/**
 * src/extraction/autopilot.ts
 *
 * BACKLOG AUTOPILOT — the app-native replacement for the operator-driven
 * review-backlog drain. A cron gate (maybeStartBacklogAutopilot, invoked from
 * the per-minute scheduled handler) decides when a run is due — any tick
 * with at least one claimable eligible-due doc (threshold 1, not 150), a
 * UTC-day catch-up when nothing is due now, or a rate-limited storm path
 * when the unresolved backlog exceeds AUTOPILOT_BACKLOG_THRESHOLD — and
 * starts a durable run row plus an
 * 'autopilot.tick' queue message. The queue consumer (handleAutopilotTick)
 * then drains docs a few at a time, re-enqueueing itself until the run ends,
 * because long model work must live in the queue (generous per-message
 * duration), never in the cron's cancellable waitUntil.
 *
 * Each selected doc runs through the EXACT same cascade/agreement machinery
 * as the per-minute cron (handleAgreementCheck): same leases, same attempt
 * caps, same daily LLM read budget, same unanimity/majority publish rules,
 * same hard-fail flags. The autopilot changes WHO initiates work — never
 * what publishes.
 *
 * OWNER POLICY (baked in, not optional):
 *  - Pilot-sized runs: AUTOPILOT_MAX_DOCS_PER_RUN (default 50) caps a run;
 *    first runs are pilots, never the whole backlog.
 *  - No retry burn: at most one attempt per model per doc per run — the
 *    cascade reads each configured model once per tier, a failed call is
 *    recorded and NEVER immediately retried or failed-over within the run.
 *  - Error-class kill-switch: when the same error class (billing / auth /
 *    quota / parse / timeout) occurs AUTOPILOT_ERROR_CLASS_HALT_THRESHOLD
 *    times (default 2) in a run, the ENTIRE run halts immediately.
 *  - Halts require acknowledgment for auth and real runaway spend. Transient
 *    OpenRouter files-prepaid / key-limit 402s use the budget circuit's
 *    bounded cool-down and auto-resume — they must not silently latch
 *    extraction for days. Jay is paged on every halt via Pushover.
 *
 * SPEND METER: every doc reserves a rate-card estimate against the shared
 * per-UTC-day autopilot_budget (AUTOPILOT_DAILY_USD_BUDGET, default $5.00,
 * integer micro-USD) BEFORE any model call, then settles to the priced actual
 * usage from extraction_runs afterwards. Reservation fails closed: a missing
 * budget table halts the run rather than spending unmetered.
 *
 * BATCH PRE-SEEDING (AUTOPILOT_BATCH_PRESEED, default off): when a chamber's
 * agreement trio includes direct batch-capable providers (openai / anthropic
 * / mistral / xai), eligible docs are submitted through the ~50%-cheaper
 * provider batch APIs first; completed batch reads land in extraction_runs,
 * where the cascade's read cache reuses them on a later run. All-OpenRouter
 * trios (the current production lineup) have no batch transport, so this is
 * a no-op there — hence "where supported".
 */

import type { Env } from '../shared/types.ts';
import { all, batch, get, run } from '../shared/db.ts';
import { uuid } from '../shared/ids.ts';
import { resolveSecrets } from '../secrets/infisical.ts';
import {
  AGREEMENT_CLAIM_LEASE_MS,
  handleAgreementCheck,
  maxAttempts,
  resolveAgreementEnv,
  resolveModelsWithC,
  type AgreementDocResult,
  type AgreementModelsC,
} from './agreement.ts';
import {
  classifyProviderErrorClass,
  isFalseSourceAuthError,
  isFalseSourceAuthHalt,
  isTransientFilesPrepaidError,
  isTransientFilesPrepaidHalt,
  isTransientInfrastructureHalt,
  type ProviderErrorClass,
} from './providerHealth.ts';
import { isTransientInfrastructureError } from '../shared/transientInfra.ts';
import { isDocScopedOpenRouterError } from './openRouterReply.ts';
import { sendPushover } from '../shared/pushover.ts';
import { countReviewQueueBuckets, TERMINAL_REVIEW_REASON_EXCLUDE_SQL } from './reviewQueueHealth.ts';
import { estimateNominalReadCostUsd, priceBenchmarkUsage } from './benchmarkMetrics.ts';
import { meanConfidence, persistExtractionRun, type CandidateDocResult, type Provider } from './bakeoff.ts';
import { arbitrationRowKey } from '../extractors/types.ts';
import { pollBatch, submitBatch, type BatchChamber, type BatchDoc, type BatchProvider } from './batchExtract.ts';
import { ensureDocClass, DOC_CLASS_ORDER_SQL, type DocClass } from './docClassifier.ts';
import { recordIngestionDecision } from '../shared/ingestionDecisions.ts';
import { allProvidersThrottled } from '../shared/monitorBudgetGate.ts';
import { settleAutopilotBudgetReceipt } from '../shared/llmSpend.ts';

const MICRO = 1_000_000;
/** Docs processed per queue-consumer invocation (each doc = 2-3 model reads). */
const DOCS_PER_TICK = 3;
/** A 'running' run whose consumer stopped updating for this long is stalled. */
const STALLED_RUN_MS = 30 * 60 * 1000;
/** Conservative planning cost for a model read the rate card cannot price. */
const UNPRICEABLE_READ_COST_USD = 0.05;
/** Outstanding pre-seed batch jobs polled per tick (bounded work). */
const PRESEED_POLL_LIMIT = 3;
/** Stale submission intents reconciled per tick independently of provider polling. */
const PRESEED_SUBMISSION_RECONCILE_LIMIT = 25;
const AUTOPILOT_BATCH_ID_PREFIX = 'autopilot-';
const PRESEED_SUBMISSION_UNKNOWN_AFTER_MS = 15 * 60 * 1000;

const KILL_SWITCH_CLASSES: readonly ProviderErrorClass[] = [
  'billing', 'auth', 'quota', 'parse', 'timeout',
];
const DIRECT_BATCH_PROVIDERS: readonly string[] = ['anthropic', 'openai', 'mistral', 'xai'];

const KV_LAST_DAY = 'autopilot:lastday';
const KV_LAST_RUN_AT = 'autopilot:lastrun';

export interface AutopilotKnobs {
  enabled: boolean;
  backlogThreshold: number;
  dailyBudgetMicroUsd: number;
  maxDocsPerRun: number;
  errorClassHaltThreshold: number;
  minIntervalMinutes: number;
  preseedEnabled: boolean;
  /** Fraction of doc_class='empty' docs left in review for a human spot-check. */
  emptySpotcheckRate: number;
  /**
   * Default-off. When true, a tick with no normally-eligible doc (attempts <
   * cap) falls back to ONE doc that already exhausted its attempt cap under
   * `reason='agreement_cascade_unresolved'` (a genuine model disagreement,
   * never a hard-fail/corrupt/suppressed doc) and has never been legacy-
   * replayed. See selectLegacyReplayDoc for the exactly-once reset guard.
   */
  legacyReplayEnabled: boolean;
  /**
   * Document kinds the cascade never spends model calls on. Defaults to
   * `senate_html` (deterministic parser, no model uncertainty to corroborate).
   * Infisical: AGREEMENT_SKIP_DOC_KINDS.
   */
  skipDocKinds: string[];
}

