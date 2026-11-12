/**
 * src/ingestion/__tests__/probeWiring.test.ts
 *
 * probeSchedule.ts already has its own 41-test suite proving the ALLOCATION is
 * correct. This file proves something different and, as of this lane, more
 * urgent: that the allocation is actually CONSULTED at runtime.
 *
 * The module shipped in #1760/#1761 with zero runtime call sites — the numbers
 * were right and nothing read them. So these tests deliberately go through the
 * real entry points (decideSourcePoll, requestMacProbeLease,
 * runLeasedLatencyProbe) rather than through the pure allocator, and the lease
 * tests run against a REAL migrated SQLite rather than a mock, because the
 * whole exclusion argument rests on SQLite evaluating the conditional upsert
 * atomically.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openMigratedD1 } from '../../prices/__tests__/sqliteD1.ts';
import { decideSourcePoll } from '../watcher.ts';
import {
  DEFAULT_PROBE_SCHEDULE_CONFIG,
  probeScheduleConfigFromEnv,
} from '../probeSchedule.ts';
import { _resetProbeCadenceLog, logProbeCadence } from '../probeCadenceLog.ts';
import {
  LATENCY_PROBE_HEALTH_KV_KEY,
  requestMacProbeLease,
  runLeasedLatencyProbe,
  type LatencyProbeProviderId,
} from '../scoutHandoff.ts';
import type { PollConfig } from '../../shared/types.ts';

const CFG: PollConfig = {
  // The legacy windows, unchanged — present so the fallback path is exercised
  // with something realistic rather than an empty schedule.
  schedule: [
    { daysOfWeek: [1, 2, 3, 4, 5], startHourET: 8, endHourET: 19, intervalSec: 300 },
    { daysOfWeek: [1, 2, 3, 4, 5], startHourET: 19, endHourET: 24, intervalSec: 1200 },
    { daysOfWeek: [1, 2, 3, 4, 5], startHourET: 0, endHourET: 8, intervalSec: 1200 },
    { daysOfWeek: [0, 6], startHourET: 0, endHourET: 24, intervalSec: 3600 },
  ],
  aggressiveMode: false,
  updatedAt: '1970-01-01T00:00:00.000Z',
};

/** 2026-08-05 is a Wednesday. EDT = UTC-4 on this date. */
const et = (hh: number, mm = 0): Date =>
  new Date(Date.UTC(2026, 7, 5, hh + 4, mm, 0, 0));

describe('probe wiring: the House peak is actually reachable', () => {
  it('allows a probe inside the measured 08:55-09:40 ET peak window', () => {
    // 60s peak cadence: a probe 61s old is due, and the tier is reported so a
    // human can see WHICH window authorised it.
    const decision = decideSourcePoll({
      source: 'house',
      now: et(9, 2), // the measured median first-arrival minute
      cfg: CFG,
      lastPollAt: new Date(et(9, 2).getTime() - 61_000),
      schedule: DEFAULT_PROBE_SCHEDULE_CONFIG,
    });
    expect(decision.poll).toBe(true);
    expect(decision.tier).toBe('peak');
    expect(decision.authority).toBe('schedule');
    expect(decision.intervalSec).toBeLessThanOrEqual(60);
  });

  it('probes the 09:00-09:06 arrival window far denser than the old 300s schedule', () => {
    // The concrete regression this whole lane exists to fix: 21 of 27 days
    // landed 09:00-09:06 ET. At the legacy 300s cadence that six-minute window
    // gets at most 2 looks; at the measured cadence it gets 6+.
    const count = (schedule: typeof DEFAULT_PROBE_SCHEDULE_CONFIG | null): number => {
      let last: Date | null = new Date(et(8, 59).getTime());
      let probes = 0;
      for (let m = 0; m < 6; m++) {
        for (let s = 0; s < 60; s += 10) {
          const now = new Date(et(9, m).getTime() + s * 1000);
          const d = decideSourcePoll({
            source: 'house',
            now,
            cfg: CFG,
            lastPollAt: last,
            schedule: schedule ?? probeScheduleConfigFromEnv({ PROBE_SCHEDULE_ENABLED: '0' }),
          });
          if (d.poll) {
            probes++;
            last = now;
          }
        }
      }
      return probes;
    };
    const measured = count(DEFAULT_PROBE_SCHEDULE_CONFIG);
    const legacy = count(null);
    expect(measured).toBeGreaterThanOrEqual(5);
    expect(measured).toBeGreaterThan(legacy);
  });

  it('puts the Senate peak in the AFTERNOON, where the Senate actually files', () => {
    // The Senate is the inverse of the House (median 16:05 ET). A single global
    // curve is wrong for one chamber or the other; this asserts they diverge.
    const senate = decideSourcePoll({
      source: 'senate',
      now: et(16, 30),
      cfg: CFG,
      lastPollAt: null,
      schedule: DEFAULT_PROBE_SCHEDULE_CONFIG,
    });
    const house = decideSourcePoll({
      source: 'house',
      now: et(16, 30),
      cfg: CFG,
      lastPollAt: null,
      schedule: DEFAULT_PROBE_SCHEDULE_CONFIG,
    });
    expect(senate.tier).toBe('peak');
    expect(house.tier).toBe('mid');
    expect(senate.intervalSec).toBeLessThan(house.intervalSec);
  });
});

