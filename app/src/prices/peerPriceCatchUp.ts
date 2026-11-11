/**
 * Same-session price retry after a stamped market-data lane (CT-2409, CT-2445).
 * Kept out of peerPricePending.ts so the pending-SQL owners (#2724, #2738,
 * open #2748) stay the only editors of that file.
 */

import { z } from 'zod';
import type { Env } from '../shared/types.ts';
import { get } from '../shared/db.ts';
import { easternDateString, lastTradingDay } from './service.ts';
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
 * - Per day:  at most PEER_PRICE_CATCHUP_MAX_RUNS_PER_SESSION engaged runs
 *   per ET calendar day within one freshThrough session, so at most
 *   8 x 300 = 2,400 Socratic.Trade price reads per day from runs that
 *   engage the provider.  Total attempts (engaged plus no-engagement) are
 *   separately capped at PEER_PRICE_CATCHUP_MAX_ATTEMPTS_PER_SESSION per
 *   day, so a provider that never engages cannot turn the drain into an
 *   unbounded hourly loop either.
 * - Day roll (2026-11-08):  the budgets used to be keyed to freshThrough
 *   alone, but freshThrough does not roll over a weekend — the Friday
 *   session spans Friday through Monday — so on Sat 2026-11-07 the walk
 *   spent all 8 runs by 12:17Z and stayed session-capped until Tuesday
 *   with ~319 tickers still pending (cursor stuck at 102624 of 126424).
 *   The budgets and the no-progress park now reset when the ET calendar
 *   day changes inside a session (see budgetDay on the state);  the
 *   session itself, the cursor, and the spacing stamp survive the roll.
 *   One visible side effect:  the NULL-only current-price backfill is
 *   keyed to the first claimed run, so it now runs on the first catch-up
 *   of each ET day instead of the first of each session.
 * - Per run:  at most PEER_PRICE_CATCHUP_MAX_TICKERS tickers, paced at
 *   PEER_PRICE_CATCHUP_MAX_PER_MINUTE.  ST's peerRead limit is 120 requests a
 *   minute for ALL peer reads, so 60 leaves half of it for everything else.
 *   300 tickers at 60/min is about 5 minutes, inside the 10-minute lane deadline.
 * - Stop:  park for the rest of the ET day after
 *   PEER_PRICE_CATCHUP_MAX_NO_PROGRESS_RUNS consecutive completed runs that did
 *   not shrink the pending count (tickers ST keeps erroring on, or no
 *   provider).  Failed runs do not count toward the park, but they do spend
 *   the day's run budget, so 429s cannot retry more than 8 times a day.
 * - No-engagement runs (CT-2445 follow-up, 2026-11-04):  a completed run that
 *   priced zero tickers and recorded provider errors on its attempts never
 *   engaged ST's data path at all — the outage signature (ST answering 503
 *   is non-fatal per ticker, so the walk "completes").  Such a run says
 *   nothing about coverage, so it does not count toward the park, and it
 *   hands its session claim back instead of spending the run budget.
 *   Without this, an outage eats the session's park and budget, and the
 *   drain stays gated for hours after ST recovers.  Spacing still applies,
 *   so the retry cadence stays at one attempt per hourly slot.
 *   Two bounds keep the exemption honest (review follow-up, 2026-11-05):
 *   only runs whose recorded errors are ALL provider-level qualify (a
 *   zero-priced run with any ticker-level failure counts as engaged, so it
 *   spends a run and can park), and every claimed run — engaged or not —
 *   increments the day's attempt count, which the gate caps.  An
 *   engaged run also resets nothing about attempts:  the cap is a
 *   per-day total, reset when the ET day rolls or when freshThrough rolls.
 */
export const PEER_PRICE_CATCHUP_MIN_SPACING_MS = 55 * 60_000;
export const PEER_PRICE_CATCHUP_MAX_RUNS_PER_SESSION = 8;
/** Total claimed runs per ET day within a session, engaged plus
 *  no-engagement.  At the 55-minute spacing, 24 attempts span a full day,
 *  so a genuine outage of any length still recovers on the first tick
 *  after the provider returns, while a permanently erroring pending set
 *  is hard-bounded. */
export const PEER_PRICE_CATCHUP_MAX_ATTEMPTS_PER_SESSION = 24;
export const PEER_PRICE_CATCHUP_MAX_TICKERS = 300;
export const PEER_PRICE_CATCHUP_MAX_PER_MINUTE = 60;
/**
 * Per-ticker fetches in flight at once inside one catch-up run (CT-2445
 * follow-up, 2026-11-06).  A cold Socratic.Trade fetch takes ~10s, so the
 * serial walk spent the 10-minute lane deadline on latency and priced only
 * ~50 of its 300-ticker page.  Four in flight over the same 60/min pacer
 * lets a run finish its full page in about 5 minutes of pacing;  the pacer
 * still governs the aggregate request rate, so this changes no rate,
 * deadline, session-cap, or schedule bound above.
 */
