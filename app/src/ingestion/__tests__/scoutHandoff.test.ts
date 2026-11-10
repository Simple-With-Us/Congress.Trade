import { describe, it, expect, beforeEach } from 'vitest';
import {
  computeNeedScout,
  isLatencyProbeAuthError,
  LATENCY_PROBE_HEALTH_KV_KEY,
  LATENCY_SCOUT_CONSECUTIVE_ERRORS,
  latencyProvidersWithRejectedCredentials,
  shouldThrottleAuthRejectedLatencyProbe,
  recordLatencyProbeOutcome,
  buildScoutPlan,
  refreshLatencySilenceFromDb,
} from '../scoutHandoff.ts';

describe('computeNeedScout (consecutive errors)', () => {
  it('clears handoff on server success', () => {
    expect(
      computeNeedScout({
        kind: 'success',
        source: 'server',
        prevConsecutiveServerErrors: 5,
      }),
    ).toEqual({
      consecutiveServerErrors: 0,
      needScout: false,
      needScoutReason: null,
    });
  });

  it('does not hand off on the 1st or 2nd successive server error', () => {
    const first = computeNeedScout({
      kind: 'error',
      source: 'server',
      lastError: 'HTTP_403',
      prevConsecutiveServerErrors: 0,
    });
    expect(first.consecutiveServerErrors).toBe(1);
    expect(first.needScout).toBe(false);

    const second = computeNeedScout({
      kind: 'error',
      source: 'server',
      lastError: 'HTTP_403',
      prevConsecutiveServerErrors: 1,
    });
    expect(second.consecutiveServerErrors).toBe(2);
    expect(second.needScout).toBe(false);
  });

  it('counts the 3rd successive server error but never hands off (scout retired)', () => {
    // Scout retired 2026-09-09: there is no host to hand the lane to, so
    // `needScout` is false on every path.  The count and the reason string
    // survive as observability — the dashboard still surfaces the streak.
    const third = computeNeedScout({
      kind: 'error',
      source: 'server',
      lastError: 'HTTP_429',
      prevConsecutiveServerErrors: 2,
    });
    expect(third.consecutiveServerErrors).toBe(3);
    expect(third.needScout).toBe(false);
    expect(third.needScoutReason).toMatch(/3 successive/);
    expect(third.needScoutReason).toMatch(/HTTP_429/);
  });

  it('does not hand off on budget_skip (spacing/cap is not a failure)', () => {
    const r = computeNeedScout({
      kind: 'budget_skip',
      source: 'server',
      prevConsecutiveServerErrors: 1,
    });
    expect(r.consecutiveServerErrors).toBe(1);
    expect(r.needScout).toBe(false);
  });

  it('maps a historical scout record onto a server-owned lane (no phantom handoff)', () => {
    // `source: 'scout'` can now only arrive from a KV row written before the
    // 2026-09-09 retirement.  Reading one must not resurrect a handoff flag
    // on the dashboard, but it must not lose the error streak either.
    const r = computeNeedScout({
      kind: 'success',
      source: 'scout',
      prevConsecutiveServerErrors: LATENCY_SCOUT_CONSECUTIVE_ERRORS,
    });
    expect(r.consecutiveServerErrors).toBe(LATENCY_SCOUT_CONSECUTIVE_ERRORS);
    expect(r.needScout).toBe(false);
    expect(r.needScoutReason).toBeNull();
  });

  it('disabled never opens handoff', () => {
    expect(
      computeNeedScout({
        kind: 'disabled',
        source: 'server',
        prevConsecutiveServerErrors: 0,
      }).needScout,
    ).toBe(false);
  });

  it('not_configured reports the gap but cannot hand off (no Mac fallback)', () => {
    // Previously the one path that opened handoff immediately.  With the scout
    // retired an unconfigured provider simply logs and skips until keys land
    // in Infisical; the reason string is what tells the operator that.
    const r = computeNeedScout({
      kind: 'not_configured',
      source: 'server',
      prevConsecutiveServerErrors: 0,
    });
    expect(r.needScout).toBe(false);
    expect(r.needScoutReason).toMatch(/not configured/);
  });
});

