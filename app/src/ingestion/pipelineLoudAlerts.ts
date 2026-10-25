/**
 * Loud pipeline alerting: terminal ingest/extract failures and stall detectors.
 *
 * Wakes GB Publisher + BF-Publisher via signed publisher webhook(s), and
 * captures Sentry errors.  Deduped per condition in CONFIG_KV with recovery
 * notices when a stall clears.
 */

import type { Env } from '../shared/types.ts';
import type { QueueMessage } from '../shared/types.ts';
import { all, get } from '../shared/db.ts';
import { getLastPollAt } from '../shared/config.ts';
import { isParkedDlqError } from './transientDlq.ts';
import {
  notifyPipelineStallPublisher,
  notifyReviewQueuePublisher,
} from './reviewQueueNotify.ts';
import { captureException, captureMessage } from '../deno/sentry.ts';
import { ogeWatchEnabled } from './ogeSource.ts';
import {
  enrichmentNeededSql,
  enrichmentProgressTimestampSql,
  hasConfiguredKeyedEnrichmentProvider,
  securitiesRefHasEnrichmentUnavailableColumns,
} from '../enrichment/service.ts';
import { excludeCompetitorFixtureTransactionSql } from '../shared/competitorFixtures.ts';
import { evaluateStPeerPricesStall } from '../prices/stPeerPricesHealth.ts';
import {
  evaluateFreshness,
  FRESHNESS_LATEST_SQL,
  FRESHNESS_MAX_AGE_DAYS,
  type FreshnessSnapshot,
  type FreshnessStream,
} from '../share/freshness.ts';
import { resolveSecrets } from '../secrets/infisical.ts';
import { checkTargetCircuit, targetKeyForUrl } from '../delivery/targetCircuit.ts';
import { checkPipelineHealth, collectEmptyFetchHandoffCheck } from '../shared/pipelineHealth.ts';

import {
  DEFAULT_PIPELINE_STALL_HOURS,
  DEFAULT_ST_PEER_ENRICHMENT_STALL_HOURS,
  readPipelineStallHours,
  stallWindowMs,
} from './pipelineStallConfig.ts';

export {
  DEFAULT_PIPELINE_STALL_HOURS,
  DEFAULT_ST_PEER_ENRICHMENT_STALL_HOURS,
  readPipelineStallHours,
} from './pipelineStallConfig.ts';

export const PIPELINE_LOUD_ALERT_KV_PREFIX = 'pipeline-loud-alert:';
/** Re-alert the same doc+stage after this window if it fails terminally again. */
export const TERMINAL_REDUP_WINDOW_MS = 7 * 24 * 3_600_000;

export type PipelineStallCondition =
  | 'house_fetch_success'
  | 'senate_fetch_success'
  | 'executive_fetch_success'
  | 'ocr_scan_reader'
  | 'st_peer_enrichment'
  | 'st_peer_prices'
  | 'st_inbound_market_data'
  | 'st_outbound_share_push'
  /**
   * Filing outside IngestStatus, or a completed fetch hand-off with no raw
   * object. Same id as the `/api/health` check. Listed in
   * HEALTH_STALL_SKIP_IDS so the generic health loop does not open a second
   * `health_empty_fetch_handoff` episode.
   */
  | 'empty_fetch_handoff'
  /** `/api/health` check ids (ingest outbox, extract, delivery, probes, …). */
  | `health_${string}`;

/** Chamber poll checks are covered by explicit `*_fetch_success` stall detectors. */
const HEALTH_STALL_SKIP_IDS = new Set([
  'polling_house',
  'polling_senate',
  'polling_executive',
  // Evaluated by the dedicated st_peer_prices condition above (same rules via
  // evaluateStPeerPricesStall).  Without this skip the generic loop raises a
  // second health_st_peer_prices episode, so every stall and recovery pages twice.
  'st_peer_prices',
  // Same id as the dedicated empty_fetch_handoff condition and the health check.
  'empty_fetch_handoff',
]);

export interface PipelineStallAlertResult {
  evaluated: string[];
  alerted: string[];
  recovered: string[];
}

interface DedupeEpisode {
  notifiedAt: string;
}

interface StallEpisode extends DedupeEpisode {
  active: boolean;
}

async function readEpisode(env: Env, kvKey: string): Promise<DedupeEpisode | null> {
  try {
    return await env.CONFIG_KV.get<DedupeEpisode>(kvKey, 'json');
  } catch {
    return null;
  }
}

