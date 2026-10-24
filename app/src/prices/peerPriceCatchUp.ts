/**
 * Same-session price retry after a stamped market-data lane (CT-2409, CT-2445).
 * Kept out of peerPricePending.ts so the pending-SQL owners (#2724, #2738,
 * open #2748) stay the only editors of that file.
 */

import { z } from 'zod';
import type { Env } from '../shared/types.ts';
import { get } from '../shared/db.ts';
import { lastTradingDay } from './service.ts';
import { isCurrentPriceFresh } from './staleness.ts';
import {
  ST_PEER_PRICE_TAIL_STALL_MAX_PENDING,
  stPeerPricePendingBindParams,
  stPeerPricePendingBindsOnce,
  stPeerPricePendingFromSql,
} from './peerPricePending.ts';

/**
 * Bounds for the catch-up (CT-2445).  The catch-up used to run once per UTC
 * day, but freshThrough rolls at midnight ET, after the 00:07Z lane run, so a
 * whole session's worth of tickers could sit pending for about a day.
 *
 * - Cadence:  at most one run per PEER_PRICE_CATCHUP_MIN_SPACING_MS, which is
 *   one per hourly :07 slot (55 minutes leaves room for cron jitter).
 * - Per session:  at most PEER_PRICE_CATCHUP_MAX_RUNS_PER_SESSION runs for one
 *   freshThrough, so at most 8 x 300 = 2,400 Socratic.Trade price reads.
 * - Per run:  at most PEER_PRICE_CATCHUP_MAX_TICKERS tickers, paced at
 *   PEER_PRICE_CATCHUP_MAX_PER_MINUTE.  ST's peerRead limit is 120 requests a
 *   minute for ALL peer reads, so 60 leaves half of it for everything else.
 *   300 tickers at 60/min is about 5 minutes, inside the 10-minute lane deadline.
 * - Stop:  park for the rest of the session after
 *   PEER_PRICE_CATCHUP_MAX_NO_PROGRESS_RUNS consecutive completed runs that did
 *   not shrink the pending count (tickers ST keeps erroring on, or no
 *   provider).  Failed runs do not count toward the park, but they do spend
 *   the session's run budget, so 429s cannot retry more than 8 times.
 */
export const PEER_PRICE_CATCHUP_MIN_SPACING_MS = 55 * 60_000;
export const PEER_PRICE_CATCHUP_MAX_RUNS_PER_SESSION = 8;
export const PEER_PRICE_CATCHUP_MAX_TICKERS = 300;
export const PEER_PRICE_CATCHUP_MAX_PER_MINUTE = 60;
export const PEER_PRICE_CATCHUP_MAX_NO_PROGRESS_RUNS = 2;

/** Persisted between hourly ticks.  Reset whenever freshThrough changes. */
export interface PeerPriceCatchUpState {
  freshThrough: string;
  runs: number;
  /** ISO time the last run STARTED.  Set before the run, so a throw or an
   *  abort still counts toward spacing and the session cap. */
  lastRunAt: string | null;
  noProgressRuns: number;
  /** Rotating resume point (MAX(cursor_seq) of the last ticker reached).  Null
   *  starts from the head of the oldest-first pending set. */
  cursorSeq: number | null;
}

export function freshPeerPriceCatchUpState(freshThrough: string): PeerPriceCatchUpState {
  return { freshThrough, runs: 0, lastRunAt: null, noProgressRuns: 0, cursorSeq: null };
}

const nonNegativeInt = z.number().int().nonnegative();

/** The persisted KV shape.  KV is outside the trust boundary, so parse, never cast. */
export const PeerPriceCatchUpStateSchema = z.object({
  freshThrough: z.string(),
  runs: nonNegativeInt,
  lastRunAt: z.string().nullable(),
  noProgressRuns: nonNegativeInt,
  cursorSeq: z.number().finite().nullable(),
});

/** Parse a stored state;  anything malformed or from another session restarts. */
export function parsePeerPriceCatchUpState(
  raw: string | null,
  freshThrough: string,
): PeerPriceCatchUpState {
  if (!raw) return freshPeerPriceCatchUpState(freshThrough);
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return freshPeerPriceCatchUpState(freshThrough);
  }
  const parsed = PeerPriceCatchUpStateSchema.safeParse(json);
  if (!parsed.success || parsed.data.freshThrough !== freshThrough) {
    return freshPeerPriceCatchUpState(freshThrough);
  }
  const v = parsed.data;
  return {
    freshThrough: v.freshThrough,
    runs: v.runs,
    lastRunAt: v.lastRunAt ?? null,
    noProgressRuns: v.noProgressRuns,
    cursorSeq: v.cursorSeq ?? null,
  };
}