describe('recordLatencyProbeOutcome + plan', () => {
  const kvStore = new Map<string, string>();
  const env = {
    CONFIG_KV: {
      get: async (key: string, type?: string) => {
        const v = kvStore.get(key);
        if (v == null) return null;
        return type === 'json' ? JSON.parse(v) : v;
      },
      put: async (key: string, value: string) => {
        kvStore.set(key, value);
      },
    },
    DB: {
      prepare: () => ({
        bind: () => ({
          all: async () => ({ results: [] }),
          first: async () => null,
          run: async () => ({ meta: {} }),
        }),
      }),
    },
  } as never;

  beforeEach(() => {
    kvStore.clear();
  });

  it('does not resurrect needScout when reading a pre-retirement KV row', async () => {
    // `computeNeedScout` never writes `needScout: true` any more, but the read
    // path normalizes every row it loads.  If that normalizer re-derived
    // handoff from the error count, a legacy row — or any provider three
    // errors into an outage — would flip back to true on the next read and
    // route the lane down the retired-Mac branch.
    kvStore.set(
      LATENCY_PROBE_HEALTH_KV_KEY,
      JSON.stringify({
        fmp: {
          provider: 'fmp',
          lastAttemptAt: '2026-09-01T00:00:00.000Z',
          lastSuccessAt: null,
          lastError: 'HTTP_403',
          lastFetchedRows: 0,
          lastSource: 'scout',
          consecutiveServerErrors: 5,
          needScout: true,
          needScoutReason: 'server probe failed 5 successive times (threshold 3)',
          updatedAt: '2026-09-01T00:00:00.000Z',
        },
      }),
    );

    const out = await recordLatencyProbeOutcome(env, 'fmp', {
      kind: 'budget_skip',
      now: new Date('2026-09-10T12:00:00.000Z'),
    });

    expect(out.needScout).toBe(false);
    // The streak itself survives — it is what the dashboard shows.
    expect(out.consecutiveServerErrors).toBe(5);
  });

  it('accumulates successive server errors without ever setting needScout', async () => {
    const t0 = new Date('2026-08-11T12:00:00.000Z');
    const e1 = await recordLatencyProbeOutcome(env, 'fmp', {
      kind: 'error',
      error: 'HTTP_403',
      now: t0,
    });
    expect(e1.needScout).toBe(false);
    expect(e1.consecutiveServerErrors).toBe(1);

    const e2 = await recordLatencyProbeOutcome(env, 'fmp', {
      kind: 'error',
      error: 'HTTP_403',
      now: new Date(t0.getTime() + 60_000),
    });
    expect(e2.needScout).toBe(false);
    expect(e2.consecutiveServerErrors).toBe(2);

    const e3 = await recordLatencyProbeOutcome(env, 'fmp', {
      kind: 'error',
      error: 'HTTP_403',
      now: new Date(t0.getTime() + 120_000),
    });
    // Streak is still recorded end-to-end through KV; handoff is not.
    expect(e3.needScout).toBe(false);
    expect(e3.consecutiveServerErrors).toBe(3);
  });

  it('server success after handoff reclaims the lane', async () => {
    for (let i = 0; i < 3; i++) {
      await recordLatencyProbeOutcome(env, 'fmp', {
        kind: 'error',
        error: 'HTTP_429',
        now: new Date(`2026-08-11T12:0${i}:00.000Z`),
      });
    }
    const ok = await recordLatencyProbeOutcome(env, 'fmp', {
      kind: 'success',
      fetchedRows: 10,
      source: 'server',
      now: new Date('2026-08-11T12:10:00.000Z'),
    });
    expect(ok.needScout).toBe(false);
    expect(ok.consecutiveServerErrors).toBe(0);
  });

  it('does not open handoff from wall-clock silence alone', async () => {
    // Seed a stale lastSuccessAt without consecutive errors.
    await recordLatencyProbeOutcome(env, 'fmp', {
      kind: 'success',
      fetchedRows: 5,
      source: 'server',
      now: new Date('2026-08-01T00:00:00.000Z'),
    });
    const map = await refreshLatencySilenceFromDb(env, new Date('2026-08-11T12:00:00.000Z'));
    expect(map.fmp?.needScout).toBe(false);
    expect(map.fmp?.consecutiveServerErrors).toBe(0);
  });

  it('buildScoutPlan no longer puts FMP on the scout after a server-error streak', async () => {
    // The plan is the Mac's work list, and the Mac is retired: a server-error
    // streak keeps the lane server-owned instead of handing FMP over, so there
    // is nothing to cover and no secondary-key hint to give.
    for (let i = 0; i < 3; i++) {
      await recordLatencyProbeOutcome(env, 'fmp', {
        kind: 'error',
        error: 'blocked',
        now: new Date(`2026-08-11T13:0${i}:00.000Z`),
      });
    }
    const plan = await buildScoutPlan(env, new Date('2026-08-11T13:10:00.000Z'));
    expect(plan.latencyNeedScout.some((h) => h.provider === 'fmp')).toBe(false);
    expect(plan.fmpPreferSecondaryKey).toBe(false);
  });

  it('never hands off fmp_rapidapi when RapidAPI path is not enabled (default stable-only)', async () => {
    // Stale v1-style claim on rapidapi must not surface in the plan.
    await recordLatencyProbeOutcome(env, 'fmp_rapidapi', {
      kind: 'error',
      error: 'HTTP_404',
      now: new Date('2026-08-11T14:00:00.000Z'),
    });
    await recordLatencyProbeOutcome(env, 'fmp_rapidapi', {
      kind: 'error',
      error: 'HTTP_404',
      now: new Date('2026-08-11T14:01:00.000Z'),
    });
    await recordLatencyProbeOutcome(env, 'fmp_rapidapi', {
      kind: 'error',
      error: 'HTTP_404',
      now: new Date('2026-08-11T14:02:00.000Z'),
    });
    const plan = await buildScoutPlan(env, new Date('2026-08-11T14:05:00.000Z'));
    expect(plan.latencyNeedScout.some((h) => h.provider === 'fmp_rapidapi')).toBe(false);
    const row = plan.latency.find((h) => h.provider === 'fmp_rapidapi');
    expect(row?.needScout).toBe(false);
  });
});

