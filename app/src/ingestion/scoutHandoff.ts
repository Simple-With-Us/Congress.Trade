/**
 * Server-only latency probe helper (formerly `scoutHandoff.ts`).
 *
 * Owner 2026-09-09: "want the server to handle the FMP probe not Mac."
 * The Mac residential-proxy, Mac Senate relay, and the Mac scout lease
 * are retired (board `ab688ea5`, `ba810d46`).  Everything that used to
 * hand off to the Mac is now the server's job, with residential IP
 * bounce provided by the GL.iNet Mango HTTP CONNECT proxy at
 * `http://10.99.0.2:8888` on the Hetzner `wg-ct` WireGuard mesh.
 *
 * The Mac lease plumbing (`probeLease.ts`) is kept for one more
 * release so the server side of the lease still has a single owner
 * for each provider lane; `needScout` always evaluates to `false`, so
 * the lane is permanently server-owned and the Mac side of the lease
 * is a no-op.
 */
import type { Env } from '../shared/types.ts';
import { all } from '../shared/db.ts';
import { resolveSecret } from '../secrets/infisical.ts';
import {
  acquireProbeLease,
  macLeaseTtlMs,
  macTenureExhausted,
  macTenureMs,
  readAllProbeLeases,
  readProbeLease,
  releaseProbeLease,
  serverLeaseTtlMs,
  type ProbeLease,
  type ProbeLeaseDecision,
} from './probeLease.ts';
import {
  checkLatencyCallBudget,
  chargeLatencyCalls,
  logLatencyCapHit,
  type FmpFreeKeySlot,
} from './latencyCallLedger.ts';
import {
  DEFAULT_PROBE_SCHEDULE_CONFIG,
  probeScheduleConfigFromEnv,
  probeTierAt,
  shouldProbeNow,
  type ProbeScheduleConfig,
  type ProbeTier,
} from './probeSchedule.ts';
import { logProbeCadence } from './probeCadenceLog.ts';

/**
 * Live cadence config from env. Total and non-throwing by construction; a hard
 * failure falls back to the shipped measured table rather than stalling probes.
 */
function macScheduleConfig(env: Env): ProbeScheduleConfig {
  try {
    return probeScheduleConfigFromEnv(env as unknown as Record<string, string | undefined>);
  } catch {
    return DEFAULT_PROBE_SCHEDULE_CONFIG;
  }
}

/** Bumped when handoff semantics change so stale "quiet 6h" claims do not stick. */
export const LATENCY_PROBE_HEALTH_KV_KEY = 'latency-probe-health:v2';

/**
 * Hand off to the Mac scout after this many successive *server* probe errors.
 * Owner 2026-08-11: 2nd or 3rd successive error — default 3.
 * Not triggered by budget/spacing skips or wall-clock silence alone.
 */
export const LATENCY_SCOUT_CONSECUTIVE_ERRORS = 3;

/**
 * @deprecated Silence no longer triggers handoff (owner 2026-08-11). Kept as a
 * named export so older tests/docs that imported it keep compiling; value is
 * unused by computeNeedScout.
 */
export const LATENCY_SCOUT_SILENCE_HOURS = 6;

/**
 * Latency probe source.  Owner 2026-09-09: server-only.  The Mac scout
 * is retired; the `'scout'` variant is kept as a single string literal
 * only so historical KV records and old telemetry events continue to
 * type-check — no new code path emits it.
 */
export type LatencyProbeSource = 'server' | 'scout';

export type LatencyProbeProviderId =
  | 'fmp'
  | 'fmp_rapidapi'
  | 'unusual_whales'
  | 'quiver';

export interface LatencyProbeHealth {
  provider: LatencyProbeProviderId;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastFetchedRows: number;
  lastSource: LatencyProbeSource;
  /**
   * Consecutive *server* hard failures since last server success.
   * Scout outcomes never increment this; server success zeros it.
   */
  consecutiveServerErrors: number;
  /** True when residential scout should poll this provider. */
  needScout: boolean;
  needScoutReason: string | null;
  updatedAt: string;
}

export interface ScoutRawNeed {
  docId: string;
  chamber: string;
  sourceUrl: string;
  reason: 'missing_raw' | 'fetch_error';
  error: string | null;
  firstSeenAt: string | null;
}

export interface ScoutPlan {
  generatedAt: string;
  latency: LatencyProbeHealth[];
  /** Providers the scout should actively poll this cycle. */
  latencyNeedScout: LatencyProbeHealth[];
  rawFetch: ScoutRawNeed[];
  notes: string[];
  /**
   * Hint for Mac dual free-tier keys: prefer the secondary FMP free key when
   * covering FMP so the server primary key is not double-spent.
   */
  fmpPreferSecondaryKey: boolean;
  /**
   * Who currently owns each provider lane and until when. The scout must still
   * acquire a lease before polling — this is visibility, not permission.
   */
  leases: ProbeLease[];
  /** Seconds the scout should request per lease (server-configured). */
  leaseTtlSec: number;
}

type HealthMap = Partial<Record<LatencyProbeProviderId, LatencyProbeHealth>>;

const PROVIDER_IDS: LatencyProbeProviderId[] = [
  'fmp',
  'fmp_rapidapi',
  'unusual_whales',
  'quiver',
];

function emptyHealth(provider: LatencyProbeProviderId, nowIso: string): LatencyProbeHealth {
  return {
    provider,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
    lastFetchedRows: 0,
    lastSource: 'server',
    consecutiveServerErrors: 0,
    needScout: false,
    needScoutReason: null,
    updatedAt: nowIso,
  };
}

