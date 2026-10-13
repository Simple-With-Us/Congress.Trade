import type { Env, Chamber } from '../shared/types.ts';
import { all, run, type SqlParam } from '../shared/db.ts';
import { maybeAlertTerminalIngestionOutbox } from './pipelineLoudAlerts.ts';
import { abortIfSignal } from '../shared/signalAbort.ts';

export type IngestionOutboxStatement = [string, SqlParam[]];

interface IngestionOutboxRow {
  doc_id: string;
  chamber: Chamber;
  source_url: string;
  status: string;
  attempts: number;
  dead_letter_cycles: number;
  available_at: string;
}

export interface IngestionOutboxFlushResult {
  claimed: number;
  enqueued: number;
  failed: number;
}

export interface IngestionDeadLetterReconnectResult {
  status: 'pending' | 'completed' | 'failed' | 'missing';
  deadLetterCycles: number;
}

export type IngestionOutboxCompletionResult = 'completed' | 'missing';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const LEASE_SECONDS = 60;
const MAX_DEAD_LETTER_CYCLES = 5;
export const INGESTION_ENQUEUED_STALE_MS = 2 * 60 * 60 * 1000;

/** Pair with the filing insert in one D1 batch to close the discovery crash gap. */
export function ingestionOutboxInsertForDoc(docId: string, nowIso: string): IngestionOutboxStatement {
  return [
    `INSERT OR IGNORE INTO ingestion_outbox
       (doc_id, chamber, source_url, status, attempts, available_at, last_error, created_at, updated_at)
     SELECT doc_id, chamber, source_url, 'pending', 0, ?, NULL, ?, ?
       FROM filings
      WHERE doc_id = ? AND ingest_status = 'new'`,
    [nowIso, nowIso, nowIso, docId],
  ];
}

function retryDelaySeconds(attempt: number): number {
  return Math.min(300, 5 * 2 ** Math.max(0, attempt - 1));
}

/**
 * Attempt the just-created handoff immediately. Failure is durably retained
 * and intentionally does not turn a successful source poll into a failure.
 */
export async function enqueueIngestionOutboxNow(env: Env, docId: string): Promise<boolean> {
  const rows = await all<IngestionOutboxRow>(
    env.DB,
    `SELECT doc_id, chamber, source_url, status, attempts, dead_letter_cycles, available_at
       FROM ingestion_outbox WHERE doc_id = ? AND status = 'pending'`,
    [docId],
  );
  const row = rows[0];
  if (!row) return false;
  const now = new Date();
  const nowIso = now.toISOString();
  try {
    await env.INGEST_QUEUE.send({
      type: 'filing.new', docId: row.doc_id, chamber: row.chamber, sourceUrl: row.source_url,
    });
    await run(
      env.DB,
      `UPDATE ingestion_outbox
          SET status = 'enqueued', attempts = attempts + 1, available_at = ?,
              last_error = NULL, updated_at = ?
        WHERE doc_id = ? AND status = 'pending'`,
      [nowIso, nowIso, row.doc_id],
    );
    return true;
  } catch (err) {
    const availableAt = new Date(now.getTime() + retryDelaySeconds(row.attempts + 1) * 1000).toISOString();
    await run(
      env.DB,
      `UPDATE ingestion_outbox
          SET attempts = attempts + 1, available_at = ?, last_error = ?, updated_at = ?
        WHERE doc_id = ? AND status = 'pending'`,
      [availableAt, String((err as Error).message ?? err).slice(0, 1000), nowIso, row.doc_id],
    );
    return false;
  }
}

/** Lease and flush ready discovery handoffs without scanning filing history. */
export async function flushIngestionOutbox(
  env: Env,
  opts: { docIds?: string[]; limit?: number; now?: Date; signal?: AbortSignal } = {},
): Promise<IngestionOutboxFlushResult> {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const staleEnqueuedBefore = new Date(now.getTime() - INGESTION_ENQUEUED_STALE_MS).toISOString();
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  const docIds = Array.from(new Set((opts.docIds ?? []).filter(Boolean))).slice(0, MAX_LIMIT);
  const idClause = docIds.length ? ` AND doc_id IN (${docIds.map(() => '?').join(',')})` : '';
  const rows = await all<IngestionOutboxRow>(
    env.DB,
    `SELECT doc_id, chamber, source_url, status, attempts, dead_letter_cycles, available_at
       FROM ingestion_outbox
      WHERE (status IN ('pending', 'sending') AND available_at <= ?${idClause})
         OR (status = 'enqueued' AND updated_at <= ?${idClause})
      ORDER BY available_at ASC
      LIMIT ${limit}`,
    [nowIso, ...docIds, staleEnqueuedBefore, ...docIds],
  );
  const result: IngestionOutboxFlushResult = { claimed: 0, enqueued: 0, failed: 0 };
  for (const row of rows) {
    abortIfSignal(opts.signal);
    const leaseUntil = new Date(now.getTime() + LEASE_SECONDS * 1000).toISOString();
    const claim = await run(
      env.DB,
      `UPDATE ingestion_outbox
          SET status = 'sending', attempts = attempts + 1, available_at = ?,
              last_error = NULL, updated_at = ?
        WHERE doc_id = ? AND (
          (status IN ('pending', 'sending') AND available_at <= ?)
          OR (status = 'enqueued' AND updated_at <= ?)
        )`,
      [leaseUntil, nowIso, row.doc_id, nowIso, staleEnqueuedBefore],
    );
    if ((claim.meta?.changes ?? 0) === 0) continue;
    result.claimed += 1;
    try {
      await env.INGEST_QUEUE.send({
        type: 'filing.new', docId: row.doc_id, chamber: row.chamber, sourceUrl: row.source_url,
      });
      await run(
        env.DB,
        `UPDATE ingestion_outbox
            SET status = 'enqueued', available_at = ?, last_error = NULL, updated_at = ?
          WHERE doc_id = ? AND status = 'sending'`,
        [nowIso, nowIso, row.doc_id],
      );
      result.enqueued += 1;
    } catch (err) {
      const availableAt = new Date(
        now.getTime() + retryDelaySeconds(row.attempts + 1) * 1000,
      ).toISOString();
      await run(
        env.DB,
        `UPDATE ingestion_outbox
            SET status = 'pending', available_at = ?, last_error = ?, updated_at = ?
          WHERE doc_id = ? AND status = 'sending'`,
        [availableAt, String((err as Error).message ?? err).slice(0, 1000), nowIso, row.doc_id],
      );
      result.failed += 1;
    }
  }
  return result;
}

