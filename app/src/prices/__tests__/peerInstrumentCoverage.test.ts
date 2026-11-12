/**
 * CT-2482: disclosure-driven ST EOD coverage and selection/pending drain helpers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../shared/types.ts';
import {
  disclosureExcludesPeerEod,
  disclosureTradeSupportsPeerEod,
  NOT_COVERED_CAUSE_DISCLOSURE_TYPE,
  readTickerPriceInstrumentHints,
  tickerHasOnlyUnsupportedDisclosureTrades,
} from '../peerInstrumentCoverage.ts';
import {
  lastTradingDay,
  PRICE_UNAVAILABLE_NOT_COVERED,
  runPriceRefresh,
  selectTickersNeedingPrices,
  selectTickersNeedingPricesPage,
} from '../service.ts';
import {
  markDisclosureUnsupportedPeerPrices,
} from '../notCovered.ts';
import { d1OnlyEnv, openMigratedD1, type SqliteDatabase } from './sqliteD1.ts';

const h = vi.hoisted(() => ({
  responses: new Map<string, Array<{ date: string; close: number }>>(),
}));

vi.mock('../../secrets/infisical', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../secrets/infisical')>()),
  resolveSecrets: vi.fn(async () => ({})),
}));

vi.mock('../../shared/pace.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../shared/pace.ts')>()),
  getSharedStPeerPacer: () => async () => {},
}));

vi.mock('../peer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../peer.ts')>();
  return {
    ...actual,
    buildPeerPriceClient: () => ({
      eodHistory: async (symbol: string) => h.responses.get(symbol) ?? [],
      spxHistory: async () => [{ date: lastTradingDay(), close: 5000 }],
    }),
  };
});

vi.mock('../../enrichment/service.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../enrichment/service.ts')>();
  return { ...actual, hasConfiguredKeyedEnrichmentProvider: vi.fn(async () => true) };
});

const NOW = new Date('2026-10-23T15:00:00.000Z');
const FRESH_THROUGH = lastTradingDay(NOW);

let db: SqliteDatabase;
let env: Env;
let close: () => void;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  h.responses.clear();
  const opened = await openMigratedD1();
  db = opened.db;
  close = opened.close;
  env = {
    ...d1OnlyEnv(opened.d1),
    APP_B_IMPORT_URL: 'https://socratic.trade',
    APP_B_INGEST_TOKEN: 'test-peer-token',
  } as Env;
});
afterEach(() => {
  vi.useRealTimers();
  close();
});

function seedTrade(
  id: string,
  ticker: string,
  opts: { txDate?: string; assetType?: string | null } = {},
): void {
  db.prepare(
    `INSERT INTO transactions (id, ticker, tx_date, source, asset_type, created_at)
     VALUES (?, ?, ?, 'primary', ?, '2026-01-05T00:00:00Z')`,
  ).run(id, ticker, opts.txDate ?? '2026-01-05', opts.assetType ?? 'ST');
}

function seedSr(
  ticker: string,
  sr: { latestPriceDate?: string | null; priceCheckedAt?: string | null; priceUnavailable?: number } = {},
): void {
  db.prepare(
    `INSERT INTO securities_ref (ticker, latest_price_date, price_checked_at, price_unavailable)
     VALUES (?, ?, ?, ?)`,
  ).run(ticker, sr.latestPriceDate ?? null, sr.priceCheckedAt ?? null, sr.priceUnavailable ?? 0);
}

describe('disclosureExcludesPeerEod', () => {
  it('flags mutual funds and options from disclosure codes', async () => {
    seedTrade('t-mf', 'CAMOX', { assetType: 'MF' });
    seedTrade('t-op', 'OPT', { assetType: 'OP' });
    const mf = await readTickerPriceInstrumentHints(env, 'CAMOX');
    const op = await readTickerPriceInstrumentHints(env, 'OPT');
    expect(mf && disclosureExcludesPeerEod(mf)).toBe(true);
    expect(op && disclosureExcludesPeerEod(op)).toBe(true);
  });

  it('keeps listed equity ST codes priceable', async () => {
    seedTrade('t-eq', 'ETSY', { assetType: 'ST' });
    const hints = await readTickerPriceInstrumentHints(env, 'ETSY');
    expect(hints && disclosureExcludesPeerEod(hints)).toBe(false);
  });

  it('keeps label-based crypto disclosures priceable', async () => {
    seedTrade('t-btc', 'COIN', { assetType: 'Cryptocurrency' });
    const hints = await readTickerPriceInstrumentHints(env, 'COIN');
    expect(hints && disclosureTradeSupportsPeerEod(hints)).toBe(true);
  });
});

describe('tickerHasOnlyUnsupportedDisclosureTrades', () => {
  it('does not exclude a ticker with both ST and OP rows', async () => {
    seedTrade('t-st', 'INTC', { txDate: '2020-01-01', assetType: 'ST' });
    seedTrade('t-op', 'INTC', { txDate: '2026-09-01', assetType: 'OP' });
    expect(await tickerHasOnlyUnsupportedDisclosureTrades(env, 'INTC')).toBe(false);
  });
});

describe('selectTickersNeedingPricesPage rotation (CT-2482)', () => {
  it('uses cursor_seq order when resuming after a rotation cursor', async () => {
    seedTrade('s1', 'LOW', { txDate: '2020-01-01' });
    seedTrade('s2', 'HIGH', { txDate: '2021-01-01' });
    db.prepare('UPDATE transactions SET cursor_seq = ? WHERE ticker = ?').run(5, 'LOW');
    db.prepare('UPDATE transactions SET cursor_seq = ? WHERE ticker = ?').run(50, 'HIGH');
    seedSr('LOW', {
      latestPriceDate: '2020-01-01',
      priceCheckedAt: '2026-10-01T00:00:00Z',
    });
    seedSr('HIGH', {
      latestPriceDate: '2020-01-01',
      priceCheckedAt: '2026-10-02T00:00:00Z',
    });

    const page = await selectTickersNeedingPricesPage(env, 10, {
      freshThrough: FRESH_THROUGH,
      afterCursorSeq: 5,
    });
    expect(page.map((r) => r.ticker)).toEqual(['HIGH']);
  });
});

describe('selectTickersNeedingPrices ordering (CT-2482)', () => {
  it('prefers never-checked tickers over recently-checked stale-bar rows', async () => {
    seedTrade('t-old', 'OLD', { txDate: '2020-01-01' });
    seedTrade('t-new', 'NEW', { txDate: '2026-09-01' });
    seedSr('OLD', { latestPriceDate: '2026-10-20', priceCheckedAt: NOW.toISOString() });
    seedSr('NEW', { latestPriceDate: '2026-10-20', priceCheckedAt: null });

    const picked = await selectTickersNeedingPrices(env, 10, { freshThrough: FRESH_THROUGH });
    expect(picked[0]).toBe('NEW');
    expect(picked).toContain('OLD');
  });
});

describe('confirmed empty ST response on unsupported disclosure', () => {
  it('marks stage 4 immediately for mutual funds', async () => {
    seedTrade('t-mf', 'CAMOX', { assetType: 'MF' });
    seedSr('CAMOX', { latestPriceDate: '2026-10-20' });

    await runPriceRefresh(env, { max: 5 });

    const row = db
      .prepare('SELECT price_unavailable, price_unavailable_reason FROM securities_ref WHERE ticker = ?')
      .get('CAMOX') as { price_unavailable: number; price_unavailable_reason: string };
    expect(row.price_unavailable).toBe(PRICE_UNAVAILABLE_NOT_COVERED);
    expect(row.price_unavailable_reason).toContain(NOT_COVERED_CAUSE_DISCLOSURE_TYPE);
  });

  it('keeps two-stage backoff for listed equities', async () => {
    seedTrade('t-eq', 'ASGN', { assetType: 'ST' });

    await runPriceRefresh(env, { max: 5 });

    const row = db
      .prepare('SELECT price_unavailable FROM securities_ref WHERE ticker = ?')
      .get('ASGN') as { price_unavailable: number };
    expect(row.price_unavailable).toBe(1);
  });

  it('does not mark stage 4 when a newer OP row hides an ST equity', async () => {
    seedTrade('t-st', 'INTC', { txDate: '2020-01-01', assetType: 'ST' });
    seedTrade('t-op', 'INTC', { txDate: '2026-09-01', assetType: 'OP' });
    seedSr('INTC', { latestPriceDate: '2026-10-20' });

    await runPriceRefresh(env, { max: 5 });

    const row = db
      .prepare('SELECT price_unavailable FROM securities_ref WHERE ticker = ?')
      .get('INTC') as { price_unavailable: number };
    expect(row.price_unavailable).toBe(1);
  });
});

describe('markDisclosureUnsupportedPeerPrices', () => {
  function seedFreshCorpus(): void {
    seedTrade('t-corp', 'CORP');
    seedSr('CORP', { latestPriceDate: FRESH_THROUGH });
    db.prepare('INSERT INTO price_eod (ticker, date, close) VALUES (?, ?, ?)').run('CORP', FRESH_THROUGH, 10);
  }

  it('marks pending MF tickers without a provider call', async () => {
    seedFreshCorpus();
    seedTrade('t-mf', 'DBLEX', { assetType: 'MF' });
    seedSr('DBLEX', { latestPriceDate: '2026-10-20' });

    const res = await markDisclosureUnsupportedPeerPrices(env, NOW);

    expect(res.marked).toBe(1);
    const row = db
      .prepare('SELECT price_unavailable FROM securities_ref WHERE ticker = ?')
      .get('DBLEX') as { price_unavailable: number };
    expect(row.price_unavailable).toBe(PRICE_UNAVAILABLE_NOT_COVERED);
    expect(h.responses.size).toBe(0);
  });
});
