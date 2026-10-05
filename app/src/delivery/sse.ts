/**
 * src/delivery/sse.ts
 * OWNER: delivery agent
 *
 * Server-Sent Events streaming for 'sse' subscriptions. Holds an open Response
 * stream and pushes new transactions (filtered per subscription) as they are
 * persisted, resuming from a client-supplied cursor (?since= or the standard
 * EventSource Last-Event-ID header; see resolveResumeCursor in rest.ts).
 *
 * STREAM TOKEN TRANSPORT: the per-subscription stream token is accepted via
 * `Authorization: Bearer <secret>` or `X-Subscription-Secret` (preferred —
 * keeps the secret out of browser history, proxy logs, and Referer headers),
 * falling back to the `?token=` query parameter. The query form exists only
 * because native browser EventSource cannot set request headers; any client
 * that CAN set headers (native apps, server-side consumers) should use the
 * header and never put the token in the URL. Query-token auth remains
 * supported for backward compatibility with existing streamUrls.
 *
 * BACKLOG / GAP-FREE RESUME:
 *   A fresh open with no `?since=` and no `Last-Event-ID` starts at the current
 *   durable high-water mark (live tail only — no history replay). Explicit
 *   `?since=<cursor_seq>` or the EventSource `Last-Event-ID` header replays
 *   `cursor_seq > since` from the `transactions` table (gap-free catch-up,
 *   paged at MAX_DRAIN_PAGES_PER_TICK per tick). Each trade carries
 *   `id:<cursorSeq>` so reconnects resume automatically.
 *
 * APPROACH (Workers-friendly poll loop):
 *   We back the Response with a TransformStream and await writer.ready plus
 *   writer.write for every frame. This propagates downstream backpressure and
 *   keeps at most one encoded frame in flight instead of growing an unbounded
 *   ReadableStream controller queue. On open we replay the catch-up backlog
 *   (cursor_seq > since), then enter an async poll loop that queries D1 every
 *   POLL_INTERVAL_MS for rows beyond the last accepted cursor. Heartbeats
 *   (`event: ping`) are emitted on each idle tick so proxies/clients keep the
 *   connection alive and can detect a dead stream.
 *
 *   We use a plain `await new Promise(setTimeout)` between polls — there is no
 *   Workers `scheduler` primitive needed; the runtime keeps the streaming
 *   response alive while the loop awaits. The loop exits cleanly when a
 *   downstream write rejects after client disconnect or when the self-imposed
 *   MAX_STREAM_MS budget is hit.
 *
 * MAX-DURATION CAVEAT:
 *   Cloudflare Workers cap wall-clock / streaming duration (and a long-lived SSE
 *   connection consumes a request's lifetime). We therefore bound each stream to
 *   MAX_STREAM_MS (~25 min) and emit a terminal `event: reconnect` with the last
 *   cursor so the client reconnects with `?since=<lastCursor>` and resumes
 *   exactly where it left off (no gaps, the catch-up replay covers the seam).
 *   This is a deliberate at-least-once, resumable design rather than a truly
 *   infinite socket. For sub-second push semantics, prefer a webhook subscription.
 *
 * FOLLOW-UP: if SSE demand outgrows the durable connection caps, replace the
 * per-connection D1 poll loop with one shared Durable Object fanout per feed.
 */

import type { Env, Subscription, Transaction } from '../shared/types.ts';
import { all, get, run } from '../shared/db.ts';
import { mapSubscription, mapFeedTransaction, readCursorHighWater, type SubscriptionRow, type FeedTransactionRow } from './rows.ts';
import { matchesFiltersWithContext, subscriptionOwnerEntitled } from './subscriptions.ts';
import { constantTimeEqual } from '../auth/tokens.ts';
import { createCongressEvent } from '@jaywedgeworth22/congress-trading-shared';
import { prefixedId } from '../shared/ids.ts';
import { rateLimit } from '../shared/rateLimit.ts';
import { flushD1Budget } from '../shared/d1Budget.ts';

/** How often to poll D1 for new rows. */
const POLL_INTERVAL_MS = 5_000;
/** Max lifetime of a single SSE connection before asking the client to reconnect. */
export const MAX_STREAM_MS = 25 * 60 * 1_000;
/** Keep the durable lease alive slightly beyond the response lifetime. */
export const SSE_LEASE_MS = MAX_STREAM_MS + 60_000;
export const SSE_SUBSCRIPTION_OPEN_RATE = 10;
export const SSE_IP_OPEN_RATE = 30;
/** A client that cannot accept one frame within this budget is disconnected. */
export const SSE_SLOW_READER_TIMEOUT_MS = 15_000;
/** Leave time near the hard deadline for a resumable reconnect frame. */
export const SSE_RECONNECT_GRACE_MS = 1_000;
/**
 * How often the live tail re-reads the durable backlog even when no gap is
 * detected. BroadcastChannel is isolate-local (it does NOT span Deno Deploy
 * regions), so a stream attached to an isolate that never ingests would
 * otherwise starve silently until reconnect. This periodic drain is a cheap
 * indexed `cursor_seq > ?` read and doubles as a reconciliation pass for any
 * broadcast payloads dropped under backpressure.
 */