/** Coerce legacy v1 health rows (no consecutiveServerErrors) into v2 shape. */
function normalizeHealth(
  provider: LatencyProbeProviderId,
  raw: Partial<LatencyProbeHealth> | undefined,
  nowIso: string,
): LatencyProbeHealth {
  const base = emptyHealth(provider, nowIso);
  if (!raw || typeof raw !== 'object') return base;
  const consecutive =
    typeof raw.consecutiveServerErrors === 'number' && Number.isFinite(raw.consecutiveServerErrors)
      ? Math.max(0, Math.floor(raw.consecutiveServerErrors))
      : 0;
  // Drop permanent silence / "no observations yet" claims from v1.
  const reason = raw.needScoutReason ?? null;
  const legacySilence =
    !!reason &&
    (/quiet \d+h/i.test(reason) ||
      /scout silence/i.test(reason) ||
      /no observations yet/i.test(reason) ||
      /no successful server probe yet/i.test(reason));
  // Owner 2026-09-09: `computeNeedScout` never writes `needScout: true` any
  // more.  This normalizer runs on every *read*, so it preserves a stored flag
  // (a pre-retirement row still has to be representable, which is what keeps
  // the defensive branch in `planServerLatencyProbe` reachable) but must no
  // longer *derive* one.  Re-deriving from the error count undid the write
  // path: any provider three errors into an outage flipped back to handed-off
  // on the next read, and the planner then released the server's lease to wait
  // for a Mac that is never coming.  Reasons are still derived — the dashboard
  // surfaces the streak and the not-configured state as observability.
  let needScout = Boolean(raw.needScout) && !legacySilence;
  let needScoutReason = legacySilence ? null : reason;
  if (consecutive >= LATENCY_SCOUT_CONSECUTIVE_ERRORS) {
    needScoutReason =
      needScoutReason && /successive/i.test(needScoutReason)
        ? needScoutReason
        : `server probe failed ${consecutive} successive times (threshold ${LATENCY_SCOUT_CONSECUTIVE_ERRORS})`;
  } else if (!needScoutReason || /quiet|silence|no observations/i.test(needScoutReason)) {
    needScout = false;
    needScoutReason = null;
  }
  // not_configured stays visible until a server success / reconfigure. It no
  // longer forces handoff: there is no host to hand off to.
  if (reason && /not configured/i.test(reason)) {
    needScoutReason = reason;
  }
  return {
    provider,
    lastAttemptAt: raw.lastAttemptAt ?? null,
    lastSuccessAt: raw.lastSuccessAt ?? null,
    lastError: raw.lastError ?? null,
    lastFetchedRows: typeof raw.lastFetchedRows === 'number' ? raw.lastFetchedRows : 0,
    lastSource: raw.lastSource === 'scout' ? 'scout' : 'server',
    consecutiveServerErrors: consecutive,
    needScout,
    needScoutReason,
    updatedAt: raw.updatedAt ?? nowIso,
  };
}

async function readHealthMap(env: Env): Promise<HealthMap> {
  if (!env.CONFIG_KV) return {};
  try {
    // Prefer v2; fall back to v1 once for migration.
    let raw = await env.CONFIG_KV.get(LATENCY_PROBE_HEALTH_KV_KEY, 'json');
    if (!raw || typeof raw !== 'object') {
      raw = await env.CONFIG_KV.get('latency-probe-health:v1', 'json');
    }
    if (!raw || typeof raw !== 'object') return {};
    const nowIso = new Date().toISOString();
    const out: HealthMap = {};
    for (const id of PROVIDER_IDS) {
      const row = (raw as Record<string, unknown>)[id];
      out[id] = normalizeHealth(
        id,
        row && typeof row === 'object' ? (row as Partial<LatencyProbeHealth>) : undefined,
        nowIso,
      );
    }
    return out;
  } catch {
    return {};
  }
}

async function writeHealthMap(env: Env, map: HealthMap): Promise<void> {
  if (!env.CONFIG_KV) return;
  await env.CONFIG_KV.put(LATENCY_PROBE_HEALTH_KV_KEY, JSON.stringify(map));
}

const MEMBERSHIP_LATENCY_PROVIDERS: LatencyProbeProviderId[] = ['unusual_whales', 'quiver'];

/** Default spacing between recovery HTTP attempts while auth-latched (hours). */
export const LATENCY_AUTH_REJECT_RECOVERY_HOURS_DEFAULT = 6;

export function latencyAuthRejectRecoveryMs(env: Env): number {
  const raw = (env as unknown as Record<string, string | undefined>).DISCLOSURE_LATENCY_AUTH_RECOVERY_HOURS;
  const hours = raw ? Number.parseFloat(raw) : LATENCY_AUTH_REJECT_RECOVERY_HOURS_DEFAULT;
  if (!Number.isFinite(hours) || hours <= 0) return LATENCY_AUTH_REJECT_RECOVERY_HOURS_DEFAULT * 3_600_000;
  return hours * 3_600_000;
}

/** True when a probe error is an auth/plan rejection, not a transient outage. */
export function isLatencyProbeAuthError(message: string | null | undefined): boolean {
  if (!message) return false;
  return /HTTP_(401|403)|FMP_HTTP_(401|403)|UW HTTP 401|QQ (?:house|senate|trump) HTTP 403/i.test(message);
}

/**
 * Membership providers (UW/Quiver) whose keys are persistently rejected.
 * These stay out of `/api/health/latency` paging and skip further HTTP until
 * a successful probe clears the latch (new key / renewed plan).
 */
