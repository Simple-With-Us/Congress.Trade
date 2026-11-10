/**
 * Mutual exclusion for latency provider polling.
 *
 * These run against a REAL in-memory SQLite with the actual migration files
 * applied (openMigratedD1), not a hand-written mock. That matters: the whole
 * safety argument rests on SQLite evaluating one conditional upsert atomically
 * and reporting changes=0 to the loser. A mock that returns whatever we tell it
 * would prove nothing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openMigratedD1 } from '../../prices/__tests__/sqliteD1.ts';
import {
  acquireProbeLease,
  macTenureExhausted,
  readAllProbeLeases,
  readProbeLease,
  releaseProbeLease,
  serverLeaseTtlMs,
  macLeaseTtlMs,
  macTenureMs,
} from '../probeLease.ts';
import {
  LATENCY_PROBE_HEALTH_KV_KEY,
  planServerLatencyProbe,
  requestMacProbeLease,
  runLeasedLatencyProbe,
  releaseHandedOffServerLanes,
  configuredServerProviders,
  SERVER_LEASE_HOLDER_ID,
  type LatencyProbeProviderId,
} from '../scoutHandoff.ts';
import { PROVIDER_CALLS_PER_RUN } from '../latencyCallLedger.ts';

const T0 = new Date('2026-08-11T12:00:00.000Z');
const HOUR = 3600_000;

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
    // Keep the probe surface small and deterministic.
    DISCLOSURE_LATENCY_PROVIDERS: 'unusual_whales,quiver',
    UNUSUAL_WHALES_API_KEY: 'uw-test-key',
    QUIVER_API_KEY: 'qq-test-key',
    ...overrides,
  } as never;
  return { env, kv, close };
}

/** Force a provider into (or out of) handoff by writing the health blob. */
function setHandoff(
  kv: Map<string, string>,
  provider: LatencyProbeProviderId,
  needScout: boolean,
): void {
  const raw = kv.get(LATENCY_PROBE_HEALTH_KV_KEY);
  const map = raw ? JSON.parse(raw) : {};
  map[provider] = {
    provider,
    lastAttemptAt: T0.toISOString(),
    lastSuccessAt: null,
    lastError: needScout ? 'HTTP_403' : null,
    lastFetchedRows: 0,
    lastSource: 'server',
    consecutiveServerErrors: needScout ? 3 : 0,
    needScout,
    needScoutReason: needScout ? 'server probe failed 3 successive times' : null,
    updatedAt: T0.toISOString(),
  };
  kv.set(LATENCY_PROBE_HEALTH_KV_KEY, JSON.stringify(map));
}

