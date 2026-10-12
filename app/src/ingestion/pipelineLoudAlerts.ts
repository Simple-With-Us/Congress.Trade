/**
 * Loud pipeline alerting: terminal ingest/extract failures and stall detectors.
 *
 * Wakes Publisher / BF-Publisher via the same signed review_queue webhook path,
 * and captures Sentry errors.  Deduped per condition in CONFIG_KV.
 */

import type { Env } from '../shared/types.ts';
import type { QueueMessage } from '../shared/types.ts';
import { get } from '../shared/db.ts';
import { isParkedDlqError } from './transientDlq.ts';
import { notifyReviewQueuePublisher } from './reviewQueueNotify.ts';
import { captureException, captureMessage } from '../deno/sentry.ts';

export const PIPELINE_LOUD_ALERT_KV_PREFIX = 'pipeline-loud-alert:';
export const DEFAULT_PIPELINE_STALL_HOURS = 6;
/** Re-alert the same doc+stage after this window if it fails terminally again. */
export const TERMINAL_REDUP_WINDOW_MS = 7 * 24 * 3_600_000;

export type PipelineTerminalStage = 'ingest' | 'extract';

export interface PipelineStallAlertResult {
  evaluated: string[];
  alerted: string[];
}

interface DedupeEpisode {
  notifiedAt: string;
}