describe('probe wiring: the dead window is throttled but never starved', () => {
  it('skips an off-cadence probe overnight and says which tier skipped it', () => {
    const now = et(3, 0); // measured-zero window: 20:00-08:55 ET
    const decision = decideSourcePoll({
      source: 'house',
      now,
      cfg: CFG,
      lastPollAt: new Date(now.getTime() - 5 * 60_000),
      schedule: DEFAULT_PROBE_SCHEDULE_CONFIG,
    });
    expect(decision.poll).toBe(false);
    expect(decision.tier).toBe('low');
    expect(decision.reason).toBe('too-soon');
    // The skip is legible: an operator can read "low tier, 1789s interval,
    // 300s elapsed" and conclude "correctly skipped", not "silently broken".
    expect(decision.intervalSec).toBeGreaterThan(600);
  });

  it('never lets the overnight gap exceed the 30-minute coverage floor', () => {
    // The floor is the load-bearing guarantee: zero probes in a window is never
    // permitted, no matter how low the measured yield. Simulated minute by
    // minute across the whole 20:00 -> 08:55 ET dead stretch.
    const start = et(20, 0);
    const minutes = 13 * 60; // 20:00 -> 09:00 next day
    let last: Date | null = start;
    let longestGapSec = 0;
    let probes = 0;
    for (let m = 1; m <= minutes; m++) {
      const now = new Date(start.getTime() + m * 60_000);
      const d = decideSourcePoll({
        source: 'house',
        now,
        cfg: CFG,
        lastPollAt: last,
        schedule: DEFAULT_PROBE_SCHEDULE_CONFIG,
      });
      if (d.poll) {
        longestGapSec = Math.max(longestGapSec, (now.getTime() - last!.getTime()) / 1000);
        probes++;
        last = now;
      }
    }
    expect(probes).toBeGreaterThan(0);
    // maxIntervalSec is 30 min; the watcher ticks once a minute, which
    // discretises the interval upward by at most one tick.
    expect(longestGapSec).toBeLessThanOrEqual(30 * 60 + 60);
  });

  it('keeps every source polling often enough for the daily full-history sweep', () => {
    // WHAT THIS PROTECTS: the sweeps that catch whatever the tiers miss.
    //   - House: every poll re-fetches and diffs the FULL yearly bulk index, so
    //     any single poll heals a missed filing.
    //   - Senate: once per UTC day the poll widens to the full maxDays lookback
    //     (the deep sweep) -- which requires at least one Senate poll per day.
    //   - pipelineHealth's polling_house / polling_senate liveness thresholds
    //     are 3h; a cadence slower than that would trip them.
    // A retune that starved a source below one poll per day would silently
    // disable all three. This pins the property, not the number.
    for (const source of ['house', 'senate'] as const) {
      let last: Date | null = null;
      let probes = 0;
      let longestGapSec = 0;
      for (let m = 0; m < 24 * 60; m++) {
        const now = new Date(Date.UTC(2026, 7, 5, 0, 0, 0) + m * 60_000);
        const d = decideSourcePoll({
          source,
          now,
          cfg: CFG,
          lastPollAt: last,
          schedule: DEFAULT_PROBE_SCHEDULE_CONFIG,
        });
        if (d.poll) {
          if (last) longestGapSec = Math.max(longestGapSec, (now.getTime() - last.getTime()) / 1000);
          probes++;
          last = now;
        }
      }
      expect(probes).toBeGreaterThan(24); // comfortably more than one/day
      expect(longestGapSec).toBeLessThan(3 * 3600); // inside the 3h liveness bound
    }
  });
});

