import { describe, expect, it } from 'vitest';
import {
  isTailOnlyPeerPriceBacklog,
  stPeerPricePendingBindParams,
} from '../peerPricePending.ts';

describe('peerPricePending', () => {
  it('isTailOnlyPeerPriceBacklog when pending is small and corpus matches freshThrough', () => {
    const now = new Date('2026-10-12T18:00:00.000Z');
    const { freshThrough } = stPeerPricePendingBindParams(now);
    expect(isTailOnlyPeerPriceBacklog(2, freshThrough, now)).toBe(true);
    expect(isTailOnlyPeerPriceBacklog(6, freshThrough, now)).toBe(false);
    expect(isTailOnlyPeerPriceBacklog(2, '2020-01-01', now)).toBe(false);
  });
});