export async function latencyProvidersWithRejectedCredentials(env: Env): Promise<Set<string>> {
  const rejected = new Set<string>();
  const map = await readHealthMap(env);
  for (const provider of MEMBERSHIP_LATENCY_PROVIDERS) {
    const health = map[provider];
    if (
      health
      && health.consecutiveServerErrors >= LATENCY_SCOUT_CONSECUTIVE_ERRORS
      && isLatencyProbeAuthError(health.lastError)
    ) {
      rejected.add(provider);
    }
  }
  for (const provider of MEMBERSHIP_LATENCY_PROVIDERS) {
    if (rejected.has(provider)) continue;
    try {
      const rows = await all<{ ok: number; error: string | null }>(
        env.DB,
        `SELECT ok, error FROM provider_probe_runs
          WHERE provider = ?
          ORDER BY ran_at DESC
          LIMIT ?`,
        [provider, LATENCY_SCOUT_CONSECUTIVE_ERRORS],
      );
      if (rows.length < LATENCY_SCOUT_CONSECUTIVE_ERRORS) continue;
      const allAuthFailures = rows.every((row) => row.ok === 0 && isLatencyProbeAuthError(row.error));
      if (allAuthFailures) rejected.add(provider);
    } catch {
      /* table may not exist in local dev */
    }
  }
  return rejected;
}

/**
 * When a membership provider is auth-latched, skip routine HTTP between recovery
 * attempts so we do not burn calls on a known-bad key.  `force` and the recovery
 * interval still run a real probe so renewed credentials can clear the latch.
 * Throttled skips must not call `recordLatencyProbeOutcome` — that would refresh
 * `lastAttemptAt` and prevent the recovery window from ever elapsing.
 */
export async function shouldThrottleAuthRejectedLatencyProbe(
  env: Env,
  provider: LatencyProbeProviderId,
  now: Date,
  opts: { force?: boolean } = {},
): Promise<boolean> {
  if (opts.force) return false;
  if (!MEMBERSHIP_LATENCY_PROVIDERS.includes(provider)) return false;
  const rejected = await latencyProvidersWithRejectedCredentials(env);
  if (!rejected.has(provider)) return false;
  const map = await readHealthMap(env);
  const health = map[provider];
  const lastMs = health?.lastAttemptAt ? Date.parse(health.lastAttemptAt) : NaN;
  if (!Number.isFinite(lastMs)) return false;
  return now.getTime() - lastMs < latencyAuthRejectRecoveryMs(env);
}

/**
 * Derive needScout + consecutive error count from a probe outcome.
 *
 * Owner 2026-09-09: server-only.  `needScout` is hard-coded to `false`
 * — the Mac scout is retired and no host in the fleet can take the
 * lane.  The Mac-lease plumbing in `probeLease.ts` is kept so the
 * server still has a single owner per provider lane, but the Mac
 * half is a no-op (no peer, no callback).
 *
 * Server outcome semantics (unchanged for backwards compatibility):
 * - success → consecutive=0, needScout=false
 * - error   → consecutive+=1; surfaced via `lastError` for observability
 * - budget_skip / disabled → do not count as failure
 * - not_configured → consecutive preserved; an operator can see this in
 *   the dashboard / Sentry; the FMP probe will simply log + skip until
 *   keys land in Infisical.
 *
 * The `source` parameter is retained for KV-record compatibility — any
 * legacy `'scout'` row is mapped to a server-side "lane permanently
 * server-owned" outcome so historical telemetry does not 500.
 */
export function computeNeedScout(opts: {
  kind: 'success' | 'error' | 'budget_skip' | 'not_configured' | 'disabled';
  source?: LatencyProbeSource;
  lastError?: string | null;
  prevConsecutiveServerErrors?: number;
  threshold?: number;
}): {
  needScout: boolean;
  needScoutReason: string | null;
  consecutiveServerErrors: number;
} {
  const threshold = opts.threshold ?? LATENCY_SCOUT_CONSECUTIVE_ERRORS;
  const source = opts.source ?? 'server';
  const prev = Math.max(0, Math.floor(opts.prevConsecutiveServerErrors ?? 0));

  if (source === 'scout') {
    // Mac scout is retired.  Map a historical scout record onto the
    // server-owned outcome so the dashboard does not display a phantom
    // handoff flag for old telemetry.
    return {
      consecutiveServerErrors: prev,
      needScout: false,
      needScoutReason: null,
    };
  }

  // Server path (Mac lease is now a no-op — see file docstring).
  if (opts.kind === 'disabled' || opts.kind === 'budget_skip') {
    return {
      consecutiveServerErrors: prev,
      needScout: false,
      needScoutReason: null,
    };
  }
  if (opts.kind === 'not_configured') {
    return {
      consecutiveServerErrors: prev,
      needScout: false,
      needScoutReason: 'provider not configured on server (server-only, no Mac fallback)',
    };
  }
  if (opts.kind === 'success') {
    return {
      consecutiveServerErrors: 0,
      needScout: false,
      needScoutReason: null,
    };
  }
  // error — surface the count + reason for observability, but never
  // set needScout: the Mac is not coming back.
  const consecutive = prev + 1;
  if (consecutive >= threshold) {
    const err = opts.lastError ? opts.lastError.slice(0, 160) : 'error';
    return {
      consecutiveServerErrors: consecutive,
      needScout: false,
      needScoutReason: `server probe failed ${consecutive} successive times (threshold ${threshold}): ${err} — server-only, no Mac fallback`,
    };
  }
  return {
    consecutiveServerErrors: consecutive,
    needScout: false,
    needScoutReason: null,
  };
}

