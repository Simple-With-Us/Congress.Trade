/**
 * Keep genuine ingest failures visible in review_queue until a reviewer or a
 * successful pipeline retry finishes them. Ingest-failure *listings* in the
 * admin API are read-only; Publisher drains unresolved review_queue rows.
 */

import type { Env } from '../shared/types.ts';
import type { DurableQueueLeaseContext } from '../deno/durableQueue.ts';
import { all, get, run, withSqliteLockRetry, type SqlParam } from '../shared/db.ts';
import { notifyReviewQueuePublisher } from './reviewQueueNotify.ts';
import {
  alreadyPublishedPredicate,
  isFilingAlreadyPublished,
  PUBLISH_DECISION_ACTIONS,
} from './reviewStatusReconcile.ts';

export const INGEST_FAILURE_REASON_PREFIX = 'ingest_failure:';
const PROVIDER_MISSING_PREFIX = 'provider-missing-%';

export type IngestFailureStage = 'fetch' | 'parse' | 'extract' | 'validation' | 'ingest';

export interface IngestFailureBackfillResult {
  dryRun: boolean;
  matched: number;
  ensured: number;
  skipped: number;
  recovered: number;
  docIds: string[];
}

function buildEligibleWhere(chamber: string | null): { clause: string; params: SqlParam[] } {
  const clauses = [
    `f.ingest_status = 'error'`,
    `f.doc_id NOT LIKE ?`,
    // Any existing review_queue row, including a resolved one, already occupies
    // the doc_id primary key. Selecting those filings again makes INSERT OR
    // IGNORE return skipped and burns the LIMIT, so older failures never run.
    // Resolved rows stay resolved: reviewQueueGuard and the stranded sweep
    // refuse to revive a closed-out filing.
    `NOT EXISTS (
       SELECT 1 FROM review_queue rq
        WHERE rq.doc_id = f.doc_id
     )`,
    `NOT EXISTS (
       SELECT 1 FROM transactions t
        WHERE t.doc_id = f.doc_id AND t.deprecated_at IS NULL
     )`,
    `NOT (${alreadyPublishedPredicate('f')})`,
  ];
  const params: SqlParam[] = [PROVIDER_MISSING_PREFIX, ...PUBLISH_DECISION_ACTIONS];
  if (chamber) {
    clauses.push('f.chamber = ?');
    params.push(chamber);
  }
  return { clause: clauses.join(' AND '), params };
}

export function inferIngestFailureStage(
  errorMessage: string,
  source?: string,
): IngestFailureStage {
  const msg = errorMessage.toLowerCase();
  const src = (source ?? '').toLowerCase();
  if (src.includes('fetch') || msg.startsWith('fetcher:')) return 'fetch';
  if (src.includes('classif') || msg.startsWith('classifier:')) return 'parse';
  if (
    src.includes('extract')
    || msg.startsWith('extraction:')
    || msg.startsWith('orchestrator:')
  ) {
    return 'extract';
  }
  if (msg.includes('validation') || msg.includes('normaliz')) return 'validation';
  return 'ingest';
}

export function ingestFailureReviewReason(stage: IngestFailureStage): string {
  return `${INGEST_FAILURE_REASON_PREFIX}${stage}`;
}

/**
 * Remove a synthetic ingest-failure row when the filing left `error` after a
 * transient retry. Uses DELETE so we never stamp a bogus resolution_kind that
 * the desync reconcile would apply back to filings.
 */
export async function clearIngestFailureReviewQueueIfRecovered(
  db: D1Database,
  docId: string,
): Promise<boolean> {
  const res = await run(
    db,
    `DELETE FROM review_queue
      WHERE doc_id = ?
        AND resolved = 0
        AND reason LIKE ?
        AND EXISTS (
          SELECT 1 FROM filings f
           WHERE f.doc_id = ?
             AND f.ingest_status IS NOT NULL
             AND f.ingest_status <> 'error'
        )`,
    [docId, `${INGEST_FAILURE_REASON_PREFIX}%`, docId],
  );
  return (res?.meta?.changes ?? 0) > 0;
}

