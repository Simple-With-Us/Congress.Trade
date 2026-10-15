import { describe, expect, it } from 'vitest';
import {
  isTailOnlyPeerPriceBacklog,
  stPeerPricePendingBindParams,
  stPeerPricePendingBindsForSubqueries,
} from '../peerPricePending.ts';

describe('peerPricePending', () => {
  it('isTailOnlyPeerPriceBacklog when pending is small, all never-priced, corpus matches freshThrough', () => {
    const now = new Date('2026-10-12T18:00:00.000Z');
    const { freshThrough } = stPeerPricePendingBindParams(now);
    expect(isTailOnlyPeerPriceBacklog(2, 2, freshThrough, now)).toBe(true);
    expect(isTailOnlyPeerPriceBacklog(6, 6, freshThrough, now)).toBe(false);
    expect(isTailOnlyPeerPriceBacklog(2, 2, '2020-01-01', now)).toBe(false);
    expect(isTailOnlyPeerPriceBacklog(3, 2, freshThrough, now)).toBe(false);
  });

  it('stPeerPricePendingBindsForSubqueries repeats triplets per subquery', () => {
    const params = stPeerPricePendingBindParams(new Date('2026-10-12T18:00:00.000Z'));
    expect(stPeerPricePendingBindsForSubqueries(params, 2)).toHaveLength(6);
    expect(stPeerPricePendingBindsForSubqueries(params, 3)).toHaveLength(9);
  });
});
