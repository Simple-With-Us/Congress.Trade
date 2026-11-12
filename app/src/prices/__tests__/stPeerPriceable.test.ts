/**
 * CT-2478 — filter non-equity symbols before ST peer price fetch.
 */
import { describe, expect, it } from 'vitest';
import { openMigratedD1 } from './sqliteD1.ts';
import { NOT_AN_EQUITY_ERROR } from '../../enrichment/service.ts';
import {
  classifyStUnpriceableSymbol,
  sweepStUnpriceablePeerPriceTickers,
  ST_UNPRICEABLE_CAUSE_GOVERNMENT,
  ST_UNPRICEABLE_CAUSE_CRYPTO,
  ST_UNPRICEABLE_CAUSE_MUTUAL_FUND,
} from '../stPeerPriceable.ts';
import { PRICE_UNAVAILABLE_NOT_COVERED } from '../service.ts';
import { selectTickersNeedingPrices } from '../service.ts';

describe('classifyStUnpriceableSymbol', () => {
  it('flags municipal and government issuer names', () => {
    expect(classifyStUnpriceableSymbol({ ticker: 'COUNTY OF SAN DIEGO' })).toBe('government');
    expect(classifyStUnpriceableSymbol({ ticker: 'CITY OF SEATTLE' })).toBe('government');
    expect(classifyStUnpriceableSymbol({ ticker: 'STATE OF CALIFORNIA' })).toBe('government');
    expect(classifyStUnpriceableSymbol({ ticker: 'DALLAS WATER MUNICIPAL BOND' })).toBe('government');
  });

  it('flags crypto names and CT disclosure rows', () => {
    expect(classifyStUnpriceableSymbol({ ticker: 'BITCOIN' })).toBe('crypto');
    expect(classifyStUnpriceableSymbol({ ticker: 'BTC', assetType: 'CT' })).toBe('crypto');
    expect(
      classifyStUnpriceableSymbol({ ticker: 'COIN', assetTypeName: 'Cryptocurrency' }),
    ).toBe('crypto');
  });

  it('flags mutual funds only when the data model confirms fund (5-letter X)', () => {
    expect(
      classifyStUnpriceableSymbol({ ticker: 'CSDIX', assetType: 'MF', assetName: 'Columbia fund' }),
    ).toBe('mutual_fund');
    expect(classifyStUnpriceableSymbol({ ticker: 'CSDIX' })).toBeNull();
    expect(classifyStUnpriceableSymbol({ ticker: 'SPY', assetType: 'EF' })).toBeNull();
    expect(classifyStUnpriceableSymbol({ ticker: 'VFIAX', assetType: 'MF', isEtf: 0 })).toBe(
      'mutual_fund',
    );
  });

  it('keeps normal listed tickers eligible', () => {
    expect(classifyStUnpriceableSymbol({ ticker: 'AAPL' })).toBeNull();
    expect(classifyStUnpriceableSymbol({ ticker: 'MSFT', assetName: 'Microsoft Corporation' })).toBeNull();
    expect(classifyStUnpriceableSymbol({ ticker: 'BRK/B' })).toBeNull();
    expect(classifyStUnpriceableSymbol({ ticker: 'BRK-B' })).toBeNull();
    expect(classifyStUnpriceableSymbol({
      ticker: 'BRK-B',
      assetName: 'Berkshire Hathaway Inc. Class B',
    })).toBeNull();
    expect(classifyStUnpriceableSymbol({ ticker: 'JPM^J' })).toBeNull();
  });

  it('does not treat bond ETF names as government issuers', () => {
    expect(classifyStUnpriceableSymbol({
      ticker: 'TLT',
      assetName: 'iShares 20+ Year Treasury Bond ETF',
    })).toBeNull();
    expect(classifyStUnpriceableSymbol({
      ticker: 'LQD',
      assetName: 'iShares iBoxx $ Investment Grade Corporate Bond ETF',
    })).toBeNull();
    expect(classifyStUnpriceableSymbol({ ticker: 'TREASURY' })).toBe('government');
  });

  it('does not treat equity tickers that collide with crypto names as crypto', () => {
    expect(classifyStUnpriceableSymbol({
      ticker: 'ETH',
      assetType: 'ST',
      assetName: 'Ethan Allen Interiors Inc.',
    })).toBeNull();
    expect(classifyStUnpriceableSymbol({
      ticker: 'SOL',
      assetType: 'ST',
      assetName: 'Emeren Group Ltd.',
    })).toBeNull();
    expect(classifyStUnpriceableSymbol({ ticker: 'LTC', assetType: 'ST', assetName: 'LTC Properties Inc.' }))
      .toBeNull();
    expect(classifyStUnpriceableSymbol({ ticker: 'ETH', assetType: 'CT' })).toBe('crypto');
    expect(classifyStUnpriceableSymbol({ ticker: 'ETH', assetName: 'Ethereum' })).toBe('crypto');
    expect(classifyStUnpriceableSymbol({ ticker: 'BTC' })).toBe('crypto');
  });

  it('honors enrichment not-an-equity tombstones', () => {
    expect(
      classifyStUnpriceableSymbol({
        ticker: 'CITY TREASURY NOTE',
        enrichmentError: NOT_AN_EQUITY_ERROR,
      }),
    ).toBe('government');
  });
});