/**
 * Reopen dead-lettered discovery handoffs after a deploy fixes a systemic
 * fetch failure (e.g. the R2 known-length regression that killed every fetch).
 * Resets `failed` rows — optionally narrowed by a doc-id prefix — back to
 * `pending` with a fresh dead-letter budget; the scheduled outbox flush then
 * re-enqueues them. `last_error` is left in place as the audit trail until a
 * successful enqueue clears it.
 */
export async function requeueFailedIngestionOutbox(
  env: Env,
  opts: { docIdPrefix?: string; now?: Date } = {},
): Promise<number> {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const prefix = opts.docIdPrefix?.replace(/[%_]/g, '') ?? '';
  const prefixClause = prefix ? ' AND doc_id LIKE ?' : '';
  const params: SqlParam[] = [nowIso, nowIso];
  if (prefix) params.push(`${prefix}%`);
  const result = await run(
    env.DB,
    `UPDATE ingestion_outbox
        SET status = 'pending', attempts = 0, dead_letter_cycles = 0,
            available_at = ?, updated_at = ?
      WHERE status = 'failed'${prefixClause}`,
    params,
  );
  return result.meta?.changes ?? 0;
}

/** Complete the canonical filing.new handoff before ACKing that message. */
export async function completeIngestionOutbox(
  env: Env,
  docId: string,
  now = new Date(),
): Promise<IngestionOutboxCompletionResult> {
  const nowIso = now.toISOString();
  const completed = await run(
    env.DB,
    `UPDATE ingestion_outbox
        SET status = 'completed', available_at = ?, last_error = NULL, updated_at = ?
      WHERE doc_id = ? AND status != 'completed'`,
    [nowIso, nowIso, docId],
  );
  if (completed.meta.changes > 0) return 'completed';
  const rows = await all<{ doc_id: string }>(
    env.DB,
    'SELECT doc_id FROM ingestion_outbox WHERE doc_id = ?',
    [docId],
  );
  return rows.length > 0 ? 'completed' : 'missing';
}

/** Restart the canonical filing.new pipeline after any ingest-stage DLQ. */
export async function reconnectDeadLetteredIngestionOutbox(
  env: Env,
  docId: string,
  error: string,
  now = new Date(),
  opts: { reopenCompleted?: boolean } = {},
): Promise<IngestionDeadLetterReconnectResult> {
  const rows = await all<IngestionOutboxRow>(
    env.DB,
    `SELECT doc_id, chamber, source_url, status, attempts, dead_letter_cycles, available_at
       FROM ingestion_outbox WHERE doc_id = ?`,
    [docId],
  );
  const row = rows[0];
  if (!row) return { status: 'missing', deadLetterCycles: 0 };
  const nowIso = now.toISOString();
  if (row.status === 'completed' && opts.reopenCompleted === false) {
    return { status: 'completed', deadLetterCycles: row.dead_letter_cycles };
  }
  if (row.status === 'pending' || row.status === 'sending') {
    return { status: 'pending', deadLetterCycles: row.dead_letter_cycles };
  }
  if (row.dead_letter_cycles >= MAX_DEAD_LETTER_CYCLES) {
    const lastError = error.slice(0, 1000);
    await run(
      env.DB,
      `UPDATE ingestion_outbox SET status = 'failed', last_error = ?, updated_at = ?
        WHERE doc_id = ?`,
      [lastError, nowIso, docId],
    );
    await maybeAlertTerminalIngestionOutbox(env, docId, lastError, now);
    return { status: 'failed', deadLetterCycles: row.dead_letter_cycles };
  }
  const nextCycle = row.dead_letter_cycles + 1;
  const availableAt = new Date(
    now.getTime() + Math.min(3600, 30 * 2 ** Math.max(0, row.dead_letter_cycles)) * 1000,
  ).toISOString();
  await run(
    env.DB,
    `UPDATE ingestion_outbox
        SET status = 'pending', dead_letter_cycles = dead_letter_cycles + 1,
            available_at = ?, last_error = ?, updated_at = ?
      WHERE doc_id = ?`,
    [availableAt, error.slice(0, 1000), nowIso, docId],
  );
  return { status: 'pending', deadLetterCycles: nextCycle };
}
