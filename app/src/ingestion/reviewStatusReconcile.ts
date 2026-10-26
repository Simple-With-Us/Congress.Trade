/**
 * src/ingestion/reviewStatusReconcile.ts
 *
 * One-time / on-demand hygiene for two production data issues:
 *   #1576 — delete the manual test-probe filing
 *            `S-grok-probe-should-not-exist-zzzz`
 *   #1574 — stamp filings.ingest_status to match an already-resolved
 *            review_queue row (the 547-row desync from 2026-08-09)
 *   CT-2453 — stamp filings.ingest_status='persisted' when the filing
 *            itself is already published (live transactions + a publish
 *            decision), even if it never had a review_queue row. A later
 *            fetch failure can leave ingest_status='error' on that filing.
 *
 * Both operations are idempotent.  Writes happen only when `apply: true`.
 * The probe delete is exact-doc_id and refuses if any transaction rows
 * exist, so a real filing can never be removed by this path.
 *
 * OWNER: ingestion / admin
 */

import type { Env, IngestStatus } from '../shared/types.ts';
import { all, get, run, type SqlParam } from '../shared/db.ts';

/** The only filing this module will ever delete.  Self-describing probe. */
export const MANUAL_TEST_PROBE_DOC_ID = 'S-grok-probe-should-not-exist-zzzz';

const PROVIDER_MISSING_PREFIX = 'provider-missing-%';

/**
 * ingestion_decisions.action values that mean the filing was published.
 * The latest decision must be one of these. An older publish followed by
 * a rejection is not still published.
 */
export const PUBLISH_DECISION_ACTIONS = [
  'auto_published',
  'confirmed',
  'manual',
  'agreement_published',
] as const;

/**
 * SQL predicate: this filing has at least one live transaction and its
 * latest ingestion decision is a publish. `filingAlias` is a trusted
 * identifier, never user input. Bind `PUBLISH_DECISION_ACTIONS` after the
 * caller's own placeholders.
 */
export function alreadyPublishedPredicate(filingAlias: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(filingAlias)) {
    throw new Error(`alreadyPublishedPredicate: bad alias ${filingAlias}`);
  }
  const actions = PUBLISH_DECISION_ACTIONS.map(() => '?').join(', ');
  return `EXISTS (
            SELECT 1 FROM transactions t
             WHERE t.doc_id = ${filingAlias}.doc_id
               AND t.deprecated_at IS NULL
          )
          AND (
            SELECT d.action FROM ingestion_decisions d
             WHERE d.doc_id = ${filingAlias}.doc_id
             ORDER BY d.created_at DESC, d.id DESC
             LIMIT 1
          ) IN (${actions})`;
}

/**
 * True when the filing's own rows say it is already published.
 * Fails open (returns false) on a query error so a broken check cannot
 * wedge every fetch. Callers that write ingest_status must also keep the
 * predicate in the UPDATE.
 */
export async function isFilingAlreadyPublished(
  db: D1Database,
  docId: string,
): Promise<boolean> {
  try {
    const row = await get<{ published: number }>(
      db,
      `SELECT 1 AS published FROM filings
        WHERE doc_id = ?
          AND ${alreadyPublishedPredicate('filings')}
        LIMIT 1`,
      [docId, ...PUBLISH_DECISION_ACTIONS],
    );
    return Number(row?.published) === 1;
  } catch (err) {
    console.warn(
      `reviewStatusReconcile: published-check failed for ${docId}; failing open:`,
      (err as Error).message,
    );
    return false;
  }
}

/** Mid-pipeline statuses plus the invalid leftover the #1579 sweep wrote. */
export const DESYNCED_INGEST_STATUSES = [
  'new',
  'fetched',
  'classified',
  'extraction_pending_local',
  'extracted',
  'needs_review',
  // Not a valid IngestStatus.  The first hourly desync sweep stamped this
  // instead of `persisted`.  Re-map those leftovers on the next pass.
  'published',
] as const;