export const PEER_PRICE_CATCHUP_FETCH_CONCURRENCY = 4;
export const PEER_PRICE_CATCHUP_MAX_NO_PROGRESS_RUNS = 2;

/** Persisted between hourly ticks.  Reset whenever freshThrough changes;
 *  the budgets inside it also reset when the ET day rolls (see budgetDay). */
export interface PeerPriceCatchUpState {
  freshThrough: string;
  runs: number;
  /** Total runs claimed this budget day, including no-engagement runs that
   *  handed their run claim back.  Never refunded within the day; the gate
   *  caps it, which is what bounds the no-engagement retry loop. */
  attempts: number;
  /** ISO time the last run STARTED.  Set before the run, so a throw or an
   *  abort still counts toward spacing and the day's run budget. */
  lastRunAt: string | null;
  noProgressRuns: number;
  /** Rotating resume point (MAX(cursor_seq) of the last ticker reached).  Null
   *  starts from the head of the oldest-first pending set. */
  cursorSeq: number | null;
  /** ET calendar day (YYYY-MM-DD) the runs / attempts / noProgressRuns
   *  budgets belong to.  freshThrough does not roll over a weekend, so a
   *  session alone can span three-plus days;  the budgets reset when this
   *  differs from the current ET day.  Absent in states written before the
   *  day roll existed — the reader treats those as belonging to the
   *  current day (their budget still applies;  no free reset) and the
   *  first write under the new code stamps the day. */
  budgetDay: string;
}

export function freshPeerPriceCatchUpState(freshThrough: string, now = new Date()): PeerPriceCatchUpState {
  return {
    freshThrough,
    runs: 0,
    attempts: 0,
    lastRunAt: null,
    noProgressRuns: 0,
    cursorSeq: null,
    budgetDay: easternDateString(now),
  };
}

const nonNegativeInt = z.number().int().nonnegative();

/** The persisted KV shape.  KV is outside the trust boundary, so parse, never cast. */
export const PeerPriceCatchUpStateSchema = z.object({
  freshThrough: z.string(),
  runs: nonNegativeInt,
  // Optional so states written before the attempts bound still parse;  the
  // reader falls back to the spent-run count for those.
  attempts: nonNegativeInt.optional(),
  lastRunAt: z.string().nullable(),
  noProgressRuns: nonNegativeInt,
  cursorSeq: z.number().finite().nullable(),
  // Optional so states written before the day roll still parse;  the reader
  // derives the day from lastRunAt.
  budgetDay: z.string().optional(),
});

/** Parse a stored state;  anything malformed or from another session restarts. */
export function parsePeerPriceCatchUpState(
  raw: string | null,
  freshThrough: string,
  now = new Date(),
): PeerPriceCatchUpState {
  if (!raw) return freshPeerPriceCatchUpState(freshThrough, now);
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return freshPeerPriceCatchUpState(freshThrough, now);
  }
  const parsed = PeerPriceCatchUpStateSchema.safeParse(json);
  if (!parsed.success || parsed.data.freshThrough !== freshThrough) {
    return freshPeerPriceCatchUpState(freshThrough, now);
  }
  const v = parsed.data;
  const today = easternDateString(now);
  // States written before the day roll have no budgetDay.  Derive it from the
  // ET day of the last run so a legacy state spent on an earlier day rolls
  // like a stamped one (defaulting to today would carry the spent budget
  // forward, and a session-capped tick never rewrites KV to stamp the day).
  // With no usable lastRunAt there is no earlier day to blame, so it
  // belongs to today.
  const lastRunMs = v.lastRunAt ? Date.parse(v.lastRunAt) : Number.NaN;
  const budgetDay = v.budgetDay ?? (Number.isNaN(lastRunMs) ? today : easternDateString(new Date(lastRunMs)));
  if (budgetDay !== today) {
    // ET day roll inside one session:  freshThrough does not roll over a
    // weekend, so without this the Friday session's budget — spent by
    // Saturday noon in the 2026-11-07 incident — would gate the walk until
    // Tuesday.  Reset the budgets and the park;  keep the cursor (the walk
    // resumes mid-set) and lastRunAt (spacing is a rate bound, not a
    // budget, so a late-evening run still throttles the first tick of the
    // new day).
    return {
      freshThrough,
      runs: 0,
      attempts: 0,
      lastRunAt: v.lastRunAt ?? null,
      noProgressRuns: 0,
      cursorSeq: v.cursorSeq ?? null,
      budgetDay: today,
    };
  }
  return {
    freshThrough: v.freshThrough,
    runs: v.runs,
    attempts: v.attempts ?? v.runs,
    lastRunAt: v.lastRunAt ?? null,
    noProgressRuns: v.noProgressRuns,
    cursorSeq: v.cursorSeq ?? null,
    budgetDay,
  };
}

