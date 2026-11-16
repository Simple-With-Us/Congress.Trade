/**
 * A fetch hand-off that finishes without a raw object.
 *
 * `IngestStatus` is the only legal filings.ingest_status. A value outside
 * that union (legacy rows such as `pending`, and a NULL status) is invisible
 * to the review queue, the desync reconcile, and the loud-alert status lists.
 * A completed ingestion_outbox row whose filing still has no raw object is
 * the same hole when the status happens to be a valid non-terminal.
 *
 * Statuses that already have a watcher upgrade path (`not_found`, `failed`,
 * `provider_seeded`) are not this hole. Re-driving them clears the extractor
 * and the status that upgrade matches on.
 *
 * The predicate `isUngroundedIngestStatus` is the matrix rule. Sweeps and
 * the stall check both call it (or the completed-outbox sibling) rather
 * than copying the status list.
 */
import { FETCH_NOT_PUBLISHED_WINDOW_MS } from './fetcher.ts';
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

/**
 * Production statuses outside IngestStatus that carry their own upgrade path
 * (watcher.ts). The empty-fetch sweep must not re-drive them.
 */
export const OPERATIONAL_INGEST_STATUSES = [
  'not_found',
  'failed',
  'provider_seeded',
] as const;

/** Statuses a completed empty hand-off must leave alone. */
export const COMPLETED_EMPTY_EXCLUDED_STATUSES = [
  ...TERMINAL_INGEST_STATUSES,
  'needs_review',
  ...OPERATIONAL_INGEST_STATUSES,
] as const;

export const EMPTY_FETCH_HANDOFF_REASON = 'empty_fetch_handoff';
/** Matches transientDlq `parked:` so the failed-row replay leaves it alone. */
export const EMPTY_FETCH_PARKED_ERROR = 'parked:empty_fetch_handoff';
/** Same budget as ingestion outbox MAX_DEAD_LETTER_CYCLES. Not a cap raise. */
export const EMPTY_FETCH_CYCLE_CAP = 5;
export const EMPTY_FETCH_REDRIVE_LIMIT = 25;
export const EMPTY_FETCH_REDRIVE_MAX_LIMIT = 100;

const FILING_ALIASES = new Set(['f', 'filing']);
const OUTBOX_ALIASES = new Set(['o', 'outbox']);
const STATUS_LITERAL = /^[a-z0-9_]+$/i;

export interface EmptyFetchFacts {
  docId: string;
  ingestStatus: string | null;
  rawObjectKey: string | null;
  liveTransactionCount: number;
}

export interface CompletedEmptyRawFacts extends EmptyFetchFacts {
  outboxStatus: string | null;
}

export function isValidIngestStatus(status: string | null | undefined): status is IngestStatus {
  return status != null && (VALID_INGEST_STATUSES as readonly string[]).includes(status);
}

export function isOperationalIngestStatus(status: string | null | undefined): boolean {
  return status != null && (OPERATIONAL_INGEST_STATUSES as readonly string[]).includes(status);
}

export function isBlankRawKey(key: string | null | undefined): boolean {
  return key == null || key.trim() === '';
}

/**
 * Flag a filing the pipeline cannot see.
 * Valid statuses are never flagged. Operational upgrade statuses are never
 * flagged. A live transaction or a stored raw object is never flagged.
 * Provider-placeholder ids are never flagged. NULL ingest_status is flagged
 * when nothing was stored.
 */
export function isUngroundedIngestStatus(row: EmptyFetchFacts): boolean {
  if (row.docId.startsWith('provider-missing-')) return false;
  if (isValidIngestStatus(row.ingestStatus)) return false;
  if (isOperationalIngestStatus(row.ingestStatus)) return false;
  if (!isBlankRawKey(row.rawObjectKey)) return false;
  if (row.liveTransactionCount > 0) return false;
  return true;
}

/**
 * A completed discovery hand-off that stored nothing.
 * Terminal statuses, `needs_review`, and the operational upgrade statuses
 * are not this hole. NULL ingest_status is.
 */
