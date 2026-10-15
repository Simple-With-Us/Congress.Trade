/**
 * src/extraction/executiveDisposition.ts
 *
 * Close an empty executive 278e, and park an unreadable 278-T for a human.
 *
 * A 278e whose deterministic read finds no 278-T table and whose other
 * successful reads also found nothing is verified_empty
 * (auto_resolved_empty).  That close is terminal: Part 7 was actually empty
 * (explicit None, or a 278e with no 278-T table and no contradictory read).
 *
 * A read the ogeText gate refuses is a different fact.  The text layer is
 * garbage, so the pipeline cannot know whether Part 7 has rows.  The Sep 8
 * Trump 278-T carried reason oge_text_unreadable and later published 1113
 * rows after a manual read.  Auto-resolving the next one as rejected (actor
 * null, same second the review opens) drops the filing with no human and no
 * alarm.  Park it unresolved, record oge_text_unreadable for the filing-skip
 * alarm, and leave verified_empty alone.
 *
 * The known-doc sweep still corrects the two historical parked rows.  Empty
 * stays verified_empty.  Unreadable is parked open.  A bounded sweep reopens
 * rows this path already auto-rejected.
 */

import type { Env } from '../shared/types.ts';
import { all, batch, get, type SqlParam } from '../shared/db.ts';
import { AGREEMENT_CLAIM_LEASE_MS } from './agreement.ts';
import {
  OGE_TEXT_UNREADABLE_DECISION_ACTION,
  recordIngestionDecision,
} from '../shared/ingestionDecisions.ts';
import { notifyReviewQueuePublisher } from '../ingestion/reviewQueueNotify.ts';

export const EXECUTIVE_EMPTY_RESOLUTION_REASON = 'executive_278e_no_transactions';
export const OGE_TEXT_UNREADABLE_RESOLUTION = 'oge_text_unreadable';
/**
 * Health-terminal token so agreement and the deterministic drain do not
 * spend another read on a refused text layer.  The review row stays
 * unresolved: `ocr_unusable` hides it from the selector, not from humans.
 * The filing-skip alarm is the loud signal.
 */
export const OGE_TEXT_UNREADABLE_REASON = 'ocr_unusable,oge_text_unreadable';

export const BONDI_EMPTY_DOC_ID = 'E-undated-pam-bondi-2026-278term';
export const TRUMP_UNREADABLE_DOC_ID = 'E-2026-donald-j-trump-09-8-2026-278t';

const EMPTY_ERROR_CLEARED = EXECUTIVE_EMPTY_RESOLUTION_REASON;
const UNREADABLE_FILING_ERROR =
  'oge_text_unreadable: deterministic extractor refused a garbled or unreadable 278-T text layer';

/**
 * Two kind=agreement vision runs count as the same reading only when their
 * row counts are this close.  33 vs 66 vs 472 (Trump 278-T) is not a
 * successful read of a 1156-row filing.
 */
export const AGREEMENT_VISION_COUNT_AGREE_RATIO = 0.8;

/**
 * maxAttempts() never exceeds 5.  A parked unreadable row at this floor is
 * not selector-due, so the agreement autopublish loop does not spend vision
 * on a text layer the deterministic gate already refused.
 */
export const UNREADABLE_PARK_ATTEMPT_FLOOR = 5;

/** Per hourly pass.  Older pipeline auto-rejects reopen first. */
export const AUTO_REJECTED_UNREADABLE_REOPEN_LIMIT = 25;

/**
 * True when extraction_runs already holds a successful nonempty read of
 * the doc named by `docIdExpr` (`?` or a correlated column).  A
 * non-agreement (or null-kind) ok run with rows still blocks; kind=agreement
 * vision blocks only when at least two ok>0 runs exist in one batch and
 * every pair in that same batch has min/max row_count >=
 * AGREEMENT_VISION_COUNT_AGREE_RATIO.  Disputed agreement vision must not
 * block an unreadable park or empty close, and a disputed batch vetoes only
 * itself, never another corroborated batch.  A pair is two distinct models
 * (provider or model differs) in the same agreement batch: retries of one
 * model, or runs from different batches, are not independent agreement.
 */
