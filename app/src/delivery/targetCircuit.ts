/**
 * src/delivery/targetCircuit.ts
 *
 * GOVERNOR 3 — per-TARGET outbound circuit breaker for webhook + cross-app
 * deliveries (owner mandate: "no storms from other sites' outages").
 *
 * The usage-telemetry breaker in shared/thirdPartyTelemetry.ts protects ONE
 * receiver with a single KV key; subscriber webhooks and the peer app are MANY
 * operator/user-configured targets, so this breaker keys durable state per
 * target host in D1 (`delivery_target_circuit`, migration 0049) where atomic
 * conditional updates coordinate isolates without a Durable Object.
 *
 * Behavior (the socratictrade.com 401 storm — 696 failed attempts — becomes
 * "5 attempts, circuit open, quiet hourly probes, one diagnostics line"):
 *   - N consecutive failures (DELIVERY_TARGET_FAILURE_THRESHOLD, default 5)
 *     OPEN the circuit for that target with an exponential schedule
 *     (base DELIVERY_TARGET_BASE_BACKOFF_SEC, default 60s, doubling, capped
 *     at 1 probe/hour/target).
 *   - While open, webhook deliveries PARK in the deliveries table
 *     (status 'parked') without consuming attempts and WITHOUT throwing, so
 *     the Cloudflare Queue never retry-storms a dead target.
 *   - Once the open window elapses, exactly ONE delivery per target is
 *     released as a half-open probe (atomic conditional claim); a 2xx closes
 *     the circuit and the scheduled flush releases the parked backlog.
 *   - A daily FAILED-attempt cap per target
 *     (DELIVERY_TARGET_DAILY_ATTEMPT_CAP, default 50) is the hard backstop:
 *     past it, the target parks until the next UTC day regardless of circuit
 *     state. Successful deliveries never count against it.
 *   - A per-subscription parked-queue depth cap
 *     (DELIVERY_TARGET_PARKED_CAP, default 500) quarantines overflow rows and
 *     alerts the admin, so a weeks-long outage cannot grow the backlog
 *     without bound.
 *
 * All knobs are read from the immutable Worker env (like the usage-telemetry
 * circuit limits): they gate the delivery hot path and must stay available
 * even while KV/Infisical are themselves degraded.
 */

import type { Env } from '../shared/types.ts';
import { all, get, run } from '../shared/db.ts';
import { prefixedId } from '../shared/ids.ts';
import { notifyAdmin } from '../alerts/notify.ts';

export const DEFAULT_TARGET_FAILURE_THRESHOLD = 5;
export const DEFAULT_TARGET_DAILY_ATTEMPT_CAP = 50;
export const DEFAULT_TARGET_BASE_BACKOFF_SEC = 60;
export const DEFAULT_TARGET_PARKED_CAP = 500;
/** Hard cap on the open window AND the half-open probe lease: 1 probe/hour. */
export const TARGET_PROBE_INTERVAL_SEC = 3_600;
/** Mirror of webhook.ts MAX_ATTEMPTS: rows at/over this many failed attempts
 *  are terminal and must never be resurrected by parking. */
const DELIVERY_MAX_ATTEMPTS = 5;