describe('isLatencyProbeAuthError', () => {
  it('matches server and scout auth failure signatures', () => {
    expect(isLatencyProbeAuthError('HTTP_401:https://api.example')).toBe(true);
    expect(isLatencyProbeAuthError('UW HTTP 401')).toBe(true);
    expect(isLatencyProbeAuthError('qq:house: QQ house HTTP 403')).toBe(true);
    expect(isLatencyProbeAuthError('HTTP_429')).toBe(false);
  });
});

describe('latencyProvidersWithRejectedCredentials', () => {
  it('latches membership providers after consecutive auth errors in KV health', async () => {
    const kvStore = new Map<string, string>();
    kvStore.set(
      LATENCY_PROBE_HEALTH_KV_KEY,
      JSON.stringify({
        unusual_whales: {
          provider: 'unusual_whales',
          consecutiveServerErrors: 3,
          lastError: 'HTTP_401:https://api.unusualwhales.com/',
          lastAttemptAt: '2026-10-01T00:00:00.000Z',
          lastSuccessAt: null,
          lastFetchedRows: 0,
          lastSource: 'server',
          needScout: false,
          needScoutReason: null,
          updatedAt: '2026-10-01T00:00:00.000Z',
        },
      }),
    );
    const env = {
      CONFIG_KV: {
        get: async (key: string, type?: string) => {
          const v = kvStore.get(key);
          if (v == null) return null;
          return type === 'json' ? JSON.parse(v) : v;
        },
        put: async () => {},
      },
      DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }) },
    } as never;
    const rejected = await latencyProvidersWithRejectedCredentials(env);
    expect(rejected.has('unusual_whales')).toBe(true);
    expect(rejected.has('fmp')).toBe(false);
  });
});

describe('shouldThrottleAuthRejectedLatencyProbe', () => {
  const kvStore = new Map<string, string>();
  const baseHealth = {
    provider: 'unusual_whales' as const,
    consecutiveServerErrors: 3,
    lastError: 'HTTP_401:https://api.unusualwhales.com/',
    lastAttemptAt: '2026-10-15T10:00:00.000Z',
    lastSuccessAt: null,
    lastFetchedRows: 0,
    lastSource: 'server' as const,
    needScout: false,
    needScoutReason: null,
    updatedAt: '2026-10-15T10:00:00.000Z',
  };
  const env = {
    CONFIG_KV: {
      get: async (key: string, type?: string) => {
        const v = kvStore.get(key);
        if (v == null) return null;
        return type === 'json' ? JSON.parse(v) : v;
      },
      put: async () => {},
    },
    DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }) },
  } as never;

  beforeEach(() => {
    kvStore.clear();
    kvStore.set(LATENCY_PROBE_HEALTH_KV_KEY, JSON.stringify({ unusual_whales: baseHealth }));
  });

  it('throttles HTTP inside the recovery window but force bypasses', async () => {
    const inside = new Date('2026-10-15T12:00:00.000Z');
    expect(await shouldThrottleAuthRejectedLatencyProbe(env, 'unusual_whales', inside, {})).toBe(true);
    expect(await shouldThrottleAuthRejectedLatencyProbe(env, 'unusual_whales', inside, { force: true })).toBe(
      false,
    );
    const after = new Date('2026-10-15T17:00:00.000Z');
    expect(await shouldThrottleAuthRejectedLatencyProbe(env, 'unusual_whales', after, {})).toBe(false);
  });
});
