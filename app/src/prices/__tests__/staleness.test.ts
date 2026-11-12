import { describe, expect, it } from 'vitest';
import {
  currentPriceFreshThrough,
  evaluateCurrentPriceStaleness,
  isCurrentPriceFresh,
} from '../staleness.ts';

describe('evaluateCurrentPriceStaleness', () => {
  const tue = new Date('2026-07-14T16:00:00Z'); // Tue ET → freshThrough 2026-07-13

  it('marks a price on freshThrough as not stale', () => {
    const freshThrough = currentPriceFreshThrough(tue);
    expect(freshThrough).toBe('2026-07-13');
    expect(evaluateCurrentPriceStaleness('2026-07-13', tue)).toEqual({
      stale: false,
      freshThrough,
      dataAgeDays: 0,
    });
  });

  it('marks an older bar stale with calendar age', () => {
    const s = evaluateCurrentPriceStaleness('2026-07-06', tue);
    expect(s.stale).toBe(true);
    expect(s.dataAgeDays).toBe(7);
  });

  it('treats missing dates as stale', () => {
    expect(evaluateCurrentPriceStaleness(null, tue).stale).toBe(true);
  });

  it('isCurrentPriceFresh matches the same rule', () => {
    expect(isCurrentPriceFresh('2026-07-13', '2026-07-13')).toBe(true);
    expect(isCurrentPriceFresh('2026-07-12', '2026-07-13')).toBe(false);
  });
});