export function isCompletedEmptyRawHandoff(row: CompletedEmptyRawFacts): boolean {
  if (row.docId.startsWith('provider-missing-')) return false;
  if (row.outboxStatus !== 'completed') return false;
  if (!isBlankRawKey(row.rawObjectKey)) return false;
  if (row.liveTransactionCount > 0) return false;
  if (row.ingestStatus != null &&
    (COMPLETED_EMPTY_EXCLUDED_STATUSES as readonly string[]).includes(row.ingestStatus)) {
    return false;
  }
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

/** Cutoff the sweep and the alert both use. Rows seen after this are still inside the window. */
export function emptyFetchSeenCutoff(now: Date): string {
  return new Date(now.getTime() - FETCH_NOT_PUBLISHED_WINDOW_MS).toISOString();
}

export function clampEmptyFetchLimit(raw: number | undefined): number {
  const n = Math.floor(raw ?? EMPTY_FETCH_REDRIVE_LIMIT);
  if (!Number.isFinite(n) || n < 1) return EMPTY_FETCH_REDRIVE_LIMIT;
  return Math.min(n, EMPTY_FETCH_REDRIVE_MAX_LIMIT);
}

function sqlList(values: readonly string[]): string {
  return values.map((status) => {
    if (!STATUS_LITERAL.test(status)) {
      throw new Error('empty fetch status literal is not in the allow-list');
    }
    return `'${status}'`;
  }).join(', ');
}

function filingColumn(filing: string): string {
  if (!FILING_ALIASES.has(filing)) {
    throw new Error('emptyFetchAlertWhere received an unsupported filing alias');
  }
  return `${filing}.ingest_status`;
}

/** NULL-inclusive. Valid union members and operational upgrade statuses are excluded. */
export function ungroundedIngestStatusSql(filing: string): string {
  const col = filingColumn(filing);
  return `(${col} IS NULL OR (${col} NOT IN (${sqlList(VALID_INGEST_STATUSES)}) AND ${col} NOT IN (${sqlList(OPERATIONAL_INGEST_STATUSES)})))`;
}

/** NULL-inclusive. Terminal, needs_review, and operational statuses are excluded. */
export function completedEmptyIngestStatusSql(filing: string): string {
  const col = filingColumn(filing);
  return `(${col} IS NULL OR ${col} NOT IN (${sqlList(COMPLETED_EMPTY_EXCLUDED_STATUSES)}))`;
}

/**
 * Filings a loud alert must see: invalid or NULL ingest_status, or a
 * completed outbox whose filing is still a non-terminal with no raw object.
 * Operational upgrade statuses, review-resolved rows, provider placeholders,
 * unseeded rows, and rows still inside the 7-day window are excluded.
 *
 * The single bound parameter is the first_seen cutoff (`emptyFetchSeenCutoff`).
 * `filing` and `outbox` are allow-listed aliases, never caller SQL.
 */
export function emptyFetchAlertWhere(filing = 'f', outbox = 'o'): string {
  if (!FILING_ALIASES.has(filing)) {
    throw new Error('emptyFetchAlertWhere received an unsupported filing alias');
  }
  if (!OUTBOX_ALIASES.has(outbox)) {
    throw new Error('emptyFetchAlertWhere received an unsupported outbox alias');
  }
  return `
    ${filing}.doc_id NOT LIKE 'provider-missing-%'
    AND (${filing}.raw_object_key IS NULL OR TRIM(${filing}.raw_object_key) = '')
    AND ${filing}.first_seen_at IS NOT NULL
    AND ${filing}.first_seen_at < ?
    AND NOT EXISTS (
      SELECT 1 FROM transactions t
       WHERE t.doc_id = ${filing}.doc_id AND t.deprecated_at IS NULL
    )
    AND NOT EXISTS (
      SELECT 1 FROM review_queue rq
       WHERE rq.doc_id = ${filing}.doc_id AND rq.resolved = 1
    )
    AND (
      ${ungroundedIngestStatusSql(filing)}
      OR (
        ${outbox}.status = 'completed'
        AND ${completedEmptyIngestStatusSql(filing)}
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