async function shouldEnsureIngestFailureQueue(
  db: D1Database,
  docId: string,
): Promise<boolean> {
  if (docId.startsWith('provider-missing-')) return false;
  if (await isFilingAlreadyPublished(db, docId)) return false;
  const row = await get<{
    ingest_status: string | null;
    rejected: number | null;
    live_n: number | null;
  }>(
    db,
    `SELECT f.ingest_status,
            (SELECT 1 FROM review_queue rq
              WHERE rq.doc_id = f.doc_id
                AND rq.resolved = 1
                AND rq.resolution_kind = 'rejected' LIMIT 1) AS rejected,
            (SELECT COUNT(*) FROM transactions t
              WHERE t.doc_id = f.doc_id AND t.deprecated_at IS NULL) AS live_n
       FROM filings f
      WHERE f.doc_id = ?`,
    [docId],
  );
  if (!row || row.ingest_status !== 'error') return false;
  if (Number(row.rejected) === 1) return false;
  if (Number(row.live_n ?? 0) > 0) return false;
  return true;
}

/**
 * Idempotently open (or refresh) an ingest-failure review row.
 */
export async function ensureIngestFailureReviewQueueRow(
  env: Pick<Env, 'DB'>,
  docId: string,
  errorMessage: string,
  opts: { stage?: IngestFailureStage; source?: string; at?: string } = {},
): Promise<'inserted' | 'updated' | 'skipped' | 'unchanged'> {
  if (!(await shouldEnsureIngestFailureQueue(env.DB, docId))) return 'skipped';

  const stage = opts.stage ?? inferIngestFailureStage(errorMessage, opts.source);
  const reason = ingestFailureReviewReason(stage);
  const at = opts.at ?? new Date().toISOString();
  const payload = JSON.stringify({
    kind: 'ingest_failure',
    stage,
    source: opts.source ?? null,
    error: errorMessage.slice(0, 1000),
    at,
  });

  const existing = await get<{ doc_id: string; reason: string | null }>(
    env.DB,
    `SELECT doc_id, reason FROM review_queue WHERE doc_id = ? AND resolved = 0 LIMIT 1`,
    [docId],
  );
  if (existing) {
    if (!(existing.reason ?? '').startsWith(INGEST_FAILURE_REASON_PREFIX)) {
      return 'skipped';
    }
    const update = await run(
      env.DB,
      `UPDATE review_queue
          SET reason = ?,
              payload = ?
        WHERE doc_id = ? AND resolved = 0`,
      [reason, payload, docId],
    );
    return (update.meta?.changes ?? 0) > 0 ? 'updated' : 'unchanged';
  }

  const insert = await run(
    env.DB,
    `INSERT OR IGNORE INTO review_queue (doc_id, reason, payload, created_at, resolved)
     VALUES (?, ?, ?, ?, 0)`,
    [docId, reason, payload, at],
  );
  if ((insert.meta?.changes ?? 0) > 0) {
    void notifyReviewQueuePublisher(env as Env, {
      docId,
      reason,
      kind: 'insert',
      at,
    });
    return 'inserted';
  }
  return 'skipped';
}

/**
 * Stamp `ingest_status='error'` when appropriate and keep the row on the
 * review queue. Call sites that already performed the filings UPDATE may set
 * `filingAlreadyStamped: true`.
 */
export async function recordGenuineIngestFailure(
  env: Env,
  docId: string,
  errorMessage: string,
  opts: {
    source?: string;
    stage?: IngestFailureStage;
    filingAlreadyStamped?: boolean;
    /**
     * Dead-letter terminalization must not replace `persisted` or an existing
     * `error` message. NULL status stays untouched (SQL NOT IN is unknown).
     */
    preserveTerminalStatus?: boolean;
    lease?: DurableQueueLeaseContext;
  } = {},
): Promise<void> {
  await opts.lease?.assertOwned();
  if (await isFilingAlreadyPublished(env.DB, docId)) return;

  if (!opts.filingAlreadyStamped) {
    const terminalGuard = opts.preserveTerminalStatus
      ? ` AND ingest_status NOT IN ('persisted', 'error')`
      : '';
    await run(
      env.DB,
      `UPDATE filings
          SET ingest_status = 'error', error = ?
        WHERE doc_id = ?
          AND NOT (${alreadyPublishedPredicate('filings')})${terminalGuard}`,
      [errorMessage.slice(0, 1000), docId, ...PUBLISH_DECISION_ACTIONS],
    );
  }

  await ensureIngestFailureReviewQueueRow(env, docId, errorMessage, {
    stage: opts.stage,
    source: opts.source,
  });
}

