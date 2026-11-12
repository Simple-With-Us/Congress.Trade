/**
 * src/ingestion/probeSchedule.ts
 *
 * ADAPTIVE PROBE CADENCE — proportional allocation of a FIXED daily probe
 * budget across measured filing-arrival windows, clamped by a coverage floor
 * and a peak:trough ratio ceiling, then renormalised so the budget still fits.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE IS (and is not)
 * ---------------------------------------------------------------------------
 * This module decides HOW OFTEN a source should be probed. It does NOT decide
 * WHO probes (server vs Mac — that is the lease in scoutHandoff.ts), it does
 * NOT perform I/O, and it never writes anything. Every exported function is
 * pure and deterministic: same (source, clock, config) in, same answer out.
 *
 * It is designed to be adopted by three existing callers WITHOUT this module
 * having to know anything about them:
 *   1. shared/config.ts    shouldPollNow()               -> probeIntervalSecAt()
 *   2. ingestion/watcher.ts                              -> passes the source id
 *   3. ingestion/tradeLatency.ts disclosurePublishYieldWeight() -> probeYieldWeightAt()
 * See app/docs/probe-schedule.md for the exact integration diff.
 *
 * ---------------------------------------------------------------------------
 * THE ALLOCATION RULE (owner spec, 2026-08-11)
 * ---------------------------------------------------------------------------
 * "if X times more likely for filing to be during X timeframe then it is wise
 *  to have X times more checks during that timeframe ... but make it
 *  proportional to how often filings are released during that timeframe based
 *  on historical data ... while still ensuring some baseline of checks at
 *  minimum ... don't let it be more than 4x as often during peaks as lowest
 *  times or whatever you recommend."
 *
 * Implemented literally, as arithmetic, in `allocateProbes()`:
 *
 *   a. w_i  = measured arrival-event share of window i  (see MEASURED_* below)
 *   b. n_i  = w_i * B                                   (proportional, pre-clamp)
 *   c. FLOOR:   n_i >= ceil(T_i / maxIntervalSec)        (no window is starved)
 *   d. CEILING: n_i <= floor(T_i / peakFloorIntervalSec) where
 *               peakFloorIntervalSec = max(minIntervalSec, maxIntervalSec / R)
 *               so peak cadence is never more than R x trough cadence
 *   e. RENORMALISE: water-fill the residual budget over the windows that are
 *      still unclamped, proportional to their w_i, iterating to a fixpoint.
 *      Without this step the clamps would silently blow the cap.
 *
 * `allocateProbes()` reports BOTH the pre-clamp (`proportionalProbes`) and
 * post-clamp (`probes`) numbers on every window so the cost of the clamp is
 * visible rather than buried.
 *
 * ---------------------------------------------------------------------------
 * BUDGET ARITHMETIC (the "provably under cap" proof)
 * ---------------------------------------------------------------------------
 * Two independent guarantees, both asserted in __tests__/probeSchedule.test.ts:
 *
 *   (1) ALLOCATION: sum(n_i) <= effectiveBudget = floor(B * (1 - retryHeadroom))
 *       <= B. Enforced by the water-fill: the residual handed to unclamped
 *       windows is (effectiveBudget - sum(clamped n_i)), never more; and the
 *       integer rounding step only ever hands out the exact shortfall.
 *       If the FLOORS alone exceed the budget (a mis-retune), the floors are
 *       scaled back and `degraded: true` is set — the cap always wins.
 *
 *   (2) REALISED: intervalSec_i = ceil(T_i / n_i), so probes actually taken in
 *       window i = floor(T_i / intervalSec_i) <= n_i. Ceil (not round) is what
 *       makes this hold. The watcher ticks once per minute, which discretises
 *       the interval upward again, so realised spend is strictly <= planned.
 *
 * Worked example, HOUSE weekday, B = 171 probes/day (today's spend), 10% retry
 * headroom => effectiveBudget = 153:
 *
 *   window                 T_i (s)   events  w_i     n_i(prop)  n_i(final)  interval
 *   PEAK  08:55-09:40 ET      2700     25    .78125     119.5       45         60s
 *   HIGH  09:40-12:00 ET      8400      3    .09375      14.3       35        240s
 *   MID   12:00-20:00 ET     28800      4    .12500      19.1       46        627s
 *   LOW   20:00-08:55 ET     46500      0    .00000       0.0       26       1789s
 *                            -----                       -----     ---
 *                            86400                       153       152  <= 153 <= 171
 *
 *   PEAK was cut 119.5 -> 45 by the 60s politeness floor; LOW was raised
 *   0 -> 26 by the 30-minute coverage floor; the 82 probes freed by the PEAK
 *   clamp were water-filled back into HIGH and MID in their 3:4 weight ratio.
 *   Achieved peak:trough = 1789 / 60 = 29.8x.
 *
 * WHAT THE TROUGH DROPS TO (stated plainly, as required):
 *   weekday 20:00-08:55 ET : 1200s (20 min) -> 1789s (~30 min)   WORSE
 *   weekday 12:00-20:00 ET :  300s ( 5 min) ->  627s (~10.5 min) WORSE
 *   weekday 09:40-12:00 ET :  300s ( 5 min) ->  240s ( 4 min)    better
 *   weekday 08:55-09:40 ET :  300s ( 5 min) ->   60s ( 1 min)    5x better
 *   weekend                : 3600s (60 min) -> 3600s (60 min)    unchanged
 *
 * The overnight and mid-day windows are what pay for the 09:00 burst. That is
 * the reallocation; the daily total does not go up. Weekend cadence is left
 * exactly as it is today because the budget is per-DAY: cutting Saturday buys
 * nothing for Monday, so cutting it would be pure loss.
 *
 * A 30-minute weekday / 60-minute weekend floor is far inside the
 * `pollSuccessMaxAgeHours` = 6h liveness thresholds in shared/pipelineHealth.ts,
 * so no health check regresses.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FLOOR IS 30 MINUTES (not a round number picked for looks)
 * ---------------------------------------------------------------------------
 * Derived from the worst acceptable detection delay, not from aesthetics. A
 * filing published at 03:00 ET has no market consequence until the 09:30 ET
 * open; detecting it by 03:30 leaves six hours of margin, so overnight latency
 * is worth ~nothing competitively. What overnight coverage IS worth:
 *   - off-schedule / corrected publications, which do happen;
 *   - the durable per-attempt liveness receipts the polling_house /
 *     polling_senate health checks depend on;
 *   - never being able to say "we were not looking".
 * 30 minutes buys all three at 26 probes/day (17% of the House budget).
 * Zero is never permitted for any window: `probes >= 1` is a hard invariant.
 *
 * ---------------------------------------------------------------------------
 * WHY R = 30 AND NOT THE SUGGESTED 4
 * ---------------------------------------------------------------------------
 * The owner invited a recommendation. The measured peak:trough YIELD ratio is
 * unbounded (78% of House arrival events land in one 45-minute window; 0 of 32
 * events landed in the 13 overnight hours across 380 covered polling-hours), so
 * the clamp is doing pure damage-limitation, not tracking the data.
 *
 * The tail is ALREADY protected by the absolute 30-minute floor, which is a
 * strictly stronger and more legible guarantee than a ratio: "every window,
 * every hour, at least one probe every 30 minutes". The ratio ceiling is a
 * second, redundant guard whose only remaining effect is to cap the peak.
 *
 * R = 4 with a 30-minute floor forces peakFloorIntervalSec = 450s, i.e. a
 * 7.5-MINUTE cadence across the 09:00 burst — worse than today's 300s, and it
 * strands ~25% of the daily budget as unspendable (every window saturates at
 * the ratio ceiling with probes left over). Run
 * `allocateProbes(HOUSE_PROFILE, 'weekday', { peakTroughRatioCap: 4 })` to see
 * it; the test suite pins that outcome.
 *
 * R = 30 makes the ratio ceiling coincide exactly with the 60s politeness
 * floor, i.e. the floor binds and the ratio never does. That is the honest
 * design: ONE binding constraint (60s), not two fighting each other. R stays
 * configurable so the owner can dial it back and see the cost directly.
 *
 * ---------------------------------------------------------------------------
 * TIER COUNT RECOMMENDATION: 4 for House and providers, 3 for Senate
 * ---------------------------------------------------------------------------
 * Recommended from the measured curve, per source, not a uniform guess:
 *   HOUSE (n = 32 arrival events / 27 days) -> 4 tiers. The curve genuinely has
 *     four regimes: a 45-minute burst (78%), a late-morning shoulder (9%), a
 *     low-but-nonzero business tail (13%), and a 13-hour measured zero. Two
 *     tiers cannot express both a 45-minute burst and a 13-hour zero without
 *     wasting one of them; 5+ would over-fit 32 events.
 *   SENATE (n = 10 events / 7 days) -> 3 tiers. The 12:00-16:00 and 18:00-21:00
 *     densities are 0.75 and 0.67 events/hour: indistinguishable at n = 10.
 *     Splitting them would be inventing structure the sample cannot support, so
 *     they are merged into one HIGH tier. This is the honest answer, not the
 *     thorough-looking one.
 *   PROVIDERS -> 4 tiers, on the UNION of both chambers' peaks, because one
 *     provider call covers both chambers.
 *
 * ---------------------------------------------------------------------------
 * PROVENANCE + EXPIRY
 * ---------------------------------------------------------------------------
 * Windows come from a 52-day measurement (2026-06-21 .. 2026-08-11) over the
 * production SQLite store, filtered to arrivals attributable to a logged poll
 * of the same source within 30 minutes and exposure-normalised per ET hour
 * (24-32 covered hours in every bucket, so the concentration is not a polling
 * artifact). Full method + tables: app/docs/probe-schedule.md.
 *
 * TWO CAVEATS THE NUMBERS CARRY:
 *   - The window is entirely inside the August recess run-up, which suppresses
 *     volume. It locates the WINDOWS reliably; it is thin for permanent
 *     WEIGHTS. Re-measure in a session month.
 *   - Senate n = 10 events over 7 days is directional only.
 * Both are why every boundary and weight is overridable from config without a
 * deploy (see probeScheduleConfigFromEnv). Deriving the windows from a rolling
 * query instead of this frozen table is the logical next step and is left as a
 * documented follow-up rather than gold-plated here.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** 4-level cadence tier. Deliberately the same vocabulary as
 *  tradeLatency.ts's DisclosurePublishYieldBand so that call site is a
 *  one-line swap with no type churn. */
