/**
 * src/ingestion/latencyCallLedger.ts
 *
 * ONE shared daily call ledger per provider, counting BOTH hosts.
 *
 * Before this module the server charged every latency HTTP call to a CONFIG_KV
 * day counter (`latency-budget:{uw,qq,fmp-rapidapi}:<date>` and
 * `fmp-latency:calls:key{1,2}:<date>`), while the Mac scout charged nothing at
 * all — `ingestScoutLatencyPayload` never incremented anything, and the Mac's
 * unconditional Quiver/UW polls never reached that endpoint. Mac spend was
 * therefore invisible to the cap, and the same physical free-tier keys were
 * being drawn down from two places against one budget.
 *
 * This module does NOT introduce a second ledger. It writes to the *same*
 * CONFIG_KV day keys via tradeLatency's own exported `addLatencySourceUsed` /
 * `addFmpLatencyUsed`, so `UW_LATENCY_DAILY_CAP` and friends finally mean what
 * they say across both hosts.
 *
 * The Mac is metered at lease acquire/renew rather than at payload post: it
 * must hold the lane before calling out, so the acquire is the one point every
 * Mac call passes through — including calls whose payload is later discarded.
 *
 * tradeLatency is imported dynamically, matching scoutHandoff.ts: it keeps this
 * module loadable in tests that only stub CONFIG_KV/DB.
 */
import type { Env } from '../shared/types.ts';
import type { LatencyProbeProviderId } from './scoutHandoff.ts';

/** FMP free-tier key slot. Mirrors tradeLatency's FmpLatencyKeySlot. */
export type FmpFreeKeySlot = '1' | '2';

/**
 * HTTP calls one probe of each provider costs, in the SAME units the server
 * charges. Kept in lockstep with tradeLatency's
 * LATENCY_SOURCE_BUDGETS[*].callsPerRun and FMP_LATENCY_CALLS_PER_RUN so one
 * cap governs both hosts.
 *
 * Quiver is deliberately charged at server parity (3) even though the Mac's
 * `pollQQ` only fetches house + senate (2) — it skips the trump bulk endpoint.
 * Over-reserving by one call is the safe direction, and it mirrors how
 * tradeLatency reserves a whole batch before the HTTP fires. Pass an explicit
 * `calls` to `chargeLatencyCalls` if a caller needs exact accounting.
 */
export const PROVIDER_CALLS_PER_RUN: Record<LatencyProbeProviderId, number> = {
  // house + senate latest
  fmp: 2,
  // house + senate latest via marketplace host
  fmp_rapidapi: 2,
  // single recent-trades feed
  unusual_whales: 1,
  // house + senate + trump bulk (server); Mac fetches 2 of these 3
  quiver: 3,
};

export interface LedgerCheck {
  provider: LatencyProbeProviderId;
  callsPerRun: number;
  used: number | null;
  cap: number | null;
  remaining: number | null;
  /** False when the daily cap cannot cover another run. */
  affordable: boolean;
  detail: string | null;
}

type SourceLedgerId = 'unusual_whales' | 'quiver' | 'fmp_rapidapi';

function sourceLedgerId(provider: LatencyProbeProviderId): SourceLedgerId | null {
  if (provider === 'unusual_whales' || provider === 'quiver' || provider === 'fmp_rapidapi') {
    return provider;
  }
  return null;
}

/**
 * Remaining daily budget for a provider, read from the same counters the
 * server probe spends against. Fails OPEN (affordable) when the ledger cannot
 * be read: a KV blip must not stop all polling, and the server-side probe
 * still enforces its own cap before spending.
 */
export async function checkLatencyCallBudget(
  env: Env,
  provider: LatencyProbeProviderId,
  now: Date = new Date(),
): Promise<LedgerCheck> {
  const callsPerRun = PROVIDER_CALLS_PER_RUN[provider] ?? 1;
  const base: LedgerCheck = {
    provider,
    callsPerRun,
    used: null,
    cap: null,
    remaining: null,
    affordable: true,
    detail: null,
  };
  try {
    const mod = await import('./tradeLatency.ts');
    const sourceId = sourceLedgerId(provider);
    if (sourceId) {
      const cap = await mod.latencySourceDailyCap(env, sourceId);
      const used = await mod.getLatencySourceUsed(env, sourceId, now);
      const remaining = Math.max(0, cap - used);
      return {
        ...base,
        used,
        cap,
        remaining,
        affordable: remaining >= callsPerRun,
        detail:
          remaining >= callsPerRun
            ? null
            : `${provider} daily cap reached: ${used}/${cap} calls used, ${callsPerRun} needed`,
      };
    }
    // FMP free tier: budget is per key slot but the meaningful question is
    // whether the fleet can still afford a run. getFmpLatencyFleetRemaining is
    // the exported helper that already knows how many slots are configured.
    const fleet = await mod.getFmpLatencyFleetRemaining(env, now);
    const remaining = fleet.freeTierRemaining;
    const cap = fleet.freeTierCap;
    return {
      ...base,
      used: Math.max(0, cap - remaining),
      cap,
      remaining,
      affordable: remaining >= callsPerRun,
      detail:
        remaining >= callsPerRun
          ? null
          : `fmp free-tier daily cap reached: ${cap - remaining}/${cap} calls used, ${callsPerRun} needed`,
    };
  } catch (err) {
    return { ...base, detail: `budget unreadable: ${(err as Error).message}` };
  }
}

/**
 * Charge `callsPerRun` for a provider to the SHARED daily counter.
 *
 * Called when the Mac is granted (or renews) a lane, mirroring how the server
 * pre-reserves its batch before the HTTP fires. Reserving up front means a
 * request that dies mid-flight still costs quota — the same conservative
 * choice tradeLatency already makes.
 */
export async function chargeLatencyCalls(
  env: Env,
  provider: LatencyProbeProviderId,
  opts: { fmpSlot?: FmpFreeKeySlot; now?: Date; calls?: number } = {},
): Promise<{ charged: number; total: number | null }> {
  const now = opts.now ?? new Date();
  const calls = opts.calls ?? PROVIDER_CALLS_PER_RUN[provider] ?? 1;
  try {
    const mod = await import('./tradeLatency.ts');
    const sourceId = sourceLedgerId(provider);
    if (sourceId) {
      const total = await mod.addLatencySourceUsed(env, sourceId, calls, now);
      return { charged: calls, total };
    }
    const total = await mod.addFmpLatencyUsed(env, opts.fmpSlot ?? '2', calls, now);
    return { charged: calls, total };
  } catch (err) {
    console.warn('latency ledger charge failed', provider, (err as Error).message);
    return { charged: 0, total: null };
  }
}

/**
 * Emit a visible line when a cap blocks a poll. Requirement from the owner:
 * hitting a cap must be logged, not swallowed — a silent stop looks identical
 * to a broken probe.
 */
export function logLatencyCapHit(
  provider: LatencyProbeProviderId,
  holder: string,
  check: LedgerCheck,
): void {
  console.warn(
    `latency budget: ${holder} denied ${provider} — ${check.detail ?? 'daily cap reached'}`,
    { used: check.used, cap: check.cap, remaining: check.remaining, needed: check.callsPerRun },
  );
}
