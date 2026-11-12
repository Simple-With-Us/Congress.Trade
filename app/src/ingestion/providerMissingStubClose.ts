/**
 * Auto-close open provider-missing-* review stubs when the matching official
 * filing is already persisted.  Provider latency can create a synthetic stub
 * before House/Senate discovery lands; when the real S-/H- filing later
 * publishes, the stub must reject as a duplicate — not stay pending forever
 * and not be confirmed as its own filing.
 *
 * Triggered from routeProviderOnlyObservationsToReview when a live provider
 * observation is processed, and from the hourly autonomy sweep
 * (reconcileProviderMissingStubsWithOfficial) so an official filing that lands
 * after the provider row has aged out of the feed still closes the stub.  This
 * also overrides a stub the hourly provider-only sweep closed as verified_empty
 * before the official filing landed, so the later official counterpart still
 * wins the classification.
 */

import type { Env } from '../shared/types.ts';
import { all, batch, get, type SqlParam } from '../shared/db.ts';
import { recordIngestionDecision } from '../shared/ingestionDecisions.ts';
import { PIPELINE_TX_SOURCES_SQL } from '../extraction/sourceSupersede.ts';
import type { DisclosureProviderRow } from './tradeLatency.ts';
import { enqueueIngestionOutboxNow, ingestionOutboxInsertForDoc } from './outbox.ts';

/**
 * Prefix of the review_queue reason / resolution_reason stamped when a
 * provider-missing stub is rejected as a duplicate of its official filing.
 * Exported so admin diagnostics can recognise that closed stub (whose
 * filings.error still holds the provider-only raw-key marker) as not an error.
 */
export const PROVIDER_STUB_DUPLICATE_REJECT_PREFIX = 'rejected: duplicate — official filing';
const REJECT_PREFIX = PROVIDER_STUB_DUPLICATE_REJECT_PREFIX;

/**
 * resolution_reason the hourly provider-only sweep (autonomySweeps.ts
 * sweepProviderOnlyReviewStubs) and the deploy-time migration stamp on a stub
 * they close as verified_empty.  That close is a placeholder verdict made only
 * because no official filing existed yet, so a later official counterpart may
 * still override it with the duplicate rejection below.
 */
export const PROVIDER_ONLY_LEAD_CLEARED_REASON = 'provider_only_lead_cleared';

