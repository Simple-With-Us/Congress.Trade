/**
 * src/ingestion/probeCadenceLog.ts
 *
 * OBSERVABILITY FOR THE ADAPTIVE PROBE CADENCE.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * A cadence that silently stops probing looks EXACTLY like one that is working
 * — right up until a filing is missed. Both produce the same thing in the log:
 * nothing. The measured schedule deliberately makes long silences normal (the
 * House LOW tier probes once every ~30 minutes and the 20:00-08:59 ET stretch
 * is measured-zero), so "quiet" stopped being evidence of health the moment
 * probeSchedule.ts was wired in.
 *
 * Every skip therefore has to say WHICH TIER AND WINDOW it came from, so a
 * human reading the log can tell:
 *
 *   probe cadence: house skip tier=low window=weekday interval=1789s
 *     elapsed=240s reason=too-soon authority=schedule
 *       -> correctly skipped, off-peak. Working as designed.
 *
 *   (nothing at all for hours)
 *       -> the tick is not running, or the lane threw. Broken.
 *
 * ---------------------------------------------------------------------------
 * VOLUME CONTROL
 * ---------------------------------------------------------------------------
 * The tick runs once a minute across ~6 lanes (house, senate, and one per
 * latency provider). Logging every evaluation would be ~8 600 lines/day of
 * almost entirely "too-soon", which is how a log becomes unreadable and
 * therefore unread. A line is emitted when:
 *
 *   1. a probe actually FIRES                       — always interesting;
 *   2. the TIER CHANGES for that lane               — the schedule moved, the
 *      single most useful event for confirming the windows are live;
 *   3. otherwise at most once per HEARTBEAT_MS/lane — so a lane that is stuck
 *      skipping still leaves a periodic trace rather than silence.
 *
 * That is ~100-200 lines/day: readable, and sufficient to distinguish the two
 * cases above. State is per-isolate and best-effort; a cold isolate simply
 * logs its first decision, which is the safe direction.
 */

import type { DayType, ProbeSource, ProbeTier } from './probeSchedule.ts';

/** Which authority produced this decision. Never two at once — see the
 *  composition rule in probeSchedule.ts: the lease decides WHO probes, the
 *  schedule decides HOW OFTEN, and the schedule is only ever consulted inside
 *  a lease-granted branch. */
export type ProbeCadenceAuthority =
  /** probeSchedule.ts measured windows decided. */
  | 'schedule'
  /** Legacy poll_config windows decided (schedule disabled or overridden). */
  | 'poll-window'
  /** probeLease.ts declined the lane; the schedule was never consulted. */
  | 'lease';

export interface ProbeCadenceEvent {
  /** Lane identity for the log line: 'house', 'senate', 'provider:quiver'. */
  readonly lane: string;
  readonly source: ProbeSource;
  readonly probe: boolean;
  /** 'none' when the decision was made before any tier was resolved (lease
   *  denial, hard kill switch) — never silently reported as a real tier. */
  readonly tier: ProbeTier | 'none';
  readonly dayType: DayType | 'n/a';
  readonly intervalSec: number;
  /** Infinity renders as `never` (no prior probe on record). */
  readonly elapsedSec: number;
  readonly authority: ProbeCadenceAuthority;
  readonly reason: string;
}

/** How long a lane may stay quiet before a heartbeat line is forced. */
export const PROBE_CADENCE_HEARTBEAT_MS = 15 * 60_000;

interface LaneLogState {
  tier: ProbeTier | 'none';
  loggedAtMs: number;
}

const laneState = new Map<string, LaneLogState>();

function fmtElapsed(sec: number): string {
  if (!Number.isFinite(sec)) return 'never';
  return `${Math.round(sec)}s`;
}

/**
 * Decide whether this event is worth a log line, and emit it if so.
 *
 * Returns true when a line was written — the return value exists so tests can
 * assert the throttle without scraping console output.
 */
export function logProbeCadence(event: ProbeCadenceEvent, now: Date = new Date()): boolean {
  const nowMs = now.getTime();
  const prev = laneState.get(event.lane);
  const tierChanged = prev?.tier !== event.tier;
  const staleHeartbeat = !prev || nowMs - prev.loggedAtMs >= PROBE_CADENCE_HEARTBEAT_MS;

  if (!event.probe && !tierChanged && !staleHeartbeat) {
    // Still record the tier so a change is detected even when we stayed quiet.
    if (prev) prev.tier = event.tier;
    return false;
  }

  laneState.set(event.lane, { tier: event.tier, loggedAtMs: nowMs });

  const line =
    `probe cadence: ${event.lane} ${event.probe ? 'probe' : 'skip'} ` +
    `tier=${event.tier} window=${event.dayType} interval=${Math.round(event.intervalSec)}s ` +
    `elapsed=${fmtElapsed(event.elapsedSec)} reason=${event.reason} authority=${event.authority}`;

  // Skips are routine by design and must not read as faults; a lane the lease
  // took away is likewise normal. Only surface at warn when the schedule is not
  // the thing in charge, which is the case an operator has to know about.
  if (event.authority === 'poll-window' && !event.probe) console.warn(line);
  else console.log(line);
  return true;
}

/** Test hook — the throttle is per-isolate state, so tests must be able to
 *  clear it between cases. */
export function _resetProbeCadenceLog(): void {
  laneState.clear();
}
