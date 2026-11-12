/**
 * src/ingestion/__tests__/probeSchedule.test.ts
 *
 * The load-bearing property here is BUDGET CONSERVATION: this schedule exists
 * to reallocate a fixed number of daily probes, not to spend more of them. So
 * the central tests do not inspect the allocation table — they SIMULATE the
 * real cron (one tick per minute, across a real ET day, through
 * shouldProbeNow) and count how many probes actually fire. That is the number
 * that hits the provider's rate limiter.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PROBE_SCHEDULE_CONFIG,
  DEFAULT_PROBE_TUNING,
  EXECUTIVE_PROFILE,
  EXECUTIVE_WEEKDAY_MAX_INTERVAL_SEC,
  HOUSE_PROFILE,
  PROVIDER_PROFILE,
  SENATE_PROFILE,
  _resetProbeScheduleCache,
  allocateProbes,
  coveredSecOf,
  dayTypeFor,
  etClock,
  probeIntervalSecAt,
  probeScheduleConfigFromEnv,
  probeTierAt,
  probeYieldWeightAt,
  shouldProbeNow,
  type DayType,
  type ProbeProfile,
  type ProbeScheduleConfig,
  type ProbeSource,
} from '../probeSchedule.ts';
import {
  FMP_LATENCY_CALLS_PER_RUN,
  FMP_LATENCY_DAILY_CAP_PER_KEY,
  LATENCY_SOURCE_BUDGETS,
} from '../tradeLatency.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ET_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** ET calendar date ('YYYY-MM-DD') for an instant. */
function etDateOf(d: Date): string {
  return ET_DATE.format(d);
}

/**
 * Replay a full ET calendar day one minute at a time — exactly how the watcher
 * cron behaves — and report what the schedule actually spends.
 *
 * Deliberately brackets the day with a wide UTC window and filters on the ET
 * date, so 23-hour and 25-hour DST days are covered honestly rather than being
 * assumed to be 1440 ticks.
 */
function simulateDay(
  etDate: string,
  source: ProbeSource,
  cfg: ProbeScheduleConfig = DEFAULT_PROBE_SCHEDULE_CONFIG,
  budget?: number,
): { probes: number; ticks: number; byTier: Record<string, number>; maxGapSec: number } {
  const start = new Date(`${etDate}T00:00:00Z`);
  const from = start.getTime() - 12 * 3600_000;
  const to = start.getTime() + 36 * 3600_000;

  let lastProbeAt: Date | null = null;
  let probes = 0;
  let ticks = 0;
  let maxGapSec = 0;
  let lastInDaySec: number | null = null;
  const byTier: Record<string, number> = {};

  for (let t = from; t <= to; t += 60_000) {
    const now = new Date(t);
    const inDay = etDateOf(now) === etDate;
    const decision = shouldProbeNow({ source, now, lastProbeAt, config: cfg, budget });
    if (inDay) {
      ticks++;
      if (lastInDaySec !== null) maxGapSec = Math.max(maxGapSec, (t / 1000) - lastInDaySec);
    }
    if (decision.probe) {
      lastProbeAt = now;
      if (inDay) {
        probes++;
        byTier[decision.tier] = (byTier[decision.tier] ?? 0) + 1;
        lastInDaySec = t / 1000;
      }
    }
  }
  return { probes, ticks, byTier, maxGapSec };
}

const PROFILES: Record<ProbeSource, ProbeProfile> = {
  house: HOUSE_PROFILE,
  senate: SENATE_PROFILE,
  provider: PROVIDER_PROFILE,
  executive: EXECUTIVE_PROFILE,
};

// Reference ET dates. 2026-08-05 is a Wednesday, 2026-08-08 a Saturday.
const WEEKDAY = '2026-08-05';
const WEEKEND = '2026-08-08';
// US DST transitions are always Sundays, i.e. always weekend days.
const SPRING_FORWARD = '2026-03-08'; // 23-hour ET day
const FALL_BACK = '2026-11-01'; //      25-hour ET day

// ---------------------------------------------------------------------------