describe('probe lease: exactly one holder', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(() => h.close());

  it('refuses a second holder while the first lease is live', async () => {
    const first = await acquireProbeLease(h.env, {
      provider: 'quiver',
      holder: 'server',
      holderId: SERVER_LEASE_HOLDER_ID,
      ttlMs: 10 * 60_000,
      now: T0,
    });
    expect(first.granted).toBe(true);

    const second = await acquireProbeLease(h.env, {
      provider: 'quiver',
      holder: 'mac',
      holderId: 'mac-laptop',
      ttlMs: 150_000,
      now: new Date(T0.getTime() + 1000),
    });
    expect(second.granted).toBe(false);
    expect(second.denial).toBe('held_by_other');
    expect(second.current?.holder).toBe('server');
  });

  it('lets exactly one of N simultaneous acquirers win', async () => {
    // Same instant, same provider, different holders — the classic race the
    // advisory needScout flag could not prevent.
    const contenders = [
      { holder: 'server' as const, holderId: SERVER_LEASE_HOLDER_ID },
      { holder: 'mac' as const, holderId: 'mac-a' },
      { holder: 'mac' as const, holderId: 'mac-b' },
      { holder: 'mac' as const, holderId: 'mac-c' },
    ];
    const results = await Promise.all(
      contenders.map((c) =>
        acquireProbeLease(h.env, {
          provider: 'unusual_whales',
          holder: c.holder,
          holderId: c.holderId,
          ttlMs: 60_000,
          now: T0,
        }),
      ),
    );
    expect(results.filter((r) => r.granted)).toHaveLength(1);

    const leases = await readAllProbeLeases(h.env, T0);
    expect(leases.filter((l) => l.provider === 'unusual_whales')).toHaveLength(1);
  });

  it('does not let a different instance of the same holder steal a live lease', async () => {
    await acquireProbeLease(h.env, {
      provider: 'quiver',
      holder: 'mac',
      holderId: 'mac-old-pid',
      ttlMs: 150_000,
      now: T0,
    });
    const restarted = await acquireProbeLease(h.env, {
      provider: 'quiver',
      holder: 'mac',
      holderId: 'mac-new-pid',
      ttlMs: 150_000,
      now: new Date(T0.getTime() + 1000),
    });
    expect(restarted.granted).toBe(false);
  });

  it('renews in place for the same instance and keeps the tenure clock', async () => {
    await acquireProbeLease(h.env, {
      provider: 'quiver',
      holder: 'mac',
      holderId: 'mac-laptop',
      ttlMs: 150_000,
      now: T0,
    });
    const renewAt = new Date(T0.getTime() + 60_000);
    const renewed = await acquireProbeLease(h.env, {
      provider: 'quiver',
      holder: 'mac',
      holderId: 'mac-laptop',
      ttlMs: 150_000,
      now: renewAt,
    });
    expect(renewed.granted).toBe(true);
    expect(renewed.lease?.renewals).toBe(1);
    // Tenure must NOT restart on renewal, or the Mac could hold forever.
    expect(renewed.lease?.tenureStartedAt).toBe(T0.toISOString());
    expect(Date.parse(renewed.lease!.expiresAt)).toBe(renewAt.getTime() + 150_000);
  });

  it('token-guards release so a stale holder cannot free its successor', async () => {
    await acquireProbeLease(h.env, {
      provider: 'quiver',
      holder: 'mac',
      holderId: 'mac-current',
      ttlMs: 150_000,
      now: T0,
    });
    expect(await releaseProbeLease(h.env, 'quiver', 'mac', 'mac-stale')).toBe(false);
    expect(await readProbeLease(h.env, 'quiver', T0)).not.toBeNull();
    expect(await releaseProbeLease(h.env, 'quiver', 'mac', 'mac-current')).toBe(true);
    expect(await readProbeLease(h.env, 'quiver', T0)).toBeNull();
  });
});

describe('probe lease: self-expiry after a crash', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(() => h.close());

  it('frees the lane once the TTL passes, with no release call', async () => {
    // Holder acquires and then "crashes" — it never releases.
    const held = await acquireProbeLease(h.env, {
      provider: 'quiver',
      holder: 'mac',
      holderId: 'mac-crashed',
      ttlMs: 150_000,
      now: T0,
    });
    expect(held.granted).toBe(true);

    const duringTtl = await acquireProbeLease(h.env, {
      provider: 'quiver',
      holder: 'server',
      holderId: SERVER_LEASE_HOLDER_ID,
      ttlMs: 20 * 60_000,
      now: new Date(T0.getTime() + 149_000),
    });
    expect(duringTtl.granted).toBe(false);

    const afterTtl = await acquireProbeLease(h.env, {
      provider: 'quiver',
      holder: 'server',
      holderId: SERVER_LEASE_HOLDER_ID,
      ttlMs: 20 * 60_000,
      now: new Date(T0.getTime() + 151_000),
    });
    expect(afterTtl.granted).toBe(true);
    expect(afterTtl.lease?.holder).toBe('server');
    // Takeover restarts the tenure clock.
    expect(afterTtl.lease?.renewals).toBe(0);
  });

  it('reports an expired lease as expired with zero seconds remaining', async () => {
    await acquireProbeLease(h.env, {
      provider: 'quiver',
      holder: 'server',
      holderId: SERVER_LEASE_HOLDER_ID,
      ttlMs: 60_000,
      now: T0,
    });
    const later = await readProbeLease(h.env, 'quiver', new Date(T0.getTime() + 90_000));
    expect(later?.expired).toBe(true);
    expect(later?.secondsRemaining).toBe(0);
  });

  it('bounds every configured TTL so a bad env value cannot park a lane', async () => {
    const insane = await makeHarness({
      LATENCY_LEASE_SERVER_TTL_SEC: '999999',
      LATENCY_LEASE_MAC_TTL_SEC: '0.001',
      LATENCY_MAC_TENURE_HOURS: '9999',
    });
    expect(serverLeaseTtlMs(insane.env)).toBe(60 * 60 * 1000);
    expect(macLeaseTtlMs(insane.env)).toBe(30 * 1000);
    expect(macTenureMs(insane.env)).toBe(48 * HOUR);
    insane.close();
  });
});

