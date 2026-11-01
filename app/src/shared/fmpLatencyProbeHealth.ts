/**
 * FMP latency probe silence: self-healing states (429 day-ban, Mac lease handoff)
 * and loud-alert confirmation for unexplained silence (CT-2335).
 */

import type { Env } from './types.ts';
import { isFmpSlotHttp429DayBan } from '../ingestion/tradeLatency.ts';
import { readProbeLease } from '../ingestion/probeLease.ts';
import { resolveSecret } from '../secrets/infisical.ts';

export const FMP_LATENCY_CRITICAL_AGE_SEC_DEFAULT = 3 * 3600;
export const FMP_LATENCY_SELF_HEALING_GRACE_SEC_DEFAULT = 2 * 3600;

export const FMP_LATENCY_SILENCE_PENDING_KV_KEY = 'pipeline-loud-alert:fmp_latency_silence:pending';

type FmpLatencyTier = 'ok' | 'degraded' | 'critical';

export type FmpLatencySelfHealingSilence = {
  cause: 'fmp_day_ban' | 'probe_lease_handoff';
  resetAtUtc: string;
};

export type FmpLatencySignal = {
  observationCount24h: number | null;
  lastObservationAt: string | null;
  lastObservationAgeSec: number | null;
  http429s24h: number | null;
  byProvider: Record<string, { lastObservationAt: string | null; ageSec: number | null; count24h: number | null }> | null;
  selfHealingSilence?: FmpLatencySelfHealingSilence | null;
};

export type FmpLatencyCheckValue = {
  observationCount24h: number | null;
  lastObservationAt: string | null;
  lastObservationAgeSec: number | null;
  http429s24h: number | null;
  byProvider: FmpLatencySignal['byProvider'];
  selfHealingSilence?: FmpLatencySelfHealingSilence | null;
  /** When true, the hourly liveness Pushover sweep skips this check (no episode). */
  suppressLivenessNotification?: boolean;
};

export function readFmpLatencyCriticalAgeSec(envGet: (k: string) => string | undefined): number {
  const n = Number.parseInt(envGet('CT_FMP_LATENCY_SILENCE_CRITICAL_SEC') || '', 10);
  return Number.isFinite(n) && n >= 60 ? Math.min(n, 7 * 24 * 3600) : FMP_LATENCY_CRITICAL_AGE_SEC_DEFAULT;
}

export function readFmpLatencySelfHealingGraceMs(envGet: (k: string) => string | undefined): number {
  const n = Number.parseInt(envGet('CT_FMP_LATENCY_SELF_HEALING_GRACE_SEC') || '', 10);
  const sec = Number.isFinite(n) && n >= 0 ? Math.min(n, 7 * 24 * 3600) : FMP_LATENCY_SELF_HEALING_GRACE_SEC_DEFAULT;
  return sec * 1000;
}

export function nextUtcMidnightIso(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
}

/** Next UTC midnight strictly after the given observation timestamp. */
export function nextUtcMidnightAfter(isoTimestamp: string): string {
  const d = new Date(isoTimestamp);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
}

export function selfHealingResetAtUtc(
  cause: FmpLatencySelfHealingSilence['cause'],
  lastObservationAt: string,
): string {
  if (cause === 'fmp_day_ban') {
    return nextUtcMidnightAfter(lastObservationAt);
  }
  return new Date(Date.parse(lastObservationAt) + 3600_000).toISOString();
}

export function fmpLatencyProbeExpected(envGet: (k: string) => string | undefined): boolean {
  const on = envGet('FMP_LATENCY_PROBE_ENABLED');
  return on !== 'false' && on !== '0';
}

export function fmpLatencySilenceWouldBeCritical(
  fmp: FmpLatencySignal,
  probeExpected: boolean,
  criticalAgeSec: number,
): boolean {
  if (!probeExpected) return false;
  const ageSec = fmp.lastObservationAgeSec;
  const count = fmp.observationCount24h;
  return ageSec == null || ageSec > criticalAgeSec || (count ?? 0) === 0;
}

function selfHealingDetail(cause: FmpLatencySelfHealingSilence['cause'], resetAtUtc: string): string {
  if (cause === 'fmp_day_ban') {
    return `FMP latency probe quiet: all free-tier keys day-banned after HTTP 429 (self-healing at ${resetAtUtc} UTC).`;
  }
  return `FMP latency probe quiet: Mac holds the fmp probe lease (handoff in progress; expected to resume by ${resetAtUtc} UTC).`;
}

