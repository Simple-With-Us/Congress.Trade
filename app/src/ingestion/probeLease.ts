/**
 * src/ingestion/probeLease.ts
 *
 * MUTUAL EXCLUSION for disclosure-latency provider polling.
 *
 * The problem this replaces: `scoutHandoff.ts` computes a `needScout` flag and
 * publishes it in the scout plan, but that is a one-way *advisory hint*. The
 * server never read its own flag, so once handoff opened the server kept
 * polling the provider while the Mac started polling it too. Both hosts spend
 * from the same free-tier quota; every duplicate call is wasted money.
 *
 * A lease is lane ownership, not a per-call mutex:
 *
 *   • Exactly one holder ('server' | 'mac') owns a provider lane at a time.
 *   • The holder must own the lane BEFORE it calls the provider.
 *   • Leases SELF-EXPIRE, so a crashed holder frees the lane on its own.
 *   • The server is preferred: it holds whenever it is healthy, and it
 *     preempts the Mac once the Mac's tenure window is up.
 *
 * ATOMICITY — why D1 and not KV
 * -----------------------------
 * Cloudflare KV is eventually consistent and offers no compare-and-set: two
 * acquirers can both read "free" and both write "mine", which is precisely the
 * failure we are trying to remove. D1 (SQLite) gives a real conditional upsert:
 *
 *     INSERT INTO latency_probe_leases (...) VALUES (...)
 *     ON CONFLICT(provider) DO UPDATE SET ... WHERE <still claimable>
 *
 * is ONE statement in ONE implicit transaction against a row whose PRIMARY KEY
 * is `provider`. Whoever commits first wins; the loser's WHERE no longer holds,
 * so its `meta.changes` is 0. Two simultaneous acquirers cannot both see 1.
 * `acquireDenoCronSingleton` (deno/scheduledTick.ts) already runs this exact
 * primitive in production for the scheduled-tick singleton lock.
 *
 * The Mac never touches D1 directly — it acquires through
 * `POST /api/ingest/probe-lease`, so the server's D1 is the single arbiter for
 * both hosts.
 */
import type { Env } from '../shared/types.ts';
import { all, get, run, withSqliteLockRetry } from '../shared/db.ts';
import type { LatencyProbeProviderId } from './scoutHandoff.ts';

export type ProbeLeaseHolder = 'server' | 'mac';

/**
 * Server lease TTL. Must comfortably exceed the cron gap so a healthy server
 * renews before expiry (the `free` cost profile fires every 15 min), while
 * still bounding how long a hard-crashed server parks the lane. Default 20 min.
 */
export const SERVER_LEASE_TTL_SEC_DEFAULT = 20 * 60;

/**
 * Mac lease TTL. The Mac renews once per poll cycle (default 45 s), and each
 * renewal is the metering event that charges the shared daily ledger — so one
 * acquire/renew authorizes exactly one poll. Keep this a small multiple of the
 * cycle so a crashed scout frees the lane in about a minute. Default 150 s.
 */
export const MAC_LEASE_TTL_SEC_DEFAULT = 150;

/**
 * How long the Mac may hold a lane before the server reclaims it, even if the
 * Mac is succeeding. Owner requirement: the server comes back when it can, so
 * a healthy-looking Mac must not squat the lane indefinitely. Default 6 h,
 * matching the historical LATENCY_SCOUT_SILENCE_HOURS window.
 */
export const MAC_TENURE_HOURS_DEFAULT = 6;

/** Hard bounds so a bad env value cannot disable exclusion or park a lane. */
const TTL_SEC_MIN = 30;
const TTL_SEC_MAX = 60 * 60;
const TENURE_HOURS_MIN = 0.25;
const TENURE_HOURS_MAX = 48;

export interface ProbeLease {
  provider: LatencyProbeProviderId;
  holder: ProbeLeaseHolder;
  holderId: string;
  acquiredAt: string;
  /** ISO instant this lease stops being valid. */
  expiresAt: string;
  /** ISO instant the current holder's tenure began (survives renewals). */
  tenureStartedAt: string;
  reason: string | null;
  renewals: number;
  updatedAt: string;
  /** True when `expiresAt` is already in the past (lane is free). */
  expired: boolean;
  /** Whole seconds until expiry; 0 once expired. */
  secondsRemaining: number;
}