function successfulNonemptyReadSql(docIdExpr: string): string {
  return `(
  EXISTS (
    SELECT 1 FROM extraction_runs
     WHERE doc_id = ${docIdExpr} AND ok = 1 AND COALESCE(row_count, 0) > 0
       AND COALESCE(kind, '') <> 'agreement'
  )
  OR EXISTS (
    SELECT 1 FROM extraction_runs a
      JOIN extraction_runs b
        ON b.doc_id = a.doc_id AND b.rowid > a.rowid
       AND b.batch_id = a.batch_id
       AND (b.provider <> a.provider OR b.model <> a.model)
     WHERE a.doc_id = ${docIdExpr}
       AND a.ok = 1 AND b.ok = 1
       AND COALESCE(a.kind, '') = 'agreement'
       AND COALESCE(b.kind, '') = 'agreement'
       AND COALESCE(a.row_count, 0) > 0
       AND COALESCE(b.row_count, 0) > 0
       /* The disagreement veto is scoped to this candidate batch: an older
          disputed batch must not cancel a later corroborated one. */
       AND NOT EXISTS (
         SELECT 1 FROM extraction_runs c
           JOIN extraction_runs d
             ON d.doc_id = c.doc_id AND d.rowid > c.rowid
            AND d.batch_id = c.batch_id
            AND (d.provider <> c.provider OR d.model <> c.model)
          WHERE c.doc_id = ${docIdExpr}
            AND c.batch_id = a.batch_id
            AND c.ok = 1 AND d.ok = 1
            AND COALESCE(c.kind, '') = 'agreement'
            AND COALESCE(d.kind, '') = 'agreement'
            AND COALESCE(c.row_count, 0) > 0
            AND COALESCE(d.row_count, 0) > 0
            AND (MIN(c.row_count, d.row_count) * 1.0 / MAX(c.row_count, d.row_count))
                < ${AGREEMENT_VISION_COUNT_AGREE_RATIO}
       )
  )
)`;
}

/** Bind `doc_id` three times when this fragment is used with `?`. */
export const SUCCESSFUL_NONEMPTY_READ_SQL = successfulNonemptyReadSql('?');

function successfulNonemptyReadParams(docId: string): SqlParam[] {
  return [docId, docId, docId];
}

export interface ExecutiveCloseOptions {
  nowIso?: string;
  /** When set, only the holder of this lease (or an unclaimed row) may close. */
  claimToken?: string | null;
  /** Skip rows a human already suppressed (admin reopen sets agreement_suppressed_at). */
  respectSuppression?: boolean;
  reviewRevision?: number | null;
  /**
   * First-pass normalize() may run before any review_queue row exists.  When
   * set, a missing row is inserted already resolved instead of the UPDATE
   * matching nothing (which would let routeToReview park an unresolved row).
   */
  insertIfAbsent?: boolean;
}

async function hasLiveTransactions(env: Env, docId: string): Promise<boolean> {
  try {
    const row = await get<{ hit: number }>(
      env.DB,
      `SELECT 1 AS hit FROM transactions
        WHERE doc_id = ? AND deprecated_at IS NULL
        LIMIT 1`,
      [docId],
    );
    return Boolean(row);
  } catch {
    // Fail closed: do not close a filing we cannot prove is empty of rows.
    return true;
  }
}

/**
 * True when some earlier successful read already found transactions.  A
 * bare zero from the deterministic parser is not enough to call the filing
 * empty in that case.  Disputed kind=agreement vision is not a successful
 * read.
 */
export async function otherSuccessfulReadHasRows(env: Env, docId: string): Promise<boolean> {
  try {
    const row = await get<{ hit: number }>(
      env.DB,
      `SELECT 1 AS hit WHERE ${SUCCESSFUL_NONEMPTY_READ_SQL}`,
      successfulNonemptyReadParams(docId),
    );
    return Boolean(row);
  } catch {
    return true;
  }
}