export const SSE_BACKLOG_DRAIN_INTERVAL_MS = 45_000;
/** Page size when draining the catch-up / live backlog. */
const PAGE_SIZE = 200;
/** Bound D1 work per poll tick; later ticks continue from the returned HWM. */
export const MAX_DRAIN_PAGES_PER_TICK = 5;

/**
 * Format one live trade as an SSE frame on the shared cross-app contract.
 *
 * The SSE `event:` line is `congress.trade` and the `data:` payload is the
 * shared `CongressEvent` envelope from `createCongressEvent` (type + id +
 * data.trades + emittedAt). Socratic Trade's stream consumer accepts this
 * shape (and still tolerates flattened/legacy variants). The `id:` line
 * carries `cursorSeq` for Last-Event-ID resume.
 */
export function formatTradeEvent(tx: Transaction): string {
  const event = createCongressEvent('congress.trade', { trades: [tx] }, { id: String(tx.cursorSeq) });
  return `id: ${tx.cursorSeq}\nevent: congress.trade\ndata: ${JSON.stringify(event)}\n\n`;
}

export class SseSlowReaderError extends Error {
  constructor(message = 'SSE client stopped accepting data') {
    super(message);
    this.name = 'SseSlowReaderError';
  }
}

export class SseStreamDeadlineError extends Error {
  constructor(message = 'SSE stream deadline reached') {
    super(message);
    this.name = 'SseStreamDeadlineError';
  }
}

class SseStreamClosedError extends Error {
  constructor(message = 'SSE stream is closed') {
    super(message);
    this.name = 'SseStreamClosedError';
  }
}

export interface SseBackpressureStream {
  readable: ReadableStream<Uint8Array>;
  write(chunk: string, deadlineAt: number): Promise<void>;
  close(deadlineAt: number): Promise<void>;
  abort(reason: unknown): void;
}

/**
 * Create a byte stream whose producer cannot outrun its consumer.
 *
 * Cloudflare's TransformStream is an identity stream. Awaiting both `ready`
 * and `write` means a frame is only considered accepted after downstream
 * capacity is available. The explicit single-write guard prevents accidental
 * callers from building a second application-level queue around the writer.
 */
export function createSseBackpressureStream(
  slowReaderTimeoutMs = SSE_SLOW_READER_TIMEOUT_MS,
): SseBackpressureStream {
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  const encoder = new TextEncoder();
  let state: 'open' | 'closing' | 'closed' | 'aborted' = 'open';
  let writeInFlight = false;

  const abort = (reason: unknown): void => {
    if (state === 'closed' || state === 'aborted') return;
    state = 'aborted';
    // Do not await abort: on the Streams standard it can remain pending until
    // the readable side observes the error. Initiating it immediately rejects
    // the pending write and discards buffered chunks without extending the
    // request deadline.
    void writer.abort(reason).catch(() => {});
  };

  return {
    readable: stream.readable,
    async write(chunk: string, deadlineAt: number): Promise<void> {
      if (state !== 'open') throw new SseStreamClosedError();
      if (writeInFlight) throw new SseStreamClosedError('concurrent SSE write rejected');
      writeInFlight = true;
      try {
        const deadlineRemainingMs = Math.max(10, deadlineAt - Date.now());
        const budgetMs = Math.min(slowReaderTimeoutMs, deadlineRemainingMs);
        const timeoutError = deadlineRemainingMs <= slowReaderTimeoutMs
          ? new SseStreamDeadlineError()
          : new SseSlowReaderError();
        const encoded = encoder.encode(chunk);
        await settleWithin(
          (async () => {
            await writer.ready;
            await writer.write(encoded);
          })(),
          budgetMs,
          timeoutError,
        );
      } catch (err) {
        abort(err);
        throw err;
      } finally {
        writeInFlight = false;
      }
    },
    async close(deadlineAt: number): Promise<void> {
      if (state === 'closed' || state === 'aborted') return;
      if (writeInFlight) throw new SseStreamClosedError('cannot close during an SSE write');
      state = 'closing';
      try {
        const remainingMs = Math.max(10, deadlineAt - Date.now());
        await settleWithin(writer.close(), remainingMs, new SseStreamDeadlineError());
        state = 'closed';
      } catch (err) {
        abort(err);
        throw err;
      }
    },
    abort,
  };
}