export async function recordLatencyProbeOutcome(
  env: Env,
  provider: LatencyProbeProviderId,
  outcome: {
    source?: LatencyProbeSource;
    kind: 'success' | 'error' | 'budget_skip' | 'not_configured' | 'disabled';
    error?: string | null;
    fetchedRows?: number;
    now?: Date;
  },
): Promise<LatencyProbeHealth> {
  const now = outcome.now ?? new Date();
  const nowIso = now.toISOString();
  const map = await readHealthMap(env);
  const prev = map[provider] ?? emptyHealth(provider, nowIso);
  const source = outcome.source ?? 'server';

  const lastSuccessAt =
    outcome.kind === 'success' ? nowIso : prev.lastSuccessAt;
  const lastError =
    outcome.kind === 'error' || outcome.kind === 'not_configured'
      ? (outcome.error ?? prev.lastError)
      : outcome.kind === 'success' && source === 'server'
        ? null
        : prev.lastError;

  const derived = computeNeedScout({
    kind: outcome.kind,
    source,
    lastError,
    prevConsecutiveServerErrors: prev.consecutiveServerErrors,
  });

  const next: LatencyProbeHealth = {
    provider,
    lastAttemptAt: nowIso,
    lastSuccessAt,
    lastError,
    lastFetchedRows:
      outcome.fetchedRows ?? (outcome.kind === 'success' ? prev.lastFetchedRows : 0),
    lastSource: source,
    consecutiveServerErrors: derived.consecutiveServerErrors,
    needScout: derived.needScout,
    needScoutReason: derived.needScoutReason,
    updatedAt: nowIso,
  };
  map[provider] = next;
  await writeHealthMap(env, map);
  return next;
}

/**
 * Refresh lastSuccessAt from DB observations for display only.
 * Does **not** open needScout based on wall-clock silence (owner 2026-08-11).
 */
export async function refreshLatencySilenceFromDb(
  env: Env,
  now: Date = new Date(),
): Promise<HealthMap> {
  const map = await readHealthMap(env);
  const nowIso = now.toISOString();
  let rows: Array<{ provider: string; last_observed: string }> = [];
  try {
    rows = await all<{ provider: string; last_observed: string }>(
      env.DB,
      `SELECT provider, MAX(last_observed_at) AS last_observed
         FROM trade_provider_observations
        GROUP BY provider`,
    );
  } catch {
    rows = [];
  }
  const byProvider = new Map(rows.map((r) => [r.provider, r.last_observed]));
  for (const provider of PROVIDER_IDS) {
    const prev = map[provider] ?? emptyHealth(provider, nowIso);
    const dbLast = byProvider.get(provider) ?? null;
    const candidates = [prev.lastSuccessAt, dbLast].filter(Boolean) as string[];
    let lastSuccessAt = prev.lastSuccessAt;
    for (const c of candidates) {
      if (!lastSuccessAt || Date.parse(c) > Date.parse(lastSuccessAt)) lastSuccessAt = c;
    }
    // Re-apply threshold without incrementing (display-only refresh).
    const consecutive = prev.consecutiveServerErrors;
    const stickyNotConfigured =
      !!prev.needScoutReason && /not configured/i.test(prev.needScoutReason);
    // Same rule as `normalizeHealth`: preserve what is stored, never derive a
    // new handoff.  This refresh writes the map straight back to KV, so
    // deriving here would persist a resurrected flag rather than just display
    // one.
    const overThreshold = consecutive >= LATENCY_SCOUT_CONSECUTIVE_ERRORS;
    const needScout = prev.needScout;
    const needScoutReason = stickyNotConfigured
      ? prev.needScoutReason
      : overThreshold
        ? `server probe failed ${consecutive} successive times (threshold ${LATENCY_SCOUT_CONSECUTIVE_ERRORS})`
        : null;
    map[provider] = {
      ...prev,
      lastSuccessAt,
      consecutiveServerErrors: consecutive,
      needScout,
      needScoutReason,
      updatedAt: nowIso,
    };
  }
  await writeHealthMap(env, map);
  return map;
}

export async function listFilingsNeedingRaw(
  env: Env,
  limit = 20,
): Promise<ScoutRawNeed[]> {
  const cap = Math.max(1, Math.min(50, Math.floor(limit)));
  try {
    const rows = await all<{
      doc_id: string;
      chamber: string | null;
      source_url: string | null;
      ingest_status: string | null;
      error: string | null;
      first_seen_at: string | null;
      raw_object_key: string | null;
    }>(
      env.DB,
      `SELECT doc_id, chamber, source_url, ingest_status, error, first_seen_at, raw_object_key
         FROM filings
        WHERE source_url IS NOT NULL AND TRIM(source_url) != ''
          AND (
            raw_object_key IS NULL
            OR (
              ingest_status = 'error'
              AND error IS NOT NULL
              AND (
                error LIKE '%403%'
                OR error LIKE '%429%'
                OR error LIKE '%Imperva%'
                OR error LIKE '%agreement wall%'
                OR error LIKE '%fetch failed%'
                OR error LIKE '%ECONN%'
                OR error LIKE '%timeout%'
              )
            )
          )
        ORDER BY COALESCE(first_seen_at, '') DESC
        LIMIT ?`,
      [cap],
    );
    return rows
      .filter((r) => r.source_url)
      .map((r) => ({
        docId: r.doc_id,
        chamber: r.chamber || 'house',
        sourceUrl: r.source_url!,
        reason: r.raw_object_key ? ('fetch_error' as const) : ('missing_raw' as const),
        error: r.error,
        firstSeenAt: r.first_seen_at,
      }));
  } catch {
    return [];
  }
}