async function readStallEpisode(env: Env, kvKey: string): Promise<StallEpisode | null> {
  try {
    return await env.CONFIG_KV.get<StallEpisode>(kvKey, 'json');
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

async function markStallActive(env: Env, kvKey: string, now: Date): Promise<void> {
  try {
    await env.CONFIG_KV.put(
      kvKey,
      JSON.stringify({ notifiedAt: now.toISOString(), active: true } satisfies StallEpisode),
    );
  } catch {
    /* best-effort */
  }
}

async function clearStallEpisode(env: Env, kvKey: string): Promise<void> {
  try {
    await env.CONFIG_KV.delete(kvKey);
  } catch {
    /* best-effort */
  }
}

function terminalIngestReason(stage: PipelineTerminalStage, lastError: string): string {
  const prefix = stage === 'extract' ? 'terminal_extract_failed' : 'terminal_ingest_failed';
  const detail = lastError.trim().slice(0, 400);
  return detail ? `${prefix}: ${detail}` : prefix;
}

export type PipelineTerminalStage = 'ingest' | 'extract';

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

async function lastSourceFetchSuccessAt(
  env: Env,
  source: 'house' | 'senate' | 'executive',
): Promise<string | null> {
  try {
    const row = await get<{ last_success: string | null }>(
      env.DB,
      `SELECT MAX(CASE WHEN outcome = 'success' THEN attempted_at END) AS last_success
         FROM source_attempts
        WHERE source = ?`,
      [source],
    );
    let last = row?.last_success ?? null;
    if (source === 'executive') {
      const ogePoll = await getLastPollAt(env, 'oge');
      const ogeIso = ogePoll?.toISOString() ?? null;
      if (ogeIso && (!last || ogeIso > last)) last = ogeIso;
    }
    return last;
  } catch {
    return null;
  }
}

interface StallEval {
  stalled: boolean;
  detail: string;
  wakeDocId?: string | null;
  skip?: boolean;
}

function idleBeyondThreshold(lastAt: string | null, now: Date, thresholdMs: number): boolean {
  const lastMs = lastAt ? Date.parse(lastAt) : NaN;
  return !Number.isFinite(lastMs) || now.getTime() - lastMs >= thresholdMs;
}

/** Pending-set enrichment progress: ignore tickers never attempted on the backlog. */
function pendingEnrichmentProgressIdle(lastAt: string | null, now: Date, thresholdMs: number): boolean {
  const lastMs = lastAt ? Date.parse(lastAt) : NaN;
  if (!Number.isFinite(lastMs)) return false;
  return now.getTime() - lastMs >= thresholdMs;
}

function hoursLabel(lastAt: string | null, now: Date): string {
  const lastMs = lastAt ? Date.parse(lastAt) : NaN;
  if (!Number.isFinite(lastMs)) return 'never';
  return ((now.getTime() - lastMs) / 3_600_000).toFixed(1);
}

/**
 * Page when a filing is sitting outside the statuses the other detectors
 * watch: no raw object, no live transactions, and either an ingest_status
 * the type union does not allow or a completed outbox that stored nothing.
 * `ocr_scan_reader` requires a raw object, so this class never reached it.
 */
export async function evaluateEmptyFetchHandoff(env: Env, now = new Date()): Promise<StallEval> {
  const collected = await collectEmptyFetchHandoffCheck(env, now);
  const uncollected = collected.check.value == null;
  return {
    stalled: collected.check.status === 'critical',
    detail: collected.check.detail,
    wakeDocId: collected.wakeDocId,
    skip: uncollected,
  };
}

async function evaluateOcrStall(env: Env, now: Date, thresholdMs: number): Promise<StallEval> {
  const backlog = await countScannedReaderBacklog(env);
  const workUnits = backlog.pending + backlog.failed;
  const lastOcr = await lastOcrScanAttemptAt(env);
  const ocrIdle = idleBeyondThreshold(lastOcr, now, thresholdMs);
  if (workUnits <= 0 || !ocrIdle) {
    return { stalled: false, detail: 'ocr scan reader healthy' };
  }
  const detail =
    `${workUnits} scanned PDF(s) pending or failed ingest ` +
    `(pending=${backlog.pending}, failed=${backlog.failed}); ` +
    `no OCR/scan-reader submission in ${hoursLabel(lastOcr, now)}h`;
  const wakeDocId = await pickOcrStallWakeDocId(env);
  return { stalled: true, detail, wakeDocId };
}

async function evaluateChamberFetchStall(
  env: Env,
  source: 'house' | 'senate' | 'executive',
  now: Date,
  thresholdMs: number,
): Promise<StallEval> {
  if (source === 'executive' && !(await ogeWatchEnabled(env))) {
    return { stalled: false, detail: 'executive polling disabled', skip: true };
  }
  const last = await lastSourceFetchSuccessAt(env, source);
  if (!idleBeyondThreshold(last, now, thresholdMs)) {
    return { stalled: false, detail: `${source} fetch success fresh` };
  }
  const stallHours = readPipelineStallHours(env, `${source}_fetch_success`);
  const detail =
    source === 'senate'
      ? `No successful Senate fetch in ${hoursLabel(last, now)}h (threshold ${stallHours}h); ` +
        `check residential proxy / eFD egress`
      : `No successful ${source} ingest fetch in ${hoursLabel(last, now)}h (threshold ${stallHours}h)`;
  return { stalled: true, detail };
}

/** Static unavailable filter for stall SQL (fixed `sr` alias — no dynamic composition). */
const ST_PEER_ENRICHMENT_UNAVAILABLE_EXCLUDED_SQL =
  '(sr.ticker IS NULL OR COALESCE(sr.enrichment_unavailable, 0) = 0)';

function stPeerEnrichmentPendingSql(has0104: boolean): string {
  const unavailable = has0104 ? ST_PEER_ENRICHMENT_UNAVAILABLE_EXCLUDED_SQL : '1=1';
  return `
  FROM transactions t
  LEFT JOIN securities_ref sr ON sr.ticker = t.ticker
 WHERE t.ticker IS NOT NULL AND TRIM(t.ticker) != ''
   AND t.deprecated_at IS NULL
   AND ${excludeCompetitorFixtureTransactionSql('t')}
   AND ${unavailable}
   AND ${enrichmentNeededSql('sr', true)}`;
}

async function evaluateStPeerEnrichment(env: Env, now: Date, thresholdMs: number): Promise<StallEval> {
  if (!(await hasConfiguredKeyedEnrichmentProvider(env))) {
    return { stalled: false, detail: 'ST peer enrichment not configured', skip: true };
  }
  let pending = 0;
  let lastChecked: string | null = null;
  let pendingSample: string[] = [];
  let pendingSql = '';
  const has0104 = await securitiesRefHasEnrichmentUnavailableColumns(env.DB);
  const progressAt = enrichmentProgressTimestampSql('sr', has0104);
  try {
    pendingSql = stPeerEnrichmentPendingSql(has0104);
    const row = await get<{ n: number; last_at: string | null }>(
      env.DB,
      `SELECT
         (SELECT COUNT(DISTINCT t.ticker) ${pendingSql}) AS n,
         (SELECT MAX(${progressAt}) ${pendingSql}) AS last_at`,
    );
    pending = Number(row?.n ?? 0);
    lastChecked = row?.last_at ?? null;
  } catch {
    return { stalled: false, detail: 'enrichment stall query failed', skip: true };
  }
  if (pending <= 0 || !pendingEnrichmentProgressIdle(lastChecked, now, thresholdMs)) {
    return { stalled: false, detail: 'ST enrichment moving' };
  }
  try {
    const names = await all<{ ticker: string }>(
      env.DB,
      `SELECT DISTINCT t.ticker AS ticker ${pendingSql}
       ORDER BY t.ticker ASC
       LIMIT 10`,
    );
    pendingSample = names.map((r) => r.ticker);
  } catch {
    /* sample is optional detail */
  }
  const stallHours = readPipelineStallHours(env, 'st_peer_enrichment');
  const sampleSuffix = pendingSample.length
    ? `; pending sample: ${pendingSample.join(', ')}`
    : '';
  const detail =
    `${pending} ticker(s) still need enrichment from Socratic.Trade / SEC` +
    sampleSuffix +
    `; no enrichment_checked_at progress on pending tickers in ${hoursLabel(lastChecked, now)}h (threshold ${stallHours}h)`;
  return { stalled: true, detail };
}

async function evaluateStPeerPrices(env: Env, now: Date, thresholdMs: number): Promise<StallEval> {
  return evaluateStPeerPricesStall(env, now, thresholdMs);
}

async function loadFreshnessSnapshot(env: Env): Promise<FreshnessSnapshot | null> {
  try {
    const row = await get<{
      spx_latest: string | null;
      price_latest: string | null;
      fundamentals_latest: string | null;
      insider_latest: string | null;
      short_volume_latest: string | null;
      analyst_latest: string | null;
    }>(env.DB, FRESHNESS_LATEST_SQL);
    return {
      spxLatestDate: row?.spx_latest ?? null,
      priceLatestDate: row?.price_latest ?? null,
      fundamentalsLatest: row?.fundamentals_latest ?? null,
      insiderLatestDate: row?.insider_latest ?? null,
      shortVolumeLatestDate: row?.short_volume_latest ?? null,
      analystLatest: row?.analyst_latest ?? null,
    };
  } catch {
    return null;
  }
}

function scaledFreshnessMaxAgeDays(thresholdMs: number): Record<FreshnessStream, number> {
  const baseMs = stallWindowMs(DEFAULT_PIPELINE_STALL_HOURS);
  const ratio = thresholdMs / baseMs;
  const out = { ...FRESHNESS_MAX_AGE_DAYS };
  for (const stream of Object.keys(out) as FreshnessStream[]) {
    out[stream] = Math.max(1, Math.ceil(out[stream] * ratio));
  }
  return out;
}

async function evaluateStInboundMarketData(
  env: Env,
  now: Date,
  thresholdMs: number,
): Promise<StallEval> {
  if (!(await hasConfiguredKeyedEnrichmentProvider(env))) {
    return { stalled: false, detail: 'ST inbound streams not configured', skip: true };
  }
  const snapshot = await loadFreshnessSnapshot(env);
  if (!snapshot) {
    return { stalled: false, detail: 'freshness snapshot unavailable', skip: true };
  }
  const stale = evaluateFreshness(snapshot, now.getTime(), scaledFreshnessMaxAgeDays(thresholdMs));
  if (stale.length === 0) {
    return { stalled: false, detail: 'inbound market-data streams fresh' };
  }
  const detail = stale
    .map((s) => `${s.stream} last ${s.latest} (${s.ageDays}d ago)`)
    .join('; ');
  return { stalled: true, detail: `Stale Socratic.Trade donated streams: ${detail}` };
}

async function evaluateStOutboundShare(env: Env): Promise<StallEval> {
  const keys = await resolveSecrets(env, ['APP_B_IMPORT_URL']);
  const url = keys.APP_B_IMPORT_URL?.trim();
  if (!url) {
    return { stalled: false, detail: 'ST outbound share not configured', skip: true };
  }
  const targetKey = targetKeyForUrl(url, 'peer-app');
  if (!targetKey) {
    return { stalled: false, detail: 'peer URL invalid', skip: true };
  }
  const gate = await checkTargetCircuit(env, targetKey);
  if (gate.allowed === false) {
    const detail =
      `Outbound share push to Socratic.Trade is blocked (${gate.reason}); ` +
      `retry after ~${gate.retryAfterSec}s`;
    return { stalled: true, detail };
  }
  return { stalled: false, detail: 'peer share circuit closed' };
}

async function processStallCondition(
  env: Env,
  condition: PipelineStallCondition,
  evalResult: StallEval,
  now: Date,
  result: PipelineStallAlertResult,
  deps: { fetchImpl?: typeof fetch },
): Promise<void> {
  if (evalResult.skip) return;
  result.evaluated.push(condition);
  const kvKey = `${PIPELINE_LOUD_ALERT_KV_PREFIX}stall:${condition}`;
  const stallHours = readPipelineStallHours(env, condition);
  const windowMs = stallWindowMs(stallHours);
  const episode = await readStallEpisode(env, kvKey);

  if (!evalResult.stalled) {
    if (episode?.active) {
      const recoveredDetail = evalResult.detail || `${condition} cleared`;
      // Recovery is published via notifyPipelineStallPublisher; Sentry info
      // messages created noisy issues (CONGRESS-TRADE-1Q).
      console.info(`Pipeline stall recovered: ${condition} — ${recoveredDetail}`);
      await notifyPipelineStallPublisher(
        env,
        { pipeline: condition, detail: recoveredDetail, recovered: true, at: now.toISOString() },
        deps,
      );
      result.recovered.push(condition);
      await clearStallEpisode(env, kvKey);
    }
    return;
  }

  const lastNotifiedMs = episode ? Date.parse(episode.notifiedAt) : NaN;
  const renotifyDue = !episode?.active
    || !Number.isFinite(lastNotifiedMs)
    || now.getTime() - lastNotifiedMs >= windowMs;
  if (!renotifyDue) return;

  try {
    captureMessage(`Pipeline stall: ${condition} — ${evalResult.detail}`, 'error');
  } catch {
    /* fail-soft */
  }

  await notifyPipelineStallPublisher(
    env,
    {
      pipeline: condition,
      detail: evalResult.detail,
      at: now.toISOString(),
      wakeDocId: evalResult.wakeDocId,
    },
    deps,
  );
  await markStallActive(env, kvKey, now);
  result.alerted.push(condition);
}

/**
 * Stall detector: ingest chambers, OCR/scan-reader, and Socratic.Trade sharing.
 * Runs on the hourly autonomy sweep (deduped per condition per window).
 */
export async function sweepPipelineStallAlerts(
  env: Env,
  now = new Date(),
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<PipelineStallAlertResult> {
  const result: PipelineStallAlertResult = { evaluated: [], alerted: [], recovered: [] };

  const chamberChecks: Array<{ condition: PipelineStallCondition; source: 'house' | 'senate' | 'executive' }> = [
    { condition: 'house_fetch_success', source: 'house' },
    { condition: 'senate_fetch_success', source: 'senate' },
    { condition: 'executive_fetch_success', source: 'executive' },
  ];

  for (const { condition, source } of chamberChecks) {
    const thresholdMs = stallWindowMs(readPipelineStallHours(env, condition));
    const evalResult = await evaluateChamberFetchStall(env, source, now, thresholdMs);
    await processStallCondition(env, condition, evalResult, now, result, deps);
  }

  const ocrThresholdMs = stallWindowMs(readPipelineStallHours(env, 'ocr_scan_reader'));
  await processStallCondition(
    env,
    'ocr_scan_reader',
    await evaluateOcrStall(env, now, ocrThresholdMs),
    now,
    result,
    deps,
  );

  const emptyFetch = await collectEmptyFetchHandoffCheck(env, now);
  await processStallCondition(
    env,
    'empty_fetch_handoff',
    {
      stalled: emptyFetch.check.status === 'critical',
      detail: emptyFetch.check.detail,
      wakeDocId: emptyFetch.wakeDocId,
      skip: emptyFetch.check.value == null,
    },
    now,
    result,
    deps,
  );

  const enrichThresholdMs = stallWindowMs(readPipelineStallHours(env, 'st_peer_enrichment'));
  await processStallCondition(
    env,
    'st_peer_enrichment',
    await evaluateStPeerEnrichment(env, now, enrichThresholdMs),
    now,
    result,
    deps,
  );

  const priceThresholdMs = stallWindowMs(readPipelineStallHours(env, 'st_peer_prices'));
  await processStallCondition(
    env,
    'st_peer_prices',
    await evaluateStPeerPrices(env, now, priceThresholdMs),
    now,
    result,
    deps,
  );

  const inboundThresholdMs = stallWindowMs(readPipelineStallHours(env, 'st_inbound_market_data'));
  await processStallCondition(
    env,
    'st_inbound_market_data',
    await evaluateStInboundMarketData(env, now, inboundThresholdMs),
    now,
    result,
    deps,
  );

  // Circuit-open stalls are immediate; `CT_PIPELINE_STALL_HOURS_st_outbound_share_push`
  // only controls re-alert cadence via processStallCondition dedupe window.
  await processStallCondition(
    env,
    'st_outbound_share_push',
    await evaluateStOutboundShare(env),
    now,
    result,
    deps,
  );

  const HEALTH_STALL_BUDGET_MS = 20_000;
  try {
    let healthTimeoutId: ReturnType<typeof setTimeout> | undefined;
    const health = await (async () => {
      try {
        return await Promise.race([
          checkPipelineHealth(env, now, { emptyFetch }),
          new Promise<never>((_, reject) => {
            healthTimeoutId = setTimeout(
              () => reject(new Error(`checkPipelineHealth exceeded ${HEALTH_STALL_BUDGET_MS}ms`)),
              HEALTH_STALL_BUDGET_MS,
            );
          }),
        ]);
      } finally {
        if (healthTimeoutId !== undefined) clearTimeout(healthTimeoutId);
      }
    })();
    for (const check of health.checks) {
      if (HEALTH_STALL_SKIP_IDS.has(check.id)) continue;
      const stalled = check.status === 'stalled' || check.status === 'critical';
      const condition = `health_${check.id}` satisfies PipelineStallCondition;
      await processStallCondition(
        env,
        condition,
        {
          stalled,
          detail: stalled
            ? `[health/${check.status}] ${check.detail}`
            : (check.detail || `${check.id} ok`),
        },
        now,
        result,
        deps,
      );
    }
  } catch {
    /* health collection must not break the stall sweep */
  }

  return result;
}