function envGet(key: string): string | undefined {
  try {
    return (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env.get(key);
  } catch {
    return undefined;
  }
}

export function readPipelineStallHours(env: Env): number {
  const fromEnv = envGet('CT_PIPELINE_STALL_HOURS');
  const n = Number.parseInt(fromEnv ?? '', 10);
  if (Number.isFinite(n) && n >= 1) return Math.min(n, 168);
  const legacy = Number.parseInt(envGet('CT_OCR_STALL_HOURS') ?? '', 10);
  if (Number.isFinite(legacy) && legacy >= 1) return Math.min(legacy, 168);
  return DEFAULT_PIPELINE_STALL_HOURS;
}

function stallWindowMs(hours: number): number {
  return hours * 3_600_000;
}

async function readEpisode(env: Env, kvKey: string): Promise<DedupeEpisode | null> {
  try {
    return await env.CONFIG_KV.get<DedupeEpisode>(kvKey, 'json');
  } catch {
    return null;
  }
}

async function shouldRenotify(
  env: Env,
  kvKey: string,
  windowMs: number,
  now: Date,
): Promise<boolean> {
  const episode = await readEpisode(env, kvKey);
  if (!episode) return true;
  const at = Date.parse(episode.notifiedAt);
  if (!Number.isFinite(at)) return true;
  return now.getTime() - at >= windowMs;
}

async function markNotified(env: Env, kvKey: string, now: Date): Promise<void> {
  try {
    await env.CONFIG_KV.put(
      kvKey,
      JSON.stringify({ notifiedAt: now.toISOString() } satisfies DedupeEpisode),
    );
  } catch {
    /* best-effort */
  }
}

function terminalIngestReason(stage: PipelineTerminalStage, lastError: string): string {
  const prefix = stage === 'extract' ? 'terminal_extract_failed' : 'terminal_ingest_failed';
  const detail = lastError.trim().slice(0, 400);
  return detail ? `${prefix}: ${detail}` : prefix;
}

/**
 * Terminal non-retryable ingest (outbox) or extract (durable queue) failure.
 * Deduped per doc_id per stage for TERMINAL_REDUP_WINDOW_MS (KV pre-claim before side effects).
 */
export async function alertPipelineTerminalFailure(
  env: Env,
  input: {
    docId: string;
    stage: PipelineTerminalStage;
    lastError: string;
    at?: string;
  },
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const docId = input.docId?.trim();
  if (!docId) return;
  const lastError = input.lastError?.trim() ?? '';
  if (isParkedDlqError(lastError)) return;

  const now = new Date(input.at ?? Date.now());
  const kvKey = `${PIPELINE_LOUD_ALERT_KV_PREFIX}terminal:${input.stage}:${docId}`;
  if (!(await shouldRenotify(env, kvKey, TERMINAL_REDUP_WINDOW_MS, now))) return;

  await markNotified(env, kvKey, now);

  const at = now.toISOString();
  const reason = terminalIngestReason(input.stage, lastError);

  const err = new Error(`Pipeline terminal ${input.stage} failure for ${docId}: ${lastError.slice(0, 500)}`);
  try {
    captureException(err, {
      tags: { pipeline_alert: 'terminal_failed', stage: input.stage },
      extra: { docId, lastError: lastError.slice(0, 1000) },
    });
  } catch {
    captureMessage(`Pipeline terminal ${input.stage} failure: ${docId}`, 'error');
  }

  await notifyReviewQueuePublisher(
    env,
    { docId, reason, kind: 'insert', at },
    deps,
  );
}

/** After ingestion_outbox is stamped failed (dead-letter budget exhausted). */
export async function maybeAlertTerminalIngestionOutbox(
  env: Env,
  docId: string,
  lastError: string,
  now = new Date(),
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<void> {
  await alertPipelineTerminalFailure(
    env,
    { docId, stage: 'ingest', lastError, at: now.toISOString() },
    deps,
  );
}

/** After deno_runtime_queue ingest row is terminally failed. */
export async function maybeAlertTerminalDurableIngestFailure(
  env: Env,
  message: QueueMessage,
  lastError: string,
  now = new Date(),
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<void> {
  if (!('docId' in message) || !message.docId) return;
  const stage: PipelineTerminalStage =
    message.type === 'filing.extracted' ? 'extract' : 'ingest';
  if (isParkedDlqError(lastError)) return;
  await alertPipelineTerminalFailure(
    env,
    { docId: message.docId, stage, lastError, at: now.toISOString() },
    deps,
  );
}

async function countScannedReaderBacklog(env: Env): Promise<{ pending: number; failed: number }> {
  let pending = 0;
  let failed = 0;
  try {
    const row = await get<{ n: number }>(
      env.DB,
      `SELECT COUNT(*) AS n
         FROM filings f
        WHERE ${SCANNED_READER_BACKLOG_WHERE}`,
    );
    pending = Number(row?.n ?? 0);
  } catch {
    pending = 0;
  }

  try {
    const row = await get<{ n: number }>(
      env.DB,
      `SELECT COUNT(*) AS n
         FROM ingestion_outbox o
         JOIN filings f ON f.doc_id = o.doc_id
        WHERE o.status = 'failed'
          AND f.doc_kind = 'scanned_pdf'
          AND COALESCE(o.last_error, '') NOT LIKE 'parked:%'`,
    );
    failed = Number(row?.n ?? 0);
  } catch {
    failed = 0;
  }

  return { pending, failed };
}

const SCANNED_READER_BACKLOG_WHERE = `
          f.doc_kind = 'scanned_pdf'
          AND f.raw_object_key IS NOT NULL
          AND TRIM(f.raw_object_key) != ''
          AND (
            f.ingest_status IN ('extraction_pending_local', 'classified', 'error')
            OR (
              f.ingest_status = 'needs_review'
              AND EXISTS (
                SELECT 1 FROM review_queue rq
                 WHERE rq.doc_id = f.doc_id AND rq.resolved = 0
              )
            )
          )
          AND (f.error IS NULL OR f.error NOT LIKE 'local_vision_exhausted%')
          AND NOT EXISTS (
            SELECT 1 FROM review_queue rq
             WHERE rq.doc_id = f.doc_id AND rq.resolved = 0
               AND rq.reason LIKE '%local_vision_exhausted%'
          )
          AND NOT EXISTS (
            SELECT 1 FROM review_queue rq
             WHERE rq.doc_id = f.doc_id AND rq.resolved = 1
          )
          AND NOT EXISTS (
            SELECT 1 FROM review_queue rq
             WHERE rq.doc_id = f.doc_id AND rq.reason LIKE '%local_vision_submitted%'
          )
          AND NOT EXISTS (
            SELECT 1 FROM transactions tx
             WHERE tx.doc_id = f.doc_id AND tx.deprecated_at IS NULL
          )`;

async function pickOcrStallWakeDocId(env: Env): Promise<string | null> {
  try {
    const row = await get<{ doc_id: string }>(
      env.DB,
      `SELECT f.doc_id AS doc_id
         FROM filings f
        WHERE ${SCANNED_READER_BACKLOG_WHERE}
        ORDER BY f.updated_at ASC
        LIMIT 1`,
    );
    const id = row?.doc_id?.trim();
    return id || null;
  } catch {
    return null;
  }
}

async function lastOcrScanAttemptAt(env: Env): Promise<string | null> {
  try {
    const row = await get<{ last_at: string | null }>(
      env.DB,
      `SELECT MAX(created_at) AS last_at
         FROM ingestion_decisions
        WHERE source IN ('server_cpu', 'local_mac')`,
    );
    return row?.last_at ?? null;
  } catch {
    return null;
  }
}

async function lastSenateFetchSuccessAt(env: Env): Promise<string | null> {
  try {
    const row = await get<{ last_success: string | null }>(
      env.DB,
      `SELECT MAX(CASE WHEN outcome = 'success' THEN attempted_at END) AS last_success
         FROM source_attempts
        WHERE source = 'senate'`,
    );
    return row?.last_success ?? null;
  } catch {
    return null;
  }
}

async function emitStallAlert(
  env: Env,
  condition: string,
  detail: string,
  now: Date,
  windowMs: number,
  opts: { wakeDocId?: string | null } = {},
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
  const kvKey = `${PIPELINE_LOUD_ALERT_KV_PREFIX}stall:${condition}`;
  if (!(await shouldRenotify(env, kvKey, windowMs, now))) return false;

  await markNotified(env, kvKey, now);

  try {
    captureMessage(`Pipeline stall: ${condition} — ${detail}`, 'error');
  } catch {
    /* fail-soft */
  }

  const wakeDocId = opts.wakeDocId?.trim();
  if (wakeDocId) {
    await notifyReviewQueuePublisher(
      env,
      {
        docId: wakeDocId,
        reason: `pipeline_stall:${condition}: ${detail}`.slice(0, 500),
        kind: 'insert',
        at: now.toISOString(),
      },
      deps,
    );
  }

  return true;
}

/**
 * Stall detector: OCR/scan-reader idle with backlog; Senate fetch success stale.
 * Runs on the hourly autonomy sweep (deduped per condition per window).
 */
export async function sweepPipelineStallAlerts(
  env: Env,
  now = new Date(),
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<PipelineStallAlertResult> {
  const result: PipelineStallAlertResult = { evaluated: [], alerted: [] };
  const stallHours = readPipelineStallHours(env);
  const windowMs = stallWindowMs(stallHours);
  const thresholdMs = windowMs;

  // --- OCR / scan-reader ---
  result.evaluated.push('ocr_scan_reader');
  const backlog = await countScannedReaderBacklog(env);
  const workUnits = backlog.pending + backlog.failed;
  const lastOcr = await lastOcrScanAttemptAt(env);
  const lastOcrMs = lastOcr ? Date.parse(lastOcr) : NaN;
  const ocrIdle =
    !Number.isFinite(lastOcrMs) || now.getTime() - lastOcrMs >= thresholdMs;
  if (workUnits > 0 && ocrIdle) {
    const hoursIdle = Number.isFinite(lastOcrMs)
      ? ((now.getTime() - lastOcrMs) / 3_600_000).toFixed(1)
      : 'never';
    const detail =
      `${workUnits} scanned PDF(s) pending or failed ingest ` +
      `(pending=${backlog.pending}, failed=${backlog.failed}); ` +
      `no OCR/scan-reader submission in ${hoursIdle}h (threshold ${stallHours}h)`;
    const wakeDocId = await pickOcrStallWakeDocId(env);
    if (
      await emitStallAlert(env, 'ocr_scan_reader', detail, now, windowMs, { wakeDocId }, deps)
    ) {
      result.alerted.push('ocr_scan_reader');
    }
  }

  // --- Senate fetch success ---
  result.evaluated.push('senate_fetch_success');
  const lastSenate = await lastSenateFetchSuccessAt(env);
  const lastSenateMs = lastSenate ? Date.parse(lastSenate) : NaN;
  const senateStale =
    !Number.isFinite(lastSenateMs) || now.getTime() - lastSenateMs >= thresholdMs;
  if (senateStale) {
    const hoursStale = Number.isFinite(lastSenateMs)
      ? ((now.getTime() - lastSenateMs) / 3_600_000).toFixed(1)
      : 'never';
    const detail =
      `No successful Senate fetch in ${hoursStale}h (threshold ${stallHours}h); ` +
      `check residential proxy / eFD egress`;
    if (await emitStallAlert(env, 'senate_fetch_success', detail, now, windowMs, {}, deps)) {
      result.alerted.push('senate_fetch_success');
    }
  }

  return result;
}
