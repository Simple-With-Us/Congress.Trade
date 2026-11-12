import { describe, expect, it } from 'vitest';
import { isoDatePrefix, tradeLearnedAt } from '../tradeLearnedAt.ts';

describe('isoDatePrefix', () => {
  it('takes the calendar day from a timestamp or date-only string', () => {
    expect(isoDatePrefix('2026-07-30T15:32:12.565Z')).toBe('2026-07-30');
    expect(isoDatePrefix('2026-08-05')).toBe('2026-08-05');
  });

  it('returns empty for missing or non-ISO values', () => {
    expect(isoDatePrefix(null)).toBe('');
    expect(isoDatePrefix('')).toBe('');
    expect(isoDatePrefix('July 30')).toBe('');
  });
});

describe('tradeLearnedAt', () => {
  it('keeps filing first-seen when it is on or after the trade date', () => {
    expect(
      tradeLearnedAt('2026-08-18T00:00:09.961Z', '2026-08-18T20:32:34.593Z', '2026-07-02'),
    ).toBe('2026-08-18T00:00:09.961Z');
  });

  it('does not invent a stamp when first-seen is missing (seed honesty)', () => {
    expect(tradeLearnedAt(null, '2026-08-11T13:06:49.836Z', '2026-08-05')).toBeNull();
    expect(tradeLearnedAt('', '2026-08-11T13:06:49.836Z', '2026-08-05')).toBeNull();
  });

  it('uses persist time when House live-search first-seen predates this trade', () => {
    // Kevin Hern H-2026-20035134 / CMCSA: discovered July 30, traded Aug 5,
    // filed Aug 10, imported Aug 11.  July 30 is the DocID listing, not this trade.
    expect(
      tradeLearnedAt(
        '2026-07-30T15:32:12.565Z',
        '2026-08-11T13:06:49.836Z',
        '2026-08-05',
      ),
    ).toBe('2026-08-11T13:06:49.836Z');
  });

  it('keeps first-seen for earlier trades in the same premature listing', () => {
    expect(
      tradeLearnedAt(
        '2026-07-30T15:32:12.565Z',
        '2026-08-11T13:06:49.836Z',
        '2026-07-16',
      ),
    ).toBe('2026-07-30T15:32:12.565Z');
  });

  it('omits the stamp when both first-seen and persist time predate the trade', () => {
    expect(
      tradeLearnedAt('2026-07-30T15:32:12.565Z', '2026-07-31T00:00:00.000Z', '2026-08-05'),
    ).toBeNull();
  });

  it('returns first-seen when there is no trade date to compare', () => {
    expect(tradeLearnedAt('2026-07-30T15:32:12.565Z', '2026-08-11T13:06:49.836Z', null)).toBe(
      '2026-07-30T15:32:12.565Z',
    );
  });
});
