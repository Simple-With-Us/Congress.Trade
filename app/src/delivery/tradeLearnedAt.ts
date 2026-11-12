/**
 * Per-trade "when we learned about this trade" stamp.
 *
 * `filings.first_seen_at` is when the watcher first INSERT OR IGNOREd this
 * doc_id.  House live search can list a DocID days before the official
 * FilingDate, and before later trades that land in the same PDF.  That is
 * not "we discovered this trade."
 *
 * Live proof (2026-08-19): Kevin Hern `H-2026-20035134` has
 * first_seen_at `2026-07-30T15:32:12.565Z`, tx_date `2026-08-05`,
 * filed_date `2026-08-10`, created_at `2026-08-11T13:06:49.836Z`.
 */

/** Calendar date prefix (YYYY-MM-DD) from an ISO date or timestamp. */
export function isoDatePrefix(raw: string | null | undefined): string {
  const s = (raw ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return '';
}

/**
 * Public "discovered / seen" stamp for one trade.  No invented dates:
 * returns only a timestamp the caller already had.  Seed rows with no
 * first-seen stay null (do not fill from created_at).
 *
 * - first-seen on/after the trade date → first-seen
 * - first-seen before the trade date → persist created_at, only if that
 *   stamp is on/after the trade date
 * - otherwise null (do not claim we discovered the trade early)
 */
export function tradeLearnedAt(
  firstSeenAt: string | null | undefined,
  createdAt: string | null | undefined,
  txDate: string | null | undefined,
): string | null {
  const seen = (firstSeenAt ?? '').trim();
  if (!seen) return null;
  const tradeDay = isoDatePrefix(txDate);
  if (!tradeDay) return seen;
  if (isoDatePrefix(seen) >= tradeDay) return seen;
  const created = (createdAt ?? '').trim();
  if (created && isoDatePrefix(created) >= tradeDay) return created;
  return null;
}
