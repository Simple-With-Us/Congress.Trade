import { describe, expect, it } from 'vitest';
import { STOCK_ACT_BRACKETS } from '../brackets.ts';
import {
  DEFAULT_PUSH_SETTINGS,
  PUSH_AMOUNT_CUTOFFS,
  filerPosition,
  filingAlertCopy,
  formatPushAmountCutoff,
  groupTradesByFiling,
  matchesWatchlistTrade,
  parsePushSettings,
  serializePushSettings,
  tradeCountPhrase,
  tradeSideKind,
} from '../pushSettings.ts';

describe('parsePushSettings', () => {
  it('defaults missing settings to filing digests, not a per-trade firehose', () => {
    expect(parsePushSettings(undefined)).toEqual(DEFAULT_PUSH_SETTINGS);
    expect(parsePushSettings({})).toEqual(DEFAULT_PUSH_SETTINGS);
    expect(parsePushSettings({ pushMode: 'nope' }).pushMode).toBe('filings');
  });

  it('keeps off / filings / watchlist and uppercases ticker rules', () => {
    const parsed = parsePushSettings({
      pushMode: 'watchlist',
      watchlistRules: {
        nvda: { minAmount: 50001, sides: 'buys' },
        '': { minAmount: 1, sides: 'all' },
      },
    });
    expect(parsed.pushMode).toBe('watchlist');
    expect(parsed.watchlistRules).toEqual({
      NVDA: { minAmount: 50001, sides: 'buys' },
    });
    expect(serializePushSettings(parsed)).toEqual({
      pushMode: 'watchlist',
      watchlistRules: { NVDA: { minAmount: 50001, sides: 'buys' } },
    });
  });
});

describe('PUSH_AMOUNT_CUTOFFS', () => {
  it('is the STOCK Act bracket floors, skipping the $0–$1,000 product tier', () => {
    expect(PUSH_AMOUNT_CUTOFFS[0]).toBe(1001);
    expect(PUSH_AMOUNT_CUTOFFS).toEqual(
      STOCK_ACT_BRACKETS.filter((b) => b.min > 0).map((b) => b.min),
    );
    expect(formatPushAmountCutoff(15001)).toBe('$15,001+');
    expect(formatPushAmountCutoff(50000001)).toBe('$50,000,001+');
  });
});

describe('filerPosition', () => {
  it('spells House / Senate seats in plain English', () => {
    expect(filerPosition({ chamber: 'senate', state: 'CA' })).toBe('Senator from California');
    expect(filerPosition({ chamber: 'house', state: 'CA', district: '17' }))
      .toBe("Representative from California's 17th District");
    expect(filerPosition({ chamber: 'house', state: 'AL', district: '1' }))
      .toBe("Representative from Alabama's 1st District");
    expect(filerPosition({ chamber: 'house', state: 'NY' })).toBe('Representative from New York');
  });

  it('uses the curated executive title', () => {
    expect(filerPosition({ chamber: 'executive', filerId: 'EXEC-DJT' })).toBe('President');
    expect(filerPosition({ chamber: 'executive', filerId: 'EXEC-UNKNOWN' })).toBe('Executive Branch');
  });
});

describe('filingAlertCopy', () => {
  it('names the filer, spells the seat, and counts sides in English', () => {
    const copy = filingAlertCopy([
      {
        filer_name: 'Nancy Pelosi',
        chamber: 'house',
        state: 'CA',
        district: '11',
        tx_type: 'P',
        ticker: 'NVDA',
      },
      { tx_type: 'B', ticker: 'AAPL' },
      { tx_type: 'S', ticker: 'MSFT' },
      { tx_type: 'E', ticker: 'GOOG' },
    ]);
    expect(copy.title).toBe("Nancy Pelosi, Representative from California's 11th District");
    expect(copy.body).toBe('Filed 4 trades (2 buys, 1 sell, 1 exchange).');
  });

  it('singularizes a one-trade filing and does not call an exchange a buy', () => {
    expect(tradeSideKind('E')).toBe('exchanges');
    expect(tradeCountPhrase([{ tx_type: 'E' }])).toBe('filed 1 trade (1 exchange)');
    const copy = filingAlertCopy([
      { filer_name: 'Jane Pelosi', chamber: 'house', tx_type: 'E', ticker: 'NVDA' },
    ]);
    expect(copy.title).toBe('Jane Pelosi, Representative');
    expect(copy.body).toBe('Filed 1 trade (1 exchange).');
    expect(copy.title).not.toMatch(/bought/i);
  });
});

describe('matchesWatchlistTrade', () => {
  const settings = parsePushSettings({
    pushMode: 'watchlist',
    watchlistRules: { NVDA: { minAmount: 50001, sides: 'buys' } },
  });

  it('requires the ticker, the side, and the disclosure-range floor', () => {
    expect(matchesWatchlistTrade(
      { ticker: 'NVDA', tx_type: 'P', amount_min: 50001 },
      ['NVDA'],
      settings,
    )).toBe(true);
    expect(matchesWatchlistTrade(
      { ticker: 'AAPL', tx_type: 'P', amount_min: 50001 },
      ['NVDA'],
      settings,
    )).toBe(false);
    expect(matchesWatchlistTrade(
      { ticker: 'NVDA', tx_type: 'S', amount_min: 50001 },
      ['NVDA'],
      settings,
    )).toBe(false);
    expect(matchesWatchlistTrade(
      { ticker: 'NVDA', tx_type: 'P', amount_min: 15001 },
      ['NVDA'],
      settings,
    )).toBe(false);
    expect(matchesWatchlistTrade(
      { ticker: 'NVDA', tx_type: 'P', amount_min: null },
      ['NVDA'],
      settings,
    )).toBe(false);
  });
});

describe('groupTradesByFiling', () => {
  it('collapses rows that share a doc_id', () => {
    const groups = groupTradesByFiling([
      { id: 'a', doc_id: 'H-1', ticker: 'NVDA' },
      { id: 'b', doc_id: 'H-1', ticker: 'AAPL' },
      { id: 'c', doc_id: 'H-2', ticker: 'MSFT' },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.map((r) => r.id)).toEqual(['a', 'b']);
    expect(groups[1]?.map((r) => r.id)).toEqual(['c']);
  });
});
