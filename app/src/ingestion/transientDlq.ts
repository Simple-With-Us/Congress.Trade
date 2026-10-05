/**
 * Bounded requeue for transient dead letters.  Poison payloads stay failed.
 *
 * Live 2026-08-14: 309 ingestion_outbox rows are `consumer retry budget
 * exhausted; received by ingest-dlq` (retryable).  Durable-queue poison
 * includes `invalid ingest queue message type: filing.local_wait_check`.
 */

import type { Env } from '../shared/types.ts';
import { all, run, type SqlParam } from '../shared/db.ts';
import { isTransientInfrastructureError } from '../shared/transientInfra.ts';
import type { DurableQueueName } from '../deno/durableQueue.ts';

export const TRANSIENT_DLQ_DEFAULT_LIMIT = 100;
export const TRANSIENT_DLQ_MAX_LIMIT = 500;
/** Matches ingestion/outbox.ts MAX_DEAD_LETTER_CYCLES.  Auto-retry stops here. */
export const AUTO_TRANSIENT_DLQ_MAX_CYCLES = 5;
/** Hourly autonomy sweep batch.  Smaller than the operator replay cap. */
export const AUTO_TRANSIENT_DLQ_LIMIT = 25;

export interface TransientDlqAutoOptions {
  /** Increment the cycle counter and back off.  Operator replay still resets it. */
  auto?: boolean;
}

export interface TransientDlqRequeueResult {
  ok: true;
  dryRun: boolean;
  scanned: number;
  matchedTransient: number;
  requeued: number;
  skippedPoison: number;
  skippedOther: number;
  skippedParked: number;
  skippedCapped: number;
}

export function clampTransientDlqLimit(raw: number | undefined): number {
  const value = Number(raw ?? TRANSIENT_DLQ_DEFAULT_LIMIT);
  if (!Number.isFinite(value)) return TRANSIENT_DLQ_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.floor(value), 1), TRANSIENT_DLQ_MAX_LIMIT);
}

/** Human-parked rows.  Never auto-replay. */
export function isParkedDlqError(message: string | null | undefined): boolean {
  return /^parked:/i.test((message ?? '').trim());
}

/** Permanent payload / config defects — do not replay. */
export function isPoisonDlqError(message: string | null | undefined): boolean {
  const m = (message ?? '').trim().toLowerCase();
  if (!m) return false;
  return (
    /invalid ingest queue message type/.test(m)
    || /invalid durable queue message/.test(m)
    || /invalid payload/.test(m)
    || /unknown message type/.test(m)
    || /malformed/.test(m)
    || /not valid json/.test(m)
    || /please enable r2/.test(m)
    || /sql read operations are forbidden/.test(m)
  );
}

/** Recoverable transport / rate-limit / session / circuit failures. */
export function isTransientDlqError(message: string | null | undefined): boolean {
  if (isPoisonDlqError(message) || isParkedDlqError(message)) return false;
  const m = (message ?? '').trim().toLowerCase();
  if (!m) return false;
  if (isTransientInfrastructureError(m)) return true;
  return (
    /retry budget exhausted/.test(m)
    || /received by ingest-dlq/.test(m)
    || /\b429\b/.test(m)
    || /too many requests/.test(m)
    || /rate[- ]?limit/.test(m)
    || /\b403\b/.test(m)
    || /unauthorized/.test(m)
    || /timed out/.test(m)
    || /timeout/.test(m)
    || /circuit is open/.test(m)
    || /circuit open/.test(m)
    || /network connection lost/.test(m)
    || /retry later/.test(m)
    || /ingest is busy/.test(m)
    || /sqlite_busy/.test(m)
    || /d1.?error/.test(m)
    || /overloaded/.test(m)
    || /database is locked/.test(m)
    || /sql statements in progress/.test(m)
  );
}

export type FailedOutboxClass = 'fresh' | 'parked' | 'retryable' | 'non_retryable';

/** Health classification.  Parked wins over the 24h fresh window, matching the SQL. */
export function classifyFailedOutboxRow(
  row: {
    last_error: string | null;
    dead_letter_cycles?: number | null;
    updated_at: string | null;
  },
  freshAfterIso: string,
): FailedOutboxClass {
  if (isParkedDlqError(row.last_error)) return 'parked';
  const updatedMs = row.updated_at ? Date.parse(row.updated_at) : NaN;
  const freshAfterMs = Date.parse(freshAfterIso);
  if (Number.isFinite(updatedMs) && Number.isFinite(freshAfterMs) && updatedMs >= freshAfterMs) {
    return 'fresh';
  }
  const cycles = Number(row.dead_letter_cycles ?? 0);
  if (isTransientDlqError(row.last_error) && cycles < AUTO_TRANSIENT_DLQ_MAX_CYCLES) {
    return 'retryable';
  }
  return 'non_retryable';
}

/** Same backoff as reconnectDeadLetteredIngestionOutbox: 30s, 60s, ... capped at 1h. */
export function transientDlqBackoffMs(cycles: number): number {
  return Math.min(3600, 30 * 2 ** Math.max(0, cycles)) * 1000;
}