function reviewWhere(opts: ExecutiveCloseOptions): { sql: string; params: SqlParam[] } {
  const respect = opts.respectSuppression ? 1 : 0;
  const revision = opts.reviewRevision ?? null;
  // A supplied claim token must match EXACTLY: a worker whose lease a
  // concurrent normalize() had just cleared must not close the row.
  const token = opts.claimToken ?? null;
  const base = `doc_id = ?
    AND resolved = 0
    AND (? = 0 OR agreement_suppressed_at IS NULL)
    AND (? IS NULL OR review_revision = ?)`;
  if (token) {
    return {
      sql: `${base}
      AND agreement_claim_token = ?`,
      params: [respect, revision, revision, token],
    };
  }
  // Tokenless callers (normalize(), the sweep) must not close over a live
  // agreement lease: acquiring a lease does not bump review_revision, so the
  // revision guard cannot see it. Close only when no lease is held or the
  // held lease has expired.
  const expiredBefore = new Date(
    Date.parse(opts.nowIso ?? new Date().toISOString()) - AGREEMENT_CLAIM_LEASE_MS,
  ).toISOString();
  return {
    sql: `${base}
      AND (
        agreement_claim_token IS NULL OR agreement_claimed_at IS NULL
        OR agreement_claimed_at <= ?
      )`,
    params: [respect, revision, revision, expiredBefore],
  };
}

async function writeClose(
  env: Env,
  docId: string,
  opts: ExecutiveCloseOptions,
  review: {
    reason: string;
    resolutionKind: 'verified_empty' | 'rejected';
    resolutionReason: string;
  },
  filing: { ingestStatus: string; error: string | null },
  decision: { action: 'auto_resolved_empty'; reason: string },
): Promise<boolean> {
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const where = reviewWhere(opts);
  const insertStatements: Array<[string, SqlParam[]]> = opts.insertIfAbsent
    ? [[
        `INSERT OR IGNORE INTO review_queue (
            doc_id, reason, payload, created_at, resolved,
            resolution_kind, resolution_reason, resolved_at
          ) SELECT ?, ?, '{}', ?, 1, ?, ?, ?
             WHERE NOT EXISTS (SELECT 1 FROM review_queue WHERE doc_id = ?)
               AND EXISTS (
                 SELECT 1 FROM filings WHERE doc_id = ? AND ingest_status <> 'persisted'
               )
               AND NOT EXISTS (
                 SELECT 1 FROM transactions WHERE doc_id = ? AND deprecated_at IS NULL
               )
               -- Same atomic guard as the UPDATE close below: a successful
               -- nonempty read persisted between the outer guard and this
               -- batch must not be closed over on a first pass either.
               -- Disputed kind=agreement vision is not a successful read.
               AND NOT ${SUCCESSFUL_NONEMPTY_READ_SQL}`,
        [
          docId,
          review.reason,
          nowIso,
          review.resolutionKind,
          review.resolutionReason,
          nowIso,
          docId,
          docId,
          docId,
          ...successfulNonemptyReadParams(docId),
        ],
      ]]
    : [];
  const results = await batch(env.DB, [
    ...insertStatements,
    [
      `UPDATE review_queue
          SET resolved = 1,
              reason = ?,
              agreement_claim_token = NULL,
              agreement_claimed_at = NULL,
              agreement_next_attempt_at = NULL,
              resolution_kind = ?,
              resolution_reason = ?,
              resolved_at = ?,
              review_revision = review_revision + 1
        WHERE ${where.sql}
          -- Repeat the emptiness guards INSIDE the close: the outer
          -- hasLiveTransactions / otherSuccessfulReadHasRows checks run
          -- before the batch, so a live row or a nonempty extraction_run
          -- persisted in between would otherwise be closed over without
          -- even a review_revision bump.
          AND NOT EXISTS (
            SELECT 1 FROM transactions WHERE doc_id = ? AND deprecated_at IS NULL
          )
          AND NOT ${SUCCESSFUL_NONEMPTY_READ_SQL}
          -- routeToReview stages low-confidence candidates only in
          -- payload.transactions: no live transaction and no successful
          -- nonempty extraction_runs row, so both table guards pass while
          -- the review holds real candidates. Staged candidates are row
          -- evidence too. Disputed kind=agreement vision is not a successful
          -- read.
          AND NOT (COALESCE(json_extract(payload, '$.transactionCount'), 0) > 0)`,
      [
        review.reason,
        review.resolutionKind,
        review.resolutionReason,
        nowIso,
        docId,
        ...where.params,
        docId,
        ...successfulNonemptyReadParams(docId),
      ],
    ],
    [
      `UPDATE filings
          SET ingest_status = ?,
              error = ?
        WHERE doc_id = ?
          AND ingest_status <> 'persisted'
          AND NOT EXISTS (
            SELECT 1 FROM transactions
             WHERE doc_id = ? AND deprecated_at IS NULL
          )
          AND EXISTS (
            SELECT 1 FROM review_queue
             WHERE doc_id = ? AND resolved = 1 AND resolution_kind = ?
               AND resolution_reason = ?
          )`,
      [
        filing.ingestStatus,
        filing.error,
        docId,
        docId,
        docId,
        review.resolutionKind,
        review.resolutionReason,
      ],
    ],
  ]);
  // Inserted-resolved or updated-to-resolved; the filings UPDATE is last.
  const closed = results
    .slice(0, insertStatements.length + 1)
    .some((result) => (result?.meta?.changes ?? 0) > 0);
  if (!closed) return false;
  await recordIngestionDecision(env.DB, {
    docId,
    action: decision.action,
    source: 'pipeline',
    reason: decision.reason,
    payload: {
      resolvedBy: 'executive-disposition',
      resolutionKind: review.resolutionKind,
    },
  });
  return true;
}

