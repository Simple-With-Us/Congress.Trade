/**
 * Auto-close open provider-missing-* review stubs when the matching official
 * filing is already persisted.  Provider latency can create a synthetic stub
 * before House/Senate discovery lands; when the real S-/H- filing later
 * publishes, the stub must reject as a duplicate — not stay pending forever
 * and not be confirmed as its own filing.
 *
 * Triggered only from routeProviderOnlyObservationsToReview when a live
 * provider observation is processed (no historic backlog sweep).
 */

import type { Env } from '../shared/types.ts';
import { batch, get } from '../shared/db.ts';
import { recordIngestionDecision } from '../shared/ingestionDecisions.ts';
import { PIPELINE_TX_SOURCES_SQL } from '../extraction/sourceSupersede.ts';
import type { DisclosureProviderRow } from './tradeLatency.ts';
import { enqueueIngestionOutboxNow, ingestionOutboxInsertForDoc } from './outbox.ts';

const REJECT_PREFIX = 'rejected: duplicate — official filing';
const SENATE_PTR_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ProviderMissingStubCloseResult {
  closed: boolean;
  stubDocId: string;
  officialDocId?: string;
  reason?: string;
}

async function officialCounterpartQuery(
  db: D1Database,
  row: DisclosureProviderRow,
  persistedOnly: boolean,
): Promise<string | null> {
  const key = row.providerKey.trim().toLowerCase();
  if (!key) return null;
  const persistedClause = persistedOnly ? `AND ingest_status = 'persisted'` : '';

  if (row.sourceUrl) {
    const byUrl = await get<{ doc_id: string }>(
      db,
      `SELECT doc_id FROM filings
         WHERE source_url = ?
           AND doc_id NOT LIKE 'provider-missing-%'
           ${persistedClause}
         LIMIT 1`,
      [row.sourceUrl],
    );
    if (byUrl?.doc_id) return byUrl.doc_id;
  }

  if (row.chamber === 'senate') {
    const senateId = `S-${key}`;
    const bySenateId = await get<{ doc_id: string }>(
      db,
      `SELECT doc_id FROM filings
         WHERE doc_id = ?
           AND doc_id NOT LIKE 'provider-missing-%'
           ${persistedClause}
         LIMIT 1`,
      [senateId],
    );
    if (bySenateId?.doc_id) return bySenateId.doc_id;
  }

  if (row.chamber === 'house') {
    const byHouseSuffix = await get<{ doc_id: string }>(
      db,
      `SELECT doc_id FROM filings
         WHERE chamber = 'house'
           AND doc_id LIKE 'H-%'
           AND doc_id NOT LIKE 'provider-missing-%'
           ${persistedClause}
           AND (doc_id = ? OR doc_id LIKE ?)
         LIMIT 1`,
      [`H-${key}`, `H-%-${key}`],
    );
    if (byHouseSuffix?.doc_id) return byHouseSuffix.doc_id;
  }

  return null;
}

async function findPersistedOfficialCounterpart(
  db: D1Database,
  row: DisclosureProviderRow,
): Promise<string | null> {
  return officialCounterpartQuery(db, row, true);
}

async function findOfficialCounterpartDocId(
  db: D1Database,
  row: DisclosureProviderRow,
): Promise<string | null> {
  return officialCounterpartQuery(db, row, false);
}

async function rejectProviderMissingStubAsDuplicate(
  env: Env,
  stubDocId: string,
  officialDocId: string,
  nowIso: string,
): Promise<boolean> {
  const review = await get<{
    doc_id: string;
    reason: string | null;
    payload: string | null;
    created_at: string;
    resolved: number;
    review_revision: number | null;
  }>(
    env.DB,
    `SELECT doc_id, reason, payload, created_at, resolved, review_revision
       FROM review_queue
      WHERE doc_id = ?
      LIMIT 1`,
    [stubDocId],
  );
  if (!review || review.resolved === 1) return false;

  const rejectionReason = `${REJECT_PREFIX} ${officialDocId} already persisted`;
  const reviewRevision = review.review_revision ?? 1;
  const rejectResults = await batch(env.DB, [
    [
      `UPDATE transactions
          SET deprecated_at = ?, deprecated_reason = ?
        WHERE doc_id = ? AND source IN (${PIPELINE_TX_SOURCES_SQL})
          AND deprecated_at IS NULL
          AND EXISTS (
            SELECT 1 FROM review_queue
             WHERE doc_id = ? AND resolved = 0 AND review_revision = ?
          )`,
      [nowIso, rejectionReason, stubDocId, stubDocId, reviewRevision],
    ],
    [
      `UPDATE filings SET ingest_status = ?
        WHERE doc_id = ? AND EXISTS (
          SELECT 1 FROM review_queue
           WHERE doc_id = ? AND resolved = 0 AND review_revision = ?
        )`,
      ['error', stubDocId, stubDocId, reviewRevision],
    ],
    [
      `UPDATE review_queue
          SET resolved = 1,
              reason = ?,
              agreement_suppressed_at = ?,
              agreement_suppression_reason = ?,
              resolution_kind = 'rejected',
              resolution_reason = ?,
              resolved_at = ?,
              review_revision = review_revision + 1
        WHERE doc_id = ? AND resolved = 0 AND review_revision = ?`,
      [
        rejectionReason,
        nowIso,
        rejectionReason,
        rejectionReason,
        nowIso,
        stubDocId,
        reviewRevision,
      ],
    ],
  ]);
  if ((rejectResults[rejectResults.length - 1]?.meta?.changes ?? 0) === 0) return false;

  try {
    await recordIngestionDecision(env.DB, {
      docId: stubDocId,
      action: 'rejected',
      source: 'pipeline',
      actor: 'pipeline:provider-missing-stub-close',
      reason: rejectionReason,
      payload: { officialDocId },
      createdAt: nowIso,
    });
  } catch (err) {
    console.error(
      'provider-missing-stub-close: audit receipt failed',
      stubDocId,
      (err as Error).message,
    );
  }
  return true;
}