describe('probe wiring: the kill switch restores the old behaviour, not silence', () => {
  it('falls back to the legacy poll windows when the schedule is disabled', () => {
    const off = probeScheduleConfigFromEnv({ PROBE_SCHEDULE_ENABLED: '0' });
    const now = et(10, 0);
    const decision = decideSourcePoll({
      source: 'house',
      now,
      cfg: CFG,
      lastPollAt: new Date(now.getTime() - 301_000), // past the legacy 300s
      schedule: off,
    });
    // The dangerous bug this pins: shouldProbeNow() reports `disabled` with
    // probe=false, so a naive `return shouldProbeNow(...).probe` would stop
    // ingestion entirely the moment someone set PROBE_SCHEDULE_ENABLED=0.
    expect(decision.poll).toBe(true);
    expect(decision.authority).toBe('poll-window');
  });

  it('hands cadence back to the legacy path when the owner sets aggressiveMode', () => {
    const decision = decideSourcePoll({
      source: 'house',
      now: et(3, 0),
      cfg: { ...CFG, aggressiveMode: true },
      lastPollAt: new Date(et(3, 0).getTime() - 1_300_000),
      schedule: DEFAULT_PROBE_SCHEDULE_CONFIG,
    });
    expect(decision.authority).toBe('poll-window');
    expect(decision.reason).toContain('aggressive-mode');
  });
});

describe('probe wiring: executive uses the adaptive schedule, not a flat 6h/15m gate', () => {
  it('is due on the weekday 15-minute floor and too-soon inside it', () => {
    const now = et(12, 0);
    const due = decideSourcePoll({
      source: 'executive',
      now,
      cfg: CFG,
      lastPollAt: new Date(now.getTime() - 901_000),
      schedule: DEFAULT_PROBE_SCHEDULE_CONFIG,
    });
    expect(due.poll).toBe(true);
    expect(due.authority).toBe('schedule');
    expect(due.intervalSec).toBe(900);
    expect(due.reason).toBe('interval-elapsed');

    const hold = decideSourcePoll({
      source: 'executive',
      now,
      cfg: CFG,
      lastPollAt: new Date(now.getTime() - 5 * 60_000),
      schedule: DEFAULT_PROBE_SCHEDULE_CONFIG,
    });
    expect(hold.poll).toBe(false);
    expect(hold.reason).toBe('too-soon');
    expect(hold.intervalSec).toBe(900);
  });

  it('never-probed executive is due even with leftover Infisical 21600 sitting unused', () => {
    const schedule = probeScheduleConfigFromEnv({
      OGE_POLL_INTERVAL_SEC: '21600',
    } as { OGE_POLL_INTERVAL_SEC?: string });
    const decision = decideSourcePoll({
      source: 'executive',
      now: et(12, 0),
      cfg: CFG,
      lastPollAt: null,
      schedule,
    });
    expect(decision.poll).toBe(true);
    expect(decision.reason).toBe('never-probed');
    expect(decision.intervalSec).toBe(900);
    expect(decision.intervalSec).toBeLessThan(6 * 3600);
  });

  it('weekends stay hourly like House', () => {
    const sat = new Date('2026-08-08T16:00:00.000Z');
    const tooSoon = decideSourcePoll({
      source: 'executive',
      now: sat,
      cfg: CFG,
      lastPollAt: new Date(sat.getTime() - 20 * 60_000),
      schedule: DEFAULT_PROBE_SCHEDULE_CONFIG,
    });
    expect(tooSoon.poll).toBe(false);
    expect(tooSoon.intervalSec).toBe(3600);

    const due = decideSourcePoll({
      source: 'executive',
      now: sat,
      cfg: CFG,
      lastPollAt: new Date(sat.getTime() - 3601_000),
      schedule: DEFAULT_PROBE_SCHEDULE_CONFIG,
    });
    expect(due.poll).toBe(true);
    expect(due.intervalSec).toBe(3600);
  });
});

// ---------------------------------------------------------------------------
// Lease + schedule composition (real SQLite)
// ---------------------------------------------------------------------------

interface Harness {
  env: never;
  kv: Map<string, string>;
  close: () => void;
}

async function makeHarness(overrides: Record<string, string> = {}): Promise<Harness> {
  const { d1, close } = await openMigratedD1();
  const kv = new Map<string, string>();
  const env = {
    DB: d1,
    CONFIG_KV: {
      get: async (key: string, type?: string) => {
        const v = kv.get(key);
        if (v == null) return null;
        return type === 'json' ? JSON.parse(v) : v;
      },
      put: async (key: string, value: string) => {
        kv.set(key, value);
      },
    },
    DISCLOSURE_LATENCY_PROVIDERS: 'unusual_whales,quiver',
    UNUSUAL_WHALES_API_KEY: 'uw-test-key',
    QUIVER_API_KEY: 'qq-test-key',
    ...overrides,
  } as never;
  return { env, kv, close };
}