describe('probeSchedule — budget conservation (the cap must hold)', () => {
  for (const source of ['house', 'senate', 'provider', 'executive'] as const) {
    it(`${source}: a simulated weekday never exceeds the daily cap`, () => {
      const profile = PROFILES[source];
      const { probes } = simulateDay(WEEKDAY, source);
      expect(probes).toBeLessThanOrEqual(profile.weekdayBudget);
      // and it should actually USE the budget, not quietly under-spend it
      expect(probes).toBeGreaterThan(profile.weekdayBudget * 0.5);
    });

    it(`${source}: a simulated weekend never exceeds the weekend cap`, () => {
      const profile = PROFILES[source];
      const { probes } = simulateDay(WEEKEND, source);
      expect(probes).toBeLessThanOrEqual(profile.weekendBudget);
    });
  }

  it('house weekday spends within its 171-probe budget and matches the documented plan', () => {
    const { probes, byTier } = simulateDay(WEEKDAY, 'house');
    expect(probes).toBeLessThanOrEqual(171);
    // 45 one-minute probes across the 08:55-09:40 burst is the whole point.
    expect(byTier.peak).toBe(45);
    expect(byTier.low).toBeGreaterThan(0);
  });

  it('DST spring-forward (23h ET day) stays under cap', () => {
    for (const source of ['house', 'senate', 'provider', 'executive'] as const) {
      const { probes } = simulateDay(SPRING_FORWARD, source);
      expect(probes).toBeLessThanOrEqual(PROFILES[source].weekendBudget);
    }
  });

  it('DST fall-back (25h ET day) stays under cap — this is what retry headroom absorbs', () => {
    for (const source of ['house', 'senate', 'provider', 'executive'] as const) {
      const profile = PROFILES[source];
      const { probes } = simulateDay(FALL_BACK, source);
      // The 25th hour pushes past the post-headroom allocation, which is
      // precisely the case the headroom exists for: the CAP still holds.
      expect(probes).toBeGreaterThan(Math.floor(profile.weekendBudget * (1 - DEFAULT_PROBE_TUNING.retryHeadroom)) - 1);
      expect(probes).toBeLessThanOrEqual(profile.weekendBudget);
    }
  });

  it('allocation sum never exceeds the effective budget, which never exceeds the cap', () => {
    for (const source of ['house', 'senate', 'provider', 'executive'] as const) {
      for (const dayType of ['weekday', 'weekend'] as DayType[]) {
        const a = allocateProbes(PROFILES[source], dayType, DEFAULT_PROBE_SCHEDULE_CONFIG);
        expect(a.allocatedProbes).toBeLessThanOrEqual(a.effectiveBudget);
        expect(a.effectiveBudget).toBeLessThanOrEqual(a.budget);
        // renormalise actually happened: the residual freed by clamping was
        // re-spent, not dropped on the floor
        expect(a.allocatedProbes).toBeGreaterThanOrEqual(a.effectiveBudget - a.windows.length);
      }
    }
  });

  it('no shipped profile lands on the degraded (floors-relaxed) path', () => {
    for (const source of ['house', 'senate', 'provider', 'executive'] as const) {
      for (const dayType of ['weekday', 'weekend'] as DayType[]) {
        expect(allocateProbes(PROFILES[source], dayType, DEFAULT_PROBE_SCHEDULE_CONFIG).degraded).toBe(false);
      }
    }
  });

  it('an infeasible retune degrades coverage rather than breaking the cap', () => {
    // 10 probes/day cannot honour a 30-minute floor over 24h (needs 48).
    const a = allocateProbes(HOUSE_PROFILE, 'weekday', { ...DEFAULT_PROBE_SCHEDULE_CONFIG, budget: 10 });
    expect(a.degraded).toBe(true);
    expect(a.allocatedProbes).toBeLessThanOrEqual(a.effectiveBudget);
    const { probes } = simulateDay(WEEKDAY, 'house', DEFAULT_PROBE_SCHEDULE_CONFIG, 10);
    expect(probes).toBeLessThanOrEqual(10);
  });
});

