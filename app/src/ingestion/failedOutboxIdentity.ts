/**
 * Read-only identity for failed `ingestion_outbox` rows so operators can settle
 * "same count, different doc_ids" disputes from admin/health without host SSH.
 */

import { all, get } from '../shared/db.ts';

/** Max failed rows returned in admin receipts (count-only aggregates stay unbounded). */
export const FAILED_INGESTION_OUTBOX_DETAIL_LIMIT = 50;

/** Max doc_ids loaded into memory for SHA-256 fingerprinting (health + admin). */
export const FAILED_INGESTION_OUTBOX_FINGERPRINT_LIMIT = 500;

export interface FailedIngestionOutboxRow {
  doc_id: string;
  chamber: string;
  available_at: string;
  updated_at: string;
  last_error: string | null;
}

export interface FailedIngestionOutboxIdentity {
  count: number;
  /** SHA-256 hex of sorted doc_ids joined by `\n` (empty string when count is 0). */
  fingerprint: string;
  /** Preview doc_ids (admin detail rows; ordered by available_at, not fingerprint input). */
  doc_ids: string[];
  /** False when `count` exceeds {@link FAILED_INGESTION_OUTBOX_FINGERPRINT_LIMIT}. */
  fingerprintCoversAll: boolean;
}

export interface FormatIngestionDeadLetterIdentityOptions {
  /** When false, omit doc_id preview (public `/api/health` surfaces). */
  includeDocIdPreview?: boolean;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, '0'))
    .join('');
}

/** Deterministic fingerprint for a set of failed outbox doc_ids (order-independent). */
export async function fingerprintFailedIngestionDocIds(docIds: string[]): Promise<string> {
  if (docIds.length === 0) return await sha256Hex('');
  const sorted = [...docIds].sort();
  return await sha256Hex(sorted.join('\n'));
}

export function formatIngestionDeadLetterIdentityDetail(
  identity: FailedIngestionOutboxIdentity | null | undefined,
  options: FormatIngestionDeadLetterIdentityOptions = {},
): string {
  if (!identity || identity.count === 0) return '';
  const includeDocIdPreview = options.includeDocIdPreview ?? true;
  const shortFp = identity.fingerprint.slice(0, 12);
  const partial = identity.fingerprintCoversAll ? '' : ' partial';
  if (!includeDocIdPreview) {
    return `; identity fp=${shortFp}${partial} (all failed=${identity.count})`;
  }
  const preview = identity.doc_ids.slice(0, 8).join(', ');
  const more = identity.doc_ids.length > 8 ? ` +${identity.doc_ids.length - 8} more` : '';
  return `; identity fp=${shortFp}${partial} [${preview}${more}]`;
}

export async function loadFailedIngestionOutboxRows(
  db: D1Database,
  limit = FAILED_INGESTION_OUTBOX_DETAIL_LIMIT,
): Promise<FailedIngestionOutboxRow[]> {
  const capped = Math.max(1, Math.min(limit, FAILED_INGESTION_OUTBOX_DETAIL_LIMIT));
  return await all<FailedIngestionOutboxRow>(
    db,
    `SELECT doc_id, chamber, available_at, updated_at, last_error
       FROM ingestion_outbox
      WHERE status = 'failed'
      ORDER BY available_at ASC, doc_id ASC
      LIMIT ?`,
    [capped],
  );
}

async function loadFailedIngestionOutboxDocIdsForFingerprint(db: D1Database): Promise<string[]> {
  const rows = await all<{ doc_id: string }>(
    db,
    `SELECT doc_id FROM ingestion_outbox WHERE status = 'failed' ORDER BY doc_id ASC LIMIT ?`,
    [FAILED_INGESTION_OUTBOX_FINGERPRINT_LIMIT],
  );
  return rows.map((row) => row.doc_id);
}

export async function buildFailedIngestionOutboxIdentity(
  db: D1Database,
  failedCount?: number | null,
  limit = FAILED_INGESTION_OUTBOX_DETAIL_LIMIT,
): Promise<FailedIngestionOutboxIdentity | null> {
  let count = failedCount;
  if (count === undefined) {
    const row = await get<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM ingestion_outbox WHERE status = 'failed'`,
    );
    count = Number(row?.n ?? 0);
  }
  if (count === null) return null;
  if (count === 0) {
    return {
      count: 0,
      fingerprint: await fingerprintFailedIngestionDocIds([]),
      doc_ids: [],
      fingerprintCoversAll: true,
    };
  }
  const fingerprintDocIds = await loadFailedIngestionOutboxDocIdsForFingerprint(db);
  const rows = await loadFailedIngestionOutboxRows(db, limit);
  const previewDocIds = rows.map((row) => row.doc_id);
  return {
    count,
    fingerprint: await fingerprintFailedIngestionDocIds(fingerprintDocIds),
    doc_ids: previewDocIds,
    fingerprintCoversAll: count <= FAILED_INGESTION_OUTBOX_FINGERPRINT_LIMIT,
  };
}