/** 278e with no transactions and no contradictory successful read. */
export async function closeVerifiedEmptyExecutive(
  env: Env,
  docId: string,
  opts: ExecutiveCloseOptions = {},
): Promise<boolean> {
  if (await hasLiveTransactions(env, docId)) return false;
  if (await otherSuccessfulReadHasRows(env, docId)) return false;
  return writeClose(
    env,
    docId,
    opts,
    {
      reason: EXECUTIVE_EMPTY_RESOLUTION_REASON,
      resolutionKind: 'verified_empty',
      resolutionReason: EXECUTIVE_EMPTY_RESOLUTION_REASON,
    },
    { ingestStatus: 'verified_empty', error: null },
    { action: 'auto_resolved_empty', reason: EMPTY_ERROR_CLEARED },
  );
}

const UNREADABLE_DECISION_PAYLOAD = JSON.stringify({
  resolvedBy: 'executive-disposition',
  parked: true,
});

/**
 * Leave the review open with the unreadable reason, move the filing to
 * needs_review, and write one filing-skip decision.  `reviewSql` is the
 * review_queue write (park an open row, or reopen a pipeline auto-reject).
 * A second pass matches nothing.
 */
async function commitUnreadablePark(
  env: Env,
  docId: string,
  opts: ExecutiveCloseOptions,
  reviewSql: { sql: string; params: SqlParam[] },
  notifyKind: 'insert' | 'reopen',
): Promise<boolean> {
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const decisionId = `decision:${OGE_TEXT_UNREADABLE_DECISION_ACTION}:${docId}`;
  const insertStatements: Array<[string, SqlParam[]]> = opts.insertIfAbsent
    ? [[
        `INSERT OR IGNORE INTO review_queue (
            doc_id, reason, payload, created_at, resolved, agreement_attempts
          ) SELECT ?, ?, '{}', ?, 0, ?
             WHERE NOT EXISTS (SELECT 1 FROM review_queue WHERE doc_id = ?)
               AND EXISTS (
                 SELECT 1 FROM filings WHERE doc_id = ? AND ingest_status <> 'persisted'
               )
               AND NOT EXISTS (
                 SELECT 1 FROM transactions WHERE doc_id = ? AND deprecated_at IS NULL
               )
               AND NOT ${SUCCESSFUL_NONEMPTY_READ_SQL}`,
        [
          docId,
          OGE_TEXT_UNREADABLE_REASON,
          nowIso,
          UNREADABLE_PARK_ATTEMPT_FLOOR,
          docId,
          docId,
          docId,
          ...successfulNonemptyReadParams(docId),
        ],
      ]]
    : [];
  const results = await batch(env.DB, [
    ...insertStatements,
    [reviewSql.sql, reviewSql.params],
    [
      `UPDATE filings
          SET ingest_status = 'needs_review',
              error = ?
        WHERE doc_id = ?
          AND ingest_status <> 'persisted'
          AND (
            ingest_status <> 'needs_review'
            OR COALESCE(error, '') <> ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM transactions
             WHERE doc_id = ? AND deprecated_at IS NULL
          )
          AND EXISTS (
            SELECT 1 FROM review_queue
             WHERE doc_id = ? AND resolved = 0 AND reason = ?
          )`,
      [
        UNREADABLE_FILING_ERROR,
        docId,
        UNREADABLE_FILING_ERROR,
        docId,
        docId,
        OGE_TEXT_UNREADABLE_REASON,
      ],
    ],
    [
      `INSERT OR IGNORE INTO ingestion_decisions
         (id, doc_id, action, source, actor, reason, payload, transaction_ids, created_at)
       SELECT ?, ?, ?, 'pipeline', NULL, ?, ?, '[]', ?
        WHERE EXISTS (
          SELECT 1 FROM review_queue
           WHERE doc_id = ? AND resolved = 0 AND reason = ?
        )`,
      [
        decisionId,
        docId,
        OGE_TEXT_UNREADABLE_DECISION_ACTION,
        OGE_TEXT_UNREADABLE_RESOLUTION,
        UNREADABLE_DECISION_PAYLOAD,
        nowIso,
        docId,
        OGE_TEXT_UNREADABLE_REASON,
      ],
    ],
  ]);
  const reviewChanged = results
    .slice(0, insertStatements.length + 1)
    .some((result) => (result?.meta?.changes ?? 0) > 0);
  const changed = results.some((result) => (result?.meta?.changes ?? 0) > 0);
  if (reviewChanged) {
    void notifyReviewQueuePublisher(env, {
      docId,
      reason: OGE_TEXT_UNREADABLE_REASON,
      kind: notifyKind,
      at: nowIso,
    });
  }
  return changed;
}

