/**
 * Terminal filing failures that never opened a review_queue row.
 *
 * Discovery through publish already retries transient fetch/extract errors
 * with bounded backoff. What remains here is the terminal class: an outbox
 * or durable-queue row that stayed `failed`, a needs_review filing with no
 * queue row, and a normalize/publish attempt that did not settle. Each one
 * gets one unresolved review_queue row. A row that already exists, including
 * a human resolution, is left alone. This module never sets resolved = 1.
 */

import type { Env } from '../shared/types.ts';
import { all, get, run } from '../shared/db.ts';
import { notifyReviewQueuePublisher } from './reviewQueueNotify.ts';
import { AUTO_TRANSIENT_DLQ_MAX_CYCLES, isTransientDlqError } from './transientDlq.ts';

const PROVIDER_MISSING_PREFIX = 'provider-missing-%';

export const PIPELINE_FAILURE_REASON = {
  download: 'pipeline_failure:download',
  extract: 'pipeline_failure:extract',
  ocr: 'pipeline_failure:ocr',
  normalize: 'pipeline_failure:normalize',
  publish: 'pipeline_failure:publish',
  deadLetter: 'pipeline_failure:dead_letter',
  dlq: 'pipeline_failure:dlq',
  extractBudget: 'pipeline_failure:extract_budget',
} as const;

export type PipelineFailureReason = typeof PIPELINE_FAILURE_REASON[keyof typeof PIPELINE_FAILURE_REASON];

export type TerminalFailureSource =
  | 'download'
  | 'extract'
  | 'ocr'
  | 'normalize'
  | 'publish'
  | 'dead_letter'
  | 'dlq';

/** Health-terminal and selector-excluded. Capped recovery must still see extract-empty rows. */
const FAILURE_REASON_LIKES = [
  "LIKE 'ingest_failure:%'",
  "LIKE 'pipeline_failure:%'",
  "LIKE '%empty_fetch_handoff%'",
] as const;

/**
 * resolveEmptyDoc must not close these as verified_empty. Extract-empty and
 * no-transactions stay selector-eligible so capped recovery can reclassify them.
 */
const AUTO_RESOLVE_REASON_LIKES = [
  ...FAILURE_REASON_LIKES,
  "LIKE '%extract_empty_failure%'",
  "LIKE '%no_transactions_extracted%'",
  "LIKE '%ocr_unusable%'",
] as const;

/** SQL: reason is not a genuine failure that must stay unresolved. */
export function genuineFailureReasonGuardSql(column: string): string {
  return FAILURE_REASON_LIKES
    .map((like) => `COALESCE(${column}, '') NOT ${like}`)
    .join('\n  AND ');
}

/** SQL: reason is a genuine failure. Pair with the guard so buckets stay disjoint. */
export function genuineFailureReasonMatchSql(column: string): string {
  return FAILURE_REASON_LIKES
    .map((like) => `COALESCE(${column}, '') ${like}`)
    .join('\n  OR ');
}

/** SQL: autopilot must not auto-resolve this reason as an empty filing. */
export function autoResolveFailureGuardSql(column: string): string {
  return AUTO_RESOLVE_REASON_LIKES
    .map((like) => `COALESCE(${column}, '') NOT ${like}`)
    .join('\n  AND ');
}

export function terminalFailureReason(
  source: TerminalFailureSource,
  message: string,
): PipelineFailureReason {
  const msg = message.toLowerCase();
  if (source !== 'publish' && /ocr|tesseract/.test(msg)) return PIPELINE_FAILURE_REASON.ocr;
  switch (source) {
    case 'download':
      return PIPELINE_FAILURE_REASON.download;
    case 'extract':
      return PIPELINE_FAILURE_REASON.extract;
    case 'ocr':
      return PIPELINE_FAILURE_REASON.ocr;
    case 'normalize':
      return PIPELINE_FAILURE_REASON.normalize;
    case 'publish':
      return PIPELINE_FAILURE_REASON.publish;
    case 'dead_letter':
      if (msg.startsWith('fetcher:') || /\bhttp\s+\d{3}\b/.test(msg) || msg.includes('download')) {
        return PIPELINE_FAILURE_REASON.download;
      }
      if (msg.includes('orchestrator:') || msg.includes('extract')) return PIPELINE_FAILURE_REASON.extract;
      if (msg.includes('classifier:')) return PIPELINE_FAILURE_REASON.normalize;
      return PIPELINE_FAILURE_REASON.deadLetter;
    case 'dlq':
      if (msg.includes('filing.new')) return PIPELINE_FAILURE_REASON.download;
      if (msg.includes('filing.fetched')) return PIPELINE_FAILURE_REASON.extract;
      if (msg.includes('local_wait')) return PIPELINE_FAILURE_REASON.ocr;
      if (msg.includes('filing.extracted')) return PIPELINE_FAILURE_REASON.extract;
      return PIPELINE_FAILURE_REASON.dlq;
    default: {
      const _never: never = source;
      return _never;
    }
  }
}

