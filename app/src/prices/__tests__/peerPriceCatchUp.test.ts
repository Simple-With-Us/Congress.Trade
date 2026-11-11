/**
 * CT-2445:  the bounded peer-price catch-up policy (pure parts).  The wiring
 * into the stamped market-data fast path is covered in jobs.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  freshPeerPriceCatchUpState,
  isProviderLevelPriceError,
  parsePeerPriceCatchUpState,
  PEER_PRICE_CATCHUP_MAX_ATTEMPTS_PER_SESSION,
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
    expect(parsePeerPriceCatchUpState(null, SESSION, NOW)).toEqual(freshPeerPriceCatchUpState(SESSION, NOW));
    expect(parsePeerPriceCatchUpState('{not json', SESSION, NOW)).toEqual(freshPeerPriceCatchUpState(SESSION, NOW));
    const old = JSON.stringify({ freshThrough: '2026-10-22', runs: 8, lastRunAt: NOW.toISOString(), noProgressRuns: 2, cursorSeq: 9 });
    expect(parsePeerPriceCatchUpState(old, SESSION, NOW)).toEqual(freshPeerPriceCatchUpState(SESSION, NOW));
  });

  it('keeps a valid same-session state, and restarts on any malformed field', () => {
    const good = { freshThrough: SESSION, runs: 3, lastRunAt: NOW.toISOString(), noProgressRuns: 1, cursorSeq: 42 };
    // A state stored before the attempts bound has no attempts field;  it
    // parses with attempts approximated by the spent-run count.  A state
    // stored before the day roll has no budgetDay;  it parses as belonging
    // to the current ET day (NOW is 2026-10-24 in ET).
    expect(parsePeerPriceCatchUpState(JSON.stringify(good), SESSION, NOW)).toEqual({ ...good, attempts: 3, budgetDay: '2026-10-24' });
    const withAttempts = { ...good, attempts: 11 };
    expect(parsePeerPriceCatchUpState(JSON.stringify(withAttempts), SESSION, NOW)).toEqual({ ...withAttempts, budgetDay: '2026-10-24' });
    for (const bad of [
      { ...good, runs: -1 },
      { ...good, runs: 1.5 },
      { ...good, attempts: -2 },
      { ...good, cursorSeq: 'y' },
      { ...good, lastRunAt: 7 },
      { freshThrough: SESSION },
    ]) {
      expect(parsePeerPriceCatchUpState(JSON.stringify(bad), SESSION, NOW)).toEqual(freshPeerPriceCatchUpState(SESSION, NOW));
    }
  });
});

describe('parsePeerPriceCatchUpState day roll', () => {
  // The 2026-11-07 incident shape:  the Friday session (freshThrough
  // 2026-11-06, current through Monday) spent its whole run budget on
  // Friday's ET day, cursor mid-set.
  const FRIDAY_SESSION = '2026-11-06';
  const spentFriday = {
    freshThrough: FRIDAY_SESSION,
    runs: PEER_PRICE_CATCHUP_MAX_RUNS_PER_SESSION,
    attempts: PEER_PRICE_CATCHUP_MAX_RUNS_PER_SESSION,
    lastRunAt: '2026-11-06T23:07:00.000Z',
    noProgressRuns: 0,
    cursorSeq: 102624,
    budgetDay: '2026-11-06',
  };
  const SATURDAY = new Date('2026-11-07T14:07:00Z'); // 09:07 EST

  it('opens the gate on a new ET day with the budget exhausted under the same freshThrough', () => {
    const rolled = parsePeerPriceCatchUpState(JSON.stringify(spentFriday), FRIDAY_SESSION, SATURDAY);
    expect(rolled.runs).toBe(0);
    expect(rolled.attempts).toBe(0);
    expect(rolled.budgetDay).toBe('2026-11-07');
    expect(peerPriceCatchUpGate(rolled, SATURDAY)).toBe('ok');
  });

  it('keeps freshThrough and the cursor across the roll, and clears the park', () => {
    const parked = { ...spentFriday, noProgressRuns: PEER_PRICE_CATCHUP_MAX_NO_PROGRESS_RUNS };
    const rolled = parsePeerPriceCatchUpState(JSON.stringify(parked), FRIDAY_SESSION, SATURDAY);
    expect(rolled.freshThrough).toBe(FRIDAY_SESSION);
    expect(rolled.cursorSeq).toBe(102624);
    expect(rolled.noProgressRuns).toBe(0);
    // Spacing is a rate bound, not a budget:  the Friday-evening stamp
    // survives the roll and still throttles early-morning ticks.
    expect(rolled.lastRunAt).toBe(spentFriday.lastRunAt);
  });

  it('does not reset within the same ET day', () => {
    const spentSaturday = { ...spentFriday, budgetDay: '2026-11-07', lastRunAt: '2026-11-07T12:17:00.000Z' };
    const parsed = parsePeerPriceCatchUpState(JSON.stringify(spentSaturday), FRIDAY_SESSION, SATURDAY);
    expect(parsed.runs).toBe(PEER_PRICE_CATCHUP_MAX_RUNS_PER_SESSION);
    expect(parsed.attempts).toBe(PEER_PRICE_CATCHUP_MAX_RUNS_PER_SESSION);
    expect(parsed.budgetDay).toBe('2026-11-07');
    expect(peerPriceCatchUpGate(parsed, SATURDAY)).toBe('session-cap');
  });

  it('derives a legacy state\'s budget day from lastRunAt, so a spent one rolls on a later ET day', () => {
    const legacy = {
      freshThrough: FRIDAY_SESSION,
      runs: PEER_PRICE_CATCHUP_MAX_RUNS_PER_SESSION,
      attempts: PEER_PRICE_CATCHUP_MAX_RUNS_PER_SESSION,
      lastRunAt: '2026-11-06T23:07:00.000Z',
      noProgressRuns: 0,
      cursorSeq: 102624,
    };
    const parsed = parsePeerPriceCatchUpState(JSON.stringify(legacy), FRIDAY_SESSION, SATURDAY);
    // Last run was Friday 6 PM ET, so the budget is Friday's and Saturday
    // rolls it (the gate must not stay session-capped, since a capped tick
    // never rewrites KV to stamp the day).
    expect(parsed.runs).toBe(0);
    expect(parsed.cursorSeq).toBe(102624);
    expect(parsed.budgetDay).toBe('2026-11-07');
    expect(peerPriceCatchUpGate(parsed, SATURDAY)).toBe('ok');
    // A legacy state last run the same ET day keeps its spent budget.
    const sameDay = { ...legacy, lastRunAt: '2026-11-07T12:17:00.000Z' };
    const capped = parsePeerPriceCatchUpState(JSON.stringify(sameDay), FRIDAY_SESSION, SATURDAY);
    expect(capped.runs).toBe(PEER_PRICE_CATCHUP_MAX_RUNS_PER_SESSION);
    expect(capped.budgetDay).toBe('2026-11-07');
    expect(peerPriceCatchUpGate(capped, SATURDAY)).toBe('session-cap');
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

  it('stops at the per-session attempt cap even when every run was refunded', () => {
    // The no-engagement loop bound:  runs handed back, attempts never are.
    const refundedDry = { ...base, runs: 0, attempts: PEER_PRICE_CATCHUP_MAX_ATTEMPTS_PER_SESSION };
    expect(peerPriceCatchUpGate(refundedDry, NOW)).toBe('session-cap');
    const oneLeft = { ...base, runs: 0, attempts: PEER_PRICE_CATCHUP_MAX_ATTEMPTS_PER_SESSION - 1 };
    expect(peerPriceCatchUpGate(oneLeft, NOW)).toBe('ok');
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

  it('resets no-progress when tickers priced even if pending count is flat', () => {
    const next = peerPriceCatchUpAfterRun(claimed, {
      pendingBefore: 950,
      pendingAfter: 950,
      lastCursorSeq: 900,
      reachedEndOfPending: false,
      tickersPriced: 120,
    });
    expect(next.noProgressRuns).toBe(0);
  });

  it('does not count a failed run with no progress toward the park', () => {
    const failed = peerPriceCatchUpAfterRun(claimed, {
      pendingBefore: 20, pendingAfter: 20, lastCursorSeq: null, reachedEndOfPending: false, failed: true,
    });
    expect(failed.noProgressRuns).toBe(1);
    expect(failed.runs).toBe(1);
    // A failed run that still shrank pending resets it like any other.
    const partial = peerPriceCatchUpAfterRun(claimed, {
      pendingBefore: 20, pendingAfter: 12, lastCursorSeq: 5, reachedEndOfPending: false, failed: true,
    });
    expect(partial.noProgressRuns).toBe(0);
  });

  it('hands the session claim back for a no-engagement run (spendRun false)', () => {
    const refunded = peerPriceCatchUpAfterRun(claimed, {
      pendingBefore: 20, pendingAfter: 20, lastCursorSeq: null, reachedEndOfPending: false,
      failed: true, spendRun: false,
    });
    // The claim (runs 1, stamped before the run) is handed back, so the
    // session budget survives an outage; the park count is untouched, and
    // lastRunAt stays stamped so spacing still throttles the retry.
    expect(refunded.runs).toBe(0);
    expect(refunded.noProgressRuns).toBe(1);
    expect(refunded.lastRunAt).toBe(claimed.lastRunAt);
    expect(peerPriceCatchUpGate(refunded, new Date(Date.parse(claimed.lastRunAt!) + 56 * 60_000))).toBe('ok');
  });

  it('never hands the attempt count back, so refunded runs still reach the attempt cap', () => {
    const claimedAttempt = { ...claimed, attempts: PEER_PRICE_CATCHUP_MAX_ATTEMPTS_PER_SESSION };
    const refunded = peerPriceCatchUpAfterRun(claimedAttempt, {
      pendingBefore: 20, pendingAfter: 20, lastCursorSeq: null, reachedEndOfPending: false,
      failed: true, spendRun: false,
    });
    expect(refunded.runs).toBe(0);
    expect(refunded.attempts).toBe(PEER_PRICE_CATCHUP_MAX_ATTEMPTS_PER_SESSION);
    const later = new Date(Date.parse(claimed.lastRunAt!) + 56 * 60_000);
    expect(peerPriceCatchUpGate(refunded, later)).toBe('session-cap');
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

describe('isProviderLevelPriceError', () => {
  it('recognizes provider outages: 5xx, network failure, and corpus lag', () => {
    expect(isProviderLevelPriceError('ASGN: PEER_HTTP_503')).toBe(true);
    expect(isProviderLevelPriceError('spx: PEER_HTTP_500')).toBe(true);
    expect(isProviderLevelPriceError('ASGN: PEER_HTTP_0:fetch failed')).toBe(true);
    expect(isProviderLevelPriceError('ASGN: PEER_STALE_RESPONSE (corpus not fresh)')).toBe(true);
  });

  it('treats anything else as a ticker-level failure, including fatal-class statuses that abort before classification', () => {
    expect(isProviderLevelPriceError('ASGN: unexpected payload shape')).toBe(false);
    expect(isProviderLevelPriceError('ASGN: PEER_HTTP_400')).toBe(false);
    expect(isProviderLevelPriceError('ASGN: PEER_HTTP_429')).toBe(false);
  });
});
