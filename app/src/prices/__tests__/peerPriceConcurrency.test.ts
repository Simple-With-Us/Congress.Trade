/**
 * src/prices/__tests__/peerPriceConcurrency.test.ts
 *
 * The bounded-concurrency fetch stage of runPriceRefresh (CT-2445 follow-up):
 * the catch-up opts into several in-flight Socratic.Trade fetches so a run
 * stops spending its lane deadline on ~10s cold-fetch latency.  These tests
 * pin the invariants that make the pool safe:
 *  - in-flight fetches never exceed the concurrency bound, and the pool
 *    really does overlap fetches (out-of-order completions still process in
 *    page order);
 *  - the shared pacer still governs the aggregate request rate — every
 *    fetch is paced, and fetch starts stay one pacer slot apart;
 *  - an abort mid-batch leaves consistent state:  a ticker is either fully
 *    priced or completely untouched, never a phantom price_checked_at;
 *  - per-ticker failure isolation matches the serial walk (a non-fatal error
 *    marks only its own ticker;  a confirmed empty negative-caches only its
 *    own ticker);
 *  - a fatal error halts the walk within one pool width — nothing past the
 *    failing ticker is written, and the pool never claims a fetch more than
 *    `concurrency` past the last processed ticker;
 *  - the fetch window is the plan's scoped missing window, unchanged by the
 *    pool (narrow incremental for a covered ticker;  oldest uncovered trade
 *    for a never-priced one).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Use the REAL createPacer (wrapped with a counter) so the rate test below
// exercises the same slot-claiming the shared pacer does in production.
// Pacing's own unit tests live in shared/__tests__/pace.test.ts.
const h = vi.hoisted(() => ({
  eodCalls: [] as Array<{ symbol: string; from: string; to: string; startedAt: number }>,
  responses: new Map<string, Array<{ date: string; close: number }>>(),
  errors: new Map<string, string>(),
  delaysMs: new Map<string, number>(),
  rejectWithOnAbort: new Map<string, string>(),
  inFlight: 0,
  maxInFlight: 0,
  paceCalls: 0,
}));

vi.mock('../../shared/pace.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/pace.ts')>();
  return {
    ...actual,
    getSharedStPeerPacer: (maxPerMinute?: number) => {
      const inner = actual.createPacer(maxPerMinute);
      return async () => {
        h.paceCalls++;
        await inner();
      };
    },
  };
});

vi.mock('../../secrets/infisical', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../secrets/infisical')>()),
  resolveSecrets: vi.fn(async () => ({})),
}));

vi.mock('../peer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../peer.ts')>();
  // A delay that honors the per-call signal the way the real peer client
  // does:  a fetch in flight when the signal fires rejects immediately
  // instead of running to its full delay.  The rejection is the signal's
  // reason — or, for symbols in rejectWithOnAbort, that provider error
  // instead:  a provider response that settled at the same moment the
  // deadline fired, whose rejection is the provider's own even though the
  // signal is aborted by the time the caller classifies it.
  const waitWithSignal = (symbol: string, ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      if (signal) {
        const onAbort = () => {
          clearTimeout(t);
          const raced = h.rejectWithOnAbort.get(symbol);
          reject(raced ? new Error(raced) : signal.reason);
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  return {
    ...actual,
    buildPeerPriceClient: () => ({
      eodHistory: async (symbol: string, from?: string, to?: string, signal?: AbortSignal) => {
        h.inFlight++;
        h.maxInFlight = Math.max(h.maxInFlight, h.inFlight);
        h.eodCalls.push({ symbol, from: from ?? '', to: to ?? '', startedAt: Date.now() });
        try {
          const d = h.delaysMs.get(symbol) ?? 0;
          if (d > 0) await waitWithSignal(symbol, d, signal);
          const err = h.errors.get(symbol);
          if (err) throw new Error(err);
          return h.responses.get(symbol) ?? [];
        } finally {
          h.inFlight--;
        }
      },
      spxHistory: async (from?: string, to?: string, signal?: AbortSignal) => {
        h.eodCalls.push({ symbol: 'SPY', from: from ?? '', to: to ?? '', startedAt: Date.now() });
        const d = h.delaysMs.get('SPY') ?? 0;
        if (d > 0) await waitWithSignal('SPY', d, signal);
        const err = h.errors.get('SPY');
        if (err) throw new Error(err);
        return h.responses.get('SPY') ?? [];
      },
    }),
  };
});

import type { Env } from '../../shared/types.ts';
import { runPriceRefresh } from '../service.ts';
import { PEER_PRICE_CATCHUP_FETCH_CONCURRENCY } from '../peerPriceCatchUp.ts';
import { openMigratedD1, type SqliteDatabase } from './sqliteD1.ts';

let db: SqliteDatabase;
let env: Env;
let close: () => void;

beforeEach(async () => {
  h.eodCalls.length = 0;
  h.responses.clear();
  h.errors.clear();
  h.delaysMs.clear();
  h.rejectWithOnAbort.clear();
  h.inFlight = 0;
  h.maxInFlight = 0;
  h.paceCalls = 0;
  const opened = await openMigratedD1();
  db = opened.db;
  close = opened.close;
  env = {
    DB: opened.d1,
    APP_B_IMPORT_URL: 'https://socratic.trade',
    APP_B_INGEST_TOKEN: 'test-token',
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
      `SELECT price_unavailable, price_checked_at, price_unavailable_reason, latest_price_date, current_price
         FROM securities_ref WHERE ticker = ?`,
    )
    .get(ticker) as Record<string, unknown> | undefined;
}

function eodCount(ticker: string): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM price_eod WHERE ticker = ?').get(ticker) as { n: number };
  return row.n;
}

function recentDate(daysAgoN: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgoN);
  return d.toISOString().slice(0, 10);
}

function freshCloses(closePrice = 100): Array<{ date: string; close: number }> {
  return [{ date: recentDate(1), close: closePrice }];
}

describe('runPriceRefresh — bounded-concurrency fetch stage (CT-2445)', () => {
  it('exposes the catch-up pool width as a named bound of 4', () => {
    expect(PEER_PRICE_CATCHUP_FETCH_CONCURRENCY).toBe(4);
  });

  it('never exceeds the in-flight bound, overlaps fetches, and still processes in page order', async () => {
    const tickers = Array.from({ length: 10 }, (_, i) => `CC${i}`);
    tickers.forEach((t, i) => {
      seedTrade(`c${i}`, t, `2026-01-${String(i + 1).padStart(2, '0')}`);
      // Later tickers answer FASTER, so fetches complete out of order;  the
      // result must still be processed (and reported) in page order.
      h.delaysMs.set(t, (tickers.length - i) * 15);
      h.responses.set(t, freshCloses(50 + i));
    });

    const res = await runPriceRefresh(env, { max: 20, concurrency: 4, maxPerMinute: 100_000 });

    expect(res.aborted).toBe(false);
    expect(res.errors).toEqual([]);
    expect(res.tickersPriced).toBe(10);
    expect(h.maxInFlight).toBeLessThanOrEqual(4);
    expect(h.maxInFlight).toBeGreaterThanOrEqual(3); // the pool really overlaps
    expect(res.sharePrices.map((s) => s.ticker)).toEqual(tickers);
    for (const t of tickers) expect(eodCount(t)).toBeGreaterThan(0);
  });

  it('keeps the shared pacer governing the aggregate request rate under concurrency', async () => {
    const tickers = Array.from({ length: 8 }, (_, i) => `PC${i}`);
    tickers.forEach((t, i) => {
      seedTrade(`p${i}`, t, `2026-02-${String(i + 1).padStart(2, '0')}`);
      // Each fetch occupies a worker for 200ms;  without pacing, four workers
      // would start fetches in bursts of four.  At 1200/min the pacer's slots
      // are 50ms apart, so starts must stay ~50ms apart even with 4 in flight.
      h.delaysMs.set(t, 200);
      h.responses.set(t, freshCloses());
    });

    const started = Date.now();
    const res = await runPriceRefresh(env, { max: 20, concurrency: 4, maxPerMinute: 1200 });
    const elapsed = Date.now() - started;

    expect(res.tickersPriced).toBe(8);
    // Every provider call — the S&P fetch and each ticker fetch — was paced.
    expect(h.paceCalls).toBe(h.eodCalls.length);
    expect(h.eodCalls.length).toBe(9);
    const starts = h.eodCalls
      .filter((c) => c.symbol !== 'SPY')
      .map((c) => c.startedAt)
      .sort((a, b) => a - b);
    // Pacer slots are claimed in order and a slot never fires early, so the
    // 8 ticker starts span at least ~7 slots (350ms ideal).  A pairwise gap
    // can compress when the event loop is busy with the processor's writes,
    // so the span — the aggregate rate — is the stable invariant.
    expect(starts[starts.length - 1] - starts[0]).toBeGreaterThanOrEqual(300);
    // 9 paced calls at 50ms slots cannot all fire inside ~350ms.
    expect(elapsed).toBeGreaterThanOrEqual(350);
  });

  it('abort mid-batch leaves consistent state — priced or untouched, never a phantom stamp', async () => {
    const tickers = Array.from({ length: 8 }, (_, i) => `AB${i}`);
    tickers.forEach((t, i) => {
      seedTrade(`a${i}`, t, `2026-03-${String(i + 1).padStart(2, '0')}`);
      h.delaysMs.set(t, 150);
      h.responses.set(t, freshCloses());
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);

    const res = await runPriceRefresh(env, {
      max: 20,
      concurrency: 4,
      maxPerMinute: 100_000,
      signal: controller.signal,
    });

    expect(res.aborted).toBe(true);
    // Work finished before the abort is kept;  the batch did not complete.
    expect(res.tickersPriced).toBeGreaterThanOrEqual(1);
    expect(res.tickersPriced).toBeLessThan(8);
    let pricedInDb = 0;
    for (const t of tickers) {
      const row = srRow(t);
      if (eodCount(t) > 0) {
        pricedInDb++;
        // Fully priced:  bars AND the freshness stamp landed together.
        expect(row?.latest_price_date).toBeTruthy();
        expect(row?.price_checked_at).toBeTruthy();
      } else {
        // Untouched:  no bars, and no price_checked_at stamp claiming a check
        // that never completed.
        expect(row?.price_checked_at ?? null).toBeNull();
        expect(row?.latest_price_date ?? null).toBeNull();
      }
    }
    expect(pricedInDb).toBe(res.tickersPriced);
    // The resume point is the last ticker actually finished, never an index
    // the pool stopped before claiming.
    let lastPricedSeq: number | null = null;
    for (const t of tickers) {
      if (eodCount(t) === 0) continue;
      const row = db
        .prepare('SELECT MAX(cursor_seq) AS s FROM transactions WHERE ticker = ?')
        .get(t) as { s: number };
      lastPricedSeq = Math.max(lastPricedSeq ?? row.s, row.s);
    }
    expect(res.lastCursorSeq).toBe(lastPricedSeq);
  });

  it('isolates per-ticker failures: one error and one empty among successes', async () => {
    const tickers = ['OKA', 'OKB', 'ERRC', 'OKD', 'EMPE', 'OKF'];
    tickers.forEach((t, i) => seedTrade(`f${i}`, t, `2026-04-${String(i + 1).padStart(2, '0')}`));
    for (const t of ['OKA', 'OKB', 'OKD', 'OKF']) h.responses.set(t, freshCloses());
    h.errors.set('ERRC', 'PEER_HTTP_500'); // non-fatal per-ticker error
    h.delaysMs.set('ERRC', 10);
    // The marker write is an UPDATE, so the erroring ticker needs a
    // securities_ref row for the outcome to land on (same as the serial walk).
    db.prepare(
      `INSERT INTO securities_ref (ticker, latest_price_date, enriched_at)
       VALUES ('ERRC', '2020-01-01', '2020-01-01T00:00:00Z')`,
    ).run();
    // EMPE returns the default [] — a confirmed empty.

    const res = await runPriceRefresh(env, { max: 20, concurrency: 4, maxPerMinute: 100_000 });

    expect(res.aborted).toBe(false);
    expect(res.errors).toEqual(['ERRC: PEER_HTTP_500']);
    expect(res.tickersPriced).toBe(4);
    // The erroring ticker:  outcome recorded, but stage and the checked-at
    // clock are untouched — exactly the serial walk's marker-only write.
    const errRow = srRow('ERRC');
    expect(errRow?.price_checked_at ?? null).toBeNull();
    expect(String(errRow?.price_unavailable_reason ?? '')).toContain('PEER_HTTP_500');
    expect(eodCount('ERRC')).toBe(0);
    // The empty ticker:  negative-cached at stage 1 with a real check stamp.
    const empRow = srRow('EMPE');
    expect(empRow?.price_unavailable).toBe(1);
    expect(empRow?.price_checked_at).toBeTruthy();
    for (const t of ['OKA', 'OKB', 'OKD', 'OKF']) expect(eodCount(t)).toBeGreaterThan(0);
  });

  it('a fatal error halts within one pool width and writes nothing past the failing ticker', async () => {
    const tickers = ['OK1', 'FATAL', 'LATE1', 'LATE2', 'LATE3', 'NEVER'];
    tickers.forEach((t, i) => seedTrade(`h${i}`, t, `2026-05-${String(i + 1).padStart(2, '0')}`));
    for (const t of tickers) {
      h.delaysMs.set(t, 120);
      h.responses.set(t, freshCloses(5));
    }
    h.errors.set('FATAL', 'PEER_HTTP_429'); // run-fatal

    const res = await runPriceRefresh(env, { max: 20, concurrency: 4, maxPerMinute: 100_000 });

    expect(res.aborted).toBe(true);
    expect(res.tickersPriced).toBe(1);
    // The lookahead gate:  NEVER sits 5 past OK1 — the pool can hold at most
    // `concurrency` unprocessed fetches, and the walk halted at FATAL (index
    // 1), so index 5 was never even fetched.
    expect(h.eodCalls.some((c) => c.symbol === 'NEVER')).toBe(false);
    // OK1 finished before the fatal error, so the resume point stays at OK1.
    const okSeq = db
      .prepare('SELECT MAX(cursor_seq) AS s FROM transactions WHERE ticker = ?')
      .get('OK1') as { s: number };
    expect(res.lastCursorSeq).toBe(okSeq.s);
    // Nothing past OK1 was written — fetched-or-not, LATE*/NEVER keep no
    // bars and no freshness stamp for the next run to trip over.
    expect(eodCount('OK1')).toBeGreaterThan(0);
    for (const t of ['FATAL', 'LATE1', 'LATE2', 'LATE3', 'NEVER']) {
      expect(eodCount(t)).toBe(0);
      expect(srRow(t)?.latest_price_date ?? null).toBeNull();
    }
  });

  it('processes the whole page when the page exactly spends the budget — no dropped tail', async () => {
    const tickers = ['BUD1', 'BUD2', 'BUD3', 'BUD4'];
    tickers.forEach((t, i) => {
      seedTrade(`b${i}`, t, `2026-06-${String(i + 1).padStart(2, '0')}`);
      // All four fetches start (and spend the budget down to zero) long
      // before the first one completes and the processor moves on.
      h.delaysMs.set(t, 100);
      h.responses.set(t, freshCloses());
    });

    // max 5 = the S&P call + exactly these 4 tickers, so the last fetch
    // spends the final budget unit mid-page.
    const res = await runPriceRefresh(env, { max: 5, concurrency: 4, maxPerMinute: 100_000 });

    // Every claimed ticker was already paid for;  dropping the tail here
    // would waste the fetches and re-pay them next run.
    expect(res.tickersPriced).toBe(4);
    expect(res.fmpCalls).toBe(5);
    expect(res.budgetRemaining).toBe(0);
    for (const t of tickers) expect(eodCount(t)).toBeGreaterThan(0);
  });

  it('a fetch hanging until the lane signal fires settles the run — cancelled, not errored, no zombie', async () => {
    // The pre-fix failure:  the peer client never received the lane signal,
    // so a hanging Socratic.Trade response held its worker forever;  the
    // lane deadline aborted around it and the run's promise never settled.
    // Here the (mock) client honors the per-call signal exactly like the
    // real one now does, and the walk must settle promptly on abort with
    // the hanging ticker recorded as neither priced nor errored.
    seedTrade('z1', 'HANG', '2026-03-02');
    seedTrade('z2', 'AFTER', '2026-03-03');
    db.prepare(
      `INSERT INTO securities_ref (ticker, latest_price_date, enriched_at)
       VALUES ('HANG', '2020-01-01', '2020-01-01T00:00:00Z')`,
    ).run();
    h.delaysMs.set('HANG', 60_000); // effectively a hang; only the abort ends it
    h.responses.set('HANG', freshCloses());
    h.responses.set('AFTER', freshCloses());
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('lane deadline')), 100);

    const started = Date.now();
    const res = await runPriceRefresh(env, {
      max: 20,
      concurrency: 1,
      maxPerMinute: 100_000,
      signal: controller.signal,
    });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(10_000); // settled on the abort, not the 60s hang
    expect(res.aborted).toBe(true);
    expect(res.tickersPriced).toBe(0);
    // Cancellation is not a per-ticker failure:  no error entry, no marker,
    // no checked-at stamp for the ticker that was in flight.
    expect(res.errors).toEqual([]);
    const row = srRow('HANG');
    expect(row?.price_checked_at ?? null).toBeNull();
    expect(row?.price_unavailable_reason ?? null).toBeNull();
    expect(eodCount('HANG')).toBe(0);
    // The ticker behind the hanging one was never attempted.
    expect(h.eodCalls.some((c) => c.symbol === 'AFTER')).toBe(false);
  });

  it('fetches the scoped missing window under concurrency', async () => {
    // Covered cache:  narrow 7-day incremental off the cached max.
    seedTrade('w1', 'WARM', '2026-06-10');
    db.prepare("INSERT INTO price_eod (ticker, date, close) VALUES ('WARM', '2026-06-01', 100)").run();
    db.prepare("INSERT INTO price_eod (ticker, date, close) VALUES ('WARM', '2026-07-01', 110)").run();
    db.prepare(
      `INSERT INTO securities_ref (ticker, latest_price_date, enriched_at)
       VALUES ('WARM', '2020-01-01', '2020-01-01T00:00:00Z')`,
    ).run();
    h.responses.set('WARM', [{ date: '2026-07-11', close: 115 }]);
    // Never-priced:  the missing window starts at the oldest uncovered trade.
    seedTrade('w2', 'COLD', '2021-03-01');
    h.responses.set('COLD', [{ date: '2026-07-11', close: 42 }]);

    const res = await runPriceRefresh(env, { max: 20, concurrency: 4, maxPerMinute: 100_000 });

    expect(res.tickersPriced).toBe(2);
    expect(h.eodCalls.find((c) => c.symbol === 'WARM')?.from).toBe('2026-06-24');
    expect(h.eodCalls.find((c) => c.symbol === 'COLD')?.from).toBe('2021-02-22');
  });

  it('a fatal provider error that races the abort still records its error entry — not swallowed as a cancellation', async () => {
    // The provider's 429 settled at the same moment the lane deadline
    // fired:  the fetch rejects with the provider error while the signal
    // is aborted.  Classifying on signal.aborted alone (the pre-fix test)
    // called that a cancellation — no error entry, no fatal handling — so
    // a rate-limit outage read as a quiet abort.  Identity against the
    // signal's reason is the classifier:  this rejection is not the
    // reason, so it lands as a run-fatal error outcome.
    seedTrade('r1', 'RACE', '2026-03-02');
    h.delaysMs.set('RACE', 60_000); // in flight until the abort ends it
    h.rejectWithOnAbort.set('RACE', 'PEER_HTTP_429');
    h.responses.set('RACE', freshCloses());
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('lane deadline')), 100);

    const res = await runPriceRefresh(env, {
      max: 20,
      concurrency: 1,
      maxPerMinute: 100_000,
      signal: controller.signal,
    });

    // Fatal handling still stops the run and restores the resume point…
    expect(res.aborted).toBe(true);
    expect(res.lastCursorSeq).toBeNull();
    expect(res.tickersPriced).toBe(0);
    expect(eodCount('RACE')).toBe(0);
    // …but the failure is on the record, not hidden behind the abort.
    expect(res.errors).toEqual(['RACE: PEER_HTTP_429']);
  });

  it('an SPX provider failure on an already-aborted signal still records the error', async () => {
    // Same race at the SPX step:  the signal fired first, then the SPX
    // fetch rejected with a fatal provider error.  The error entry and the
    // fatal classification must survive; only the caller's own abort
    // reason may take the silent-cancellation path.
    h.errors.set('SPY', 'PEER_HTTP_429');
    const controller = new AbortController();
    controller.abort(new Error('lane deadline'));

    const res = await runPriceRefresh(env, { max: 20, signal: controller.signal });

    expect(res.aborted).toBe(true);
    expect(res.errors).toEqual(['spx: PEER_HTTP_429']);
    expect(res.tickersPriced).toBe(0);
  });

  it('an SPX fetch cancelled by the lane signal records no error entry', async () => {
    // The mirror image:  the SPX fetch hangs, the lane signal fires, and
    // the fetch rejects with the signal's reason itself.  That IS the
    // caller's cancellation — the run aborts with errors empty.
    h.delaysMs.set('SPY', 60_000);
    h.responses.set('SPY', freshCloses());
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('lane deadline')), 100);

    const started = Date.now();
    const res = await runPriceRefresh(env, { max: 20, signal: controller.signal });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(10_000); // settled on the abort, not the 60s hang
    expect(res.aborted).toBe(true);
    expect(res.errors).toEqual([]);
    expect(res.spxUpdated).toBe(false);
  });
});
