/**
 * src/prices/__tests__/notCovered.test.ts
 *
 * CT-2443: tickers Socratic.Trade cannot price are marked stage 4
 * (PRICE_UNAVAILABLE_NOT_COVERED), excluded from every pending predicate,
 * kept visible as a count, and re-checked daily. Real migrated SQLite +
 * a stubbed peer client, following pricesRefresh.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The shared ST peer pacer paces at 100/min even when unset (CT-2445), which
// would make every multi-call test sleep 600ms per call.  Pacing has its own
// tests in shared/__tests__/pace.test.ts.
vi.mock('../../shared/pace.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../shared/pace.ts')>()),
  getSharedStPeerPacer: () => async () => {},
}));


const h = vi.hoisted(() => ({
  eodCalls: [] as Array<{ symbol: string; from: string; to: string }>,
  responses: new Map<string, Array<{ date: string; close: number }>>(),
  errors: new Map<string, string>(),
}));

vi.mock('../../secrets/infisical', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../secrets/infisical')>()),
  resolveSecrets: vi.fn(async () => ({})),
}));

vi.mock('../peer', () => ({
  buildPeerPriceClient: () => ({
    eodHistory: async (symbol: string, from?: string, to?: string) => {
      h.eodCalls.push({ symbol, from: from ?? '', to: to ?? '' });
      const herr = h.errors.get(symbol);
      if (herr) throw new Error(herr);
      return h.responses.get(symbol) ?? [];
    },
    spxHistory: async (from?: string, to?: string) => {
      h.eodCalls.push({ symbol: 'SPY', from: from ?? '', to: to ?? '' });
      const herr = h.errors.get('SPY');
      if (herr) throw new Error(herr);
      return h.responses.get('SPY') ?? [];
    },
  }),
}));

vi.mock('../../enrichment/service.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../enrichment/service.ts')>();
  return { ...actual, hasConfiguredKeyedEnrichmentProvider: vi.fn(async () => true) };
});

import type { Env } from '../../shared/types.ts';
import type { PriceClient } from '../fmp.ts';
import {
  lastTradingDay,
  PRICE_UNAVAILABLE_NOT_COVERED,
  priceNotCoveredExclusionSql,
  runPriceRefresh,
  ST_FETCH_ERROR_REASON_PREFIX,
} from '../service.ts';
import {
  markStuckPeerPriceTickersNotCovered,
  NOT_COVERED_RECHECK_LOOKBACK_DAYS,
  recheckNotCoveredPeerPrices,
  ST_NOT_COVERED_MAX_BATCH,
  ST_NOT_COVERED_STUCK_HOURS,
} from '../notCovered.ts';
import {
  stPeerPricePendingBindParams,
  stPeerPricePendingBindsForSubqueries,
  stPeerPricePendingFromSql,
} from '../peerPricePending.ts';
import {
  collectStPeerPricesMetrics,
  stPeerPricesMetricsToCheck,
} from '../stPeerPricesHealth.ts';
import { openMigratedD1, type SqliteDatabase } from './sqliteD1.ts';

let db: SqliteDatabase;
let env: Env;
let close: () => void;

// Friday 2026-10-23 15:00Z = 11:00 ET Friday → last trading day Thu 2026-10-22.
const NOW = new Date('2026-10-23T15:00:00.000Z');
const FRESH_THROUGH = lastTradingDay(NOW);
const hoursAgoIso = (n: number): string => new Date(NOW.getTime() - n * 3_600_000).toISOString();

beforeEach(async () => {
  h.eodCalls.length = 0;
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
afterEach(() => close());

function seedTrade(id: string, ticker: string, txDate = '2026-01-05'): void {
  db.prepare(
    `INSERT INTO transactions (id, ticker, tx_date, source, created_at)
     VALUES (?, ?, ?, 'primary', '2026-01-05T00:00:00Z')`,
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

function srRow(ticker: string): Record<string, unknown> | undefined {
  return db
    .prepare(
      `SELECT price_unavailable, price_checked_at, price_unavailable_reason,
              latest_price_date, current_price, current_price_date
         FROM securities_ref WHERE ticker = ?`,
    )
    .get(ticker);
}

function pendingCount(now = NOW): number {
  const params = stPeerPricePendingBindParams(now);
  const row = db
    .prepare(`SELECT COUNT(DISTINCT t.ticker) AS n ${stPeerPricePendingFromSql()}`)
    .get(...stPeerPricePendingBindsForSubqueries(params, 1)) as { n: number };
  return Number(row.n);
}

describe('stage 4 excluded from the st_peer_prices pending SQL regardless of price_checked_at age', () => {
  it('excludes a stage-4 ticker even with an ancient price_checked_at, keeps a normal pending one', () => {
    seedTrade('t-nc', 'NOTCOV');
    seedSr('NOTCOV', { priceUnavailable: 4, priceCheckedAt: '2000-01-01T00:00:00Z' });
    seedTrade('t-pend', 'PENDING');

    expect(pendingCount()).toBe(1);
    const rows = db
      .prepare(`SELECT DISTINCT t.ticker AS ticker ${stPeerPricePendingFromSql()} ORDER BY t.ticker ASC`)
      .all(...stPeerPricePendingBindsForSubqueries(stPeerPricePendingBindParams(NOW), 1)) as Array<{
        ticker: string;
      }>;
    expect(rows.map((r) => r.ticker)).toEqual(['PENDING']);
  });
});

describe('runPriceRefresh attemptedAllPending (sweep gate)', () => {
  it('is true when the whole pending set fit in the budget', async () => {
    for (const t of ['PA', 'PB', 'PC']) seedTrade(`t-g-${t}`, t);
    const r = await runPriceRefresh(env, { max: 10 });
    expect(r.aborted).toBe(false);
    expect(r.attemptedAllPending).toBe(true);
  });

  it('is false when the budget truncated the pending selection', async () => {
    for (const t of ['PA', 'PB', 'PC', 'PD']) seedTrade(`t-g-${t}`, t);
    const r = await runPriceRefresh(env, { max: 3 });
    expect(r.attemptedAllPending).toBe(false);
  });

  it('is false on a fatal provider abort', async () => {
    for (const t of ['PA', 'PB']) seedTrade(`t-g-${t}`, t);
    h.errors.set('PA', 'PEER_HTTP_401');
    h.errors.set('PB', 'PEER_HTTP_401');
    const r = await runPriceRefresh(env, { max: 10 });
    expect(r.aborted).toBe(true);
    expect(r.attemptedAllPending).toBe(false);
  });
});

describe('rule (a): repeat miss terminates at stage 4', () => {
  it('stage 2 + empty -> 4 with a st_not_covered reason', async () => {
    seedTrade('t-a1', 'REPEAT');
    seedSr('REPEAT', { priceUnavailable: 2, priceCheckedAt: '2000-01-01T00:00:00Z' });

    await runPriceRefresh(env, { max: 10 });

    const row = srRow('REPEAT');
    expect(row?.price_unavailable).toBe(PRICE_UNAVAILABLE_NOT_COVERED);
    expect(row?.price_unavailable_reason).toMatch(/^st_not_covered since \d{4}-\d{2}-\d{2}: /);
    expect(row?.price_unavailable_reason).toContain('no EOD history after repeat re-check');
  });

  it('stage 3 + stalled -> 4 with a st_not_covered reason', async () => {
    seedTrade('t-a2', 'STALLED', '2019-01-05');
    seedSr('STALLED', {
      priceUnavailable: 3,
      priceCheckedAt: '2000-01-01T00:00:00Z',
      latestPriceDate: '2020-01-15',
    });
    h.responses.set('STALLED', [{ date: '2020-01-15', close: 50 }]);

    await runPriceRefresh(env, { max: 10 });

    const row = srRow('STALLED');
    expect(row?.price_unavailable).toBe(PRICE_UNAVAILABLE_NOT_COVERED);
    expect(row?.price_unavailable_reason).toMatch(/^st_not_covered since \d{4}-\d{2}-\d{2}: /);
    expect(row?.price_unavailable_reason).toContain('stale listing after repeat re-check');
    expect(row?.latest_price_date).toBe('2020-01-15');
  });

  it('stage 0 + empty -> 1 (first miss keeps the existing backoff)', async () => {
    seedTrade('t-a3', 'FIRSTMISS');

    await runPriceRefresh(env, { max: 10 });

    expect(srRow('FIRSTMISS')?.price_unavailable).toBe(1);
  });

  it('stage 1 + empty -> 2 (second miss keeps the existing backoff)', async () => {
    seedTrade('t-a4', 'SECONDMISS');
    seedSr('SECONDMISS', { priceUnavailable: 1, priceCheckedAt: '2000-01-01T00:00:00Z' });

    await runPriceRefresh(env, { max: 10 });

    expect(srRow('SECONDMISS')?.price_unavailable).toBe(2);
  });

  it('stage 0 + stalled -> 3 (first stalled result keeps the existing stage)', async () => {
    seedTrade('t-a5', 'GONE', '2019-01-05');
    seedSr('GONE', { latestPriceDate: '2020-01-15' });
    h.responses.set('GONE', [{ date: '2020-01-15', close: 50 }]);

    await runPriceRefresh(env, { max: 10 });

    expect(srRow('GONE')?.price_unavailable).toBe(3);
  });
});

describe('rule (b): stuck-while-pending sweep', () => {
  function seedFreshCorpus(): void {
    seedTrade('t-corp', 'CORP');
    seedSr('CORP', { latestPriceDate: FRESH_THROUGH });
    seedPrice('CORP', FRESH_THROUGH);
  }

  it('marks a 73h-stuck pending ticker when the corpus is fresh', async () => {
    expect(ST_NOT_COVERED_STUCK_HOURS).toBe(72);
    seedFreshCorpus();
    seedTrade('t-s1', 'STUCK');
    seedSr('STUCK', { priceUnavailable: 0, priceCheckedAt: hoursAgoIso(73) });

    const res = await markStuckPeerPriceTickersNotCovered(env, NOW);

    expect(res).toEqual({ marked: 1, qualified: 1 });
    const row = srRow('STUCK');
    expect(row?.price_unavailable).toBe(PRICE_UNAVAILABLE_NOT_COVERED);
    expect(row?.price_checked_at).toBe(NOW.toISOString());
    expect(row?.price_unavailable_reason).toBe(
      'st_not_covered since 2026-10-23: no price_checked_at progress for 72h while pending',
    );
    // No longer pending once marked.
    expect(pendingCount()).toBe(0);
  });

  it('leaves a 71h pending ticker untouched', async () => {
    seedFreshCorpus();
    seedTrade('t-s2', 'FRESH');
    seedSr('FRESH', { priceUnavailable: 0, priceCheckedAt: hoursAgoIso(71) });

    const res = await markStuckPeerPriceTickersNotCovered(env, NOW);

    expect(res).toEqual({ marked: 0, qualified: 0 });
    const row = srRow('FRESH');
    expect(row?.price_unavailable).toBe(0);
    expect(row?.price_checked_at).toBe(hoursAgoIso(71));
    expect(pendingCount()).toBe(1);
  });

  it('marks nothing when the corpus is stale (ST outage, not a coverage gap)', async () => {
    seedTrade('t-corp', 'CORP');
    seedSr('CORP', { latestPriceDate: '2020-01-01' });
    seedPrice('CORP', '2020-01-01');
    seedTrade('t-s3', 'STUCK');
    seedSr('STUCK', { priceUnavailable: 0, priceCheckedAt: hoursAgoIso(73) });

    const res = await markStuckPeerPriceTickersNotCovered(env, NOW);

    expect(res).toEqual({ marked: 0, qualified: 0 });
    expect(srRow('STUCK')?.price_unavailable).toBe(0);
  });

  it('marks none when more than ST_NOT_COVERED_MAX_BATCH qualify', async () => {
    expect(ST_NOT_COVERED_MAX_BATCH).toBe(50);
    seedFreshCorpus();
    for (let i = 0; i < 51; i++) {
      const ticker = `STUCK${i}`;
      seedTrade(`t-many-${i}`, ticker);
      seedSr(ticker, { priceUnavailable: 0, priceCheckedAt: hoursAgoIso(73) });
    }

    const res = await markStuckPeerPriceTickersNotCovered(env, NOW);

    expect(res.marked).toBe(0);
    expect(res.qualified).toBe(51);
    const marked = db
      .prepare('SELECT COUNT(*) AS n FROM securities_ref WHERE price_unavailable = 4')
      .get() as { n: number };
    expect(marked.n).toBe(0);
  });

  it('marks all 50 when exactly the batch cap qualifies', async () => {
    seedFreshCorpus();
    for (let i = 0; i < 50; i++) {
      const ticker = `EDGE${i}`;
      seedTrade(`t-edge-${i}`, ticker);
      seedSr(ticker, { priceUnavailable: 0, priceCheckedAt: hoursAgoIso(73) });
    }

    const res = await markStuckPeerPriceTickersNotCovered(env, NOW);

    expect(res).toEqual({ marked: 50, qualified: 50 });
  });
});

describe('daily not-covered re-check', () => {
  const noPace = async (): Promise<void> => {};
  function stubClient(
    impl: (symbol: string) => Array<{ date: string; close: number }> | Promise<Array<{ date: string; close: number }>>,
    calls: string[] = [],
  ): PriceClient {
    return {
      eodHistory: async (symbol: string) => {
        calls.push(symbol);
        return impl(symbol);
      },
      spxHistory: async () => [],
    };
  }

  it('writes a fresh close via the shared upsert path: stage 0, reason cleared, latest updated', async () => {
    seedTrade('t-r1', 'BACK');
    seedSr('BACK', {
      priceUnavailable: 4,
      priceCheckedAt: hoursAgoIso(100),
      latestPriceDate: '2026-10-21',
      reason: 'st_not_covered since 2026-10-20: no price_checked_at progress for 72h while pending',
    });
    const client = stubClient(() => [{ date: '2026-10-22', close: 42 }]);

    const res = await recheckNotCoveredPeerPrices(env, client, { now: NOW, pace: noPace });

    expect(res.aborted).toBe(false);
    expect(res).toMatchObject({ checked: 1, repriced: 1, restamped: 0 });
    const row = srRow('BACK');
    expect(row?.price_unavailable).toBe(0);
    expect(row?.price_unavailable_reason).toBeNull();
    expect(row?.latest_price_date).toBe('2026-10-22');
    expect(row?.current_price).toBe(42);
  });

  it('on empty ST output stays 4, advances price_checked_at, keeps the reason since-date', async () => {
    const reason = 'st_not_covered since 2026-10-20: no price_checked_at progress for 72h while pending';
    seedTrade('t-r2', 'STILLGONE');
    seedSr('STILLGONE', {
      priceUnavailable: 4,
      priceCheckedAt: hoursAgoIso(100),
      latestPriceDate: null,
      reason,
    });
    const client = stubClient(() => []);

    const res = await recheckNotCoveredPeerPrices(env, client, { now: NOW, pace: noPace });

    expect(res).toMatchObject({ checked: 1, repriced: 0, restamped: 1 });
    const row = srRow('STILLGONE');
    expect(row?.price_unavailable).toBe(4);
    expect(row?.price_checked_at).toBe(NOW.toISOString());
    expect(row?.price_unavailable_reason).toBe(reason);
  });

  it('restamps (no write) when the newest close is stale or behind the previous latest', async () => {
    seedTrade('t-r3', 'OLDIE');
    seedSr('OLDIE', {
      priceUnavailable: 4,
      priceCheckedAt: hoursAgoIso(100),
      latestPriceDate: '2026-10-21',
      reason: 'st_not_covered since 2026-10-20: stale listing after repeat re-check',
    });
    const client = stubClient(() => [{ date: '2020-01-15', close: 7 }]);

    const res = await recheckNotCoveredPeerPrices(env, client, { now: NOW, pace: noPace });

    expect(res).toMatchObject({ checked: 1, repriced: 0, restamped: 1 });
    const row = srRow('OLDIE');
    expect(row?.price_unavailable).toBe(4);
    expect(row?.latest_price_date).toBe('2026-10-21');
  });

  it('aborts on a fatal provider error without touching tickers', async () => {
    seedTrade('t-r4', 'DOOMED');
    seedSr('DOOMED', {
      priceUnavailable: 4,
      priceCheckedAt: hoursAgoIso(100),
      latestPriceDate: null,
      reason: 'st_not_covered since 2026-10-20: no EOD history after repeat re-check',
    });
    const client: PriceClient = {
      eodHistory: async () => {
        throw new Error('PEER_HTTP_401');
      },
      spxHistory: async () => [],
    };

    const res = await recheckNotCoveredPeerPrices(env, client, { now: NOW, pace: noPace });

    expect(res.aborted).toBe(true);
    expect(res.checked).toBe(0);
    const row = srRow('DOOMED');
    expect(row?.price_unavailable).toBe(4);
    expect(row?.price_checked_at).toBe(hoursAgoIso(100));
    expect(row?.price_unavailable_reason).toContain('since 2026-10-20');
  });

  it('restamps on a non-fatal per-ticker error so the window rotates', async () => {
    seedTrade('t-r5', 'FLAKY');
    seedSr('FLAKY', {
      priceUnavailable: 4,
      priceCheckedAt: hoursAgoIso(100),
      latestPriceDate: null,
      reason: 'st_not_covered since 2026-10-20: no EOD history after repeat re-check',
    });
    const client: PriceClient = {
      eodHistory: async () => {
        throw new Error('PEER_HTTP_500');
      },
      spxHistory: async () => [],
    };

    const res = await recheckNotCoveredPeerPrices(env, client, { now: NOW, pace: noPace });

    expect(res.aborted).toBe(false);
    expect(res.restamped).toBe(1);
    const row = srRow('FLAKY');
    expect(row?.price_unavailable).toBe(4);
    expect(row?.price_checked_at).toBe(NOW.toISOString());
    expect(row?.price_unavailable_reason).toContain('since 2026-10-20');
  });

  it('retries oldest price_checked_at first and honors max', async () => {
    const calls: string[] = [];
    for (const [ticker, ageH] of [['OLD', 200], ['MID', 150], ['NEW', 100]] as const) {
      seedTrade(`t-o-${ticker}`, ticker);
      seedSr(ticker, { priceUnavailable: 4, priceCheckedAt: hoursAgoIso(ageH) });
    }
    const client = stubClient(() => [], calls);

    const res = await recheckNotCoveredPeerPrices(env, client, { now: NOW, pace: noPace, max: 2 });

    expect(res.checked).toBe(2);
    expect(calls).toEqual(['OLD', 'MID']);
  });
});

describe('health metrics carry the not-covered count', () => {
  it('pending=0 with notCovered=3 is ok, with count + sample in value and detail', async () => {
    for (const ticker of ['AAA', 'BBB', 'CCC']) {
      seedTrade(`t-h-${ticker}`, ticker);
      seedSr(ticker, {
        priceUnavailable: 4,
        priceCheckedAt: hoursAgoIso(100),
        reason: 'st_not_covered since 2026-10-20: no price_checked_at progress for 72h while pending',
      });
    }

    const metrics = await collectStPeerPricesMetrics(env, NOW, 6);

    expect(metrics.pending).toBe(0);
    expect(metrics.stalled).toBe(false);
    expect(metrics.notCovered).toBe(3);
    expect(metrics.notCoveredSample).toEqual(['AAA', 'BBB', 'CCC']);
    const check = stPeerPricesMetricsToCheck(metrics);
    expect(check.status).toBe('ok');
    expect(check.detail).toContain('; 3 not covered by ST');
    expect(check.value).toMatchObject({
      pending: 0,
      notCovered: 3,
      notCoveredSample: ['AAA', 'BBB', 'CCC'],
    });
  });

  it('a 15-ticker stall shape stops stalling after rule (b) runs', async () => {
    seedTrade('t-corp', 'CORP');
    seedSr('CORP', { latestPriceDate: FRESH_THROUGH });
    seedPrice('CORP', FRESH_THROUGH);
    for (let i = 0; i < 15; i++) {
      const ticker = `STALL${i}`;
      seedTrade(`t-stall-${i}`, ticker);
      seedSr(ticker, { priceUnavailable: 0, priceCheckedAt: hoursAgoIso(73) });
    }

    const before = await collectStPeerPricesMetrics(env, NOW, 6);
    expect(before.pending).toBe(15);
    expect(before.stalled).toBe(true);

    const swept = await markStuckPeerPriceTickersNotCovered(env, NOW);
    expect(swept).toEqual({ marked: 15, qualified: 15 });

    const after = await collectStPeerPricesMetrics(env, NOW, 6);
    expect(after.pending).toBe(0);
    expect(after.stalled).toBe(false);
    expect(after.notCovered).toBe(15);
    expect(after.detail).toContain('; 15 not covered by ST');
    expect(stPeerPricesMetricsToCheck(after).status).toBe('ok');
  });
});

describe('Kody review follow-ups (#2849)', () => {
  const noPace = async (): Promise<void> => {};
  function seedFreshCorpus(): void {
    seedTrade('t-corp', 'CORP');
    seedSr('CORP', { latestPriceDate: FRESH_THROUGH });
    seedPrice('CORP', FRESH_THROUGH);
  }

  it('#1 a non-fatal ST error records the error as the last outcome, leaving stage and price_checked_at alone', async () => {
    seedTrade('t-e1', 'ERRS');
    seedSr('ERRS', { priceUnavailable: 1, priceCheckedAt: '2000-01-01T00:00:00Z' });
    h.errors.set('ERRS', 'peer 500 upstream');

    await runPriceRefresh(env, { max: 10 });

    const row = srRow('ERRS');
    expect(row?.price_unavailable).toBe(1);
    expect(row?.price_checked_at).toBe('2000-01-01T00:00:00Z');
    expect(String(row?.price_unavailable_reason)).toBe(`${ST_FETCH_ERROR_REASON_PREFIX}peer 500 upstream`);
  });

  it('#1 the sweep names a persistent ST error as the not-covered cause', async () => {
    seedFreshCorpus();
    seedTrade('t-e2', 'ERRSTUCK');
    seedSr('ERRSTUCK', {
      priceCheckedAt: hoursAgoIso(80),
      reason: `${ST_FETCH_ERROR_REASON_PREFIX}peer 500 upstream`,
    });

    expect(await markStuckPeerPriceTickersNotCovered(env, NOW)).toEqual({ marked: 1, qualified: 1 });

    const row = srRow('ERRSTUCK');
    expect(row?.price_unavailable).toBe(PRICE_UNAVAILABLE_NOT_COVERED);
    expect(row?.price_unavailable_reason).toBe(
      'st_not_covered since 2026-10-23: no price_checked_at progress for 72h while pending; last ST fetch errored (peer 500 upstream)',
    );
  });

  it('#1 a later successful fetch clears the error marker', async () => {
    seedTrade('t-e3', 'RECOVER');
    seedSr('RECOVER', { reason: `${ST_FETCH_ERROR_REASON_PREFIX}peer 500 upstream` });
    h.responses.set('RECOVER', [{ date: FRESH_THROUGH, close: 12 }]);

    await runPriceRefresh(env, { max: 10 });

    const row = srRow('RECOVER');
    expect(row?.price_unavailable).toBe(0);
    expect(row?.price_unavailable_reason).toBeNull();
  });

  it('#2 a stage-4 ticker with no trades to plan is restamped, not left at its old price_checked_at', async () => {
    seedSr('NOTRADES', { priceUnavailable: 4, priceCheckedAt: hoursAgoIso(100) });
    const calls: string[] = [];
    const client: PriceClient = {
      eodHistory: async (symbol: string) => {
        calls.push(symbol);
        return [];
      },
      spxHistory: async () => [],
    };

    const res = await recheckNotCoveredPeerPrices(env, client, { now: NOW, pace: noPace });

    // No ST call is made (checked counts ST probes), but the row still rotates.
    expect(res).toMatchObject({ checked: 0, repriced: 0, restamped: 1 });
    expect(calls).toEqual([]);
    expect(srRow('NOTRADES')?.price_checked_at).toBe(NOW.toISOString());
    expect(srRow('NOTRADES')?.price_unavailable).toBe(PRICE_UNAVAILABLE_NOT_COVERED);
  });

  it('#3 the re-check asks ST for a bounded window, not full history from the first trade', async () => {
    expect(NOT_COVERED_RECHECK_LOOKBACK_DAYS).toBe(30);
    seedTrade('t-w1', 'OLDTRADE', '2012-03-01');
    seedSr('OLDTRADE', { priceUnavailable: 4, priceCheckedAt: hoursAgoIso(100) });
    const froms: string[] = [];
    const client: PriceClient = {
      eodHistory: async (_symbol: string, from?: string) => {
        froms.push(from ?? '');
        return [];
      },
      spxHistory: async () => [],
    };

    await recheckNotCoveredPeerPrices(env, client, { now: NOW, pace: noPace });

    expect(froms).toHaveLength(1);
    const ageDays = (Date.now() - new Date(`${froms[0]}T00:00:00Z`).getTime()) / 86_400_000;
    expect(ageDays).toBeLessThanOrEqual(NOT_COVERED_RECHECK_LOOKBACK_DAYS + 1);
  });

  it('#5 the exclusion SQL helper rejects any alias outside the allowlist', () => {
    expect(priceNotCoveredExclusionSql('sr')).toContain('sr.price_unavailable');
    expect(() => priceNotCoveredExclusionSql('sr) OR 1=1 --')).toThrow();
    expect(() => priceNotCoveredExclusionSql('t')).toThrow();
  });

  it('#6 the refresh loop reads the previous stage from the plan query, with no per-ticker stage lookup', async () => {
    seedTrade('t-n1', 'NPLUS1');
    seedSr('NPLUS1', { priceUnavailable: 2, priceCheckedAt: '2000-01-01T00:00:00Z' });
    seedTrade('t-n2', 'NPLUS2');
    seedSr('NPLUS2', { priceUnavailable: 1, priceCheckedAt: '2000-01-01T00:00:00Z' });
    const sqls: string[] = [];
    const realPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = ((sql: string) => {
      sqls.push(sql.replace(/\s+/g, ' ').trim());
      return realPrepare(sql);
    }) as typeof env.DB.prepare;

    await runPriceRefresh(env, { max: 10 });

    expect(sqls.filter((q) => /^SELECT price_unavailable FROM securities_ref WHERE ticker = \?$/.test(q))).toEqual([]);
    // Rule (a) still terminates the stage-2 repeat miss.
    expect(srRow('NPLUS1')?.price_unavailable).toBe(PRICE_UNAVAILABLE_NOT_COVERED);
    expect(srRow('NPLUS2')?.price_unavailable).toBe(2);
  });
});

describe('Kody follow-ups on #2849 (post-merge)', () => {
  const noPace = async (): Promise<void> => {};
  const OLD_TRADE = '2012-03-01';

  function priceAtTrade(txId: string): unknown {
    return (db.prepare('SELECT price_at_trade FROM tx_performance WHERE tx_id = ?').get(txId) as
      | { price_at_trade: unknown }
      | undefined)?.price_at_trade ?? null;
  }

  /** ST that prices the ticker again:  every requested day it has, newest first. */
  function recoveredClient(calls: Array<{ from: string; to: string }>, failBackfill?: string): PriceClient {
    return {
      eodHistory: async (_symbol: string, from?: string, to?: string) => {
        calls.push({ from: from ?? '', to: to ?? '' });
        if (failBackfill && calls.length === 2) throw new Error(failBackfill);
        const rows = [
          { date: '2026-10-22', close: 42 },
          { date: '2026-10-01', close: 40 },
          { date: '2012-02-29', close: 10 },
        ];
        return rows.filter((r) => r.date >= (from ?? ''));
      },
      spxHistory: async () => [],
    };
  }

  function seedRecoverable(ticker: string, txId: string): void {
    seedTrade(txId, ticker, OLD_TRADE);
    seedSr(ticker, {
      priceUnavailable: 4,
      priceCheckedAt: hoursAgoIso(100),
      reason: 'st_not_covered since 2026-10-01: no price_checked_at progress for 72h while pending',
    });
  }

  it('HIGH: a recovered ticker gets its full history, so trades older than the 30-day probe are priced', async () => {
    seedRecoverable('RECOV', 't-old');
    const calls: Array<{ from: string; to: string }> = [];

    const res = await recheckNotCoveredPeerPrices(env, recoveredClient(calls), { now: NOW, pace: noPace });

    expect(res).toMatchObject({ checked: 1, repriced: 1, backfilled: 1, aborted: false });
    expect(calls).toHaveLength(2);
    // First call is the bounded probe, second reaches back to the oldest trade.
    expect(calls[0].from > '2026-09-01').toBe(true);
    expect(calls[1].from <= OLD_TRADE).toBe(true);
    expect(priceAtTrade('t-old')).toBe(10);
    const row = srRow('RECOV');
    expect(row?.price_unavailable).toBe(0);
    expect(row?.latest_price_date).toBe('2026-10-22');
  });

  it('HIGH: a ticker whose window fits the probe makes no extra backfill call', async () => {
    seedTrade('t-new', 'RECENT', '2026-10-10');
    seedSr('RECENT', { priceUnavailable: 4, priceCheckedAt: hoursAgoIso(100) });
    const calls: Array<{ from: string; to: string }> = [];

    const res = await recheckNotCoveredPeerPrices(env, recoveredClient(calls), { now: NOW, pace: noPace });

    expect(res).toMatchObject({ repriced: 1, backfilled: 0 });
    expect(calls).toHaveLength(1);
  });

  it('HIGH: a failed backfill writes nothing, keeps stage 4, and the next re-check prices the full window', async () => {
    seedRecoverable('HALF', 't-half');
    const calls: Array<{ from: string; to: string }> = [];

    const res = await recheckNotCoveredPeerPrices(env, recoveredClient(calls, 'PEER_HTTP_500'), {
      now: NOW,
      pace: noPace,
    });

    expect(res).toMatchObject({ repriced: 0, backfilled: 0, restamped: 1, aborted: false });
    const row = srRow('HALF');
    expect(row?.price_unavailable).toBe(PRICE_UNAVAILABLE_NOT_COVERED);
    expect(row?.price_checked_at).toBe(NOW.toISOString());
    expect(row?.latest_price_date).toBeNull();
    // No partial cache:  a warm newest close would make later plans skip the gap.
    expect(db.prepare('SELECT COUNT(*) AS n FROM price_eod WHERE ticker = ?').get('HALF')).toEqual({ n: 0 });

    // Next day's re-check, ST healthy:  full window in one write.
    const calls2: Array<{ from: string; to: string }> = [];
    const res2 = await recheckNotCoveredPeerPrices(env, recoveredClient(calls2), {
      now: new Date(NOW.getTime() + 86_400_000),
      pace: noPace,
    });
    expect(res2).toMatchObject({ repriced: 1, backfilled: 1 });
    expect(priceAtTrade('t-half')).toBe(10);
    expect(srRow('HALF')?.latest_price_date).toBe('2026-10-22');
  });

  it('HIGH: a warm cache with a gap since its last close is filled across the gap, not just the probe window', async () => {
    seedTrade('t-gap', 'GAPPY', '2025-06-02');
    seedSr('GAPPY', { priceUnavailable: 4, priceCheckedAt: hoursAgoIso(100), latestPriceDate: '2025-01-31' });
    seedPrice('GAPPY', '2025-01-31', 5);
    seedPrice('GAPPY', '2020-01-02', 4);
    const froms: string[] = [];
    const client: PriceClient = {
      eodHistory: async (_s: string, from?: string) => {
        froms.push(from ?? '');
        return [
          { date: '2026-10-22', close: 42 },
          { date: '2025-05-30', close: 7 },
        ].filter((r) => r.date >= (from ?? ''));
      },
      spxHistory: async () => [],
    };

    const res = await recheckNotCoveredPeerPrices(env, client, { now: NOW, pace: noPace });

    expect(res).toMatchObject({ repriced: 1, backfilled: 1 });
    expect(froms[1] <= '2025-01-31').toBe(true);
    expect(priceAtTrade('t-gap')).toBe(7);
  });

  it('HIGH: a fatal error on the backfill aborts the re-check without writing the probe', async () => {
    seedRecoverable('FATALB', 't-fb');
    const calls: Array<{ from: string; to: string }> = [];

    const res = await recheckNotCoveredPeerPrices(env, recoveredClient(calls, 'PEER_HTTP_401'), {
      now: NOW,
      pace: noPace,
    });

    expect(res.aborted).toBe(true);
    expect(srRow('FATALB')?.price_unavailable).toBe(PRICE_UNAVAILABLE_NOT_COVERED);
    expect(db.prepare('SELECT COUNT(*) AS n FROM price_eod WHERE ticker = ?').get('FATALB')).toEqual({ n: 0 });
  });

  it('the cause never claims an error streak from one marker', async () => {
    seedTrade('t-corp2', 'CORP2');
    seedSr('CORP2', { latestPriceDate: FRESH_THROUGH });
    seedPrice('CORP2', FRESH_THROUGH);
    seedTrade('t-one', 'ONEERR');
    seedSr('ONEERR', { priceCheckedAt: hoursAgoIso(120), reason: `${ST_FETCH_ERROR_REASON_PREFIX}peer 500 upstream` });

    await markStuckPeerPriceTickersNotCovered(env, NOW);

    const reason = String(srRow('ONEERR')?.price_unavailable_reason);
    expect(reason).not.toMatch(/kept erroring|erroring for/);
    expect(reason).toBe(
      'st_not_covered since 2026-10-23: no price_checked_at progress for 72h while pending; last ST fetch errored (peer 500 upstream)',
    );
  });

  describe('error marker writes only when it changes', () => {
    function countUpdates(ticker: string): () => number {
      db.exec(`CREATE TABLE IF NOT EXISTS _sr_updates (ticker TEXT);
        CREATE TRIGGER IF NOT EXISTS _sr_upd AFTER UPDATE ON securities_ref
        BEGIN INSERT INTO _sr_updates (ticker) VALUES (NEW.ticker); END;`);
      return () =>
        Number((db.prepare('SELECT COUNT(*) AS n FROM _sr_updates WHERE ticker = ?').get(ticker) as { n: number }).n);
    }

    it('the same error on the next run writes nothing to securities_ref', async () => {
      seedTrade('t-w1', 'SAMEERR');
      seedSr('SAMEERR', { priceUnavailable: 1, priceCheckedAt: '2000-01-01T00:00:00Z' });
      h.errors.set('SAMEERR', 'peer 500 upstream');
      const updates = countUpdates('SAMEERR');

      await runPriceRefresh(env, { max: 10 });
      const afterFirst = updates();
      expect(afterFirst).toBe(1);
      await runPriceRefresh(env, { max: 10 });
      expect(updates()).toBe(afterFirst);
      expect(srRow('SAMEERR')?.price_unavailable_reason).toBe(`${ST_FETCH_ERROR_REASON_PREFIX}peer 500 upstream`);
      expect(srRow('SAMEERR')?.price_checked_at).toBe('2000-01-01T00:00:00Z');
    });

    it('a different error message still updates the marker', async () => {
      seedTrade('t-w2', 'NEWERR');
      seedSr('NEWERR', { priceUnavailable: 1, priceCheckedAt: '2000-01-01T00:00:00Z' });
      h.errors.set('NEWERR', 'peer 500 upstream');
      const updates = countUpdates('NEWERR');

      await runPriceRefresh(env, { max: 10 });
      h.errors.set('NEWERR', 'peer 502 bad gateway');
      await runPriceRefresh(env, { max: 10 });

      expect(updates()).toBe(2);
      expect(srRow('NEWERR')?.price_unavailable_reason).toBe(`${ST_FETCH_ERROR_REASON_PREFIX}peer 502 bad gateway`);
    });
  });
});
