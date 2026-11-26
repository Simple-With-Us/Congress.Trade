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
import {
  FETCH_NOT_PUBLISHED_WINDOW_MS,
  NOT_YET_PUBLISHED_MARKER,
} from './fetcher.ts';
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
  /** Subset of `requeued` re-armed on the not-yet-published slow cadence. */
  slowRetried: number;
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
    || m.includes(NOT_YET_PUBLISHED_MARKER)
  );
}

/**
 * The not-yet-published class: the source index listed the filing before
 * its PDF was posted, so every fetch 404s (fetcher.ts stamps the marker).
 * This is not a defect in the filing or the payload — the document simply
 * does not exist yet, and the fetcher already treats the 404 as retryable
 * for FETCH_NOT_PUBLISHED_WINDOW_MS after first sight.
 */
export function isNotYetPublishedDlqError(message: string | null | undefined): boolean {
  if (isPoisonDlqError(message) || isParkedDlqError(message)) return false;
  const m = (message ?? '').trim().toLowerCase();
  if (!m) return false;
  return m.includes(NOT_YET_PUBLISHED_MARKER);
}

/** Same window rule the fetcher applies to a 404 (strictly inside). */
export function isWithinNotPublishedWindow(
  firstSeenAt: string | null | undefined,
  now: Date,
): boolean {
  const seen = firstSeenAt ? Date.parse(firstSeenAt) : NaN;
  return Number.isFinite(seen) && now.getTime() - seen < FETCH_NOT_PUBLISHED_WINDOW_MS;
}

/**
 * Slow-retry cadence for the not-yet-published class once the fast retry
 * budget is spent (owner directive 2026-11-25: after the initial set of
 * failures, keep looking for the PDF every 2–6 hours).  4h sits mid-band;
 * the hourly sweep's phase adds under an hour, so the effective spacing
 * stays inside 2–6h.  Slow retries do not consume the dead-letter cycle
 * budget — the fetcher's 7-day not-published window is the bound, and
 * once it closes the row falls back to the normal capped behavior.
 */
export const NOT_YET_PUBLISHED_SLOW_RETRY_MS = 4 * 60 * 60 * 1000;

interface FilingFetchFacts {
  error: string | null;
  firstSeenAt: string | null;
}

async function loadFilingFetchFacts(
  env: Env,
  docIds: string[],
): Promise<Map<string, FilingFetchFacts>> {
  const facts = new Map<string, FilingFetchFacts>();
  const unique = Array.from(new Set(docIds.filter(Boolean)));
  if (unique.length === 0) return facts;
  const placeholders = unique.map(() => '?').join(', ');
  const rows = await all<{ doc_id: string; error: string | null; first_seen_at: string | null }>(
    env.DB,
    `SELECT doc_id, error, first_seen_at FROM filings WHERE doc_id IN (${placeholders})`,
    unique,
  );
  for (const row of rows) {
    facts.set(row.doc_id, { error: row.error, firstSeenAt: row.first_seen_at });
  }
  return facts;
}