function intKnob(value: string | undefined, fallback: number): number {
  const n = Number.parseInt((value ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function failureThreshold(env: Env): number {
  return intKnob(env.DELIVERY_TARGET_FAILURE_THRESHOLD, DEFAULT_TARGET_FAILURE_THRESHOLD);
}

function dailyAttemptCap(env: Env): number {
  return intKnob(env.DELIVERY_TARGET_DAILY_ATTEMPT_CAP, DEFAULT_TARGET_DAILY_ATTEMPT_CAP);
}

function baseBackoffSec(env: Env): number {
  return intKnob(env.DELIVERY_TARGET_BASE_BACKOFF_SEC, DEFAULT_TARGET_BASE_BACKOFF_SEC);
}

function parkedCap(env: Env): number {
  return intKnob(env.DELIVERY_TARGET_PARKED_CAP, DEFAULT_TARGET_PARKED_CAP);
}

function dayStr(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Stable per-target circuit key: kind + lowercase hostname. Null for URLs the
 * URL parser rejects (those fail validation later anyway). */
export function targetKeyForUrl(
  url: string | null | undefined,
  kind: 'webhook' | 'peer-app' = 'webhook',
): string | null {
  try {
    return `${kind}:${new URL(String(url)).hostname.toLowerCase().replace(/\.$/, '')}`;
  } catch {
    return null;
  }
}

interface CircuitRow {
  target_key: string;
  consecutive_failures: number;
  open_until: string | null;
  failures_day: string | null;
  failures_today: number;
  last_error: string | null;
  updated_at: string;
}

export type TargetGate =
  | { allowed: true; probe: boolean }
  | { allowed: false; reason: 'circuit-open' | 'daily-cap' | 'probe-contended'; retryAfterSec: number };

function secondsUntilNextUtcDay(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

async function readCircuitRow(env: Env, targetKey: string): Promise<CircuitRow | null> {
  return get<CircuitRow>(
    env.DB,
    `SELECT target_key, consecutive_failures, open_until, failures_day,
            failures_today, last_error, updated_at
       FROM delivery_target_circuit WHERE target_key = ?`,
    [targetKey],
  );
}

/**
 * Gate one real outbound attempt to a target. Healthy targets cost one read
 * and zero writes. An elapsed open window admits exactly one contender as the
 * half-open probe (atomic conditional update on the exact `open_until` value);
 * everyone else keeps parking. Fails OPEN when the circuit table is missing
 * (pre-migration) — the governor must never block deliveries because its own
 * state is unavailable.
 */
export async function checkTargetCircuit(
  env: Env,
  targetKey: string,
  now = new Date(),
): Promise<TargetGate> {
  let row: CircuitRow | null;
  try {
    row = await readCircuitRow(env, targetKey);
  } catch {
    return { allowed: true, probe: false };
  }
  if (!row) return { allowed: true, probe: false };

  const nowIso = now.toISOString();
  const day = dayStr(now);
  if (row.failures_day === day && row.failures_today >= dailyAttemptCap(env)) {
    return { allowed: false, reason: 'daily-cap', retryAfterSec: secondsUntilNextUtcDay(now) };
  }
  if (row.open_until && row.open_until > nowIso) {
    return {
      allowed: false,
      reason: 'circuit-open',
      retryAfterSec: Math.max(1, Math.ceil((Date.parse(row.open_until) - now.getTime()) / 1000)),
    };
  }
  if (row.open_until && row.open_until <= nowIso) {
    // Half-open: claim the singleton probe by pushing open_until forward one
    // probe interval. Only the contender that observes changes=1 proceeds; the
    // probe lease itself guarantees at most one probe per hour even if the
    // probe's failure recording later fails.
    const probeUntil = new Date(now.getTime() + TARGET_PROBE_INTERVAL_SEC * 1000).toISOString();
    try {
      const claim = await run(
        env.DB,
        `UPDATE delivery_target_circuit
            SET open_until = ?, updated_at = ?
          WHERE target_key = ? AND open_until = ?`,
        [probeUntil, nowIso, targetKey, row.open_until],
      );
      if ((claim.meta?.changes ?? 0) !== 1) {
        return { allowed: false, reason: 'probe-contended', retryAfterSec: TARGET_PROBE_INTERVAL_SEC };
      }
      return { allowed: true, probe: true };
    } catch {
      return { allowed: false, reason: 'probe-contended', retryAfterSec: TARGET_PROBE_INTERVAL_SEC };
    }
  }
  return { allowed: true, probe: false };
}

/** Auto-close on 2xx: reset failures + open window. Fail-soft. */
export async function recordTargetSuccess(env: Env, targetKey: string, now = new Date()): Promise<void> {
  try {
    await run(
      env.DB,
      `UPDATE delivery_target_circuit
          SET consecutive_failures = 0, open_until = NULL, last_error = NULL, updated_at = ?
        WHERE target_key = ?`,
      [now.toISOString(), targetKey],
    );
  } catch {
    /* pre-migration or transient; a healthy target needs no durable state */
  }
}

export interface TargetFailureRecord {
  consecutiveFailures: number;
  opened: boolean;
  openUntil: string | null;
}

/**
 * Count one FAILED outbound attempt. Opens the circuit at the threshold with
 * an exponential window (base * 2^(n - threshold), capped at one hour). The
 * failure counter increments atomically in SQL; the open window is monotonic
 * (never shortened by a racing writer). Fail-soft.
 */
export async function recordTargetFailure(
  env: Env,
  targetKey: string,
  error: string,
  now = new Date(),
): Promise<TargetFailureRecord | null> {
  const nowIso = now.toISOString();
  const day = dayStr(now);
  try {
    let row = await readCircuitRow(env, targetKey);
    const nextFailures = (row?.consecutive_failures ?? 0) + 1;
    const threshold = failureThreshold(env);
    const base = baseBackoffSec(env);
    const openUntil = nextFailures >= threshold
      ? new Date(
          now.getTime() + Math.min(
            TARGET_PROBE_INTERVAL_SEC,
            base * 2 ** (nextFailures - threshold),
          ) * 1000,
        ).toISOString()
      : null;
    await run(
      env.DB,
      `INSERT INTO delivery_target_circuit
         (target_key, consecutive_failures, open_until, failures_day, failures_today, last_error, updated_at)
       VALUES (?, 1, ?, ?, 1, ?, ?)
       ON CONFLICT(target_key) DO UPDATE SET
         consecutive_failures = delivery_target_circuit.consecutive_failures + 1,
         open_until = CASE
           WHEN (delivery_target_circuit.consecutive_failures + 1) >= ? THEN
             strftime('%Y-%m-%dT%H:%M:%SZ', datetime(?, '+' || CAST(MIN(?,
               ? * CASE (delivery_target_circuit.consecutive_failures + 1 - ?)
                 WHEN 0 THEN 1
                 WHEN 1 THEN 2
                 WHEN 2 THEN 4
                 WHEN 3 THEN 8
                 WHEN 4 THEN 16
                 WHEN 5 THEN 32
                 ELSE 64
               END
             ) AS TEXT) || ' seconds'))
           ELSE NULL
         END,
         failures_today = CASE
           WHEN delivery_target_circuit.failures_day = excluded.failures_day
             THEN delivery_target_circuit.failures_today + 1
           ELSE 1
         END,
         failures_day = excluded.failures_day,
         last_error = excluded.last_error,
         updated_at = excluded.updated_at`,
      [
        targetKey,
        openUntil,
        day,
        error.slice(0, 300),
        nowIso,
        threshold,
        nowIso,
        TARGET_PROBE_INTERVAL_SEC,
        base,
        threshold,
      ],
    );
    row = await readCircuitRow(env, targetKey);
    return {
      consecutiveFailures: row?.consecutive_failures ?? nextFailures,
      opened: Boolean(row?.open_until && row.open_until > nowIso),
      openUntil: row?.open_until ?? openUntil,
    };
  } catch {
    return null;
  }
}

export type ParkOutcome = 'parked' | 'quarantined' | 'skipped';

/**
 * Durably park one subscription/transaction delivery while its target circuit
 * is open (or capped). No attempt is consumed and NOTHING is thrown, so the
 * queue message completes instead of retry-storming. Terminal rows
 * (delivered / skipped / quarantined / failed at max attempts) and rows mid-
 * send under a live lease are left untouched. Past the parked-depth cap the
 * row is quarantined instead and the admin is alerted (throttled).
 */
export async function parkDelivery(
  env: Env,
  subscriptionId: string,
  txId: string,
  reason: string,
  now = new Date(),
): Promise<ParkOutcome> {
  const nowIso = now.toISOString();
  const note = `target circuit: ${reason}`.slice(0, 300);
  const parked = await run(
    env.DB,
    `INSERT INTO deliveries (id, subscription_id, tx_id, status, attempts, last_error, updated_at)
     VALUES (?, ?, ?, 'parked', 0, ?, ?)
     ON CONFLICT (subscription_id, tx_id) DO UPDATE SET
       status = 'parked', last_error = excluded.last_error, updated_at = excluded.updated_at,
       claim_token = NULL, lease_until = NULL
     WHERE deliveries.status NOT IN ('delivered', 'skipped', 'quarantined')
       AND NOT (deliveries.status = 'failed' AND deliveries.attempts >= ${DELIVERY_MAX_ATTEMPTS})
       AND (deliveries.status != 'sending'
            OR deliveries.lease_until IS NULL
            OR deliveries.lease_until <= excluded.updated_at)`,
    [prefixedId('dlv'), subscriptionId, txId, note, nowIso],
  );
  if (!parked || (parked.meta?.changes ?? 0) === 0) return 'skipped';

  // Queue-depth cap: a target that stays dead must not grow an unbounded
  // parked backlog. Overflow rows become terminal 'quarantined' + one
  // throttled admin alert per subscription.
  try {
    if ((await parkedDepth(env, subscriptionId)) > parkedCap(env)) {
      await run(
        env.DB,
        `UPDATE deliveries SET status = 'quarantined', updated_at = ?
          WHERE subscription_id = ? AND tx_id = ? AND status = 'parked'`,
        [nowIso, subscriptionId, txId],
      );
      await notifyAdmin(env, {
        subject: 'Outbound delivery parked-queue overflow',
        text:
          `Subscription ${subscriptionId} exceeded the parked-delivery depth cap ` +
          `(${parkedCap(env)}). Overflow deliveries are quarantined (not dropped) and ` +
          `recover to parked when the target circuit closes and parked headroom opens. ` +
          `Operator replay: POST /api/admin/delivery-requeue-quarantined. ` +
          `Latest quarantined transaction: ${txId}\nReason: ${note}`,
        dedupeKey: `target-parked-overflow:${subscriptionId}`,
        throttleSec: 3600,
      }).catch(() => {});
      return 'quarantined';
    }
  } catch {
    /* depth bookkeeping is best-effort; the parked row itself is durable */
  }
  return 'parked';
}

export interface ParkedFlushResult {
  scanned: number;
  released: number;
  skipped: number;
  quarantineRecovered: number;
}

export interface QuarantineRecoveryResult {
  scanned: number;
  recovered: number;
  skipped: number;
}

async function parkedDepth(env: Env, subscriptionId: string): Promise<number> {
  const depth = await get<{ c: number }>(
    env.DB,
    `SELECT COUNT(*) AS c FROM deliveries WHERE subscription_id = ? AND status = 'parked'`,
    [subscriptionId],
  );
  return depth?.c ?? 0;
}

/**
 * Move quarantined webhook rows back to `parked` when it is safe: the target
 * circuit is not open (unless `ignoreCircuit`), the daily attempt cap has
 * headroom, and the subscription still has parked-queue depth under the cap.
 * Oldest quarantined rows are recovered first so a long outage drains in order.
 */
export async function recoverQuarantinedDeliveries(
  env: Env,
  opts: {
    limit?: number;
    now?: Date;
    subscriptionId?: string;
    ignoreCircuit?: boolean;
    dryRun?: boolean;
  } = {},
): Promise<QuarantineRecoveryResult> {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 50), 1), 500);
  const subscriptionFilter = opts.subscriptionId?.trim()
    ? ` AND d.subscription_id = ?`
    : '';
  const params: (string | number)[] = opts.subscriptionId?.trim() ? [opts.subscriptionId.trim()] : [];
  let rows: Array<{ subscription_id: string; tx_id: string; target_url: string | null }> = [];
  try {
    rows = await all(
      env.DB,
      `SELECT d.subscription_id, d.tx_id, s.target_url
         FROM deliveries d
         JOIN subscriptions s ON s.id = d.subscription_id
        WHERE d.status = 'quarantined' AND s.active = 1 AND s.delivery = 'webhook'${subscriptionFilter}
        ORDER BY d.updated_at ASC
        LIMIT ${limit}`,
      params,
    );
  } catch {
    return { scanned: 0, recovered: 0, skipped: 0 };
  }
  const result: QuarantineRecoveryResult = { scanned: rows.length, recovered: 0, skipped: 0 };
  const depthCache = new Map<string, number>();
  const day = dayStr(now);
  for (const row of rows) {
    const targetKey = targetKeyForUrl(row.target_url);
    if (!targetKey) {
      result.skipped += 1;
      continue;
    }
    if (!opts.ignoreCircuit) {
      const gate = await checkTargetCircuit(env, targetKey, now);
      if (!gate.allowed) {
        result.skipped += 1;
        continue;
      }
      try {
        const circuit = await readCircuitRow(env, targetKey);
        if (circuit && circuit.failures_day === day && circuit.failures_today >= dailyAttemptCap(env)) {
          result.skipped += 1;
          continue;
        }
      } catch {
        /* fail open */
      }
    }
    let depth = depthCache.get(row.subscription_id);
    if (depth === undefined) {
      try {
        depth = await parkedDepth(env, row.subscription_id);
      } catch {
        result.skipped += 1;
        continue;
      }
      depthCache.set(row.subscription_id, depth);
    }
    if (depth >= parkedCap(env)) {
      result.skipped += 1;
      continue;
    }
    if (opts.dryRun) {
      result.recovered += 1;
      depthCache.set(row.subscription_id, depth + 1);
      continue;
    }
    try {
      const updated = await run(
        env.DB,
        `UPDATE deliveries
            SET status = 'parked', updated_at = ?
          WHERE subscription_id = ? AND tx_id = ? AND status = 'quarantined'`,
        [nowIso, row.subscription_id, row.tx_id],
      );
      if ((updated.meta?.changes ?? 0) === 1) {
        result.recovered += 1;
        depthCache.set(row.subscription_id, depth + 1);
      } else {
        result.skipped += 1;
      }
    } catch {
      result.skipped += 1;
    }
  }
  return result;
}

/**
 * Scheduled re-dispatch of parked deliveries. Groups a bounded page of parked
 * rows by target, releases the whole group when the target circuit is closed,
 * and releases exactly ONE row (the oldest) when an open circuit's window has
 * elapsed — that row becomes the half-open probe, whose 2xx closes the
 * circuit so the next flush releases the rest. Rows stay 'parked' until the
 * targeted dispatch claims them, so duplicate releases are absorbed by the
 * delivery claim CAS.
 */
export async function flushParkedDeliveries(
  env: Env,
  opts: { limit?: number; now?: Date } = {},
): Promise<ParkedFlushResult> {
  const now = opts.now ?? new Date();
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 50), 1), 200);
  const quarantineRecovery = await recoverQuarantinedDeliveries(env, { limit, now });
  let rows: Array<{ subscription_id: string; tx_id: string; target_url: string | null }> = [];
  try {
    rows = await all(
      env.DB,
      `SELECT d.subscription_id, d.tx_id, s.target_url
         FROM deliveries d
         JOIN subscriptions s ON s.id = d.subscription_id
        WHERE d.status = 'parked' AND s.active = 1 AND s.delivery = 'webhook'
        ORDER BY d.updated_at ASC
        LIMIT ${limit}`,
      [],
    );
  } catch {
    return { scanned: 0, released: 0, skipped: 0, quarantineRecovered: quarantineRecovery.recovered };
  }
  const result: ParkedFlushResult = {
    scanned: rows.length,
    released: 0,
    skipped: 0,
    quarantineRecovered: quarantineRecovery.recovered,
  };
  const byTarget = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = targetKeyForUrl(row.target_url);
    if (!key) {
      result.skipped += 1;
      continue;
    }
    const group = byTarget.get(key) ?? [];
    group.push(row);
    byTarget.set(key, group);
  }
  const nowIso = now.toISOString();
  for (const [targetKey, group] of byTarget) {
    let circuit: CircuitRow | null = null;
    try {
      circuit = await readCircuitRow(env, targetKey);
    } catch {
      /* fail open below */
    }
    const day = dayStr(now);
    if (circuit && circuit.failures_day === day && circuit.failures_today >= dailyAttemptCap(env)) {
      result.skipped += group.length;
      continue;
    }
    const open = Boolean(circuit?.open_until && circuit.open_until > nowIso);
    const probeDue = Boolean(circuit?.open_until && circuit.open_until <= nowIso);
    // Closed circuit: release everything. Probe due: release only the oldest
    // row; the delivery-time gate claims the actual probe atomically.
    const releasable = open ? [] : probeDue ? group.slice(0, 1) : group;
    result.skipped += group.length - releasable.length;
    for (const row of releasable) {
      try {
        await env.DELIVERY_QUEUE.send({
          type: 'delivery.dispatch',
          txId: row.tx_id,
          subscriptionId: row.subscription_id,
        });
        result.released += 1;
      } catch {
        result.skipped += 1;
      }
    }
  }
  return result;
}

export interface TargetCircuitSnapshot {
  targetKey: string;
  consecutiveFailures: number;
  openUntil: string | null;
  failuresToday: number;
  failuresDay: string | null;
  lastError: string | null;
  updatedAt: string;
}

/** Admin-diagnostics view of every known target circuit (bounded). */
export async function readTargetCircuits(env: Env, limit = 25): Promise<TargetCircuitSnapshot[]> {
  const rows = await all<CircuitRow>(
    env.DB,
    `SELECT target_key, consecutive_failures, open_until, failures_day,
            failures_today, last_error, updated_at
       FROM delivery_target_circuit
      ORDER BY updated_at DESC
      LIMIT ${Math.min(Math.max(Math.floor(limit), 1), 100)}`,
    [],
  );
  return rows.map((row) => ({
    targetKey: row.target_key,
    consecutiveFailures: row.consecutive_failures,
    openUntil: row.open_until,
    failuresToday: row.failures_today,
    failuresDay: row.failures_day,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  }));
}
