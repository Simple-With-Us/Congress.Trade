import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Env } from '../types.ts';
import {
  evaluateFmpLatencyCheck,
  enrichFmpLatencySelfHealingSilence,
  fmpLatencySilenceWouldBeCritical,
  nextUtcMidnightAfter,
  readFmpLatencySelfHealingGraceMs,
  selfHealingResetAtUtc,
} from '../fmpLatencyProbeHealth.ts';

vi.mock('../secrets/infisical.ts', () => ({
  resolveSecret: vi.fn(async (_env: Env, name: string) => ({
    value: name === 'FMP_LATENCY_API_KEY' ? 'key1' : null,
  })),
}));

vi.mock('../../ingestion/tradeLatency.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ingestion/tradeLatency.ts')>();
  return {
    ...actual,
    isFmpSlotHttp429DayBan: vi.fn(async () => false),
  };
});

vi.mock('../../ingestion/probeLease.ts', () => ({
  readProbeLease: vi.fn(async () => null),
}));

import { isFmpSlotHttp429DayBan } from '../../ingestion/tradeLatency.ts';
import { readProbeLease } from '../../ingestion/probeLease.ts';

describe('evaluateFmpLatencyCheck', () => {
  const nowMs = Date.parse('2026-11-01T18:00:00.000Z');
  const graceMs = readFmpLatencySelfHealingGraceMs(() => undefined);
  const base = {
    observationCount24h: 12,
    lastObservationAt: new Date(nowMs - 600_000).toISOString(),
    lastObservationAgeSec: 600,
    http429s24h: 0,
    byProvider: null,
  };

  it('healthy → ok', () => {
    const r = evaluateFmpLatencyCheck(base, nowMs, {
      probeExpected: true,
      criticalAgeSec: 3 * 3600,
      graceMs,
    });
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('live');
  });

  it('day-banned silence within reset → degraded, no liveness', () => {
    const lastObservationAt = new Date(nowMs - 5 * 3600_000).toISOString();
    const resetAtUtc = selfHealingResetAtUtc('fmp_day_ban', lastObservationAt);
    const silent = {
      ...base,
      observationCount24h: 0,
      lastObservationAgeSec: 5 * 3600,
      lastObservationAt,
      selfHealingSilence: { cause: 'fmp_day_ban' as const, resetAtUtc },
    };
    const r = evaluateFmpLatencyCheck(silent, nowMs, {
      probeExpected: true,
      criticalAgeSec: 3 * 3600,
      graceMs,
      selfHealing: silent.selfHealingSilence,
    });
    expect(r.status).toBe('degraded');
    expect(r.value.suppressLivenessNotification).toBe(true);
    expect(r.detail).toContain('day-banned');
    expect(r.detail).toContain('UTC');
  });

  it('silence 2h+ past reset → critical', () => {
    const resetAtUtc = '2026-11-01T00:00:00.000Z';
    const silent = {
      ...base,
      observationCount24h: 0,
      lastObservationAgeSec: 20 * 3600,
      lastObservationAt: new Date(nowMs - 20 * 3600_000).toISOString(),
      selfHealingSilence: { cause: 'fmp_day_ban' as const, resetAtUtc },
    };
    const r = evaluateFmpLatencyCheck(silent, nowMs, {
      probeExpected: true,
      criticalAgeSec: 3 * 3600,
      graceMs,
      selfHealing: silent.selfHealingSilence,
    });
    expect(r.status).toBe('critical');
    expect(fmpLatencySilenceWouldBeCritical(silent, true, 3 * 3600)).toBe(true);
  });

  it('day-ban self-healing past midnight-after-last-obs plus grace → critical', () => {
    const lastObservationAt = '2026-10-30T12:00:00.000Z';
    const resetAtUtc = selfHealingResetAtUtc('fmp_day_ban', lastObservationAt);
    const silent = {
      ...base,
      observationCount24h: 0,
      lastObservationAgeSec: 3 * 24 * 3600,
      lastObservationAt,
      selfHealingSilence: { cause: 'fmp_day_ban' as const, resetAtUtc },
    };
    const r = evaluateFmpLatencyCheck(silent, nowMs, {
      probeExpected: true,
      criticalAgeSec: 3 * 3600,
      graceMs,
      selfHealing: silent.selfHealingSilence,
    });
    expect(r.status).toBe('critical');
    expect(resetAtUtc).toBe('2026-10-31T00:00:00.000Z');
  });

  it('Mac lease handoff past last-obs plus one hour and grace → critical', () => {
    const lastObservationAt = '2026-11-01T13:00:00.000Z';
    const resetAtUtc = selfHealingResetAtUtc('probe_lease_handoff', lastObservationAt);
    const silent = {
      ...base,
      observationCount24h: 0,
      lastObservationAgeSec: 5 * 3600,
      lastObservationAt,
      selfHealingSilence: { cause: 'probe_lease_handoff' as const, resetAtUtc },
    };
    const r = evaluateFmpLatencyCheck(silent, nowMs, {
      probeExpected: true,
      criticalAgeSec: 3 * 3600,
      graceMs,
      selfHealing: silent.selfHealingSilence,
    });
    expect(r.status).toBe('critical');
    expect(resetAtUtc).toBe('2026-11-01T14:00:00.000Z');
  });
});