export type TerminalIngestStatus = Extract<
  IngestStatus,
  'persisted' | 'error' | 'verified_empty'
>;

export type ResolutionKind =
  | 'published'
  | 'verified_empty'
  | 'rejected'
  | 'orphan_deleted';

export interface ResolvedReviewEvidence {
  resolutionKind: string | null;
  resolutionReason: string | null;
  reviewReason: string | null;
  decisionAction: string | null;
  hasLiveTx: boolean;
}

export interface TerminalStatusDecision {
  status: TerminalIngestStatus;
  basis: string;
}

const RESOLUTION_KINDS: readonly ResolutionKind[] = [
  'published',
  'verified_empty',
  'rejected',
  'orphan_deleted',
];

function asResolutionKind(value: string | null): ResolutionKind | null {
  if (!value) return null;
  return (RESOLUTION_KINDS as readonly string[]).includes(value)
    ? (value as ResolutionKind)
    : null;
}

/**
 * Pick the terminal filings.ingest_status that the review process already
 * decided.  resolution_kind wins; ingestion_decisions and live-tx presence
 * are fallbacks for legacy rows that predate honest resolution columns.
 */
export function terminalStatusForResolvedReview(
  evidence: ResolvedReviewEvidence,
): TerminalStatusDecision {
  const kind = asResolutionKind(evidence.resolutionKind);
  if (kind) {
    switch (kind) {
      case 'published':
        return { status: 'persisted', basis: 'resolution_kind=published' };
      case 'verified_empty':
        return { status: 'verified_empty', basis: 'resolution_kind=verified_empty' };
      case 'rejected':
        return { status: 'error', basis: 'resolution_kind=rejected' };
      case 'orphan_deleted':
        return { status: 'error', basis: 'resolution_kind=orphan_deleted' };
      default: {
        const _exhaustive: never = kind;
        return _exhaustive;
      }
    }
  }

  switch (evidence.decisionAction) {
    case 'confirmed':
    case 'manual':
    case 'auto_published':
    case 'agreement_published':
      return { status: 'persisted', basis: `ingestion_decisions.action=${evidence.decisionAction}` };
    case 'auto_resolved_empty':
      return { status: 'verified_empty', basis: 'ingestion_decisions.action=auto_resolved_empty' };
    case 'rejected':
    case 'extract_empty_failure':
    case 'doc_quarantined':
      return { status: 'error', basis: `ingestion_decisions.action=${evidence.decisionAction}` };
    default:
      break;
  }

  const reason = `${evidence.resolutionReason ?? ''} ${evidence.reviewReason ?? ''}`.toLowerCase();
  if (/\brejected\b/.test(reason)) {
    return { status: 'error', basis: 'review reason contains rejected' };
  }
  if (evidence.hasLiveTx) {
    return { status: 'persisted', basis: 'legacy resolved row with live transactions' };
  }
  return { status: 'error', basis: 'legacy resolved row with no live transactions' };
}

export interface DesyncCandidate {
  docId: string;
  currentStatus: string;
  targetStatus: TerminalIngestStatus;
  basis: string;
  hasLiveTx: boolean;
  resolutionKind: string | null;
  decisionAction: string | null;
  /**
   * review_queue: the resolved-queue desync path.
   * published_truth: live transactions + a publish decision, no dependence
   * on a review_queue row (CT-2453).
   */
  via: 'review_queue' | 'published_truth';
}

export interface DesyncReconcileResult {
  scanned: number;
  updated: number;
  alreadyTerminal: number;
  sample: DesyncCandidate[];
}

export interface ProbeRelatedCounts {
  filings: number;
  reviewQueue: number;
  transactions: number;
  ingestionOutbox: number;
  ingestionDecisions: number;
  extractionRuns: number;
  disclosureLatencyCandidates: number;
  runtimeQueue: number;
}

export interface ProbeHygieneResult {
  docId: string;
  found: boolean;
  related: ProbeRelatedCounts;
  deleted: boolean;
  refusedReason: string | null;
}