export async function backfillIngestFailureReviewQueue(
  env: Pick<Env, 'DB'>,
  opts: { chamber?: string | null; limit?: number; dryRun?: boolean } = {},
): Promise<IngestFailureBackfillResult> {
  let limit = typeof opts.limit === 'number' && opts.limit > 0 ? Math.floor(opts.limit) : 500;
  if (limit > 2000) limit = 2000;
  const dryRun = opts.dryRun === true;
  const where = buildEligibleWhere(opts.chamber ?? null);
  const rows = await all<{ doc_id: string; error: string | null }>(
    env.DB,
    `SELECT f.doc_id, f.error
       FROM filings f
      WHERE ${where.clause}
      ORDER BY f.first_seen_at DESC, f.doc_id
      LIMIT ?`,
    [...where.params, limit],
  );

  const result: IngestFailureBackfillResult = {
    dryRun,
    matched: rows.length,
    ensured: 0,
    skipped: 0,
    recovered: 0,
    docIds: rows.map((r) => r.doc_id),
  };
  if (dryRun) return result;

  const at = new Date().toISOString();
  const pending = rows.map((row) => {
    const msg = row.error?.trim() || 'ingest failure (no error text)';
    const stage = inferIngestFailureStage(msg, 'backfill');
    const reason = ingestFailureReviewReason(stage);
    return {
      docId: row.doc_id,
      reason,
      payload: JSON.stringify({
        kind: 'ingest_failure',
        stage,
        source: 'backfill',
        error: msg.slice(0, 1000),
        at,
      }),
      at,
    };
  });
  const inserted = await insertIngestFailureReviewRows(env, pending);
  result.ensured = inserted.length;
  result.skipped = pending.length - inserted.length;
  return result;
}

/**
 * Rows per INSERT. Four bound parameters each, and this repo treats 100 as
 * the D1 statement cap (`D1_BOUND_PARAM_LIMIT`), so 20 rows is 80 parameters.
 */
const BACKFILL_INSERT_CHUNK = 20;

/**
 * One multi-row INSERT per chunk. Production SQLite is a single writer
 * (`withSqliteLockRetry` in db.ts); concurrent per-row ensures would queue
 * on that lock instead of reducing the sweep's round trips.
 */
async function insertIngestFailureReviewRows(
  env: Pick<Env, 'DB'>,
  rows: Array<{ docId: string; reason: string; payload: string; at: string }>,
): Promise<string[]> {
  const inserted: string[] = [];
  for (let i = 0; i < rows.length; i += BACKFILL_INSERT_CHUNK) {
    const chunk = rows.slice(i, i + BACKFILL_INSERT_CHUNK);
    const values: string[] = [];
    const params: SqlParam[] = [];
    for (const row of chunk) {
      values.push('(?, ?, ?, ?, 0)');
      params.push(row.docId, row.reason, row.payload, row.at);
    }
    const written = await withSqliteLockRetry(() => all<{ doc_id: string }>(
      env.DB,
      `INSERT OR IGNORE INTO review_queue (doc_id, reason, payload, created_at, resolved)
       VALUES ${values.join(', ')}
       RETURNING doc_id`,
      params,
    ));
    const byId = new Map(chunk.map((row) => [row.docId, row]));
    for (const row of written) {
      inserted.push(row.doc_id);
      const source = byId.get(row.doc_id);
      if (!source) continue;
      void notifyReviewQueuePublisher(env as Env, {
        docId: row.doc_id,
        reason: source.reason,
        kind: 'insert',
        at: source.at,
      });
    }
  }
  return inserted;
}

/** Hourly safety net: backfill missing rows and drop stale rows after retries. */
export async function sweepIngestFailureReviewQueue(
  env: Pick<Env, 'DB'>,
  opts: { limit?: number } = {},
): Promise<{ backfill: IngestFailureBackfillResult; recovered: number }> {
  const backfill = await backfillIngestFailureReviewQueue(env, {
    limit: opts.limit ?? 200,
    dryRun: false,
  });

  const stale = await all<{ doc_id: string }>(
    env.DB,
    `SELECT rq.doc_id
       FROM review_queue rq
       JOIN filings f ON f.doc_id = rq.doc_id
      WHERE rq.resolved = 0
        AND rq.reason LIKE ?
        AND f.ingest_status <> 'error'
      LIMIT ?`,
    [`${INGEST_FAILURE_REASON_PREFIX}%`, opts.limit ?? 200],
  );
  let recovered = 0;
  for (const row of stale) {
    if (await clearIngestFailureReviewQueueIfRecovered(env.DB, row.doc_id)) recovered += 1;
  }
  backfill.recovered = recovered;
  return { backfill, recovered };
}
