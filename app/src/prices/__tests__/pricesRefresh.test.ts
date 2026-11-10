/**
 * src/prices/__tests__/pricesRefresh.test.ts
 *
 * Behavioral tests for runPriceRefresh (real migrated SQLite + a stubbed price
 * client): the negative-cache write on an empty EOD fetch, the latest_price_date
 * bookkeeping on success, and the incremental fetch window that stops the price
 * refresh from re-downloading each ticker's entire multi-year history every pass.
 *
 * EOD history is Socratic.Trade only. The peer mock records into h.* so the
 * bookkeeping assertions stay stable. MASSIVE/FMP keys must not be called.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The shared ST peer pacer paces at 100/min even when unset (CT-2445), which
// would make every multi-call test sleep 600ms per call.  Pacing has its own
// tests in shared/__tests__/pace.test.ts.
vi.mock('../../shared/pace.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../shared/pace.ts')>()),
  getSharedStPeerPacer: () => async () => {},
}));


// Shared, hoisted state the price-client mocks read/write (vi.mock is hoisted above
// imports, so it can't close over ordinary module-scope locals).
const h = vi.hoisted(() => ({
  eodCalls: [] as Array<{ symbol: string; from: string; to: string }>,
  responses: new Map<string, Array<{ date: string; close: number }>>(),
  // Symbols whose fetch throws — message defaults to MASSIVE_HTTP_403 (auth/plan
  // fatal) unless a custom message is stored in the map.
  errors: new Map<string, string>(),
}));

vi.mock('../../secrets/infisical', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../secrets/infisical')>()),
  resolveSecrets: vi.fn(async () => ({})),
}));

// Same shape for the Massive client, for the unmetered-provider 429 tests
// below (per-symbol error MESSAGE so a test can pick 429 vs 403).
const m = vi.hoisted(() => ({
  eodCalls: [] as Array<{ symbol: string }>,
  errors: new Map<string, string>(),
  responses: new Map<string, Array<{ date: string; close: number }>>(),
}));
const order = vi.hoisted(() => ({ log: [] as string[] }));

vi.mock('../massive', () => ({
  buildMassivePriceClient: () => ({
    // Default suite records into h.* so assertions on h.eodCalls / h.responses stay stable.  Unmetered-provider
    // suite below uses m.* overrides when PRICE_PROVIDER=massive with m.errors.
    eodHistory: async (symbol: string, from?: string, to?: string) => {
      order.log.push(`massive:eod:${symbol}`);
      m.eodCalls.push({ symbol });
      h.eodCalls.push({ symbol, from: from ?? '', to: to ?? '' });
      const err = m.errors.get(symbol);
      if (err) throw new Error(err);
      const herr = h.errors.get(symbol);
      if (herr) throw new Error(herr);
      return m.responses.get(symbol) ?? h.responses.get(symbol) ?? [];
    },
    spxHistory: async (from?: string, to?: string) => {
      order.log.push('massive:spx');
      m.eodCalls.push({ symbol: 'SPY' });
      h.eodCalls.push({ symbol: 'SPY', from: from ?? '', to: to ?? '' });
      const err = m.errors.get('SPY');
      if (err) throw new Error(err);
      const herr = h.errors.get('SPY');
      if (herr) throw new Error(herr);
      return m.responses.get('SPY') ?? h.responses.get('SPY') ?? [];
    },
  }),
}));

const p = vi.hoisted(() => ({
  eodCalls: [] as Array<{ symbol: string }>,
  errors: new Map<string, string>(),
  responses: new Map<string, Array<{ date: string; close: number }>>(),
}));
vi.mock('../peer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../peer.ts')>();
  return {
    ...actual,
    buildPeerPriceClient: () => ({
      eodHistory: async (symbol: string, from?: string, to?: string) => {
        order.log.push(`peer:eod:${symbol}`);
        p.eodCalls.push({ symbol });
        h.eodCalls.push({ symbol, from: from ?? '', to: to ?? '' });
        const err = p.errors.get(symbol) ?? h.errors.get(symbol);
        if (err) throw new Error(err);
        return p.responses.get(symbol) ?? h.responses.get(symbol) ?? [];
      },
      spxHistory: async (from?: string, to?: string) => {
        order.log.push('peer:spx');
        p.eodCalls.push({ symbol: 'SPY' });
        h.eodCalls.push({ symbol: 'SPY', from: from ?? '', to: to ?? '' });
        const err = p.errors.get('SPY') ?? h.errors.get('SPY');
        if (err) throw new Error(err);
        return p.responses.get('SPY') ?? h.responses.get('SPY') ?? [];
      },
    }),
  };
});

import type { Env } from '../../shared/types.ts';
import { runPriceRefresh } from '../service.ts';
import { openMigratedD1, type SqliteDatabase } from './sqliteD1.ts';

let db: SqliteDatabase;
let env: Env;
let close: () => void;

beforeEach(async () => {
  h.eodCalls.length = 0;
  h.responses.clear();
  h.errors.clear();
  m.eodCalls.length = 0;
  m.responses.clear();
  m.errors.clear();
  p.eodCalls.length = 0;
  p.responses.clear();
  p.errors.clear();
  order.log.length = 0;
  const opened = await openMigratedD1();
  db = opened.db;
  close = opened.close;
  env = {
    DB: opened.d1,
    // Prices come from Socratic.Trade. Vendor keys must not change the client.
    APP_B_IMPORT_URL: 'https://socratic.trade',
    APP_B_INGEST_TOKEN: 'test-peer-token',
    MASSIVE_API_KEY: 'test-massive-key',
    FMP_API_KEY: 'test-fmp-key',
    PRICE_PROVIDER: 'massive',
    CONFIG_KV: { get: async () => null, put: async () => {} },
  } as unknown as Env;
});
afterEach(() => close());

function seedTrade(id: string, ticker: string, txDate: string): void {
  db.prepare(
    `INSERT INTO transactions (id, ticker, tx_date, source, created_at)
     VALUES (?, ?, ?, 'primary', ?)`,
  ).run(id, ticker, txDate, `${txDate}T00:00:00Z`);
}

function srRow(ticker: string): Record<string, unknown> | undefined {
  return db
    .prepare(
      `SELECT price_unavailable, price_checked_at, latest_price_date, current_price, current_price_date
         FROM securities_ref WHERE ticker = ?`,
    )
    .get(ticker);
}

describe('runPriceRefresh — negative-cache on empty history', () => {
  it('marks a never-cached ticker price_unavailable on a CONFIRMED-empty (no-throw) response', async () => {
    seedTrade('t1', 'DEAD', '2026-01-05'); // delisted/foreign → provider returns [] (no throw)
    const res = await runPriceRefresh(env, { max: 10 });

    const row = srRow('DEAD');
    expect(row?.price_unavailable).toBe(1);
    expect(row?.price_checked_at).toBeTruthy();
    expect(row?.latest_price_date).toBeNull();
    expect(res.tickersPriced).toBe(0);
    // No price rows were written for an un-priceable ticker.
    expect(db.prepare('SELECT COUNT(*) AS n FROM price_eod WHERE ticker = ?').get('DEAD')).toEqual({
      n: 0,
    });
  });

  it('does NOT negative-cache when the provider fetch THROWS (transient error) — retry next cycle', async () => {
    seedTrade('t1', 'FLAKY', '2026-01-05');
    h.errors.set('FLAKY', 'MASSIVE_HTTP_429'); // simulate 429/5xx/auth failure → client throws

    const res = await runPriceRefresh(env, { max: 10 });

    // No securities_ref row was created and no negative-cache written: a transient
    // outage must not lock a priceable ticker out for the 30-day TTL.
    expect(srRow('FLAKY')).toBeUndefined();
    expect(res.errors.some((e) => e.includes('FLAKY'))).toBe(true);
  });

  it('does not write the negative-cache on a dry run', async () => {
    seedTrade('t1', 'DEAD', '2026-01-05');
    await runPriceRefresh(env, { max: 10, dryRun: true });
    expect(srRow('DEAD')).toBeUndefined();
  });
});

// Dates relative to the real clock so the "fresh close" assertions don't rot as
// time passes (the stalled-listing check compares against isoDaysAgo(14)).
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

describe('runPriceRefresh — successful fetch bookkeeping', () => {
  it('caches closes, records latest_price_date, and clears any prior negative-cache', async () => {
    const d1 = daysAgo(1);
    const d2 = daysAgo(2);
    seedTrade('t2', 'AAPL', '2026-01-05');
    // Pre-mark it unavailable to prove a fresh successful fetch clears the flag.
    db.prepare(
      `INSERT INTO securities_ref (ticker, price_unavailable, price_checked_at)
       VALUES ('AAPL', 1, '2026-06-01T00:00:00Z')`,
    ).run();
    h.responses.set('AAPL', [
      { date: d1, close: 200 },
      { date: d2, close: 198 },
    ]);

    await runPriceRefresh(env, { max: 10 });

    const row = srRow('AAPL');
    expect(row?.price_unavailable).toBe(0); // recent close → not stalled
    expect(row?.latest_price_date).toBe(d1);
    expect(row?.current_price).toBe(200);
    expect(row?.current_price_date).toBe(d1);
    const rows = db
      .prepare('SELECT date FROM price_eod WHERE ticker = ? ORDER BY date')
      .all('AAPL');
    expect(rows.map((r) => r.date)).toEqual([d2, d1]);
  });

  it('negative-caches a delisted ticker whose newest close is weeks stale (non-empty fetch)', async () => {
    seedTrade('t2b', 'GONE', '2019-01-05'); // trades exist, but the series stopped
    db.prepare(
      // stale latest_price_date → selected; the provider still returns its OLD closes.
      "INSERT INTO securities_ref (ticker, latest_price_date, enriched_at) VALUES ('GONE', '2020-01-15', '2020-01-01T00:00:00Z')",
    ).run();
    h.responses.set('GONE', [{ date: '2020-01-15', close: 50 }]); // newest close is years old

    await runPriceRefresh(env, { max: 10 });

    const row = srRow('GONE');
    // Marked unavailable (TTL-bounded) so it stops being re-selected + re-fetched
    // every day, even though the fetch was non-empty. latest_price_date/current
    // price still reflect the last real close. Stalled-listing uses its own
    // stage value (3 = PRICE_UNAVAILABLE_STALLED), distinct from the two
    // not-found stages (1/2) — same 30-day recheck cadence, but a different
    // status so a reader can tell "confirmed empty" apart from "stopped
    // trading" without re-deriving it from latest_price_date.
    expect(row?.price_unavailable).toBe(3);
    expect(row?.latest_price_date).toBe('2020-01-15');
    expect(row?.current_price).toBe(50);
  });
});

describe('runPriceRefresh — two-stage not-found backoff (7d then 30d)', () => {
  it('marks the FIRST empty-history result as stage 1 (not stage 2/stalled)', async () => {
    seedTrade('t6', 'DEAD1', '2026-01-05');
    await runPriceRefresh(env, { max: 10 });
    expect(srRow('DEAD1')?.price_unavailable).toBe(1);
  });

  it('escalates to stage 2 on a SECOND consecutive empty-history result', async () => {
    seedTrade('t7', 'DEAD2', '2026-01-05');
    // Pre-seed a first-stage miss whose 7-day recheck has already elapsed, so
    // this ticker is selected again this run.
    db.prepare(
      `INSERT INTO securities_ref (ticker, price_unavailable, price_checked_at)
       VALUES ('DEAD2', 1, '2000-01-01T00:00:00Z')`,
    ).run();

    await runPriceRefresh(env, { max: 10 });

    expect(srRow('DEAD2')?.price_unavailable).toBe(2); // escalated 1 → 2
  });

  it('restarts at stage 1 for a ticker that was previously priced (not mid not-found streak)', async () => {
    seedTrade('t8', 'FLIP', '2026-01-05');
    // Was successfully priced before (price_unavailable=0), now goes empty.
    db.prepare(
      `INSERT INTO securities_ref (ticker, price_unavailable, price_checked_at, latest_price_date)
       VALUES ('FLIP', 0, '2026-07-01T00:00:00Z', '2026-07-01')`,
    ).run();

    await runPriceRefresh(env, { max: 10 });

    expect(srRow('FLIP')?.price_unavailable).toBe(1); // restarts at stage 1, not 2
  });
});

describe('runPriceRefresh — abort on auth/plan failures (401/402/403)', () => {
  it('aborts the whole run when the SPX fetch hits a fatal provider error, never attempting any ticker', async () => {
    seedTrade('t9', 'AAA', '2026-01-05');
    seedTrade('t10', 'BBB', '2026-01-06');
    h.errors.set('SPY', 'MASSIVE_HTTP_403'); // auth/plan fatal — aborts whole run

    const res = await runPriceRefresh(env, { max: 10 });

    expect(res.aborted).toBe(true);
    expect(res.errors.some((e) => e.startsWith('spx:'))).toBe(true);
    expect(h.eodCalls.some((c) => c.symbol === 'AAA' || c.symbol === 'BBB')).toBe(false);
    // Nothing was written for either un-attempted ticker.
    expect(srRow('AAA')).toBeUndefined();
    expect(srRow('BBB')).toBeUndefined();
  });

  it('aborts mid-loop on a fatal per-ticker error, leaving tickers not yet reached completely untouched', async () => {
    seedTrade('t11', 'FIRSTOK', '2026-01-05'); // oldest-traded → attempted first
    seedTrade('t12', 'FATAL', '2026-01-06');
    seedTrade('t13', 'NEVERREACHED', '2026-01-07'); // newest-traded → after FATAL
    h.responses.set('FIRSTOK', [{ date: '2026-07-11', close: 100 }]);
    h.errors.set('FATAL', 'MASSIVE_HTTP_403'); // auth/plan fatal per-ticker

    const res = await runPriceRefresh(env, { max: 10 });

    expect(res.aborted).toBe(true);
    expect(res.errors.some((e) => e.includes('FATAL'))).toBe(true);
    // Processed before the fatal error: succeeded normally.
    expect(srRow('FIRSTOK')?.current_price).toBe(100);
    // Never reached (oldest-first order puts it after FATAL): no negative-cache
    // write, no partial state — completely untouched for the next run.
    expect(h.eodCalls.some((c) => c.symbol === 'NEVERREACHED')).toBe(false);
    expect(srRow('NEVERREACHED')).toBeUndefined();
  });
});

describe('runPriceRefresh — accurate meter counting (an attempt counts even when it throws)', () => {
  it('counts a thrown per-ticker fetch attempt against fmpCalls, same as a successful one', async () => {
    seedTrade('t14', 'FATAL2', '2026-01-05');
    h.errors.set('FATAL2', 'MASSIVE_HTTP_403');

    const res = await runPriceRefresh(env, { max: 10 });

    // 1 attempt for SPX (succeeds, empty response) + 1 attempt for FATAL2 (throws) = 2.
    expect(res.fmpCalls).toBe(2);
    expect(res.aborted).toBe(true);
  });

  it('counts the SPX attempt itself even when SPX throws before any ticker is reached', async () => {
    seedTrade('t15', 'AAA2', '2026-01-05');
    h.errors.set('SPY', 'MASSIVE_HTTP_403');

    const res = await runPriceRefresh(env, { max: 10 });

    expect(res.fmpCalls).toBe(1); // the SPX attempt only; the ticker loop never ran
    expect(res.aborted).toBe(true);
  });
});

describe('runPriceRefresh — SPX anchor preservation when spx_eod coverage is incomplete', () => {
  it('preserves a previously-computed spx_at_trade/spx_at_filing instead of nulling them out', async () => {
    seedTrade('tx-anchor', 'ANCH', '2020-01-05');
    // Cached price history already covers the trade date (a normal, previously-
    // enriched ticker) — the ticker's OWN price side recomputes to the SAME value.
    db.prepare("INSERT INTO price_eod (ticker, date, close) VALUES ('ANCH', '2020-01-03', 40)").run();
    // A prior run had already computed SPX anchors for this trade.
    db.prepare(
      `INSERT INTO tx_performance (tx_id, price_at_trade, spx_at_trade, price_at_filing, spx_at_filing, computed_at)
       VALUES ('tx-anchor', 40, 999, 40, 888, '2020-01-01T00:00:00Z')`,
    ).run();
    // This run: the ticker's OWN fetch succeeds (a fresh, unrelated close)...
    h.responses.set('ANCH', [{ date: '2026-07-11', close: 55 }]);
    // ...but SPX comes back empty this run (h.responses has nothing for 'SPY'),
    // so spx_eod stays completely empty — the spx_at_trade/spx_at_filing
    // subqueries resolve NULL regardless of this ticker's own success.

    await runPriceRefresh(env, { max: 10 });

    const row = db
      .prepare(
        'SELECT price_at_trade, spx_at_trade, price_at_filing, spx_at_filing FROM tx_performance WHERE tx_id = ?',
      )
      .get('tx-anchor');
    expect(row?.price_at_trade).toBe(40); // ticker's own anchor recomputed (unaffected by the SPX gap)
    expect(row?.spx_at_trade).toBe(999); // preserved, NOT nulled by this run's incomplete spx_eod
    expect(row?.spx_at_filing).toBe(888); // preserved, NOT nulled
  });
});

describe('runPriceRefresh — incremental fetch window (Fix 3)', () => {
  it('backfills from the oldest trade when the cache does not yet cover it', async () => {
    seedTrade('t3', 'MSFT', '2012-03-01'); // ancient first trade
    // Cache is a single recent close → its earliest cached date (2026-07-01) is
    // AFTER the oldest trade, so there is a historical gap to backfill.
    db.prepare("INSERT INTO price_eod (ticker, date, close) VALUES ('MSFT', '2026-07-01', 300)").run();
    // latest_price_date far in the past → guaranteed stale → selected regardless of run date.
    db.prepare(
      `INSERT INTO securities_ref (ticker, latest_price_date, enriched_at)
       VALUES ('MSFT', '2020-01-01', '2020-01-01T00:00:00Z')`,
    ).run();
    h.responses.set('MSFT', [{ date: '2026-07-11', close: 305 }]);

    await runPriceRefresh(env, { max: 10 });

    const call = h.eodCalls.find((c) => c.symbol === 'MSFT');
    // Gap below the cache → fetch from the oldest trade (2012-03-01 − 7d) so its
    // trade/filing anchors can be computed.
    expect(call?.from).toBe('2012-02-23');
  });

  it('uses the narrow 7-day window once the cache already covers the oldest trade', async () => {
    seedTrade('t3b', 'IBM', '2026-06-10'); // oldest trade
    // Cache spans from BEFORE the oldest trade to a recent close → no gap.
    db.prepare("INSERT INTO price_eod (ticker, date, close) VALUES ('IBM', '2026-06-01', 100)").run();
    db.prepare("INSERT INTO price_eod (ticker, date, close) VALUES ('IBM', '2026-07-01', 110)").run();
    db.prepare(
      `INSERT INTO securities_ref (ticker, latest_price_date, enriched_at)
       VALUES ('IBM', '2020-01-01', '2020-01-01T00:00:00Z')`,
    ).run();
    h.responses.set('IBM', [{ date: '2026-07-11', close: 115 }]);

    await runPriceRefresh(env, { max: 10 });

    const call = h.eodCalls.find((c) => c.symbol === 'IBM');
    // No gap (cached min 2026-06-01 <= oldest trade) → narrow window off the cached
    // max (2026-07-01 − 7d), NOT a full re-download of the multi-year history.
    expect(call?.from).toBe('2026-06-24');
  });

  it('fetches SPX covering both the cached spx close and the oldest trade date', async () => {
    seedTrade('t4', 'NVDA', '2026-01-05'); // oldest trade
    db.prepare("INSERT INTO spx_eod (date, close) VALUES ('2026-07-02', 5000)").run();
    h.responses.set('SPY', [{ date: '2026-07-11', close: 5100 }]);
    h.responses.set('NVDA', [{ date: '2026-07-11', close: 120 }]);

    await runPriceRefresh(env, { max: 10 });

    const spy = h.eodCalls.find((c) => c.symbol === 'SPY');
    // min(cached spx 2026-07-02, oldest trade 2026-01-05) − 7d = 2025-12-29, so
    // older trades can still get spx_at_trade/spx_at_filing anchors.
    expect(spy?.from).toBe('2025-12-29');
  });

  it('fetches SPX from just the cached overlap once the series already covers the oldest trade', async () => {
    seedTrade('t5', 'NVDA', '2026-06-10'); // oldest trade
    // SPX cache spans from BEFORE the oldest trade to a recent close → no gap.
    db.prepare("INSERT INTO spx_eod (date, close) VALUES ('2026-06-01', 4900)").run();
    db.prepare("INSERT INTO spx_eod (date, close) VALUES ('2026-07-02', 5000)").run();
    h.responses.set('SPY', [{ date: '2026-07-11', close: 5100 }]);
    h.responses.set('NVDA', [{ date: '2026-07-11', close: 120 }]);

    await runPriceRefresh(env, { max: 10 });

    const spy = h.eodCalls.find((c) => c.symbol === 'SPY');
    // No gap (cached min 2026-06-01 <= oldest trade) → narrow window off cached max
    // (2026-07-02 − 7d = 2026-06-25), not a full re-download of the series.
    expect(spy?.from).toBe('2026-06-25');
  });
});

describe('runPriceRefresh — Socratic peer: 429 is run-fatal', () => {
  it('aborts on a per-ticker 429 so later tickers are not walked', async () => {
    seedTrade('t20', 'RATE1', '2026-01-05');
    seedTrade('t21', 'OK2', '2026-01-06');
    h.errors.set('RATE1', 'PEER_HTTP_429');
    h.responses.set('OK2', [{ date: '2026-07-11', close: 42 }]);

    const res = await runPriceRefresh(env, { max: 10 });

    expect(res.aborted).toBe(true);
    expect(res.errors.some((e) => e.includes('RATE1') && e.includes('429'))).toBe(true);
    expect(srRow('RATE1')).toBeUndefined();
    expect(srRow('OK2')).toBeUndefined();
    expect(h.eodCalls.some((c) => c.symbol === 'OK2')).toBe(false);
    expect(res.tickersPriced).toBe(0);
    expect(m.eodCalls).toEqual([]);
  });

  it('aborts when the SPX fetch 429s — the ticker loop does not run', async () => {
    seedTrade('t22', 'OK3', '2026-01-05');
    h.errors.set('SPY', 'PEER_HTTP_429');
    h.responses.set('OK3', [{ date: '2026-07-11', close: 7 }]);

    const res = await runPriceRefresh(env, { max: 10 });

    expect(res.aborted).toBe(true);
    expect(res.errors.some((e) => e.startsWith('spx:') && e.includes('429'))).toBe(true);
    expect(h.eodCalls.some((c) => c.symbol === 'OK3')).toBe(false);
    expect(srRow('OK3')).toBeUndefined();
    expect(m.eodCalls).toEqual([]);
  });

  it('still aborts on 403 (broken peer token/plan)', async () => {
    seedTrade('t23', 'AAA3', '2026-01-05');
    h.errors.set('SPY', 'PEER_HTTP_403');

    const res = await runPriceRefresh(env, { max: 10 });

    expect(res.aborted).toBe(true);
    expect(h.eodCalls.some((c) => c.symbol === 'AAA3')).toBe(false);
    expect(m.eodCalls).toEqual([]);
    expect(srRow('AAA3')).toBeUndefined();
  });

  it('still aborts mid-loop on a per-ticker 403', async () => {
    seedTrade('t24', 'FIRST4', '2026-01-05');
    seedTrade('t25', 'NEVER4', '2026-01-06');
    h.errors.set('FIRST4', 'PEER_HTTP_403');

    const res = await runPriceRefresh(env, { max: 10 });

    expect(res.aborted).toBe(true);
    expect(h.eodCalls.some((c) => c.symbol === 'NEVER4')).toBe(false);
    expect(m.eodCalls).toEqual([]);
    expect(srRow('NEVER4')).toBeUndefined();
  });
});

describe('runPriceRefresh — vendor keys are not a price fallback', () => {
  it('prices from the peer and never calls Massive when both are configured', async () => {
    const d1 = daysAgo(1);
    seedTrade('t-peer-1', 'AAPL', '2026-01-05');
    p.responses.set('SPY', [{ date: d1, close: 500 }]);
    p.responses.set('AAPL', [{ date: d1, close: 200 }]);
    m.responses.set('AAPL', [{ date: d1, close: 199 }]);

    const res = await runPriceRefresh(env, { max: 10 });

    expect(res.aborted).toBe(false);
    expect(res.tickersPriced).toBe(1);
    expect(srRow('AAPL')?.current_price).toBe(200);
    expect(m.eodCalls).toEqual([]);
    expect(order.log[0]).toBe('peer:spx');
    expect(order.log.some((c) => c.startsWith('massive:'))).toBe(false);
  });

  it('does not call Massive when the peer series is empty', async () => {
    seedTrade('t-peer-2', 'MSFT', '2026-01-05');
    p.responses.set('SPY', [{ date: daysAgo(1), close: 500 }]);
    m.responses.set('MSFT', [{ date: daysAgo(1), close: 410 }]);

    const res = await runPriceRefresh(env, { max: 10 });

    expect(res.tickersPriced).toBe(0);
    expect(srRow('MSFT')?.current_price ?? null).toBeNull();
    expect(srRow('MSFT')?.price_unavailable).toBe(1);
    expect(m.eodCalls).toEqual([]);
    expect(order.log.filter((c) => c.endsWith(':MSFT'))).toEqual(['peer:eod:MSFT']);
  });

  it('aborts on peer 401 and never calls Massive', async () => {
    seedTrade('t-peer-3', 'NVDA', '2026-01-05');
    p.errors.set('SPY', 'PEER_HTTP_401');
    m.responses.set('NVDA', [{ date: daysAgo(1), close: 100 }]);

    const res = await runPriceRefresh(env, { max: 10 });

    expect(res.aborted).toBe(true);
    expect(m.eodCalls).toEqual([]);
    expect(order.log.some((c) => c.startsWith('massive:'))).toBe(false);
    expect(srRow('NVDA')).toBeUndefined();
  });

  it('no-ops when the peer is not configured, even if FMP and Massive keys are set', async () => {
    const envx = env as unknown as Record<string, string | undefined>;
    delete envx.APP_B_IMPORT_URL;
    delete envx.APP_B_INGEST_TOKEN;
    seedTrade('t-peer-4', 'IBM', '2026-01-05');
    h.responses.set('IBM', [{ date: daysAgo(1), close: 10 }]);

    const res = await runPriceRefresh(env, { max: 10 });

    expect(res.tickersPriced).toBe(0);
    expect(res.fmpCalls).toBe(0);
    expect(h.eodCalls).toEqual([]);
    expect(m.eodCalls).toEqual([]);
    expect(srRow('IBM')).toBeUndefined();
  });
});

describe('runPriceRefresh — missing price_unavailable_reason column (CT-2409)', () => {
  it('adds the column when production never migrated and still stamps price_checked_at', async () => {
    db.exec('ALTER TABLE securities_ref DROP COLUMN price_unavailable_reason');
    seedTrade('t1', 'AAPL', '2026-01-05');
    h.responses.set('AAPL', [{ date: '2026-10-14', close: 230 }]);

    const res = await runPriceRefresh(env, { max: 10 });

    expect(res.aborted).toBe(false);
    expect(res.errors).toEqual([]);
    const row = srRow('AAPL');
    expect(row?.latest_price_date).toBe('2026-10-14');
    expect(row?.price_checked_at).toBeTruthy();
    const cols = db.prepare('PRAGMA table_info(securities_ref)').all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'price_unavailable_reason')).toBe(true);
  });

  it('stops the ticker loop when the lane deadline aborts the signal', async () => {
    seedTrade('t1', 'AAPL', '2026-01-05');
    h.responses.set('AAPL', [{ date: '2026-10-14', close: 230 }]);
    const controller = new AbortController();
    controller.abort();

    const res = await runPriceRefresh(env, { max: 10, signal: controller.signal });

    expect(res.aborted).toBe(true);
    expect(res.tickersPriced).toBe(0);
    expect(h.eodCalls.some((c) => c.symbol === 'AAPL')).toBe(false);
  });
});

describe('runPriceRefresh — rotating cursor for the bounded catch-up (CT-2445)', () => {
  it('walks the pending set in pages, resuming after the last ticker reached', async () => {
    seedTrade('r1', 'ERRA', '2026-01-05');
    seedTrade('r2', 'ERRB', '2026-01-06');
    seedTrade('r3', 'TAIL', '2026-01-07');
    // Non-fatal per-ticker errors leave ERRA/ERRB pending at the head of the FIFO.
    h.errors.set('ERRA', 'PEER_HTTP_500');
    h.errors.set('ERRB', 'PEER_HTTP_500');
    h.responses.set('TAIL', [{ date: daysAgo(1), close: 10 }]);

    // max 3 = 1 S&P call + 2 tickers.
    const first = await runPriceRefresh(env, { max: 3, afterCursorSeq: null });
    expect(h.eodCalls.filter((c) => c.symbol !== 'SPY').map((c) => c.symbol)).toEqual(['ERRA', 'ERRB']);
    expect(first.reachedEndOfPending).toBe(false);
    expect(first.lastCursorSeq).not.toBeNull();

    h.eodCalls.length = 0;
    const second = await runPriceRefresh(env, { max: 3, afterCursorSeq: first.lastCursorSeq });
    expect(h.eodCalls.filter((c) => c.symbol !== 'SPY').map((c) => c.symbol)).toEqual(['TAIL']);
    expect(second.reachedEndOfPending).toBe(true);
    expect(srRow('TAIL')?.current_price).toBe(10);
    // A resumed walk skipped the head, so it never attempted the whole set.
    expect(second.attemptedAllPending).toBe(false);
  });

  it('resumes at the ticker a fatal error stopped on, not past it', async () => {
    seedTrade('r1', 'OK1', '2026-01-05');
    seedTrade('r2', 'FATAL', '2026-01-06');
    seedTrade('r3', 'LATER', '2026-01-07');
    h.responses.set('OK1', [{ date: daysAgo(1), close: 5 }]);
    h.errors.set('FATAL', 'PEER_HTTP_429');

    const res = await runPriceRefresh(env, { max: 10 });
    expect(res.aborted).toBe(true);
    expect(res.reachedEndOfPending).toBe(false);
    // OK1 finished;  FATAL did not, so the resume point stays at OK1.
    const okSeq = db
      .prepare('SELECT MAX(cursor_seq) AS s FROM transactions WHERE ticker = ?')
      .get('OK1') as { s: number };
    expect(res.lastCursorSeq).toBe(okSeq.s);

    // The next run starts with FATAL, then LATER.
    h.errors.delete('FATAL');
    h.eodCalls.length = 0;
    await runPriceRefresh(env, { max: 10, afterCursorSeq: res.lastCursorSeq });
    expect(h.eodCalls.filter((c) => c.symbol !== 'SPY').map((c) => c.symbol)).toEqual(['FATAL', 'LATER']);
  });

  it('keeps no resume point when the first ticker hits a fatal error', async () => {
    seedTrade('r1', 'FATAL', '2026-01-05');
    h.errors.set('FATAL', 'PEER_HTTP_429');

    const res = await runPriceRefresh(env, { max: 10, afterCursorSeq: null });
    expect(res.aborted).toBe(true);
    expect(res.lastCursorSeq).toBeNull();
  });
});