describe('sweepStUnpriceablePeerPriceTickers', () => {
  it('marks pending junk symbols stage 4 and drops them from selection', async () => {
    const { db, d1, close } = await openMigratedD1();
    const env = { DB: d1 } as import('../../shared/types.ts').Env;
    try {
      const insert = db.prepare(
        `INSERT INTO transactions (id, ticker, asset_type, asset_name, tx_date, source, created_at)
         VALUES (?, ?, ?, ?, '2026-03-01', 'primary', '2026-03-01T00:00:00Z')`,
      );
      insert.run('tx1', 'COUNTY OF SAN DIEGO', 'GS', 'COUNTY OF SAN DIEGO');
      insert.run('tx2', 'BITCOIN', 'CT', 'BITCOIN');
      insert.run('tx3', 'CSDIX', 'MF', 'Columbia Strategic Income');
      insert.run('tx4', 'AAPL', 'ST', 'Apple Inc.');

      const before = await selectTickersNeedingPrices(env, 20);
      expect(before).toEqual(
        expect.arrayContaining(['COUNTY OF SAN DIEGO', 'BITCOIN', 'CSDIX', 'AAPL']),
      );

      const swept = await sweepStUnpriceablePeerPriceTickers(env, new Date('2026-03-02T12:00:00.000Z'));
      expect(swept.marked).toBe(3);

      const sd = db
        .prepare(
          'SELECT price_unavailable, price_unavailable_reason FROM securities_ref WHERE ticker = ?',
        )
        .get('BITCOIN') as { price_unavailable: number; price_unavailable_reason: string };
      expect(sd.price_unavailable).toBe(PRICE_UNAVAILABLE_NOT_COVERED);
      expect(sd.price_unavailable_reason).toContain(ST_UNPRICEABLE_CAUSE_CRYPTO);

      const muni = db
        .prepare('SELECT price_unavailable_reason FROM securities_ref WHERE ticker = ?')
        .get('COUNTY OF SAN DIEGO') as { price_unavailable_reason: string };
      expect(muni.price_unavailable_reason).toContain(ST_UNPRICEABLE_CAUSE_GOVERNMENT);

      const fund = db
        .prepare('SELECT price_unavailable_reason FROM securities_ref WHERE ticker = ?')
        .get('CSDIX') as { price_unavailable_reason: string };
      expect(fund.price_unavailable_reason).toContain(ST_UNPRICEABLE_CAUSE_MUTUAL_FUND);

      const after = await selectTickersNeedingPrices(env, 20);
      expect(after).toEqual(['AAPL']);
    } finally {
      close();
    }
  });
});