function setHandoff(
  kv: Map<string, string>,
  provider: LatencyProbeProviderId,
  needScout: boolean,
  at: Date,
): void {
  const raw = kv.get(LATENCY_PROBE_HEALTH_KV_KEY);
  const map = raw ? JSON.parse(raw) : {};
  map[provider] = {
    provider,
    lastAttemptAt: at.toISOString(),
    lastSuccessAt: null,
    lastError: needScout ? 'HTTP_403' : null,
    lastFetchedRows: 0,
    lastSource: 'server',
    consecutiveServerErrors: needScout ? 3 : 0,
    needScout,
    needScoutReason: needScout ? 'server probe failed 3 successive times' : null,
    updatedAt: at.toISOString(),
  };
  kv.set(LATENCY_PROBE_HEALTH_KV_KEY, JSON.stringify(map));
}

/** 09:30 ET on a Wednesday — squarely inside the provider PEAK window, so any
 *  skip in these tests is provably the LEASE talking, not the schedule. */
const PEAK = new Date('2026-08-05T13:30:00.000Z');

describe('probe wiring: lease denial wins regardless of the schedule', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
    _resetProbeCadenceLog();
  });
  afterEach(() => h.close());

  it('denies the Mac a lane the server owns, even at peak cadence', async () => {
    // needScout=false -> the server holds the lane. The schedule would happily
    // authorise a probe at 09:30 ET; it never gets asked.
    setHandoff(h.kv, 'quiver', false, PEAK);
    const res = await requestMacProbeLease(h.env, {
      provider: 'quiver',
      holderId: 'mac-laptop',
      now: PEAK,
    });
    expect(res.granted).toBe(false);
    expect(res.denial).toBe('not_eligible');
    // Nothing was charged: the schedule cannot spend on a lane it does not hold.
    expect(res.charged).toBe(0);
    expect(res.tier ?? null).toBeNull();
  });

  it('never calls runProbe for a provider whose lane another holder still owns', async () => {
    // Scout retired 2026-09-09: the server never *hands off* a lane any more,
    // so a stale `needScout` row plus a leftover Mac lease no longer reports
    // `handed_off` — it reports `blocked`, the ordinary "someone else holds
    // this lane" denial.  Within the tenure window the server still waits; it
    // preempts once the window is spent (see probeLease.test.ts).  What this
    // test guards is unchanged: a lane the server does not hold is never
    // probed.
    setHandoff(h.kv, 'quiver', true, PEAK);
    setHandoff(h.kv, 'unusual_whales', true, PEAK);
    await requestMacProbeLease(h.env, { provider: 'quiver', holderId: 'mac-laptop', now: PEAK });
    await requestMacProbeLease(h.env, { provider: 'unusual_whales', holderId: 'mac-laptop', now: PEAK });
    const runProbe = vi.fn(async () => 'fetched');
    const outcome = await runLeasedLatencyProbe(h.env, runProbe, PEAK);
    expect(runProbe).not.toHaveBeenCalled();
    expect(outcome.result).toBeNull();
    expect(outcome.plan.probeProviders).toEqual([]);
    expect(outcome.skipped.map((l) => l.action)).toEqual(['blocked', 'blocked']);
  });

  it('hands runProbe ONLY the leased providers, so the schedule sees no others', async () => {
    // The nesting, stated as a test: the set the schedule gets to pace is a
    // subset of the set the lease granted, never a union with anything else.
    setHandoff(h.kv, 'quiver', true, PEAK); // mac's lane
    setHandoff(h.kv, 'unusual_whales', false, PEAK); // server's lane
    await requestMacProbeLease(h.env, { provider: 'quiver', holderId: 'mac-laptop', now: PEAK });
    const seen: string[][] = [];
    await runLeasedLatencyProbe(
      h.env,
      async (providers) => {
        seen.push([...providers]);
        return 'ok';
      },
      PEAK,
    );
    expect(seen).toEqual([['unusual_whales']]);
  });
});