export type ProbeTier = 'peak' | 'high' | 'mid' | 'low';

/** Probe targets with independent cadence curves. `provider` covers the
 *  metered latency providers (Unusual Whales / Quiver / FMP), which fetch both
 *  chambers in one call and therefore need the union of both peaks. */
export type ProbeSource = 'house' | 'senate' | 'provider' | 'executive';

export const PROBE_SOURCES: readonly ProbeSource[] = ['house', 'senate', 'provider', 'executive'];

export type DayType = 'weekday' | 'weekend';

/** A half-open [startMinuteET, endMinuteET) range, minutes since ET midnight.
 *  end may exceed 1440 to express a window that wraps past midnight. */
export type MinuteRange = readonly [number, number];

export interface ProbeWindowSpec {
  readonly tier: ProbeTier;
  /** One or more disjoint ranges. A tier may be non-contiguous (the Senate's
   *  HIGH tier is 12:00-16:00 plus 18:00-21:00). */
  readonly ranges: readonly MinuteRange[];
  /** Measured arrival EVENTS in this window — the proportional weight input.
   *  Events (distinct "a new batch appeared") rather than filing counts,
   *  because two single-day bursts distort the filing counts badly. */
  readonly events: number;
  readonly note?: string;
}

export interface ProbeProfile {
  readonly source: ProbeSource;
  readonly weekday: readonly ProbeWindowSpec[];
  readonly weekend: readonly ProbeWindowSpec[];
  /** Probes (not HTTP calls) permitted per weekday / weekend day. */
  readonly weekdayBudget: number;
  readonly weekendBudget: number;
  /** Optional per-source politeness floor. Unset = global tuning. */
  readonly minIntervalSec?: number;
  /** Optional per-source weekday coverage floor (longest gap). Unset = global. */
  readonly maxIntervalSec?: number;
  /** Optional per-source weekend coverage floor. Unset = global. */
  readonly weekendMaxIntervalSec?: number;
}

export interface ProbeScheduleTuning {
  /** Never probe faster than this. Politeness toward public .gov endpoints
   *  and free-tier providers; matches tradeLatency.ts's existing 60s floor. */
  readonly minIntervalSec: number;
  /** COVERAGE FLOOR: no window may ever go longer than this between probes. */
  readonly maxIntervalSec: number;
  /** Coverage floor on weekend days (publication activity is ~zero). */
  readonly weekendMaxIntervalSec: number;
  /** R: peak cadence may not exceed R x trough cadence. */
  readonly peakTroughRatioCap: number;
  /** Fraction of the daily budget withheld for retries / failure backoff. */
  readonly retryHeadroom: number;
  /** Exponent on the measured mass when allocating. 1.0 = the owner's literal
   *  proportional rule (the default, and what ships). 0.5 would be the
   *  expected-detection-latency optimum (minimising sum(p_i * T_i / 2 n_i)
   *  subject to sum(n_i) = B gives n_i proportional to sqrt(p_i * T_i)) — it
   *  is exposed as a knob, NOT substituted, because proportional is what was
   *  asked for and it is the more legible rule. */
  readonly allocationExponent: number;
}