describe('probeSchedule — real provider caps', () => {
  it('stays inside every documented per-provider daily HTTP cap', () => {
    const cases: Array<{ name: string; runs: number; callsPerRun: number; cap: number }> = [
      {
        name: 'unusual_whales',
        runs: Math.floor(LATENCY_SOURCE_BUDGETS.unusual_whales.defaultDailyCap / LATENCY_SOURCE_BUDGETS.unusual_whales.callsPerRun),
        callsPerRun: LATENCY_SOURCE_BUDGETS.unusual_whales.callsPerRun,
        cap: LATENCY_SOURCE_BUDGETS.unusual_whales.defaultDailyCap,
      },
      {
        name: 'quiver',
        runs: Math.floor(LATENCY_SOURCE_BUDGETS.quiver.defaultDailyCap / LATENCY_SOURCE_BUDGETS.quiver.callsPerRun),
        callsPerRun: LATENCY_SOURCE_BUDGETS.quiver.callsPerRun,
        cap: LATENCY_SOURCE_BUDGETS.quiver.defaultDailyCap,
      },
      {
        name: 'fmp_rapidapi',
        runs: Math.floor(LATENCY_SOURCE_BUDGETS.fmp_rapidapi.defaultDailyCap / LATENCY_SOURCE_BUDGETS.fmp_rapidapi.callsPerRun),
        callsPerRun: LATENCY_SOURCE_BUDGETS.fmp_rapidapi.callsPerRun,
        cap: LATENCY_SOURCE_BUDGETS.fmp_rapidapi.defaultDailyCap,
      },
      {
        name: 'fmp_free_per_key',
        runs: Math.floor(FMP_LATENCY_DAILY_CAP_PER_KEY / FMP_LATENCY_CALLS_PER_RUN),
        callsPerRun: FMP_LATENCY_CALLS_PER_RUN,
        cap: FMP_LATENCY_DAILY_CAP_PER_KEY,
      },
    ];

    for (const c of cases) {
      for (const dayType of ['weekday', 'weekend'] as DayType[]) {
        const a = allocateProbes(PROVIDER_PROFILE, dayType, {
          ...DEFAULT_PROBE_SCHEDULE_CONFIG,
          budget: c.runs,
        });
        expect(a.allocatedProbes * c.callsPerRun, `${c.name}/${dayType}`).toBeLessThanOrEqual(c.cap);
      }
      const { probes } = simulateDay(WEEKDAY, 'provider', DEFAULT_PROBE_SCHEDULE_CONFIG, c.runs);
      expect(probes * c.callsPerRun, `${c.name} simulated weekday`).toBeLessThanOrEqual(c.cap);
    }
  });
});