describe('probe wiring: the schedule paces a lane the lease granted', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
    _resetProbeCadenceLog();
  });
  afterEach(() => h.close());

  it('grants once, then denies off_cadence until the measured interval elapses', async () => {
    setHandoff(h.kv, 'quiver', true, PEAK);

    const first = await requestMacProbeLease(h.env, {
      provider: 'quiver',
      holderId: 'mac-laptop',
      now: PEAK,
    });
    expect(first.granted).toBe(true);
    expect(first.tier).toBe('peak');

    // The scout re-asks 20 seconds later, as its loop does. The lease
    // conditions all still pass; the cadence is what says no.
    const tooSoon = await requestMacProbeLease(h.env, {
      provider: 'quiver',
      holderId: 'mac-laptop',
      now: new Date(PEAK.getTime() + 20_000),
    });
    expect(tooSoon.granted).toBe(false);
    expect(tooSoon.denial).toBe('off_cadence');
    // Critically: a cadence denial must not spend a call to discover it was
    // too soon. The gate sits before the charge for exactly this reason.
    expect(tooSoon.charged).toBe(0);

    // Past the peak interval, the same request succeeds.
    const later = await requestMacProbeLease(h.env, {
      provider: 'quiver',
      holderId: 'mac-laptop',
      now: new Date(PEAK.getTime() + 10 * 60_000),
    });
    expect(later.granted).toBe(true);
  });

  it('paces the dead window far harder than the peak (same lane, same lease)', async () => {
    setHandoff(h.kv, 'quiver', true, PEAK);
    const grantsOver = async (start: Date, hours: number): Promise<number> => {
      let grants = 0;
      for (let m = 0; m < hours * 60; m += 1) {
        const res = await requestMacProbeLease(h.env, {
          provider: 'quiver',
          holderId: 'mac-laptop',
          now: new Date(start.getTime() + m * 60_000),
        });
        if (res.granted) grants++;
      }
      return grants;
    };
    // 02:00 ET -> 04:00 ET, the measured-zero stretch.
    const dead = await grantsOver(new Date('2026-08-05T06:00:00.000Z'), 2);
    h.kv.delete('latency-cadence:mac:quiver');
    // 09:00 ET -> 10:00 ET, the House burst hour (provider PEAK).
    const peak = await grantsOver(new Date('2026-08-05T13:00:00.000Z'), 1);
    expect(peak).toBeGreaterThan(dead);
    // Never zero: the coverage floor applies to the scout too.
    expect(dead).toBeGreaterThan(0);
  });

  it('leaves the scout unpaced when the schedule is switched off', async () => {
    const off = await makeHarness({ PROBE_SCHEDULE_ENABLED: '0' });
    try {
      setHandoff(off.kv, 'quiver', true, PEAK);
      const first = await requestMacProbeLease(off.env, {
        provider: 'quiver',
        holderId: 'mac-laptop',
        now: PEAK,
      });
      const immediately = await requestMacProbeLease(off.env, {
        provider: 'quiver',
        holderId: 'mac-laptop',
        now: new Date(PEAK.getTime() + 20_000),
      });
      expect(first.granted).toBe(true);
      // Today's behaviour, restored exactly: renewal on the scout's own loop.
      expect(immediately.granted).toBe(true);
      expect(immediately.denial).toBeNull();
    } finally {
      off.close();
    }
  });
});

describe('probe cadence log: skips stay legible without drowning the log', () => {
  beforeEach(() => _resetProbeCadenceLog());

  const base = {
    lane: 'house',
    source: 'house' as const,
    tier: 'low' as const,
    dayType: 'weekday' as const,
    intervalSec: 1789,
    elapsedSec: 120,
    authority: 'schedule' as const,
    reason: 'too-soon',
  };

  it('logs the first decision, then throttles identical skips', () => {
    const t0 = new Date('2026-08-05T04:00:00.000Z');
    expect(logProbeCadence({ ...base, probe: false }, t0)).toBe(true);
    expect(
      logProbeCadence({ ...base, probe: false }, new Date(t0.getTime() + 60_000)),
    ).toBe(false);
  });

  it('always logs a tier change and an actual probe', () => {
    const t0 = new Date('2026-08-05T04:00:00.000Z');
    logProbeCadence({ ...base, probe: false }, t0);
    // Tier moved low -> peak: the single most useful line for confirming the
    // measured windows are live in production.
    expect(
      logProbeCadence(
        { ...base, tier: 'peak', probe: false },
        new Date(t0.getTime() + 60_000),
      ),
    ).toBe(true);
    expect(
      logProbeCadence(
        { ...base, tier: 'peak', probe: true, reason: 'interval-elapsed' },
        new Date(t0.getTime() + 120_000),
      ),
    ).toBe(true);
  });

  it('forces a heartbeat so a stuck lane is never wholly silent', () => {
    const t0 = new Date('2026-08-05T04:00:00.000Z');
    logProbeCadence({ ...base, probe: false }, t0);
    expect(
      logProbeCadence({ ...base, probe: false }, new Date(t0.getTime() + 5 * 60_000)),
    ).toBe(false);
    expect(
      logProbeCadence({ ...base, probe: false }, new Date(t0.getTime() + 16 * 60_000)),
    ).toBe(true);
  });
});