export interface ProbeScheduleConfig extends ProbeScheduleTuning {
  readonly enabled: boolean;
  readonly profiles: Readonly<Record<ProbeSource, ProbeProfile>>;
}

export interface AllocatedWindow {
  readonly tier: ProbeTier;
  readonly ranges: readonly MinuteRange[];
  readonly coveredSec: number;
  readonly events: number;
  /** Normalised measured share of arrivals, 0..1. */
  readonly weight: number;
  /** Pre-clamp proportional allocation (may be fractional, may be 0). */
  readonly proportionalProbes: number;
  /** Post-clamp, post-renormalise, integer. Always >= 1. */
  readonly probes: number;
  readonly intervalSec: number;
  /** Which bound moved this window off its proportional share.
   *  `coverage-floor`  = raised, the window was starved by proportionality;
   *  `cadence-ceiling` = capped, proportionality wanted to probe faster than
   *                      max(minIntervalSec, maxIntervalSec / R) allows. */
  readonly clampedBy: 'none' | 'coverage-floor' | 'cadence-ceiling';
  readonly note?: string;
}

export interface ProbeAllocation {
  readonly source: ProbeSource;
  readonly dayType: DayType;
  /** The configured daily cap. */
  readonly budget: number;
  /** budget minus retry headroom — what the allocator is allowed to spend. */
  readonly effectiveBudget: number;
  /** Sum of window probes. Invariant: <= effectiveBudget <= budget. */
  readonly allocatedProbes: number;
  readonly windows: readonly AllocatedWindow[];
  readonly peakIntervalSec: number;
  readonly troughIntervalSec: number;
  readonly achievedPeakTroughRatio: number;
  /** True when the coverage floors alone could not fit the budget and had to
   *  be relaxed. The cap always wins; this flag makes the compromise loud. */
  readonly degraded: boolean;
}

export interface ProbeDecision {
  readonly probe: boolean;
  readonly tier: ProbeTier;
  readonly intervalSec: number;
  readonly elapsedSec: number;
  readonly dayType: DayType;
  readonly reason: 'never-probed' | 'interval-elapsed' | 'too-soon' | 'disabled';
}

// ---------------------------------------------------------------------------
// Eastern Time clock (DST-correct)
// ---------------------------------------------------------------------------

/**
 * Minute-of-day (0..1439) and weekday (0=Sun..6=Sat) in America/New_York.
 *
 * Mirrors shared/config.ts etParts() but resolves to the MINUTE, which the
 * hour-only helper cannot express and which this schedule needs (the House
 * peak starts at 08:55 and ends at 09:40). A fixed UTC-4 offset would be
 * correct for the measurement window and silently wrong from 2026-11-01, so
 * this goes through Intl like the rest of the codebase.
 */
// Hoisted: constructing an Intl.DateTimeFormat is expensive (tens of
// microseconds) and this runs on every cron tick for every source. The
// formatter is immutable and thread-confined in both Workers and Deno, so one
// module-level instance is safe and roughly two orders of magnitude cheaper
// than building it per call.
const ET_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  weekday: 'short',
});

export function etClock(now: Date): { minuteOfDayET: number; dayOfWeekET: number } {
  const parts = ET_FORMAT.formatToParts(now);
  const pick = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';

  let hour = parseInt(pick('hour'), 10);
  if (!Number.isFinite(hour) || hour === 24) hour = 0;
  let minute = parseInt(pick('minute'), 10);
  if (!Number.isFinite(minute)) minute = 0;

  const weekdayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  const dayOfWeekET = weekdayMap[pick('weekday')] ?? now.getUTCDay();

  return { minuteOfDayET: hour * 60 + minute, dayOfWeekET };
}

export function dayTypeFor(dayOfWeekET: number): DayType {
  return dayOfWeekET === 0 || dayOfWeekET === 6 ? 'weekend' : 'weekday';
}

const MIN = 60;
const HOUR = 60;
const DAY_MINUTES = 24 * 60;
const DAY_SECONDS = 24 * 60 * 60;

/** Minutes since ET midnight for a wall-clock h:m. */
const at = (h: number, m = 0): number => h * HOUR + m;

// ---------------------------------------------------------------------------
// MEASURED WINDOWS — the frozen distribution table (provenance in the header)
// ---------------------------------------------------------------------------

/**
 * HOUSE. 32 arrival events across 27 days. Events by ET hour:
 *   09 -> 25 | 10 -> 2 | 11 -> 1 | 13 -> 1 | 14 -> 1 | 16 -> 1 | 19 -> 1
 *   00-08, 12, 15, 17, 18, 20-23 -> 0 (across ~381 covered polling-hours)
 * First-arrival-of-day quantiles: p25 09:01, median 09:02, p75 09:06; the
 * latest first-arrival on any of the 27 days was 09:19.
 *
 * THE ONE INTERPOLATION IN THIS TABLE: hour 09's 25 events are credited
 * entirely to the 08:55-09:40 PEAK window. Events were measured at hour
 * granularity, so a strict reading cannot place them inside the hour; the
 * daily first-arrival list (every single one at or before 09:19) is what
 * justifies it. Tightening or widening PEAK is the first thing to revisit once
 * sub-hour event counts exist — it is also the highest-leverage boundary here,
 * since PEAK saturates the 60s floor and every minute of width costs a probe.
 */
export const HOUSE_WEEKDAY_WINDOWS: readonly ProbeWindowSpec[] = [
  {
    tier: 'peak',
    ranges: [[at(8, 55), at(9, 40)]],
    events: 25,
    note: 'House Clerk morning batch; 21/27 days first-arrived 09:00-09:06 ET, none later than 09:19. 5-min lead-in so a probe is in flight before the first possible arrival.',
  },
  {
    tier: 'high',
    ranges: [[at(9, 40), at(12)]],
    events: 3,
    note: 'Late-morning shoulder (hours 10 and 11).',
  },
  {
    tier: 'mid',
    ranges: [[at(12), at(20)]],
    events: 4,
    note: 'Low-but-nonzero business tail (hours 13, 14, 16, 19).',
  },
  {
    tier: 'low',
    ranges: [[at(20), at(24)], [at(0), at(8, 55)]],
    events: 0,
    note: 'Measured zero across ~381 covered polling-hours. Held open by the coverage floor, never by measured yield.',
  },
];

/**
 * SENATE. 10 arrival events across 7 days — DIRECTIONAL ONLY. Events by ET
 * hour: 12 -> 1 | 13 -> 1 | 14 -> 1 | 16 -> 2 | 17 -> 3 | 19 -> 1 | 20 -> 1.
 * First-arrival-of-day median 16:05 ET.
 *
 * Three tiers, not four: 12:00-16:00 (0.75 events/h) and 18:00-21:00
 * (0.67 events/h) are statistically indistinguishable at n = 10, so they are
 * one tier rather than a fabricated HIGH/MID split.
 *
 * The Senate rhythm is the INVERSE of the House's — afternoon/evening, diffuse
 * rather than bursty. A single global curve (which is what ships today) is
 * wrong for both chambers at once.
 */
