/**
 * A fetch hand-off that finishes without a raw object.
 *
 * `IngestStatus` is the only legal filings.ingest_status. A value outside
 * that union (legacy rows such as `pending`) is invisible to the review
 * queue, the desync reconcile, and the loud-alert status lists. A completed
 * ingestion_outbox row whose filing still has no raw object is the same
 * hole when the status happens to be a valid non-terminal.
 *
 * The predicate `isUngroundedIngestStatus` is the matrix rule. Sweeps and
 * the stall check both call it (or the completed-outbox sibling) rather
 * than copying the status list.
 */
import type { IngestStatus } from '../shared/types.ts';

export const VALID_INGEST_STATUSES = [
  'new',
  'fetched',
  'classified',
  'extraction_pending_local',
  'extracted',
  'persisted',
  'needs_review',
  'verified_empty',
  'error',
] as const satisfies readonly IngestStatus[];

type _AssertEveryIngestStatusListed = Exclude<
  IngestStatus,
  (typeof VALID_INGEST_STATUSES)[number]
> extends never
  ? true
  : never;
const _assertEveryIngestStatusListed: _AssertEveryIngestStatusListed = true;
void _assertEveryIngestStatusListed;

/** Valid statuses that already record a finished fetch outcome. */
export const TERMINAL_INGEST_STATUSES = [
  'persisted',
  'verified_empty',
  'error',
] as const satisfies readonly IngestStatus[];

export const EMPTY_FETCH_HANDOFF_REASON = 'empty_fetch_handoff';
/** Matches transientDlq `parked:` so the failed-row replay leaves it alone. */
export const EMPTY_FETCH_PARKED_ERROR = 'parked:empty_fetch_handoff';
/** Same budget as ingestion outbox MAX_DEAD_LETTER_CYCLES. Not a cap raise. */
export const EMPTY_FETCH_CYCLE_CAP = 5;
export const EMPTY_FETCH_REDRIVE_LIMIT = 25;
export const EMPTY_FETCH_REDRIVE_MAX_LIMIT = 100;

export interface EmptyFetchFacts {
  docId: string;
  ingestStatus: string;
  rawObjectKey: string | null;
  liveTransactionCount: number;
}

export interface CompletedEmptyRawFacts extends EmptyFetchFacts {
  outboxStatus: string | null;
}

export function isValidIngestStatus(status: string): status is IngestStatus {
  return (VALID_INGEST_STATUSES as readonly string[]).includes(status);
}

export function isBlankRawKey(key: string | null | undefined): boolean {
  return key == null || key.trim() === '';
}

/**
 * Flag a filing the pipeline cannot see.
 * Valid statuses are never flagged. A live transaction or a stored raw
 * object is never flagged. Provider-placeholder ids are never flagged.
 */
export function isUngroundedIngestStatus(row: EmptyFetchFacts): boolean {
  if (row.docId.startsWith('provider-missing-')) return false;
  if (isValidIngestStatus(row.ingestStatus)) return false;
  if (!isBlankRawKey(row.rawObjectKey)) return false;
  if (row.liveTransactionCount > 0) return false;
  return true;
}

/**
 * A completed discovery hand-off that stored nothing.
 * Terminal statuses (`error` after markError, `persisted`, `verified_empty`)
 * and `needs_review` (owned by the review queue) are not this hole.
 */
export function isCompletedEmptyRawHandoff(row: CompletedEmptyRawFacts): boolean {
  if (row.docId.startsWith('provider-missing-')) return false;
  if (row.outboxStatus !== 'completed') return false;
  if (!isBlankRawKey(row.rawObjectKey)) return false;
  if (row.liveTransactionCount > 0) return false;
  if (row.ingestStatus === 'needs_review') return false;
  if ((TERMINAL_INGEST_STATUSES as readonly string[]).includes(row.ingestStatus)) return false;
  return true;
}

/** Strictly older than the fetcher's not-yet-published window. */
export function isPastFetchNotPublishedWindow(
  firstSeenAt: string | null | undefined,
  now: Date,
  windowMs: number,
): boolean {
  const seen = firstSeenAt ? Date.parse(firstSeenAt) : NaN;
  if (!Number.isFinite(seen)) return false;
  return now.getTime() - seen > windowMs;
}

export function clampEmptyFetchLimit(raw: number | undefined): number {
  const n = Math.floor(raw ?? EMPTY_FETCH_REDRIVE_LIMIT);
  if (!Number.isFinite(n) || n < 1) return EMPTY_FETCH_REDRIVE_LIMIT;
  return Math.min(n, EMPTY_FETCH_REDRIVE_MAX_LIMIT);
}

function sqlList(values: readonly string[]): string {
  return values.map((status) => `'${status}'`).join(', ');
}

/**
 * Filings a loud alert must see: invalid ingest_status, or a completed
 * outbox whose filing is still a non-terminal with no raw object.
 * Review-resolved rows and provider placeholders are excluded.
 */
export function emptyFetchAlertWhere(filing = 'f', outbox = 'o'): string {
  return `
    ${filing}.doc_id NOT LIKE 'provider-missing-%'
    AND (${filing}.raw_object_key IS NULL OR TRIM(${filing}.raw_object_key) = '')
    AND NOT EXISTS (
      SELECT 1 FROM transactions t
       WHERE t.doc_id = ${filing}.doc_id AND t.deprecated_at IS NULL
    )
    AND NOT EXISTS (
      SELECT 1 FROM review_queue rq
       WHERE rq.doc_id = ${filing}.doc_id AND rq.resolved = 1
    )
    AND (
      ${filing}.ingest_status NOT IN (${sqlList(VALID_INGEST_STATUSES)})
      OR (
        ${outbox}.status = 'completed'
        AND ${filing}.ingest_status NOT IN (${sqlList(TERMINAL_INGEST_STATUSES)})
        AND ${filing}.ingest_status != 'needs_review'
      )
    )`;
}

export interface EmptyFetchSweepResult {
  dryRun: boolean;
  matched: number;
  rearmed: number;
  parked: number;
  docIds: string[];
}