export interface FilingsHygieneResult {
  applied: boolean;
  probe: ProbeHygieneResult;
  desync: DesyncReconcileResult;
}

interface DesyncRow {
  doc_id: string;
  ingest_status: string;
  has_tx: number;
  resolution_kind: string | null;
  resolution_reason: string | null;
  review_reason: string | null;
  decision_action: string | null;
}

async function countTableByDocId(
  db: D1Database,
  table: string,
  docId: string,
  extraWhere = '',
  extraParams: SqlParam[] = [],
): Promise<number> {
  try {
    const row = await get<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM ${table} WHERE doc_id = ?${extraWhere}`,
      [docId, ...extraParams],
    );
    return Number(row?.n ?? 0);
  } catch (err) {
    if (/no such table/i.test((err as Error).message)) return 0;
    throw err;
  }
}

async function countRuntimeQueueForDoc(db: D1Database, docId: string): Promise<number> {
  try {
    const row = await get<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM deno_runtime_queue
        WHERE payload LIKE ?`,
      [`%"docId":"${docId}"%`],
    );
    return Number(row?.n ?? 0);
  } catch (err) {
    if (/no such table/i.test((err as Error).message)) return 0;
    throw err;
  }
}

async function deleteTableByDocId(db: D1Database, table: string, docId: string): Promise<number> {
  try {
    const res = await run(db, `DELETE FROM ${table} WHERE doc_id = ?`, [docId]);
    return res.meta?.changes ?? 0;
  } catch (err) {
    if (/no such table/i.test((err as Error).message)) return 0;
    throw err;
  }
}

export async function inspectManualTestProbe(db: D1Database): Promise<ProbeHygieneResult> {
  const docId = MANUAL_TEST_PROBE_DOC_ID;
  const related: ProbeRelatedCounts = {
    filings: await countTableByDocId(db, 'filings', docId),
    reviewQueue: await countTableByDocId(db, 'review_queue', docId),
    transactions: await countTableByDocId(db, 'transactions', docId),
    ingestionOutbox: await countTableByDocId(db, 'ingestion_outbox', docId),
    ingestionDecisions: await countTableByDocId(db, 'ingestion_decisions', docId),
    extractionRuns: await countTableByDocId(db, 'extraction_runs', docId),
    disclosureLatencyCandidates: await countTableByDocId(db, 'disclosure_latency_candidates', docId),
    runtimeQueue: await countRuntimeQueueForDoc(db, docId),
  };
  return {
    docId,
    found: related.filings > 0,
    related,
    deleted: false,
    refusedReason: related.transactions > 0
      ? 'refusing probe delete: transaction rows exist for this doc_id'
      : null,
  };
}

export async function deleteManualTestProbe(
  db: D1Database,
  opts: { apply: boolean },
): Promise<ProbeHygieneResult> {
  const preview = await inspectManualTestProbe(db);
  if (preview.refusedReason) return preview;
  if (!opts.apply || !preview.found) return preview;

  await deleteTableByDocId(db, 'review_queue', MANUAL_TEST_PROBE_DOC_ID);
  await deleteTableByDocId(db, 'ingestion_outbox', MANUAL_TEST_PROBE_DOC_ID);
  await deleteTableByDocId(db, 'ingestion_decisions', MANUAL_TEST_PROBE_DOC_ID);
  await deleteTableByDocId(db, 'extraction_runs', MANUAL_TEST_PROBE_DOC_ID);
  await deleteTableByDocId(db, 'disclosure_latency_candidates', MANUAL_TEST_PROBE_DOC_ID);
  try {
    await run(
      db,
      `DELETE FROM deno_runtime_queue WHERE payload LIKE ?`,
      [`%"docId":"${MANUAL_TEST_PROBE_DOC_ID}"%`],
    );
  } catch (err) {
    if (!/no such table/i.test((err as Error).message)) throw err;
  }
  const filingRes = await run(
    db,
    `DELETE FROM filings WHERE doc_id = ?`,
    [MANUAL_TEST_PROBE_DOC_ID],
  );
  return {
    ...preview,
    found: false,
    deleted: (filingRes.meta?.changes ?? 0) > 0,
    related: { ...preview.related, filings: 0 },
  };
}