export type PeerPriceCatchUpGate = 'ok' | 'session-cap' | 'no-progress' | 'spacing';

/** The cheap (KV-only) part of the policy, checked before any D1 read. */
/** Engaged-run budget scales with backlog so a daily EOD wave can finish in one day. */
export function peerPriceCatchUpEffectiveRunCap(pending: number): number {
  if (pending <= 0) return PEER_PRICE_CATCHUP_MAX_RUNS_PER_SESSION;
  const pages = Math.ceil(pending / PEER_PRICE_CATCHUP_MAX_TICKERS);
  return Math.min(
    PEER_PRICE_CATCHUP_MAX_ATTEMPTS_PER_SESSION,
    Math.max(PEER_PRICE_CATCHUP_MAX_RUNS_PER_SESSION, pages + 1),
  );
}

export function peerPriceCatchUpGate(
  state: PeerPriceCatchUpState,
  now: Date,
  opts: { maxRuns?: number } = {},
): PeerPriceCatchUpGate {
  const maxRuns = opts.maxRuns ?? PEER_PRICE_CATCHUP_MAX_RUNS_PER_SESSION;
  if (state.runs >= maxRuns) return 'session-cap';
  if (state.attempts >= PEER_PRICE_CATCHUP_MAX_ATTEMPTS_PER_SESSION) return 'session-cap';
  if (state.noProgressRuns >= PEER_PRICE_CATCHUP_MAX_NO_PROGRESS_RUNS) return 'no-progress';
  if (state.lastRunAt) {
    const last = Date.parse(state.lastRunAt);
    if (Number.isFinite(last) && now.getTime() - last < PEER_PRICE_CATCHUP_MIN_SPACING_MS) return 'spacing';
  }
  return 'ok';
}

/**
 * Whether one recorded refresh error is provider-level:  ST answered 5xx,
 * the fetch never completed (PEER_HTTP_0), or ST answered with a stale
 * corpus (the corpus-lag entry the walk records itself).  The strict peer
 * client throws PEER_HTTP_<status> for every non-2xx except 404, and a 404
 * becomes a confirmed-empty result, never an error entry — so an error that
 * matches none of these shapes is a ticker-level failure, not an outage
 * signal.  Entries are prefixed with the ticker (or `spx:`), so the match
 * is unanchored.
 */
const PROVIDER_LEVEL_PRICE_ERROR = /PEER_HTTP_(0|5\d\d)(\D|$)|PEER_STALE_RESPONSE/;

export function isProviderLevelPriceError(errorEntry: string): boolean {
  return PROVIDER_LEVEL_PRICE_ERROR.test(errorEntry);
}

/** State after a finished (or aborted) run.  `state` is the CLAIMED state:
 *  the caller already incremented `runs` and stamped `lastRunAt` in KV before
 *  any provider call, so a run that hands its claim back (spendRun false)
 *  decrements `runs` here. */
export function peerPriceCatchUpAfterRun(
  state: PeerPriceCatchUpState,
  run: {
    pendingBefore: number;
    pendingAfter: number | null;
    lastCursorSeq: number | null;
    reachedEndOfPending: boolean;
    /** The run aborted (fatal ST error, deadline) or threw. */
    failed?: boolean;
    /** False only for a no-engagement run:  it priced zero tickers and every
     *  attempt failed with a provider-level error, so it never engaged ST's
     *  data path and hands its session claim back.  Default true — aborted
     *  and engaged runs spend one of the day's runs as before.  The
     *  day's attempt count is never handed back either way. */
    spendRun?: boolean;
    /** Tickers that received EOD history this run (may not shrink pending when
     *  the tail re-queues on negative-cache boundaries). */
    tickersPriced?: number;
  },
): PeerPriceCatchUpState {
  // An unreadable after-count is not proof of progress; priced tickers are.
  const progressed =
    (run.pendingAfter !== null && run.pendingAfter < run.pendingBefore) ||
    (run.tickersPriced ?? 0) > 0;
  // A failed run that moved nothing says nothing about whether ST can price the
  // rest, so it does not count toward the park (Kody #2859).  It still spent one
  // of the day's runs and waits out the spacing, so failures stay bounded.
  const noProgressRuns = progressed ? 0 : run.failed ? state.noProgressRuns : state.noProgressRuns + 1;
  return {
    ...state,
    runs: run.spendRun === false ? Math.max(0, state.runs - 1) : state.runs,
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