export function unsettledNormalizeReason(input: {
  needsReview: boolean;
  reviewReason?: string;
}): PipelineFailureReason {
  const reason = input.reviewReason ?? '';
  if (/ocr|tesseract/i.test(reason)) return PIPELINE_FAILURE_REASON.ocr;
  if (input.needsReview || reason) return PIPELINE_FAILURE_REASON.normalize;
  return PIPELINE_FAILURE_REASON.publish;
}

export type TerminalFailureEnqueue = 'inserted' | 'visible' | 'skipped';

interface FilingGate {
  ingest_status: string | null;
  has_review: number | null;
  live_n: number | null;
}

/**
 * Open one unresolved review row for a filing that has none. Idempotent:
 * a second call sees the row and returns `visible` without changing resolved.
 */
export async function ensureTerminalFailureReviewRow(
  env: Pick<Env, 'DB'>,
  docId: string,
  reason: PipelineFailureReason,
  errorMessage: string,
  opts: { source?: TerminalFailureSource; at?: string } = {},
): Promise<TerminalFailureEnqueue> {
  if (docId.startsWith('provider-missing-')) return 'skipped';
  const gate = await get<FilingGate>(
    env.DB,
    `SELECT f.ingest_status,
            (SELECT 1 FROM review_queue rq WHERE rq.doc_id = f.doc_id LIMIT 1) AS has_review,
            (SELECT COUNT(*) FROM transactions t
              WHERE t.doc_id = f.doc_id AND t.deprecated_at IS NULL) AS live_n
       FROM filings f
      WHERE f.doc_id = ?`,
    [docId],
  );
  if (!gate) return 'skipped';
  if (Number(gate.has_review) === 1) return 'visible';
  if (Number(gate.live_n ?? 0) > 0) return 'skipped';
  const status = gate.ingest_status ?? '';
  if (status === 'persisted' || status === 'verified_empty') return 'skipped';

  const at = opts.at ?? new Date().toISOString();
  const error = errorMessage.slice(0, 1000);
  await run(
    env.DB,
    `UPDATE filings
        SET ingest_status = 'error', error = ?
      WHERE doc_id = ?
        AND COALESCE(ingest_status, '') NOT IN ('persisted', 'verified_empty', 'error')
        AND NOT EXISTS (
          SELECT 1 FROM transactions t
           WHERE t.doc_id = filings.doc_id AND t.deprecated_at IS NULL
        )`,
    [error, docId],
  );

  const payload = JSON.stringify({
    kind: 'pipeline_failure',
    reason,
    source: opts.source ?? null,
    error,
    at,
  });
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
  return 'visible';
}

interface SweepCandidate {
  doc_id: string;
  error: string | null;
  source: TerminalFailureSource;
  msg_type: string | null;
  cycles: number | null;
}

/** Page of failed rows inspected per source. Wider than the enqueue cap so a transient backlog cannot hide a real terminal. */
const SWEEP_SCAN_LIMIT = 500;

function awaitingTransientReplay(error: string | null, cycles: number | null): boolean {
  return isTransientDlqError(error) && Number(cycles ?? 0) < AUTO_TRANSIENT_DLQ_MAX_CYCLES;
}

export interface TerminalFailureSweepResult {
  matched: number;
  enqueued: number;
  visible: number;
  skipped: number;
  byReason: Record<string, number>;
}

const NO_REVIEW_SQL = `NOT EXISTS (SELECT 1 FROM review_queue rq WHERE rq.doc_id = f.doc_id)`;
const NO_LIVE_TX_SQL = `NOT EXISTS (
  SELECT 1 FROM transactions t
   WHERE t.doc_id = f.doc_id AND t.deprecated_at IS NULL
)`;
const OPEN_FAILURE_FILING_SQL = `
  f.doc_id NOT LIKE ?
  AND COALESCE(f.ingest_status, '') NOT IN ('persisted', 'verified_empty')
  AND ${NO_REVIEW_SQL}
  AND ${NO_LIVE_TX_SQL}
`;