async function loadDesyncRows(
  db: D1Database,
  limit: number,
): Promise<DesyncRow[]> {
  const placeholders = DESYNCED_INGEST_STATUSES.map(() => '?').join(',');
  return all<DesyncRow>(
    db,
    `SELECT f.doc_id,
            f.ingest_status,
            EXISTS(
              SELECT 1 FROM transactions t
               WHERE t.doc_id = f.doc_id AND t.deprecated_at IS NULL
            ) AS has_tx,
            rq.resolution_kind,
            rq.resolution_reason,
            rq.reason AS review_reason,
            (
              SELECT d.action FROM ingestion_decisions d
               WHERE d.doc_id = f.doc_id
               ORDER BY d.created_at DESC
               LIMIT 1
            ) AS decision_action
       FROM filings f
       JOIN review_queue rq ON rq.doc_id = f.doc_id AND rq.resolved = 1
      WHERE f.ingest_status IN (${placeholders})
        AND f.doc_id NOT LIKE ?
        AND f.doc_id != ?
      LIMIT ?`,
    [...DESYNCED_INGEST_STATUSES, PROVIDER_MISSING_PREFIX, MANUAL_TEST_PROBE_DOC_ID, limit],
  );
}

function candidateFromRow(
  row: DesyncRow,
  via: DesyncCandidate['via'],
): DesyncCandidate {
  const decision = terminalStatusForResolvedReview({
    resolutionKind: row.resolution_kind,
    resolutionReason: row.resolution_reason,
    reviewReason: row.review_reason,
    decisionAction: row.decision_action,
    hasLiveTx: Number(row.has_tx) > 0,
  });
  return {
    docId: row.doc_id,
    currentStatus: row.ingest_status,
    targetStatus: decision.status,
    basis: decision.basis,
    hasLiveTx: Number(row.has_tx) > 0,
    resolutionKind: row.resolution_kind,
    decisionAction: row.decision_action,
    via,
  };
}

/**
 * Filings the resolved-queue query cannot see: ingest_status is already
 * `error` (not in DESYNCED_INGEST_STATUSES), or there is no review_queue
 * row at all. Live transactions plus a latest publish decision are enough
 * to call the filing persisted. Filings with no live transaction are not
 * selected. Rows the resolved-queue query already owns stay on that path.
 */
async function loadPublishedTruthRows(
  db: D1Database,
  limit: number,
): Promise<DesyncRow[]> {
  const desynced = DESYNCED_INGEST_STATUSES.map(() => '?').join(',');
  return await all<DesyncRow>(
    db,
    `SELECT f.doc_id,
            f.ingest_status,
            1 AS has_tx,
            NULL AS resolution_kind,
            NULL AS resolution_reason,
            NULL AS review_reason,
            (
              SELECT d.action FROM ingestion_decisions d
               WHERE d.doc_id = f.doc_id
               ORDER BY d.created_at DESC, d.id DESC
               LIMIT 1
            ) AS decision_action
       FROM filings f
      WHERE f.ingest_status IS NOT NULL
        AND f.ingest_status != 'persisted'
        AND f.doc_id NOT LIKE ?
        AND f.doc_id != ?
        AND ${alreadyPublishedPredicate('f')}
        AND NOT (
          f.ingest_status IN (${desynced})
          AND EXISTS (
            SELECT 1 FROM review_queue rq
             WHERE rq.doc_id = f.doc_id AND rq.resolved = 1
          )
        )
      ORDER BY f.doc_id
      LIMIT ?`,
    [
      PROVIDER_MISSING_PREFIX,
      MANUAL_TEST_PROBE_DOC_ID,
      ...PUBLISH_DECISION_ACTIONS,
      ...DESYNCED_INGEST_STATUSES,
      limit,
    ],
  );
}