function openUnreadableParkSql(
  docId: string,
  opts: ExecutiveCloseOptions,
): { sql: string; params: SqlParam[] } {
  const where = reviewWhere(opts);
  return {
    sql: `UPDATE review_queue
            SET resolved = 0,
                reason = ?,
                agreement_claim_token = NULL,
                agreement_claimed_at = NULL,
                agreement_next_attempt_at = NULL,
                agreement_attempts = MAX(COALESCE(agreement_attempts, 0), ${UNREADABLE_PARK_ATTEMPT_FLOOR}),
                resolution_kind = NULL,
                resolution_reason = NULL,
                resolved_at = NULL,
                review_revision = review_revision + 1
          WHERE ${where.sql}
            AND COALESCE(reason, '') NOT LIKE '%oge_text_unreadable%'
            AND NOT EXISTS (
              SELECT 1 FROM transactions WHERE doc_id = ? AND deprecated_at IS NULL
            )
            AND NOT ${SUCCESSFUL_NONEMPTY_READ_SQL}
            AND NOT (COALESCE(json_extract(payload, '$.transactionCount'), 0) > 0)`,
    params: [
      OGE_TEXT_UNREADABLE_REASON,
      docId,
      ...where.params,
      docId,
      ...successfulNonemptyReadParams(docId),
    ],
  };
}