describe('enrichFmpLatencySelfHealingSilence', () => {
  const now = new Date('2026-11-01T18:00:00.000Z');
  const env = {
    FMP_LATENCY_API_KEY: 'key1',
    CONFIG_KV: { get: async () => null, put: async () => {}, delete: async () => {} },
    DB: {},
  } as Env;
  const silentFmp = {
    observationCount24h: 0,
    lastObservationAgeSec: 5 * 3600,
    lastObservationAt: new Date(now.getTime() - 5 * 3600_000).toISOString(),
    http429s24h: 2,
    byProvider: null,
  };

  beforeEach(() => {
    vi.mocked(isFmpSlotHttp429DayBan).mockReset();
    vi.mocked(readProbeLease).mockReset();
  });

  it('returns day_ban when all configured slots are 429 day-banned', async () => {
    vi.mocked(isFmpSlotHttp429DayBan).mockResolvedValue(true);
    const sh = await enrichFmpLatencySelfHealingSilence(env, silentFmp, now, () => undefined);
    expect(sh?.cause).toBe('fmp_day_ban');
    expect(sh?.resetAtUtc).toBe(nextUtcMidnightAfter(silentFmp.lastObservationAt!));
  });

  it('returns lease handoff when Mac holds fmp lease', async () => {
    vi.mocked(isFmpSlotHttp429DayBan).mockResolvedValue(false);
    vi.mocked(readProbeLease).mockResolvedValue({
      provider: 'fmp',
      holder: 'mac',
      holderId: 'mac-1',
      acquiredAt: now.toISOString(),
      expiresAt: '2026-11-01T23:00:00.000Z',
      tenureStartedAt: now.toISOString(),
      reason: null,
      renewals: 0,
      updatedAt: now.toISOString(),
      expired: false,
      secondsRemaining: 5 * 3600,
    });
    const sh = await enrichFmpLatencySelfHealingSilence(env, silentFmp, now, () => undefined);
    expect(sh?.cause).toBe('probe_lease_handoff');
    expect(sh?.resetAtUtc).toBe(selfHealingResetAtUtc('probe_lease_handoff', silentFmp.lastObservationAt!));
  });

  it('returns null when lastObservationAt is missing', async () => {
    vi.mocked(isFmpSlotHttp429DayBan).mockResolvedValue(true);
    const sh = await enrichFmpLatencySelfHealingSilence(
      env,
      { ...silentFmp, lastObservationAt: null },
      now,
      () => undefined,
    );
    expect(sh).toBeNull();
  });
});
