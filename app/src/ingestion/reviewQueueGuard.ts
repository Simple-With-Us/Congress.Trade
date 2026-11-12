/**
 * src/ingestion/reviewQueueGuard.ts
 * OWNER: ingestion agent
 *
 * ROOT CAUSE FIX (autonomy diagnosis 2026-08-09, finding #2): classifyFiling
 * and fetchFiling unconditionally overwrite filings.ingest_status on every
 * (re-)delivery of filing.new / filing.fetched, with no check for whether the
 * review process already closed the filing out (publish, admin reject/confirm,
 * agreement-cascade exhaustion, or provider-placeholder reconciliation all
 * flip review_queue.resolved = 1). A re-triggered message — e.g. a stray
 * outbox replay, a dead-letter reconnect, or a duplicate discovery — then
 * clobbers the terminal ingest_status back to a mid-pipeline value, making an
 * already-finished filing look stuck forever (verified in prod: a filing
 * correctly rejected via POST /api/admin/review/:docId, with ingest_status
 * stamped 'error' in the same transaction, later showed ingest_status =
 * 'classified' with no further admin action — only explainable by exactly
 * this clobber).
 *
 * This module is deliberately tiny and standalone (no dependency on
 * agreement.ts / normalizer.ts / admin/routes.ts, which own the *write* side
 * of review_queue.resolved and may be under concurrent development) so the
 * two ingestion call sites can guard themselves with a minimal, low-conflict
 * diff: one read-only EXISTS check before any ingest_status write.
 */

import { get } from '../shared/db.ts';

/**
 * True when the review process has already closed this doc_id out
 * (review_queue.resolved = 1 for at least one row). Fails OPEN (returns
 * false) on a query error — a guard that could never be satisfied would
 * silently wedge every fetch/classify call, which is worse than the rare
 * clobber this guard exists to prevent.
 */
export async function isReviewResolved(db: D1Database, docId: string): Promise<boolean> {
  try {
    const row = await get<{ n: number }>(
      db,
      `SELECT 1 AS n FROM review_queue WHERE doc_id = ? AND resolved = 1 LIMIT 1`,
      [docId],
    );
    return row != null;
  } catch (err) {
    console.warn(`reviewQueueGuard: resolved-check failed for ${docId}; failing open:`, (err as Error).message);
    return false;
  }
}
