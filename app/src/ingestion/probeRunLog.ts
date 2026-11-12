/**
 * src/ingestion/probeRunLog.ts
 * OWNER: ingestion
 *
 * DURABLE RECORD OF EVERY COMPETITOR PROBE — including the ones that find
 * nothing.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * `trade_provider_observations.first_observed_at` records the moment WE first
 * saw a competitor carrying a filing. It has been read as if it were the
 * moment the COMPETITOR PUBLISHED it. It is not, and the difference is the
 * entire latency edge.
 *
 * If we probe every 30 minutes, a filing the competitor published at 10:00 is
 * first seen at 10:29, and a naive lead calculation credits us 29 minutes we
 * did not earn. Measured on production data (2026-08-16..19) this produced
 * leads quantised onto a handful of values — quiver AND unusual_whales both
 * reporting exactly 68.28h and 147.28h across dozens of rows, which is
 * impossible for real publication times and is simply our own probe schedule
 * showing through.
 *
 * The honest statement is an INTERVAL, not a point. If the probe at T finds a
 * row that the probe at T_prev did not, the competitor published somewhere in
 * (T_prev, T]. That requires knowing T_prev — which requires recording probes
 * that found NOTHING, because those are exactly the ones that establish the
 * lower bound. `probeCadenceLog.ts` writes to the console and deliberately
 * suppresses most lines, so it cannot answer this. Hence a table.
 *
 * ---------------------------------------------------------------------------
 * WHAT CALLERS MUST DO
 * ---------------------------------------------------------------------------
 * Order matters and is easy to get wrong:
 *
 *   1. read `previousSuccessfulProbeAt()`  <- BEFORE recording this run
 *   2. stamp new observations with that value as `prev_probe_at`
 *   3. `recordProbeRun()` for this run
 *
 * Recording first would make the current run its own predecessor and collapse
 * every bracket to zero width — which would look like a perfect measurement
 * and be entirely fictional.
 *
 * Only SUCCESSFUL probes bound the interval. A probe that threw or was rate
 * limited did not observe the competitor's absence, so it cannot establish
 * that the row was not yet published. Failed runs are still recorded (they are
 * needed to explain gaps and to drive the lease handoff) but are excluded from
 * the predecessor lookup.
 */

import type { Env } from '../shared/types.ts';
import { all, run, withSqliteLockRetry } from '../shared/db.ts';

/** A single probe attempt against one provider/chamber lane. */
export interface ProbeRun {
  provider: string;
  chamber: string;
  ranAt: string;
  ok: boolean;
  rowsSeen: number;
  error?: string | null;
}

/**
 * How confident we are about a competitor's publication time.
 *  - `bracketed`  — we have both bounds; publication is inside a known window.
 *  - `unbounded`  — no prior successful probe (cold start, or the lane had
 *                   been dark); the row could have been published at any point
 *                   before we saw it. NEVER treat this as a fast race.
 */
export type DetectionConfidence = 'bracketed' | 'unbounded';

export interface DetectionWindow {
  /** Exclusive lower bound: the last probe that looked and did NOT see it. */
  start: string | null;
  /** Inclusive upper bound: the probe that first saw it. */
  end: string;
  /** Window width in seconds, or null when unbounded. */
  widthSec: number | null;
  confidence: DetectionConfidence;
}

const MAX_ERROR_LEN = 300;

/**
 * Chamber sentinel for a probe that fetches a provider's whole "latest" feed in
 * one request, covering every chamber it carries. Recorded once per run under
 * this lane; `previousSuccessfulProbeAt` matches it for any chamber.
 */
export const ALL_CHAMBERS = '*';

/**
 * Build the detection window for an observation. Pure — unit-tested without a
 * database.
 *
 * A non-finite or inverted pair (prev >= end, e.g. clock skew between the Mac
 * scout and the server) is treated as UNBOUNDED rather than clamped to zero: a
 * zero-width window is the strongest possible claim and must never be produced
 * by accident.
 */
export function detectionWindow(prevProbeAt: string | null | undefined, firstSeenAt: string): DetectionWindow {
  const end = firstSeenAt;
  if (!prevProbeAt) return { start: null, end, widthSec: null, confidence: 'unbounded' };
  const prevMs = Date.parse(prevProbeAt);
  const endMs = Date.parse(end);
  if (!Number.isFinite(prevMs) || !Number.isFinite(endMs) || prevMs >= endMs) {
    return { start: null, end, widthSec: null, confidence: 'unbounded' };
  }
  return { start: prevProbeAt, end, widthSec: (endMs - prevMs) / 1000, confidence: 'bracketed' };
}

/**
 * Bounded lead of congress.trade over a competitor for one filing.
 *
 * Returns the range of possible leads in seconds. `atLeast` uses the lower
 * bound of the competitor's publication window (the pessimistic, defensible
 * number) and `atMost` uses the upper bound. Positive means CT was ahead.
 *
 * `atLeast` is null when the window is unbounded — in that case we genuinely
 * cannot claim any minimum lead, and reporting one would be the exact bug this
 * module exists to remove.
 */
export function boundedLeadSec(
  window: DetectionWindow,
  congressFirstSeenAt: string,
): { atLeastSec: number | null; atMostSec: number | null } {
  const ctMs = Date.parse(congressFirstSeenAt);
  if (!Number.isFinite(ctMs)) return { atLeastSec: null, atMostSec: null };
  const endMs = Date.parse(window.end);
  const atMostSec = Number.isFinite(endMs) ? (endMs - ctMs) / 1000 : null;
  if (!window.start) return { atLeastSec: null, atMostSec };
  const startMs = Date.parse(window.start);
  return {
    atLeastSec: Number.isFinite(startMs) ? (startMs - ctMs) / 1000 : null,
    atMostSec,
  };
}

/** Record one probe attempt. Best-effort: never throws into the probe path. */
export async function recordProbeRun(env: Env, probe: ProbeRun): Promise<void> {
  try {
    await withSqliteLockRetry(() => run(
      env.DB,
      `INSERT INTO provider_probe_runs (provider, chamber, ran_at, ok, rows_seen, error)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, chamber, ran_at) DO UPDATE SET
         ok=excluded.ok,
         rows_seen=excluded.rows_seen,
         error=excluded.error`,
      [
        probe.provider,
        probe.chamber,
        probe.ranAt,
        probe.ok ? 1 : 0,
        Number.isFinite(probe.rowsSeen) ? probe.rowsSeen : 0,
        probe.error ? String(probe.error).slice(0, MAX_ERROR_LEN) : null,
      ],
    ));
  } catch (err) {
    console.warn(`probe run log: could not record ${probe.provider}/${probe.chamber}:`, (err as Error).message);
  }
}

/**
 * The most recent SUCCESSFUL probe of this lane strictly before `before`.
 * Returns null when the lane has no prior success — which correctly yields an
 * unbounded window rather than a fabricated one.
 */
export async function previousSuccessfulProbeAt(
  env: Env,
  provider: string,
  chamber: string,
  before: string,
): Promise<string | null> {
  try {
    const rows = await all<{ ran_at: string }>(
      env.DB,
      `SELECT ran_at FROM provider_probe_runs
        WHERE provider = ? AND (chamber = ? OR chamber = ?) AND ok = 1 AND ran_at < ?
        ORDER BY ran_at DESC LIMIT 1`,
      [provider, chamber, ALL_CHAMBERS, before],
    );
    return rows[0]?.ran_at ?? null;
  } catch {
    return null;
  }
}