describe('server-preferred lane assignment', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(() => h.close());

  it('takes every lane while healthy', async () => {
    const plan = await planServerLatencyProbe(h.env, T0);
    expect(plan.probeProviders.sort()).toEqual(['quiver', 'unusual_whales']);
    expect(plan.lanes.every((l) => l.action === 'acquired')).toBe(true);
  });

  it('honours DISCLOSURE_LATENCY_PROVIDERS instead of probing everything', async () => {
    expect(await configuredServerProviders(h.env)).toEqual(['unusual_whales', 'quiver']);
    const dflt = await makeHarness({ DISCLOSURE_LATENCY_PROVIDERS: '' });
    expect((await configuredServerProviders(dflt.env)).sort()).toEqual([
      'fmp',
      'fmp_rapidapi',
      'quiver',
      'unusual_whales',
    ]);
    dflt.close();
  });

  it('stops fetching a handed-off provider and releases the lane', async () => {
    // Server owns the lane, then hits its 3rd consecutive failure.
    await planServerLatencyProbe(h.env, T0);
    setHandoff(h.kv, 'quiver', true);

    const plan = await planServerLatencyProbe(h.env, new Date(T0.getTime() + 60_000));
    expect(plan.probeProviders).toEqual(['unusual_whales']);
    const quiver = plan.lanes.find((l) => l.provider === 'quiver');
    expect(quiver?.action).toBe('handed_off');
    expect(quiver?.probe).toBe(false);
    // Released, so the Mac can take it immediately rather than after the TTL.
    expect(await readProbeLease(h.env, 'quiver', T0)).toBeNull();
  });

  it('reclaims a handed-off provider when no Mac lease is live (scout retired)', async () => {
    await planServerLatencyProbe(h.env, T0);
    setHandoff(h.kv, 'quiver', true);
    const handoff = await planServerLatencyProbe(h.env, new Date(T0.getTime() + 60_000));
    expect(handoff.lanes.find((l) => l.provider === 'quiver')?.action).toBe('handed_off');
    expect(await readProbeLease(h.env, 'quiver', T0)).toBeNull();

    const reclaim = await planServerLatencyProbe(h.env, new Date(T0.getTime() + 120_000));
    const quiver = reclaim.lanes.find((l) => l.provider === 'quiver');
    expect(quiver?.probe).toBe(true);
    expect(quiver?.action).toBe('acquired');
    expect(reclaim.probeProviders).toEqual(expect.arrayContaining(['quiver']));
  });

  it('never calls the probe with an empty provider list', async () => {
    // An empty `providers` array makes tradeLatency fall back to ALL providers,
    // which would silently undo the exclusion. It must not be called at all.
    setHandoff(h.kv, 'quiver', true);
    setHandoff(h.kv, 'unusual_whales', true);
    await requestMacProbeLease(h.env, { provider: 'quiver', holderId: 'mac-laptop', now: T0 });
    await requestMacProbeLease(h.env, { provider: 'unusual_whales', holderId: 'mac-laptop', now: T0 });
    const calls: LatencyProbeProviderId[][] = [];
    const outcome = await runLeasedLatencyProbe(
      h.env,
      async (providers) => {
        calls.push(providers);
        return 'ran';
      },
      T0,
    );
    expect(calls).toHaveLength(0);
    expect(outcome.result).toBeNull();
    expect(outcome.skipped.map((s) => s.provider).sort()).toEqual(['quiver', 'unusual_whales']);
  });

  it('passes only the leased providers to the probe', async () => {
    setHandoff(h.kv, 'quiver', true);
    await requestMacProbeLease(h.env, { provider: 'quiver', holderId: 'mac-laptop', now: T0 });
    const calls: LatencyProbeProviderId[][] = [];
    await runLeasedLatencyProbe(
      h.env,
      async (providers) => {
        calls.push(providers);
        return 'ran';
      },
      T0,
    );
    expect(calls).toEqual([['unusual_whales']]);
  });

  it('releases a lane whose reclaim probe left it still handed off', async () => {
    await planServerLatencyProbe(h.env, T0);
    expect(await readProbeLease(h.env, 'quiver', T0)).not.toBeNull();
    // Probe ran and failed again -> health says handoff.
    setHandoff(h.kv, 'quiver', true);
    const released = await releaseHandedOffServerLanes(h.env, ['quiver', 'unusual_whales'], T0);
    expect(released).toEqual(['quiver']);
    expect(await readProbeLease(h.env, 'quiver', T0)).toBeNull();
    // The healthy lane is untouched.
    expect(await readProbeLease(h.env, 'unusual_whales', T0)).not.toBeNull();
  });
});