/**
 * When an official filing already exists, reject any open provider-missing stub
 * for the same observation and skip creating a new one.
 */
export async function closeProviderMissingStubIfOfficialPersisted(
  env: Env,
  row: DisclosureProviderRow,
  stubDocId: string,
  nowIso: string,
): Promise<ProviderMissingStubCloseResult> {
  const officialDocId = await findPersistedOfficialCounterpart(env.DB, row);
  if (!officialDocId) {
    return { closed: false, stubDocId };
  }

  const closed = await rejectProviderMissingStubAsDuplicate(
    env,
    stubDocId,
    officialDocId,
    nowIso,
  );
  return {
    closed,
    stubDocId,
    officialDocId,
    reason: closed ? `${REJECT_PREFIX} ${officialDocId} already persisted` : undefined,
  };
}

/** Exported for unit tests — does not mutate review_queue. */
export async function findPersistedOfficialCounterpartForObservation(
  db: D1Database,
  row: DisclosureProviderRow,
): Promise<string | null> {
  return findPersistedOfficialCounterpart(db, row);
}

/** Any non-stub official row for the observation (used to skip duplicate stub creation). */
export async function findOfficialCounterpartDocIdForObservation(
  db: D1Database,
  row: DisclosureProviderRow,
): Promise<string | null> {
  return findOfficialCounterpartDocId(db, row);
}

/** Senate eFD report UUID → official `S-{uuid}` doc id, or null when the key is not a PTR id. */
export function senateOfficialDocIdFromProvider(row: DisclosureProviderRow): string | null {
  if (row.chamber !== 'senate') return null;
  const key = row.providerKey.trim().toLowerCase();
  if (!SENATE_PTR_UUID.test(key)) return null;
  return `S-${key}`;
}

export function senateOfficialSourceUrlFromProvider(row: DisclosureProviderRow): string | null {
  const docId = senateOfficialDocIdFromProvider(row);
  if (!docId) return null;
  const fromRow = (row.sourceUrl || '').trim();
  if (/efdsearch\.senate\.gov\/search\/view\/ptr\//i.test(fromRow)) {
    return fromRow.endsWith('/') ? fromRow : `${fromRow}/`;
  }
  const key = row.providerKey.trim().toLowerCase();
  return `https://efdsearch.senate.gov/search/view/ptr/${key}/`;
}

/**
 * When FMP (or another provider) already carries the official Senate PTR view
 * URL / UUID, insert `S-{uuid}` and hand it to the ingest outbox instead of
 * opening a synthetic provider-missing review stub.  The official senateHtml
 * path then publishes; a later provider pass still auto-rejects any leftover
 * stub once that filing is persisted (#2221).
 */
export async function enqueueOfficialSenateFromProviderObservation(
  env: Env,
  row: DisclosureProviderRow,
  nowIso: string,
): Promise<string | null> {
  const docId = senateOfficialDocIdFromProvider(row);
  const sourceUrl = senateOfficialSourceUrlFromProvider(row);
  if (!docId || !sourceUrl) return null;

  const existing = await findOfficialCounterpartDocId(env.DB, row);
  if (existing) return existing;

  await batch(env.DB, [
    [
      `INSERT OR IGNORE INTO filings
         (doc_id, chamber, filer_id, filing_type, filed_date, source_url,
          raw_object_key, ingest_status, doc_kind, extractor, model_version,
          confidence, first_seen_at, source_updated_at, error)
       VALUES (?, 'senate', NULL, 'P', ?, ?, NULL, 'new', 'senate_html', NULL, NULL,
               NULL, ?, NULL, NULL)`,
      [docId, row.filedDate, sourceUrl, nowIso],
    ],
    ingestionOutboxInsertForDoc(docId, nowIso),
  ]);
  try {
    await enqueueIngestionOutboxNow(env, docId);
  } catch (err) {
    console.error(
      'provider-missing official enqueue failed',
      docId,
      (err as Error).message,
    );
  }
  return (await findOfficialCounterpartDocId(env.DB, row)) ?? docId;
}
