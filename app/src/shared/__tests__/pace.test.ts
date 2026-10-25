import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  clampStPeerMaxPerMinute,
  createPacer,
  getSharedStPeerPacer,
  ST_PEER_PACE_SECRET_NAMES,
  ST_PEER_SAFE_MAX_PER_MINUTE,
  stPeerMaxPerMinute,
  __resetSharedStPeerPacerForTests,
  getSharedEdgarPacer,
  __resetSharedEdgarPacerForTests,
} from '../pace.ts';

describe('createPacer', () => {
  it('is a no-op when no cap is given (never sleeps)', async () => {
    for (const cap of [undefined, 0, -10]) {
      const pace = createPacer(cap as number | undefined);
      const t0 = Date.now();
      for (let i = 0; i < 5; i++) await pace();
      expect(Date.now() - t0).toBeLessThan(50);
    }
  });

  it('first call is immediate; subsequent calls are spaced by ~60000/maxPerMinute ms', async () => {
    const pace = createPacer(600); // 100ms min gap
    const t0 = Date.now();
    await pace(); // immediate
    expect(Date.now() - t0).toBeLessThan(50);
    await pace(); // waits ~100ms
    expect(Date.now() - t0).toBeGreaterThanOrEqual(90);
  });

  it('staggers callers that enter concurrently instead of firing them together', async () => {
    // Two consumers awaiting the gate in the same tick (e.g. house+senate via
    // Promise.all) must each claim a distinct slot, not both read one stale
    // timestamp and fire at ~0ms apart.
    const pace = createPacer(600); // 100ms min gap
    const t0 = Date.now();
    const done: number[] = [];
    await Promise.all([
      pace().then(() => done.push(Date.now() - t0)),
      pace().then(() => done.push(Date.now() - t0)),
    ]);
    done.sort((a, b) => a - b);
    expect(done[0]).toBeLessThan(50); // first slot immediate
    expect(done[1]).toBeGreaterThanOrEqual(90); // second slot ~100ms later
  });
});

describe('getSharedStPeerPacer', () => {
  beforeEach(() => __resetSharedStPeerPacerForTests());

  it('returns the SAME instance across calls with the same maxPerMinute', () => {
    const a = getSharedStPeerPacer(80);
    const b = getSharedStPeerPacer(80);
    expect(a).toBe(b);
  });

  it('is a shared gate: two "consumers" drawing from it are spaced together', async () => {
    vi.useFakeTimers();
    try {
      const enrichmentPace = getSharedStPeerPacer(100); // 600ms min gap
      const pricesPace = getSharedStPeerPacer(100); // same instance
      let second = false;
      await enrichmentPace(); // immediate
      const p = pricesPace().then(() => { second = true; });
      await vi.advanceTimersByTimeAsync(500);
      expect(second).toBe(false); // still waiting on the shared clock
      await vi.advanceTimersByTimeAsync(200);
      await p;
      expect(second).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps ONE clock across caps, so a slower consumer cannot open a second gate (Kody #2859)', async () => {
    vi.useFakeTimers();
    try {
      const catchUp = getSharedStPeerPacer(60); // 1000ms gap
      const enrichment = getSharedStPeerPacer(100); // 600ms gap, same clock
      expect(catchUp).not.toBe(enrichment);
      let done = false;
      await catchUp(); // immediate, reserves the next slot 1000ms out
      const p = enrichment().then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(900);
      expect(done).toBe(false); // waits on the catch-up's reservation
      await vi.advanceTimersByTimeAsync(150);
      await p;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clamps to the ST peerRead-safe ceiling, and paces at it when unset (CT-2445)', () => {
    expect(clampStPeerMaxPerMinute(285)).toBe(ST_PEER_SAFE_MAX_PER_MINUTE);
    expect(clampStPeerMaxPerMinute(undefined)).toBe(ST_PEER_SAFE_MAX_PER_MINUTE);
    expect(clampStPeerMaxPerMinute(0)).toBe(ST_PEER_SAFE_MAX_PER_MINUTE);
    expect(clampStPeerMaxPerMinute(60)).toBe(60);
    // 285, 100 and unset all map to one cap, so they share one pacer instance.
    const a = getSharedStPeerPacer(285);
    expect(getSharedStPeerPacer(undefined)).toBe(a);
    expect(getSharedStPeerPacer(100)).toBe(a);
  });
});

describe('stPeerMaxPerMinute', () => {
  it('reads only ST_PEER_MAX_PER_MINUTE', () => {
    expect(stPeerMaxPerMinute({ ST_PEER_MAX_PER_MINUTE: '90' })).toBe(90);
    expect(stPeerMaxPerMinute({ ST_PEER_MAX_PER_MINUTE: 'x' })).toBeUndefined();
    expect(stPeerMaxPerMinute({ ST_PEER_MAX_PER_MINUTE: '0' })).toBeUndefined();
    expect(stPeerMaxPerMinute({})).toBeUndefined();
    expect(ST_PEER_PACE_SECRET_NAMES).toEqual(['ST_PEER_MAX_PER_MINUTE']);
  });
});

describe('getSharedEdgarPacer', () => {
  beforeEach(() => __resetSharedEdgarPacerForTests());

  it('returns the SAME instance across calls with the same maxPerMinute', () => {
    const a = getSharedEdgarPacer(300);
    const b = getSharedEdgarPacer(300);
    expect(a).toBe(b);
  });

  it('paces calls independently of the ST peer pacer (separate budget/clock)', async () => {
    __resetSharedStPeerPacerForTests();
    const edgarPace = getSharedEdgarPacer(600); // 100ms min gap
    const fmpPace = getSharedStPeerPacer(100); // its own clock (600ms gap)
    const t0 = Date.now();
    await edgarPace(); // immediate
    await new Promise((r) => setTimeout(r, 30));
    await fmpPace(); // immediate too — its own clock hasn't been touched yet
    expect(Date.now() - t0).toBeLessThan(150);
  });

  it('rebuilds the pacer if the maxPerMinute ceiling changes (Infisical-live semantics)', () => {
    const first = getSharedEdgarPacer(0); // no-op pacer memoized
    const second = getSharedEdgarPacer(600); // 600 differs from 0, so rebuilds
    expect(second).not.toBe(first);
  });
});
