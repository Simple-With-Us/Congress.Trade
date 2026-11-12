/**
 * src/shared/d1Budget.ts
 *
 * App-level D1 rows-read / rows-written daily budget guard.
 *
 * Cloudflare D1 bills per row read/written and has NO hard spend cap — a runaway
 * scan or backfill accrues cost with only after-the-fact budget *alerts*, which
 * is how a $10 budget got blown. This module gives the app its own ceiling:
 *
 *   - METER: every all()/run()/batch() through shared/db.ts reports its
 *     D1Meta.rows_read / rows_written here (recordD1Meta), accumulated per
 *     isolate and flushed once per invocation to an atomic D1 day-counter.
 *   - ALERT (default, always on): flushD1Budget() warns + sends a Sentry
 *     message when the day's total crosses a soft fraction of the budget, so a
 *     spike is visible in hours, not at invoice time. No blocking.
 *   - ENFORCE (opt-in, default OFF): when D1_ROW_BUDGET_ENFORCE is truthy AND
 *     the day's total exceeds the hard budget, isD1RowBudgetExceeded() returns
 *     true so discretionary batch work (the daily enrichment/price/backfill
 *     jobs) can self-abort. It never gates health, auth, billing, delivery, or
 *     the public read path.
 *
 * Everything here FAILS OPEN: any D1/KV/meta error is swallowed so the guard
 * can never take the app down. D1's atomic counter prevents concurrent isolate
 * flushes from losing increments; reconcile against D1's own Row Metrics for
 * the authoritative number.
 *
 * NOTE: get() in shared/db.ts uses .first(), which returns the row directly and
 * carries no D1Meta, so single-row point reads are intentionally unmetered. The
 * expensive unindexed point reads that motivated this are addressed by indexing
 * (migration 0044) + caching, not here.
 */

import type { Env } from './types.ts';
import type { SqlParam } from './db.ts';
import { resolveSecret } from '../secrets/infisical.ts';
import { sentryLoggerWarn } from './sentryRuntime.ts';

interface RowDelta {
  read: number;
  written: number;
}

/**
 * Per-isolate accumulator. Reused across invocations in the same isolate until
 * flushed; flushD1Budget() snapshots + resets it. Cross-invocation/cross-isolate
 * attribution is fuzzy by design — only the daily totals need to be roughly right.
 */
let pending: RowDelta = { read: 0, written: 0 };

/** Best-known day totals from the last flush, so the enforce check can usually
 *  answer without a KV round trip. */

/** Day we last emitted a soft-threshold warning for (once per isolate per day). */
let warnedDay: string | null = null;

/** Day we last emitted the HARD (100%) written-budget alert for. */
let hardWarnedDay: string | null = null;

// The production database is self-hosted SQLite on the Oracle host (migrated off
// Cloudflare D1 / Turso 2026-07-30), so per-row pricing no longer applies. These
// defaults are kept ONLY as an anomaly tripwire for runaway scans/backfills and
// are sized far above any legitimate daily volume so normal operation never
// trips them. Both Infisical-tunable (D1_DAILY_ROWS_READ_BUDGET /
// D1_DAILY_ROWS_WRITTEN_BUDGET) should a real dollar cap ever become relevant
// again.
const DEFAULT_READ_BUDGET = 5_000_000_000;
const DEFAULT_WRITTEN_BUDGET = 500_000_000;
const SOFT_RATIO = 0.8;
const DAY_TTL_SEC = 172_800; // 2 days, same as the FMP counter