export const SENATE_WEEKDAY_WINDOWS: readonly ProbeWindowSpec[] = [
  {
    tier: 'peak',
    ranges: [[at(16), at(18)]],
    events: 5,
    note: 'Senate eFD afternoon concentration (2.5 events/h).',
  },
  {
    tier: 'high',
    ranges: [[at(12), at(16)], [at(18), at(21)]],
    events: 5,
    note: 'Merged shoulder: 0.75 and 0.67 events/h are one population at n=10, not two tiers.',
  },
  {
    tier: 'low',
    ranges: [[at(21), at(24)], [at(0), at(12)]],
    events: 0,
    note: 'Measured zero across ~336 covered polling-hours.',
  },
];

/**
 * PROVIDERS (Unusual Whales / Quiver / FMP). One call covers both chambers, so
 * the curve is the UNION of both peaks. Combined events by ET hour:
 *   09 -> 25 | 10 -> 2 | 11 -> 1 | 12 -> 1 | 13 -> 2 | 14 -> 2
 *   16 -> 3  | 17 -> 3 | 19 -> 2 | 20 -> 1 | rest -> 0   (42 total)
 *
 * Note this shape is inherited from OUR sources, not measured on the providers
 * themselves: trade_provider_observations.first_observed_at stamps when the
 * probe ran, not when the provider published (988 rows collapse into 78
 * distinct instants), so it measures our own scheduler and nothing else.
 * Populating the existing, near-empty provider_published_at column is the one
 * change that would make a genuinely provider-specific curve measurable.
 */
export const PROVIDER_WEEKDAY_WINDOWS: readonly ProbeWindowSpec[] = [
  { tier: 'peak', ranges: [[at(9), at(10)]], events: 25, note: 'House burst, hour granularity (providers lag the primary source, so no sub-hour precision is warranted).' },
  { tier: 'high', ranges: [[at(16), at(18)]], events: 6, note: 'Senate afternoon concentration.' },
  { tier: 'mid', ranges: [[at(10), at(16)], [at(18), at(21)]], events: 11, note: 'Combined business-hours tail.' },
  { tier: 'low', ranges: [[at(21), at(24)], [at(0), at(9)]], events: 0, note: 'Measured zero for both chambers.' },
];

/**
 * WEEKEND, all sources: one flat LOW tier at the weekend coverage floor.
 * Source-side filed_date shows 6-8% weekend share, but that is the MEMBER's
 * filing date; publication is next-business-day (10 of the 80 House 09:00-hour
 * arrivals carry a 3-day lag, i.e. Friday filings surfacing Monday morning).
 * Publication-side weekend volume is effectively zero.
 *
 * Deliberately NOT cut below today's 3600s: the budget is per-DAY, so a
 * cheaper Saturday cannot fund a denser Monday. Cutting it would be pure loss.
 */
export const WEEKEND_WINDOWS: readonly ProbeWindowSpec[] = [
  {
    tier: 'low',
    ranges: [[at(0), at(24)]],
    events: 0,
    note: 'No measured weekend publication activity in either chamber; held at the weekend coverage floor.',
  },
];

// ---------------------------------------------------------------------------
// Default profiles
// ---------------------------------------------------------------------------

/**
 * HOUSE weekday budget = 171 probes, which is exactly what today's
 * DEFAULT_SCHEDULE spends (11h @ 300s = 132, 5h @ 1200s = 15, 8h @ 1200s = 24).
 * This is a self-imposed politeness budget, NOT a documented Clerk rate limit —
 * no such limit is published. It is therefore the single knob to raise if the
 * mid-day cadence regression (300s -> ~613s) proves unacceptable in practice.
 *
 * Weekend budget = 27 so that after the 10% retry headroom the allocator has
 * exactly 24 probes = 86400/3600, i.e. today's 60-minute weekend cadence,
 * unchanged. (Setting the cap to 24 would leave 21 spendable and quietly make
 * the weekend WORSE than today — the headroom has to sit above the floor, not
 * eat into it.)
 */
export const HOUSE_PROFILE: ProbeProfile = {
  source: 'house',
  weekday: HOUSE_WEEKDAY_WINDOWS,
  weekend: WEEKEND_WINDOWS,
  weekdayBudget: 171,
  weekendBudget: 27,
};

export const SENATE_PROFILE: ProbeProfile = {
  source: 'senate',
  weekday: SENATE_WEEKDAY_WINDOWS,
  weekend: WEEKEND_WINDOWS,
  weekdayBudget: 171,
  weekendBudget: 27,
};

/**
 * PROVIDER budget is a NOMINAL default only. Real provider budgets are
 * per-provider and dynamic (remaining daily quota), so tradeLatency.ts keeps
 * owning that arithmetic; it consumes probeYieldWeightAt(), which is a
 * budget-independent SHAPE normalised to a time-average of 1.0. 240 matches
 * the Unusual Whales cap (240 calls / 1 call per run) so the nominal table is
 * anchored to a real quota rather than an invented one.
 */
export const PROVIDER_PROFILE: ProbeProfile = {
  source: 'provider',
  weekday: PROVIDER_WEEKDAY_WINDOWS,
  weekend: WEEKEND_WINDOWS,
  weekdayBudget: 240,
  // 36 -> 32 spendable -> 2700s, matching the 45-minute maxIntervalSec the
  // existing LATENCY_SOURCE_BUDGETS specs already use for these providers.
  weekendBudget: 36,
};

/**
 * EXECUTIVE (OGE 278-T). No measured arrival-hour sample exists in-repo.
 * Do not invent House-style 78% peak weights. One flat weekday window uses
 * the same floor/peak machinery with a conservative 15-minute coverage floor
 * (never 6 hours) and the shared 60s politeness floor. Weekend stays hourly
 * like House. Re-measure before adding peak/high/mid tiers.
 *
 * Weekday budget 107 → 96 spendable after 10% headroom = 86400/900.
 * Weekend budget 27 → 24 spendable = 86400/3600.
 */
export const EXECUTIVE_WEEKDAY_WINDOWS: readonly ProbeWindowSpec[] = [
  {
    tier: 'low',
    ranges: [[at(0), at(24)]],
    events: 0,
    note: 'No measured OGE arrival-hour sample in-repo. Flat weekday window at the 15-minute coverage floor. Do not invent peak weights.',
  },
];

export const EXECUTIVE_WEEKDAY_MAX_INTERVAL_SEC = 15 * MIN;
export const EXECUTIVE_POLITENESS_MIN_INTERVAL_SEC = 60;