export type PeerPriceCatchUpGate = 'ok' | 'session-cap' | 'no-progress' | 'spacing';

/** The cheap (KV-only) part of the policy, checked before any D1 read. */
export function peerPriceCatchUpGate(state: PeerPriceCatchUpState, now: Date): PeerPriceCatchUpGate {
  if (state.runs >= PEER_PRICE_CATCHUP_MAX_RUNS_PER_SESSION) return 'session-cap';
  if (state.noProgressRuns >= PEER_PRICE_CATCHUP_MAX_NO_PROGRESS_RUNS) return 'no-progress';
  if (state.lastRunAt) {
    const last = Date.parse(state.lastRunAt);
    if (Number.isFinite(last) && now.getTime() - last < PEER_PRICE_CATCHUP_MIN_SPACING_MS) return 'spacing';
  }
  return 'ok';
}

/** State after a finished (or aborted) run. */
export function peerPriceCatchUpAfterRun(
  state: PeerPriceCatchUpState,
  run: {
    pendingBefore: number;
    pendingAfter: number | null;
    lastCursorSeq: number | null;
    reachedEndOfPending: boolean;
    /** The run aborted (fatal ST error, deadline) or threw. */
    failed?: boolean;
  },
): PeerPriceCatchUpState {
  // An unreadable after-count is not proof of progress.
  const progressed = run.pendingAfter !== null && run.pendingAfter < run.pendingBefore;
  // A failed run that moved nothing says nothing about whether ST can price the
  // rest, so it does not count toward the park (Kody #2859).  It still spent one
  // of the session's runs and waits out the spacing, so failures stay bounded.
  const noProgressRuns = progressed ? 0 : run.failed ? state.noProgressRuns : state.noProgressRuns + 1;
  return {
    ...state,
    noProgressRuns,
    // Wrap to the head once the walk reached the end of the pending set.
    cursorSeq: run.reachedEndOfPending ? null : (run.lastCursorSeq ?? state.cursorSeq),
  };
}

export interface PeerPricePendingSnapshot {
  freshThrough: string;
  corpusFresh: boolean;
  pending: number;
}

/**
 * Corpus freshness and the pending count, or null when either query fails.
 * Do not use readCorpusLatestPriceDate here.  That helper turns a query error
 * into null, which would look like an empty corpus and retry every hour.
 */
export async function readPeerPricePending(env: Env, now = new Date()): Promise<PeerPricePendingSnapshot | null> {
  try {
    const row = await get<{ d: string | null }>(
      env.DB,
      'SELECT MAX(latest_price_date) AS d FROM securities_ref',
    );
    const corpus = row?.d && row.d.length >= 10 ? row.d.slice(0, 10) : null;
    const freshThrough = lastTradingDay(now);
    const params = stPeerPricePendingBindParams(now);
    const pending = await get<{ n: number }>(
      env.DB,
      `SELECT COUNT(DISTINCT t.ticker) AS n ${stPeerPricePendingFromSql()}`,
      stPeerPricePendingBindsOnce(params),
    );
    return {
      freshThrough,
      corpusFresh: isCurrentPriceFresh(corpus, freshThrough),
      pending: Number(pending?.n ?? 0),
    };
  } catch {
    return null;
  }
}

/** A current corpus with only a tiny never-priced tail is not a catch-up. */
export function peerPriceSnapshotNeedsCatchUp(s: PeerPricePendingSnapshot): boolean {
  if (!s.corpusFresh) return true;
  return s.pending > ST_PEER_PRICE_TAIL_STALL_MAX_PENDING;
}

/**
 * True when the hourly market-data tick should pull prices even if today's
 * lane stamp is already set.  A caught refresh throw used to stamp the UTC
 * day anyway, which parked the corpus until the next 00:07Z.
 */
export async function peerPricesNeedCatchUp(env: Env, now = new Date()): Promise<boolean> {
  const s = await readPeerPricePending(env, now);
  return s !== null && peerPriceSnapshotNeedsCatchUp(s);
}