describe('bounded Mac tenure and handback', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness({ LATENCY_MAC_TENURE_HOURS: '6' });
    setHandoff(h.kv, 'quiver', true);
  });
  afterEach(() => h.close());

  it('grants the Mac a handed-off lane', async () => {
    const res = await requestMacProbeLease(h.env, {
      provider: 'quiver',
      holderId: 'mac-laptop',
      now: T0,
    });
    expect(res.granted).toBe(true);
    expect(res.lease?.holder).toBe('mac');
  });

  it('refuses a lane the server has not handed off', async () => {
    const res = await requestMacProbeLease(h.env, {
      provider: 'unusual_whales',
      holderId: 'mac-laptop',
      now: T0,
    });
    expect(res.granted).toBe(false);
    expect(res.denial).toBe('not_eligible');
  });

  it('cuts the Mac off once its window is spent, even while it is succeeding', async () => {
    const first = await requestMacProbeLease(h.env, {
      provider: 'quiver',
      holderId: 'mac-laptop',
      now: T0,
    });
    expect(first.granted).toBe(true);

    // Renewing every cycle keeps the lease alive but not the tenure.
    const midway = await requestMacProbeLease(h.env, {
      provider: 'quiver',
      holderId: 'mac-laptop',
      now: new Date(T0.getTime() + 5 * HOUR),
    });
    expect(midway.granted).toBe(true);

    const past = new Date(T0.getTime() + 6 * HOUR + 60_000);
    expect(macTenureExhausted(midway.lease, 6 * HOUR, past)).toBe(true);
    const expired = await requestMacProbeLease(h.env, {
      provider: 'quiver',
      holderId: 'mac-laptop',
      now: past,
    });
    expect(expired.granted).toBe(false);
    expect(expired.denial).toBe('tenure_exhausted');
  });

  it('lets the server preempt the Mac after the tenure window', async () => {
    await requestMacProbeLease(h.env, {
      provider: 'quiver',
      holderId: 'mac-laptop',
      now: T0,
    });
    const past = new Date(T0.getTime() + 6 * HOUR + 60_000);
    // Mac lease is still LIVE (it renewed), yet the server must get it back.
    await requestMacProbeLease(h.env, {
      provider: 'quiver',
      holderId: 'mac-laptop',
      now: new Date(T0.getTime() + 6 * HOUR - 60_000),
    });
    const plan = await planServerLatencyProbe(h.env, past);
    const quiver = plan.lanes.find((l) => l.provider === 'quiver');
    expect(quiver?.action).toBe('reclaimed');
    expect(quiver?.probe).toBe(true);
    expect(plan.probeProviders).toContain('quiver');
    expect((await readProbeLease(h.env, 'quiver', past))?.holder).toBe('server');
  });

  it('does not preempt before the window is up', async () => {
    await requestMacProbeLease(h.env, {
      provider: 'quiver',
      holderId: 'mac-laptop',
      now: T0,
    });
    const mid = new Date(T0.getTime() + 3 * HOUR);
    await requestMacProbeLease(h.env, {
      provider: 'quiver',
      holderId: 'mac-laptop',
      now: mid,
    });
    const plan = await planServerLatencyProbe(h.env, mid);
    const quiver = plan.lanes.find((l) => l.provider === 'quiver');
    expect(quiver?.probe).toBe(false);
    expect((await readProbeLease(h.env, 'quiver', mid))?.holder).toBe('mac');
  });

  it('drops the Mac lease the moment the server recovers', async () => {
    await requestMacProbeLease(h.env, {
      provider: 'quiver',
      holderId: 'mac-laptop',
      now: T0,
    });
    // Server succeeded -> needScout false.
    setHandoff(h.kv, 'quiver', false);
    const res = await requestMacProbeLease(h.env, {
      provider: 'quiver',
      holderId: 'mac-laptop',
      now: new Date(T0.getTime() + 60_000),
    });
    expect(res.granted).toBe(false);
    expect(res.denial).toBe('not_eligible');
    // Lane freed right away rather than after the TTL, so the server resumes now.
    expect(await readProbeLease(h.env, 'quiver', T0)).toBeNull();
  });
});