export const EXECUTIVE_PROFILE: ProbeProfile = {
  source: 'executive',
  weekday: EXECUTIVE_WEEKDAY_WINDOWS,
  weekend: WEEKEND_WINDOWS,
  weekdayBudget: 107,
  weekendBudget: 27,
  minIntervalSec: EXECUTIVE_POLITENESS_MIN_INTERVAL_SEC,
  maxIntervalSec: EXECUTIVE_WEEKDAY_MAX_INTERVAL_SEC,
  weekendMaxIntervalSec: 60 * MIN,
};

export const DEFAULT_PROBE_TUNING: ProbeScheduleTuning = {
  minIntervalSec: 60,
  maxIntervalSec: 30 * MIN,
  weekendMaxIntervalSec: 60 * MIN,
  peakTroughRatioCap: 30,
  retryHeadroom: 0.1,
  allocationExponent: 1,
};

export const DEFAULT_PROBE_SCHEDULE_CONFIG: ProbeScheduleConfig = {
  ...DEFAULT_PROBE_TUNING,
  enabled: true,
  profiles: {
    house: HOUSE_PROFILE,
    senate: SENATE_PROFILE,
    provider: PROVIDER_PROFILE,
    executive: EXECUTIVE_PROFILE,
  },
};

// ---------------------------------------------------------------------------
// Window geometry
// ---------------------------------------------------------------------------

function normalizeRanges(ranges: readonly MinuteRange[]): MinuteRange[] {
  const out: MinuteRange[] = [];
  for (const [rawStart, rawEnd] of ranges) {
    const start = clampMinute(rawStart);
    const end = clampMinute(rawEnd);
    if (end <= start) continue;
    out.push([start, end]);
  }
  return out;
}

function clampMinute(m: number): number {
  if (!Number.isFinite(m)) return 0;
  return Math.max(0, Math.min(DAY_MINUTES, Math.round(m)));
}

/** Total seconds covered by a window's ranges. */
export function coveredSecOf(ranges: readonly MinuteRange[]): number {
  let total = 0;
  for (const [start, end] of normalizeRanges(ranges)) total += (end - start) * 60;
  return total;
}