/**
 * Providers that are intentionally off / not in the server probe set should
 * never appear in latencyNeedScout (e.g. fmp_rapidapi when paths=stable only).
 */
export async function eligibleHandoffProviders(env: Env): Promise<Set<LatencyProbeProviderId>> {
  const eligible = new Set<LatencyProbeProviderId>(['unusual_whales', 'quiver', 'fmp']);
  try {
    // Dynamic import keeps scoutHandoff free of heavy tradeLatency cycles in tests
    // that only mock CONFIG_KV/DB.
    const { isFmpProbeEnabled } = await import('./tradeLatency.ts');
    if (!(await isFmpProbeEnabled(env))) {
      eligible.delete('fmp');
      return eligible;
    }
    // fmp_rapidapi is never a handoff target: congress routes 404 on that
    // product, so a scout cover would not observe disclosures. Stable `fmp`
    // stays eligible whenever the probe switch is on, including a
    // rapidapi-only FMP_LATENCY_PATHS value.
  } catch {
    // On import/env failure keep fmp eligible; never add rapidapi.
  }
  return eligible;
}

export async function buildScoutPlan(env: Env, now: Date = new Date()): Promise<ScoutPlan> {
  const map = await refreshLatencySilenceFromDb(env, now);
  const eligible = await eligibleHandoffProviders(env);
  const latency = PROVIDER_IDS.map((id) => {
    const row = map[id] ?? emptyHealth(id, now.toISOString());
    if (!eligible.has(id)) {
      // Disabled path: never hand off (clears stale "no observations" rapidapi claims).
      return {
        ...row,
        needScout: false,
        needScoutReason: null,
        consecutiveServerErrors: 0,
      };
    }
    return row;
  });
  const latencyNeedScout = latency.filter((h) => h.needScout);
  const rawFetch = await listFilingsNeedingRaw(env, 20);
  const fmpPreferSecondaryKey = latencyNeedScout.some(
    (h) => h.provider === 'fmp' || h.provider === 'fmp_rapidapi',
  );
  const notes: string[] = [
    `Server probes first. Scout covers a provider only after ${LATENCY_SCOUT_CONSECUTIVE_ERRORS} successive server errors (not silence alone).`,
    'Scout success fills observations; server success clears needScout and reclaims the lane.',
    'When covering FMP, prefer the secondary free-tier key (FMP_LATENCY_API_KEY_2 / FMP_API_KEY) so the server primary is not double-spent.',
    'fmp_rapidapi is never handed off: RapidAPI house/senate-latest 404, so it cannot cover the stable congress probes.',
    'Filing storage is Cloudflare R2 (RAW_FILES), not Backblaze.',
  ];
  if (latencyNeedScout.length) {
    notes.push(
      `Scout latency cover: ${latencyNeedScout.map((h) => `${h.provider} (${h.needScoutReason})`).join('; ')}`,
    );
  }
  if (rawFetch.length) {
    notes.push(`Scout raw cover: ${rawFetch.length} filing(s) need residential download → R2`);
  }
  const leases = await readAllProbeLeases(env, now);
  notes.push(
    'Acquire POST /api/ingest/probe-lease before polling any provider; a denial means the server owns that lane.',
  );
  const held = leases.filter((l) => !l.expired);
  if (held.length) {
    notes.push(
      `Lanes held: ${held.map((l) => `${l.provider} → ${l.holder} until ${l.expiresAt}`).join('; ')}`,
    );
  }
  return {
    generatedAt: now.toISOString(),
    latency,
    latencyNeedScout,
    rawFetch,
    notes,
    fmpPreferSecondaryKey,
    leases,
    leaseTtlSec: Math.floor(macLeaseTtlMs(env) / 1000),
  };
}

// ---------------------------------------------------------------------------
// Lease-backed mutual exclusion
// ---------------------------------------------------------------------------

/**
 * Stable holder id for the server. Deliberately NOT a per-isolate UUID: Deno
 * Deploy may serve consecutive ticks from different isolates, and a per-isolate
 * id would make the new isolate fail to renew and lock the server out of its
 * own lane for a full TTL. Concurrency between server ticks is already handled
 * by the scheduled-tick singleton lock.
 */
export const SERVER_LEASE_HOLDER_ID = 'server';

export interface ServerLatencyLaneDecision {
  provider: LatencyProbeProviderId;
  /** True when the server may call the provider this tick. */
  probe: boolean;
  action: 'acquired' | 'reclaimed' | 'handed_off' | 'blocked' | 'not_configured';
  detail: string;
  lease: ProbeLease | null;
}

export interface ServerLatencyProbePlan {
  /** Providers the server holds a lease on and may fetch this tick. */
  probeProviders: LatencyProbeProviderId[];
  lanes: ServerLatencyLaneDecision[];
}

/**
 * The provider set the server would probe absent any lease, mirroring
 * tradeLatency's private `requestedProviderIds`: DISCLOSURE_LATENCY_PROVIDERS
 * when set and parseable, otherwise all four direct providers.
 *
 * This must stay in lockstep with that function. Getting it wrong in the
 * permissive direction would re-enable a provider the owner disabled, so the
 * parse deliberately keeps only ids we know.
 */