interface AutopilotSecretEnv {
  AGREEMENT_AUTOPUBLISH_ENABLED?: string;
  AUTOPILOT_ENABLED?: string;
  AUTOPILOT_BACKLOG_THRESHOLD?: string;
  AUTOPILOT_DAILY_USD_BUDGET?: string;
  AUTOPILOT_MAX_DOCS_PER_RUN?: string;
  AUTOPILOT_ERROR_CLASS_HALT_THRESHOLD?: string;
  AUTOPILOT_MIN_INTERVAL_MINUTES?: string;
  AUTOPILOT_BATCH_PRESEED?: string;
  DOC_CLASS_EMPTY_SPOTCHECK_RATE?: string;
  AUTOPILOT_LEGACY_REPLAY_ENABLED?: string;
  AGREEMENT_SKIP_DOC_KINDS?: string;
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  const value = Number.parseFloat(raw ?? '');
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Live-tunable knobs (Infisical-first, env fallback). The autopilot inherits
 * the cascade's master switch: it runs only where AGREEMENT_AUTOPUBLISH is
 * already on, and can be independently disabled with AUTOPILOT_ENABLED=false.
 */
export async function resolveAutopilotKnobs(env: Env): Promise<AutopilotKnobs> {
  let secrets: AutopilotSecretEnv = {};
  try {
    secrets = (await resolveSecrets(env, [
      'AGREEMENT_AUTOPUBLISH_ENABLED',
      'AUTOPILOT_ENABLED',
      'AUTOPILOT_BACKLOG_THRESHOLD',
      'AUTOPILOT_DAILY_USD_BUDGET',
      'AUTOPILOT_MAX_DOCS_PER_RUN',
      'AUTOPILOT_ERROR_CLASS_HALT_THRESHOLD',
      'AUTOPILOT_MIN_INTERVAL_MINUTES',
      'AUTOPILOT_BATCH_PRESEED',
      'DOC_CLASS_EMPTY_SPOTCHECK_RATE',
      'AUTOPILOT_LEGACY_REPLAY_ENABLED',
      'AGREEMENT_SKIP_DOC_KINDS',
    ])) as AutopilotSecretEnv;
  } catch {
    // Resolver outage: fail closed (disabled) rather than run unconfigured.
    return {
      enabled: false,
      backlogThreshold: 150,
      dailyBudgetMicroUsd: 5 * MICRO,
      maxDocsPerRun: 50,
      errorClassHaltThreshold: 2,
      minIntervalMinutes: 60,
      preseedEnabled: false,
      emptySpotcheckRate: 0.1,
      legacyReplayEnabled: false,
      skipDocKinds: agreementSkipDocKinds(),
    };
  }
  return {
    enabled: secrets.AGREEMENT_AUTOPUBLISH_ENABLED === 'true'
      && secrets.AUTOPILOT_ENABLED !== 'false',
    backlogThreshold: Math.round(positiveNumber(secrets.AUTOPILOT_BACKLOG_THRESHOLD, 150)),
    dailyBudgetMicroUsd: Math.round(positiveNumber(secrets.AUTOPILOT_DAILY_USD_BUDGET, 5) * MICRO),
    maxDocsPerRun: Math.round(positiveNumber(secrets.AUTOPILOT_MAX_DOCS_PER_RUN, 50)),
    errorClassHaltThreshold: Math.round(
      positiveNumber(secrets.AUTOPILOT_ERROR_CLASS_HALT_THRESHOLD, 2),
    ),
    minIntervalMinutes: positiveNumber(secrets.AUTOPILOT_MIN_INTERVAL_MINUTES, 60),
    preseedEnabled: secrets.AUTOPILOT_BATCH_PRESEED === 'true',
    emptySpotcheckRate: Math.min(positiveNumber(secrets.DOC_CLASS_EMPTY_SPOTCHECK_RATE, 0.1), 1),
    legacyReplayEnabled: secrets.AUTOPILOT_LEGACY_REPLAY_ENABLED === 'true',
    skipDocKinds: agreementSkipDocKinds(secrets.AGREEMENT_SKIP_DOC_KINDS),
  };
}

/**
 * "Current era first": congressional terms begin January of odd years, so the
 * current era starts Jan 1 of the most recent odd year. Era docs drain before
 * older filings; within an era, oldest review item first.
 */
export function currentEraStart(now = new Date()): string {
  const year = now.getUTCFullYear();
  return `${year - ((year - 1) % 2)}-01-01`;
}

function budgetDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Durable run state
// ---------------------------------------------------------------------------

export interface AutopilotOutcome {
  docId: string;
  outcome: string;
  reason?: string;
  spendUsd?: number;
  /** Receipt/attribution dimension from the pre-extraction classifier. */
  docClass?: DocClass | null;
}

interface AutopilotRunRow {
  id: string;
  status: string;
  /** 'trigger' is a SQLite reserved keyword; the column is run_trigger. */
  run_trigger: string;
  revision: number;
  backlog_before: number | null;
  docs_attempted: number;
  docs_published: number;
  docs_deferred: number;
  spend_microusd: number;
  budget_microusd: number;
  error_class_counts: string | null;
  sample_errors: string | null;
  outcomes: string | null;
  skip_reasons: string | null;
  halt_reason: string | null;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  started_at: string;
  updated_at: string;
  finished_at: string | null;
}

interface RunState {
  docsAttempted: number;
  docsPublished: number;
  docsDeferred: number;
  spendMicro: number;
  errorClassCounts: Partial<Record<ProviderErrorClass, number>>;
  sampleErrors: Partial<Record<ProviderErrorClass, string>>;
  outcomes: AutopilotOutcome[];
  skipReasons: Record<string, number>;
}

function parseJsonOr<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function parseRunState(row: AutopilotRunRow): RunState {
  return {
    docsAttempted: row.docs_attempted ?? 0,
    docsPublished: row.docs_published ?? 0,
    docsDeferred: row.docs_deferred ?? 0,
    spendMicro: row.spend_microusd ?? 0,
    errorClassCounts: parseJsonOr(row.error_class_counts, {}),
    sampleErrors: parseJsonOr(row.sample_errors, {}),
    outcomes: parseJsonOr(row.outcomes, []),
    skipReasons: parseJsonOr(row.skip_reasons, {}),
  };
}

/**
 * CAS-persist the run state (revision fence) so a redelivered tick that lost
 * ownership can never clobber the live consumer's receipt. Returns the new
 * revision on success, null when ownership was lost.
 */
async function persistRunState(
  env: Env,
  runId: string,
  expectedRevision: number,
  state: RunState,
  final?: { status: 'completed' | 'halted'; haltReason: string | null },
): Promise<number | null> {
  const nowIso = new Date().toISOString();
  const result = await run(
    env.DB,
    `UPDATE autopilot_runs
        SET revision = revision + 1,
            docs_attempted = ?, docs_published = ?, docs_deferred = ?,
            spend_microusd = ?, error_class_counts = ?, sample_errors = ?,
            outcomes = ?, skip_reasons = ?, updated_at = ?,
            status = COALESCE(?, status),
            halt_reason = COALESCE(?, halt_reason),
            finished_at = COALESCE(?, finished_at)
      WHERE id = ? AND status = 'running' AND revision = ?`,
    [
      state.docsAttempted, state.docsPublished, state.docsDeferred,
      state.spendMicro, JSON.stringify(state.errorClassCounts),
      JSON.stringify(state.sampleErrors), JSON.stringify(state.outcomes),
      JSON.stringify(state.skipReasons), nowIso,
      final?.status ?? null,
      final?.haltReason ?? null,
      final ? nowIso : null,
      runId, expectedRevision,
    ],
  );
  return (result.meta?.changes ?? 0) > 0 ? expectedRevision + 1 : null;
}

/** Terminal halt without the revision fence (DLQ / stalled-run recovery). */
export async function markAutopilotRunHalted(
  env: Env,
  runId: string,
  reason: string,
): Promise<boolean> {
  try {
    const nowIso = new Date().toISOString();
    const result = await run(
      env.DB,
      `UPDATE autopilot_runs
          SET status = 'halted', halt_reason = ?, finished_at = ?, updated_at = ?,
              revision = revision + 1
        WHERE id = ? AND status = 'running'`,
      [reason, nowIso, nowIso, runId],
    );
    const halted = (result.meta?.changes ?? 0) > 0;
    if (halted) await pageExtractionHalt(env, reason);
    return halted;
  } catch (err) {
    console.warn('autopilot: halt mark failed:', runId, (err as Error).message);
    return false;
  }
}

async function pageExtractionHalt(env: Env, reason: string): Promise<void> {
  const delivered = await sendPushover(env, {
    title: 'CT DOWN: extraction halted',
    message: `Autopilot halted: ${reason.slice(0, 240)}`,
    priority: 1,
    url: 'https://congress.trade/?view=review',
    urlTitle: 'Review + acknowledge',
  });
  if (!delivered.sent) {
    console.error('autopilot: halt page NOT delivered —', delivered.reason ?? 'unknown reason');
  }
}

// ---------------------------------------------------------------------------
// Daily USD spend meter (integer micro-USD, guarded like reserveLlmBudget but
// failing CLOSED: unmetered spend is worse than a paused autopilot)
// ---------------------------------------------------------------------------

async function reserveAutopilotBudget(
  env: Env,
  reservationId: string,
  day: string,
  amountMicro: number,
  capMicro: number,
): Promise<'created' | 'replay_reserved' | 'replay_settled' | false> {
  const createdAt = new Date().toISOString();
  try {
    const result = await run(
      env.DB,
      `INSERT OR IGNORE INTO autopilot_budget_reservations
         (reservation_id, day, reserved_microusd, actual_microusd,
          cap_microusd, status, created_at, settled_at)
       VALUES (?, ?, ?, NULL, ?, 'reserved', ?, NULL)`,
      [reservationId, day, amountMicro, capMicro, createdAt],
    );
    if ((result.meta?.changes ?? 0) > 0) return 'created';
    const existing = await get<{
      day: string;
      reserved_microusd: number;
      cap_microusd: number;
      status: string;
    }>(
      env.DB,
      `SELECT day, reserved_microusd, cap_microusd, status
         FROM autopilot_budget_reservations WHERE reservation_id = ?`,
      [reservationId],
    );
    if (
      existing?.day === day
      && Number(existing.reserved_microusd) === amountMicro
      && Number(existing.cap_microusd) === capMicro
    ) return existing.status === 'reserved' ? 'replay_reserved' : 'replay_settled';
    throw new Error('autopilot reservation identity conflict');
  } catch (error) {
    if (/autopilot budget exhausted/i.test((error as Error).message)) return false;
    throw error;
  }
}

async function settleAutopilotBudget(
  env: Env,
  settlementId: string,
  day: string,
  reservedMicro: number,
  actualMicro: number,
  status: 'completed' | 'aborted' | 'failed',
): Promise<void> {
  await settleAutopilotBudgetReceipt(env, {
    settlementId,
    day,
    reservedMicroUsd: reservedMicro,
    actualMicroUsd: actualMicro,
    status,
    createdAt: new Date().toISOString(),
  });
}

interface OutstandingAutopilotReservation {
  reservation_id: string;
  day: string;
  reserved_microusd: number;
  actual_microusd: number | null;
  status: 'reserved' | 'completed' | 'aborted' | 'failed';
}

async function outstandingAutopilotReservation(
  env: Env,
  runId: string,
  revision: number,
): Promise<(OutstandingAutopilotReservation & { docId: string }) | null> {
  const prefix = `autopilot:${runId}:`;
  const suffix = `:r${revision}`;
  const row = await get<OutstandingAutopilotReservation>(
    env.DB,
    `SELECT reservation_id, day, reserved_microusd, actual_microusd, status
       FROM autopilot_budget_reservations
      WHERE reservation_id LIKE ?
      ORDER BY created_at DESC
      LIMIT 1`,
    [`${prefix}%${suffix}`],
  );
  if (!row?.reservation_id.startsWith(prefix) || !row.reservation_id.endsWith(suffix)) return null;
  const docId = row.reservation_id.slice(prefix.length, -suffix.length);
  return docId ? { ...row, docId } : null;
}

async function todaysSpendMicro(env: Env, day: string): Promise<number> {
  try {
    const row = await get<{ spend_microusd: number }>(
      env.DB,
      'SELECT spend_microusd FROM autopilot_budget WHERE day = ?',
      [day],
    );
    return row?.spend_microusd ?? 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Cost estimation + settlement
// ---------------------------------------------------------------------------

function estimateDocCostMicro(trio: AgreementModelsC | null, pageCount: number | null): number {
  if (!trio) return 0; // missing lineup config: the cascade flags it without model spend
  let totalUsd = 0;
  for (const model of [trio.a, trio.b, trio.c]) {
    totalUsd += estimateNominalReadCostUsd(model.provider, model.model, { pageCount })
      ?? UNPRICEABLE_READ_COST_USD;
  }
  return Math.ceil(totalUsd * MICRO);
}

interface DocReadRow {
  provider: string;
  model: string;
  ok: number;
  error: string | null;
  usage_json: string | null;
}

async function loadDocReads(env: Env, docId: string, sinceIso: string): Promise<DocReadRow[]> {
  try {
    return await all<DocReadRow>(
      env.DB,
      `SELECT provider, model, ok, error, usage_json FROM extraction_runs
        WHERE doc_id = ? AND kind = 'agreement' AND created_at >= ?`,
      [docId, sinceIso],
    );
  } catch {
    return [];
  }
}

/** Price the doc's observed reads: measured usage first, nominal fallback. */
function priceDocReadsMicro(reads: DocReadRow[], pageCount: number | null): number {
  let totalUsd = 0;
  for (const read of reads) {
    const usage = parseJsonOr<Record<string, number> | null>(read.usage_json, null);
    const priced = usage
      ? priceBenchmarkUsage({
          provider: read.provider,
          model: read.model,
          invoked: true,
          usage,
        }).costUsd
      : null;
    totalUsd += priced
      ?? estimateNominalReadCostUsd(read.provider, read.model, { pageCount })
      ?? UNPRICEABLE_READ_COST_USD;
  }
  return Math.ceil(totalUsd * MICRO);
}

// ---------------------------------------------------------------------------
// Doc selection (era-priority: current congressional era first, oldest first)
// ---------------------------------------------------------------------------

interface EligibleDoc {
  doc_id: string;
  raw_object_key: string | null;
  chamber: string | null;
  page_count: number | null;
  doc_class: string | null;
}

/**
 * Document kinds the agreement cascade must never spend model calls on.
 *
 * The cascade exists to corroborate a MODEL's reading of a document by having
 * two or three other models read the same bytes. That is only meaningful where
 * the primary read was itself probabilistic. `senate_html` is parsed by a
 * deterministic HTML extractor (extraction/senateHtml.ts) — there is no model
 * uncertainty to corroborate, and the cascade's vision models receive HTML
 * bytes they cannot parse at all.
 *
 * Measured cost of not having this gate (2026-08-11, production):
 *   senate_html / agreement : 2,086 runs, 48 ok, ZERO rows
 *   scanned_pdf / agreement : 2,590 runs, 1,345 ok, 11,710 rows
 *   text_pdf    / agreement :   617 runs,   249 ok,  9,727 rows
 *
 * i.e. 25% of every model call this system has ever made went to a format that
 * cannot produce a row. Three Senate HTML docs alone absorbed ~2,013 calls over
 * four days, each provider replying "Failed to parse document.pdf" — the files
 * were never corrupt, they were simply not PDFs.
 *
 * Override with AGREEMENT_SKIP_DOC_KINDS (comma-separated) to re-open a kind,
 * or set it empty to disable the gate entirely.
 */
export const DEFAULT_AGREEMENT_SKIP_DOC_KINDS = 'senate_html';

export function agreementSkipDocKinds(raw?: string | null): string[] {
  const value = raw ?? DEFAULT_AGREEMENT_SKIP_DOC_KINDS;
  return value
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** SQL fragment excluding the skipped kinds; empty string when nothing is skipped. */
export function agreementSkipDocKindSql(kinds: string[]): string {
  if (!kinds.length) return '';
  const list = kinds.map((k) => `'${k.replace(/'/g, "''")}'`).join(', ');
  return `\n   AND COALESCE(f.doc_kind, '') NOT IN (${list})`;
}

const ELIGIBLE_PREDICATES = `
       rq.resolved = 0
   AND rq.agreement_suppressed_at IS NULL
   AND ${TERMINAL_REVIEW_REASON_EXCLUDE_SQL}
   AND COALESCE(rq.agreement_attempts, 0) < ?
   AND (rq.agreement_next_attempt_at IS NULL OR rq.agreement_next_attempt_at <= ?)
   AND (rq.agreement_claim_token IS NULL OR rq.agreement_claimed_at IS NULL OR rq.agreement_claimed_at <= ?)
   AND f.raw_object_key IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM transactions t
      WHERE t.doc_id = rq.doc_id AND t.source IN ('primary', 'manual')
        AND t.deprecated_at IS NULL
   )`;

/**
 * Predicates for a doc that already exhausted its normal attempt cap via a
 * genuine model disagreement (never a hard-fail/corrupt/quarantine reason,
 * never suppressed) and has not yet been given its one-time legacy-replay
 * reset. `reason = 'agreement_cascade_unresolved'` is the exact terminal
 * label leaveInReviewHighPriority writes on a cascade that ran out of
 * attempts without reaching unanimity/majority — the only reason this path
 * targets, so a doc flagged for a different, more deliberate cause (e.g. a
 * future hard-fail classification) is never swept in here.
 */
const LEGACY_REPLAY_PREDICATES = `
       rq.resolved = 0
   AND rq.agreement_suppressed_at IS NULL
   AND rq.agreement_legacy_replay_at IS NULL
   AND COALESCE(rq.agreement_attempts, 0) >= ?
   AND rq.reason = 'agreement_cascade_unresolved'
   AND (rq.agreement_claim_token IS NULL OR rq.agreement_claimed_at IS NULL OR rq.agreement_claimed_at <= ?)
   AND f.raw_object_key IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM transactions t
      WHERE t.doc_id = rq.doc_id AND t.source IN ('primary', 'manual')
        AND t.deprecated_at IS NULL
   )`;

/**
 * Atomically reset ONE exhausted, not-yet-replayed doc back to a fresh
 * attempt budget (attempts=0, tier cleared, any stale schedule/lease
 * cleared) and stamp `agreement_legacy_replay_at` in the SAME guarded
 * UPDATE, so a concurrent selector can never grant a second grace reset to
 * the same doc (the WHERE clause re-checks `agreement_legacy_replay_at IS
 * NULL`, matching the CAS pattern acquireAgreementLease/reserveLlmBudget
 * use elsewhere in this cascade). Returns the doc once the reset lands; the
 * caller then runs it through the EXACT same handleAgreementCheck cascade
 * (leases, attempt cap, daily LLM budget, publish rules) as any other doc —
 * this function only ever grants ONE extra full attempt budget, never
 * bypasses the cascade's own governance.
 */
async function selectLegacyReplayDoc(
  env: Env,
  attemptCap: number,
  excludeDocIds: string[],
  now: Date,
  skipKinds: string[] = agreementSkipDocKinds(),
): Promise<EligibleDoc | null> {
  const nowIso = now.toISOString();
  const leaseExpired = new Date(now.getTime() - AGREEMENT_CLAIM_LEASE_MS).toISOString();
  const skipSql = agreementSkipDocKindSql(skipKinds);
  const candidate = await get<EligibleDoc>(
    env.DB,
    `SELECT f.doc_id, f.raw_object_key, f.chamber, f.page_count, f.doc_class
       FROM review_queue rq JOIN filings f ON f.doc_id = rq.doc_id
      WHERE ${LEGACY_REPLAY_PREDICATES}${skipSql}
        AND rq.doc_id NOT IN (SELECT value FROM json_each(?))
      ORDER BY rq.created_at ASC
      LIMIT 1`,
    [attemptCap, leaseExpired, JSON.stringify(excludeDocIds)],
  );
  if (!candidate) return null;
  const reset = await run(
    env.DB,
    `UPDATE review_queue
        SET agreement_attempts = 0, agreement_tier = NULL, agreement_next_attempt_at = NULL,
            agreement_legacy_replay_at = ?, review_revision = review_revision + 1
      WHERE doc_id = ? AND resolved = 0 AND agreement_legacy_replay_at IS NULL`,
    [nowIso, candidate.doc_id],
  );
  // Lost the race (another selector reset it first, or it resolved meanwhile):
  // do not return a doc whose reset didn't actually land.
  return (reset.meta?.changes ?? 0) > 0 ? candidate : null;
}

async function selectNextDoc(
  env: Env,
  attemptCap: number,
  excludeDocIds: string[],
  eraStart: string,
  now: Date,
  legacyReplayEnabled = false,
  skipKinds: string[] = agreementSkipDocKinds(),
): Promise<EligibleDoc | null> {
  const nowIso = now.toISOString();
  const leaseExpired = new Date(now.getTime() - AGREEMENT_CLAIM_LEASE_MS).toISOString();
  const skipSql = agreementSkipDocKindSql(skipKinds);
  // Ordering: doc_class first (typed/clean/empty are the cheapest to resolve,
  // hard scans and quarantine candidates last), then current-era-first, then
  // oldest review item. Cheapest wins.
  const primary = await get<EligibleDoc>(
    env.DB,
    `SELECT f.doc_id, f.raw_object_key, f.chamber, f.page_count, f.doc_class
       FROM review_queue rq JOIN filings f ON f.doc_id = rq.doc_id
      WHERE ${ELIGIBLE_PREDICATES}${skipSql}
        AND rq.doc_id NOT IN (SELECT value FROM json_each(?))
      ORDER BY ${DOC_CLASS_ORDER_SQL},
               CASE WHEN COALESCE(f.filed_date, '') >= ? THEN 0 ELSE 1 END,
               rq.created_at ASC
      LIMIT 1`,
    [attemptCap, nowIso, leaseExpired, JSON.stringify(excludeDocIds), eraStart],
  );
  if (primary) return primary;
  // Only reached once the normal (attempts < cap) pool is empty, and only
  // when the operator opted in — this never displaces a normally-eligible
  // doc, it only fills an otherwise-idle tick slot.
  if (!legacyReplayEnabled) return null;
  return selectLegacyReplayDoc(env, attemptCap, excludeDocIds, now);
}

/**
 * Unresolved-with-raw-bytes backlog size (trigger + status reporting).
 * Mirrors ELIGIBLE_PREDICATES' resolvability gate (suppressed/raw-bytes) but
 * deliberately does NOT filter on `agreement_attempts < cap`: a doc that
 * exhausted its cap is still real, unprocessed backlog (it will get a
 * legacy-replay grace shot when that's enabled, or stay a visible terminal
 * count when it's not) — undercounting it here is what previously made every
 * autopilot run report a stable `backlog_before` while `docs_attempted`
 * stayed 0 and every run "completed" as `backlog_drained`, silently masking
 * a permanently-stuck backlog instead of surfacing it honestly.
 */
export async function countEligibleBacklog(env: Env): Promise<number | null> {
  let skipKindsRaw: string | undefined;
  try {
    const s = (await resolveSecrets(env, ['AGREEMENT_SKIP_DOC_KINDS'])) as {
      AGREEMENT_SKIP_DOC_KINDS?: string;
    };
    skipKindsRaw = s.AGREEMENT_SKIP_DOC_KINDS;
  } catch {
    skipKindsRaw = undefined; // fall back to the default skip list
  }
  try {
    const row = await get<{ n: number }>(
      env.DB,
      `SELECT COUNT(*) AS n
         FROM review_queue rq JOIN filings f ON f.doc_id = rq.doc_id
        WHERE rq.resolved = 0
          AND rq.agreement_suppressed_at IS NULL
          AND f.raw_object_key IS NOT NULL${agreementSkipDocKindSql(agreementSkipDocKinds(skipKindsRaw))}`,
    );
    return row?.n ?? 0;
  } catch {
    return null;
  }
}

/**
 * Selector-eligible due-now docs the cascade can claim on this tick.
 * Health `eligible` is a looser bucket and must not be used as this count.
 */
export async function countEligibleDueDocs(env: Env, now = new Date()): Promise<number | null> {
  let skipKindsRaw: string | undefined;
  let maxAttemptsRaw: string | undefined;
  try {
    const s = (await resolveSecrets(env, ['AGREEMENT_SKIP_DOC_KINDS', 'AGREEMENT_MAX_ATTEMPTS'])) as {
      AGREEMENT_SKIP_DOC_KINDS?: string;
      AGREEMENT_MAX_ATTEMPTS?: string;
    };
    skipKindsRaw = s.AGREEMENT_SKIP_DOC_KINDS;
    maxAttemptsRaw = s.AGREEMENT_MAX_ATTEMPTS;
  } catch {
    skipKindsRaw = undefined;
    maxAttemptsRaw = undefined;
  }
  const attemptCap = maxAttempts({ AGREEMENT_MAX_ATTEMPTS: maxAttemptsRaw } as Parameters<typeof maxAttempts>[0]);
  const nowIso = now.toISOString();
  const leaseExpired = new Date(now.getTime() - AGREEMENT_CLAIM_LEASE_MS).toISOString();
  try {
    const row = await get<{ n: number }>(
      env.DB,
      `SELECT COUNT(*) AS n
         FROM review_queue rq JOIN filings f ON f.doc_id = rq.doc_id
        WHERE ${ELIGIBLE_PREDICATES}${agreementSkipDocKindSql(agreementSkipDocKinds(skipKindsRaw))}`,
      [attemptCap, nowIso, leaseExpired],
    );
    return row?.n ?? 0;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cron gate — decide whether a run is due, create it, enqueue the first tick
// ---------------------------------------------------------------------------

export type AutopilotStartTrigger = 'daily' | 'backlog' | 'eligible';

export interface AutopilotStartResult {
  started?: { runId: string; trigger: AutopilotStartTrigger };
  blocked?: 'unacknowledged_halt' | 'run_in_progress' | 'stalled_run_halted' | 'not_due';
}

export async function maybeStartBacklogAutopilot(
  env: Env,
  now = new Date(),
): Promise<AutopilotStartResult | null> {
  const knobs = await resolveAutopilotKnobs(env);
  if (!knobs.enabled) return null;

  // Halt/ack + single-run gates. A halted run must be acknowledged by a human
  // (POST /api/admin/autopilot/acknowledge) before any new run may start.
  let open: Array<{
    id: string;
    status: string;
    updated_at: string;
    halt_reason: string | null;
    sample_errors: string | null;
  }>;
  try {
    open = await all<{
      id: string;
      status: string;
      updated_at: string;
      halt_reason: string | null;
      sample_errors: string | null;
    }>(
      env.DB,
      `SELECT id, status, updated_at, halt_reason, sample_errors FROM autopilot_runs
        WHERE status IN ('running', 'halted')
        ORDER BY started_at DESC LIMIT 10`,
    );
  } catch {
    return null; // autopilot_runs not migrated yet — do nothing, never throw
  }
  const haltedRows = open.filter((row) => row.status === 'halted');
  if (haltedRows.length) {
    const resumable = haltedRows.filter((row) =>
      isTransientFilesPrepaidHalt(row.halt_reason, row.sample_errors)
      || isFalseSourceAuthHalt(row.halt_reason, row.sample_errors)
      || isTransientInfrastructureHalt(row.halt_reason, row.sample_errors));
    if (resumable.length && resumable.length === haltedRows.length) {
      for (const row of resumable) {
        const actor = isFalseSourceAuthHalt(row.halt_reason, row.sample_errors)
          ? 'auto_resume:false_source_auth'
          : isTransientInfrastructureHalt(row.halt_reason, row.sample_errors)
            ? 'auto_resume:transient_infra'
            : 'auto_resume:files_prepaid';
        await acknowledgeAutopilotHalt(env, {
          runId: row.id,
          actor,
        });
      }
    } else {
      return { blocked: 'unacknowledged_halt' };
    }
  }
  const runningRow = open.find((row) => row.status === 'running');
  if (runningRow) {
    const updatedAt = Date.parse(runningRow.updated_at);
    if (Number.isFinite(updatedAt) && now.getTime() - updatedAt >= STALLED_RUN_MS) {
      // Consumer died mid-run: surface it as a halt that requires human ack.
      await markAutopilotRunHalted(env, runningRow.id, 'stalled');
      return { blocked: 'stalled_run_halted' };
    }
    return { blocked: 'run_in_progress' };
  }

  // Due-now first: one claimable eligible-due doc is enough.  Do not wait
  // for UTC midnight or AUTOPILOT_BACKLOG_THRESHOLD.  minIntervalMinutes
  // applies only to the leftover >150 storm path so it cannot park due work.
  // Daily UTC is catch-up when nothing is due now — never the only start.
  const day = budgetDay(now);
  let trigger: AutopilotStartTrigger | null = null;
  let backlog: number | null = null;
  try {
    const eligibleDue = await countEligibleDueDocs(env, now);
    if (eligibleDue != null && eligibleDue >= 1) {
      trigger = 'eligible';
    } else {
      const lastDay = await env.CONFIG_KV.get(KV_LAST_DAY);
      if (lastDay !== day) {
        trigger = 'daily';
      } else {
        backlog = await countEligibleBacklog(env);
        if (backlog != null && backlog > knobs.backlogThreshold) {
          const lastRunRaw = await env.CONFIG_KV.get(KV_LAST_RUN_AT);
          const lastRunAt = lastRunRaw ? Date.parse(lastRunRaw) : Number.NaN;
          if (!Number.isFinite(lastRunAt)
            || now.getTime() - lastRunAt >= knobs.minIntervalMinutes * 60 * 1000) {
            trigger = 'backlog';
          }
        }
      }
    }
  } catch {
    return null; // no KV → skip rather than risk a run storm every minute
  }
  if (!trigger) return { blocked: 'not_due' };
  if (backlog == null) backlog = await countEligibleBacklog(env);

  // Stamp BEFORE starting so the next cron tick can't double-start.
  try {
    await env.CONFIG_KV.put(KV_LAST_DAY, day, { expirationTtl: 172800 });
    await env.CONFIG_KV.put(KV_LAST_RUN_AT, now.toISOString(), { expirationTtl: 7 * 86400 });
  } catch {
    return null;
  }

  const runId = uuid();
  const nowIso = now.toISOString();
  try {
    await run(
      env.DB,
      `INSERT INTO autopilot_runs
         (id, status, run_trigger, backlog_before, budget_microusd, started_at, updated_at)
       VALUES (?, 'running', ?, ?, ?, ?, ?)`,
      [runId, trigger, backlog, knobs.dailyBudgetMicroUsd, nowIso, nowIso],
    );
  } catch (err) {
    console.warn('autopilot: run insert failed:', (err as Error).message);
    return null;
  }
  try {
    await env.INGEST_QUEUE.send({ type: 'autopilot.tick', runId, tickId: uuid() });
  } catch (err) {
    console.warn('autopilot: tick enqueue failed:', runId, (err as Error).message);
    await markAutopilotRunHalted(env, runId, 'tick_enqueue_failed');
    return { blocked: 'stalled_run_halted' };
  }
  console.log(`autopilot: run ${runId} started (trigger=${trigger}, backlog=${backlog ?? 'unknown'})`);
  return { started: { runId, trigger } };
}

// ---------------------------------------------------------------------------
// Queue consumer — process a slice of the run, then re-enqueue or finalize
// ---------------------------------------------------------------------------

export interface AutopilotTickDeps {
  /** Injectable for tests; defaults to the real cascade entry point. */
  check?: typeof handleAgreementCheck;
  /** Injectable for tests; defaults to R2-bytes + ensureDocClass. */
  classify?: (
    env: Env,
    docId: string,
    rawObjectKey: string,
    signal?: AbortSignal,
  ) => Promise<DocClass | null>;
  /** Injectable for tests; defaults to Math.random (empty spot-check sampling). */
  random?: () => number;
  /** Abort work immediately when the owning durable queue lease is lost. */
  signal?: AbortSignal;
}

/** Default classification path: load raw bytes and run the two-tier classifier. */
async function classifyFromR2(
  env: Env,
  docId: string,
  rawObjectKey: string,
  signal?: AbortSignal,
): Promise<DocClass | null> {
  try {
    signal?.throwIfAborted();
    const obj = await env.RAW_FILES.get(rawObjectKey);
    if (!obj) return null;
    const bytes = await obj.arrayBuffer();
    signal?.throwIfAborted();
    const result = signal
      ? await ensureDocClass(env, docId, bytes, undefined, { signal })
      : await ensureDocClass(env, docId, bytes);
    signal?.throwIfAborted();
    return result.docClass;
  } catch (err) {
    signal?.throwIfAborted();
    console.warn('autopilot: doc classification failed:', docId, (err as Error).message);
    return null;
  }
}

/** Quarantine a corrupt doc: suppress the cascade, keep it in human review. */
async function quarantineCorruptDoc(env: Env, docId: string): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const result = await run(
    env.DB,
    `UPDATE review_queue
        SET agreement_suppressed_at = ?, agreement_suppression_reason = 'doc_class_corrupt',
            review_revision = review_revision + 1
      WHERE doc_id = ? AND resolved = 0 AND agreement_suppressed_at IS NULL`,
    [nowIso, docId],
  );
  if ((result.meta?.changes ?? 0) === 0) return false;
  await recordIngestionDecision(env.DB, {
    docId,
    action: 'doc_quarantined',
    source: 'pipeline',
    reason: 'doc_class_corrupt',
    payload: { resolvedBy: 'backlog-autopilot', docClass: 'corrupt' },
  });
  return true;
}

/**
 * Auto-resolve an empty doc as no-transactions. Lease-respecting guarded
 * UPDATE — a claimed/suppressed/resolved row is never touched.
 *
 * This is the ONLY 'verified_empty' write path: resolution_kind + a
 * non-blank resolution_reason are set in the SAME statement that flips
 * resolved=1 (trg_review_queue_honest_resolution, migration 0082, aborts any
 * UPDATE that doesn't), and filings.ingest_status moves off 'needs_review' to
 * 'verified_empty' in the same atomic batch. Previously this only touched
 * review_queue — filings.ingest_status was left stuck at 'needs_review'
 * forever, and review_queue recorded no reason on the row itself (only a
 * companion ingestion_decisions audit row) — the exact production bug this
 * migration fixes (3,497 review_queue rows all resolved=1, 738 with zero live
 * transactions, 180 filings stuck at needs_review despite a "resolved" queue
 * row).
 */
async function resolveEmptyDoc(env: Env, docId: string, now: Date): Promise<boolean> {
  const leaseExpired = new Date(now.getTime() - AGREEMENT_CLAIM_LEASE_MS).toISOString();
  const results = await batch(env.DB, [
    [
      `UPDATE review_queue
          SET resolved = 1, agreement_next_attempt_at = NULL,
              agreement_claim_token = NULL, agreement_claimed_at = NULL,
              resolution_kind = 'verified_empty',
              resolution_reason = 'doc_class_empty_no_transactions',
              resolved_at = CURRENT_TIMESTAMP,
              review_revision = review_revision + 1
        WHERE doc_id = ? AND resolved = 0 AND agreement_suppressed_at IS NULL
          AND (agreement_claim_token IS NULL OR agreement_claimed_at IS NULL OR agreement_claimed_at <= ?)`,
      [docId, leaseExpired],
    ],
    [
      `UPDATE filings
          SET ingest_status = 'verified_empty', error = NULL
        WHERE doc_id = ?
          AND ingest_status <> 'persisted'
          AND NOT EXISTS (SELECT 1 FROM transactions WHERE doc_id = ? AND deprecated_at IS NULL)
          AND EXISTS (
            SELECT 1 FROM review_queue
             WHERE doc_id = ? AND resolved = 1 AND resolution_kind = 'verified_empty'
          )`,
      [docId, docId, docId],
    ],
  ]);
  if ((results[0]?.meta?.changes ?? 0) === 0) return false;
  await recordIngestionDecision(env.DB, {
    docId,
    action: 'auto_resolved_empty',
    source: 'pipeline',
    reason: 'doc_class_empty_no_transactions',
    payload: { resolvedBy: 'backlog-autopilot', docClass: 'empty' },
  });
  return true;
}

export async function handleAutopilotTick(
  env: Env,
  runId: string,
  deps: AutopilotTickDeps = {},
  now = new Date(),
): Promise<void> {
  deps.signal?.throwIfAborted();
  const check = deps.check ?? handleAgreementCheck;
  const classify = deps.classify ?? classifyFromR2;
  const random = deps.random ?? Math.random;
  const knobs = await resolveAutopilotKnobs(env);
  let row: AutopilotRunRow | null;
  try {
    row = await get<AutopilotRunRow>(env.DB, 'SELECT * FROM autopilot_runs WHERE id = ?', [runId]);
  } catch {
    deps.signal?.throwIfAborted();
    return;
  }
  if (!row || row.status !== 'running') return; // stale/duplicate tick
  let revision = row.revision;
  const state = parseRunState(row);
  const seenDocIds = state.outcomes.map((outcome) => outcome.docId);
  // Minute-tick eligible drain is one selector-eligible-due doc.  Daily
  // UTC and threshold backlog runs keep the configured pilot cap.
  const maxDocsThisRun = row.run_trigger === 'eligible' ? 1 : knobs.maxDocsPerRun;
  const day = budgetDay(now);
  const eraStart = currentEraStart(now);

  // Reconcile stale submission intents even when operators disable new
  // pre-seeding. Provider polling remains gated by the live feature flag.
  await pollAutopilotPreseedBatches(
    env,
    day,
    deps.signal,
    () => new Date(),
    knobs.preseedEnabled,
  ).catch((err) => {
    deps.signal?.throwIfAborted();
    console.warn('autopilot: preseed reconciliation failed:', (err as Error).message);
  });

  const agreementEnv = await resolveAgreementEnv(env);
  const attemptCap = maxAttempts(agreementEnv);
  const preseedQueue = new Map<string, Array<{ docId: string; rawObjectKey: string }>>();

  const noteError = (cls: ProviderErrorClass, text: string | null | undefined): void => {
    state.errorClassCounts[cls] = (state.errorClassCounts[cls] ?? 0) + 1;
    if (!state.sampleErrors[cls] && text) state.sampleErrors[cls] = text.slice(0, 240);
  };
  const finalize = async (
    status: 'completed' | 'halted',
    reason: string,
  ): Promise<void> => {
    const next = await persistRunState(env, runId, revision, state, { status, haltReason: reason });
    if (next != null) revision = next;
    console.log(`autopilot: run ${runId} ${status} (${reason}); `
      + `attempted=${state.docsAttempted} published=${state.docsPublished} `
      + `deferred=${state.docsDeferred} spend=$${(state.spendMicro / MICRO).toFixed(4)}`);
    if (status === 'halted') await pageExtractionHalt(env, reason);
  };

  let finished = false;
  let haltedByErrors = false;

  for (let slot = 0; slot < DOCS_PER_TICK && !finished; slot++) {
    if (seenDocIds.length >= maxDocsThisRun) {
      await finalize('completed', 'max_docs_reached');
      finished = true;
      break;
    }

    // A prior worker may have completed provider work (and even published the
    // document) before dying ahead of autopilot settlement/state persistence.
    // Reconcile that stable run/revision reservation before selecting anything
    // else, because the original document may no longer be eligible to select.
    const outstanding = await outstandingAutopilotReservation(env, runId, revision);
    if (outstanding) {
      if (outstanding.status === 'reserved') {
        await settleAutopilotBudget(
          env,
          outstanding.reservation_id,
          outstanding.day,
          Number(outstanding.reserved_microusd),
          Number(outstanding.reserved_microusd),
          'aborted',
        );
      }
      const recoveredMicro = Number(
        outstanding.actual_microusd ?? outstanding.reserved_microusd,
      );
      if (!seenDocIds.includes(outstanding.docId)) seenDocIds.push(outstanding.docId);
      state.docsDeferred += 1;
      state.spendMicro += recoveredMicro;
      state.outcomes.push({
        docId: outstanding.docId,
        outcome: 'deferred',
        reason: 'budget_reservation_recovered',
        spendUsd: Math.round((recoveredMicro / MICRO) * 10_000) / 10_000,
      });
      state.skipReasons.budget_reservation_recovered
        = (state.skipReasons.budget_reservation_recovered ?? 0) + 1;
      const next = await persistRunState(env, runId, revision, state);
      if (next == null) return;
      revision = next;
      continue;
    }

    let doc: EligibleDoc | null;
    try {
      doc = await selectNextDoc(env, attemptCap, seenDocIds, eraStart, new Date(), knobs.legacyReplayEnabled);
    } catch (err) {
      console.warn('autopilot: doc selection failed:', (err as Error).message);
      await finalize('halted', 'selector_failed');
      finished = true;
      break;
    }
    if (!doc) {
      await finalize('completed', 'backlog_drained');
      finished = true;
      break;
    }
    seenDocIds.push(doc.doc_id);
    const chamber = doc.chamber
      || (doc.doc_id.startsWith('E-') ? 'executive' : doc.doc_id.startsWith('S-') ? 'senate' : 'house');

    // Pre-extraction classification (persisted from selection or computed now;
    // deterministic-first, one ~free model call only for ambiguous scans).
    let docClass = doc.doc_class && (['typed', 'clean_scan', 'hard_scan', 'empty', 'corrupt'] as const)
      .includes(doc.doc_class as DocClass) ? doc.doc_class as DocClass : null;
    if (!docClass && doc.raw_object_key) {
      docClass = deps.signal
        ? await classify(env, doc.doc_id, doc.raw_object_key, deps.signal)
        : await classify(env, doc.doc_id, doc.raw_object_key);
      deps.signal?.throwIfAborted();
    }

    // corrupt → quarantine immediately: suppress the cascade so no model
    // spend ever lands on an unreadable document; humans keep the review item.
    if (docClass === 'corrupt') {
      const quarantined = await quarantineCorruptDoc(env, doc.doc_id).catch(() => {
        deps.signal?.throwIfAborted();
        return false;
      });
      state.docsDeferred += 1;
      state.outcomes.push({
        docId: doc.doc_id,
        outcome: quarantined ? 'quarantined' : 'deferred',
        reason: quarantined ? 'doc_class_corrupt' : 'quarantine_conflict',
        docClass,
      });
      state.skipReasons.doc_class_corrupt = (state.skipReasons.doc_class_corrupt ?? 0) + 1;
      const next = await persistRunState(env, runId, revision, state);
      if (next == null) return;
      revision = next;
      continue;
    }

    // empty → auto-resolve as no-transactions, keeping a sampled fraction in
    // review as a human spot-check on the classifier itself.
    if (docClass === 'empty') {
      if (random() < knobs.emptySpotcheckRate) {
        state.docsDeferred += 1;
        state.outcomes.push({
          docId: doc.doc_id, outcome: 'deferred', reason: 'empty_spot_check', docClass,
        });
        state.skipReasons.empty_spot_check = (state.skipReasons.empty_spot_check ?? 0) + 1;
      } else {
        const resolved = await resolveEmptyDoc(env, doc.doc_id, new Date()).catch(() => {
          deps.signal?.throwIfAborted();
          return false;
        });
        if (resolved) {
          state.docsAttempted += 1;
          state.outcomes.push({
            docId: doc.doc_id, outcome: 'resolved_empty', reason: 'no_transactions', docClass,
          });
        } else {
          state.docsDeferred += 1;
          state.outcomes.push({
            docId: doc.doc_id, outcome: 'deferred', reason: 'empty_resolve_conflict', docClass,
          });
          state.skipReasons.empty_resolve_conflict
            = (state.skipReasons.empty_resolve_conflict ?? 0) + 1;
        }
      }
      const next = await persistRunState(env, runId, revision, state);
      if (next == null) return;
      revision = next;
      continue;
    }

    const trio = resolveModelsWithC(agreementEnv, chamber);

    // Monitor-informed advisory backoff (early, non-blocking — composes
    // UNDER the hard per-run/per-day $ budget reserved below): when the API
    // Usage Monitor's cross-app budget-status reports EVERY provider this
    // doc's trio would call as already at/over its monthly budget, defer the
    // doc instead of spending on providers with no budget headroom anyway.
    // Fails open (never defers) when the monitor is disabled/unreachable —
    // see shared/monitorBudgetGate.ts.
    if (trio) {
      const throttle = await allProvidersThrottled(env, [trio.a.provider, trio.b.provider, trio.c.provider]);
      if (throttle.throttled) {
        state.docsDeferred += 1;
        state.outcomes.push({
          docId: doc.doc_id,
          outcome: 'deferred',
          reason: 'provider_budget_throttled',
          docClass,
        });
        state.skipReasons.provider_budget_throttled = (state.skipReasons.provider_budget_throttled ?? 0) + 1;
        console.log(`autopilot: deferring doc ${doc.doc_id} (${throttle.decision?.reason ?? 'provider budget throttled'})`);
        const next = await persistRunState(env, runId, revision, state);
        if (next == null) return; // lost ownership to a concurrent consumer
        revision = next;
        continue;
      }
    }

    // Batch pre-seeding: defer this doc onto the cheaper batch transport when
    // its trio has direct batch-capable models with no cached read yet.
    if (knobs.preseedEnabled && trio && doc.raw_object_key) {
      const missing = await missingDirectBatchReads(env, doc.doc_id, trio);
      if (missing.length) {
        for (const model of missing) {
          const key = `${model.provider}:${model.model}`;
          const queue = preseedQueue.get(key) ?? [];
          queue.push({ docId: doc.doc_id, rawObjectKey: doc.raw_object_key });
          preseedQueue.set(key, queue);
        }
        state.docsDeferred += 1;
        state.outcomes.push({ docId: doc.doc_id, outcome: 'deferred', reason: 'batch_preseed' });
        state.skipReasons.batch_preseed = (state.skipReasons.batch_preseed ?? 0) + 1;
        const next = await persistRunState(env, runId, revision, state);
        if (next == null) return; // lost ownership to a concurrent consumer
        revision = next;
        continue;
      }
    }

    // Reserve the rate-card estimate BEFORE any model call. Fails closed.
    const estimateMicro = estimateDocCostMicro(trio, doc.page_count);
    const budgetSettlementId = `autopilot:${runId}:${doc.doc_id}:r${revision}`;
    let reserved: 'created' | 'replay_reserved' | 'replay_settled' | false;
    try {
      reserved = await reserveAutopilotBudget(
        env,
        budgetSettlementId,
        day,
        estimateMicro,
        knobs.dailyBudgetMicroUsd,
      );
    } catch (err) {
      deps.signal?.throwIfAborted();
      console.warn('autopilot: budget reserve failed (failing closed):', (err as Error).message);
      await finalize('halted', 'budget_unavailable');
      finished = true;
      break;
    }
    if (!reserved) {
      await finalize('completed', 'budget_exhausted');
      finished = true;
      break;
    }
    if (reserved !== 'created') {
      // Redelivery before run-state persistence must never repeat paid model
      // calls. Close an ambiguous still-reserved receipt conservatively at the
      // estimate; terminal receipts are already settled and replay as no-ops.
      if (reserved === 'replay_reserved') {
        await settleAutopilotBudget(
          env,
          budgetSettlementId,
          day,
          estimateMicro,
          estimateMicro,
          'aborted',
        );
      }
      state.docsDeferred += 1;
      state.outcomes.push({
        docId: doc.doc_id,
        outcome: 'deferred',
        reason: 'budget_reservation_replay',
        spendUsd: Math.round((estimateMicro / MICRO) * 10_000) / 10_000,
        docClass,
      });
      state.skipReasons.budget_reservation_replay
        = (state.skipReasons.budget_reservation_replay ?? 0) + 1;
      const next = await persistRunState(env, runId, revision, state);
      if (next == null) return;
      revision = next;
      continue;
    }

    // Run the SAME cascade machinery the per-minute cron uses — same leases,
    // attempt caps, LLM read budget, and publish safety. One attempt per
    // model per doc within this run; failures are recorded, never retried.
    const docStartIso = new Date().toISOString();
    let res: AgreementDocResult | null = null;
    let thrown: string | null = null;
    let abortError: unknown = null;
    try {
      deps.signal?.throwIfAborted();
      res = deps.signal
        ? await check(
            env,
            doc.doc_id,
            doc.raw_object_key,
            undefined,
            undefined,
            deps.signal,
          )
        : await check(env, doc.doc_id, doc.raw_object_key);
      deps.signal?.throwIfAborted();
    } catch (err) {
      if (deps.signal?.aborted) abortError = err;
      else thrown = (err as Error).message ?? String(err);
    }

    // Settle exactly once through the lease-independent accounting capability.
    // When ownership disappears before extraction_runs can be read, retain the
    // conservative estimate as the paid-attempt receipt instead of leaking or
    // refunding a provider call whose response may already have arrived.
    const reads = abortError ? [] : await loadDocReads(env, doc.doc_id, docStartIso);
    const actualMicro = abortError ? estimateMicro : priceDocReadsMicro(reads, doc.page_count);
    await settleAutopilotBudget(
      env,
      budgetSettlementId,
      day,
      estimateMicro,
      actualMicro,
      abortError ? 'aborted' : thrown ? 'failed' : 'completed',
    );
    if (abortError) throw abortError;
    state.spendMicro += actualMicro;
    for (const read of reads) {
      if (read.ok) continue;
      noteError(classifyProviderErrorClass(read.error) ?? 'other', read.error);
    }
    if (thrown) noteError(classifyProviderErrorClass(thrown) ?? 'other', thrown);

    state.docsAttempted += 1;
    const outcome = thrown ? 'error' : res?.outcome ?? 'skipped';
    if (outcome === 'published') state.docsPublished += 1;
    else state.docsDeferred += 1;
    const reason = thrown ? thrown.slice(0, 160) : res?.reason;
    state.outcomes.push({
      docId: doc.doc_id,
      outcome,
      ...(reason ? { reason } : {}),
      spendUsd: Math.round((actualMicro / MICRO) * 10_000) / 10_000,
      docClass,
    });
    if (outcome !== 'published') {
      const bucket = reason ?? outcome;
      state.skipReasons[bucket] = (state.skipReasons[bucket] ?? 0) + 1;
    }

    // Error-class kill-switch: same class twice (default) halts the WHOLE
    // run for auth / real spend / parse / timeout. Transient OpenRouter
    // files-prepaid / key-limit 402s and source-fetch / admin Unauthorized
    // are NOT a latch — those auto-resume. Proven invalid_api_key / User
    // not found stay fail-closed.
    const haltClass = KILL_SWITCH_CLASSES.find(
      (cls) => (state.errorClassCounts[cls] ?? 0) >= knobs.errorClassHaltThreshold,
    );
    const haltSamples = Object.values(state.sampleErrors);
    const transientFilesOnly = haltSamples.length > 0
      && haltSamples.every((sample) => isTransientFilesPrepaidError(sample));
    const falseSourceAuthOnly = haltSamples.length > 0
      && haltSamples.every((sample) => isFalseSourceAuthError(sample));
    const docScopedOpenRouterOnly = haltSamples.length > 0
      && haltSamples.every((sample) => isDocScopedOpenRouterError(sample));
    const infraOnly = haltSamples.length > 0
      && haltSamples.every((sample) => isTransientInfrastructureError(sample));
    const skipTransientLatch = (
      (transientFilesOnly && (haltClass === 'billing' || haltClass === 'quota'))
      || (falseSourceAuthOnly && haltClass === 'auth')
      || (docScopedOpenRouterOnly && (haltClass === 'auth' || haltClass === 'parse'))
      || infraOnly
    );
    if (haltClass && !skipTransientLatch) {
      await finalize('halted', `error_class:${haltClass}`);
      finished = true;
      haltedByErrors = true;
      break;
    }
    // The cascade's own daily LLM read budget is gone: nothing more can run
    // today, so end the run cleanly instead of burning selects.
    if (res?.reason === 'llm_budget_exhausted') {
      await finalize('completed', 'agreement_llm_budget_exhausted');
      finished = true;
      break;
    }

    const next = await persistRunState(env, runId, revision, state);
    if (next == null) return; // lost ownership to a concurrent consumer
    revision = next;
  }

  // Submit any collected pre-seed batches (skipped after an error halt: a
  // halted run must stop spending immediately).
  if (preseedQueue.size && !haltedByErrors) {
    await submitPreseedBatches(
      env,
      preseedQueue,
      state,
      runId,
      revision,
      deps.signal,
    )
      .then((next) => { if (next != null) revision = next; })
      .catch((err) => {
        deps.signal?.throwIfAborted();
        console.warn('autopilot: preseed submit failed:', (err as Error).message);
      });
  }

  if (!finished) {
    try {
      // Fresh tickId every continuation — see QueueMessage 'autopilot.tick'
      // docs: re-enqueue happens while this claim is still `processing`.
      await env.INGEST_QUEUE.send({ type: 'autopilot.tick', runId, tickId: uuid() });
    } catch (err) {
      deps.signal?.throwIfAborted();
      console.warn('autopilot: continuation enqueue failed:', runId, (err as Error).message);
      await markAutopilotRunHalted(env, runId, 'tick_enqueue_failed');
    }
  }
}

// ---------------------------------------------------------------------------
// Batch pre-seeding (where supported: direct anthropic/openai/mistral/xai)
// ---------------------------------------------------------------------------

function isDirectBatchProvider(provider: string): provider is BatchProvider {
  return DIRECT_BATCH_PROVIDERS.includes(provider);
}

/** Trio models that could be batch pre-seeded and have no cached ok read yet. */
async function missingDirectBatchReads(
  env: Env,
  docId: string,
  trio: AgreementModelsC,
): Promise<Array<{ provider: BatchProvider; model: string }>> {
  const directModels = [trio.a, trio.b, trio.c]
    .filter((model) => isDirectBatchProvider(model.provider))
    .map((model) => ({ provider: model.provider as BatchProvider, model: model.model }));
  if (!directModels.length) return [];
  let cached: Array<{ provider: string; model: string }> = [];
  try {
    cached = await all<{ provider: string; model: string }>(
      env.DB,
      'SELECT DISTINCT provider, model FROM extraction_runs WHERE doc_id = ? AND ok = 1',
      [docId],
    );
  } catch {
    return []; // no extraction_runs table → no cache to seed; run live instead
  }
  const cachedLabels = new Set(cached.map((row) => `${row.provider}:${row.model}`));
  return directModels.filter((model) => !cachedLabels.has(`${model.provider}:${model.model}`));
}

export interface PreseedSubmitDeps {
  submit?: typeof submitBatch;
  now?: () => Date;
  id?: () => string;
}

export async function submitPreseedBatches(
  env: Env,
  queue: Map<string, Array<{ docId: string; rawObjectKey: string }>>,
  state: RunState,
  runId: string,
  revision: number,
  signal?: AbortSignal,
  deps: PreseedSubmitDeps = {},
): Promise<number | null> {
  const submit = deps.submit ?? submitBatch;
  const now = deps.now ?? (() => new Date());
  const id = deps.id ?? uuid;
  for (const [modelKey, docs] of queue) {
    const [provider, ...modelParts] = modelKey.split(':');
    const model = modelParts.join(':');
    if (!isDirectBatchProvider(provider)) continue;
    const batchDocs: BatchDoc[] = [];
    const seen = new Set<string>();
    for (const docRef of docs) {
      if (seen.has(docRef.docId)) continue;
      seen.add(docRef.docId);
      let obj: Awaited<ReturnType<Env['RAW_FILES']['get']>> | null;
      try {
        obj = await env.RAW_FILES.get(docRef.rawObjectKey);
      } catch {
        signal?.throwIfAborted();
        obj = null;
      }
      if (!obj) continue;
      const chamber: BatchChamber = docRef.docId.startsWith('E-')
        ? 'executive' : docRef.docId.startsWith('S-') ? 'senate' : 'house';
      batchDocs.push({ docId: docRef.docId, chamber, bytes: await obj.arrayBuffer() });
    }
    if (!batchDocs.length) continue;
    const jobId = `${AUTOPILOT_BATCH_ID_PREFIX}${id()}`;
    const submittedAt = now().toISOString();
    try {
      signal?.throwIfAborted();
      // Persist intent before the non-transactional provider call. If the
      // provider accepts work while this worker loses its queue lease, the
      // durable `submitting` row remains as an explicit unknown outcome for
      // reconciliation instead of silently orphaning unmetered work.
      await run(
        env.DB,
        `INSERT INTO batch_jobs
           (id, provider, model, provider_batch_id, doc_ids, status, submitted_at)
         VALUES (?, ?, ?, NULL, ?, 'submitting', ?)`,
        [
          jobId,
          provider,
          model,
          JSON.stringify(batchDocs.map((doc) => doc.docId)),
          submittedAt,
        ],
      );
      const providerBatchId = signal
        ? await submit(env, provider, model, batchDocs, signal)
        : await submit(env, provider, model, batchDocs);
      signal?.throwIfAborted();
      const finalized = await run(
        env.DB,
        `UPDATE batch_jobs
            SET provider_batch_id = ?, status = 'submitted'
          WHERE id = ? AND status = 'submitting'`,
        [providerBatchId, jobId],
      );
      if ((finalized.meta?.changes ?? 0) !== 1) {
        throw new Error('autopilot batch submission intent lost before finalization');
      }
      console.log(`autopilot: pre-seeded ${batchDocs.length} docs via ${modelKey} batch`);
    } catch (err) {
      signal?.throwIfAborted();
      await run(
        env.DB,
        `UPDATE batch_jobs
            SET status = 'submission_unknown', completed_at = ?, error = ?
          WHERE id = ? AND status = 'submitting'`,
        [
          now().toISOString(),
          `provider submission outcome unknown: ${(err as Error).message}`.slice(0, 500),
          jobId,
        ],
      ).catch(() => undefined);
      state.skipReasons.batch_preseed_submit_failed
        = (state.skipReasons.batch_preseed_submit_failed ?? 0) + 1;
      console.warn(`autopilot: batch pre-seed submit failed for ${modelKey}:`, (err as Error).message);
    }
  }
  return persistRunState(env, runId, revision, state);
}

/**
 * Poll outstanding autopilot-submitted batch jobs; persist finished readings
 * into extraction_runs (kind='batch') so the cascade's read cache reuses them,
 * and meter the priced batch spend into the day's autopilot budget.
 */
export async function pollAutopilotPreseedBatches(
  env: Env,
  day: string,
  signal?: AbortSignal,
  now: () => Date = () => new Date(),
  pollProviders = true,
  pollImpl: typeof pollBatch = pollBatch,
): Promise<void> {
  let jobs: Array<{
    id: string;
    provider: string;
    model: string;
    provider_batch_id: string | null;
    status: string;
  }>;
  try {
    const submissionUnknownBefore = new Date(
      now().getTime() - PRESEED_SUBMISSION_UNKNOWN_AFTER_MS,
    ).toISOString();
    // Reconcile abandoned submission intents under their own quota. Mixing
    // these rows into the provider-poll query lets a few older running jobs
    // consume PRESEED_POLL_LIMIT forever and starve an unknown paid side
    // effect from ever becoming explicit.
    const staleSubmissions = await all<{
      id: string;
      provider: string;
      model: string;
      provider_batch_id: string | null;
      status: string;
    }>(
      env.DB,
      `SELECT id, provider, model, provider_batch_id, status FROM batch_jobs
        WHERE id LIKE '${AUTOPILOT_BATCH_ID_PREFIX}%'
          AND status = 'submitting'
          AND submitted_at <= ?
        ORDER BY submitted_at ASC LIMIT ?`,
      [submissionUnknownBefore, PRESEED_SUBMISSION_RECONCILE_LIMIT],
    );
    const providerJobs = pollProviders
      ? await all<{
        id: string;
        provider: string;
        model: string;
        provider_batch_id: string | null;
        status: string;
      }>(
        env.DB,
        `SELECT id, provider, model, provider_batch_id, status FROM batch_jobs
          WHERE id LIKE '${AUTOPILOT_BATCH_ID_PREFIX}%'
            AND status IN ('submitted', 'running')
          ORDER BY submitted_at ASC LIMIT ?`,
        [PRESEED_POLL_LIMIT],
      )
      : [];
    jobs = [...staleSubmissions, ...providerJobs];
  } catch {
    signal?.throwIfAborted();
    return;
  }
  for (const job of jobs) {
    if (job.status === 'submitting' && !job.provider_batch_id) {
      signal?.throwIfAborted();
      await run(
        env.DB,
        `UPDATE batch_jobs
            SET status = 'submission_unknown', completed_at = ?,
                error = 'provider submission outcome unknown after queue lease loss'
          WHERE id = ? AND status = 'submitting'`,
        [now().toISOString(), job.id],
      );
      continue;
    }
    if (!job.provider_batch_id || !isDirectBatchProvider(job.provider)) continue;
    try {
      signal?.throwIfAborted();
      const poll = signal
        ? await pollImpl(env, job.provider, job.provider_batch_id, signal)
        : await pollImpl(env, job.provider, job.provider_batch_id);
      signal?.throwIfAborted();
      if (!poll.done) {
        await run(env.DB, "UPDATE batch_jobs SET status = 'running' WHERE id = ?", [job.id]);
        continue;
      }
      const nowIso = new Date().toISOString();
      if (poll.failed) {
        await run(
          env.DB,
          "UPDATE batch_jobs SET status = 'failed', completed_at = ?, error = ? WHERE id = ?",
          [nowIso, JSON.stringify(poll.providerErrors ?? null), job.id],
        );
        continue;
      }
      let spentUsd = 0;
      for (const result of poll.results) {
        const candidateResult: CandidateDocResult = {
          provider: job.provider as Provider,
          model: job.model,
          docId: result.docId,
          ok: result.ok,
          ...(result.error ? { error: result.error } : {}),
          latencyMs: 0,
          rowCount: result.rows?.length ?? 0,
          rowKeys: (result.rows ?? []).map(arbitrationRowKey),
          avgConfidence: meanConfidence(result.rows ?? []),
          rows: result.rows ?? [],
          ...(result.resolvedModel ? { resolvedModel: result.resolvedModel } : {}),
          ...(result.usage ? { usage: { ...result.usage, serviceTier: 'batch' } } : {}),
        };
        await persistExtractionRun(env, candidateResult, 'batch', job.id);
        if (result.usage) {
          spentUsd += priceBenchmarkUsage({
            provider: job.provider,
            model: job.model,
            invoked: true,
            usage: { ...result.usage, serviceTier: 'batch' },
          }).costUsd ?? 0;
        }
      }
      if (spentUsd > 0) {
        const chargedMicro = Math.ceil(spentUsd * MICRO);
        const batchReservationId = `autopilot-batch:${job.id}`;
        const batchReservation = await reserveAutopilotBudget(
          env,
          batchReservationId,
          day,
          chargedMicro,
          Number.MAX_SAFE_INTEGER,
        );
        if (!batchReservation) throw new Error('autopilot batch budget reservation failed');
        await settleAutopilotBudget(
          env,
          batchReservationId,
          day,
          chargedMicro,
          chargedMicro,
          'completed',
        );
      }
      await run(
        env.DB,
        `UPDATE batch_jobs SET status = 'completed', completed_at = ?, result_summary = ? WHERE id = ?`,
        [
          nowIso,
          JSON.stringify({
            source: 'autopilot-preseed',
            docs: poll.results.length,
            ok: poll.results.filter((result) => result.ok).length,
            spendUsd: Math.round(spentUsd * 10_000) / 10_000,
          }),
          job.id,
        ],
      );
      console.log(`autopilot: pre-seed batch ${job.id} completed (${poll.results.length} docs)`);
    } catch (err) {
      signal?.throwIfAborted();
      console.warn(`autopilot: pre-seed poll failed for ${job.id}:`, (err as Error).message);
    }
  }
}

// ---------------------------------------------------------------------------
// Admin surface — status + halt acknowledgment
// ---------------------------------------------------------------------------

export interface AutopilotRunReceipt {
  id: string;
  status: string;
  trigger: string;
  backlogBefore: number | null;
  docsAttempted: number;
  docsPublished: number;
  docsDeferred: number;
  spendUsd: number;
  budgetUsd: number;
  errorClassCounts: Partial<Record<ProviderErrorClass, number>>;
  sampleErrors: Partial<Record<ProviderErrorClass, string>>;
  outcomes: AutopilotOutcome[];
  skipReasons: Record<string, number>;
  haltReason: string | null;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  startedAt: string;
  finishedAt: string | null;
}

function toReceipt(row: AutopilotRunRow): AutopilotRunReceipt {
  return {
    id: row.id,
    status: row.status,
    trigger: row.run_trigger,
    backlogBefore: row.backlog_before,
    docsAttempted: row.docs_attempted,
    docsPublished: row.docs_published,
    docsDeferred: row.docs_deferred,
    spendUsd: Math.round((row.spend_microusd / MICRO) * 10_000) / 10_000,
    budgetUsd: Math.round((row.budget_microusd / MICRO) * 10_000) / 10_000,
    errorClassCounts: parseJsonOr(row.error_class_counts, {}),
    sampleErrors: parseJsonOr(row.sample_errors, {}),
    outcomes: parseJsonOr(row.outcomes, []),
    skipReasons: parseJsonOr(row.skip_reasons, {}),
    haltReason: row.halt_reason,
    acknowledgedAt: row.acknowledged_at,
    acknowledgedBy: row.acknowledged_by,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export async function getAutopilotStatus(env: Env, now = new Date()): Promise<{
  enabled: boolean;
  knobs: Omit<AutopilotKnobs, 'enabled' | 'dailyBudgetMicroUsd'> & { dailyBudgetUsd: number };
  backlog: number | null;
  reviewQueue: Awaited<ReturnType<typeof countReviewQueueBuckets>>;
  today: { day: string; spendUsd: number; budgetUsd: number };
  unacknowledgedHalt: AutopilotRunReceipt | null;
  runs: AutopilotRunReceipt[];
}> {
  const knobs = await resolveAutopilotKnobs(env);
  const day = budgetDay(now);
  const spendMicro = await todaysSpendMicro(env, day);
  let rows: AutopilotRunRow[] = [];
  try {
    rows = await all<AutopilotRunRow>(
      env.DB,
      'SELECT * FROM autopilot_runs ORDER BY started_at DESC LIMIT 10',
    );
  } catch {
    // Pre-migration: report empty run history.
  }
  const runs = rows.map(toReceipt);
  return {
    enabled: knobs.enabled,
    knobs: {
      backlogThreshold: knobs.backlogThreshold,
      dailyBudgetUsd: knobs.dailyBudgetMicroUsd / MICRO,
      maxDocsPerRun: knobs.maxDocsPerRun,
      errorClassHaltThreshold: knobs.errorClassHaltThreshold,
      minIntervalMinutes: knobs.minIntervalMinutes,
      preseedEnabled: knobs.preseedEnabled,
      emptySpotcheckRate: knobs.emptySpotcheckRate,
      legacyReplayEnabled: knobs.legacyReplayEnabled,
      // Surfaced so the admin page shows which formats the cascade will not
      // spend on, and where that is configured (Infisical AGREEMENT_SKIP_DOC_KINDS).
      skipDocKinds: knobs.skipDocKinds,
    },
    backlog: await countEligibleBacklog(env),
    reviewQueue: await countReviewQueueBuckets(env),
    today: {
      day,
      spendUsd: Math.round((spendMicro / MICRO) * 10_000) / 10_000,
      budgetUsd: knobs.dailyBudgetMicroUsd / MICRO,
    },
    unacknowledgedHalt: runs.find((receipt) => receipt.status === 'halted') ?? null,
    runs,
  };
}

/**
 * Acknowledge a halted run (unblocks the cron gate). With no runId, the most
 * recent halted run is acknowledged. Returns the acknowledged receipt, or
 * null when no halted run matched.
 */
export async function acknowledgeAutopilotHalt(
  env: Env,
  opts: { runId?: string; actor?: string } = {},
): Promise<AutopilotRunReceipt | null> {
  let target = opts.runId ?? null;
  if (!target) {
    try {
      const newest = await get<{ id: string }>(
        env.DB,
        "SELECT id FROM autopilot_runs WHERE status = 'halted' ORDER BY started_at DESC LIMIT 1",
      );
      target = newest?.id ?? null;
    } catch {
      return null;
    }
  }
  if (!target) return null;
  const nowIso = new Date().toISOString();
  const result = await run(
    env.DB,
    `UPDATE autopilot_runs
        SET status = 'halt_acknowledged', acknowledged_at = ?, acknowledged_by = ?,
            updated_at = ?, revision = revision + 1
      WHERE id = ? AND status = 'halted'`,
    [nowIso, opts.actor ?? null, nowIso, target],
  );
  if ((result.meta?.changes ?? 0) === 0) return null;
  const row = await get<AutopilotRunRow>(env.DB, 'SELECT * FROM autopilot_runs WHERE id = ?', [target]);
  return row ? toReceipt(row) : null;
}