describe('probeSchedule — peak/trough shape', () => {
  it('peak is at least 2x trough on every weekday profile (owner floor)', () => {
    for (const source of ['house', 'senate', 'provider'] as const) {
      const a = allocateProbes(PROFILES[source], 'weekday', DEFAULT_PROBE_SCHEDULE_CONFIG);
      expect(a.achievedPeakTroughRatio, source).toBeGreaterThanOrEqual(2);
    }
  });

  it('the ratio ceiling is genuinely enforced, not decorative', () => {
    for (const source of ['house', 'senate', 'provider'] as const) {
      for (const R of [2, 4, 8, 30]) {
        const a = allocateProbes(PROFILES[source], 'weekday', {
          ...DEFAULT_PROBE_SCHEDULE_CONFIG,
          peakTroughRatioCap: R,
        });
        expect(a.achievedPeakTroughRatio, `${source} @ R=${R}`).toBeLessThanOrEqual(R + 0.01);
      }
    }
  });

  it('R=4 costs the peak: it becomes SLOWER than the 300s schedule it replaces', () => {
    const clamped = allocateProbes(HOUSE_PROFILE, 'weekday', {
      ...DEFAULT_PROBE_SCHEDULE_CONFIG,
      peakTroughRatioCap: 4,
    });
    const shipped = allocateProbes(HOUSE_PROFILE, 'weekday', DEFAULT_PROBE_SCHEDULE_CONFIG);
    expect(shipped.peakIntervalSec).toBe(60);
    expect(clamped.peakIntervalSec).toBe(450);
    // 450s at the 09:00 burst is worse than today's 300s active-window cadence.
    expect(clamped.peakIntervalSec).toBeGreaterThan(300);
    // ...and the freed budget lands in a window with zero measured arrivals.
    const clampedLow = clamped.windows.find((w) => w.tier === 'low')!;
    const shippedLow = shipped.windows.find((w) => w.tier === 'low')!;
    expect(clampedLow.probes).toBeGreaterThan(shippedLow.probes * 2);
    expect(clampedLow.events).toBe(0);
  });

  it('no window is ever starved to zero, on any profile or day type', () => {
    for (const source of ['house', 'senate', 'provider', 'executive'] as const) {
      for (const dayType of ['weekday', 'weekend'] as DayType[]) {
        for (const w of allocateProbes(PROFILES[source], dayType, DEFAULT_PROBE_SCHEDULE_CONFIG).windows) {
          expect(w.probes, `${source}/${dayType}/${w.tier}`).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });

  it('the coverage floor holds: the longest real gap on a weekday is ~30 minutes', () => {
    for (const source of ['house', 'senate', 'provider'] as const) {
      const { maxGapSec } = simulateDay(WEEKDAY, source);
      // one tick of slack for minute-granularity cron discretisation
      expect(maxGapSec, source).toBeLessThanOrEqual(DEFAULT_PROBE_TUNING.maxIntervalSec + 60);
    }
    // and well inside pipelineHealth's 6-hour polling-liveness threshold
    expect(DEFAULT_PROBE_TUNING.maxIntervalSec).toBeLessThan(6 * 3600);
  });

  it('allocation stays proportional among windows the clamps did not touch', () => {
    const a = allocateProbes(HOUSE_PROFILE, 'weekday', DEFAULT_PROBE_SCHEDULE_CONFIG);
    const free = a.windows.filter((w) => w.clampedBy === 'none');
    expect(free.length).toBeGreaterThanOrEqual(2);
    const [x, y] = free;
    // probes should track weight, not duration
    expect(x.probes / y.probes).toBeCloseTo(x.weight / y.weight, 1);
  });
});

describe('probeSchedule — measured windows drive the tiers', () => {
  const atEt = (date: string, hhmm: string): Date => {
    // August => EDT (UTC-4). Used only for weekday assertions inside EDT.
    const [h, m] = hhmm.split(':').map(Number);
    return new Date(Date.UTC(
      Number(date.slice(0, 4)),
      Number(date.slice(5, 7)) - 1,
      Number(date.slice(8, 10)),
      h + 4,
      m,
    ));
  };

  it('house: the 09:00 ET burst is peak and the small hours are low', () => {
    expect(probeTierAt('house', atEt(WEEKDAY, '09:02'))).toBe('peak');
    expect(probeTierAt('house', atEt(WEEKDAY, '08:56'))).toBe('peak');
    expect(probeTierAt('house', atEt(WEEKDAY, '08:50'))).toBe('low');
    expect(probeTierAt('house', atEt(WEEKDAY, '10:30'))).toBe('high');
    expect(probeTierAt('house', atEt(WEEKDAY, '14:00'))).toBe('mid');
    expect(probeTierAt('house', atEt(WEEKDAY, '03:00'))).toBe('low');
    expect(probeIntervalSecAt('house', atEt(WEEKDAY, '09:02'))).toBe(60);
  });

  it('senate: the peak is the 16:00-18:00 ET afternoon, NOT the House morning', () => {
    expect(probeTierAt('senate', atEt(WEEKDAY, '17:00'))).toBe('peak');
    expect(probeTierAt('senate', atEt(WEEKDAY, '09:02'))).toBe('low');
    // The two chambers are genuinely inverted — a single global curve is wrong
    // for both, which is the core reason this module is per-source.
    expect(probeIntervalSecAt('senate', atEt(WEEKDAY, '17:00')))
      .toBeLessThan(probeIntervalSecAt('house', atEt(WEEKDAY, '17:00')));
    expect(probeIntervalSecAt('house', atEt(WEEKDAY, '09:02')))
      .toBeLessThan(probeIntervalSecAt('senate', atEt(WEEKDAY, '09:02')));
  });

  it('provider: covers the union of both chambers’ peaks', () => {
    expect(probeTierAt('provider', atEt(WEEKDAY, '09:30'))).toBe('peak');
    expect(probeTierAt('provider', atEt(WEEKDAY, '17:00'))).toBe('high');
    expect(probeTierAt('provider', atEt(WEEKDAY, '02:00'))).toBe('low');
  });

  it('weekends collapse to the flat low tier for every source', () => {
    const sat = new Date('2026-08-08T17:00:00.000Z');
    for (const source of ['house', 'senate', 'provider', 'executive'] as const) {
      expect(probeTierAt(source, sat)).toBe('low');
    }
  });

  it('window tables tile the full day with no gaps or double-cover', () => {
    for (const source of ['house', 'senate', 'provider', 'executive'] as const) {
      for (const dayType of ['weekday', 'weekend'] as DayType[]) {
        const specs = dayType === 'weekday' ? PROFILES[source].weekday : PROFILES[source].weekend;
        const total = specs.reduce((sum, w) => sum + coveredSecOf(w.ranges), 0);
        expect(total, `${source}/${dayType}`).toBe(86400);
      }
    }
  });
});

describe('probeSchedule — executive (no measured OGE arrival-hour sample)', () => {
  const weekdayNoon = new Date('2026-08-05T16:00:00.000Z'); // Wed 12:00 EDT
  const weekendNoon = new Date('2026-08-08T16:00:00.000Z'); // Sat 12:00 EDT

  it('uses a flat weekday window at the 15-minute coverage floor, not invented peaks', () => {
    expect(EXECUTIVE_PROFILE.weekday).toHaveLength(1);
    expect(EXECUTIVE_PROFILE.weekday[0]?.tier).toBe('low');
    expect(EXECUTIVE_PROFILE.weekday[0]?.events).toBe(0);
    expect(EXECUTIVE_WEEKDAY_MAX_INTERVAL_SEC).toBe(15 * 60);
    expect(EXECUTIVE_PROFILE.maxIntervalSec).toBe(15 * 60);
    expect(EXECUTIVE_PROFILE.minIntervalSec).toBe(60);
    expect(EXECUTIVE_PROFILE.weekendMaxIntervalSec).toBe(60 * 60);

    const weekday = allocateProbes(EXECUTIVE_PROFILE, 'weekday', DEFAULT_PROBE_SCHEDULE_CONFIG);
    expect(weekday.peakIntervalSec).toBe(900);
    expect(weekday.troughIntervalSec).toBe(900);
    expect(weekday.windows.every((w) => w.events === 0)).toBe(true);
    expect(probeIntervalSecAt('executive', weekdayNoon)).toBe(900);
    expect(probeTierAt('executive', weekdayNoon)).toBe('low');
  });

  it('weekends stay hourly like House, not a 6-hour gate', () => {
    const weekend = allocateProbes(EXECUTIVE_PROFILE, 'weekend', DEFAULT_PROBE_SCHEDULE_CONFIG);
    const houseWeekend = allocateProbes(HOUSE_PROFILE, 'weekend', DEFAULT_PROBE_SCHEDULE_CONFIG);
    expect(probeIntervalSecAt('executive', weekendNoon)).toBe(3600);
    expect(weekend.peakIntervalSec).toBe(3600);
    expect(houseWeekend.peakIntervalSec).toBe(3600);
  });

  it('per-source floors win so a global 6h maxInterval cannot re-impose the old gate', () => {
    const forced = allocateProbes(EXECUTIVE_PROFILE, 'weekday', {
      ...DEFAULT_PROBE_SCHEDULE_CONFIG,
      maxIntervalSec: 6 * 3600,
    });
    expect(forced.peakIntervalSec).toBe(900);
    expect(forced.troughIntervalSec).toBe(900);
  });

  it('is due after the weekday floor and too-soon inside it', () => {
    const due = shouldProbeNow({
      source: 'executive',
      now: weekdayNoon,
      lastProbeAt: new Date(weekdayNoon.getTime() - 901_000),
    });
    expect(due.probe).toBe(true);
    expect(due.reason).toBe('interval-elapsed');
    expect(due.intervalSec).toBe(900);

    const hold = shouldProbeNow({
      source: 'executive',
      now: weekdayNoon,
      lastProbeAt: new Date(weekdayNoon.getTime() - 5 * 60_000),
    });
    expect(hold.probe).toBe(false);
    expect(hold.reason).toBe('too-soon');
    expect(hold.intervalSec).toBe(900);
  });
});

describe('probeSchedule — DST correctness', () => {
  it('the House peak is 08:55-09:40 ET in BOTH EST and EDT', () => {
    // EDT (UTC-4): 09:02 ET = 13:02Z
    expect(probeTierAt('house', new Date('2026-08-05T13:02:00.000Z'))).toBe('peak');
    expect(probeTierAt('house', new Date('2026-08-05T14:02:00.000Z'))).toBe('high');
    // EST (UTC-5): 09:02 ET = 14:02Z. A hardcoded -4 offset would fail here,
    // which is exactly the bug this module avoids by going through Intl.
    expect(probeTierAt('house', new Date('2026-12-02T14:02:00.000Z'))).toBe('peak');
    expect(probeTierAt('house', new Date('2026-12-02T13:02:00.000Z'))).toBe('low');
  });

  it('etClock resolves to the minute and tracks the weekday', () => {
    const d = new Date('2026-08-05T13:02:00.000Z'); // Wed 09:02 EDT
    expect(etClock(d)).toEqual({ minuteOfDayET: 9 * 60 + 2, dayOfWeekET: 3 });
    expect(dayTypeFor(3)).toBe('weekday');
    expect(dayTypeFor(0)).toBe('weekend');
    expect(dayTypeFor(6)).toBe('weekend');
  });

  it('midnight ET normalises to minute 0, not 1440', () => {
    expect(etClock(new Date('2026-08-05T04:00:00.000Z')).minuteOfDayET).toBe(0);
  });
});

describe('probeSchedule — the decision function is pure and deterministic', () => {
  const now = new Date('2026-08-05T13:02:00.000Z');

  it('returns identical results for identical inputs', () => {
    const args = { source: 'house' as const, now, lastProbeAt: new Date(now.getTime() - 120_000) };
    const a = shouldProbeNow(args);
    const b = shouldProbeNow(args);
    expect(a).toEqual(b);
    expect(a.probe).toBe(true);
    expect(a.reason).toBe('interval-elapsed');
  });

  it('probes immediately when there is no prior probe', () => {
    const d = shouldProbeNow({ source: 'house', now, lastProbeAt: null });
    expect(d.probe).toBe(true);
    expect(d.reason).toBe('never-probed');
  });

  it('holds off inside the interval', () => {
    const d = shouldProbeNow({ source: 'house', now, lastProbeAt: new Date(now.getTime() - 30_000) });
    expect(d.probe).toBe(false);
    expect(d.reason).toBe('too-soon');
    expect(d.elapsedSec).toBe(30);
  });

  it('honours the kill switch', () => {
    const d = shouldProbeNow({
      source: 'house',
      now,
      lastProbeAt: null,
      config: { ...DEFAULT_PROBE_SCHEDULE_CONFIG, enabled: false },
    });
    expect(d.probe).toBe(false);
    expect(d.reason).toBe('disabled');
  });

  it('does not mutate its inputs', () => {
    const lastProbeAt = new Date(now.getTime() - 120_000);
    const snapshot = lastProbeAt.getTime();
    shouldProbeNow({ source: 'house', now, lastProbeAt });
    expect(lastProbeAt.getTime()).toBe(snapshot);
    expect(now.toISOString()).toBe('2026-08-05T13:02:00.000Z');
  });
});

describe('probeSchedule — yield weight is budget-neutral (tradeLatency contract)', () => {
  it('time-averages to 1.0 across a weekday, so reshaping does not raise spend', () => {
    // Sampled through the public function, minute by minute across a real ET
    // day — not re-derived from the allocation, or this would only be testing
    // the test's own arithmetic.
    const midnightEt = new Date('2026-08-05T04:00:00.000Z'); // 00:00 EDT Wed
    for (const source of ['house', 'senate', 'provider'] as const) {
      let acc = 0;
      for (let m = 0; m < 1440; m++) {
        acc += probeYieldWeightAt(source, new Date(midnightEt.getTime() + m * 60_000));
      }
      expect(acc / 1440, source).toBeCloseTo(1, 2);
    }
  });

  it('weights the House morning far above the overnight trough', () => {
    const peak = probeYieldWeightAt('house', new Date('2026-08-05T13:02:00.000Z'));
    const night = probeYieldWeightAt('house', new Date('2026-08-05T07:00:00.000Z'));
    expect(peak).toBeGreaterThan(5);
    expect(night).toBeLessThan(0.5);
    expect(night).toBeGreaterThan(0);
  });
});

describe('probeSchedule — configuration', () => {
  it('defaults cleanly with an empty env', () => {
    const cfg = probeScheduleConfigFromEnv({});
    expect(cfg).toEqual(DEFAULT_PROBE_SCHEDULE_CONFIG);
  });

  it('applies scalar overrides and clamps them to sane ranges', () => {
    const cfg = probeScheduleConfigFromEnv({
      PROBE_SCHEDULE_PEAK_TROUGH_RATIO: '4',
      PROBE_SCHEDULE_MAX_INTERVAL_SEC: '900',
      PROBE_SCHEDULE_RETRY_HEADROOM: '5', // absurd -> clamped to the 0.5 ceiling
      PROBE_SCHEDULE_ENABLED: 'false',
    });
    expect(cfg.peakTroughRatioCap).toBe(4);
    expect(cfg.maxIntervalSec).toBe(900);
    expect(cfg.retryHeadroom).toBe(0.5);
    expect(cfg.enabled).toBe(false);
  });

  it('ignores unparseable scalars instead of throwing', () => {
    const cfg = probeScheduleConfigFromEnv({ PROBE_SCHEDULE_PEAK_TROUGH_RATIO: 'banana' });
    expect(cfg.peakTroughRatioCap).toBe(DEFAULT_PROBE_TUNING.peakTroughRatioCap);
  });

  it('a budget override retunes the schedule without a deploy', () => {
    _resetProbeScheduleCache();
    const cfg = probeScheduleConfigFromEnv({ PROBE_SCHEDULE_HOUSE_BUDGET: '320' });
    expect(cfg.profiles.house.weekdayBudget).toBe(320);
    const { probes } = simulateDay(WEEKDAY, 'house', cfg);
    expect(probes).toBeLessThanOrEqual(320);
    expect(probes).toBeGreaterThan(simulateDay(WEEKDAY, 'house').probes);
    _resetProbeScheduleCache();
  });

  it('accepts a full window-table override', () => {
    _resetProbeScheduleCache();
    const cfg = probeScheduleConfigFromEnv({
      PROBE_SCHEDULE_JSON: JSON.stringify({
        house: {
          weekdayBudget: 100,
          weekday: [
            { tier: 'peak', ranges: [[600, 660]], events: 10 },
            { tier: 'low', ranges: [[0, 600], [660, 1440]], events: 0 },
          ],
        },
      }),
    });
    expect(cfg.profiles.house.weekday).toHaveLength(2);
    expect(cfg.profiles.house.weekdayBudget).toBe(100);
    // untouched sources keep their shipped tables
    expect(cfg.profiles.senate.weekday).toBe(SENATE_PROFILE.weekday);
    const { probes } = simulateDay(WEEKDAY, 'house', cfg);
    expect(probes).toBeLessThanOrEqual(100);
    _resetProbeScheduleCache();
  });

  it('falls back to the shipped table on malformed JSON rather than stalling ingestion', () => {
    expect(probeScheduleConfigFromEnv({ PROBE_SCHEDULE_JSON: '{not json' }).profiles.house.weekday)
      .toBe(HOUSE_PROFILE.weekday);
    expect(probeScheduleConfigFromEnv({ PROBE_SCHEDULE_JSON: '{"house":{"weekday":[{"tier":"nope"}]}}' })
      .profiles.house.weekday).toBe(HOUSE_PROFILE.weekday);
    expect(probeScheduleConfigFromEnv({ PROBE_SCHEDULE_JSON: '[]' }).profiles.house.weekday)
      .toBe(HOUSE_PROFILE.weekday);
  });

  it('two different window tables with the same shape do not collide in the cache', () => {
    _resetProbeScheduleCache();
    const build = (peakStart: number, peakEnd: number): ProbeScheduleConfig =>
      probeScheduleConfigFromEnv({
        PROBE_SCHEDULE_JSON: JSON.stringify({
          house: {
            weekday: [
              { tier: 'peak', ranges: [[peakStart, peakEnd]], events: 20 },
              { tier: 'low', ranges: [[0, peakStart], [peakEnd, 1440]], events: 0 },
            ],
          },
        }),
      });
    // Same source, same day type, same window COUNT, same budgets — only the
    // boundaries differ. No cache reset between the two calls on purpose.
    const morning = build(540, 600); // 09:00-10:00 ET
    const evening = build(1020, 1080); // 17:00-18:00 ET
    const at9 = new Date('2026-08-05T13:30:00.000Z');
    expect(probeTierAt('house', at9, { config: morning })).toBe('peak');
    expect(probeTierAt('house', at9, { config: evening })).toBe('low');
    _resetProbeScheduleCache();
  });

  it('a config with a gap in its window table still probes (fails safe, never silent)', () => {
    _resetProbeScheduleCache();
    const cfg = probeScheduleConfigFromEnv({
      PROBE_SCHEDULE_JSON: JSON.stringify({
        house: { weekday: [{ tier: 'peak', ranges: [[540, 600]], events: 10 }] },
      }),
    });
    // 02:00 ET is outside the only declared window; must not resolve to "never".
    const d = shouldProbeNow({
      source: 'house',
      now: new Date('2026-08-05T06:00:00.000Z'),
      lastProbeAt: null,
      config: cfg,
    });
    expect(d.probe).toBe(true);
    expect(Number.isFinite(d.intervalSec)).toBe(true);
    _resetProbeScheduleCache();
  });
});
