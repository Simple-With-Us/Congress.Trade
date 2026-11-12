/**
 * Runtime tick profile (Coolify Deno-in-Docker).
 *
 * Deno Deploy is retired.  The old free/balanced/paid names described Deploy
 * quota survival (15-minute cron, tiny drains) and are gone.  Production is
 * Coolify on Hetzner with aggressive defaults: cron `* * * * *`, larger
 * batches.  Secrets come from Infisical.  Do not put `CT_COST_PROFILE` in
 * Coolify env — the knob no longer exists.
 *
 * Optional Infisical overrides (not Coolify duplicates):
 *   CT_CRON_SCHEDULE           — crontab expression for Deno.cron
 *   CT_DRAIN_LIMIT             — max durable-queue messages completed per tick
 *   CT_DRAIN_CLAIM_SIZE        — messages claimed per SQL batch
 *   CT_OUTBOX_LIMIT            — max outbox rows flushed per tick (each outbox)
 *   CT_DISABLE_INTERNAL_CRON=true — skip Deno.cron; drive ticks externally
 *     (POST /api/admin/runtime-tick).  Not the production path.
 */

export type DenoCostProfileName = 'live';

export interface DenoCostProfile {
  name: DenoCostProfileName;
  /** Crontab for Deno.cron. */
  cronSchedule: string;
  /** Max messages processed across claim loops per queue per tick. */
  drainLimit: number;
  /** Claim batch size (rows leased at once; still handled serially). */
  drainClaimSize: number;
  /** Max rows per ingestion/delivery outbox flush. */
  outboxLimit: number;
  /** When true, main.ts does not register Deno.cron. */
  disableInternalCron: boolean;
  /**
   * When true, skip outbox flush + queue drain when a cheap probe finds no
   * pending work (watcher + daily jobs still run).
   */
  idleShortCircuit: boolean;
}

const LIVE: Omit<DenoCostProfile, 'disableInternalCron'> = {
  name: 'live',
  cronSchedule: '* * * * *',
  drainLimit: 25,
  drainClaimSize: 10,
  outboxLimit: 100,
  idleShortCircuit: true,
};

function parsePositiveInt(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

function truthy(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * Resolve the active tick profile.  Always starts from aggressive live
 * defaults.  `CT_COST_PROFILE` / `DENO_COST_PROFILE` are ignored leftovers.
 */
export function resolveDenoCostProfile(
  env: Record<string, string | undefined> | { get?: (k: string) => string | undefined } = {},
): DenoCostProfile {
  const read = (key: string): string | undefined => {
    if (typeof (env as { get?: (k: string) => string | undefined }).get === 'function') {
      return (env as { get: (k: string) => string | undefined }).get(key) ?? undefined;
    }
    return (env as Record<string, string | undefined>)[key];
  };

  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const v = read(key);
      if (v !== undefined && v !== '') return v;
    }
    return undefined;
  };

  const cronOverride = pick('CT_CRON_SCHEDULE', 'DENO_CRON_SCHEDULE')?.trim();
  return {
    ...LIVE,
    cronSchedule: cronOverride && cronOverride.length > 0 ? cronOverride : LIVE.cronSchedule,
    drainLimit: parsePositiveInt(
      pick('CT_DRAIN_LIMIT', 'DENO_DRAIN_LIMIT'),
      LIVE.drainLimit,
      100,
    ),
    drainClaimSize: parsePositiveInt(
      pick('CT_DRAIN_CLAIM_SIZE', 'DENO_DRAIN_CLAIM_SIZE'),
      LIVE.drainClaimSize,
      25,
    ),
    outboxLimit: parsePositiveInt(
      pick('CT_OUTBOX_LIMIT', 'DENO_OUTBOX_LIMIT'),
      LIVE.outboxLimit,
      200,
    ),
    disableInternalCron: truthy(
      pick('CT_DISABLE_INTERNAL_CRON', 'DENO_DISABLE_INTERNAL_CRON'),
    ),
    idleShortCircuit: !truthy(pick('CT_FORCE_FULL_TICK', 'DENO_FORCE_FULL_TICK')),
  };
}

/** Public-safe summary for /api/health and admin diagnostics (no secrets). */
export function costProfilePublicSummary(profile: DenoCostProfile): Record<string, unknown> {
  return {
    name: profile.name,
    cronSchedule: profile.cronSchedule,
    drainLimit: profile.drainLimit,
    drainClaimSize: profile.drainClaimSize,
    outboxLimit: profile.outboxLimit,
    disableInternalCron: profile.disableInternalCron,
    idleShortCircuit: profile.idleShortCircuit,
  };
}
