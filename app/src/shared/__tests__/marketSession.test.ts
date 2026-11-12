import { describe, expect, it } from 'vitest';
import { marketSessionAt } from '../marketSession.ts';

describe('marketSessionAt', () => {
  it.each([
    ['2026-01-14T07:00:00.000Z', 'closed'], // 02:00 ET, before pre-market
    ['2026-01-14T13:00:00.000Z', 'pre'], // 08:00 ET
    ['2026-01-14T14:00:00.000Z', 'pre'], // 09:00 ET — still before the 09:30 open
    ['2026-01-14T14:29:59.000Z', 'pre'], // 09:29:59 ET — one second before open
    ['2026-01-14T14:30:00.000Z', 'regular'], // 09:30:00 ET exactly — open boundary
    ['2026-01-14T15:00:00.000Z', 'regular'], // 10:00 ET
    ['2026-01-14T20:59:59.000Z', 'regular'], // 15:59:59 ET — one second before close
    ['2026-01-14T21:00:00.000Z', 'post'], // 16:00:00 ET exactly — close boundary
    ['2026-01-14T22:00:00.000Z', 'post'], // 17:00 ET
    ['2026-01-15T00:59:59.000Z', 'post'], // 19:59:59 ET — one second before post-market ends
    ['2026-01-15T01:00:00.000Z', 'closed'], // 20:00:00 ET exactly
    ['2026-01-17T15:00:00.000Z', 'closed'], // Saturday, regular-session hours
    ['2026-01-18T15:00:00.000Z', 'closed'], // Sunday, regular-session hours
  ])('%s (ET wall clock) -> %s', (iso, expected) => {
    expect(marketSessionAt(iso)).toBe(expected);
  });

  it('is holiday-agnostic by design — a market holiday during regular hours still reports regular', () => {
    // 2026-01-01 is New Year's Day (market closed) but this module never
    // consults a holiday calendar; the peer's confirmed-empty bars response
    // is the actual ground truth for "did anything trade" (see
    // prices/peerMarketData.ts). 15:00Z = 10:00 ET on a Thursday.
    expect(marketSessionAt('2026-01-01T15:00:00.000Z')).toBe('regular');
  });

  it('uses real America/New_York conversion, not a fixed UTC offset (DST boundary)', () => {
    // Same UTC wall-clock instant (14:00Z) on a January weekday (EST, UTC-5)
    // vs a July weekday (EDT, UTC-4) resolves to different ET clock times and
    // therefore different sessions. A fixed-offset implementation would
    // report the same session for both and this assertion would fail.
    expect(marketSessionAt('2026-01-14T14:00:00.000Z')).toBe('pre'); // 09:00 EST
    expect(marketSessionAt('2026-07-14T14:00:00.000Z')).toBe('regular'); // 10:00 EDT
  });

  it('returns closed for an unparseable timestamp rather than throwing', () => {
    expect(marketSessionAt('not-a-date')).toBe('closed');
  });
});