function containsMinute(ranges: readonly MinuteRange[], minute: number): boolean {
  for (const [start, end] of normalizeRanges(ranges)) {
    if (minute >= start && minute < end) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// THE ALLOCATOR
// ---------------------------------------------------------------------------

export interface AllocateOptions extends Partial<ProbeScheduleTuning> {
  /** Override the profile's own daily budget (providers pass their live cap). */
  readonly budget?: number;
}

/**
 * Proportional allocation of a fixed budget over measured windows, clamped by
 * the coverage floor and the peak:trough ratio ceiling, water-filled back to
 * the budget. Pure; see the module header for the rule it implements.
 */
export function allocateProbes(
  profile: ProbeProfile,
  dayType: DayType,
  opts: AllocateOptions = {},
): ProbeAllocation {
  const tuning: ProbeScheduleTuning = {
    ...DEFAULT_PROBE_TUNING,
    ...stripUndefined(opts),
    // Per-source floors win over the global House/Senate 30-minute coverage
    // floor. Executive ships a 15-minute weekday floor; House/Senate unset.
    ...stripUndefined({
      minIntervalSec: profile.minIntervalSec,
      maxIntervalSec: profile.maxIntervalSec,
      weekendMaxIntervalSec: profile.weekendMaxIntervalSec,
    }),
  };
  const specs = (dayType === 'weekday' ? profile.weekday : profile.weekend).filter(
    (w) => coveredSecOf(w.ranges) > 0,
  );

  const budget = Math.max(
    1,
    Math.floor(opts.budget ?? (dayType === 'weekday' ? profile.weekdayBudget : profile.weekendBudget)),
  );
  const headroom = Math.min(0.5, Math.max(0, tuning.retryHeadroom));
  const effectiveBudget = Math.max(specs.length, Math.floor(budget * (1 - headroom)));

  const maxIntervalSec = Math.max(
    tuning.minIntervalSec,
    dayType === 'weekend' ? tuning.weekendMaxIntervalSec : tuning.maxIntervalSec,
  );
  // The ratio ceiling, expressed as an interval floor. Derived from the fixed
  // coverage floor rather than from the observed trough so the bound is
  // deterministic and independent of allocation order.
  const ratioCap = Math.max(1, tuning.peakTroughRatioCap);
  const peakFloorIntervalSec = Math.max(tuning.minIntervalSec, maxIntervalSec / ratioCap);

  const covered = specs.map((w) => coveredSecOf(w.ranges));

  // (a) weights: measured mass, exponent-shaped. All-zero mass (e.g. weekend)
  // falls back to duration-proportional so the water-fill has something to
  // spread by rather than dividing by zero.
  const exponent = Math.max(0.1, Math.min(2, tuning.allocationExponent));
  const rawWeights = specs.map((w) => Math.pow(Math.max(0, w.events), exponent));
  const rawTotal = rawWeights.reduce((a, b) => a + b, 0);
  const coveredTotal = covered.reduce((a, b) => a + b, 0) || 1;
  const weights = rawTotal > 0
    ? rawWeights.map((x) => x / rawTotal)
    : covered.map((c) => c / coveredTotal);

  // (c) FLOOR and (d) CEILING as integer probe bounds per window.
  const floors = covered.map((c) => Math.max(1, Math.ceil(c / maxIntervalSec)));
  const ceilings = covered.map((c, i) => Math.max(floors[i], Math.max(1, Math.floor(c / peakFloorIntervalSec))));

  // If the floors alone do not fit, the CAP wins: relax the floors uniformly
  // toward the budget and flag it. A schedule must never be able to exceed the
  // cap, so an infeasible retune degrades coverage rather than overspending.
  const floorTotal = floors.reduce((a, b) => a + b, 0);
  let degraded = false;
  if (floorTotal > effectiveBudget) {
    degraded = true;
    const scale = effectiveBudget / floorTotal;
    for (let i = 0; i < floors.length; i++) floors[i] = Math.max(1, Math.floor(floors[i] * scale));
    for (let i = 0; i < ceilings.length; i++) ceilings[i] = Math.max(floors[i], ceilings[i]);
  }

  // (b) proportional pre-clamp allocation, kept for reporting.
  const proportional = weights.map((w) => w * effectiveBudget);

  // (e) water-fill: clamp, then redistribute the residual over the still-free
  // windows in their weight ratio, to a fixpoint. Bounded iteration count.
  const n = proportional.slice();
  const fixed = new Array<boolean>(specs.length).fill(false);
  for (let round = 0; round <= specs.length + 1; round++) {
    let changed = false;
    for (let i = 0; i < n.length; i++) {
      if (fixed[i]) continue;
      if (n[i] < floors[i]) { n[i] = floors[i]; fixed[i] = true; changed = true; } else if (n[i] > ceilings[i]) { n[i] = ceilings[i]; fixed[i] = true; changed = true; }
    }
    if (!changed) break;

    let fixedSum = 0;
    for (let i = 0; i < n.length; i++) if (fixed[i]) fixedSum += n[i];
    const residual = effectiveBudget - fixedSum;
    const freeIdx = specs.map((_, i) => i).filter((i) => !fixed[i]);
    if (freeIdx.length === 0) break;
    if (residual <= 0) {
      for (const i of freeIdx) { n[i] = floors[i]; fixed[i] = true; }
      break;
    }
    let freeWeight = 0;
    for (const i of freeIdx) freeWeight += weights[i];
    // Zero measured mass among the free windows: spread by duration so the
    // residual is still spent rather than silently discarded.
    const share = freeWeight > 0
      ? (i: number) => weights[i] / freeWeight
      : (i: number) => covered[i] / (freeIdx.reduce((a, j) => a + covered[j], 0) || 1);
    for (const i of freeIdx) n[i] = residual * share(i);
  }

  // Integer rounding: floor everything (never overspend), then hand the exact
  // shortfall to the largest fractional remainders, respecting the ceilings.
  const ints = n.map((x, i) => Math.max(floors[i], Math.min(ceilings[i], Math.floor(x))));
  let spent = ints.reduce((a, b) => a + b, 0);
  if (spent > effectiveBudget) {
    // Only reachable via the degraded path; trim from the lowest-weight window.
    const order = specs.map((_, i) => i).sort((a, b) => weights[a] - weights[b]);
    for (const i of order) {
      while (spent > effectiveBudget && ints[i] > 1) { ints[i]--; spent--; }
      if (spent <= effectiveBudget) break;
    }
  } else if (spent < effectiveBudget) {
    const remainders = specs
      .map((_, i) => ({ i, frac: n[i] - Math.floor(n[i]) }))
      .sort((a, b) => b.frac - a.frac);
    let guard = 0;
    while (spent < effectiveBudget && guard < effectiveBudget + specs.length) {
      let handedOut = false;
      for (const { i } of remainders) {
        if (spent >= effectiveBudget) break;
        if (ints[i] < ceilings[i]) { ints[i]++; spent++; handedOut = true; }
      }
      if (!handedOut) break;
      guard++;
    }
  }

  const windows: AllocatedWindow[] = specs.map((w, i) => {
    // ceil, not round: guarantees floor(coveredSec / intervalSec) <= probes,
    // i.e. the realised spend can never exceed the plan. Deliberately NOT
    // clamped down to maxIntervalSec — when probes >= floor that clamp is
    // redundant, and on the degraded path it would silently take MORE probes
    // than were allocated, breaking the cap guarantee it is meant to protect.
    const intervalSec = Math.max(
      tuning.minIntervalSec,
      Math.ceil(covered[i] / Math.max(1, ints[i])),
    );
    const clampedBy: AllocatedWindow['clampedBy'] = proportional[i] < floors[i]
      ? 'coverage-floor'
      : proportional[i] > ceilings[i]
        ? 'cadence-ceiling'
        : 'none';
    return {
      tier: w.tier,
      ranges: normalizeRanges(w.ranges),
      coveredSec: covered[i],
      events: w.events,
      weight: weights[i],
      proportionalProbes: Math.round(proportional[i] * 10) / 10,
      probes: ints[i],
      intervalSec,
      clampedBy,
      note: w.note,
    };
  });

  const intervals = windows.map((w) => w.intervalSec);
  const peakIntervalSec = Math.min(...intervals);
  const troughIntervalSec = Math.max(...intervals);

  return {
    source: profile.source,
    dayType,
    budget,
    effectiveBudget,
    allocatedProbes: windows.reduce((a, w) => a + w.probes, 0),
    windows,
    peakIntervalSec,
    troughIntervalSec,
    achievedPeakTroughRatio: Math.round((troughIntervalSec / peakIntervalSec) * 100) / 100,
    degraded,
  };
}

/** Drop explicitly-undefined keys so `{...defaults, ...overrides}` cannot
 *  clobber a default with `undefined`. */
function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}

// ---------------------------------------------------------------------------
// Point queries — the pure decision surface the lease/tick callers adopt
// ---------------------------------------------------------------------------

// Allocations are deterministic in (profile, dayType, tuning) and are consulted
// on every cron tick, so memoize them per isolate. Keyed on the full config
// identity, not just the source, so an env retune is picked up immediately.
const allocationCache = new Map<string, ProbeAllocation>();

/** Compact content signature of a window table. Included in the cache key so
 *  two different tables can never collide just because they happen to have the
 *  same number of windows — a live PROBE_SCHEDULE_JSON retune must always be
 *  seen, never served from a stale entry. */
function windowsSignature(windows: readonly ProbeWindowSpec[]): string {
  return windows
    .map((w) => `${w.tier}:${w.events}:${w.ranges.map(([a, b]) => `${a}-${b}`).join(',')}`)
    .join(';');
}

function allocationFor(
  source: ProbeSource,
  dayType: DayType,
  cfg: ProbeScheduleConfig,
  budgetOverride?: number,
): ProbeAllocation {
  const profile = cfg.profiles[source] ?? DEFAULT_PROBE_SCHEDULE_CONFIG.profiles[source];
  const key = [
    source, dayType, budgetOverride ?? 'default',
    cfg.minIntervalSec, cfg.maxIntervalSec, cfg.weekendMaxIntervalSec,
    profile.minIntervalSec ?? '', profile.maxIntervalSec ?? '', profile.weekendMaxIntervalSec ?? '',
    cfg.peakTroughRatioCap, cfg.retryHeadroom, cfg.allocationExponent,
    profile.weekdayBudget, profile.weekendBudget,
    windowsSignature(dayType === 'weekday' ? profile.weekday : profile.weekend),
  ].join('|');
  const hit = allocationCache.get(key);
  if (hit) return hit;
  const fresh = allocateProbes(profile, dayType, { ...cfg, budget: budgetOverride });
  if (allocationCache.size > 64) allocationCache.clear();
  allocationCache.set(key, fresh);
  return fresh;
}

/** Test hook. The cache key hashes window content, so clearing is not required
 *  for correctness — this exists only to keep memory-behaviour tests honest. */
export function _resetProbeScheduleCache(): void {
  allocationCache.clear();
}

export interface PointQueryOptions {
  readonly config?: ProbeScheduleConfig;
  /** Live daily cap (providers pass remaining-quota-derived budgets). */
  readonly budget?: number;
}

function resolveWindow(
  source: ProbeSource,
  now: Date,
  opts: PointQueryOptions,
): { allocation: ProbeAllocation; window: AllocatedWindow; dayType: DayType } {
  const cfg = opts.config ?? DEFAULT_PROBE_SCHEDULE_CONFIG;
  const { minuteOfDayET, dayOfWeekET } = etClock(now);
  const dayType = dayTypeFor(dayOfWeekET);
  const allocation = allocationFor(source, dayType, cfg, opts.budget);
  const window = allocation.windows.find((w) => containsMinute(w.ranges, minuteOfDayET))
    // Unreachable for the shipped tables (they tile the full day), but a
    // hand-edited PROBE_SCHEDULE_JSON could leave a gap. Fail SAFE: fall back
    // to the slowest window rather than to "never probe".
    ?? allocation.windows.reduce((a, b) => (b.intervalSec > a.intervalSec ? b : a));
  return { allocation, window, dayType };
}

/** Which cadence tier the given instant falls in. Pure. */
export function probeTierAt(source: ProbeSource, now: Date, opts: PointQueryOptions = {}): ProbeTier {
  return resolveWindow(source, now, opts).window.tier;
}

/** Target seconds between probes at the given instant. Pure. */
export function probeIntervalSecAt(source: ProbeSource, now: Date, opts: PointQueryOptions = {}): number {
  return resolveWindow(source, now, opts).window.intervalSec;
}

/**
 * Relative probe-density weight, normalised so the time-average over the day
 * is 1.0. This is the drop-in replacement for tradeLatency.ts's
 * disclosurePublishYieldWeight(): budgetedProbeIntervalSec() computes
 * `interval = (secLeft / runsLeft) / weight`, so a mean-1 weight reshapes the
 * spend across the day WITHOUT changing the daily total — budget-neutral by
 * construction, which is exactly the property that file needs.
 */
export function probeYieldWeightAt(source: ProbeSource, now: Date, opts: PointQueryOptions = {}): number {
  const { allocation, window } = resolveWindow(source, now, opts);
  const meanDensity = allocation.allocatedProbes / DAY_SECONDS;
  if (meanDensity <= 0) return 1;
  const density = window.probes / Math.max(1, window.coveredSec);
  return Math.round((density / meanDensity) * 1000) / 1000;
}

/**
 * "Should <source> be probed right now, given when it was last probed?"
 *
 * Pure and deterministic — no I/O, no clock reads, no env reads. The lease
 * (scoutHandoff.ts) decides WHO probes; this decides only WHETHER it is time.
 */
export function shouldProbeNow(args: {
  source: ProbeSource;
  now: Date;
  lastProbeAt: Date | null;
  config?: ProbeScheduleConfig;
  budget?: number;
}): ProbeDecision {
  const cfg = args.config ?? DEFAULT_PROBE_SCHEDULE_CONFIG;
  const { window, dayType } = resolveWindow(args.source, args.now, {
    config: cfg,
    budget: args.budget,
  });
  const intervalSec = window.intervalSec;

  if (!cfg.enabled) {
    return { probe: false, tier: window.tier, intervalSec, elapsedSec: 0, dayType, reason: 'disabled' };
  }
  if (args.lastProbeAt === null) {
    return { probe: true, tier: window.tier, intervalSec, elapsedSec: Infinity, dayType, reason: 'never-probed' };
  }
  const elapsedSec = (args.now.getTime() - args.lastProbeAt.getTime()) / 1000;
  return elapsedSec >= intervalSec
    ? { probe: true, tier: window.tier, intervalSec, elapsedSec, dayType, reason: 'interval-elapsed' }
    : { probe: false, tier: window.tier, intervalSec, elapsedSec, dayType, reason: 'too-soon' };
}

// ---------------------------------------------------------------------------
// Configuration (env-tunable, no deploy needed)
// ---------------------------------------------------------------------------

/**
 * Env shape this module reads. Declared locally with all-optional string
 * members so the app's `Env` satisfies it structurally without types.ts having
 * to grow — and so nothing outside this lane needs editing to adopt it.
 */
export interface ProbeScheduleEnvLike {
  PROBE_SCHEDULE_ENABLED?: string;
  PROBE_SCHEDULE_MIN_INTERVAL_SEC?: string;
  PROBE_SCHEDULE_MAX_INTERVAL_SEC?: string;
  PROBE_SCHEDULE_WEEKEND_MAX_INTERVAL_SEC?: string;
  PROBE_SCHEDULE_PEAK_TROUGH_RATIO?: string;
  PROBE_SCHEDULE_RETRY_HEADROOM?: string;
  PROBE_SCHEDULE_ALLOCATION_EXPONENT?: string;
  PROBE_SCHEDULE_HOUSE_BUDGET?: string;
  PROBE_SCHEDULE_SENATE_BUDGET?: string;
  PROBE_SCHEDULE_PROVIDER_BUDGET?: string;
  PROBE_SCHEDULE_EXECUTIVE_BUDGET?: string;
  /** Full window-table override; see probeScheduleConfigFromEnv(). */
  PROBE_SCHEDULE_JSON?: string;
}

function num(raw: string | undefined, lo: number, hi: number): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw.trim());
  if (!Number.isFinite(n)) return undefined;
  return Math.min(hi, Math.max(lo, n));
}