/** Garbled / refused deterministic read.  Not an empty filing, and not a terminal reject. */
export async function closeUnreadableExecutive(
  env: Env,
  docId: string,
  opts: ExecutiveCloseOptions = {},
): Promise<boolean> {
  if (await hasLiveTransactions(env, docId)) return false;
  // A later refused read must not park over a filing an earlier successful
  // read already found rows for — same guard the verified_empty close applies.
  if (await otherSuccessfulReadHasRows(env, docId)) return false;
  return commitUnreadablePark(
    env,
    docId,
    opts,
    openUnreadableParkSql(docId, opts),
    'insert',
  );
}

export interface ExecutiveTerminalSweepResult {
  verifiedEmpty: number;
  unreadable: number;
}

/**
 * Correct the two parked rows.  Bondi is an empty 278e and still closes
 * verified_empty.  Trump is an unreadable 278-T and is parked open, not
 * rejected.  A second run matches nothing.  A row an administrator reopened
 * (agreement_suppressed_at set) is left for human review; the sweep must not
 * undo a reopen on its next hourly run.
 */
export async function sweepKnownParkedExecutiveTerminals(
  env: Env,
  now = new Date(),
): Promise<ExecutiveTerminalSweepResult> {
  const nowIso = now.toISOString();
  const targets: Array<{ docId: string; kind: 'empty' | 'unreadable' }> = [
    { docId: BONDI_EMPTY_DOC_ID, kind: 'empty' },
    { docId: TRUMP_UNREADABLE_DOC_ID, kind: 'unreadable' },
  ];
  let verifiedEmpty = 0;
  let unreadable = 0;
  for (const target of targets) {
    // Bind the close to the revision this SELECT observed: a normalize()
    // revision landing between the two would otherwise be closed over.  Only
    // correct a row still carrying the legacy parked reason: an operator
    // retry-auto rewrites it to auto_retry_requested and clears suppression,
    // and this sweep must not re-apply the hard-coded close without
    // re-reading the PDF.
    const open = await get<{ doc_id: string; review_revision: number }>(
      env.DB,
      `SELECT doc_id, review_revision FROM review_queue
        WHERE doc_id = ? AND resolved = 0 AND agreement_suppressed_at IS NULL
          AND (reason LIKE 'extract_empty_failure%' OR reason LIKE 'agreement_cascade_unresolved%')
        LIMIT 1`,
      [target.docId],
    ).catch(() => null);
    if (!open) continue;
    const closed = target.kind === 'empty'
      ? await closeVerifiedEmptyExecutive(env, target.docId, {
          nowIso,
          respectSuppression: true,
          reviewRevision: open.review_revision,
        })
      : await closeUnreadableExecutive(env, target.docId, {
          nowIso,
          respectSuppression: true,
          reviewRevision: open.review_revision,
        });
    if (!closed) continue;
    if (target.kind === 'empty') verifiedEmpty += 1;
    else unreadable += 1;
  }
  if (verifiedEmpty || unreadable) {
    console.log(
      `executiveDisposition sweep: verified_empty=${verifiedEmpty} unreadable=${unreadable}`,
    );
  }
  return { verifiedEmpty, unreadable };
}

/** Docs the allowlisted sweep is allowed to touch.  Tests and callers share this list. */
export function knownParkedExecutiveDocIds(): string[] {
  return [BONDI_EMPTY_DOC_ID, TRUMP_UNREADABLE_DOC_ID];
}

export interface AutoRejectedUnreadableSweepResult {
  reopened: number;
}

/**
 * Reopen executive 278-Ts that executive-disposition already terminal-rejected
 * for oge_text_unreadable with no human actor.  A later human decision, a
 * live transaction, or a corroborated nonempty read stays closed.  Bounded
 * and idempotent: a reopened row is unresolved, so the next pass skips it.
 */