export async function configuredServerProviders(env: Env): Promise<LatencyProbeProviderId[]> {
  let raw = '';
  try {
    raw =
      (await resolveSecret(env, 'DISCLOSURE_LATENCY_PROVIDERS')).value ??
      (env as unknown as Record<string, string | undefined>).DISCLOSURE_LATENCY_PROVIDERS ??
      '';
  } catch {
    raw = '';
  }
  const allowed = new Set<string>(PROVIDER_IDS);
  const parsed = raw
    .split(/[,\s]+/)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => allowed.has(part)) as LatencyProbeProviderId[];
  return parsed.length ? Array.from(new Set(parsed)) : [...PROVIDER_IDS];
}

/**
 * Decide, per provider, whether the server owns the lane this tick — and take
 * or give back the lease accordingly.
 *
 * Server-preferred rules:
 *   • healthy (needScout=false) → acquire/renew and probe.
 *   • handed off (needScout=true) and a live Mac lease is inside tenure →
 *     RELEASE and do not fetch (Mac scout is covering).
 *   • handed off, server still holds the row (first tick after the 3rd error)
 *     → RELEASE once so a living Mac can acquire.
 *   • handed off with no live Mac lease (scout retired / crashed / expired)
 *     or Mac tenure spent → server reclaims. Without this, needScout stayed
 *     true after the 2026-09-02 scout retirement and FMP sat silent 42h+.
 */
export async function planServerLatencyProbe(
  env: Env,
  now: Date = new Date(),
): Promise<ServerLatencyProbePlan> {
  const configured = await configuredServerProviders(env);
  const eligible = await eligibleHandoffProviders(env);
  const map = await readHealthMap(env);
  const ttlMs = serverLeaseTtlMs(env);
  const tenureMs = macTenureMs(env);
  const lanes: ServerLatencyLaneDecision[] = [];

  for (const provider of configured) {
    const health = map[provider];
    // Owner 2026-09-09: server-only.  `health.needScout` is permanently
    // false (see `computeNeedScout`), so `handedOff` collapses to
    // `false` and every lane is server-acquired.  The eligible check is
    // retained for the case where an operator disables a provider path
    // entirely (e.g. FMP_RAPIDAPI when paths=stable only); that path
    // should still register as server-owned so its health surface is
    // visible.
    const handedOff = eligible.has(provider) ? Boolean(health?.needScout) : false;
    const current = await readProbeLease(env, provider, now);

    if (!handedOff) {
      // A live Mac-held row can only be stale now that the scout is retired
      // (nothing renews it any more).  `preemptMacAfterMs` is what lets the
      // server take such a lane back once the tenure window is spent; without
      // it a leftover Mac row blocks the probe for the whole lease TTL and the
      // provider goes silent — the 2026-09-02 failure this lane already had
      // once.  Preemption cannot double-poll: the Mac no longer probes.
      const macLive = Boolean(current && current.holder === 'mac' && !current.expired);
      const decision = await acquireProbeLease(env, {
        provider,
        holder: 'server',
        holderId: SERVER_LEASE_HOLDER_ID,
        ttlMs,
        reason: macLive ? 'reclaim probe after mac tenure (mac retired)' : 'server healthy',
        now,
        preemptMacAfterMs: tenureMs,
      });
      lanes.push({
        provider,
        probe: decision.granted,
        action: decision.granted ? (macLive ? 'reclaimed' : 'acquired') : 'blocked',
        detail: decision.granted
          ? macLive
            ? `mac tenure of ${Math.round(tenureMs / 3600000)}h elapsed; server reclaiming the lane`
            : 'server holds the lane'
          : (decision.detail ?? 'lane unavailable'),
        lease: decision.lease ?? decision.current,
      });
      continue;
    }

    // Owner 2026-09-09: server-only.  `needScout` is always false (see
    // computeNeedScout), so this `handedOff` branch is unreachable in
    // production; it is kept as a one-release defense so any historical
    // KV row that still flips true on a misconfigured install does not
    // stall the probe forever.  Mac lease / Mac tenure are no-ops here.
    const serverLive = Boolean(current && current.holder === 'server' && !current.expired);

    if (serverLive) {
      await releaseProbeLease(env, provider, 'server', SERVER_LEASE_HOLDER_ID);
      lanes.push({
        provider,
        probe: false,
        action: 'handed_off',
        detail: health?.needScoutReason ?? 'historical handed-off record (mac retired); server reclaiming',
        lease: current,
      });
      continue;
    }

    // Same reasoning as the server-owned branch above: a historical
    // `needScout` row must not combine with a leftover Mac lease to stall the
    // provider past the tenure window.
    const macLive = Boolean(current && current.holder === 'mac' && !current.expired);
    const decision = await acquireProbeLease(env, {
      provider,
      holder: 'server',
      holderId: SERVER_LEASE_HOLDER_ID,
      ttlMs,
      reason: 'server-only lane (mac retired)',
      now,
      preemptMacAfterMs: tenureMs,
    });
    lanes.push({
      provider,
      probe: decision.granted,
      action: decision.granted ? (macLive ? 'reclaimed' : 'acquired') : 'blocked',
      detail: decision.granted
        ? 'server holds the lane (mac retired, server-only)'
        : (decision.detail ?? 'lane unavailable'),
      lease: decision.lease ?? decision.current,
    });
  }

  return {
    probeProviders: lanes.filter((lane) => lane.probe).map((lane) => lane.provider),
    lanes,
  };
}

/**
 * Release lanes the server no longer qualifies for. Run right after the probe:
 * a failed reclaim probe pushes the provider back into handoff, and without
 * this the server would sit on the lease until its TTL and lock the Mac out
 * for a whole cron gap.
 */