function bool(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return undefined;
}

/**
 * Build the live config from env. Pure, total, and never throws: any
 * unparseable or out-of-range value falls back to its default, so a fat-
 * fingered retune degrades to the shipped table instead of stalling ingestion.
 *
 * PROBE_SCHEDULE_JSON accepts a partial override of the window tables:
 *   {"house":{"weekdayBudget":220,
 *             "weekday":[{"tier":"peak","ranges":[[535,580]],"events":25}, ...]}}
 * `ranges` are [startMinuteET, endMinuteET) pairs. Anything malformed is
 * ignored for that source only; the other sources keep their defaults.
 */
export function probeScheduleConfigFromEnv(env: ProbeScheduleEnvLike): ProbeScheduleConfig {
  const base = DEFAULT_PROBE_SCHEDULE_CONFIG;

  const tuning: ProbeScheduleTuning = {
    minIntervalSec: num(env.PROBE_SCHEDULE_MIN_INTERVAL_SEC, 15, 3600) ?? base.minIntervalSec,
    maxIntervalSec: num(env.PROBE_SCHEDULE_MAX_INTERVAL_SEC, 60, 6 * 3600) ?? base.maxIntervalSec,
    weekendMaxIntervalSec: num(env.PROBE_SCHEDULE_WEEKEND_MAX_INTERVAL_SEC, 60, 12 * 3600) ?? base.weekendMaxIntervalSec,
    peakTroughRatioCap: num(env.PROBE_SCHEDULE_PEAK_TROUGH_RATIO, 1, 240) ?? base.peakTroughRatioCap,
    retryHeadroom: num(env.PROBE_SCHEDULE_RETRY_HEADROOM, 0, 0.5) ?? base.retryHeadroom,
    allocationExponent: num(env.PROBE_SCHEDULE_ALLOCATION_EXPONENT, 0.1, 2) ?? base.allocationExponent,
  };

  const budgets: Partial<Record<ProbeSource, number>> = {
    house: num(env.PROBE_SCHEDULE_HOUSE_BUDGET, 24, 5000),
    senate: num(env.PROBE_SCHEDULE_SENATE_BUDGET, 24, 5000),
    provider: num(env.PROBE_SCHEDULE_PROVIDER_BUDGET, 12, 50_000),
    executive: num(env.PROBE_SCHEDULE_EXECUTIVE_BUDGET, 24, 5000),
  };

  let overrides: Record<string, unknown> = {};
  if (env.PROBE_SCHEDULE_JSON) {
    try {
      const parsed: unknown = JSON.parse(env.PROBE_SCHEDULE_JSON);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        overrides = parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed override => shipped table. Never throw on the hot path.
    }
  }

  const profiles = {} as Record<ProbeSource, ProbeProfile>;
  for (const source of PROBE_SOURCES) {
    profiles[source] = mergeProfile(base.profiles[source], overrides[source], budgets[source]);
  }

  return {
    ...tuning,
    enabled: bool(env.PROBE_SCHEDULE_ENABLED) ?? base.enabled,
    profiles,
  };
}

