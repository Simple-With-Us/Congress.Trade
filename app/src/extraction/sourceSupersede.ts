/**
 * Same-doc_id source replacement for confirm-then-chunk.
 *
 * A truncated admin confirm (source=primary) plus a later complete local_mac /
 * server_cpu extract used to sit live together: persistNormalizedPublish's
 * exact-set CAS counted every pipeline source, unpublish/reject/confirm only
 * touched primary+manual, and GET /filings/:docId did not hide deprecated
 * rows. Twin-dedupe then preferred the truncated primary.
 *
 * Vision extracts retire other pipeline sources on the same doc_id. Cross-doc
 * competitor_backfill twins are out of scope (DATACORRECTNESS-01).
 */

export const PIPELINE_TX_SOURCES_SQL = "'primary', 'manual', 'local_mac', 'server_cpu'";

export const VISION_SUPERSEDE_REASON = 'superseded_by_local_vision';

export function isVisionTxSource(source: string | null | undefined): boolean {
  return source === 'local_mac' || source === 'server_cpu';
}

/** Sources a vision publish may retire on the same doc_id. Never the incoming source. */
export function supersededPipelineSourcesSql(incoming: string | null | undefined): string | null {
  if (incoming === 'local_mac') return "'primary', 'manual', 'server_cpu'";
  if (incoming === 'server_cpu') return "'primary', 'manual', 'local_mac'";
  return null;
}

export function canSupersedeResolvedVision(opts: {
  incomingSource: string | undefined;
  incomingCount: number;
  incomingDatedCount: number;
  liveSameSource: number;
  liveOther: number;
  liveOtherDated: number;
}): boolean {
  if (!isVisionTxSource(opts.incomingSource)) return false;
  // Already-published vision rows keep their ids; leftover primary is a
  // retire-superseded-sources repair, not a second insert.
  if (opts.liveSameSource > 0) return false;
  if (opts.liveOther <= 0) return false;
  // Raw length is not a size signal.  Local vision still persists placeholder
  // dates ("N/A", "—") that increment incomingCount; comparing that would let
  // a 361-row submit with 180 ISO dates retire a 209-lot confirmed set.
  // Same invariant as storedReviewBlocksSmallerVisionSubmit (#2154).
  return opts.incomingDatedCount > opts.liveOtherDated;
}