function classifyScanned(lastError: string | null | undefined): 'transient' | 'poison' | 'other' {
  if (isPoisonDlqError(lastError)) return 'poison';
  if (isTransientDlqError(lastError)) return 'transient';
  return 'other';
}

function emptyResult(dryRun: boolean): TransientDlqRequeueResult {
  return {
    ok: true,
    dryRun,
    scanned: 0,
    matchedTransient: 0,
    requeued: 0,
    skippedPoison: 0,
    skippedOther: 0,
    skippedParked: 0,
    skippedCapped: 0,
  };
}

function tallyClasses(errors: Array<string | null | undefined>, limit: number): {
  transient: number;
  poison: number;
  other: number;
  scanned: number;
} {
  let transient = 0;
  let poison = 0;
  let other = 0;
  for (const error of errors) {
    const cls = classifyScanned(error);
    if (cls === 'transient') {
      if (transient < limit) transient += 1;
    } else if (cls === 'poison') poison += 1;
    else other += 1;
  }
  return { transient, poison, other, scanned: errors.length };
}

export async function requeueTransientFailedIngestionOutbox(
  env: Env,
  opts: { limit?: number; dryRun?: boolean; now?: Date } & TransientDlqAutoOptions = {},
): Promise<TransientDlqRequeueResult> {
  const limit = clampTransientDlqLimit(opts.limit);
  const dryRun = opts.dryRun === true;
  const auto = opts.auto === true;
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const scanLimit = Math.min(limit * 4, TRANSIENT_DLQ_MAX_LIMIT * 4);
  const rows = await all<{
    doc_id: string;
    last_error: string | null;
    dead_letter_cycles: number | null;
  }>(
    env.DB,
    `SELECT doc_id, last_error, dead_letter_cycles FROM ingestion_outbox
      WHERE status = 'failed'
      ORDER BY updated_at ${auto ? 'ASC' : 'DESC'}
      LIMIT ?`,
    [scanLimit],
  );
  const counts = tallyClasses(rows.map((row) => row.last_error), limit);
  const chosen: Array<{ docId: string; cycles: number }> = [];
  let skippedParked = 0;
  let skippedCapped = 0;
  for (const row of rows) {
    if (isParkedDlqError(row.last_error)) {
      skippedParked += 1;
      continue;
    }
    if (!isTransientDlqError(row.last_error)) continue;
    const cycles = Number(row.dead_letter_cycles ?? 0);
    if (auto && cycles >= AUTO_TRANSIENT_DLQ_MAX_CYCLES) {
      skippedCapped += 1;
      continue;
    }
    chosen.push({ docId: row.doc_id, cycles });
    if (chosen.length >= limit) break;
  }
  const base = {
    ...emptyResult(dryRun),
    scanned: counts.scanned,
    matchedTransient: chosen.length,
    skippedPoison: counts.poison,
    skippedOther: counts.other,
    skippedParked,
    skippedCapped,
  };
  if (dryRun || chosen.length === 0) return base;
  if (!auto) {
    const placeholders = chosen.map(() => '?').join(', ');
    const params: SqlParam[] = [nowIso, nowIso, ...chosen.map((row) => row.docId)];
    const updated = await run(
      env.DB,
      `UPDATE ingestion_outbox
          SET status = 'pending', attempts = 0, dead_letter_cycles = 0,
              available_at = ?, updated_at = ?
        WHERE status = 'failed' AND doc_id IN (${placeholders})`,
      params,
    );
    return { ...base, dryRun: false, requeued: updated.meta?.changes ?? 0 };
  }
  let requeued = 0;
  for (const row of chosen) {
    const availableAt = new Date(now.getTime() + transientDlqBackoffMs(row.cycles)).toISOString();
    const updated = await run(
      env.DB,
      `UPDATE ingestion_outbox
          SET status = 'pending', attempts = 0,
              dead_letter_cycles = dead_letter_cycles + 1,
              available_at = ?, updated_at = ?
        WHERE status = 'failed'
          AND doc_id = ?
          AND COALESCE(dead_letter_cycles, 0) < ?
          AND COALESCE(last_error, '') NOT LIKE 'parked:%'`,
      [availableAt, nowIso, row.docId, AUTO_TRANSIENT_DLQ_MAX_CYCLES],
    );
    requeued += updated.meta?.changes ?? 0;
  }
  return { ...base, dryRun: false, requeued };
}