export async function releaseHandedOffServerLanes(
  env: Env,
  probed: LatencyProbeProviderId[],
  now: Date = new Date(),
): Promise<LatencyProbeProviderId[]> {
  if (!probed.length) return [];
  const map = await readHealthMap(env);
  const eligible = await eligibleHandoffProviders(env);
  const released: LatencyProbeProviderId[] = [];
  for (const provider of probed) {
    if (!eligible.has(provider)) continue;
    if (!map[provider]?.needScout) continue;
    if (await releaseProbeLease(env, provider, 'server', SERVER_LEASE_HOLDER_ID)) {
      released.push(provider);
    }
  }
  if (released.length) {
    console.log(
      `latency handoff: server released ${released.join(', ')} to the mac scout at ${now.toISOString()}`,
    );
  }
  return released;
}

export interface LeasedLatencyProbeOutcome<T> {
  plan: ServerLatencyProbePlan;
  /** Null when the server owns no lane this tick (nothing was fetched). */
  result: T | null;
  released: LatencyProbeProviderId[];
  skipped: ServerLatencyLaneDecision[];
}

/**
 * Run the server's latency probe under lease control.
 *
 * `runProbe` receives ONLY the providers the server holds. It is never called
 * with an empty list: tradeLatency's `requestedProviderIds` treats an empty
 * `providers` array as "unset" and falls back to probing every provider, which
 * would silently defeat the whole mechanism.
 *
 * COMPOSITION: this is the WHO half. The HOW OFTEN half runs strictly inside
 * `runProbe` — tradeLatency's evaluateLatencySourceProbe() consults the
 * measured cadence per provider, and only for the providers handed to it here.
 * Nested, not side by side: a lane the lease declined is never even offered to
 * the schedule, and the schedule can only decline a lane the lease granted.
 */
export async function runLeasedLatencyProbe<T>(
  env: Env,
  runProbe: (providers: LatencyProbeProviderId[]) => Promise<T>,
  now: Date = new Date(),
): Promise<LeasedLatencyProbeOutcome<T>> {
  const plan = await planServerLatencyProbe(env, now);
  const skipped = plan.lanes.filter((lane) => !lane.probe);
  if (!plan.probeProviders.length) {
    if (skipped.length) {
      console.log(
        'latency probe: server holds no lane this tick — ' +
          skipped.map((lane) => `${lane.provider} (${lane.action})`).join(', '),
      );
    }
    // A lease denial is decided WITHOUT consulting the schedule, so the tier is
    // genuinely unknown here; reporting one would be a lie. `tier=none` plus
    // `authority=lease` is the honest rendering, and it keeps the lane visible
    // in the same log stream as its cadence skips.
    for (const lane of skipped) {
      logProbeCadence(
        {
          lane: `server:${lane.provider}`,
          source: 'provider',
          probe: false,
          tier: 'none',
          dayType: 'n/a',
          intervalSec: 0,
          elapsedSec: Infinity,
          authority: 'lease',
          reason: lane.action,
        },
        now,
      );
    }
    return { plan, result: null, released: [], skipped };
  }
  console.log(
    `latency probe: server holds ${plan.probeProviders.join(', ')} at ` +
      `${probeTierAt('provider', now, { config: macScheduleConfig(env) })} cadence; ` +
      'per-provider spacing decided inside the probe',
  );
  const result = await runProbe(plan.probeProviders);
  const released = await releaseHandedOffServerLanes(env, plan.probeProviders, now);
  return { plan, result, released, skipped };
}

export interface MacLeaseRequest {
  provider: LatencyProbeProviderId;
  holderId: string;
  ttlSec?: number;
  /** Which FMP free-tier key slot the scout will spend. Default secondary. */
  fmpSlot?: FmpFreeKeySlot;
  now?: Date;
}

export interface MacLeaseResult extends ProbeLeaseDecision {
  /** Calls charged to the shared daily ledger for this grant. */
  charged: number;
  /** Ledger state after the decision, for scout-side logging. */
  budget: Awaited<ReturnType<typeof checkLatencyCallBudget>> | null;
  /** Measured cadence tier this decision was taken in, for scout-side logging.
   *  Null when the lease declined before the schedule was ever consulted. */
  tier?: ProbeTier | null;
  /** Target seconds between Mac probes of this lane at this instant. */
  cadenceIntervalSec?: number | null;
}

/**
 * Per-provider clock for MAC probes, so the cadence gate below has a
 * `lastProbeAt` to reason about.
 *
 * Deliberately its OWN key rather than the server's `last_poll:` stamp for the
 * lane. Reusing that stamp would make a Mac grant look like a server poll to
 * every liveness check that reads it — masking a server outage behind scout
 * activity, which is precisely the failure the handoff receipts exist to catch.
 */
function macCadenceKey(provider: LatencyProbeProviderId): string {
  return `latency-cadence:mac:${provider}`;
}

async function readMacLastProbeAt(
  env: Env,
  provider: LatencyProbeProviderId,
): Promise<Date | null> {
  try {
    const raw = await env.CONFIG_KV?.get(macCadenceKey(provider));
    if (!raw) return null;
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? new Date(ms) : null;
  } catch {
    // FAIL OPEN, unlike the lease itself. Exclusivity is already guaranteed by
    // the lease we are nested inside, so a lost cadence clock can only cost one
    // extra poll — it can never cause a double-poll. Failing closed here would
    // instead silence the scout on a KV blip, which is strictly worse.
    return null;
  }
}