function docIdFromQueuePayload(payload: string | null | undefined): string | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as { docId?: unknown };
    return typeof parsed.docId === 'string' && parsed.docId ? parsed.docId : null;
  } catch {
    return null;
  }
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
    slowRetried: 0,
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
  const cappedCandidates: Array<{ docId: string }> = [];
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
      cappedCandidates.push({ docId: row.doc_id });
      continue;
    }
    chosen.push({ docId: row.doc_id, cycles });
    if (chosen.length >= limit) break;
  }
  // Cycle-capped rows get one class check before they are written off:
  // a filing whose last fetch error is the not-yet-published marker and
  // that is still inside the fetcher's window is not exhausted — it is
  // waiting on the source.  The outbox row's own last_error is the generic
  // budget message, so the class evidence lives on the filings row.
  const slowChosen: Array<{ docId: string }> = [];
  if (auto && cappedCandidates.length > 0) {
    const facts = await loadFilingFetchFacts(env, cappedCandidates.map((row) => row.docId));
    for (const candidate of cappedCandidates) {
      const fact = facts.get(candidate.docId);
      if (
        fact
        && isNotYetPublishedDlqError(fact.error)
        && isWithinNotPublishedWindow(fact.firstSeenAt, now)
        && chosen.length + slowChosen.length < limit
      ) {
        slowChosen.push(candidate);
      } else {
        skippedCapped += 1;
      }
    }
  } else {
    skippedCapped += cappedCandidates.length;
  }
  const base = {
    ...emptyResult(dryRun),
    scanned: counts.scanned,
    matchedTransient: chosen.length + slowChosen.length,
    skippedPoison: counts.poison,
    skippedOther: counts.other,
    skippedParked,
    skippedCapped,
  };
  if (dryRun || (chosen.length === 0 && slowChosen.length === 0)) return base;
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
  // Slow cadence for the not-yet-published class: re-arm at +4h WITHOUT
  // consuming or resetting the dead-letter cycle budget.  If the window
  // closes first, the row is exactly as capped as it was and the normal
  // terminal behavior resumes on the next sweep.
  let slowRetried = 0;
  for (const row of slowChosen) {
    const availableAt = new Date(now.getTime() + NOT_YET_PUBLISHED_SLOW_RETRY_MS).toISOString();
    const updated = await run(
      env.DB,
      `UPDATE ingestion_outbox
          SET status = 'pending', attempts = 0,
              available_at = ?, updated_at = ?
        WHERE status = 'failed'
          AND doc_id = ?
          AND COALESCE(last_error, '') NOT LIKE 'parked:%'`,
      [availableAt, nowIso, row.docId],
    );
    slowRetried += updated.meta?.changes ?? 0;
  }
  return { ...base, dryRun: false, requeued: requeued + slowRetried, slowRetried };
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
    payload: string | null;
  }>(
    env.DB,
    `SELECT id, last_error, dedupe_key, dead_letter_cycles, payload FROM deno_runtime_queue
      WHERE queue_name = ? AND status = 'failed'
      ORDER BY id ${auto ? 'ASC' : 'DESC'}
      LIMIT ?`,
    [queue, scanLimit],
  );
  const counts = tallyClasses(rows.map((row) => row.last_error), Number.POSITIVE_INFINITY);
  const chosen: Array<{ id: number; cycles: number }> = [];
  const cappedClassCandidates: Array<{ id: number; dedupeKey: string | null; docId: string }> = [];
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
      // A capped row whose own error is the not-yet-published marker is a
      // slow-retry candidate (window check below); every other capped row
      // stays capped exactly as before.
      const docId = isNotYetPublishedDlqError(row.last_error)
        ? docIdFromQueuePayload(row.payload)
        : null;
      if (docId) {
        cappedClassCandidates.push({ id: Number(row.id), dedupeKey: row.dedupe_key ?? null, docId });
      } else {
        skippedCapped += 1;
      }
      continue;
    }
    if (row.dedupe_key) {
      if (seenDedupe.has(row.dedupe_key)) continue;
      seenDedupe.add(row.dedupe_key);
    }
    chosen.push({ id: Number(row.id), cycles });
    if (chosen.length >= limit) break;
  }
  const slowChosen: Array<{ id: number }> = [];
  if (auto && cappedClassCandidates.length > 0) {
    const facts = await loadFilingFetchFacts(env, cappedClassCandidates.map((row) => row.docId));
    for (const candidate of cappedClassCandidates) {
      const fact = facts.get(candidate.docId);
      if (!fact || !isWithinNotPublishedWindow(fact.firstSeenAt, now)) {
        skippedCapped += 1;
        continue;
      }
      if (candidate.dedupeKey) {
        if (seenDedupe.has(candidate.dedupeKey)) continue;
        seenDedupe.add(candidate.dedupeKey);
      }
      slowChosen.push({ id: candidate.id });
      if (chosen.length + slowChosen.length >= limit) break;
    }
  }
  const base = {
    ...emptyResult(dryRun),
    queue,
    scanned: counts.scanned,
    matchedTransient: chosen.length + slowChosen.length,
    skippedPoison: counts.poison,
    skippedOther: counts.other,
    skippedParked,
    skippedCapped,
  };
  if (dryRun || (chosen.length === 0 && slowChosen.length === 0)) return base;
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
  // Slow cadence for the not-yet-published class: re-arm at +4h WITHOUT
  // consuming or resetting the dead-letter cycle budget (same rule as the
  // outbox path above).  The dedupe guard mirrors the normal auto path.
  let slowRetried = 0;
  for (const row of slowChosen) {
    const availableAt = new Date(now.getTime() + NOT_YET_PUBLISHED_SLOW_RETRY_MS).toISOString();
    const updated = await run(
      env.DB,
      `UPDATE deno_runtime_queue
          SET status = 'pending', attempts = 0,
              lease_until = NULL, lease_token = NULL, dead_letter_pending = 0,
              available_at = ?, updated_at = ?
        WHERE status = 'failed'
          AND id = ?
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
      [availableAt, nowIso, row.id],
    );
    slowRetried += updated.meta?.changes ?? 0;
  }
  const totalChosen = chosen.length + slowChosen.length;
  const totalRequeued = requeued + slowRetried;
  return {
    ...base,
    dryRun: false,
    requeued: totalRequeued,
    slowRetried,
    skippedOther: counts.other + Math.max(0, totalChosen - totalRequeued),
  };
}

export interface TransientDlqSweepResult {
  ingestion: TransientDlqRequeueResult;
  ingestQueue: TransientDlqRequeueResult & { queue: DurableQueueName };
  deliveryQueue: TransientDlqRequeueResult & { queue: DurableQueueName };
}

/**
 * Hourly self-heal.  Parked, poison, and cycle-capped rows stay failed —
 * with one exception: cycle-capped rows in the not-yet-published class
 * (source PDF not posted yet) re-arm on the slow 4h cadence while the
 * filing is inside the fetcher's not-published window.
 */
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
