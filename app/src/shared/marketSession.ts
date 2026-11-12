/**
 * src/shared/marketSession.ts
 * OWNER: shared
 *
 * Labels a UTC instant with the US equity session it falls in, using real
 * America/New_York wall-clock conversion (not a fixed UTC offset, which would
 * be wrong for roughly half the year across the March/November DST change).
 *
 * Deliberately NOT holiday-aware: a peer's confirmed-empty intraday-bars
 * response (see src/prices/peerMarketData.ts) is the actual ground truth for
 * "did anything trade" on a given day. This label exists only so a price
 * print that crosses the 16:00 close is excluded from same-session
 * before/after comparisons instead of silently diluting them — it is never a
 * gate on whether a capture is attempted.
 */

export type MarketSession = 'pre' | 'regular' | 'post' | 'closed';

// Hoisted: constructing an Intl.DateTimeFormat is comparatively expensive and
// this can run once per due row on every capture tick. Mirrors the proven
// pattern in src/ingestion/probeSchedule.ts's etClock().
const ET_CLOCK_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  weekday: 'short',
});

const PRE_OPEN_MIN = 4 * 60; // 04:00 ET
const REGULAR_OPEN_MIN = 9 * 60 + 30; // 09:30 ET
const REGULAR_CLOSE_MIN = 16 * 60; // 16:00 ET
const POST_CLOSE_MIN = 20 * 60; // 20:00 ET

export function marketSessionAt(iso: string): MarketSession {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'closed';

  const parts = ET_CLOCK_FORMAT.formatToParts(d);
  const pick = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';

  const weekday = pick('weekday');
  if (weekday === 'Sat' || weekday === 'Sun') return 'closed';

  // hour12:false renders midnight as "24", not "00" — normalize the same way
  // etClock() does, or every midnight instant misclassifies as post/closed.
  let hour = parseInt(pick('hour'), 10);
  if (!Number.isFinite(hour) || hour === 24) hour = 0;
  let minute = parseInt(pick('minute'), 10);
  if (!Number.isFinite(minute)) minute = 0;

  const minuteOfDay = hour * 60 + minute;
  if (minuteOfDay >= PRE_OPEN_MIN && minuteOfDay < REGULAR_OPEN_MIN) return 'pre';
  if (minuteOfDay >= REGULAR_OPEN_MIN && minuteOfDay < REGULAR_CLOSE_MIN) return 'regular';
  if (minuteOfDay >= REGULAR_CLOSE_MIN && minuteOfDay < POST_CLOSE_MIN) return 'post';
  return 'closed';
}