export async function reconcileResolvedReviewStatus(
  env: Env,
  opts: { apply: boolean; limit?: number; now?: Date } = { apply: false },
): Promise<DesyncReconcileResult> {
  const limit = Math.min(Math.max(opts.limit ?? 600, 1), 2000);
  const nowIso = (opts.now ?? new Date()).toISOString();
  const rows = await loadDesyncRows(env.DB, limit);
  const publishedRows = await loadPublishedTruthRows(env.DB, limit);
  const sample: DesyncCandidate[] = [];
  let updated = 0;
  let alreadyTerminal = 0;

  const candidates = [
    ...rows.map((row) => candidateFromRow(row, 'review_queue')),
    ...publishedRows.map((row) => candidateFromRow(row, 'published_truth')),
  ];

  for (const candidate of candidates) {
    if (sample.length < 25) sample.push(candidate);
    if (candidate.currentStatus === candidate.targetStatus) {
      alreadyTerminal += 1;
      continue;
    }
    // The truth path only ever means "this filing is published".
    if (candidate.via === 'published_truth' && candidate.targetStatus !== 'persisted') {
      continue;
    }
    if (!opts.apply) continue;
    const errorNote = candidate.targetStatus === 'error'
      ? `review-status-reconcile: ${candidate.basis} as of ${nowIso}`
      : null;
    const res = candidate.via === 'published_truth'
      ? await run(
        env.DB,
        `UPDATE filings
            SET ingest_status = 'persisted',
                error = NULL
          WHERE doc_id = ?
            AND ingest_status = ?
            AND ingest_status != 'persisted'
            AND ${alreadyPublishedPredicate('filings')}`,
        [candidate.docId, candidate.currentStatus, ...PUBLISH_DECISION_ACTIONS],
      )
      : await run(
        env.DB,
        `UPDATE filings
            SET ingest_status = ?,
                error = CASE
                          WHEN ? = 'error' THEN COALESCE(error, ?)
                          WHEN ? IN ('persisted', 'verified_empty') THEN NULL
                          ELSE error
                        END
          WHERE doc_id = ?
            AND ingest_status = ?
            AND EXISTS (
              SELECT 1 FROM review_queue
               WHERE doc_id = ? AND resolved = 1
            )`,
        [
          candidate.targetStatus,
          candidate.targetStatus,
          errorNote,
          candidate.targetStatus,
          candidate.docId,
          candidate.currentStatus,
          candidate.docId,
        ],
      );
    if ((res.meta?.changes ?? 0) > 0) updated += 1;
  }

  return {
    scanned: candidates.length,
    updated: opts.apply ? updated : 0,
    alreadyTerminal,
    sample,
  };
}

export async function runFilingsHygiene(
  env: Env,
  opts: {
    apply: boolean;
    deleteProbe?: boolean;
    reconcileDesync?: boolean;
    limit?: number;
    now?: Date;
  },
): Promise<FilingsHygieneResult> {
  const deleteProbe = opts.deleteProbe !== false;
  const reconcileDesync = opts.reconcileDesync !== false;
  const probe = deleteProbe
    ? await deleteManualTestProbe(env.DB, { apply: opts.apply })
    : {
        docId: MANUAL_TEST_PROBE_DOC_ID,
        found: false,
        related: {
          filings: 0,
          reviewQueue: 0,
          transactions: 0,
          ingestionOutbox: 0,
          ingestionDecisions: 0,
          extractionRuns: 0,
          disclosureLatencyCandidates: 0,
          runtimeQueue: 0,
        },
        deleted: false,
        refusedReason: 'skipped',
      };
  const desync = reconcileDesync
    ? await reconcileResolvedReviewStatus(env, {
        apply: opts.apply,
        limit: opts.limit,
        now: opts.now,
      })
    : { scanned: 0, updated: 0, alreadyTerminal: 0, sample: [] };
  return { applied: opts.apply, probe, desync };
}