async function stampMacProbe(
  env: Env,
  provider: LatencyProbeProviderId,
  now: Date,
): Promise<void> {
  try {
    await env.CONFIG_KV?.put(macCadenceKey(provider), now.toISOString(), {
      expirationTtl: 172800,
    });
  } catch {
    /* best effort; worst case the next grant is not paced */
  }
}

/**
 * Mac scout asks for a provider lane.
 *
 * Order matters: eligibility, then tenure, then budget, then THE MEASURED
 * CADENCE, then the atomic claim, then the charge. The charge happens only on a
 * granted lease, and every grant charges — so one acquire/renew authorizes
 * exactly one poll and the shared cap counts Mac calls the same way it counts
 * server calls.
 *
 * ---------------------------------------------------------------------------
 * THE COMPOSITION RULE (probeLease + probeSchedule)
 * ---------------------------------------------------------------------------
 * The lease decides WHO probes; the schedule decides HOW OFTEN. They are
 * NESTED, not side by side: the cadence check is only ever reached for a
 * provider whose lease conditions already passed, and it can only ever DECLINE.
 * It can never grant a lane on its own. If the two sat side by side, a provider
 * would be probed by whichever check passed first and the daily-budget
 * guarantee would evaporate.
 *
 * The cadence gate sits just BEFORE the claim rather than just after, for one
 * reason: the claim charges the shared ledger. Granting and then discovering it
 * was too soon would spend a call to learn nothing.
 */
export async function requestMacProbeLease(
  env: Env,
  req: MacLeaseRequest,
): Promise<MacLeaseResult> {
  const now = req.now ?? new Date();
  const deny = (
    denial: MacLeaseResult['denial'],
    detail: string,
    current: ProbeLease | null,
    budget: MacLeaseResult['budget'] = null,
  ): MacLeaseResult => ({
    granted: false,
    lease: null,
    denial,
    detail,
    current,
    charged: 0,
    budget,
  });

  const eligible = await eligibleHandoffProviders(env);
  const map = await readHealthMap(env);
  const current = await readProbeLease(env, req.provider, now);

  if (!eligible.has(req.provider) || !map[req.provider]?.needScout) {
    // The server owns this lane. Drop any stale Mac lease immediately rather
    // than letting it run out the clock while the server waits.
    await releaseProbeLease(env, req.provider, 'mac', req.holderId);
    return deny(
      'not_eligible',
      `server has not handed off ${req.provider}; scout must not poll it`,
      current,
    );
  }

  const tenureMs = macTenureMs(env);
  if (macTenureExhausted(current, tenureMs, now)) {
    await releaseProbeLease(env, req.provider, 'mac', req.holderId);
    return deny(
      'tenure_exhausted',
      `mac tenure of ${Math.round(tenureMs / 3600000)}h is spent; server reclaims ${req.provider}`,
      current,
    );
  }

  const budget = await checkLatencyCallBudget(env, req.provider, now);
  if (!budget.affordable) {
    logLatencyCapHit(req.provider, 'mac', budget);
    return deny('daily_cap', budget.detail ?? 'daily cap reached', current, budget);
  }

  // ---- HOW OFTEN — nested inside the lease-granted branch, never beside it --
  const schedule = macScheduleConfig(env);
  const cadence = shouldProbeNow({
    source: 'provider',
    now,
    lastProbeAt: await readMacLastProbeAt(env, req.provider),
    config: schedule,
  });
  // `disabled` means the operator switched the schedule off; that must restore
  // today's unpaced behaviour, not silence the scout.
  if (schedule.enabled && !cadence.probe) {
    logProbeCadence(
      {
        lane: `mac:${req.provider}`,
        source: 'provider',
        probe: false,
        tier: cadence.tier,
        dayType: cadence.dayType,
        intervalSec: cadence.intervalSec,
        elapsedSec: cadence.elapsedSec,
        authority: 'schedule',
        reason: cadence.reason,
      },
      now,
    );
    return {
      ...deny(
        'off_cadence',
        `measured ${cadence.tier} cadence for ${req.provider} is ${cadence.intervalSec}s; ` +
          `${Math.round(cadence.elapsedSec)}s elapsed`,
        current,
        budget,
      ),
      tier: cadence.tier,
      cadenceIntervalSec: cadence.intervalSec,
    };
  }

  const ttlMs = req.ttlSec ? Math.max(1000, req.ttlSec * 1000) : macLeaseTtlMs(env);
  const decision = await acquireProbeLease(env, {
    provider: req.provider,
    holder: 'mac',
    holderId: req.holderId,
    ttlMs,
    reason: map[req.provider]?.needScoutReason ?? 'server handed off',
    now,
  });
  if (!decision.granted) {
    return { ...decision, charged: 0, budget, tier: cadence.tier, cadenceIntervalSec: cadence.intervalSec };
  }

  const { charged } = await chargeLatencyCalls(env, req.provider, {
    fmpSlot: req.fmpSlot ?? '2',
    now,
  });
  // Stamp only on a granted, charged lease: that is exactly one authorized poll.
  await stampMacProbe(env, req.provider, now);
  logProbeCadence(
    {
      lane: `mac:${req.provider}`,
      source: 'provider',
      probe: true,
      tier: cadence.tier,
      dayType: cadence.dayType,
      intervalSec: cadence.intervalSec,
      elapsedSec: cadence.elapsedSec,
      authority: 'schedule',
      reason: schedule.enabled ? cadence.reason : 'schedule-disabled',
    },
    now,
  );
  return {
    ...decision,
    charged,
    budget,
    tier: cadence.tier,
    cadenceIntervalSec: cadence.intervalSec,
  };
}
