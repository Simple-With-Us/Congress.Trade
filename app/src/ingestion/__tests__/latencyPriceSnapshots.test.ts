import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../secrets/infisical', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../secrets/infisical')>()),
  resolveSecrets: vi.fn(async () => ({})),
}));

import type { Env } from '../../shared/types.ts';
import { openMigratedD1, type SqliteDatabase } from '../../prices/__tests__/sqliteD1.ts';
import {
  addMs,
  captureDueLatencyPriceSnapshots,
  scheduleCtPublishSnapshot,
  scheduleMissingLatencyPriceSnapshots,
  snapshotPlan,
  summarizeProviderPublishBump,
  SNAPSHOT_STALE_MS,
} from '../latencyPriceSnapshots.ts';

// ---------------------------------------------------------------------------
// Pure function tests — snapshotPlan / addMs / SNAPSHOT_STALE_MS
// ---------------------------------------------------------------------------

describe('snapshotPlan', () => {
  it('plans CT publish, competitor publish, and +5/+15/+30/+60 from the competitor stamp', () => {
    const plan = snapshotPlan({
      trade_hash: 'h1',
      ticker: 'nvda',
      provider: 'fmp',
      congress_first_seen_at: '2026-08-16T15:00:00.000Z',
      provider_first_seen_at: '2026-08-16T15:10:00.000Z',
      provider_published_at: null,
      provider_window_start: null,
      provider_window_end: null,
    });
    expect(plan.map((p) => p.event)).toEqual([
      'ct_publish',
      'provider_publish',
      'provider_minus_30m',
      'provider_minus_15m',
      'provider_plus_5m',
      'provider_plus_15m',
      'provider_plus_30m',
      'provider_plus_60m',
      'provider_plus_6h',
      'provider_plus_12h',
      'provider_plus_24h',
    ]);
    expect(plan[0]!.dueAt).toBe('2026-08-16T15:00:00.000Z'); // ct_publish
    expect(plan[1]!.dueAt).toBe('2026-08-16T15:10:00.000Z'); // provider_publish
    expect(plan[2]!.dueAt).toBe('2026-08-16T14:40:00.000Z'); // -30m
    expect(plan[3]!.dueAt).toBe('2026-08-16T14:55:00.000Z'); // -15m
    expect(plan[4]!.dueAt).toBe('2026-08-16T15:15:00.000Z'); // +5m
    expect(plan[5]!.dueAt).toBe('2026-08-16T15:25:00.000Z'); // +15m
    expect(plan[6]!.dueAt).toBe('2026-08-16T15:40:00.000Z'); // +30m
    expect(plan[7]!.dueAt).toBe('2026-08-16T16:10:00.000Z'); // +60m
    expect(plan[8]!.dueAt).toBe('2026-08-16T21:10:00.000Z'); // +6h
    expect(plan[9]!.dueAt).toBe('2026-08-17T03:10:00.000Z'); // +12h
    expect(plan[10]!.dueAt).toBe('2026-08-17T15:10:00.000Z'); // +24h
  });

  it('ct_publish is always exact confidence, observed provenance, zero uncertainty', () => {
    const plan = snapshotPlan({
      trade_hash: 'h1', ticker: 'AAPL', provider: 'fmp',
      congress_first_seen_at: '2026-08-16T15:00:00.000Z',
      provider_first_seen_at: null, provider_published_at: null,
      provider_window_start: null, provider_window_end: null,
    });
    expect(plan).toEqual([{
      event: 'ct_publish',
      dueAt: '2026-08-16T15:00:00.000Z',
      confidence: 'exact',
      uncertaintySec: 0,
      timeProvenance: 'observed',
    }]);
  });

  it('provider_publish family uses provider_first_seen_at for offsets and bracketed confidence even if provider_published_at exists', () => {
    const plan = snapshotPlan({
      trade_hash: 'h1', ticker: 'AAPL', provider: 'unusual_whales',
      congress_first_seen_at: '2026-08-16T15:00:00.000Z',
      provider_first_seen_at: '2026-08-16T15:12:00.000Z',
      provider_published_at: '2026-08-16T15:11:00.000Z',
      provider_window_start: '2026-08-16T14:00:00.000Z',
      provider_window_end: '2026-08-16T15:12:00.000Z',
    });
    const pub = plan.find((p) => p.event === 'provider_publish')!;
    expect(pub.dueAt).toBe('2026-08-16T15:12:00.000Z');
    expect(pub.confidence).toBe('bracketed');
    expect(pub.timeProvenance).toBe('observed');
    expect(pub.uncertaintySec).toBe(4320); // 15:12 - 14:00 (72 minutes)
    expect(plan.find((p) => p.event === 'provider_plus_5m')?.dueAt).toBe(addMs('2026-08-16T15:12:00.000Z', 5 * 60_000));
  });

  it('provider_publish family is bracketed with the window width when only a probe bracket exists', () => {
    const plan = snapshotPlan({
      trade_hash: 'h1', ticker: 'AAPL', provider: 'quiver',
      congress_first_seen_at: '2026-08-16T15:00:00.000Z',
      provider_first_seen_at: '2026-08-16T15:30:00.000Z',
      provider_published_at: null,
      provider_window_start: '2026-08-16T15:00:00.000Z',
      provider_window_end: '2026-08-16T15:30:00.000Z',
    });
    const pub = plan.find((p) => p.event === 'provider_publish')!;
    expect(pub.dueAt).toBe('2026-08-16T15:30:00.000Z');
    expect(pub.confidence).toBe('bracketed');
    expect(pub.timeProvenance).toBe('observed');
    expect(pub.uncertaintySec).toBe(1800);
    // Every follow-up inherits the same confidence.
    expect(plan.filter((p) => p.event !== 'ct_publish').every((p) => p.confidence === 'bracketed')).toBe(true);
  });

  it('provider_publish family is unbounded when neither a published time nor a probe bracket exists', () => {
    const plan = snapshotPlan({
      trade_hash: 'h1', ticker: 'AAPL', provider: 'quiver',
      congress_first_seen_at: '2026-08-16T15:00:00.000Z',
      provider_first_seen_at: '2026-08-16T15:30:00.000Z',
      provider_published_at: null,
      provider_window_start: null,
      provider_window_end: null,
    });
    const pub = plan.find((p) => p.event === 'provider_publish')!;
    expect(pub.confidence).toBe('unbounded');
    expect(pub.timeProvenance).toBe('observed');
    expect(pub.uncertaintySec).toBeNull();
  });

  it('marks provider_publish as claimed when only the competitor stamp exists', () => {
    const plan = snapshotPlan({
      trade_hash: 'h1', ticker: 'AAPL', provider: 'quiver',
      congress_first_seen_at: '2026-08-16T15:00:00.000Z',
      provider_first_seen_at: null,
      provider_published_at: '2026-08-16T15:11:00.000Z',
      provider_window_start: null,
      provider_window_end: null,
    });
    const pub = plan.find((p) => p.event === 'provider_publish')!;
    expect(pub.dueAt).toBe('2026-08-16T15:11:00.000Z');
    expect(pub.confidence).toBe('exact');
    expect(pub.timeProvenance).toBe('claimed');
    expect(plan.filter((p) => p.event !== 'ct_publish').every((p) => p.timeProvenance === 'claimed')).toBe(true);
  });

  it('skips options and Kalshi event contracts instead of planning equity minute prints', () => {
    expect(snapshotPlan({
      trade_hash: 'h1', ticker: 'AAPL', provider: 'fmp',
      congress_first_seen_at: '2026-08-16T15:00:00.000Z',
      provider_first_seen_at: '2026-08-16T15:10:00.000Z', provider_published_at: null,
      provider_window_start: null, provider_window_end: null,
      is_option: 1,
    })).toEqual([]);
    expect(snapshotPlan({
      trade_hash: 'h1', ticker: 'FED', provider: 'fmp',
      congress_first_seen_at: '2026-08-16T15:00:00.000Z',
      provider_first_seen_at: '2026-08-16T15:10:00.000Z', provider_published_at: null,
      provider_window_start: null, provider_window_end: null,
      asset_name: 'Kalshi Fed decision',
    })).toEqual([]);
  });

  it('skips blank or absurd tickers', () => {
    expect(snapshotPlan({
      trade_hash: 'h1', ticker: null, provider: 'fmp',
      congress_first_seen_at: '2026-08-16T15:00:00.000Z',
      provider_first_seen_at: '2026-08-16T15:10:00.000Z', provider_published_at: null,
      provider_window_start: null, provider_window_end: null,
    })).toEqual([]);
    expect(snapshotPlan({
      trade_hash: 'h1', ticker: 'THIS-IS-NOT-A-TICKER', provider: 'fmp',
      congress_first_seen_at: '2026-08-16T15:00:00.000Z',
      provider_first_seen_at: '2026-08-16T15:10:00.000Z', provider_published_at: null,
      provider_window_start: null, provider_window_end: null,
    })).toEqual([]);
  });

  it('keeps the live-quote stale window at three minutes', () => {
    expect(SNAPSHOT_STALE_MS).toBe(180_000);
  });
});