function mergeProfile(base: ProbeProfile, raw: unknown, budgetOverride?: number): ProbeProfile {
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const weekday = parseWindows(o.weekday) ?? base.weekday;
  const weekend = parseWindows(o.weekend) ?? base.weekend;
  const wdBudget = typeof o.weekdayBudget === 'number' && Number.isFinite(o.weekdayBudget) && o.weekdayBudget > 0
    ? Math.floor(o.weekdayBudget)
    : undefined;
  const weBudget = typeof o.weekendBudget === 'number' && Number.isFinite(o.weekendBudget) && o.weekendBudget > 0
    ? Math.floor(o.weekendBudget)
    : undefined;
  const minIntervalSec = typeof o.minIntervalSec === 'number' && Number.isFinite(o.minIntervalSec) && o.minIntervalSec > 0
    ? Math.floor(o.minIntervalSec)
    : base.minIntervalSec;
  const maxIntervalSec = typeof o.maxIntervalSec === 'number' && Number.isFinite(o.maxIntervalSec) && o.maxIntervalSec > 0
    ? Math.floor(o.maxIntervalSec)
    : base.maxIntervalSec;
  const weekendMaxIntervalSec = typeof o.weekendMaxIntervalSec === 'number' && Number.isFinite(o.weekendMaxIntervalSec) && o.weekendMaxIntervalSec > 0
    ? Math.floor(o.weekendMaxIntervalSec)
    : base.weekendMaxIntervalSec;
  return {
    source: base.source,
    weekday,
    weekend,
    weekdayBudget: budgetOverride ?? wdBudget ?? base.weekdayBudget,
    weekendBudget: weBudget ?? base.weekendBudget,
    ...stripUndefined({ minIntervalSec, maxIntervalSec, weekendMaxIntervalSec }),
  };
}

const TIERS: readonly ProbeTier[] = ['peak', 'high', 'mid', 'low'];

function parseWindows(raw: unknown): ProbeWindowSpec[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: ProbeWindowSpec[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null;
    const o = item as Record<string, unknown>;
    const tier = TIERS.find((t) => t === o.tier);
    if (!tier) return null;
    if (!Array.isArray(o.ranges) || o.ranges.length === 0) return null;
    const ranges: MinuteRange[] = [];
    for (const r of o.ranges) {
      if (!Array.isArray(r) || r.length !== 2) return null;
      const [a, b] = r as unknown[];
      if (typeof a !== 'number' || typeof b !== 'number') return null;
      ranges.push([a, b]);
    }
    const events = typeof o.events === 'number' && Number.isFinite(o.events) ? Math.max(0, o.events) : 0;
    const note = typeof o.note === 'string' ? o.note : undefined;
    out.push({ tier, ranges, events, note });
  }
  return coveredSecOf(out.flatMap((w) => w.ranges)) > 0 ? out : null;
}

// ---------------------------------------------------------------------------
// Human-readable rendering (docs, admin surfaces, PR bodies)
// ---------------------------------------------------------------------------

function hhmm(minute: number): string {
  const m = minute % DAY_MINUTES;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function formatRanges(ranges: readonly MinuteRange[]): string {
  return ranges.map(([a, b]) => `${hhmm(a)}-${b >= DAY_MINUTES ? '24:00' : hhmm(b)}`).join(' + ');
}

function fmtInterval(sec: number): string {
  return sec < 90 ? `${sec}s` : `${sec}s (${(sec / 60).toFixed(1)}m)`;
}

/** Render one allocation as a fixed-width table. */
export function describeAllocation(a: ProbeAllocation): string {
  const rows = a.windows.map((w) => [
    w.tier.toUpperCase().padEnd(4),
    formatRanges(w.ranges).padEnd(23),
    String(w.coveredSec).padStart(6),
    String(w.events).padStart(6),
    w.weight.toFixed(4).padStart(7),
    w.proportionalProbes.toFixed(1).padStart(9),
    String(w.probes).padStart(6),
    fmtInterval(w.intervalSec).padStart(13),
    w.clampedBy.padStart(8),
  ].join('  '));
  const header = [
    'TIER'.padEnd(4), 'WINDOW (ET)'.padEnd(23), 'COV(s)'.padStart(6), 'EVENTS'.padStart(6),
    'WEIGHT'.padStart(7), 'PRE-CLAMP'.padStart(9), 'PROBES'.padStart(6),
    'INTERVAL'.padStart(13), 'CLAMPED'.padStart(8),
  ].join('  ');
  return [
    `${a.source} / ${a.dayType} — budget ${a.budget}, effective ${a.effectiveBudget}, allocated ${a.allocatedProbes}`
      + `${a.degraded ? ' [DEGRADED: floors relaxed to fit cap]' : ''}`,
    header,
    '-'.repeat(header.length),
    ...rows,
    `peak ${fmtInterval(a.peakIntervalSec)}  trough ${fmtInterval(a.troughIntervalSec)}  ratio ${a.achievedPeakTroughRatio}x`,
  ].join('\n');
}

/** Render the whole shipped schedule. Used by the docs and safe to log. */
export function describeProbeSchedule(cfg: ProbeScheduleConfig = DEFAULT_PROBE_SCHEDULE_CONFIG): string {
  const out: string[] = [];
  for (const source of PROBE_SOURCES) {
    for (const dayType of ['weekday', 'weekend'] as const) {
      out.push(describeAllocation(allocateProbes(cfg.profiles[source], dayType, cfg)));
      out.push('');
    }
  }
  return out.join('\n');
}