export function evaluateFmpLatencyCheck(
  fmp: FmpLatencySignal,
  nowMs: number,
  opts: {
    probeExpected: boolean;
    criticalAgeSec: number;
    graceMs: number;
    selfHealing?: FmpLatencySelfHealingSilence | null;
  },
): { status: FmpLatencyTier; detail: string; value: FmpLatencyCheckValue } {
  const ageSec = fmp.lastObservationAgeSec;
  const count = fmp.observationCount24h;
  const f429 = fmp.http429s24h;
  const baseValue: FmpLatencyCheckValue = {
    observationCount24h: count,
    lastObservationAt: fmp.lastObservationAt,
    lastObservationAgeSec: ageSec,
    http429s24h: f429,
    byProvider: fmp.byProvider,
    selfHealingSilence: opts.selfHealing ?? fmp.selfHealingSilence ?? null,
  };

  const silenceCritical = fmpLatencySilenceWouldBeCritical(fmp, opts.probeExpected, opts.criticalAgeSec);
  const selfHealing = baseValue.selfHealingSilence;
  if (silenceCritical && selfHealing) {
    const resetMs = Date.parse(selfHealing.resetAtUtc);
    const pastGrace = Number.isFinite(resetMs) && nowMs >= resetMs + opts.graceMs;
    if (!pastGrace) {
      return {
        status: 'degraded',
        detail: selfHealingDetail(selfHealing.cause, selfHealing.resetAtUtc),
        value: { ...baseValue, suppressLivenessNotification: true },
      };
    }
  }

  const isCritical = silenceCritical;
  const isDegraded = !isCritical && (ageSec == null || ageSec > 3600 || (f429 ?? 0) > 5);
  const tier: FmpLatencyTier = isCritical ? 'critical' : isDegraded ? 'degraded' : 'ok';
  const detail = isCritical
    ? `FMP latency probe silent for ${ageSec != null ? Math.round(ageSec / 60) + ' min' : 'no observation in 48h'} (${count ?? 0} obs/24h). Observations are not committing.  Check SQLITE_BUSY / WAL checkpoint before rotating FMP_LATENCY_API_KEY.`
    : isDegraded
      ? `FMP latency probe lagging (last age ${ageSec != null ? Math.round(ageSec / 60) + ' min' : 'unknown'}, ${f429 ?? 0} HTTP 429s in 24h).`
      : `FMP latency probe live (last observation ${ageSec != null ? Math.round(ageSec / 60) + ' min ago' : 'unknown'}, ${count ?? 0} obs in 24h, ${f429 ?? 0} 429s).`;
  return { status: tier, detail, value: baseValue };
}

async function configuredFmpLatencySlots(env: Env): Promise<Array<'1' | '2'>> {
  const envx = env as unknown as Record<string, string | undefined>;
  const slots: Array<'1' | '2'> = [];
  const primary =
    (await resolveSecret(env, 'FMP_LATENCY_API_KEY' as keyof Env & string)).value?.trim()
    ?? envx.FMP_LATENCY_API_KEY?.trim();
  if (primary) slots.push('1');
  for (const name of ['FMP_LATENCY_API_KEY_2', 'FMP_API_KEY'] as const) {
    const value = (await resolveSecret(env, name as keyof Env & string)).value?.trim() ?? envx[name]?.trim();
    if (!value || value === primary) continue;
    slots.push('2');
    break;
  }
  return slots;
}

/** Populate `selfHealingSilence` when probe silence is explained by day-ban or Mac lease. */
export async function enrichFmpLatencySelfHealingSilence(
  env: Env,
  fmp: FmpLatencySignal,
  now: Date,
  envGet: (k: string) => string | undefined,
): Promise<FmpLatencySelfHealingSilence | null> {
  const criticalAgeSec = readFmpLatencyCriticalAgeSec(envGet);
  if (!fmpLatencySilenceWouldBeCritical(fmp, fmpLatencyProbeExpected(envGet), criticalAgeSec)) {
    return null;
  }

  const lastObservationAt = fmp.lastObservationAt;
  if (!lastObservationAt) {
    return null;
  }

  try {
    const slots = await configuredFmpLatencySlots(env);
    if (slots.length > 0) {
      let allBanned = true;
      for (const slot of slots) {
        if (!(await isFmpSlotHttp429DayBan(env, slot, now))) {
          allBanned = false;
          break;
        }
      }
      if (allBanned) {
        return {
          cause: 'fmp_day_ban',
          resetAtUtc: selfHealingResetAtUtc('fmp_day_ban', lastObservationAt),
        };
      }
    }
  } catch {
    /* fail-soft */
  }

  try {
    const lease = await readProbeLease(env, 'fmp', now);
    if (lease && lease.holder === 'mac' && !lease.expired) {
      return {
        cause: 'probe_lease_handoff',
        resetAtUtc: selfHealingResetAtUtc('probe_lease_handoff', lastObservationAt),
      };
    }
  } catch {
    /* fail-soft */
  }

  return null;
}

export interface FmpLatencySilencePending {
  firstSeenAt: string;
  lastSeenAt?: string;
}
