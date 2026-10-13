import type { Env } from '../shared/types.ts';
import { all, run, type SqlParam } from '../shared/db.ts';
import { consumeGovernedD1Writes } from '../shared/d1Budget.ts';
import { abortIfSignal } from '../shared/signalAbort.ts';

export type SqlStatement = [string, SqlParam[]];

interface OutboxRow {
  tx_id: string;
  status: string;
  attempts: number;
  dead_letter_cycles: number;
  available_at: string;
}

export interface OutboxFlushResult {
  claimed: number;
  enqueued: number;
  failed: number;
}

export interface DeadLetterReconnectResult {
  status: 'pending' | 'completed' | 'failed' | 'missing';
  deadLetterCycles: number;
}

export type OutboxCompletionResult = 'completed' | 'missing';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
/**
 * D1 accepts at most 100 bound parameters per statement. The targeted select
 * already binds two timestamps, so keep a conservative page below that cap.
 * Callers may supply larger sets; the durable minute reconciler drains the
 * remainder without an IN clause.
 */
export const DELIVERY_TARGETED_ID_LIMIT = 40;
const LEASE_SECONDS = 60;
const MAX_DEAD_LETTER_CYCLES = 5;
/** Finite fallback when a Queue message and every DLQ recovery attempt vanish. */
export const DELIVERY_ENQUEUED_STALE_MS = 2 * 60 * 60 * 1000;

/**
 * Insert an outbox row for the canonical transaction selected by its durable
 * row key. Used in the same D1 batch as INSERT OR IGNORE transactions so a
 * retry also repairs a previously-missing outbox row without inventing an id.
 */
export function deliveryOutboxInsertForRowKey(
  docId: string,
  source: string,
  rowKey: string,
  nowIso: string,
): SqlStatement {
  return [
    `INSERT OR IGNORE INTO delivery_outbox
       (tx_id, status, attempts, available_at, last_error, created_at, updated_at)
     SELECT id, 'pending', 0, ?, NULL, ?, ?
       FROM transactions
      WHERE doc_id = ? AND source = ? AND row_key = ?`,
    [nowIso, nowIso, nowIso, docId, source, rowKey],
  ];
}

/** Outbox insert for rows whose identity is their primary transaction id. */
export function deliveryOutboxInsertForTxId(txId: string, nowIso: string): SqlStatement {
  return [
    `INSERT OR IGNORE INTO delivery_outbox
       (tx_id, status, attempts, available_at, last_error, created_at, updated_at)
     SELECT id, 'pending', 0, ?, NULL, ?, ? FROM transactions WHERE id = ?`,
    [nowIso, nowIso, nowIso, txId],
  ];
}

function retryDelaySeconds(attempt: number): number {
  return Math.min(300, 5 * 2 ** Math.max(0, attempt - 1));
}

/**
 * Claim ready outbox rows with a recoverable lease, enqueue them, then mark
 * them enqueued. A crash after send but before the final update can duplicate a
 * queue message after the lease; downstream delivery idempotency absorbs it.
 */
