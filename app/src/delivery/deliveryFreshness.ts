/**
 * Delivery freshness: distinguish live disclosures from historical backfill rows
 * so webhook/SSE/RSS/APNs do not treat years-old trades as breaking news.
 */

import { isoDatePrefix, tradeLearnedAt } from './tradeLearnedAt.ts';
import type { Transaction } from '../shared/types.ts';

/** Default subscription + RSS window: filed or first-seen within this many days. */
export const DELIVERY_FRESH_WINDOW_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

type FreshnessInput = Pick<Transaction, 'filedDate' | 'firstSeenAt' | 'createdAt' | 'txDate'>;

function parseInstantMs(raw: string | null | undefined): number | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * When we treat a trade as "new" for delivery: prefer the learned first-seen
 * stamp, then the official filed date (end of that UTC day), then persist time.
 */
export function deliveryFreshnessAnchorMs(tx: FreshnessInput): number | null {
  const seenMs = parseInstantMs(tradeLearnedAt(tx.firstSeenAt, tx.createdAt, tx.txDate));
  if (seenMs != null) return seenMs;
  const filed = isoDatePrefix(tx.filedDate);
  if (filed) {
    const filedMs = Date.parse(`${filed}T23:59:59.999Z`);
    if (Number.isFinite(filedMs)) return filedMs;
  }
  return parseInstantMs(tx.createdAt);
}

function isStaleCalendarDay(day: string | null | undefined, nowMs: number): boolean {
  const filed = isoDatePrefix(day);
  if (!filed) return false;
  const filedMs = Date.parse(`${filed}T23:59:59.999Z`);
  if (!Number.isFinite(filedMs)) return false;
  return nowMs - filedMs > DELIVERY_FRESH_WINDOW_DAYS * MS_PER_DAY;
}

/** True when the trade is older than the fresh window (or has no anchor). */
export function isDeliveryBackfill(tx: FreshnessInput, nowMs = Date.now()): boolean {
  // Late-discovered rows still carry an old official filing date — treat as backfill.
  if (isStaleCalendarDay(tx.filedDate, nowMs) || isStaleCalendarDay(tx.txDate, nowMs)) {
    return true;
  }
  const anchor = deliveryFreshnessAnchorMs(tx);
  if (anchor == null) return true;
  return nowMs - anchor > DELIVERY_FRESH_WINDOW_DAYS * MS_PER_DAY;
}

export function stampDeliveryFreshness<T extends Transaction>(tx: T): T & { isBackfill: boolean } {
  return { ...tx, isBackfill: isDeliveryBackfill(tx) };
}