export async function requeueTransientFailedDurableJobs(
  env: Env,
  opts: { queue?: DurableQueueName; limit?: number; dryRun?: boolean; now?: Date } & TransientDlqAutoOptions = {},
): Promise<TransientDlqRequeueResult & { queue: DurableQueueName }> {
  const queue = opts.queue ?? 'ingest';
  const limit = clampTransientDlqLimit(opts.limit);
  const dryRun = opts.dryRun === true;
  const auto = opts.auto === true;
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const scanLimit = Math.min(limit * 4, TRANSIENT_DLQ_MAX_LIMIT * 4);
  const rows = await all<{
    id: number;
    last_error: string | null;
    dedupe_key: string | null;
    dead_letter_cycles: number | null;
  }>(
    env.DB,
    `SELECT id, last_error, dedupe_key, dead_letter_cycles FROM deno_runtime_queue
      WHERE queue_name = ? AND status = 'failed'
      ORDER BY id ${auto ? 'ASC' : 'DESC'}
      LIMIT ?`,
    [queue, scanLimit],
  );
  const counts = tallyClasses(rows.map((row) => row.last_error), Number.POSITIVE_INFINITY);
  const chosen: Array<{ id: number; cycles: number }> = [];
  const seenDedupe = new Set<string>();
  let skippedParked = 0;
  let skippedCapped = 0;
  for (const row of rows) {
    if (isParkedDlqError(row.last_error)) {
      skippedParked += 1;
      continue;
    }
    if (!isTransientDlqError(row.last_error)) continue;
    const cycles = Number(row.dead_letter_cycles ?? 0);
    if (auto && cycles >= AUTO_TRANSIENT_DLQ_MAX_CYCLES) {
      skippedCapped += 1;
      continue;
    }
    if (row.dedupe_key) {
      if (seenDedupe.has(row.dedupe_key)) continue;
      seenDedupe.add(row.dedupe_key);
    }
    chosen.push({ id: Number(row.id), cycles });
    if (chosen.length >= limit) break;
  }
  const base = {
    ...emptyResult(dryRun),
    queue,
    scanned: counts.scanned,
    matchedTransient: chosen.length,
    skippedPoison: counts.poison,
    skippedOther: counts.other,
    skippedParked,
    skippedCapped,
  };
  if (dryRun || chosen.length === 0) return base;
  if (!auto) {
    const placeholders = chosen.map(() => '?').join(', ');
    const updated = await run(
      env.DB,
      `UPDATE deno_runtime_queue
          SET status = 'pending', attempts = 0, last_error = NULL,
              lease_until = NULL, lease_token = NULL, dead_letter_pending = 0,
              dead_letter_cycles = 0, available_at = ?, updated_at = ?
        WHERE status = 'failed'
          AND id IN (${placeholders})
          AND (
            dedupe_key IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM deno_runtime_queue a
               WHERE a.queue_name = deno_runtime_queue.queue_name
                 AND a.dedupe_key = deno_runtime_queue.dedupe_key
                 AND a.status IN ('pending', 'processing')
            )
          )`,
      [nowIso, nowIso, ...chosen.map((row) => row.id)],
    );
    const requeued = updated.meta?.changes ?? 0;
    return {
      ...base,
      dryRun: false,
      requeued,
      skippedOther: counts.other + Math.max(0, chosen.length - requeued),
    };
  }
  let requeued = 0;
  for (const row of chosen) {
    const availableAt = new Date(now.getTime() + transientDlqBackoffMs(row.cycles)).toISOString();
    const updated = await run(
      env.DB,
      `UPDATE deno_runtime_queue
          SET status = 'pending', attempts = 0,
              lease_until = NULL, lease_token = NULL, dead_letter_pending = 0,
              dead_letter_cycles = dead_letter_cycles + 1,
              available_at = ?, updated_at = ?
        WHERE status = 'failed'
          AND id = ?
          AND COALESCE(dead_letter_cycles, 0) < ?
          AND COALESCE(last_error, '') NOT LIKE 'parked:%'
          AND (
            dedupe_key IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM deno_runtime_queue a
               WHERE a.queue_name = deno_runtime_queue.queue_name
                 AND a.dedupe_key = deno_runtime_queue.dedupe_key
                 AND a.status IN ('pending', 'processing')
            )
          )`,
      [availableAt, nowIso, row.id, AUTO_TRANSIENT_DLQ_MAX_CYCLES],
    );
    requeued += updated.meta?.changes ?? 0;
  }
  return {
    ...base,
    dryRun: false,
    requeued,
    skippedOther: counts.other + Math.max(0, chosen.length - requeued),
  };
}

export interface TransientDlqSweepResult {
  ingestion: TransientDlqRequeueResult;
  ingestQueue: TransientDlqRequeueResult & { queue: DurableQueueName };
  deliveryQueue: TransientDlqRequeueResult & { queue: DurableQueueName };
}

/** Hourly self-heal.  Parked, poison, and cycle-capped rows stay failed. */
export async function sweepTransientDeadLetters(
  env: Env,
  now = new Date(),
): Promise<TransientDlqSweepResult> {
  const ingestion = await requeueTransientFailedIngestionOutbox(env, {
    auto: true,
    limit: AUTO_TRANSIENT_DLQ_LIMIT,
    now,
  });
  const ingestQueue = await requeueTransientFailedDurableJobs(env, {
    queue: 'ingest',
    auto: true,
    limit: AUTO_TRANSIENT_DLQ_LIMIT,
    now,
  });
  const deliveryQueue = await requeueTransientFailedDurableJobs(env, {
    queue: 'delivery',
    auto: true,
    limit: AUTO_TRANSIENT_DLQ_LIMIT,
    now,
  });
  return { ingestion, ingestQueue, deliveryQueue };
}