/** review_queue predicate: open, or closed only by the provider-only sweep. */
const REVIEW_REJECTABLE_SQL = `(resolved = 0 OR (
               resolved = 1
               AND resolution_kind = 'verified_empty'
               AND resolution_reason = '${PROVIDER_ONLY_LEAD_CLEARED_REASON}'
             ))`;
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

  // Provider rows matched to an official filing by the latency matcher.  This
  // is the only link for Unusual Whales / Quiver rows without an official URL,
  // whose provider_key is a synthetic hash that never equals an S-/H- doc id
  // (mirrors the trade_latency_candidates check in
  // tradeLatency.ts routeProviderOnlyObservationsToReview).
  const rawKey = row.providerKey.trim();
  if (row.provider && rawKey) {
    const byCandidate = await get<{ doc_id: string }>(
      db,
      `SELECT f.doc_id FROM trade_latency_candidates tlc
         JOIN filings f ON f.doc_id = tlc.doc_id
        WHERE tlc.provider = ?
          AND tlc.provider_key = ?
          AND tlc.status = 'matched'
          AND f.doc_id NOT LIKE 'provider-missing-%'
          ${persistedClause}
        LIMIT 1`,
      [row.provider, rawKey],
    );
    if (byCandidate?.doc_id) return byCandidate.doc_id;
  }

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
    resolution_kind: string | null;
    resolution_reason: string | null;
    review_revision: number | null;
  }>(
    env.DB,
    `SELECT doc_id, reason, payload, created_at, resolved, resolution_kind,
            resolution_reason, review_revision
       FROM review_queue
      WHERE doc_id = ?
      LIMIT 1`,
    [stubDocId],
  );
  if (!review) return false;
  // A stub the hourly provider-only sweep already closed as verified_empty is
  // still reclassified here: that verdict only meant "no official filing yet",
  // and the official counterpart now exists.  Any other resolution (a human
  // decision, or an earlier duplicate rejection) is final.
  const sweptAsProviderOnly = review.resolved === 1
    && review.resolution_kind === 'verified_empty'
    && review.resolution_reason === PROVIDER_ONLY_LEAD_CLEARED_REASON;
  if (review.resolved === 1 && !sweptAsProviderOnly) return false;

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
             WHERE doc_id = ? AND ${REVIEW_REJECTABLE_SQL} AND review_revision = ?
          )`,
      [nowIso, rejectionReason, stubDocId, stubDocId, reviewRevision],
    ],
    [
      `UPDATE filings SET ingest_status = ?
        WHERE doc_id = ? AND EXISTS (
          SELECT 1 FROM review_queue
           WHERE doc_id = ? AND ${REVIEW_REJECTABLE_SQL} AND review_revision = ?
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
        WHERE doc_id = ? AND ${REVIEW_REJECTABLE_SQL} AND review_revision = ?`,
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

export interface ProviderMissingStubReconcileResult {
  scanned: number;
  rejected: number;
}

interface StubReconcileCandidate {
  doc_id: string;
  payload: string | null;
  /** Keyset cursor columns: selected for pagination, not used per stub. */
  created_at: string;
  stub_rowid: number;
  chamber: string | null;
  source_url: string | null;
  filed_date: string | null;
  /** Stub filing's error column: `provider-only:{provider}:{raw providerKey}`. */
  error: string | null;
}

const STUB_DOC_PREFIX = 'provider-missing-';
const PROVIDER_ONLY_ERROR_PREFIX = 'provider-only:';

/** Parse the `provider-only:{provider}:{providerKey}` marker the stub insert writes to filings.error. */
function providerMarkerFromStubError(error: string | null): { provider: string | null; providerKey: string | null } {
  const value = (error || '').trim();
  if (!value.startsWith(PROVIDER_ONLY_ERROR_PREFIX)) return { provider: null, providerKey: null };
  const rest = value.slice(PROVIDER_ONLY_ERROR_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) return { provider: null, providerKey: null };
  const provider = rest.slice(0, sep).trim() || null;
  const providerKey = rest.slice(sep + 1).trim() || null;
  return { provider, providerKey };
}

/** Rebuild the provider observation a stub was created from (payload first, doc_id fallback). */
function observationFromStub(stub: StubReconcileCandidate): DisclosureProviderRow | null {
  const chamber = stub.chamber === 'house' || stub.chamber === 'senate' ? stub.chamber : null;
  if (!chamber) return null;
  let parsed: Record<string, unknown> = {};
  try {
    const value = JSON.parse(stub.payload || '{}');
    if (value && typeof value === 'object') parsed = value as Record<string, unknown>;
  } catch {
    // Payload is sliced to PAYLOAD_LIMIT on insert and can be truncated JSON.
  }
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
  // providerOnlyDocId: provider-missing-{provider}-{chamber}-{sanitized key}.
  // Provider ids never contain '-', so the first -{chamber}- splits it.
  const rest = stub.doc_id.startsWith(STUB_DOC_PREFIX) ? stub.doc_id.slice(STUB_DOC_PREFIX.length) : '';
  const marker = `-${chamber}-`;
  const at = rest.indexOf(marker);
  const fromError = providerMarkerFromStubError(stub.error);
  // Raw key order: payload (can be truncated JSON), then the untruncated
  // filings.error marker, then the sanitized doc_id suffix (last resort; it can
  // differ from the raw key, so the candidate lookup may miss on it).
  const providerKey = str(parsed.providerKey)
    ?? fromError.providerKey
    ?? (at > 0 ? str(rest.slice(at + marker.length)) : null);
  if (!providerKey) return null;
  const provider = str(parsed.provider)
    ?? fromError.provider
    ?? (at > 0 ? str(rest.slice(0, at)) : null)
    ?? 'fmp';
  return {
    provider: provider as DisclosureProviderRow['provider'],
    chamber,
    providerKey,
    tradeHash: '',
    payload: {},
    sourceUrl: str(parsed.sourceUrl) ?? str(stub.source_url),
    filedDate: str(parsed.filedDate) ?? str(stub.filed_date),
    filerName: str(parsed.filerName),
    providerPublishedAt: str(parsed.providerPublishedAt),
  };
}

/**
 * Hourly reconcile from the official side.  closeProviderMissingStubIfOfficialPersisted
 * otherwise only runs when the provider feed re-serves the same observation, so an
 * official filing that persists after the provider row has aged out of the feed
 * would leave the stub open (or swept to verified_empty) forever.  This checks
 * recent open or sweep-closed stubs against persisted official filings,
 * independent of the current provider response, and applies the same duplicate
 * rejection.  Bounded by age and row count; idempotent.
 *
 * Rotation: a plain newest-first LIMIT would re-scan the same newest rows every
 * hour and never reach older eligible stubs.  Eligible stubs are split into
 * buckets by rowid (stable per row), sized so each bucket is about half the row
 * limit, and each run scans the bucket for the current hour.  rowid % N only
 * bounds the *average* bucket size — the queue also holds non-stub rows, so the
 * stub rowids are uneven and one bucket can hold more than `limit` eligible
 * stubs — so each run pages through its whole bucket with a keyset cursor on
 * (created_at, rowid) instead of taking a single newest-first page.  Every
 * eligible stub is therefore checked at least once every `buckets` hours, and
 * an oversized bucket is drained over its visit instead of starving its oldest
 * rows.
 */
export async function reconcileProviderMissingStubsWithOfficial(
  env: Env,
  opts: { now?: Date; limit?: number; maxAgeDays?: number } = {},
): Promise<ProviderMissingStubReconcileResult> {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const limit = Math.max(1, opts.limit ?? 500);
  const maxAgeDays = opts.maxAgeDays ?? 120;
  const cutoffIso = new Date(now.getTime() - maxAgeDays * 86_400_000).toISOString();
  const eligibleSql = `rq.reason = 'provider_discovered_missing_official'
        AND rq.doc_id LIKE '${STUB_DOC_PREFIX}%'
        AND rq.created_at >= ?
        AND (rq.resolved = 0 OR (
              rq.resolved = 1
              AND rq.resolution_kind = 'verified_empty'
              AND rq.resolution_reason = ?
            ))`;
  const eligible = await get<{ n: number }>(
    env.DB,
    `SELECT COUNT(*) AS n FROM review_queue rq WHERE ${eligibleSql}`,
    [cutoffIso, PROVIDER_ONLY_LEAD_CLEARED_REASON],
  );
  const total = Number(eligible?.n ?? 0);
  if (total === 0) return { scanned: 0, rejected: 0 };
  const bucketTarget = Math.max(1, Math.floor(limit / 2));
  const buckets = Math.max(1, Math.ceil(total / bucketTarget));
  const bucket = Math.floor(now.getTime() / 3_600_000) % buckets;
  // Page through the whole current bucket with a keyset cursor on
  // (created_at, rowid).  A single newest-first page would re-scan the same
  // newest rows on every visit, so the oldest stubs in a bucket that holds
  // more than `limit` eligible rows would never be reached.
  const stubs: StubReconcileCandidate[] = [];
  let cursorCreatedAt: string | null = null;
  let cursorRowid = 0;
  for (;;) {
    const keysetSql = cursorCreatedAt === null
      ? ''
      : 'AND (rq.created_at < ? OR (rq.created_at = ? AND rq.rowid < ?))';
    const params: SqlParam[] = [cutoffIso, PROVIDER_ONLY_LEAD_CLEARED_REASON, buckets, bucket];
    if (cursorCreatedAt !== null) {
      params.push(cursorCreatedAt, cursorCreatedAt, cursorRowid);
    }
    params.push(limit);
    const page = await all<StubReconcileCandidate>(
      env.DB,
      `SELECT rq.doc_id, rq.payload, rq.created_at, rq.rowid AS stub_rowid,
              f.chamber, f.source_url, f.filed_date, f.error
         FROM review_queue rq
         LEFT JOIN filings f ON f.doc_id = rq.doc_id
        WHERE ${eligibleSql}
          AND (rq.rowid % ?) = ?
          ${keysetSql}
        ORDER BY rq.created_at DESC, rq.rowid DESC
        LIMIT ?`,
      params,
    );
    if (page.length === 0) break;
    stubs.push(...page);
    if (page.length < limit) break;
    const last = page[page.length - 1];
    cursorCreatedAt = last.created_at;
    cursorRowid = last.stub_rowid;
  }
  let rejected = 0;
  for (const stub of stubs) {
    const row = observationFromStub(stub);
    if (!row) continue;
    const result = await closeProviderMissingStubIfOfficialPersisted(env, row, stub.doc_id, nowIso);
    if (result.closed) rejected += 1;
  }
  return { scanned: stubs.length, rejected };
}