export type ProbeLeaseDenial =
  /** Another holder owns a live, non-preemptible lease. */
  | 'held_by_other'
  /** The Mac asked but the server has not handed this provider off. */
  | 'not_eligible'
  /** The Mac's tenure window is spent; the server must reclaim. */
  | 'tenure_exhausted'
  /** The shared daily call ledger for this provider is exhausted. */
  | 'daily_cap'
  /**
   * The lease conditions PASSED, but the measured cadence in probeSchedule.ts
   * says it is not yet time — see the composition rule in
   * scoutHandoff.requestMacProbeLease: the lease decides WHO probes, the
   * schedule decides HOW OFTEN, and the schedule is consulted only inside a
   * lease-granted branch. A caller that sees this should retry later, not
   * escalate: the lane is healthy and is ours to take when it is due.
   */
  | 'off_cadence'
  /** Lease storage is unavailable (fail-closed for the Mac). */
  | 'storage_unavailable';

export interface ProbeLeaseDecision {
  granted: boolean;
  lease: ProbeLease | null;
  denial: ProbeLeaseDenial | null;
  detail: string | null;
  /** Whoever holds the lane when we were denied — for operator visibility. */
  current: ProbeLease | null;
}

interface LeaseRow {
  provider: string;
  holder: string;
  holder_id: string;
  acquired_at: string;
  expires_at: number;
  tenure_started_at: number;
  reason: string | null;
  renewals: number;
  updated_at: string;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function readNumericEnv(env: Env, name: string, fallback: number): number {
  const raw = (env as unknown as Record<string, string | undefined>)[name];
  const n = Number.parseFloat((raw ?? '').trim());
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function serverLeaseTtlMs(env: Env): number {
  return (
    clamp(
      readNumericEnv(env, 'LATENCY_LEASE_SERVER_TTL_SEC', SERVER_LEASE_TTL_SEC_DEFAULT),
      TTL_SEC_MIN,
      TTL_SEC_MAX,
    ) * 1000
  );
}

export function macLeaseTtlMs(env: Env): number {
  return (
    clamp(
      readNumericEnv(env, 'LATENCY_LEASE_MAC_TTL_SEC', MAC_LEASE_TTL_SEC_DEFAULT),
      TTL_SEC_MIN,
      TTL_SEC_MAX,
    ) * 1000
  );
}

export function macTenureMs(env: Env): number {
  return (
    clamp(
      readNumericEnv(env, 'LATENCY_MAC_TENURE_HOURS', MAC_TENURE_HOURS_DEFAULT),
      TENURE_HOURS_MIN,
      TENURE_HOURS_MAX,
    ) *
    3600 *
    1000
  );
}

function toLease(row: LeaseRow, nowMs: number): ProbeLease {
  const expired = row.expires_at <= nowMs;
  return {
    provider: row.provider as LatencyProbeProviderId,
    holder: row.holder === 'mac' ? 'mac' : 'server',
    holderId: row.holder_id,
    acquiredAt: row.acquired_at,
    expiresAt: new Date(row.expires_at).toISOString(),
    tenureStartedAt: new Date(row.tenure_started_at).toISOString(),
    reason: row.reason,
    renewals: row.renewals,
    updatedAt: row.updated_at,
    expired,
    secondsRemaining: expired ? 0 : Math.floor((row.expires_at - nowMs) / 1000),
  };
}

/** Raw lease row for a provider, expired or not. Null when never claimed. */
export async function readProbeLease(
  env: Env,
  provider: LatencyProbeProviderId,
  now: Date = new Date(),
): Promise<ProbeLease | null> {
  try {
    const row = await get<LeaseRow>(
      env.DB,
      `SELECT provider, holder, holder_id, acquired_at, expires_at,
              tenure_started_at, reason, renewals, updated_at
         FROM latency_probe_leases
        WHERE provider = ?`,
      [provider],
    );
    return row ? toLease(row, now.getTime()) : null;
  } catch {
    return null;
  }
}

/** Every lane's lease, for the operator surface. Includes expired rows. */
export async function readAllProbeLeases(
  env: Env,
  now: Date = new Date(),
): Promise<ProbeLease[]> {
  try {
    const rows = await all<LeaseRow>(
      env.DB,
      `SELECT provider, holder, holder_id, acquired_at, expires_at,
              tenure_started_at, reason, renewals, updated_at
         FROM latency_probe_leases
        ORDER BY provider`,
    );
    return rows.map((row) => toLease(row, now.getTime()));
  } catch {
    return [];
  }
}

/**
 * True when a Mac-held lease has used up its tenure window and the server is
 * entitled to preempt it. Exported so callers can explain the decision.
 */
export function macTenureExhausted(
  lease: ProbeLease | null,
  tenureMs: number,
  now: Date = new Date(),
): boolean {
  if (!lease || lease.holder !== 'mac') return false;
  return Date.parse(lease.tenureStartedAt) + tenureMs <= now.getTime();
}

export interface AcquireProbeLeaseOptions {
  provider: LatencyProbeProviderId;
  holder: ProbeLeaseHolder;
  /** Stable per-process token. Renewal requires the same value. */
  holderId: string;
  ttlMs: number;
  reason?: string | null;
  now?: Date;
  /**
   * Server-only. Allows stealing a Mac-held lease whose tenure has elapsed.
   * Evaluated inside the same atomic statement, never read-then-write.
   */
  preemptMacAfterMs?: number | null;
}

/**
 * Claim or renew a provider lane.
 *
 * The whole decision is one conditional upsert, so concurrency is decided by
 * SQLite rather than by application logic. A caller wins only when the row is
 * expired, or is already its own (holder AND holder_id match, i.e. a renewal),
 * or — for a preempting server — is Mac-held with a spent tenure.
 */
export async function acquireProbeLease(
  env: Env,
  opts: AcquireProbeLeaseOptions,
): Promise<ProbeLeaseDecision> {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const expiresAt = nowMs + Math.max(1000, Math.floor(opts.ttlMs));
  const reason = opts.reason ?? null;
  // Sentinel that can never match a real tenure timestamp when preemption is
  // off, so the branch is simply unreachable rather than conditionally built.
  const preemptBefore =
    typeof opts.preemptMacAfterMs === 'number'
      ? nowMs - Math.max(0, opts.preemptMacAfterMs)
      : Number.NEGATIVE_INFINITY;

  let changes = 0;
  try {
    // Busy writes retry.  The lease still fail-closes if they keep failing.
    // A non-busy error (missing table, malformed SQL) is one-shot fail-closed.
    const res = await withSqliteLockRetry(() => run(
      env.DB,
      `INSERT INTO latency_probe_leases
         (provider, holder, holder_id, acquired_at, expires_at,
          tenure_started_at, reason, renewals, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(provider) DO UPDATE SET
         holder       = excluded.holder,
         holder_id    = excluded.holder_id,
         acquired_at  = excluded.acquired_at,
         expires_at   = excluded.expires_at,
         reason       = excluded.reason,
         updated_at   = excluded.updated_at,
         -- Renewal by the same instance keeps the tenure clock running; any
         -- takeover restarts it, which is what bounds the Mac's stint.
         tenure_started_at = CASE
           WHEN latency_probe_leases.holder = excluded.holder
            AND latency_probe_leases.holder_id = excluded.holder_id
           THEN latency_probe_leases.tenure_started_at
           ELSE excluded.tenure_started_at END,
         renewals = CASE
           WHEN latency_probe_leases.holder = excluded.holder
            AND latency_probe_leases.holder_id = excluded.holder_id
           THEN latency_probe_leases.renewals + 1
           ELSE 0 END
       WHERE latency_probe_leases.expires_at <= ?
          OR (latency_probe_leases.holder = excluded.holder
              AND latency_probe_leases.holder_id = excluded.holder_id)
          OR (latency_probe_leases.holder = 'mac'
              AND excluded.holder = 'server'
              AND latency_probe_leases.tenure_started_at <= ?)`,
      [
        opts.provider,
        opts.holder,
        opts.holderId,
        nowIso,
        expiresAt,
        nowMs,
        reason,
        nowIso,
        nowMs,
        // NEGATIVE_INFINITY is not a valid bind param; use a value no real
        // epoch-ms tenure can be <= to.
        Number.isFinite(preemptBefore) ? preemptBefore : -1,
      ],
    ));
    changes = res?.meta?.changes ?? 0;
  } catch (err) {
    // Fail CLOSED. An unavailable lease table must not silently re-enable the
    // double-polling this module exists to prevent.
    return {
      granted: false,
      lease: null,
      denial: 'storage_unavailable',
      detail: `lease storage unavailable: ${(err as Error).message}`,
      current: null,
    };
  }

  const current = await readProbeLease(env, opts.provider, now);
  if (changes === 1) {
    return { granted: true, lease: current, denial: null, detail: null, current };
  }
  return {
    granted: false,
    lease: null,
    denial: 'held_by_other',
    detail: current
      ? `provider lane held by ${current.holder} until ${current.expiresAt}`
      : 'lease row unavailable',
    current,
  };
}

/**
 * Give a lane back. Token-guarded so a slow or restarted holder can never
 * delete its successor's lease.
 */
export async function releaseProbeLease(
  env: Env,
  provider: LatencyProbeProviderId,
  holder: ProbeLeaseHolder,
  holderId: string,
): Promise<boolean> {
  try {
    const res = await run(
      env.DB,
      `DELETE FROM latency_probe_leases
        WHERE provider = ? AND holder = ? AND holder_id = ?`,
      [provider, holder, holderId],
    );
    return (res?.meta?.changes ?? 0) === 1;
  } catch {
    return false;
  }
}