export async function sweepAutoRejectedUnreadable(
  env: Env,
  now = new Date(),
): Promise<AutoRejectedUnreadableSweepResult> {
  const nowIso = now.toISOString();
  let rows: Array<{ doc_id: string }> = [];
  try {
    rows = await all<{ doc_id: string }>(
      env.DB,
      `SELECT rq.doc_id
         FROM review_queue rq
         JOIN filings f ON f.doc_id = rq.doc_id
        WHERE rq.resolved = 1
          AND rq.resolution_kind = 'rejected'
          AND rq.resolution_reason = ?
          AND COALESCE(rq.reason, '') LIKE '%oge_text_unreadable%'
          AND rq.agreement_suppressed_at IS NULL
          AND f.ingest_status <> 'persisted'
          AND NOT EXISTS (
            SELECT 1 FROM transactions t
             WHERE t.doc_id = rq.doc_id AND t.deprecated_at IS NULL
          )
          AND NOT ${successfulNonemptyReadSql('rq.doc_id')}
          AND NOT (COALESCE(json_extract(rq.payload, '$.transactionCount'), 0) > 0)
          AND EXISTS (
            SELECT 1 FROM ingestion_decisions d
             WHERE d.doc_id = rq.doc_id
               AND d.action = 'rejected'
               AND d.actor IS NULL
               AND d.source = 'pipeline'
               AND json_extract(d.payload, '$.resolvedBy') = 'executive-disposition'
          )
          AND NOT EXISTS (
            SELECT 1 FROM ingestion_decisions h
             WHERE h.doc_id = rq.doc_id
               AND h.actor IS NOT NULL
               AND TRIM(h.actor) <> ''
          )
        ORDER BY rq.resolved_at ASC
        LIMIT ?`,
      [OGE_TEXT_UNREADABLE_RESOLUTION, AUTO_REJECTED_UNREADABLE_REOPEN_LIMIT],
    );
  } catch (err) {
    console.warn('sweepAutoRejectedUnreadable select failed:', (err as Error).message);
    return { reopened: 0 };
  }

  let reopened = 0;
  for (const row of rows) {
    const parked = await commitUnreadablePark(
      env,
      row.doc_id,
      { nowIso, respectSuppression: true },
      {
        sql: `UPDATE review_queue
                SET resolved = 0,
                    reason = ?,
                    agreement_claim_token = NULL,
                    agreement_claimed_at = NULL,
                    agreement_next_attempt_at = NULL,
                    agreement_attempts = MAX(COALESCE(agreement_attempts, 0), ${UNREADABLE_PARK_ATTEMPT_FLOOR}),
                    resolution_kind = NULL,
                    resolution_reason = NULL,
                    resolved_at = NULL,
                    review_revision = review_revision + 1
              WHERE doc_id = ?
                AND resolved = 1
                AND resolution_kind = 'rejected'
                AND resolution_reason = ?
                AND COALESCE(reason, '') LIKE '%oge_text_unreadable%'
                AND agreement_suppressed_at IS NULL
                AND NOT EXISTS (
                  SELECT 1 FROM transactions WHERE doc_id = ? AND deprecated_at IS NULL
                )
                AND NOT ${SUCCESSFUL_NONEMPTY_READ_SQL}
                AND NOT (COALESCE(json_extract(payload, '$.transactionCount'), 0) > 0)
                AND EXISTS (
                  SELECT 1 FROM ingestion_decisions d
                   WHERE d.doc_id = review_queue.doc_id
                     AND d.action = 'rejected'
                     AND d.actor IS NULL
                     AND d.source = 'pipeline'
                     AND json_extract(d.payload, '$.resolvedBy') = 'executive-disposition'
                )
                AND NOT EXISTS (
                  SELECT 1 FROM ingestion_decisions h
                   WHERE h.doc_id = review_queue.doc_id
                     AND h.actor IS NOT NULL
                     AND TRIM(h.actor) <> ''
                )`,
        params: [
          OGE_TEXT_UNREADABLE_REASON,
          row.doc_id,
          OGE_TEXT_UNREADABLE_RESOLUTION,
          row.doc_id,
          ...successfulNonemptyReadParams(row.doc_id),
        ],
      },
      'reopen',
    ).catch((err) => {
      console.warn('sweepAutoRejectedUnreadable park failed:', row.doc_id, (err as Error).message);
      return false;
    });
    if (parked) reopened += 1;
  }
  if (reopened) {
    console.log(`executiveDisposition sweep: reopened unreadable=${reopened}`);
  }
  return { reopened };
}
