/**
 * CT-2445:  the bounded peer-price catch-up policy (pure parts).  The wiring
 * into the stamped market-data fast path is covered in jobs.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  freshPeerPriceCatchUpState,
  parsePeerPriceCatchUpState,
  PEER_PRICE_CATCHUP_MAX_NO_PROGRESS_RUNS,
  PEER_PRICE_CATCHUP_MAX_RUNS_PER_SESSION,
  PEER_PRICE_CATCHUP_MIN_SPACING_MS,
  peerPriceCatchUpAfterRun,
  peerPriceCatchUpGate,
  peerPriceSnapshotNeedsCatchUp,
} from '../peerPriceCatchUp.ts';

const SESSION = '2026-10-23';
const NOW = new Date('2026-10-24T15:07:00Z');

describe('parsePeerPriceCatchUpState', () => {
  it('starts fresh when nothing is stored, the JSON is bad, or the session changed', () => {
    expect(parsePeerPriceCatchUpState(null, SESSION)).toEqual(freshPeerPriceCatchUpState(SESSION));
    expect(parsePeerPriceCatchUpState('{not json', SESSION)).toEqual(freshPeerPriceCatchUpState(SESSION));
    const old = JSON.stringify({ freshThrough: '2026-10-22', runs: 8, lastRunAt: NOW.toISOString(), noProgressRuns: 2, cursorSeq: 9 });
    expect(parsePeerPriceCatchUpState(old, SESSION)).toEqual(freshPeerPriceCatchUpState(SESSION));
  });

  it('keeps a valid same-session state, and restarts on any malformed field', () => {
    const good = { freshThrough: SESSION, runs: 3, lastRunAt: NOW.toISOString(), noProgressRuns: 1, cursorSeq: 42 };
    expect(parsePeerPriceCatchUpState(JSON.stringify(good), SESSION)).toEqual(good);
    for (const bad of [
      { ...good, runs: -1 },
      { ...good, runs: 1.5 },
      { ...good, cursorSeq: 'y' },
      { ...good, lastRunAt: 7 },
      { freshThrough: SESSION },
    ]) {
      expect(parsePeerPriceCatchUpState(JSON.stringify(bad), SESSION)).toEqual(freshPeerPriceCatchUpState(SESSION));
    }
  });
});

describe('peerPriceCatchUpGate', () => {
  const base = freshPeerPriceCatchUpState(SESSION);

  it('allows the first run of a session', () => {
    expect(peerPriceCatchUpGate(base, NOW)).toBe('ok');
  });

  it('holds runs closer together than the minimum spacing', () => {
    const recent = new Date(NOW.getTime() - PEER_PRICE_CATCHUP_MIN_SPACING_MS + 1000).toISOString();
    expect(peerPriceCatchUpGate({ ...base, runs: 1, lastRunAt: recent }, NOW)).toBe('spacing');
    // The next hourly :07 slot clears it.
    const hourAgo = new Date(NOW.getTime() - 60 * 60_000).toISOString();
    expect(peerPriceCatchUpGate({ ...base, runs: 1, lastRunAt: hourAgo }, NOW)).toBe('ok');
  });

  it('stops at the per-session run cap', () => {
    expect(peerPriceCatchUpGate({ ...base, runs: PEER_PRICE_CATCHUP_MAX_RUNS_PER_SESSION }, NOW)).toBe('session-cap');
  });

  it('parks after consecutive runs with no progress', () => {
    expect(
      peerPriceCatchUpGate({ ...base, runs: 2, noProgressRuns: PEER_PRICE_CATCHUP_MAX_NO_PROGRESS_RUNS }, NOW),
    ).toBe('no-progress');
  });
});

describe('peerPriceCatchUpAfterRun', () => {
  const claimed = { ...freshPeerPriceCatchUpState(SESSION), runs: 1, lastRunAt: NOW.toISOString(), noProgressRuns: 1 };

  it('resets the no-progress count when pending shrank, and advances the cursor', () => {
    const next = peerPriceCatchUpAfterRun(claimed, {
      pendingBefore: 1427,
      pendingAfter: 1130,
      lastCursorSeq: 500,
      reachedEndOfPending: false,
    });
    expect(next.noProgressRuns).toBe(0);
    expect(next.cursorSeq).toBe(500);
    expect(next.runs).toBe(1);
  });

  it('counts a flat or unreadable pending count as no progress', () => {
    const flat = peerPriceCatchUpAfterRun(claimed, { pendingBefore: 20, pendingAfter: 20, lastCursorSeq: 7, reachedEndOfPending: false });
    expect(flat.noProgressRuns).toBe(2);
    const unknown = peerPriceCatchUpAfterRun(claimed, { pendingBefore: 20, pendingAfter: null, lastCursorSeq: 7, reachedEndOfPending: false });
    expect(unknown.noProgressRuns).toBe(2);
  });

  it('does not count a failed run with no progress toward the park', () => {
    const failed = peerPriceCatchUpAfterRun(claimed, {
      pendingBefore: 20, pendingAfter: 20, lastCursorSeq: null, reachedEndOfPending: false, failed: true,
    });
    expect(failed.noProgressRuns).toBe(1);
    // A failed run that still shrank pending resets it like any other.
    const partial = peerPriceCatchUpAfterRun(claimed, {
      pendingBefore: 20, pendingAfter: 12, lastCursorSeq: 5, reachedEndOfPending: false, failed: true,
    });
    expect(partial.noProgressRuns).toBe(0);
  });

  it('wraps to the head after reaching the end, and keeps the cursor when nothing was reached', () => {
    const wrapped = peerPriceCatchUpAfterRun({ ...claimed, cursorSeq: 400 }, {
      pendingBefore: 20, pendingAfter: 10, lastCursorSeq: 900, reachedEndOfPending: true,
    });
    expect(wrapped.cursorSeq).toBeNull();
    const kept = peerPriceCatchUpAfterRun({ ...claimed, cursorSeq: 400 }, {
      pendingBefore: 20, pendingAfter: 20, lastCursorSeq: null, reachedEndOfPending: false,
    });
    expect(kept.cursorSeq).toBe(400);
  });
});

describe('peerPriceSnapshotNeedsCatchUp', () => {
  it('needs a catch-up when the corpus is behind or more than the tail is pending', () => {
    expect(peerPriceSnapshotNeedsCatchUp({ freshThrough: SESSION, corpusFresh: false, pending: 0 })).toBe(true);
    expect(peerPriceSnapshotNeedsCatchUp({ freshThrough: SESSION, corpusFresh: true, pending: 1427 })).toBe(true);
    expect(peerPriceSnapshotNeedsCatchUp({ freshThrough: SESSION, corpusFresh: true, pending: 5 })).toBe(false);
  });
});