function dayStr(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function dayKey(kind: 'read' | 'written', now: Date): string {
  return `d1:rows_${kind}:${dayStr(now)}`;
}

interface DayTotals {
  read: number;
  written: number;
}

function intVar(v: string | undefined, fallback: number): number {
  const n = parseInt((v ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function truthy(v: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((v ?? '').trim());
}

interface RowBudgets {
  read: number;
  written: number;
}

async function rowBudgets(env: Env): Promise<RowBudgets> {
  try {
    const [read, written] = await Promise.all([
      resolveSecret(env, 'D1_DAILY_ROWS_READ_BUDGET'),
      resolveSecret(env, 'D1_DAILY_ROWS_WRITTEN_BUDGET'),
    ]);
    return {
      read: intVar(read.value ?? env.D1_DAILY_ROWS_READ_BUDGET, DEFAULT_READ_BUDGET),
      written: intVar(written.value ?? env.D1_DAILY_ROWS_WRITTEN_BUDGET, DEFAULT_WRITTEN_BUDGET),
    };
  } catch {
    return {
      read: intVar(env.D1_DAILY_ROWS_READ_BUDGET, DEFAULT_READ_BUDGET),
      written: intVar(env.D1_DAILY_ROWS_WRITTEN_BUDGET, DEFAULT_WRITTEN_BUDGET),
    };
  }
}

/**
 * Record a D1 result's metered rows. Called on the hot path (every all/run/batch),
 * so it is synchronous, allocation-free, and never throws.
 */
export function recordD1Meta(
  meta: { rows_read?: number; rows_written?: number } | null | undefined,
): void {
  if (!meta) return;
  const r = meta.rows_read;
  const w = meta.rows_written;
  if (typeof r === 'number' && r > 0) pending.read += r;
  if (typeof w === 'number' && w > 0) pending.written += w;
}

/** Atomically add both dimensions in one D1 statement. Returns null only when
 * the binding/schema is unavailable, allowing the compatibility fallback. */
async function bumpD1Totals(env: Env, delta: RowDelta, now: Date): Promise<DayTotals | null> {
  const db = (env as Partial<Env>).DB;
  if (!db || typeof db.prepare !== 'function') return null;
  try {
    await db.prepare(
      `INSERT INTO d1_budget (day, rows_read, rows_written) VALUES (?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET
         rows_read = rows_read + excluded.rows_read,
         rows_written = rows_written + excluded.rows_written`,
    ).bind(dayStr(now), delta.read, delta.written).run();
    const row = await db
      .prepare('SELECT rows_read, rows_written FROM d1_budget WHERE day = ?')
      .bind(dayStr(now))
      .first<{ rows_read: number; rows_written: number }>();
    return {
      read: Number(row?.rows_read ?? 0),
      written: Number(row?.rows_written ?? 0),
    };
  } catch {
    return null;
  }
}

/** Compatibility path for isolates running before migration 0045 is applied. */
async function bumpKvTotals(env: Env, delta: RowDelta, now: Date): Promise<DayTotals> {
  const readKey = dayKey('read', now);
  const writtenKey = dayKey('written', now);
  const [read, written] = await Promise.all([env.CONFIG_KV.get(readKey), env.CONFIG_KV.get(writtenKey)]);
  const totals = {
    read: (parseInt(read ?? '0', 10) || 0) + delta.read,
    written: (parseInt(written ?? '0', 10) || 0) + delta.written,
  };
  await Promise.all([
    env.CONFIG_KV.put(readKey, String(totals.read), { expirationTtl: DAY_TTL_SEC }),
    env.CONFIG_KV.put(writtenKey, String(totals.written), { expirationTtl: DAY_TTL_SEC }),
  ]);
  return totals;
}

async function readD1Totals(env: Env, now: Date): Promise<DayTotals | null> {
  const db = (env as Partial<Env>).DB;
  if (!db || typeof db.prepare !== 'function') return null;
  try {
    const row = await db
      .prepare('SELECT rows_read, rows_written FROM d1_budget WHERE day = ?')
      .bind(dayStr(now))
      .first<{ rows_read: number; rows_written: number }>();
    return {
      read: Number(row?.rows_read ?? 0),
      written: Number(row?.rows_written ?? 0),
    };
  } catch {
    return null;
  }
}

function warnIfOverSoft(
  day: string,
  readTotal: number | null,
  writtenTotal: number | null,
  budgets: RowBudgets,
): void {
  const rB = budgets.read;
  const wB = budgets.written;
  const overRead = readTotal != null && readTotal >= rB * SOFT_RATIO;
  const overWritten = writtenTotal != null && writtenTotal >= wB * SOFT_RATIO;
  if (!overRead && !overWritten) return;
  // HARD alert (error severity, once per isolate per day) when the WRITE
  // dimension — the expensive one — has fully crossed 100% of budget. Distinct
  // from the 80% soft warning so operators can page on it specifically.
  if (writtenTotal != null && writtenTotal >= wB && hardWarnedDay !== day) {
    hardWarnedDay = day;
    const hardMsg = `D1 daily rows-written budget EXCEEDED: written ${writtenTotal}/${wB}`;
    console.error(hardMsg);
  }
  if (warnedDay === day) return; // at most once per isolate per day
  warnedDay = day;
  sentryLoggerWarn('d1.budget_soft', {
    read: readTotal ?? -1,
    readBudget: rB,
    written: writtenTotal ?? -1,
    writtenBudget: wB,
  });
}

/** CT-2459 flush throttle: at most one meter write per window (or per row
 *  threshold) per isolate. Previously every invocation with any metered
 *  rows did an INSERT+SELECT — a DB write per read request on the single
 *  libsql connection. Metering is approximate by design (see header), so
 *  delaying the flush loses nothing but freshness of the day counter. */
export const D1_BUDGET_FLUSH_INTERVAL_MS = 30_000;
export const D1_BUDGET_FLUSH_ROW_THRESHOLD = 10_000;
let lastBudgetFlushMs = 0;

/** Test hook: reset the flush throttle clock. */
export function resetD1BudgetFlushClockForTests(): void {
  lastBudgetFlushMs = 0;
}

/**
 * Flush the isolate's accumulated D1 row usage to today's atomic D1 counter, and warn
 * if the day's total crossed the soft threshold. Call once at an invocation tail
 * (via ctx.waitUntil). No-op when nothing is pending; fails open.
 */
export async function flushD1Budget(env: Env, now = new Date()): Promise<void> {
  // The flush marks an invocation tail, so the per-invocation write-governor
  // budget refreshes here regardless of whether any rows are pending.
  resetD1WriteGovernor();
  const snap = pending;
  if (snap.read === 0 && snap.written === 0) return;
  const nowMs = now.getTime();
  if (
    nowMs - lastBudgetFlushMs < D1_BUDGET_FLUSH_INTERVAL_MS &&
    snap.read + snap.written < D1_BUDGET_FLUSH_ROW_THRESHOLD
  ) {
    return; // keep accumulating; a later tail (or the threshold) flushes
  }
  lastBudgetFlushMs = nowMs;
  pending = { read: 0, written: 0 };
  try {
    const day = dayStr(now);
    // The atomic D1 counter update is itself one D1 row write. Include that
    // write in the D1 budget so read-only traffic cannot evade the write alarm
    // merely because its application queries reported rows_written = 0.
    const d1Delta = { read: snap.read, written: snap.written + 1 };
    const totals = (await bumpD1Totals(env, d1Delta, now)) ?? (await bumpKvTotals(env, snap, now));
    const { read: readTotal, written: writtenTotal } = totals;
    warnIfOverSoft(day, readTotal, writtenTotal, await rowBudgets(env));
  } catch {
    /* best-effort meter; never surface an error to the caller */
  }
}

async function enforceEnabled(env: Env): Promise<boolean> {
  try {
    const live = (await resolveSecret(env, 'D1_ROW_BUDGET_ENFORCE')).value ?? env.D1_ROW_BUDGET_ENFORCE;
    return truthy(live);
  } catch {
    return truthy(env.D1_ROW_BUDGET_ENFORCE);
  }
}

/**
 * True only when enforcement is armed (D1_ROW_BUDGET_ENFORCE truthy) AND today's
 * metered D1 rows read/written already exceeded the hard budget. Used by the
 * discretionary daily jobs to self-abort. Fails open (returns false) on any error.
 */
export async function isD1RowBudgetExceeded(env: Env, now = new Date()): Promise<boolean> {
  try {
    if (!(await enforceEnabled(env))) return false;
    // Flush local work first, then always read the shared counters. The
    await flushD1Budget(env, now);
    const totals = (await readD1Totals(env, now)) ?? {
      read: parseInt((await env.CONFIG_KV.get(dayKey('read', now))) ?? '0', 10) || 0,
      written: parseInt((await env.CONFIG_KV.get(dayKey('written', now))) ?? '0', 10) || 0,
    };
    const budgets = await rowBudgets(env);
    return totals.read >= budgets.read || totals.written >= budgets.written;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// GOVERNOR 2 — D1 write governor (owner mandate: "no more D1 write spikes").
//
// The daily meter above ALERTS; this section BOUNDS. Known storm writers
// (ingestion discovery upserts, DLQ receipt inserts, delivery-outbox flush
// fan-out, extraction_runs persistence) route their write work through a
// per-invocation soft cap so a runaway loop degrades to bounded batches with
// quarantine markers instead of unbounded row writes (the $1,153 backfill-loop
// incident class). The knobs are read from the immutable Worker env — like the
// usage-telemetry circuit limits — because they gate the hot write path and
// must be O(1) and always available even mid-incident:
//
//   D1_WRITE_OPS_PER_INVOCATION_CAP  governed write ops per invocation
//                                    (default 2000; resets at each
//                                    flushD1Budget invocation tail)
//   D1_WRITE_BATCH_CAP               statements per governed batch before
//                                    truncation + quarantine (default 200)
// ---------------------------------------------------------------------------

const DEFAULT_WRITE_OPS_PER_INVOCATION_CAP = 2_000;
const DEFAULT_WRITE_BATCH_CAP = 200;

/** Per-isolate governed write ops used since the last flushD1Budget reset. */
let governedWriteOps = 0;
/** Last time a governor-cap warning was emitted (rate-limited to 1/minute). */
let governorWarnedAtMs = 0;

function invocationWriteCap(env: Env): number {
  return intVar(env.D1_WRITE_OPS_PER_INVOCATION_CAP, DEFAULT_WRITE_OPS_PER_INVOCATION_CAP);
}

function writeBatchCap(env: Env): number {
  return intVar(env.D1_WRITE_BATCH_CAP, DEFAULT_WRITE_BATCH_CAP);
}

/** Refresh the per-invocation governed-write budget (called by flushD1Budget). */
export function resetD1WriteGovernor(): void {
  governedWriteOps = 0;
}

function warnGovernorCap(writer: string, requested: number, allowed: number, cap: number): void {
  const nowMs = Date.now();
  if (nowMs - governorWarnedAtMs < 60_000) return;
  governorWarnedAtMs = nowMs;
  sentryLoggerWarn('d1.governor_cap', {
    writer,
    requested,
    allowed,
    invocationCap: cap,
  });
}

/**
 * Consume up to `ops` governed write operations from the per-invocation
 * budget. Returns how many were granted (possibly 0). Synchronous and
 * allocation-free so single-row storm writers (DLQ receipts, extraction_runs)
 * can gate cheaply; callers skip/defer the write when the grant is 0.
 */
export function consumeGovernedD1Writes(env: Env, writer: string, ops: number): number {
  if (!(Number.isFinite(ops) && ops > 0)) return 0;
  const cap = invocationWriteCap(env);
  const remaining = Math.max(0, cap - governedWriteOps);
  const allowed = Math.min(Math.floor(ops), remaining);
  governedWriteOps += allowed;
  if (allowed < ops) warnGovernorCap(writer, Math.floor(ops), allowed, cap);
  return allowed;
}

export interface GovernedBatchResult {
  results: D1Result[];
  /** Statements actually executed (head of the input). */
  executed: number;
  /** Statements dropped by the governor; a quarantine marker records them. */
  quarantined: number;
}

/** Best-effort auditable marker for a truncated governed batch (1 row/event). */
async function writeQuarantineMarker(
  env: Env,
  writer: string,
  dropped: number,
  reason: string,
  now: Date,
): Promise<void> {
  const db = (env as Partial<Env>).DB;
  if (!db || typeof db.prepare !== 'function') return;
  try {
    await db
      .prepare(
        `INSERT INTO d1_write_quarantine (writer, day, dropped, reason, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(writer, dayStr(now), dropped, reason.slice(0, 300), now.toISOString())
      .run();
  } catch {
    /* pre-migration table or transient failure; the console/Sentry warn stands */
  }
}

/**
 * Execute a write batch under the governor. Batches within both the per-batch
 * cap and the remaining per-invocation budget run whole; oversized batches are
 * LOGGED, TRUNCATED to the allowed head, and the remainder is quarantined via
 * one marker row — never an unbounded write loop. Callers must treat the
 * dropped tail as deferred work (idempotent INSERT OR IGNORE / upsert
 * statements re-materialize on the next cycle).
 */
export async function governedD1Batch(
  env: Env,
  writer: string,
  statements: Array<[string, SqlParam[]]>,
  now = new Date(),
): Promise<GovernedBatchResult> {
  const db = env.DB;
  const allowed = Math.min(
    statements.length,
    writeBatchCap(env),
    Math.max(0, invocationWriteCap(env) - governedWriteOps),
  );
  governedWriteOps += allowed;
  const head = statements.slice(0, allowed);
  const dropped = statements.length - head.length;

  const prepared = head.map(([sql, params]) =>
    params.length ? db.prepare(sql).bind(...(params as unknown[])) : db.prepare(sql),
  );
  let results: D1Result[] = [];
  if (prepared.length > 0) {
    if (typeof db.batch === 'function') {
      results = await db.batch(prepared);
      for (const r of results ?? []) recordD1Meta(r?.meta);
    } else {
      for (const stmt of prepared) {
        const r = await stmt.run();
        recordD1Meta(r?.meta);
        results.push(r);
      }
    }
  }

  if (dropped > 0) {
    warnGovernorCap(writer, statements.length, head.length, invocationWriteCap(env));
    await writeQuarantineMarker(
      env,
      writer,
      dropped,
      `governed batch truncated: executed ${head.length} of ${statements.length}`,
      now,
    );
  }
  return { results, executed: head.length, quarantined: dropped };
}