export async function flushDeliveryOutbox(
  env: Env,
  opts: { txIds?: string[]; limit?: number; now?: Date; signal?: AbortSignal } = {},
): Promise<OutboxFlushResult> {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const staleEnqueuedBefore = new Date(now.getTime() - DELIVERY_ENQUEUED_STALE_MS).toISOString();
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  const txIds = Array.from(new Set((opts.txIds ?? []).filter(Boolean))).slice(0, DELIVERY_TARGETED_ID_LIMIT);
  const idClause = txIds.length ? ` AND tx_id IN (${txIds.map(() => '?').join(',')})` : '';
  const rows = await all<OutboxRow>(
    env.DB,
    `SELECT tx_id, status, attempts, dead_letter_cycles, available_at
       FROM delivery_outbox
      WHERE (status IN ('pending', 'sending') AND available_at <= ?${idClause})
         OR (status = 'enqueued' AND updated_at <= ?${idClause})
      ORDER BY available_at ASC
      LIMIT ${limit}`,
    [nowIso, ...txIds, staleEnqueuedBefore, ...txIds],
  );

  const result: OutboxFlushResult = { claimed: 0, enqueued: 0, failed: 0 };
  for (const row of rows) {
    abortIfSignal(opts.signal);
    // GOVERNOR 2: the outbox fan-out performs 2-3 writes per claimed row. Past
    // the per-invocation governed-write cap, stop this cycle early — the
    // remaining rows stay 'pending' and the next scheduled flush drains them,
    // so a storm degrades to bounded batches instead of an unbounded loop.
    if (consumeGovernedD1Writes(env, 'delivery-outbox-flush', 1) < 1) {
      console.warn('flushDeliveryOutbox stopped early: D1 write governor cap reached');
      break;
    }
    const leaseUntil = new Date(now.getTime() + LEASE_SECONDS * 1000).toISOString();
    const claim = await run(
      env.DB,
      `UPDATE delivery_outbox
          SET status = 'sending', attempts = attempts + 1,
              available_at = ?, last_error = NULL, updated_at = ?
        WHERE tx_id = ? AND (
          (status IN ('pending', 'sending') AND available_at <= ?)
          OR (status = 'enqueued' AND updated_at <= ?)
        )`,
      [leaseUntil, nowIso, row.tx_id, nowIso, staleEnqueuedBefore],
    );
    if ((claim.meta?.changes ?? 0) === 0) continue;
    result.claimed += 1;

    try {
      await env.DELIVERY_QUEUE.send({ type: 'delivery.dispatch', txId: row.tx_id });
      await run(
        env.DB,
        `UPDATE delivery_outbox
            SET status = 'enqueued', available_at = ?, last_error = NULL, updated_at = ?
          WHERE tx_id = ? AND status = 'sending'`,
        [nowIso, nowIso, row.tx_id],
      );
      result.enqueued += 1;
    } catch (err) {
      const attempt = row.attempts + 1;
      const availableAt = new Date(now.getTime() + retryDelaySeconds(attempt) * 1000).toISOString();
      const message = err instanceof Error ? err.message : String(err);
      await run(
        env.DB,
        `UPDATE delivery_outbox
            SET status = 'pending', available_at = ?, last_error = ?, updated_at = ?
          WHERE tx_id = ? AND status = 'sending'`,
        [availableAt, message.slice(0, 1000), nowIso, row.tx_id],
      );
      result.failed += 1;
    }
  }

  // Broadcast the fresh transactions to all SSE listeners in edge locations to bypass DB reads
  if (result.claimed > 0 && txIds.length > 0) {
    try {
      const freshRows = await all(
        env.DB,
        `SELECT t.*, f.chamber AS __chamber, sr.sector AS __sector, sr.market_cap_bucket AS __bucket,
                COALESCE(fl.display_name, fl.full_name) AS filer_full_name, fl.state AS filer_state, fl.photo_url AS filer_photo_url
           FROM transactions t
           LEFT JOIN filings f ON f.doc_id = t.doc_id
           LEFT JOIN securities_ref sr ON sr.ticker = t.ticker
           LEFT JOIN filers fl ON fl.bioguide_id = t.filer_id
          WHERE t.id IN (${txIds.map(() => '?').join(',')})`,
        txIds
      );
      if (freshRows.length > 0 && typeof BroadcastChannel !== 'undefined') {
        const channel = new (BroadcastChannel as any)('congress.trade.live');
        channel.postMessage({
          type: 'NEW_TRANSACTIONS',
          transactions: freshRows,
        });
        channel.close();
      }
    } catch (err) {
      console.error('BroadcastChannel failed to send fresh transactions:', (err as Error).message);
    }
  }

  return result;
}

/** Mark a fully processed fanout chain before its Queue message is ACKed. */
export async function completeDeliveryOutbox(
  env: Env,
  txId: string,
  now = new Date(),
): Promise<OutboxCompletionResult> {
  const nowIso = now.toISOString();
  const completed = await run(
    env.DB,
    `UPDATE delivery_outbox
        SET status = 'completed', available_at = ?, last_error = NULL, updated_at = ?
      WHERE tx_id = ? AND status != 'completed'`,
    [nowIso, nowIso, txId],
  );
  if (completed.meta.changes > 0) return 'completed';
  return (await getOutboxRow(env, txId)) ? 'completed' : 'missing';
}

/**
 * Reconnect an unexpectedly dead-lettered delivery message to its originating
 * outbox row. Queue publication attempts and consumer dead-letter cycles are
 * deliberately independent so a Queue outage cannot consume poison retries.
 */
export async function reconnectDeadLetteredOutbox(
  env: Env,
  txId: string,
  error: string,
  now: Date = new Date(),
): Promise<DeadLetterReconnectResult> {
  const row = await getOutboxRow(env, txId);
  if (!row) return { status: 'missing', deadLetterCycles: 0 };
  const nowIso = now.toISOString();
  if (row.status === 'completed') {
    return { status: 'completed', deadLetterCycles: row.dead_letter_cycles };
  }
  if (row.status === 'pending' || row.status === 'sending') {
    return { status: 'pending', deadLetterCycles: row.dead_letter_cycles };
  }
  if (row.dead_letter_cycles >= MAX_DEAD_LETTER_CYCLES) {
    await run(
      env.DB,
      `UPDATE delivery_outbox
          SET status = 'failed', last_error = ?, updated_at = ?
        WHERE tx_id = ?`,
      [error.slice(0, 1000), nowIso, txId],
    );
    return { status: 'failed', deadLetterCycles: row.dead_letter_cycles };
  }
  const nextCycle = row.dead_letter_cycles + 1;
  const delaySeconds = Math.min(3600, 30 * 2 ** Math.max(0, row.dead_letter_cycles));
  const availableAt = new Date(now.getTime() + delaySeconds * 1000).toISOString();
  await run(
    env.DB,
    `UPDATE delivery_outbox
        SET status = 'pending', dead_letter_cycles = dead_letter_cycles + 1,
            available_at = ?, last_error = ?, updated_at = ?
      WHERE tx_id = ?`,
    [availableAt, error.slice(0, 1000), nowIso, txId],
  );
  return { status: 'pending', deadLetterCycles: nextCycle };
}

async function getOutboxRow(env: Env, txId: string): Promise<OutboxRow | null> {
  const rows = await all<OutboxRow>(
    env.DB,
    `SELECT tx_id, status, attempts, dead_letter_cycles, available_at
       FROM delivery_outbox WHERE tx_id = ?`,
    [txId],
  );
  return rows[0] ?? null;
}