describe('one shared daily ledger across both hosts', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
    setHandoff(h.kv, 'quiver', true);
  });
  afterEach(() => h.close());

  const dayKey = 'latency-budget:qq:2026-08-11';

  it('charges Mac calls to the same counter the server spends from', async () => {
    expect(h.kv.get(dayKey)).toBeUndefined();
    const res = await requestMacProbeLease(h.env, {
      provider: 'quiver',
      holderId: 'mac-laptop',
      now: T0,
    });
    expect(res.granted).toBe(true);
    expect(res.charged).toBe(PROVIDER_CALLS_PER_RUN.quiver);
    expect(h.kv.get(dayKey)).toBe(String(PROVIDER_CALLS_PER_RUN.quiver));
  });

  it('adds Mac spend on top of server spend rather than tracking it separately', async () => {
    // Pretend the server already spent 12 calls today.
    h.kv.set(dayKey, '12');
    await requestMacProbeLease(h.env, {
      provider: 'quiver',
      holderId: 'mac-laptop',
      now: T0,
    });
    expect(h.kv.get(dayKey)).toBe(String(12 + PROVIDER_CALLS_PER_RUN.quiver));
  });

  it('charges once per renewal, so one grant buys exactly one poll', async () => {
    // Spacing is 40 minutes, not the scout's 45-second loop, because the
    // measured cadence now gates renewals (see the off_cadence test below).
    // T0 = 08:00 ET is the provider LOW tier (21:00-09:00), interval 1800s;
    // 40 minutes clears it, so each iteration is a genuine new authorization
    // and this test measures what it means to measure — ledger accounting.
    for (let i = 0; i < 4; i++) {
      await requestMacProbeLease(h.env, {
        provider: 'quiver',
        holderId: 'mac-laptop',
        now: new Date(T0.getTime() + i * 40 * 60_000),
      });
    }
    expect(h.kv.get(dayKey)).toBe(String(4 * PROVIDER_CALLS_PER_RUN.quiver));
  });

  it('denies the Mac once the shared daily cap is exhausted', async () => {
    h.kv.set(dayKey, '359'); // default QUIVER_LATENCY_DAILY_CAP is 360; a run needs 3
    const res = await requestMacProbeLease(h.env, {
      provider: 'quiver',
      holderId: 'mac-laptop',
      now: T0,
    });
    expect(res.granted).toBe(false);
    expect(res.denial).toBe('daily_cap');
    expect(res.budget?.remaining).toBe(1);
    // Nothing charged on a denial, and no lease handed out.
    expect(h.kv.get(dayKey)).toBe('359');
    expect(await readProbeLease(h.env, 'quiver', T0)).toBeNull();
  });

  it('respects an env-raised cap', async () => {
    const raised = await makeHarness({
      DISCLOSURE_LATENCY_PROVIDERS: 'quiver',
      QUIVER_API_KEY: 'qq-test-key',
      QUIVER_LATENCY_DAILY_CAP: '600',
    });
    setHandoff(raised.kv, 'quiver', true);
    raised.kv.set(dayKey, '400');
    const res = await requestMacProbeLease(raised.env, {
      provider: 'quiver',
      holderId: 'mac-laptop',
      now: T0,
    });
    expect(res.granted).toBe(true);
    expect(res.budget?.cap).toBe(600);
    raised.close();
  });
});
