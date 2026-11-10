/**
 * src/prices/__tests__/terminalListing.test.ts
 *
 * CT-2466: tickers confirmed no longer trading are stage 5. They leave the
 * pending set and the stall clock, stay visible as a count with a reason,
 * and a real pending ticker still stalls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/pace.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../shared/pace.ts')>()),
  getSharedStPeerPacer: () => async () => {},
}));

const h = vi.hoisted(() => ({
  responses: new Map<string, Array<{ date: string; close: number }>>(),
  errors: new Map<string, string>(),
}));

vi.mock('../../secrets/infisical', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../secrets/infisical')>()),
  resolveSecrets: vi.fn(async () => ({})),
}));

vi.mock('../peer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../peer.ts')>();
  return {
    ...actual,
    buildPeerPriceClient: () => ({
      eodHistory: async (symbol: string) => {
        const err = h.errors.get(symbol);
        if (err) throw new Error(err);
        return h.responses.get(symbol) ?? [];
      },
      spxHistory: async () => h.responses.get('SPY') ?? [],
    }),
  };
});

vi.mock('../../enrichment/service.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../enrichment/service.ts')>();
  return { ...actual, hasConfiguredKeyedEnrichmentProvider: vi.fn(async () => true) };
});

import type { Env } from '../../shared/types.ts';
import {
  formatTerminalReason,
  isConfirmedNoLongerTradingDate,
  lastTradingDay,
  parseTerminalReason,
  PRICE_UNAVAILABLE_NOT_COVERED,
  PRICE_UNAVAILABLE_TERMINAL,
  priceNotCoveredExclusionSql,
  runPriceRefresh,
  TERMINAL_LAST_TRADE_DAYS,
  terminalLastTradeCutoff,
  terminalReasonForListing,
} from '../service.ts';
import { recheckNotCoveredPeerPrices } from '../notCovered.ts';
import {
  stPeerPricePendingBindParams,
  stPeerPricePendingBindsForSubqueries,
  stPeerPricePendingFromSql,
} from '../peerPricePending.ts';
import { markTerminalPeerPriceTickers } from '../terminalListing.ts';
import { collectStPeerPricesMetrics, stPeerPricesMetricsToCheck } from '../stPeerPricesHealth.ts';
import { openMigratedD1, type SqliteDatabase } from './sqliteD1.ts';

let db: SqliteDatabase;
let env: Env;
let close: () => void;

const NOW = new Date('2026-10-23T15:00:00.000Z');
const FRESH_THROUGH = lastTradingDay(NOW);
const hoursAgoIso = (n: number): string => new Date(NOW.getTime() - n * 3_600_000).toISOString();

function daysBeforeFresh(days: number): string {
  const day = new Date(`${FRESH_THROUGH}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - days);
  return day.toISOString().slice(0, 10);
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  h.responses.clear();
  h.errors.clear();
  const opened = await openMigratedD1();
  db = opened.db;
  close = opened.close;
  env = {
    DB: opened.d1,
    APP_B_IMPORT_URL: 'https://socratic.trade',
    APP_B_INGEST_TOKEN: 'test-peer-token',
    CONFIG_KV: { get: async () => null, put: async () => {} },
  } as unknown as Env;
});

afterEach(() => {
  vi.useRealTimers();
  close();
});

function seedTrade(id: string, ticker: string, txDate = '2020-01-05'): void {
  db.prepare(
    `INSERT INTO transactions (id, ticker, tx_date, source, created_at)
     VALUES (?, ?, ?, 'primary', '2020-01-05T00:00:00Z')`,
  ).run(id, ticker, txDate);
}

function seedSr(
  ticker: string,
  sr: {
    latestPriceDate?: string | null;
    priceUnavailable?: number;
    priceCheckedAt?: string | null;
    reason?: string | null;
  } = {},
): void {
  db.prepare(
    `INSERT INTO securities_ref (ticker, latest_price_date, price_unavailable, price_checked_at, price_unavailable_reason)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    ticker,
    sr.latestPriceDate ?? null,
    sr.priceUnavailable ?? 0,
    sr.priceCheckedAt ?? null,
    sr.reason ?? null,
  );
}

function seedPrice(ticker: string, date: string, close = 100): void {
  db.prepare('INSERT INTO price_eod (ticker, date, close) VALUES (?, ?, ?)').run(ticker, date, close);
}

function seedFreshCorpus(): void {
  seedTrade('t-corp', 'CORP');
  seedSr('CORP', { latestPriceDate: FRESH_THROUGH, priceCheckedAt: NOW.toISOString() });
  seedPrice('CORP', FRESH_THROUGH);
}

function pendingCount(): number {
  const params = stPeerPricePendingBindParams(NOW);
  const row = db
    .prepare(`SELECT COUNT(DISTINCT t.ticker) AS n ${stPeerPricePendingFromSql()}`)
    .get(...stPeerPricePendingBindsForSubqueries(params, 1)) as { n: number };
  return Number(row.n);
}

function srRow(ticker: string): Record<string, unknown> | undefined {
  return db
    .prepare(
      `SELECT price_unavailable, price_checked_at, price_unavailable_reason, latest_price_date
         FROM securities_ref WHERE ticker = ?`,
    )
    .get(ticker);
}

describe('terminal last-trade classification', () => {
  it('uses a 90-day bar before the last completed session', () => {
    expect(TERMINAL_LAST_TRADE_DAYS).toBe(90);
    const cutoff = terminalLastTradeCutoff(NOW);
    expect(cutoff).toBe(daysBeforeFresh(90));
    expect(isConfirmedNoLongerTradingDate('2023-12-13', NOW)).toBe(true);
    expect(isConfirmedNoLongerTradingDate('2024-03-15', NOW)).toBe(true);
    expect(isConfirmedNoLongerTradingDate(daysBeforeFresh(91), NOW)).toBe(true);
    expect(isConfirmedNoLongerTradingDate(daysBeforeFresh(90), NOW)).toBe(false);
    expect(isConfirmedNoLongerTradingDate(daysBeforeFresh(1), NOW)).toBe(false);
    expect(isConfirmedNoLongerTradingDate(null, NOW)).toBe(false);
  });

  it('maps repeat not-found to delisted and every other stage to no_longer_trading', () => {
    expect(terminalReasonForListing(2)).toBe('delisted');
    expect(terminalReasonForListing(0)).toBe('no_longer_trading');
    expect(terminalReasonForListing(3)).toBe('no_longer_trading');
    const text = formatTerminalReason(NOW, 'acquired', '2023-12-13');
    expect(parseTerminalReason(text)).toEqual({
      since: '2026-10-23',
      reason: 'acquired',
      lastTrade: '2023-12-13',
    });
  });

  it('excludes stage 5 from the pending SQL along with stage 4', () => {
    expect(priceNotCoveredExclusionSql('sr')).toContain(
      `NOT IN (${PRICE_UNAVAILABLE_NOT_COVERED}, ${PRICE_UNAVAILABLE_TERMINAL})`,
    );
  });
});

describe('terminal sweep and the stall clock', () => {
  it('marks an ancient last trade and leaves a one-session lag pending', async () => {
    seedFreshCorpus();
    seedTrade('t-sgen', 'SGEN');
    seedSr('SGEN', { latestPriceDate: '2023-12-13', priceCheckedAt: hoursAgoIso(80) });
    seedTrade('t-splk', 'SPLK');
    seedSr('SPLK', { latestPriceDate: '2024-03-15', priceCheckedAt: hoursAgoIso(80) });
    seedTrade('t-cpx', 'CPXWF');
    seedSr('CPXWF', { latestPriceDate: daysBeforeFresh(1), priceCheckedAt: hoursAgoIso(80) });

    const swept = await markTerminalPeerPriceTickers(env, NOW);

    expect(swept.marked).toBe(2);
    expect(srRow('SGEN')?.price_unavailable).toBe(PRICE_UNAVAILABLE_TERMINAL);
    expect(String(srRow('SGEN')?.price_unavailable_reason)).toContain('no_longer_trading');
    expect(String(srRow('SGEN')?.price_unavailable_reason)).toContain('last trade 2023-12-13');
    expect(srRow('SPLK')?.price_unavailable).toBe(PRICE_UNAVAILABLE_TERMINAL);
    expect(String(srRow('SPLK')?.price_unavailable_reason)).toContain('no_longer_trading');
    expect(String(srRow('SPLK')?.price_unavailable_reason)).toContain('last trade 2024-03-15');
    expect(srRow('CPXWF')?.price_unavailable).toBe(0);
    expect(pendingCount()).toBe(1);
  });

  it('uses delisted when the ancient row is already a repeat not-found', async () => {
    seedFreshCorpus();
    seedTrade('t-dead', 'DEAD');
    seedSr('DEAD', {
      latestPriceDate: '2020-01-15',
      priceUnavailable: 2,
      priceCheckedAt: hoursAgoIso(80),
    });

    await markTerminalPeerPriceTickers(env, NOW);

    expect(srRow('DEAD')?.price_unavailable).toBe(PRICE_UNAVAILABLE_TERMINAL);
    expect(String(srRow('DEAD')?.price_unavailable_reason)).toContain('delisted');
  });

  it('marks nothing when the corpus itself is behind', async () => {
    seedTrade('t-old', 'OLD');
    seedSr('OLD', { latestPriceDate: '2020-01-15', priceCheckedAt: hoursAgoIso(80) });

    const swept = await markTerminalPeerPriceTickers(env, NOW);

    expect(swept).toEqual({ marked: 0, qualified: 0 });
    expect(srRow('OLD')?.price_unavailable).toBe(0);
  });

  it('does not let terminal tickers hold the stall clock', async () => {
    seedFreshCorpus();
    seedTrade('t-sgen', 'SGEN');
    seedSr('SGEN', {
      latestPriceDate: '2023-12-13',
      priceUnavailable: PRICE_UNAVAILABLE_TERMINAL,
      priceCheckedAt: hoursAgoIso(200),
      reason: formatTerminalReason(NOW, 'no_longer_trading', '2023-12-13'),
    });
    seedTrade('t-splk', 'SPLK');
    seedSr('SPLK', {
      latestPriceDate: '2024-03-15',
      priceUnavailable: PRICE_UNAVAILABLE_TERMINAL,
      priceCheckedAt: hoursAgoIso(200),
      reason: formatTerminalReason(NOW, 'no_longer_trading', '2024-03-15'),
    });

    const metrics = await collectStPeerPricesMetrics(env, NOW, 6);

    expect(metrics.pending).toBe(0);
    expect(metrics.stalled).toBe(false);
    expect(metrics.terminal).toBe(2);
    expect(metrics.terminalSample.map((row) => row.ticker)).toEqual(['SGEN', 'SPLK']);
    expect(metrics.terminalSample.map((row) => row.reason)).toEqual([
      'no_longer_trading',
      'no_longer_trading',
    ]);
    const check = stPeerPricesMetricsToCheck(metrics);
    expect(check.status).toBe('ok');
    expect(check.detail).toContain('2 no longer trading');
    expect(check.detail).toContain('SGEN no_longer_trading');
    expect(check.value).toMatchObject({ pending: 0, terminal: 2 });
  });

  it('still stalls when a real ticker is pending beside terminal ones', async () => {
    seedFreshCorpus();
    seedTrade('t-sgen', 'SGEN');
    seedSr('SGEN', {
      latestPriceDate: '2023-12-13',
      priceUnavailable: PRICE_UNAVAILABLE_TERMINAL,
      priceCheckedAt: hoursAgoIso(200),
      reason: formatTerminalReason(NOW, 'no_longer_trading', '2023-12-13'),
    });
    seedTrade('t-live', 'LIVE');
    seedSr('LIVE', { latestPriceDate: daysBeforeFresh(1), priceCheckedAt: hoursAgoIso(80) });

    const metrics = await collectStPeerPricesMetrics(env, NOW, 6);

    expect(metrics.pending).toBe(1);
    expect(metrics.pendingSample).toEqual(['LIVE']);
    expect(metrics.terminal).toBe(1);
    expect(metrics.stalled).toBe(true);
    expect(stPeerPricesMetricsToCheck(metrics).status).toBe('stalled');
    expect(metrics.detail).toContain('LIVE');
    expect(metrics.detail).toContain('1 no longer trading');
  });
});

describe('price refresh writes the terminal stage', () => {
  it('marks a years-old close terminal instead of the 30-day stall cache', async () => {
    seedFreshCorpus();
    seedTrade('t-gone', 'GONE', '2019-01-05');
    seedSr('GONE', { latestPriceDate: '2020-01-15', priceCheckedAt: hoursAgoIso(80) });
    h.responses.set('GONE', [{ date: '2020-01-15', close: 50 }]);

    await runPriceRefresh(env, { max: 10 });

    const row = srRow('GONE');
    expect(row?.price_unavailable).toBe(PRICE_UNAVAILABLE_TERMINAL);
    expect(String(row?.price_unavailable_reason)).toContain('no_longer_trading');
    expect(String(row?.price_unavailable_reason)).toContain('last trade 2020-01-15');
    expect(pendingCount()).toBe(0);
  });

  it('marks a repeat empty on an ancient last trade as delisted', async () => {
    seedFreshCorpus();
    seedTrade('t-rep', 'REPEATOLD');
    seedSr('REPEATOLD', {
      latestPriceDate: '2020-01-15',
      priceUnavailable: 2,
      priceCheckedAt: '2000-01-01T00:00:00Z',
    });

    await runPriceRefresh(env, { max: 10 });

    const row = srRow('REPEATOLD');
    expect(row?.price_unavailable).toBe(PRICE_UNAVAILABLE_TERMINAL);
    expect(String(row?.price_unavailable_reason)).toContain('delisted');
  });

  it('keeps a repeat empty with no ancient last trade at not-covered', async () => {
    seedFreshCorpus();
    seedTrade('t-gap', 'GAP');
    seedSr('GAP', {
      latestPriceDate: daysBeforeFresh(1),
      priceUnavailable: 2,
      priceCheckedAt: '2000-01-01T00:00:00Z',
    });

    await runPriceRefresh(env, { max: 10 });

    expect(srRow('GAP')?.price_unavailable).toBe(PRICE_UNAVAILABLE_NOT_COVERED);
  });
});

describe('daily re-check keeps a terminal ticker terminal', () => {
  it('restamps the check time and keeps the since-date when ST returns nothing new', async () => {
    const reason = formatTerminalReason(new Date('2026-10-01T00:00:00Z'), 'no_longer_trading', '2023-12-13');
    seedTrade('t-sgen', 'SGEN');
    seedSr('SGEN', {
      latestPriceDate: '2023-12-13',
      priceUnavailable: PRICE_UNAVAILABLE_TERMINAL,
      priceCheckedAt: hoursAgoIso(400),
      reason,
    });

    const res = await recheckNotCoveredPeerPrices(env, {
      eodHistory: async () => [],
      spxHistory: async () => [],
    }, { now: NOW, pace: async () => {} });

    expect(res.restamped).toBe(1);
    const row = srRow('SGEN');
    expect(row?.price_unavailable).toBe(PRICE_UNAVAILABLE_TERMINAL);
    expect(row?.price_unavailable_reason).toBe(reason);
    expect(row?.price_checked_at).toBe(NOW.toISOString());
  });
});