export interface SseStreamTimingOptions {
  maxStreamMs?: number;
  pollIntervalMs?: number;
  slowReaderTimeoutMs?: number;
  reconnectGraceMs?: number;
  /** Cross-region safety-net drain cadence (see SSE_BACKLOG_DRAIN_INTERVAL_MS). */
  backlogDrainIntervalMs?: number;
}

export async function openSseStream(
  env: Env,
  subscriptionId: string,
  since?: number,
  streamToken?: string,
  requestIp = 'unknown',
  timingOptions: SseStreamTimingOptions = {},
): Promise<Response> {
  const subRow = await get<SubscriptionRow>(
    env.DB,
    'SELECT id, client_id, delivery, target_url, secret, filters, cursor, active, created_at FROM subscriptions WHERE id = ?',
    [subscriptionId],
  );
  if (!subRow) {
    return new Response(JSON.stringify({ error: 'subscription not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const sub = mapSubscription(subRow);
  if (!sub.active) {
    return new Response(JSON.stringify({ error: 'subscription inactive' }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (sub.delivery !== 'sse') {
    return new Response(JSON.stringify({ error: 'subscription is not an SSE subscription' }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (!sub.secret || !streamToken || !(await constantTimeEqual(streamToken, sub.secret))) {
    return new Response(JSON.stringify({ error: 'subscription stream token required' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Entitlement re-check at connection time (panel HIGH: a lapsed owner's
  // stream token must stop opening premium streams). Placed after the token
  // check so unauthenticated probes cannot enumerate owner billing state.
  if (!(await subscriptionOwnerEntitled(env, sub.clientId))) {
    return new Response(
      JSON.stringify({ error: 'subscription owner requires an active Premium account', upgradeRequired: true }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Authentication deliberately precedes rate counters and lease writes so an
  // attacker cannot consume another subscription's capacity with a guessed id.
  const subscriptionRate = await rateLimit(
    env, 'sse-open-subscription', sub.id, SSE_SUBSCRIPTION_OPEN_RATE, 60,
  );
  const ipRate = await rateLimit(env, 'sse-open-ip', requestIp, SSE_IP_OPEN_RATE, 60);
  if (!subscriptionRate.ok || !ipRate.ok) {
    const retryAfter = Math.max(subscriptionRate.retryAfterSec, ipRate.retryAfterSec, 1);
    return new Response(JSON.stringify({ error: 'stream open rate limit exceeded' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) },
    });
  }

  let leaseId: string;
  try {
    leaseId = await acquireSseLease(env, sub.id, sub.clientId);
  } catch (err) {
    if (err instanceof SseLeaseQuotaError) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
      });
    }
    throw err;
  }

  const maxStreamMs = positiveDuration(timingOptions.maxStreamMs, MAX_STREAM_MS);
  const pollIntervalMs = positiveDuration(timingOptions.pollIntervalMs, POLL_INTERVAL_MS);
  const slowReaderTimeoutMs = positiveDuration(
    timingOptions.slowReaderTimeoutMs,
    SSE_SLOW_READER_TIMEOUT_MS,
  );
  const reconnectGraceMs = Math.min(
    positiveDuration(timingOptions.reconnectGraceMs, SSE_RECONNECT_GRACE_MS),
    maxStreamMs,
  );
  const backlogDrainIntervalMs = positiveDuration(
    timingOptions.backlogDrainIntervalMs,
    SSE_BACKLOG_DRAIN_INTERVAL_MS,
  );
  const startedAt = Date.now();
  const deadlineAt = startedAt + maxStreamMs;
  /** When true, the client did not supply ?since= or Last-Event-ID — live tail only. */
  const liveTailDefault = since === undefined;
  let closed = false;
  const stream = createSseBackpressureStream(slowReaderTimeoutMs);
  const send = async (chunk: string): Promise<void> => {
    if (closed) throw new SseStreamClosedError();
    await stream.write(chunk, deadlineAt);
  };

  const produce = async (): Promise<void> => {
    const hwm = await readCursorHighWater(env);
    let cursor: number;
    if (liveTailDefault) {
      cursor = hwm;
    } else {
      cursor = Number(since);
      // Clamp an explicit resume cursor above the real high-water mark; otherwise
      // the stream never emits again for the life of the client.
      if (cursor > 1_000_000_000_000 || (hwm > 0 && cursor > hwm)) {
        cursor = Math.min(cursor, hwm);
      }
    }

    // Opening comment + initial cursor so clients know the resume point.
    await send(`: connected\n`);
    await send(`event: cursor\ndata: ${cursor}\n\n`);

    // 1) Catch-up replay when the client asked for history (?since= / header).
    // Fresh opens at the HWM skip this — they are already on the live tail.
    if (!liveTailDefault) {
      cursor = await drainSseBacklog(env, sub, cursor, send);
    }
    // The HTTP handler's waitUntil settles when this Response is created, but
    // the producer continues querying D1 in the background. Flush those rows
    // while the stream is alive instead of leaving them in the isolate until
    // an unrelated invocation happens to flush them.
    await flushD1Budget(env);

    // 2) Live tail via BroadcastChannel push mechanism.
    let channel: any = null;
    const pendingPayloads: any[] = [];
    let isProcessing = false;

    const processIncoming = async () => {
      if (closed || isProcessing || pendingPayloads.length === 0) return;
      isProcessing = true;
      try {
        while (pendingPayloads.length > 0 && !closed) {
          const payload = pendingPayloads.shift();
          if (payload.transaction) {
            const minIncomingCursor = payload.transaction.cursorSeq ?? Infinity;
            if (minIncomingCursor > cursor + 1) {
              // Gap detected: fall back to Turso DB to catch up safely
              cursor = await drainSseBacklog(env, sub, cursor, send);
              await flushD1Budget(env);
            } else {
              // No gap: push directly from memory, bypassing the database
              const tx = payload.transaction;
              if (tx.cursorSeq > cursor) {
                const ctx = payload.context || { chamber: null, sector: null, marketCapBucket: null };
                if (matchesFiltersWithContext(tx, sub.filters, ctx)) {
                  await send(formatTradeEvent(tx));
                }
                cursor = Math.max(cursor, tx.cursorSeq);
              }
            }
          }
        }
      } catch (err) {
        if (!isTerminalStreamError(err)) console.error('SSE processIncoming error:', err);
      } finally {
        isProcessing = false;
      }
    };

    if (typeof BroadcastChannel !== 'undefined') {
      channel = new (BroadcastChannel as any)('congress.trade.live');
      channel.addEventListener('message', (event: any) => {
        if (event.data?.type === 'NEW_TRANSACTION') {
          pendingPayloads.push(event.data);
          void processIncoming();
        }
      });
    }

    // Keep-alive loop + hard deadline checker
    let lastActiveCheck = Date.now();
    let lastBacklogDrain = Date.now();
    while (!closed) {
      const remainingBeforeSleep = deadlineAt - Date.now();
      if (remainingBeforeSleep <= reconnectGraceMs) break;
      await sleep(Math.min(pollIntervalMs, remainingBeforeSleep - reconnectGraceMs));
      if (closed || Date.now() >= deadlineAt - reconnectGraceMs) break;

      if (Date.now() - lastActiveCheck > 60_000) {
        const activeCheck = await get<{ active: number }>(
          env.DB,
          'SELECT active FROM subscriptions WHERE id = ?',
          [sub.id],
        );
        if (!activeCheck || !activeCheck.active) {
          break;
        }
        lastActiveCheck = Date.now();
      }

      // Cross-region safety net: BroadcastChannel never reaches isolates in
      // other Deno Deploy regions, so a stream whose isolate sees no ingests
      // would starve on push alone. Re-drain the durable backlog on a slow
      // cadence — an indexed `cursor_seq > ?` read that is a no-op when the
      // push path is healthy (drainSseBacklog never re-emits below the HWM).
      if (Date.now() - lastBacklogDrain >= backlogDrainIntervalMs) {
        cursor = await drainSseBacklog(env, sub, cursor, send);
        await flushD1Budget(env);
        lastBacklogDrain = Date.now();
      }

      // Idle tick — heartbeat so intermediaries keep the socket open.
      await send(`event: ping\ndata: ${Date.now()}\n\n`).catch(() => { closed = true; });
    }

    channel?.close();

    if (!closed && Date.now() < deadlineAt) {
      await send(`event: reconnect\ndata: ${JSON.stringify({ since: cursor })}\n\n`);
    }
  };

  // The response body keeps this producer alive in Workers. The promise is
  // explicitly handled here: a hard race bounds the entire producer, including
  // D1 calls, and the finally block always terminates the transport and lease.
  void (async () => {
    let abortReason: unknown;
    try {
      await settleWithin(produce(), deadlineAt - Date.now(), new SseStreamDeadlineError());
    } catch (err) {
      if (isTerminalStreamError(err)) {
        abortReason = err;
      } else {
        try {
          await send(`event: error\ndata: ${JSON.stringify({ message: errorMessage(err) })}\n\n`);
        } catch (writeErr) {
          abortReason = writeErr;
        }
      }
    } finally {
      closed = true;
      if (abortReason !== undefined) {
        stream.abort(abortReason);
      } else {
        try {
          await stream.close(deadlineAt);
        } catch (err) {
          stream.abort(err);
        }
      }
      await releaseSseLease(env, leaseId);
      // releaseSseLease is also a D1 operation and the producer's final
      // flush covers it even when the stream ended before another poll tick.
      await flushD1Budget(env);
    }
  })();

  return new Response(stream.readable, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

export class SseLeaseQuotaError extends Error {}

/**
 * Race-safe connection admission. D1 triggers enforce both caps against the
 * same durable insert; expired rows are ignored and opportunistically removed.
 */
export async function acquireSseLease(
  env: Env,
  subscriptionId: string,
  clientId: string,
  now = new Date(),
): Promise<string> {
  const id = prefixedId('sse');
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + SSE_LEASE_MS).toISOString();
  await run(env.DB, 'DELETE FROM sse_leases WHERE expires_at <= ?', [createdAt]).catch(() => {});
  try {
    await run(
      env.DB,
      `INSERT INTO sse_leases (id, subscription_id, client_id, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [id, subscriptionId, clientId, expiresAt, createdAt],
    );
  } catch (err) {
    const message = (err as Error).message;
    if (/sse .* connection quota exceeded/i.test(message)) {
      throw new SseLeaseQuotaError('too many concurrent streams for this subscription or client');
    }
    throw err;
  }
  return id;
}

export async function releaseSseLease(env: Env, leaseId: string): Promise<void> {
  await run(env.DB, 'DELETE FROM sse_leases WHERE id = ?', [leaseId]).catch(() => {});
}

/**
 * Emit every matching transaction with cursor_seq > `cursor`, paging through the
 * backlog. Returns the new high-water cursor (max cursor_seq seen, matched or
 * not, so we never re-scan rows that were merely filtered out).
 */
export async function drainSseBacklog(
  env: Env,
  sub: Subscription,
  cursor: number,
  send: (chunk: string) => Promise<void>,
): Promise<number> {
  let hwm = cursor;
  // Drain a bounded number of pages. If more history remains, the next poll
  // tick continues from this exact high-water cursor without gaps.
  for (let page = 0; page < MAX_DRAIN_PAGES_PER_TICK; page += 1) {
    const rows = await all<
      FeedTransactionRow & { __chamber: string | null; __sector: string | null; __bucket: string | null }
    >(
      env.DB,
      `SELECT t.*, f.chamber AS __chamber,
              sr.sector AS __sector, sr.market_cap_bucket AS __bucket,
              COALESCE(fl.display_name, fl.full_name) AS filer_full_name, fl.state AS filer_state,
              fl.photo_url AS filer_photo_url
         FROM (
           SELECT t.* FROM transactions t INDEXED BY idx_tx_cursor
            WHERE t.cursor_seq > ? AND t.deprecated_at IS NULL
            ORDER BY t.cursor_seq ASC
            LIMIT ?
         ) t
         LEFT JOIN filings f ON f.doc_id = t.doc_id
         LEFT JOIN securities_ref sr ON sr.ticker = t.ticker
         LEFT JOIN filers fl ON fl.bioguide_id = t.filer_id`,
      [hwm, PAGE_SIZE],
    );
    if (rows.length === 0) break;

    for (const row of rows) {
      const tx: Transaction = mapFeedTransaction(row);
      const ctx = {
        chamber: row.__chamber ?? null,
        sector: row.__sector ?? null,
        marketCapBucket: row.__bucket ?? null,
      };
      if (matchesFiltersWithContext(tx, sub.filters, ctx)) {
        // Never acknowledge a matching cursor until its frame has crossed the
        // backpressure boundary. If the reader stalls, reconnect resumes from
        // the caller's prior cursor and replays this transaction.
        await send(formatTradeEvent(tx));
      }
      hwm = Math.max(hwm, tx.cursorSeq);
    }

    if (rows.length < PAGE_SIZE) break;
  }
  return hwm;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number, timeoutError: Error): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw timeoutError;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(timeoutError), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback;
}

function isTerminalStreamError(err: unknown): boolean {
  return err instanceof SseSlowReaderError
    || err instanceof SseStreamDeadlineError
    || err instanceof SseStreamClosedError;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