/**
 * Find terminal failures with no review_queue row and enqueue them.
 * Safe to rerun: INSERT OR IGNORE plus the NOT EXISTS filter make a second
 * pass a no-op. Does not resolve, delete, or reopen any review row.
 */
export async function sweepTerminalFailureReviewQueue(
  env: Pick<Env, 'DB'>,
  opts: { limit?: number } = {},
): Promise<TerminalFailureSweepResult> {
  let limit = typeof opts.limit === 'number' && opts.limit > 0 ? Math.floor(opts.limit) : 100;
  if (limit > 500) limit = 500;

  const [deadLetters, dlqRows, reviewOrphans] = await Promise.all([
    all<SweepCandidate>(
      env.DB,
      `SELECT o.doc_id AS doc_id, o.last_error AS error, 'dead_letter' AS source,
              NULL AS msg_type, o.dead_letter_cycles AS cycles
         FROM ingestion_outbox o
         JOIN filings f ON f.doc_id = o.doc_id
        WHERE o.status = 'failed'
          AND ${OPEN_FAILURE_FILING_SQL}
        ORDER BY o.updated_at ASC, o.doc_id
        LIMIT ?`,
      [PROVIDER_MISSING_PREFIX, SWEEP_SCAN_LIMIT],
    ),
    all<SweepCandidate>(
      env.DB,
      `SELECT json_extract(q.payload, '$.docId') AS doc_id,
              q.last_error AS error,
              'dlq' AS source,
              json_extract(q.payload, '$.type') AS msg_type,
              q.dead_letter_cycles AS cycles
         FROM deno_runtime_queue q
         JOIN filings f ON f.doc_id = json_extract(q.payload, '$.docId')
        WHERE q.status = 'failed'
          AND json_valid(q.payload)
          AND json_extract(q.payload, '$.type') IN (
            'filing.new', 'filing.fetched', 'filing.extracted', 'filing.local_wait_check'
          )
          AND ${OPEN_FAILURE_FILING_SQL}
        ORDER BY q.updated_at ASC, q.id
        LIMIT ?`,
      [PROVIDER_MISSING_PREFIX, SWEEP_SCAN_LIMIT],
    ),
    all<SweepCandidate>(
      env.DB,
      `SELECT f.doc_id AS doc_id, f.error AS error, 'normalize' AS source, NULL AS msg_type,
              NULL AS cycles
         FROM filings f
        WHERE f.ingest_status = 'needs_review'
          AND ${OPEN_FAILURE_FILING_SQL}
        ORDER BY f.first_seen_at ASC, f.doc_id
        LIMIT ?`,
      [PROVIDER_MISSING_PREFIX, limit],
    ),
  ]);

  const result: TerminalFailureSweepResult = {
    matched: 0,
    enqueued: 0,
    visible: 0,
    skipped: 0,
    byReason: {},
  };
  const seen = new Set<string>();
  const deferred = new Set<string>();
  const accepted = new Map<TerminalFailureSource, number>();
  for (const row of [...deadLetters, ...dlqRows, ...reviewOrphans]) {
    if (!row.doc_id || seen.has(row.doc_id) || deferred.has(row.doc_id)) continue;
    if (
      (row.source === 'dead_letter' || row.source === 'dlq')
      && awaitingTransientReplay(row.error, row.cycles)
    ) {
      deferred.add(row.doc_id);
      continue;
    }
    const soFar = accepted.get(row.source) ?? 0;
    if (soFar >= limit) continue;
    accepted.set(row.source, soFar + 1);
    seen.add(row.doc_id);
    result.matched += 1;
    const detail = [row.msg_type, row.error].filter(Boolean).join(' ')
      || `${row.source} terminal failure`;
    const reason = terminalFailureReason(row.source, detail);
    const outcome = await ensureTerminalFailureReviewRow(env, row.doc_id, reason, detail, {
      source: row.source,
    });
    if (outcome === 'inserted') {
      result.enqueued += 1;
      result.byReason[reason] = (result.byReason[reason] ?? 0) + 1;
    } else if (outcome === 'visible') {
      result.visible += 1;
    } else {
      result.skipped += 1;
    }
  }
  return result;
}
