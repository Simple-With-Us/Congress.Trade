/**
 * Read-only identity for failed `ingestion_outbox` rows so operators can settle
 * "same count, different doc_ids" disputes from admin/health without host SSH.
 */

import { all, get } from '../shared/db.ts';

/** Max failed rows returned in admin receipts (count-only aggregates stay unbounded). */
export const FAILED_INGESTION_OUTBOX_DETAIL_LIMIT = 50;

/** Head window for fingerprint scans; tail doc_ids are hashed separately when truncated. */
export const FAILED_INGESTION_OUTBOX_FINGERPRINT_LIMIT = 500;

const FINGERPRINT_TAIL_PAGE_SIZE = 500;

export interface FailedIngestionOutboxRow {
  doc_id: string;
  chamber: string;
  available_at: string;
  updated_at: string;
  last_error: string | null;
}

export interface FailedIngestionOutboxIdentity {
  count: number;
  /** SHA-256 hex of count + sorted head doc_ids + tail digest (see {@link fingerprintFailedIngestionIdentity}). */
  fingerprint: string;
  /** Preview doc_ids (admin detail rows; ordered by available_at, not fingerprint input). */
  doc_ids: string[];
  /** True only when the fingerprint scan saw every failed row with no truncation or count drift. */
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

/**
 * Fingerprint for the full failed set: `count`, lexicographic head window, and a
 * digest of any tail doc_ids beyond the head window (so truncated scans stay distinct).
 */
export async function fingerprintFailedIngestionIdentity(
  count: number,
  headDocIds: string[],
  tailDocIds: string[] = [],
): Promise<string> {
  const sortedHead = [...headDocIds].sort();
  const tailDigest = tailDocIds.length > 0
    ? await fingerprintFailedIngestionDocIds(tailDocIds)
    : '';
  return await sha256Hex(`${count}\n${sortedHead.join('\n')}\n${tailDigest}`);
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

async function loadFingerprintHeadDocIds(
  db: D1Database,
): Promise<{ headDocIds: string[]; truncatedByScan: boolean }> {
  const scanLimit = FAILED_INGESTION_OUTBOX_FINGERPRINT_LIMIT + 1;
  const scanned = await all<{ doc_id: string }>(
    db,
    `SELECT doc_id FROM ingestion_outbox WHERE status = 'failed' ORDER BY doc_id ASC LIMIT ?`,
    [scanLimit],
  );
  const truncatedByScan = scanned.length > FAILED_INGESTION_OUTBOX_FINGERPRINT_LIMIT;
  const headDocIds = (truncatedByScan
    ? scanned.slice(0, FAILED_INGESTION_OUTBOX_FINGERPRINT_LIMIT)
    : scanned
  ).map((row) => row.doc_id);
  return { headDocIds, truncatedByScan };
}

async function loadFingerprintTailDocIds(db: D1Database): Promise<string[]> {
  const tailDocIds: string[] = [];
  let offset = FAILED_INGESTION_OUTBOX_FINGERPRINT_LIMIT;
  while (true) {
    const page = await all<{ doc_id: string }>(
      db,
      `SELECT doc_id FROM ingestion_outbox WHERE status = 'failed' ORDER BY doc_id ASC LIMIT ? OFFSET ?`,
      [FINGERPRINT_TAIL_PAGE_SIZE, offset],
    );
    if (page.length === 0) break;
    tailDocIds.push(...page.map((row) => row.doc_id));
    offset += page.length;
    if (page.length < FINGERPRINT_TAIL_PAGE_SIZE) break;
  }
  return tailDocIds;
}

export async function buildFailedIngestionOutboxIdentity(
  db: D1Database,
  failedCount?: number | null,
  limit = FAILED_INGESTION_OUTBOX_DETAIL_LIMIT,
): Promise<FailedIngestionOutboxIdentity | null> {
  if (failedCount === null) return null;

  const { headDocIds, truncatedByScan } = await loadFingerprintHeadDocIds(db);
  const tailDocIds = truncatedByScan ? await loadFingerprintTailDocIds(db) : [];

  const countRow = await get<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM ingestion_outbox WHERE status = 'failed'`,
  );
  const count = Number(countRow?.n ?? 0);

  if (count === 0) {
    return {
      count: 0,
      fingerprint: await fingerprintFailedIngestionIdentity(0, [], []),
      doc_ids: [],
      fingerprintCoversAll: true,
    };
  }

  const fingerprintCoversAll = !truncatedByScan
    && headDocIds.length === count
    && tailDocIds.length === 0;

  const rows = await loadFailedIngestionOutboxRows(db, limit);
  const previewDocIds = rows.map((row) => row.doc_id);

  return {
    count,
    fingerprint: await fingerprintFailedIngestionIdentity(count, headDocIds, tailDocIds),
    doc_ids: previewDocIds,
    fingerprintCoversAll,
  };
}