// ---------------------------------------------------------------------------
// Static regression guard — FMP must never come back as a price source.
// ---------------------------------------------------------------------------

describe('never reintroduces the paid quote provider this pipeline was built to remove', () => {
  it('the source file contains no fmp / financialmodelingprep token anywhere, including comments', () => {
    const src = readFileSync(new URL('../latencyPriceSnapshots.ts', import.meta.url), 'utf8');
    expect(/fmp|financialmodelingprep/i.test(src)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Behavioral tests — real migrated SQLite + a URL-routed fetch stub standing
// in for the peer's /api/market/quotes and /api/market/intraday/{ticker}.
// ---------------------------------------------------------------------------

let db: SqliteDatabase;
let env: Env;
let close: () => void;

beforeEach(async () => {
  const opened = await openMigratedD1();
  db = opened.db;
  close = opened.close;
  env = {
    DB: opened.d1,
    APP_B_IMPORT_URL: 'https://peer.example',
    APP_B_INGEST_TOKEN: 'test-token',
  } as unknown as Env;
});
afterEach(() => close());

function insertDueRow(opts: {
  tradeHash?: string;
  ticker: string;
  provider?: string;
  event?: string;
  dueAt: string;
  backfillAttempts?: number;
  error?: string | null;
}): void {
  db.prepare(
    `INSERT INTO latency_price_snapshots
       (trade_hash, ticker, provider, event, due_at, created_at, backfill_attempts, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.tradeHash ?? `h-${opts.ticker}-${opts.event ?? 'provider_publish'}`,
    opts.ticker,
    opts.provider ?? 'fmp',
    opts.event ?? 'provider_publish',
    opts.dueAt,
    '2026-08-16T00:00:00.000Z',
    opts.backfillAttempts ?? 0,
    opts.error ?? null,
  );
}

function readRow(tradeHash: string, provider: string, event: string): Record<string, unknown> | undefined {
  return db
    .prepare('SELECT * FROM latency_price_snapshots WHERE trade_hash = ? AND provider = ? AND event = ?')
    .get(tradeHash, provider, event) as Record<string, unknown> | undefined;
}

interface RecordedCall {
  kind: 'quotes' | 'intraday' | 'other';
  url: string;
}

/** Routes by URL shape to independently controllable quotes/intraday responders,
 *  and records every call so tests can assert on what was (or was not) requested. */
function buildFetch(handlers: {
  quotes?: (url: string) => Response | Promise<Response>;
  intraday?: (url: string) => Response | Promise<Response>;
  calls?: RecordedCall[];
}): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const kind: RecordedCall['kind'] = url.includes('/api/market/quotes')
      ? 'quotes'
      : url.includes('/api/market/intraday/')
        ? 'intraday'
        : 'other';
    handlers.calls?.push({ kind, url });
    if (kind === 'quotes') return handlers.quotes ? handlers.quotes(url) : new Response(JSON.stringify({ quotes: {} }), { status: 200 });
    if (kind === 'intraday') return handlers.intraday ? handlers.intraday(url) : new Response(JSON.stringify({ bars: [] }), { status: 200 });
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

describe('captureDueLatencyPriceSnapshots — live/backfill branch selection', () => {
  it('NEVER requests a live quote for a row whose due_at already aged past SNAPSHOT_STALE_MS — routes straight to backfill', async () => {
    const now = new Date('2026-08-16T15:10:00.000Z');
    insertDueRow({ ticker: 'AAPL', dueAt: '2026-08-16T15:00:00.000Z' }); // 10 min stale
    const calls: RecordedCall[] = [];
    const fetchImpl = buildFetch({ calls, intraday: () => new Response(JSON.stringify({ bars: [] }), { status: 200 }) });

    await captureDueLatencyPriceSnapshots(env, now, fetchImpl);

    expect(calls.some((c) => c.kind === 'quotes')).toBe(false);
    expect(calls.some((c) => c.kind === 'intraday')).toBe(true);
  });

  it('captures a LIVE quote for a row due within the stale window and stamps capture_mode=live', async () => {
    const now = new Date('2026-08-16T15:00:30.000Z');
    insertDueRow({ tradeHash: 'h1', ticker: 'AAPL', dueAt: '2026-08-16T15:00:00.000Z' });
    const fetchImpl = buildFetch({
      quotes: () => new Response(JSON.stringify({ quotes: { AAPL: { price: 190.5, source: 'alpaca-snapshot' } } }), { status: 200 }),
    });

    const result = await captureDueLatencyPriceSnapshots(env, now, fetchImpl);
    expect(result.liveCaptured).toBe(1);

    const row = readRow('h1', 'fmp', 'provider_publish')!;
    expect(row.price).toBe(190.5);
    expect(row.source).toBe('alpaca-snapshot');
    expect(row.capture_mode).toBe('live');
    expect(row.captured_at).not.toBeNull();
    expect(row.error).toBeNull();
  });

  it('a live-eligible row the peer cannot quote is left pending (no fabricated price, no error) for the next tick', async () => {
    const now = new Date('2026-08-16T15:00:30.000Z');
    insertDueRow({ tradeHash: 'h1', ticker: 'AAPL', dueAt: '2026-08-16T15:00:00.000Z' });
    const fetchImpl = buildFetch({ quotes: () => new Response(JSON.stringify({ quotes: {} }), { status: 200 }) });

    const result = await captureDueLatencyPriceSnapshots(env, now, fetchImpl);
    expect(result.liveCaptured).toBe(0);
    expect(result.deferred).toBe(1);

    const row = readRow('h1', 'fmp', 'provider_publish')!;
    expect(row.captured_at).toBeNull();
    expect(row.error).toBeNull();
    expect(row.price).toBeNull();
  });
});

describe('captureDueLatencyPriceSnapshots — backfill outcomes (#2959 discrimination is load-bearing)', () => {
  it('a SINGLE HTTP 200 with bars:[] does NOT terminate the row — one empty answer is not proof', async () => {
    // Deploy-ordering guard. Until Socratic.Trade PR #2959 is live, ST collapses EVERY intraday
    // failure (missing credential, timeout, upstream 500) into 200 {bars: []}. If one empty answer
    // terminated the row, a single ST-side hiccup would convert the whole reopened backlog into
    // "confirmed no trading happened" at CAPTURE_BATCH rows/minute, and the due query
    // (captured_at IS NULL) could never re-select them. Empty must corroborate instead.
    const now = new Date('2026-08-16T20:00:00.000Z');
    insertDueRow({ tradeHash: 'h1', ticker: 'AAPL', dueAt: '2026-08-16T15:00:00.000Z' });
    const fetchImpl = buildFetch({ intraday: () => new Response(JSON.stringify({ bars: [] }), { status: 200 }) });

    const result = await captureDueLatencyPriceSnapshots(env, now, fetchImpl);
    expect(result.terminalNoData).toBe(0);

    const row = readRow('h1', 'fmp', 'provider_publish')!;
    expect(row.captured_at).toBeNull();
    expect(row.error).toBeNull();
    expect(row.price).toBeNull();
    expect(row.backfill_attempts).toBe(1);
  });

  it('after MAX_BACKFILL_ATTEMPTS consecutive empty answers the row terminates as confirmed_no_bars', async () => {
    // A genuine weekend/halt range still reaches a terminal state - just over several ticks
    // rather than on the first response.
    const now = new Date('2026-08-16T20:00:00.000Z');
    insertDueRow({ tradeHash: 'h1', ticker: 'AAPL', dueAt: '2026-08-16T15:00:00.000Z', backfillAttempts: 4 });
    const fetchImpl = buildFetch({ intraday: () => new Response(JSON.stringify({ bars: [] }), { status: 200 }) });

    const result = await captureDueLatencyPriceSnapshots(env, now, fetchImpl);
    expect(result.terminalNoData).toBe(1);

    const row = readRow('h1', 'fmp', 'provider_publish')!;
    expect(row.error).toBe('confirmed_no_bars');
    expect(row.price).toBeNull();
    expect(row.captured_at).not.toBeNull();
    expect(row.backfill_attempts).toBe(5);
  });

  it('a non-200 intraday response is UNAVAILABLE — retryable, captured_at stays NULL, backfill_attempts increments, no price written', async () => {
    const now = new Date('2026-08-16T20:00:00.000Z');
    insertDueRow({ tradeHash: 'h1', ticker: 'AAPL', dueAt: '2026-08-16T15:00:00.000Z' });
    const fetchImpl = buildFetch({ intraday: () => new Response('bad gateway', { status: 502 }) });

    const result = await captureDueLatencyPriceSnapshots(env, now, fetchImpl);
    expect(result.terminalNoData).toBe(0);
    expect(result.deferred).toBe(1);

    const row = readRow('h1', 'fmp', 'provider_publish')!;
    expect(row.captured_at).toBeNull();
    expect(row.error).toBeNull();
    expect(row.price).toBeNull();
    expect(row.backfill_attempts).toBe(1);
  });

  it('after MAX_BACKFILL_ATTEMPTS consecutive unavailable results the row terminates as backfill_exhausted', async () => {
    const now = new Date('2026-08-16T20:00:00.000Z');
    insertDueRow({ tradeHash: 'h1', ticker: 'AAPL', dueAt: '2026-08-16T15:00:00.000Z', backfillAttempts: 4 });
    const fetchImpl = buildFetch({ intraday: () => new Response('bad gateway', { status: 502 }) });

    const result = await captureDueLatencyPriceSnapshots(env, now, fetchImpl);
    expect(result.terminalNoData).toBe(1);

    const row = readRow('h1', 'fmp', 'provider_publish')!;
    expect(row.error).toBe('backfill_exhausted');
    expect(row.captured_at).not.toBeNull();
    expect(row.price).toBeNull();
    expect(row.backfill_attempts).toBe(5);
  });

  it('finds and prices the nearest bar at-or-after due_at, and reports no_bar_in_tolerance when nothing qualifies', async () => {
    const now = new Date('2026-08-16T20:00:00.000Z');
    insertDueRow({ tradeHash: 'h1', ticker: 'AAPL', dueAt: '2026-08-16T15:00:00.000Z' });
    insertDueRow({ tradeHash: 'h2', ticker: 'AAPL', event: 'ct_publish', dueAt: '2026-08-16T15:00:00.000Z' });
    const fetchImpl = buildFetch({
      intraday: () =>
        new Response(
          JSON.stringify({ bars: [{ t: '2026-08-16T14:58:00.000Z', c: 99 }, { t: '2026-08-16T15:02:00.000Z', c: 101.25 }] }),
          { status: 200 },
        ),
    });

    await captureDueLatencyPriceSnapshots(env, now, fetchImpl);
    const priced = readRow('h1', 'fmp', 'provider_publish')!;
    expect(priced.price).toBe(101.25);
    expect(priced.source).toBe('peer-intraday');
    expect(priced.error).toBeNull();

    // Same group, but tighten by re-running with a bar list that has nothing
    // in tolerance for a due_at far from any bar.
    db.prepare(`DELETE FROM latency_price_snapshots`).run();
    insertDueRow({ tradeHash: 'h3', ticker: 'MSFT', dueAt: '2026-08-16T15:00:00.000Z' });
    const farFetch = buildFetch({
      intraday: () => new Response(JSON.stringify({ bars: [{ t: '2026-08-16T15:30:00.000Z', c: 400 }] }), { status: 200 }),
    });
    await captureDueLatencyPriceSnapshots(env, now, farFetch);
    const unmatched = readRow('h3', 'fmp', 'provider_publish')!;
    expect(unmatched.error).toBe('no_bar_in_tolerance');
    expect(unmatched.price).toBeNull();
  });
});

describe('captureDueLatencyPriceSnapshots — batching', () => {
  it('groups due rows by (ticker, ET calendar date) into exactly one intraday call per group', async () => {
    const now = new Date('2026-08-16T20:00:00.000Z');
    // Same ticker, same day, three different events -> one call.
    insertDueRow({ tradeHash: 'h1', ticker: 'AAPL', event: 'provider_publish', dueAt: '2026-08-16T15:00:00.000Z' });
    insertDueRow({ tradeHash: 'h1', ticker: 'AAPL', event: 'provider_plus_5m', dueAt: '2026-08-16T15:05:00.000Z' });
    insertDueRow({ tradeHash: 'h2', ticker: 'AAPL', event: 'provider_publish', dueAt: '2026-08-16T16:00:00.000Z' });
    const calls: RecordedCall[] = [];
    const fetchImpl = buildFetch({ calls, intraday: () => new Response(JSON.stringify({ bars: [] }), { status: 200 }) });

    await captureDueLatencyPriceSnapshots(env, now, fetchImpl);
    expect(calls.filter((c) => c.kind === 'intraday')).toHaveLength(1);
  });

  it('splits into separate calls across different ET calendar dates, even for the same ticker', async () => {
    const now = new Date('2026-08-17T20:00:00.000Z');
    insertDueRow({ tradeHash: 'h1', ticker: 'AAPL', event: 'provider_publish', dueAt: '2026-08-16T15:00:00.000Z' });
    insertDueRow({ tradeHash: 'h2', ticker: 'AAPL', event: 'provider_publish', dueAt: '2026-08-17T15:00:00.000Z' });
    const calls: RecordedCall[] = [];
    const fetchImpl = buildFetch({ calls, intraday: () => new Response(JSON.stringify({ bars: [] }), { status: 200 }) });

    await captureDueLatencyPriceSnapshots(env, now, fetchImpl);
    expect(calls.filter((c) => c.kind === 'intraday')).toHaveLength(2);
  });

  it('batches every live-eligible ticker into a single /api/market/quotes call', async () => {
    const now = new Date('2026-08-16T15:00:30.000Z');
    insertDueRow({ tradeHash: 'h1', ticker: 'AAPL', dueAt: '2026-08-16T15:00:00.000Z' });
    insertDueRow({ tradeHash: 'h2', ticker: 'MSFT', dueAt: '2026-08-16T15:00:00.000Z' });
    const calls: RecordedCall[] = [];
    const fetchImpl = buildFetch({
      calls,
      quotes: () =>
        new Response(JSON.stringify({ quotes: { AAPL: { price: 1, source: 'x' }, MSFT: { price: 2, source: 'x' } } }), { status: 200 }),
    });

    await captureDueLatencyPriceSnapshots(env, now, fetchImpl);
    expect(calls.filter((c) => c.kind === 'quotes')).toHaveLength(1);
  });
});

describe('captureDueLatencyPriceSnapshots — invariant sweep', () => {
  it('never leaves a row with captured_at set but both price AND error NULL', async () => {
    const now = new Date('2026-08-16T20:00:00.000Z');
    // A mix of outcomes: live capture, confirmed-empty, retry-then-exhaust, bar match.
    insertDueRow({ tradeHash: 'h-live', ticker: 'AAPL', dueAt: '2026-08-16T19:59:00.000Z' });
    insertDueRow({ tradeHash: 'h-empty', ticker: 'MSFT', dueAt: '2026-08-16T15:00:00.000Z' });
    insertDueRow({ tradeHash: 'h-exhaust', ticker: 'NVDA', dueAt: '2026-08-16T15:00:00.000Z', backfillAttempts: 4 });
    insertDueRow({ tradeHash: 'h-bar', ticker: 'TSLA', dueAt: '2026-08-16T15:00:00.000Z' });

    const fetchImpl = buildFetch({
      quotes: () => new Response(JSON.stringify({ quotes: { AAPL: { price: 5, source: 'x' } } }), { status: 200 }),
      intraday: (url) => {
        if (url.includes('/MSFT')) return new Response(JSON.stringify({ bars: [] }), { status: 200 });
        if (url.includes('/NVDA')) return new Response('down', { status: 502 });
        if (url.includes('/TSLA')) return new Response(JSON.stringify({ bars: [{ t: '2026-08-16T15:01:00.000Z', c: 250 }] }), { status: 200 });
        return new Response(JSON.stringify({ bars: [] }), { status: 200 });
      },
    });

    await captureDueLatencyPriceSnapshots(env, now, fetchImpl);

    const rows = db
      .prepare('SELECT trade_hash, captured_at, price, error FROM latency_price_snapshots')
      .all() as Array<{ trade_hash: string; captured_at: string | null; price: number | null; error: string | null }>;
    const violating = rows.filter((r) => r.captured_at !== null && r.price === null && r.error === null);
    expect(violating).toEqual([]);
  });
});

describe('scheduleMissingLatencyPriceSnapshots — interaction with inline ct_publish scheduling', () => {
  it('a candidate whose ct_publish row was already scheduled inline still gets provider_publish + offsets once matched', async () => {
    // Simulate the inline write recordTradeLatencyCandidates now performs at
    // mint time, BEFORE the candidate is matched.
    await scheduleCtPublishSnapshot(
      env,
      { trade_hash: 'h1', ticker: 'AAPL', provider: 'fmp', congress_first_seen_at: '2026-08-16T15:00:00.000Z' },
      '2026-08-16T15:00:00.000Z',
    );

    db.prepare(
      `INSERT INTO trade_latency_candidates
         (trade_hash, doc_id, provider, chamber, congress_first_seen_at, provider_first_seen_at, provider_published_at,
          status, attempts, created_at, updated_at, ticker)
       VALUES ('h1', 'doc-1', 'fmp', 'house', '2026-08-16T15:00:00.000Z', '2026-08-16T15:10:00.000Z', NULL,
               'matched', 1, '2026-08-16T15:00:00.000Z', '2026-08-16T15:10:00.000Z', 'AAPL')`,
    ).run();

    const { scheduled } = await scheduleMissingLatencyPriceSnapshots(env, new Date('2026-08-16T15:10:01.000Z'));
    expect(scheduled).toBeGreaterThan(0);

    const events = (
      db.prepare('SELECT event FROM latency_price_snapshots WHERE trade_hash = ? ORDER BY event').all('h1') as Array<{ event: string }>
    ).map((r) => r.event);
    expect(events).toContain('provider_publish');
    expect(events).toContain('provider_plus_15m');
    // ct_publish was inserted exactly once (the inline write), never duplicated.
    expect(events.filter((e) => e === 'ct_publish')).toHaveLength(1);
  });

  it('does not schedule ct_publish for options or event contracts', async () => {
    await scheduleCtPublishSnapshot(
      env,
      {
        trade_hash: 'opt1',
        ticker: 'AAPL',
        provider: 'fmp',
        congress_first_seen_at: '2026-08-16T15:00:00.000Z',
        isOption: true,
      },
      '2026-08-16T15:00:00.000Z',
    );
    await scheduleCtPublishSnapshot(
      env,
      {
        trade_hash: 'ev1',
        ticker: 'FED',
        provider: 'fmp',
        congress_first_seen_at: '2026-08-16T15:00:00.000Z',
        assetName: 'Kalshi Fed decision',
      },
      '2026-08-16T15:00:00.000Z',
    );
    const rows = db.prepare('SELECT trade_hash FROM latency_price_snapshots').all() as Array<{ trade_hash: string }>;
    expect(rows).toEqual([]);
  });
});

describe('summarizeProviderPublishBump', () => {
  it('excludes a pub/later pair when either side did not capture during the regular session', async () => {
    const insertPriced = (hash: string, event: string, price: number, session: string) => {
      db.prepare(
        `INSERT INTO latency_price_snapshots (trade_hash, ticker, provider, event, due_at, created_at, captured_at, price, market_session)
         VALUES (?, 'AAPL', 'fmp', ?, '2026-08-16T15:00:00.000Z', '2026-08-16T15:00:00.000Z', '2026-08-16T15:00:01.000Z', ?, ?)`,
      ).run(hash, event, price, session);
    };
    // In-session pair: counted.
    insertPriced('a', 'provider_publish', 100, 'regular');
    insertPriced('a', 'provider_plus_5m', 101, 'regular');
    // Crosses the close: excluded even though both prices exist.
    insertPriced('b', 'provider_publish', 100, 'regular');
    insertPriced('b', 'provider_plus_5m', 102, 'post');

    const buckets = await summarizeProviderPublishBump(env);
    const fiveMin = buckets.find((b) => b.event === 'provider_plus_5m')!;
    expect(fiveMin.n).toBe(1);
    expect(fiveMin.medianBps).toBeCloseTo(100, 5);
  });

  it('includes the +15m rung in its output', async () => {
    const buckets = await summarizeProviderPublishBump(env);
    expect(buckets.map((b) => b.event)).toEqual([
      'provider_minus_30m',
      'provider_minus_15m',
      'provider_plus_5m',
      'provider_plus_15m',
      'provider_plus_30m',
      'provider_plus_60m',
      'provider_plus_6h',
      'provider_plus_12h',
      'provider_plus_24h',
    ]);
  });
});
