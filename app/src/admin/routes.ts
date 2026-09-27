/**
 * src/admin/routes.ts
 * OWNER: admin agent
 *
 * Admin Hono router (mounted under /api/admin). Endpoints:
 *   GET   /poll-config              -> current PollConfig
 *   PUT   /poll-config              -> update schedule / aggressiveMode (setConfig)
 *   GET   /poll-config/aggressive   -> aggressiveMode toggle convenience read
 *   GET   /review-queue             -> list unresolved review items
 *   POST  /review/:docId            -> {decision:'confirm'|'reject', edits?}
 *   GET   /sources/health           -> ingest_log aggregates per source
 *   GET   /instrument-pricing       -> equities/crypto/options/event-contract capability matrix
 *   GET   /instrument-pricing/at    -> exact-time minute bar lookup (refuses options/event contracts)
 *   GET   /diagnostics              -> connection status + recent app errors
 *   GET   /premium-roster           -> Premium members (trial vs paid, Stripe vs Apple)
 *   GET   /subscriptions            -> admin list of subscriptions
 *   POST  /subscriptions            -> operator-provisioned subscription
 *   POST  /subscriptions/:id/rotate-secret -> rotate signing secret (shown-once if generated)
 *   POST  /subscriptions/:id/deactivate    -> deactivate (drops from fanout, frees creation quota)
 *   POST  /filings-hygiene              -> dry-run (default) / apply probe delete + review desync (#1576/#1574)
 *   POST  /sweep-already-published     -> dry-run (default) / apply already-published review integrity close
 *
 * AUTH (deny-by-default once provisioned). A request is authorized if:
 *   1. Bearer token — env.ADMIN_TOKEN is set and the request carries a matching
 *      `Authorization: Bearer <ADMIN_TOKEN>` (good for curl / cron / automation); OR
 *   2. First-party session — cookie `ct_session` or `Authorization: Bearer
 *      <session>` for an ADMIN_EMAILS user (website cookie; native iOS Bearer);
 *      OR
 *   3. Cloudflare Access — an Access application fronts /api/admin/* and the
 *      `Cf-Access-Jwt-Assertion` JWT verifies against the team keys with an
 *      `aud` matching ACCESS_AUD and an authenticated email on ADMIN_EMAILS
 *      (good for humans signing in with Google/SSO — no token to paste).
 *
 *   The surface fails closed when no auth mechanism is configured. For local
 *   development only, set ADMIN_OPEN_IN_DEV=true to open it explicitly.
 *   Provision `wrangler secret put ADMIN_TOKEN`, and/or set ADMIN_EMAILS +
 *   ACCESS_AUD + ACCESS_TEAM_DOMAIN (with an Access app in front), to lock down.
 */

import { Hono, type Context } from 'hono';
import {
  AnalystRowSchema,
  FundamentalRowSchema,
  InsiderRowSchema,
  PriceCloseSchema,
  PriceSeriesSchema,
  SecurityRefInputSchema,
  ShortVolumeRowSchema,
} from '@jaywedgeworth22/congress-trading-shared';
import type { Env, ParsedTx, PollConfig, PollWindow, TxType, TxSource, Subscription, DocKind, Chamber, Filing } from '../shared/types.ts';
import { all, batch, batchPrepared, chunkArray, first, get, run, type SqlParam } from '../shared/db.ts';
import { checkReadiness } from '../shared/readiness.ts';
import { HOUSE_ASSET_TYPE_NAMES } from '../shared/assetTypes.ts';
import { listIngestionDecisions, recordIngestionDecision } from '../shared/ingestionDecisions.ts';
import { activeWindow, effectiveInterval, getConfig, setConfig } from '../shared/config.ts';
import { uuid } from '../shared/ids.ts';
import { runCommitteeSync } from '../enrichment/committeeSync.ts';
import { buildLegislatorMap, normName } from '../enrichment/legislators.ts';
import {
  isMemberPhotoPackUrl,
  memberPhotoUrl,
  packFaceForKey,
  packFacesWithFilerIds,
} from '../enrichment/memberPhotoPack.ts';
import { runIdentitySync } from '../enrichment/identitySync.ts';
import {
  assertSubscriptionQuota,
  createSubscription,
  deactivateSubscription,
  getSubscription,
  listSubscriptions,
  rotateSubscriptionSecret,
  rotateSubscriptionSecretError,
  SubscriptionQuotaError,
  subscriptionSecretError,
  validateAndResolveSubscriptionFilters,
  webhookTargetLengthError,
} from '../delivery/subscriptions.ts';
import { localWebhookTargetsAllowed, validatePublicWebhookTarget } from '../delivery/webhookTarget.ts';
import { apnsLaneErrorIsRecent, inspectApnsFanoutDiagnostics, resolveApnsConfig } from '../delivery/apnsFanout.ts';
import { apnsConfigured } from '../shared/apns.ts';
import { runSeedBackfillFromEnv } from '../backfill/seed.ts';
import { runFmpSenateRecovery } from '../backfill/fmpSenateRecovery.ts';
import { runHouseHistoricalBackfill } from '../backfill/houseCrawler.ts';
import { runSenateBackfill } from '../backfill/senateCrawler.ts';
import { extractParsed } from '../extraction/orchestrator.ts';
import {
  normalize,
  recomputeTransactions,
  transactionRowKey,
  loadResolver,
  CONFIDENCE_THRESHOLD,
  HARD_FAILURE_FLAGS,
  hasHardFailureFlags,
} from '../extraction/normalizer.ts';
import { storedReviewBlocksSmallerVisionSubmit, storedReviewTransactionCount } from '../extraction/visionSubmitGuard.ts';
import { PIPELINE_TX_SOURCES_SQL, VISION_SUPERSEDE_REASON } from '../extraction/sourceSupersede.ts';
import { EXTRACTION_PROMPT_VERSION } from '../extraction/visionLlm.ts';
import { deprecatePredecessorFilingTransactions, duplicateLineupReason, enqueueAgreementCheck, processAgreementDoc, loadDocBytes, loadFilingRow, sameRowSet, type AgreementModels } from '../extraction/agreement.ts';
import { acknowledgeAutopilotHalt, getAutopilotStatus } from '../extraction/autopilot.ts';
import { providerHealthDiagnostics } from '../extraction/providerHealth.ts';
import { buildCoverageScorecard } from './coverageScorecard.ts';
import { instrumentPricingPayload, lookupExactPriceForAdmin } from './instrumentPricing.ts';
import {
  readOpenRouterBudgetCircuit,
  resolveOpenRouterBudgetCircuitKnobs,
} from '../shared/openRouterBudgetCircuit.ts';
import { readLlmSpend, readLlmSpendWeekAndMonth } from '../shared/llmSpend.ts';
import { fetchLlamaParseCredits } from '../extraction/llamaParseCredits.ts';
import { mapFiling } from '../delivery/rows.ts';
import { verifyAccessJwt, certsUrl } from './access.ts';
import { adminRuntimeConfig } from './identity.ts';
import { buildPremiumRoster, localPremiumCounts } from './premiumRoster.ts';
import { getLogoDisplay, setLogoDisplay } from '../shared/settings.ts';
import { normalizeCompanyName } from '../shared/companyName.ts';
import { cleanFilerName } from '../extraction/nameNormalizer.ts';
import {
  MEMBER_FILER_MERGES,
  MEMBER_NAME_ALIASES,
  type MemberFilerMerge,
} from '../shared/memberIdentity.ts';
import { dedupeSplitFilerIdentities } from './filerIdentityDedupe.ts';
import { constantTimeEqual } from '../auth/tokens.ts';
import { getCurrentUserFromRequest } from '../auth/session.ts';
import {
  DEFAULT_CANDIDATES,
  EXTRACTION_SCHEMA_VERSION,
  isRetiredDisclosureCandidate,
  keyFor,
  runCandidateOnDoc,
  summarizeModels,
  type BakeoffCandidate,
  type CandidateDocResult,
  type Provider,
} from '../extraction/bakeoff.ts';
import {
  isBatchProvider,
  normalizeBatchChamber,
  submitBatch,
  pollBatch,
  BatchTerminalPayloadError,
  type BatchDoc,
  type BatchUsage,
} from '../extraction/batchExtract.ts';
import { buildConsensusRows, type ConsensusRun } from '../extraction/consensus.ts';
import {
  runEnrichment,
  getDailyUsed,
  prepareImportSecurityRef,
  enrichmentNeededSql,
  hasConfiguredKeyedEnrichmentProvider,
} from '../enrichment/service.ts';
import { mergeRefs } from '../enrichment/compute.ts';
import type { SecurityRef } from '../enrichment/types.ts';
import {
  runPriceRefresh,
  priceUnavailableCutoffIso,
  priceUnavailableFirstRecheckCutoffIso,
  PRICE_UNAVAILABLE_NOT_FOUND_FIRST,
} from '../prices/service.ts';
import { getSecretResolverStatus, refreshSecrets, resolveSecret, resolveSecrets, updateSecret } from '../secrets/infisical.ts';
import {
  backfillTradeLatencyCandidates,
  getDisclosureLatencySummary,
  rematchAndHealLatencyRaces,
  runDisclosureLatencyProbe,
} from '../ingestion/tradeLatency.ts';
import { pollExecutive } from '../ingestion/watcher.ts';
import { verifyRawFilesStorage } from './storageSmoke.ts';

function isObjectStoreAuthError(message: string): boolean {
  return /\bunauthorized\b|\baccessdenied\b|\binvalidaccesskeyid\b|\bsignaturedoesnotmatch\b/i.test(message);
}
import { flushIngestionOutbox, requeueFailedIngestionOutbox } from '../ingestion/outbox.ts';
import { PROVIDER_STUB_DUPLICATE_REJECT_PREFIX } from '../ingestion/providerMissingStubClose.ts'
import {
  listAlreadyPublishedReviewCandidates,
  sweepAlreadyPublishedReviewRows,
} from '../ingestion/autonomySweeps.ts';
import {
  requeueTransientFailedDurableJobs,
  requeueTransientFailedIngestionOutbox,
} from '../ingestion/transientDlq.ts';
import { estimateTransactionValue } from '../shared/transactionValue.ts';
import { isValidBracket } from '../shared/brackets.ts';
import { flushDeliveryOutbox } from '../delivery/outbox.ts';
import { resolveDenoCostProfile } from '../deno/costProfile.ts';
import { createRuntimeQueueHandlers } from '../deno/runtimeHandlers.ts';
import { runScheduledTick } from '../deno/scheduledTick.ts';
import { requeueFailedDurableJobs } from '../deno/durableQueue.ts';
import { readTargetCircuits } from '../delivery/targetCircuit.ts';
import { inspectLlmSpend } from '../shared/llmSpend.ts';
import { runR2UsageSummary } from '../shared/r2Usage.ts';
import {
  beginBenchmarkRun,
  claimBenchmarkMeasurement,
  clearBenchmarkRuns,
  completeBenchmarkRun,
  failBenchmarkRun,
  getBenchmarkRun,
  getRunningBenchmarkRun,
  listBenchmarkRuns,
  recordBenchmarkSelection,
  releaseBenchmarkMeasurementClaim,
  rescoreBenchmarkRun,
  reuseSuccessfulBenchmarkMeasurements,
  saveBenchmarkMeasurement,
  saveUnavailableBenchmarkMeasurementsIfAbsent,
  updateBenchmarkRunRequestProfile,
  BenchmarkActiveRunConflictError,
  BenchmarkRunStateConflictError,
  BENCHMARK_CHAMBERS,
  type BenchmarkChamber,
  type BenchmarkModelRef,
  type BenchmarkRunDetail,
  type BenchmarkSelectedLineup,
} from '../benchmark/persistence.ts';
import {
  checkOpenAiModelAccess,
  openAiModelAccessDecision,
  OPENAI_BENCHMARK_ACCESS_MODELS,
} from '../benchmark/providerAccess.ts';
import {
  BenchmarkSettingsConflictError,
  BenchmarkSettingsValidationError,
  BenchmarkSettingsWriteError,
  getUnderlyingProvider,
  isOpenRouterAuto,
  readBenchmarkLineupSettings,
  readBenchmarkRoleSettings,
  saveBenchmarkLineupSettings,
  saveBenchmarkRoleSettings,
  type BenchmarkSelectedRoles,
  validateBenchmarkLineup,
  validateBenchmarkModel,
  validateBenchmarkRoles,
} from '../benchmark/settings.ts';
import {
  priceBenchmarkUsage,
  simulateCascadeDocumentMetrics,
  summarizeBenchmarkLatency,
} from '../extraction/benchmarkMetrics.ts';
import { BENCHMARK_SCORING_PROFILE, compareBenchmarkRows } from '../benchmark/scoring.ts';
import {
  benchmarkCanaryTarget,
  findProviderFailureBlock,
  modelsAffectedByProviderFailure,
  type ProviderFailureBlock,
  type ProviderFailureSource,
  type ProviderFailureStatus,
} from '../extraction/providerFailure.ts';
import { pushExtractionTelemetry } from '../extraction/telemetry.ts';
import { enhanceSenateHtmlDocument } from '../extraction/senatePaperMedia.ts';
import {
  inspectUsageTelemetryFallback,
  recordMeasuredThirdPartyUsage,
  stableMeasuredUsageIdempotencyKey,
  trackedFetch,
} from '../shared/thirdPartyTelemetry.ts';
import {
  BASE_SCHEMA_STATEMENTS,
  DISCLOSURE_AVAILABLE_SCHEMA_STATEMENTS,
  POST_0024_SCHEMA_STATEMENTS,
  CLEAN_PLACEHOLDER_TICKERS_SCHEMA_STATEMENTS,
} from './migrations.ts';
import { getQualityCrosscheck } from '../analytics/quality.ts';
import { runFilingsHygiene } from '../ingestion/reviewStatusReconcile.ts';
import { notifyReviewQueuePublisher } from '../ingestion/reviewQueueNotify.ts';
import {
  grantAdmin,
  revokeAdmin,
  listGrantedAdmins,
  normalizeAdminEmail,
} from './adminAccess.ts';

// Optional secrets/vars; not declared on Env (frozen). Read defensively.
type EnvWithAdmin = Env & {
  /** Shared bearer token for automation. */
  ADMIN_TOKEN?: string;
  /** Comma/space-separated email allowlist for Cloudflare Access sign-in. */
  ADMIN_EMAILS?: string;
  /** Access team name ("myteam") or hostname ("myteam.cloudflareaccess.com"). */
  ACCESS_TEAM_DOMAIN?: string;
  /** Cloudflare Access application AUD tag. */
  ACCESS_AUD?: string;
  /** Local-only escape hatch. Production should leave this unset/false. */
  ADMIN_OPEN_IN_DEV?: string;
  /**
   * Scoped bearer token that unlocks ONLY POST /securities/import (the
   * cross-app data-sharing endpoint). Lets a sibling app push FMP data without
   * holding the full ADMIN_TOKEN. Optional; ignored if unset.
   */
  INGEST_TOKEN?: string;
  /**
   * Scoped bearer token that unlocks ONLY the low-risk, idempotent
   * operational-maintenance endpoints (MAINTENANCE_PATH_SUFFIXES below).
   * Lets agent/automation sessions run backlog drains without holding the
   * full ADMIN_TOKEN — same pattern as INGEST_TOKEN. Optional; ignored if
   * unset. Worst case if leaked: someone re-runs an idempotent requeue.
   */
  ADMIN_MAINTENANCE_TOKEN?: string;
};

/** The ONLY admin paths ADMIN_MAINTENANCE_TOKEN unlocks. Keep this list to
 * idempotent, non-destructive recovery operations — never migrations, review
 * resolution, config writes, or anything that changes published data. */
const MAINTENANCE_PATH_SUFFIXES = [
  '/ingest-requeue-failed',
  '/ingest-retry-errored',
  // External free-tier scheduler (Coolify/cron) may drive the same tick body as
  // Deno.cron without holding full ADMIN_TOKEN. Worst case if leaked: someone
  // advances the normal watcher/outbox/queue path (already idempotent / leased).
  '/runtime-tick',
];

const LATENCY_RESET_KEY = 'admin:source_health:latency_reset_at';

/** True when the request is a bearer-authenticated call to the import endpoint. */
async function isAuthorizedIngest(
  env: EnvWithAdmin,
  path: string,
  authorization?: string,
): Promise<boolean> {
  const token = (await resolveSecret(env, 'INGEST_TOKEN')).value;
  return (
    !!token &&
    path.endsWith('/securities/import') &&
    (await constantTimeEqual(authorization ?? '', `Bearer ${token}`))
  );
}

/** True when the request is a bearer-authenticated call to a maintenance endpoint. */
async function isAuthorizedMaintenance(
  env: EnvWithAdmin,
  path: string,
  authorization?: string,
): Promise<boolean> {
  const token = (await resolveSecret(env, 'ADMIN_MAINTENANCE_TOKEN')).value;
  return (
    !!token &&
    MAINTENANCE_PATH_SUFFIXES.some((suffix) => path.endsWith(suffix)) &&
    (await constantTimeEqual(authorization ?? '', `Bearer ${token}`))
  );
}

let warnedOpenAdmin = false;
let warnedClosedAdmin = false;

async function isExplicitOpenAdmin(env: EnvWithAdmin): Promise<boolean> {
  const sentryEnvironment = (await resolveSecret(env, 'SENTRY_ENVIRONMENT')).value;
  const usageEnvironment =
    (await resolveSecret(env, 'USAGE_MONITOR_ENVIRONMENT')).value ?? env.USAGE_MONITOR_ENVIRONMENT;
  const openInDev = (await resolveSecret(env, 'ADMIN_OPEN_IN_DEV')).value ?? env.ADMIN_OPEN_IN_DEV;
  const isProduction = sentryEnvironment === 'production' || usageEnvironment === 'production';
  return openInDev === 'true' && !isProduction;
}

/** True in production — used to fail closed on dev-only debug endpoints regardless of admin auth. */
async function isProductionEnvironment(env: EnvWithAdmin): Promise<boolean> {
  const sentryEnvironment = (await resolveSecret(env, 'SENTRY_ENVIRONMENT')).value;
  const usageEnvironment =
    (await resolveSecret(env, 'USAGE_MONITOR_ENVIRONMENT')).value ?? env.USAGE_MONITOR_ENVIRONMENT;
  return sentryEnvironment === 'production' || usageEnvironment === 'production';
}

function adminActor(c: { req: { header(name: string): string | undefined } }): string {
  const accessEmail =
    c.req.header('Cf-Access-Authenticated-User-Email') ||
    c.req.header('cf-access-authenticated-user-email');
  if (accessEmail) return accessEmail;
  return c.req.header('authorization') ? 'admin-token' : 'admin';
}

/**
 * Best-effort real email for the admin-allowlist audit trail and the
 * last-admin/self-revoke check.  Prefers a verified identity (Cloudflare
 * Access header, first-party session) over the generic adminActor()
 * fallback ('admin-token'/'admin'), which carries no email to compare
 * against a revoke target.
 */
async function resolveAdminActor(c: Context<{ Bindings: Env }>): Promise<string> {
  const accessEmail =
    c.req.header('Cf-Access-Authenticated-User-Email') ||
    c.req.header('cf-access-authenticated-user-email');
  if (accessEmail) return accessEmail.trim().toLowerCase();
  try {
    const user = await getCurrentUserFromRequest(c);
    if (user?.email) return user.email.trim().toLowerCase();
  } catch {
    /* fall through to the generic actor label */
  }
  return adminActor(c);
}

/**
 * Admin auth — authorized if a valid bearer token OR an allowlisted, verified
 * Cloudflare Access identity is presented. Open only when neither is configured.
 */
async function isAuthorized(
  env: EnvWithAdmin,
  headers: { authorization?: string; accessJwt?: string; sessionEmail?: string },
): Promise<boolean> {
  const token = (await resolveSecret(env, 'ADMIN_TOKEN')).value;
  const tokenConfigured = !!token;

  // Fast path: a correct bearer ADMIN_TOKEN authorizes without ever needing
  // the merged allowlist (ADMIN_EMAILS + persisted grants) — skips an extra
  // DB round trip on the overwhelmingly common automation/curl/CI path.  A
  // wrong or missing bearer falls through to the full check below exactly
  // as before.
  if (tokenConfigured && (await constantTimeEqual(headers.authorization ?? '', `Bearer ${token}`))) {
    return true;
  }

  const adminConfig = await adminRuntimeConfig(env);
  const allow = adminConfig.allow;
  const aud = adminConfig.accessAud;
  const teamDomain = adminConfig.accessTeamDomain;
  const accessConfigured = !!(aud && teamDomain && allow.size > 0);
  const sessionConfigured = allow.size > 0;

  if (!tokenConfigured && !accessConfigured && !sessionConfigured) {
    if (await isExplicitOpenAdmin(env)) {
      if (!warnedOpenAdmin) {
        warnedOpenAdmin = true;
        console.warn(
          'admin: ADMIN_OPEN_IN_DEV=true and no ADMIN_TOKEN/Access config is present — ' +
            'the admin API is OPEN. Do not set this in production.',
        );
      }
      return true;
    }
    if (!warnedClosedAdmin) {
      warnedClosedAdmin = true;
      console.warn(
        'admin: neither ADMIN_TOKEN nor Cloudflare Access (ADMIN_EMAILS + ' +
          'ACCESS_AUD + ACCESS_TEAM_DOMAIN) is configured — the admin API is CLOSED. ' +
          'Run `wrangler secret put ADMIN_TOKEN`, set Access vars, or set ' +
          'ADMIN_OPEN_IN_DEV=true for local-only development.',
      );
    }
    return false;
  }

  // 1) Bearer token (automation / curl) — already tried above via the fast
  // path; reaching here means it was absent or wrong, so fall through.

  // 2) First-party Google session identity (browser). The session itself is an
  // opaque KV token; admin authorization is the ADMIN_EMAILS + granted allowlist.
  const sessionEmail = headers.sessionEmail?.trim().toLowerCase();
  if (sessionConfigured && sessionEmail && allow.has(sessionEmail)) {
    return true;
  }

  // 3) Cloudflare Access identity (humans). Verify signature + aud + allowlist.
  if (accessConfigured && headers.accessJwt) {
    const res = await verifyAccessJwt(headers.accessJwt, {
      aud: aud as string,
      allow,
      jwksUrl: certsUrl(teamDomain as string),
    });
    if (res.ok) return true;
    console.warn(`admin: Cloudflare Access JWT rejected — ${res.reason}`);
  }

  return false;
}

/** Validate a PollWindow[] schedule shape. Returns an error string or null. */
function validateSchedule(schedule: unknown): string | null {
  if (!Array.isArray(schedule)) return 'schedule must be an array';
  if (schedule.length === 0) return 'schedule must have at least one window';
  for (const [i, w] of schedule.entries()) {
    if (typeof w !== 'object' || w === null) return `schedule[${i}] must be an object`;
    const win = w as Record<string, unknown>;
    if (
      !Array.isArray(win.daysOfWeek) ||
      !win.daysOfWeek.every((d) => typeof d === 'number' && d >= 0 && d <= 6)
    ) {
      return `schedule[${i}].daysOfWeek must be numbers in [0,6]`;
    }
    if (typeof win.startHourET !== 'number' || win.startHourET < 0 || win.startHourET > 24) {
      return `schedule[${i}].startHourET must be a number in [0,24]`;
    }
    if (typeof win.endHourET !== 'number' || win.endHourET < 0 || win.endHourET > 24) {
      return `schedule[${i}].endHourET must be a number in [0,24]`;
    }
    if (win.startHourET >= win.endHourET) {
      return `schedule[${i}].startHourET must be < endHourET`;
    }
    if (typeof win.intervalSec !== 'number' || win.intervalSec <= 0) {
      return `schedule[${i}].intervalSec must be a positive number`;
    }
  }
  return null;
}

function canonicalBatchTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  try {
    return new Date(timestamp).toISOString();
  } catch {
    return null;
  }
}

type BatchAccountingPlan =
  | { version: 1; tokenMode: 'per-result' }
  | {
      version: 1;
      tokenMode: 'aggregate';
      aggregateUsage: Required<Pick<BatchUsage, 'promptTokens' | 'completionTokens'>>
        & Pick<BatchUsage, 'cachedTokens'>;
    };

type SafeBatchProviderErrors = { count: number; summaries: string[] };

type BatchTerminalDecision = {
  version: 1;
  fingerprint: string;
  kind: 'valid' | 'invalid';
  finalStatus: 'completed' | 'failed';
  providerStatus: string;
  submittedAt: string;
  completedAt: string;
  turnaroundMs: number;
  returnedDocs: number;
  recognizedDocs: number;
  missingDocs: number;
  providerErrors?: SafeBatchProviderErrors;
  reason?: 'malformed_result_jsonl' | 'invalid_result_identity' | 'unknown_result_identity';
  violationCount?: number;
  identityObservationTruncated?: true;
};

const BATCH_ACCOUNTING_PROTOCOL_VERSION = 1;
const LEGACY_BATCH_ACCOUNTING_MARKER = 'per_result_compat';

function parseBatchResultSummary(value: unknown): Record<string, unknown> | null {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
}

function hasCurrentBatchAccountingProtocol(value: unknown): boolean {
  return parseBatchResultSummary(value)?.accountingProtocol === BATCH_ACCOUNTING_PROTOCOL_VERSION;
}

function hasLegacyBatchAccountingMarker(value: unknown): boolean {
  return parseBatchResultSummary(value)?.legacyAccounting === LEGACY_BATCH_ACCOUNTING_MARKER;
}

function parseSafeBatchProviderErrors(value: unknown): SafeBatchProviderErrors | undefined {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const count = nonNegativeSafeInteger(raw.count);
  if (count == null || count === 0 || !Array.isArray(raw.summaries)) return undefined;
  const summaries = raw.summaries
    .flatMap((summary) => (
      typeof summary === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(summary) ? [summary] : []
    ))
    .slice(0, 20)
    .sort();
  return { count, summaries };
}

function parseBatchTerminalDecision(value: unknown): BatchTerminalDecision | null {
  const summary = parseBatchResultSummary(value);
  const rawDecision = summary?.terminalDecision;
  if (rawDecision == null || typeof rawDecision !== 'object' || Array.isArray(rawDecision)) return null;
  const raw = rawDecision as Record<string, unknown>;
  if (raw.version !== 1
    || (raw.kind !== 'valid' && raw.kind !== 'invalid')
    || (raw.finalStatus !== 'completed' && raw.finalStatus !== 'failed')
    || typeof raw.fingerprint !== 'string'
    || !/^ct-measured-[0-9a-f]{64}$/.test(raw.fingerprint)) {
    return null;
  }
  const submittedAt = canonicalBatchTimestamp(raw.submittedAt);
  const completedAt = canonicalBatchTimestamp(raw.completedAt);
  const turnaroundMs = nonNegativeSafeInteger(raw.turnaroundMs);
  const returnedDocs = nonNegativeSafeInteger(raw.returnedDocs);
  const recognizedDocs = nonNegativeSafeInteger(raw.recognizedDocs);
  const missingDocs = nonNegativeSafeInteger(raw.missingDocs);
  if (!submittedAt || !completedAt || turnaroundMs == null || returnedDocs == null
    || recognizedDocs == null || missingDocs == null) return null;
  const providerStatus = safeBatchProviderStatus(raw.providerStatus);
  const providerErrors = parseSafeBatchProviderErrors(raw.providerErrors);
  const base = {
    version: 1 as const,
    fingerprint: raw.fingerprint,
    kind: raw.kind,
    finalStatus: raw.finalStatus,
    providerStatus,
    submittedAt,
    completedAt,
    turnaroundMs,
    returnedDocs,
    recognizedDocs,
    missingDocs,
    ...(providerErrors ? { providerErrors } : {}),
    ...(raw.identityObservationTruncated === true ? { identityObservationTruncated: true as const } : {}),
  };
  if (raw.kind === 'valid') return base as BatchTerminalDecision;
  if (raw.reason !== 'malformed_result_jsonl'
    && raw.reason !== 'invalid_result_identity'
    && raw.reason !== 'unknown_result_identity') return null;
  const violationCount = nonNegativeSafeInteger(raw.violationCount);
  if (violationCount == null || violationCount === 0) return null;
  return { ...base, reason: raw.reason, violationCount } as BatchTerminalDecision;
}

function canonicalBatchFingerprintValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalBatchFingerprintValue);
  if (value != null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalBatchFingerprintValue(child)]),
    );
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value;
}

async function batchTerminalFingerprint(jobId: string, payload: unknown): Promise<string> {
  return stableMeasuredUsageIdempotencyKey(
    'batch-terminal-decision',
    'fingerprint',
    jobId,
    JSON.stringify(canonicalBatchFingerprintValue(payload)),
  );
}

function safeBatchProviderStatus(value: unknown): string {
  if (typeof value !== 'string') return 'unknown';
  const status = value.trim().slice(0, 64);
  return /^[A-Za-z0-9._-]+$/.test(status) ? status : 'unknown';
}

function nonNegativeSafeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseBatchAccountingPlan(resultSummary: unknown): BatchAccountingPlan | null {
  const parsed = parseBatchResultSummary(resultSummary);
  if (!parsed) return null;
  const rawPlan = parsed.accountingPlan;
  if (rawPlan == null || typeof rawPlan !== 'object' || Array.isArray(rawPlan)) return null;
  const plan = rawPlan as Record<string, unknown>;
  if (plan.version !== 1) return null;
  if (plan.tokenMode === 'per-result') return { version: 1, tokenMode: 'per-result' };
  if (plan.tokenMode !== 'aggregate') return null;
  const rawUsage = plan.aggregateUsage;
  if (rawUsage == null || typeof rawUsage !== 'object' || Array.isArray(rawUsage)) return null;
  const usage = rawUsage as Record<string, unknown>;
  const promptTokens = nonNegativeSafeInteger(usage.promptTokens);
  const completionTokens = nonNegativeSafeInteger(usage.completionTokens);
  const cachedTokens = usage.cachedTokens == null ? null : nonNegativeSafeInteger(usage.cachedTokens);
  if (promptTokens == null || completionTokens == null
    || !Number.isSafeInteger(promptTokens + completionTokens)
    || (usage.cachedTokens != null && (cachedTokens == null || cachedTokens > promptTokens))) {
    return null;
  }
  return {
    version: 1,
    tokenMode: 'aggregate',
    aggregateUsage: {
      promptTokens,
      completionTokens,
      ...(cachedTokens == null ? {} : { cachedTokens }),
    },
  };
}

function proposedBatchAccountingPlan(usage: BatchUsage | undefined): BatchAccountingPlan {
  const promptTokens = nonNegativeSafeInteger(usage?.promptTokens);
  const completionTokens = nonNegativeSafeInteger(usage?.completionTokens);
  if (promptTokens == null || completionTokens == null
    || !Number.isSafeInteger(promptTokens + completionTokens)) {
    return { version: 1, tokenMode: 'per-result' };
  }
  const cachedTokens = nonNegativeSafeInteger(usage?.cachedTokens);
  return {
    version: 1,
    tokenMode: 'aggregate',
    aggregateUsage: {
      promptTokens,
      completionTokens,
      ...(cachedTokens == null || cachedTokens > promptTokens ? {} : { cachedTokens }),
    },
  };
}

async function stableBatchExtractionRunId(jobId: string, docId: string): Promise<string> {
  const key = await stableMeasuredUsageIdempotencyKey('batch-extraction-run', 'row', jobId, docId);
  return key.replace('ct-measured-', 'ct-batch-run-');
}

interface ReviewRow {
  doc_id: string;
  reason: string | null;
  payload: string | null;
  created_at: string | null;
  resolved: number | null;
  source_url: string | null;
  raw_object_key: string | null;
  doc_kind: string | null;
  chamber?: string | null;
  agreement_suppressed_at?: string | null;
  agreement_suppression_reason?: string | null;
  review_revision?: number | null;
  resolution_kind?: string | null;
  resolution_reason?: string | null;
  resolved_at?: string | null;
}

// --- GET /review-queue pagination/filter helpers ---------------------------

const REVIEW_QUEUE_DEFAULT_LIMIT = 50;
const REVIEW_QUEUE_MAX_LIMIT = 200;
// D1 bounds a statement to ~100 bound parameters. This is the chunk size for
// batched `IN (...)` per-model detail lookups keyed off a page of doc_ids;
// 90 leaves headroom vs. the hard cap.
const REVIEW_QUEUE_IN_CHUNK = 90;

interface ReviewQueueCursor {
  createdAt: string;
  docId: string;
}

/** Opaque keyset cursor over (created_at, doc_id) — the pair review_queue
 *  rows are ordered/tie-broken by. base64(JSON) is sufficient; it only needs
 *  to round-trip through this API, never be interpreted by the client. */
function encodeReviewQueueCursor(cur: ReviewQueueCursor): string {
  return btoa(JSON.stringify(cur));
}

function decodeReviewQueueCursor(raw: string): ReviewQueueCursor | null {
  try {
    const parsed = JSON.parse(atob(raw)) as Partial<ReviewQueueCursor>;
    if (typeof parsed.createdAt === 'string' && typeof parsed.docId === 'string') {
      return { createdAt: parsed.createdAt, docId: parsed.docId };
    }
  } catch {
    /* malformed cursor — caller treats this as null (400) */
  }
  return null;
}

interface ReviewQueueFilters {
  resolved: number;
  chamber: string | null;
  reasonPrefix: string | null;
}

/** WHERE clause + bound params shared by the page query and the `matching`
 *  total — everything except the keyset cursor condition (which only the
 *  page query needs; totals cover the whole filtered set). */
function reviewQueueFilterWhere(f: ReviewQueueFilters): { clause: string; params: SqlParam[] } {
  const clauses = ['rq.resolved = ?'];
  const params: SqlParam[] = [f.resolved];
  if (f.chamber) {
    clauses.push('f.chamber = ?');
    params.push(f.chamber);
  }
  if (f.reasonPrefix) {
    // Match one complete token in the comma-joined reason string. Escape the
    // LIKE metacharacters so a reason filter cannot widen its own match.
    const escaped = f.reasonPrefix
      .replace(/\\/g, '\\\\')
      .replace(/%/g, '\\%')
      .replace(/_/g, '\\_');
    clauses.push("(',' || COALESCE(rq.reason, '') || ',') LIKE ? ESCAPE '\\'");
    params.push(`%,${escaped},%`);
  }
  return { clause: clauses.join(' AND '), params };
}

interface ReviewQueueTotals {
  unresolved: number;
  matching: number;
  byReason: Record<string, number>;
  byChamber: Record<string, number>;
}

/**
 * Cheap aggregate-only queries (COUNT/GROUP BY, no payload/join-per-row cost)
 * so the dashboard header stays accurate without re-scanning + materializing
 * the whole queue on every page request.
 *  - unresolved: total pending backlog, independent of the current filters —
 *    a stable KPI regardless of which page/filter the operator is viewing.
 *  - matching: total rows for the current resolved+chamber+reason filters —
 *    powers "X of Y" display since keyset pagination alone doesn't expose a
 *    total.
 *  - byReason / byChamber: breakdowns scoped to `resolved` only (not the
 *    chamber/reason filters, so the breakdown itself isn't self-filtered).
 */
async function reviewQueueTotals(db: D1Database, filters: ReviewQueueFilters): Promise<ReviewQueueTotals> {
  const matchingWhere = reviewQueueFilterWhere(filters);
  const [unresolvedRow, matchingRow, reasonRows, chamberRows] = await Promise.all([
    get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM review_queue WHERE resolved = 0`),
    get<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM review_queue rq LEFT JOIN filings f ON f.doc_id = rq.doc_id WHERE ${matchingWhere.clause}`,
      matchingWhere.params,
    ),
    all<{ reason: string | null; n: number }>(
      db,
      `SELECT rq.reason AS reason, COUNT(*) AS n FROM review_queue rq WHERE rq.resolved = ? GROUP BY rq.reason`,
      [filters.resolved],
    ),
    all<{ chamber: string | null; n: number }>(
      db,
      `SELECT f.chamber AS chamber, COUNT(*) AS n
         FROM review_queue rq LEFT JOIN filings f ON f.doc_id = rq.doc_id
        WHERE rq.resolved = ?
        GROUP BY f.chamber`,
      [filters.resolved],
    ),
  ]);

  const byReason: Record<string, number> = {};
  for (const row of reasonRows) byReason[row.reason ?? ''] = Number(row.n) || 0;
  const byChamber: Record<string, number> = {};
  for (const row of chamberRows) byChamber[row.chamber ?? ''] = Number(row.n) || 0;

  return {
    unresolved: unresolvedRow?.n ?? 0,
    matching: matchingRow?.n ?? 0,
    byReason,
    byChamber,
  };
}

interface DiagnosticConnection {
  id: string;
  label: string;
  /** off = intentional disable (grey); ok = green running; error = red; warn/unknown = amber */
  status: 'ok' | 'warn' | 'error' | 'unknown' | 'off';
  configured: boolean | null;
  lastUsedAt: string | null;
  callsTotal: number;
  callsLast24h: number;
  callsToday: number;
  errorsLast24h: number;
  note: string | null;
}

interface DiagnosticError {
  at: string | null;
  area: string;
  severity: 'warning' | 'error';
  subject: string;
  message: string;
}

interface DiagnosticUserStats {
  totalUsers: number;
  subscribedUsers: number;
  premiumUsers: number;
  trialUsers: number;
  paidUsers: number;
  stripeUsers: number;
  appleUsers: number;
  deliverySubscriptions: number;
  activeDeliverySubscriptions: number;
  adminUsers: number;
  loginsLast24h: number;
  recentLogins: Array<{
    email: string;
    name: string | null;
    lastLoginAt: string | null;
    plan: string | null;
    subscriptionStatus: string | null;
  }>;
}

function dayStartIso(now = new Date()): string {
  return `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
}

function hoursAgoIso(hours: number, now = new Date()): string {
  return new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();
}

async function optionalAll<T>(env: Env, sql: string, params: SqlParam[] = []): Promise<T[]> {
  try {
    return await all<T>(env.DB, sql, params);
  } catch (err) {
    const msg = (err as Error).message;
    if (/no such table|no such column/i.test(msg)) return [];
    throw err;
  }
}

function connectionStatus(
  configured: boolean | null,
  errorsLast24h: number,
  lastUsedAt: string | null,
): DiagnosticConnection['status'] {
  if (configured === false) return 'warn';
  if (errorsLast24h > 0) return 'error';
  if (!lastUsedAt) return 'unknown';
  return 'ok';
}

function maxIso(...values: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!value) continue;
    const ms = Date.parse(value);
    if (Number.isFinite(ms) && ms > bestMs) {
      best = value;
      bestMs = ms;
    }
  }
  return best;
}

function deltaSeconds(later: string | null | undefined, earlier: string | null | undefined): number | null {
  if (!later || !earlier) return null;
  const a = Date.parse(later);
  const b = Date.parse(earlier);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((a - b) / 1000) : null;
}

function titleCaseSource(source: string): string {
  if (source.toLowerCase() === 'house') return 'House';
  if (source.toLowerCase() === 'senate') return 'Senate';
  return source ? `${source[0].toUpperCase()}${source.slice(1)}` : 'Source';
}

function adminSubscription(sub: Subscription): Omit<Subscription, 'secret'> & { hasSecret: boolean } {
  const { secret, ...rest } = sub;
  return { ...rest, hasSecret: Boolean(secret) };
}

/**
 * Console-safe audit trail for subscription lifecycle admin mutations
 * (rotate-secret, deactivate). Subscriptions carry no doc_id, so they can't
 * use the ingestion_decisions table (doc_id is NOT NULL there); this mirrors
 * the try/catch-and-log pattern used for review-queue audit receipts
 * elsewhere in this file. Never throws and never logs the secret value.
 */
function auditAdminSubscriptionAction(
  c: { req: { header(name: string): string | undefined } },
  action: 'rotate-secret' | 'deactivate',
  subscriptionId: string,
  extra?: Record<string, unknown>,
): void {
  try {
    console.log(
      'admin subscription audit:',
      JSON.stringify({
        action,
        subscriptionId,
        actor: adminActor(c),
        at: new Date().toISOString(),
        ...extra,
      }),
    );
  } catch (err) {
    console.error('admin subscription audit log failed', subscriptionId, (err as Error).message);
  }
}

interface EditedTx {
  filerId?: string | null;
  txDate?: string | null;
  owner?: string | null;
  assetName?: string;
  ticker?: string | null;
  assetType?: string | null;
  assetTypeName?: string | null;
  txType?: TxType;
  amountMin?: number | null;
  amountMax?: number | null;
  isOption?: boolean;
  capGainsOver200?: boolean;
  rawText?: string;
  filingStatus?: string | null;
  subholding?: string | null;
  location?: string | null;
  description?: string | null;
  supplementalText?: string | null;
  confidence?: number;
}

type ValidatedEditedTx = EditedTx & {
  txDate: string;
  owner: 'self' | 'spouse' | 'joint' | 'dependent' | null;
  txType: TxType;
};

function validCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day
    && value <= new Date().toISOString().slice(0, 10);
}

function validateReviewEdits(
  rawEdits: unknown[],
  filedDate: string | null,
): { edits: ValidatedEditedTx[] } | { error: string } {
  // The live backlog contains filings with more than 200 disclosed lots. Keep
  // those reviewable while still bounding request and D1 work.
  if (rawEdits.length > 2000) return { error: 'edits cannot contain more than 2000 rows' };
  const edits: ValidatedEditedTx[] = [];
  for (const [index, raw] of rawEdits.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { error: `edits[${index}] must be an object` };
    }
    const e = raw as EditedTx;
    // Canonical B|S|E; legacy form letter P (Purchase) → B.
    let txType = typeof e.txType === 'string' ? e.txType.toUpperCase() : '';
    if (txType === 'P') txType = 'B';
    if (txType !== 'B' && txType !== 'S' && txType !== 'E') {
      return { error: `edits[${index}].txType must be explicitly B (Buy), S (Sell), or E (Exchange); P is accepted as Buy` };
    }
    const ownerRaw = typeof e.owner === 'string' ? e.owner.trim().toLowerCase() : '';
    const owner = ownerRaw === '' ? null : ownerRaw;
    if (owner !== null && owner !== 'self' && owner !== 'spouse' && owner !== 'joint' && owner !== 'dependent') {
      return { error: `edits[${index}].owner must be self, spouse, joint, dependent, or null` };
    }
    const txDate = typeof e.txDate === 'string' ? e.txDate.trim() : '';
    if (!validCalendarDate(txDate)) {
      return { error: `edits[${index}].txDate must be a valid non-future YYYY-MM-DD date` };
    }
    // Allow a disclosed trade a few days after Clerk's filed_date (signature
    // stamp).  Still refuse dates that have not happened yet.
    const ticker = typeof e.ticker === 'string' ? e.ticker.trim() : '';
    const assetName = typeof e.assetName === 'string' ? e.assetName.trim() : '';
    if (!ticker && !assetName) {
      return { error: `edits[${index}] requires a ticker or assetName` };
    }
    if (assetName.length > 500) {
      return { error: `edits[${index}].assetName must be at most 500 characters` };
    }
    if (ticker && (ticker.length > 20 || !/^[A-Za-z0-9.^$-]+$/.test(ticker))) {
      return { error: `edits[${index}].ticker is invalid` };
    }
    const amountOmitted = e.amountMin == null;
    if (!amountOmitted && (typeof e.amountMin !== 'number' || !Number.isFinite(e.amountMin))) {
      return { error: `edits[${index}].amountMin must be a number or null` };
    }
    if (e.amountMax != null && (typeof e.amountMax !== 'number' || !Number.isFinite(e.amountMax))) {
      return { error: `edits[${index}].amountMax must be a number or null` };
    }
    if (!amountOmitted && !isValidBracket(e.amountMin as number, e.amountMax ?? null)) {
      return { error: `edits[${index}] amount must be a canonical STOCK Act bracket` };
    }
    if (e.confidence != null && (
      typeof e.confidence !== 'number' || !Number.isFinite(e.confidence)
      || e.confidence < 0 || e.confidence > 1
    )) {
      return { error: `edits[${index}].confidence must be between 0 and 1` };
    }
    for (const field of ['isOption', 'capGainsOver200'] as const) {
      if (e[field] !== undefined && typeof e[field] !== 'boolean') {
        return { error: `edits[${index}].${field} must be a boolean` };
      }
    }
    edits.push({ ...e, ticker: ticker || null, assetName, txDate, owner: owner as any, txType });
  }
  return { edits };
}

function reviewAssetTypeName(e: EditedTx): string | null {
  const supplied = typeof e.assetTypeName === 'string' ? e.assetTypeName.trim() : '';
  if (supplied) return supplied;
  const raw = typeof e.assetType === 'string' ? e.assetType.trim() : '';
  if (!raw || raw.toLowerCase() === 'unknown') return null;
  const code = raw.toUpperCase();
  return HOUSE_ASSET_TYPE_NAMES[code] ?? raw;
}

// --- Politician photo enrichment (name -> bioguide -> unitedstates/images CDN) ---
// buildLegislatorMap/normName/Legislator live in ../enrichment/legislators.ts
// (shared with identitySync.ts's bioguide backfill + display-name sync).
//
// Prefer 450x550 over the historical 225x275 — ~3x more pixels, still well
// under 250KB/image, sharp enough for retina avatars and the politician drawer.
// `original` (~500KB) is available but overkill for UI faces.

export const LEGISLATOR_PHOTO_SIZE = '450x550';
const LEGISLATOR_PHOTO_SIZE_LEGACY = '225x275';

export function photoUrlFor(bioguide: string, size: string = LEGISLATOR_PHOTO_SIZE): string {
  return `https://unitedstates.github.io/images/congress/${size}/${bioguide}.jpg`;
}

/**
 * The photo URL a legislator *should* carry.
 *
 * Prefer our own cropped face pack when it has this bioguide: a 256px
 * head-focused WebP served from our origin beats a 200KB head-and-torso
 * hotlink, and it keeps working when the upstream CDN does not have the image
 * (nine stored bioguides 404 there today). Anything not in the pack keeps the
 * upstream URL, so this can never turn a working photo into a blank one.
 */
export function desiredPhotoUrlFor(bioguide: string, baseUrl: string | undefined): string {
  return packFaceForKey(bioguide)
    ? memberPhotoUrl(bioguide, baseUrl ?? 'https://congress.trade')
    : photoUrlFor(bioguide);
}

/**
 * True when the stored URL is missing, legacy-size, points at a different
 * bioguide, or predates the face pack. `want` defaults to the upstream URL so
 * existing callers keep their old meaning.
 */
export function photoUrlNeedsUpgrade(
  current: string | null | undefined,
  bioguide: string,
  want: string = photoUrlFor(bioguide),
): boolean {
  const have = (current ?? '').trim();
  if (!have) return true;
  if (have === want) return false;
  // Upgrade any legacy 225x275 unitedstates URL for this bioguide.
  if (have.includes(`/images/congress/${LEGISLATOR_PHOTO_SIZE_LEGACY}/${bioguide}.jpg`)) return true;
  // Replace a wrong-bioguide or other CDN path with the canonical one.
  if (have.includes('unitedstates.github.io/images/congress/')) return true;
  // A pack URL for some other key (or a stale origin) is also stale.
  if (isMemberPhotoPackUrl(have)) return true;
  return false;
}

/**
 * Backfill ticker resolution over stored rows whose ticker is NULL/empty or
 * whose asset name clearly describes a preferred/depositary share. No PDF
 * re-extraction — just the deterministic resolver over the stored asset name.
 * Bounded per call; safe to re-run. Shared by POST /resolve-tickers and cron.
 */
export async function runTickerBackfill(
  env: Env,
  limit = 5000,
  opts: { afterId?: string } = {},
): Promise<{ scanned: number; resolved: number; lastId?: string | null }> {
  const resolver = await loadResolver(env);
  type BackfillTickerRow = {
    id: string;
    ticker: string | null;
    asset_name: string | null;
    tx_date: string | null;
    owner: string | null;
    asset_type: string | null;
    asset_type_name: string | null;
    tx_type: string | null;
    amount_min: number | null;
    amount_max: number | null;
    is_option: number | null;
    cap_gains_over_200: number | null;
    raw_text: string | null;
    filing_status: string | null;
    subholding: string | null;
    location: string | null;
    description: string | null;
    supplemental_text: string | null;
    source: TxSource;
    row_key: string | null;
  };
  // Cursor mode (opts.afterId, '' = start): page by id so rows that never resolve
  // (bonds, funds, private assets — most of the ~30k ticker-less rows) cannot
  // starve the tail.  Without a cursor the legacy ordering (preferred/depositary
  // rows first, then lowest ids) is preserved exactly.
  const cursorMode = opts.afterId !== undefined;
  const preferredSql =
    "(asset_name LIKE '%Depositary Share%' " +
    "OR asset_name LIKE '%Preferred%' " +
    "OR asset_name LIKE '%Preference%' " +
    "OR asset_name LIKE '%Pfd%' " +
    "OR asset_name LIKE '%Pref%')";
  const orderSql = cursorMode
    ? 'ORDER BY id '
    : "ORDER BY CASE WHEN ticker IS NOT NULL AND ticker <> '' AND ticker NOT LIKE '%^%' AND " +
      preferredSql +
      " THEN 0 WHEN (ticker IS NULL OR ticker = '') AND " +
      preferredSql +
      ' THEN 1 ELSE 2 END, id ';
  const rows = await all<BackfillTickerRow>(
    env.DB,
    "SELECT id, ticker, asset_name, tx_date, owner, asset_type, asset_type_name, tx_type, " +
      "amount_min, amount_max, is_option, cap_gains_over_200, raw_text, filing_status, " +
      "subholding, location, description, supplemental_text, source, row_key FROM transactions " +
      "WHERE asset_name IS NOT NULL AND asset_name <> '' " +
      "AND ((ticker IS NULL OR ticker = '') " +
      "OR (ticker NOT LIKE '%^%' AND " +
      preferredSql +
      ')) ' +
      'AND deprecated_at IS NULL ' +
      (cursorMode ? 'AND id > ? ' : '') +
      orderSql +
      'LIMIT ?',
    cursorMode ? [opts.afterId as string, Math.min(limit, 20000)] : [Math.min(limit, 20000)],
  );
  const updates: D1PreparedStatement[] = [];
  for (const row of rows) {
    const resolved = resolver(row.ticker, row.asset_name);
    if (resolved && resolved !== (row.ticker ?? '').trim().toUpperCase()) {
      const rowIndex = parseRowIndex(row.row_key);
      const rowKey = rowIndex === null
        ? row.row_key ?? null
        : transactionRowKey(row.source, rowIndex, {
            txDate: row.tx_date,
            owner: normalizeStoredOwner(row.owner),
            assetName: row.asset_name ?? '',
            ticker: resolved,
            assetType: row.asset_type,
            assetTypeName: row.asset_type_name,
            txType: normalizeStoredTxType(row.tx_type),
            amountMin: row.amount_min,
            amountMax: row.amount_max,
            isOption: row.is_option === 1,
            capGainsOver200: row.cap_gains_over_200 === 1,
            rawText: row.raw_text ?? '',
            filingStatus: row.filing_status,
            subholding: row.subholding,
            location: row.location,
            description: row.description,
            supplementalText: row.supplemental_text,
          });
      updates.push(env.DB.prepare('UPDATE transactions SET ticker = ?, row_key = ? WHERE id = ?').bind(resolved, rowKey, row.id));
    }
  }
  for (let i = 0; i < updates.length; i += 50) {
    await batchPrepared(env.DB, updates.slice(i, i + 50));
  }
  const summary = { scanned: rows.length, resolved: updates.length };
  return cursorMode ? { ...summary, lastId: rows.length ? rows[rows.length - 1].id : null } : summary;
}

function parseRowIndex(rowKey: string | null): number | null {
  const m = /^v1:[^:]+:(\d+):/.exec(rowKey ?? '');
  return m ? Number(m[1]) : null;
}

function normalizeStoredOwner(value: string | null): 'self' | 'spouse' | 'joint' | 'dependent' | null {
  return value === 'self' || value === 'spouse' || value === 'joint' || value === 'dependent' ? value : null;
}

function normalizeStoredTxType(value: string | null): TxType {
  // Canonical B|S|E; legacy P → B on read so API never serves Purchase letter.
  if (value === 'P' || value === 'B') return 'B';
  return value === 'S' || value === 'E' ? value : 'B';
}

/**
 * Resolve each filer's name -> bioguide (congress-legislators) and fill in the
 * public headshot URL plus party/state/district (COALESCE-preserve so an existing
 * value is never overwritten). Pure data fill, safe to re-run; unmatched filers
 * stay null (the UI falls back to initials). Shared by POST /enrich-photos and the
 * daily cron so photos/party fill in automatically, not just on a manual call.
 *
 * Also stores the matched official Bioguide ID in filers.resolved_bioguide_id
 * (migration 0066). The filers PK (bioguide_id) holds source-specific synthetic
 * slugs and cannot join Bioguide-keyed external datasets; the resolved column
 * can. COALESCE-preserve here too, so a manually corrected value wins.
 */
/**
 * Merge curated member filer forks onto their preferred identity.
 * For each {@link MEMBER_FILER_MERGES} group:
 *   1. Ensure the canonical filer row exists with the preferred name / bioguide
 *   2. Rewrite transactions + filings from every alias id onto the canonical id
 *   3. Copy useful metadata (photo, party, bioguide) from aliases onto canonical
 *   4. Delete the alias filer rows
 *   5. Rename any remaining filer still carrying an alias full_name
 * Idempotent and safe to re-run.
 */
export async function repairMemberIdentityMerges(
  env: Env,
): Promise<{
  groups: number;
  filersEnsured: number;
  transactionsMoved: number;
  filingsMoved: number;
  aliasesDeleted: number;
  namesRenamed: number;
  details: Array<{
    canonicalId: string;
    aliases: string[];
    transactionsMoved: number;
    filingsMoved: number;
    deleted: string[];
  }>;
}> {
  let filersEnsured = 0;
  let transactionsMoved = 0;
  let filingsMoved = 0;
  let aliasesDeleted = 0;
  let namesRenamed = 0;
  const details: Array<{
    canonicalId: string;
    aliases: string[];
    transactionsMoved: number;
    filingsMoved: number;
    deleted: string[];
  }> = [];

  for (const group of MEMBER_FILER_MERGES) {
    const groupDetail = await applyMemberFilerMerge(env, group);
    filersEnsured += groupDetail.ensured ? 1 : 0;
    transactionsMoved += groupDetail.transactionsMoved;
    filingsMoved += groupDetail.filingsMoved;
    aliasesDeleted += groupDetail.deleted.length;
    details.push({
      canonicalId: group.canonicalId,
      aliases: [...group.aliasIds],
      transactionsMoved: groupDetail.transactionsMoved,
      filingsMoved: groupDetail.filingsMoved,
      deleted: groupDetail.deleted,
    });
  }

  // Rename any leftover filer still carrying a known legal-name alias.
  // Aliases are stored normalized ("rohit khanna"); match case-insensitively.
  for (const nameAlias of MEMBER_NAME_ALIASES) {
    for (const alias of nameAlias.aliases) {
      const res = await run(
        env.DB,
        `UPDATE filers
            SET full_name = ?
          WHERE full_name IS NOT NULL
            AND lower(trim(full_name)) = ?
            AND full_name != ?`,
        [nameAlias.canonicalName, alias, nameAlias.canonicalName],
      );
      namesRenamed += res.meta?.changes ?? 0;
    }
  }

  return {
    groups: MEMBER_FILER_MERGES.length,
    filersEnsured,
    transactionsMoved,
    filingsMoved,
    aliasesDeleted,
    namesRenamed,
    details,
  };
}

async function applyMemberFilerMerge(
  env: Env,
  group: MemberFilerMerge,
): Promise<{
  ensured: boolean;
  transactionsMoved: number;
  filingsMoved: number;
  deleted: string[];
}> {
  // Pull metadata from any existing alias/canonical rows so we do not lose
  // photo_url / resolved_bioguide_id that photo enrichment already filled.
  const ids = [group.canonicalId, ...group.aliasIds];
  const placeholders = ids.map(() => '?').join(',');
  const existing = await all<{
    bioguide_id: string;
    full_name: string | null;
    party: string | null;
    state: string | null;
    district: string | null;
    photo_url: string | null;
    resolved_bioguide_id: string | null;
    chamber: string | null;
  }>(
    env.DB,
    `SELECT bioguide_id, full_name, party, state, district, photo_url,
            resolved_bioguide_id, chamber
       FROM filers
      WHERE bioguide_id IN (${placeholders})`,
    ids,
  );

  const byId = new Map(existing.map((r) => [r.bioguide_id, r]));
  const pick = <K extends keyof (typeof existing)[0]>(key: K): (typeof existing)[0][K] | null => {
    if (byId.get(group.canonicalId)?.[key]) return byId.get(group.canonicalId)![key];
    for (const alias of group.aliasIds) {
      const v = byId.get(alias)?.[key];
      if (v) return v;
    }
    return null;
  };

  const photoUrl = pick('photo_url');
  const party = pick('party');
  const state = pick('state') ?? group.state ?? null;
  const district = pick('district') ?? group.district ?? null;
  const resolvedBioguide =
    pick('resolved_bioguide_id') ?? group.resolvedBioguideId ?? null;
  const chamber = pick('chamber') ?? group.chamber;

  await run(
    env.DB,
    `INSERT INTO filers (
       bioguide_id, chamber, full_name, party, state, district, committees, photo_url, resolved_bioguide_id
     ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
     ON CONFLICT(bioguide_id) DO UPDATE SET
       full_name = excluded.full_name,
       party = COALESCE(excluded.party, filers.party),
       state = COALESCE(excluded.state, filers.state),
       district = COALESCE(excluded.district, filers.district),
       photo_url = COALESCE(excluded.photo_url, filers.photo_url),
       resolved_bioguide_id = COALESCE(excluded.resolved_bioguide_id, filers.resolved_bioguide_id)`,
    [
      group.canonicalId,
      chamber,
      group.canonicalName,
      party,
      state,
      district,
      photoUrl,
      resolvedBioguide,
    ],
  );

  let transactionsMoved = 0;
  let filingsMoved = 0;
  const deleted: string[] = [];

  for (const aliasId of group.aliasIds) {
    if (aliasId === group.canonicalId) continue;
    const txRes = await run(
      env.DB,
      `UPDATE transactions SET filer_id = ? WHERE filer_id = ?`,
      [group.canonicalId, aliasId],
    );
    transactionsMoved += txRes.meta?.changes ?? 0;

    const filRes = await run(
      env.DB,
      `UPDATE filings SET filer_id = ? WHERE filer_id = ?`,
      [group.canonicalId, aliasId],
    );
    filingsMoved += filRes.meta?.changes ?? 0;

    if (byId.has(aliasId)) {
      await run(env.DB, `DELETE FROM filers WHERE bioguide_id = ?`, [aliasId]);
      deleted.push(aliasId);
    }
  }

  return {
    ensured: !byId.has(group.canonicalId),
    transactionsMoved,
    filingsMoved,
    deleted,
  };
}

export async function runPhotoEnrichment(
  env: Env,
): Promise<{
  filers: number;
  matched: number;
  unmatched: number;
  upgraded: number;
  /** Pack-by-filer-id UPDATEs queued (executive filers and pack-only bioguides). */
  packFilerFills: number;
}> {
  const map = await buildLegislatorMap();
  // Also index by bioguide so filers that already carry resolved_bioguide_id
  // (from identity sync) get a headshot even when free-text name matching fails.
  const byBioguide = new Map<string, { bioguide: string; party: string | null; state: string | null; district: string | null }>();
  for (const m of map.values()) {
    if (!byBioguide.has(m.bioguide)) byBioguide.set(m.bioguide, m);
  }
  const filers = await all<{
    bioguide_id: string;
    full_name: string | null;
    photo_url: string | null;
    resolved_bioguide_id: string | null;
  }>(
    env.DB,
    'SELECT bioguide_id, full_name, photo_url, resolved_bioguide_id FROM filers',
  );
  const updates: D1PreparedStatement[] = [];
  let matched = 0;
  let upgraded = 0;
  for (const f of filers) {
    // Prefer cleaned/alias-normalized name so "Rohit Khanna" matches "Ro Khanna"
    // in congress-legislators (official_full / nickname keys). Fall back to an
    // already-resolved bioguide so identity sync + photo enrichment compose.
    const cleaned = cleanFilerName(f.full_name);
    const nameMatch =
      map.get(normName(cleaned || f.full_name)) ??
      map.get(normName(f.full_name));
    const resolved = (f.resolved_bioguide_id ?? '').trim().toUpperCase();
    const match =
      nameMatch ??
      (resolved ? byBioguide.get(resolved) ?? null : null);
    if (!match) continue;
    matched++;
    const nextPhoto = desiredPhotoUrlFor(match.bioguide, env.APP_BASE_URL);
    if (photoUrlNeedsUpgrade(f.photo_url, match.bioguide, nextPhoto)) upgraded++;
    updates.push(
      env.DB
        .prepare(
          "UPDATE filers SET photo_url = ?, party = COALESCE(NULLIF(party, ''), ?), state = COALESCE(NULLIF(state, ''), ?), district = COALESCE(NULLIF(district, ''), ?), resolved_bioguide_id = COALESCE(NULLIF(resolved_bioguide_id, ''), ?) WHERE bioguide_id = ?",
        )
        .bind(nextPhoto, match.party, match.state, match.district, match.bioguide, f.bioguide_id),
    );
  }

  // Executive-branch filers have no bioguide and are invisible to every
  // congress-legislators lookup, which is why ~45 of them carried no photo at
  // all. The face pack pins each one to a curated public-domain portrait by
  // filer id; fill those in here. Only NULL/blank photos and stale pack URLs
  // are touched, so a hand-set photo is never clobbered — which also means the
  // count below is UPDATEs queued, not rows actually changed (a re-run is a
  // no-op at the database and still reports the same number).
  let packFilerFills = 0;
  const knownFilerIds = new Set(filers.map((f) => f.bioguide_id));
  for (const face of packFacesWithFilerIds()) {
    const url = memberPhotoUrl(face.key, env.APP_BASE_URL ?? 'https://congress.trade');
    for (const filerId of face.filerIds) {
      if (!knownFilerIds.has(filerId)) continue;
      packFilerFills++;
      updates.push(
        env.DB
          .prepare(
            "UPDATE filers SET photo_url = ? WHERE bioguide_id = ? AND (photo_url IS NULL OR TRIM(photo_url) = '' OR (photo_url LIKE '%/api/photos/member?key=%' AND photo_url <> ?))",
          )
          .bind(url, filerId, url),
      );
    }
  }

  for (let i = 0; i < updates.length; i += 50) {
    await batchPrepared(env.DB, updates.slice(i, i + 50));
  }
  return {
    filers: filers.length,
    matched,
    unmatched: filers.length - matched,
    upgraded,
    packFilerFills,
  };
}

interface BenchmarkGroundTruthTx {
  ticker: string | null;
  assetName: string;
  txDate: string;
  txType: string;
  amountMin: number | null;
  amountMax: number | null;
  owner: string | null;
  assetType: string | null;
  assetTypeName: string | null;
  isOption: boolean;
  capGainsOver200: boolean;
  filingStatus: string | null;
  subholding: string | null;
  location: string | null;
  description: string | null;
  supplementalText: string | null;
}

interface BenchmarkDocumentSnapshot {
  docId: string;
  resolved: boolean;
  groundTruth: BenchmarkGroundTruthTx[] | null;
}

/**
 * A benchmark accuracy label is human ground truth only when the current
 * resolved review's latest decision receipt is an admin confirm/manual action.
 * Pipeline/autopublish/agreement receipts therefore cannot score themselves.
 */
function benchmarkHumanResolvedSql(docIdSql: string): string {
  return `COALESCE(rq.resolved, 0) = 1
    AND COALESCE((
      SELECT CASE
        WHEN d.source = 'admin' AND d.action IN ('confirmed', 'manual') THEN 1
        ELSE 0
      END
        FROM ingestion_decisions d
       WHERE d.doc_id = ${docIdSql}
       ORDER BY d.created_at DESC, d.id DESC
       LIMIT 1
    ), 0) = 1`;
}

async function benchmarkDocumentIsHumanResolved(env: Env, docId: string): Promise<boolean> {
  const row = await get<{ resolved: number }>(
    env.DB,
    `SELECT CASE WHEN ${benchmarkHumanResolvedSql('f.doc_id')} THEN 1 ELSE 0 END AS resolved
       FROM filings f
       LEFT JOIN review_queue rq ON rq.doc_id = f.doc_id
      WHERE f.doc_id = ?`,
    [docId],
  );
  return row?.resolved === 1;
}

function benchmarkChamber(value: unknown): BenchmarkChamber | null {
  const chamber = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return BENCHMARK_CHAMBERS.includes(chamber as BenchmarkChamber)
    ? chamber as BenchmarkChamber
    : null;
}

function isPreviewDeployment(env: Env): boolean {
  return env.PREVIEW_DEPLOYMENT?.trim().toLowerCase() === 'true';
}

async function loadBenchmarkGroundTruth(
  env: Env,
  docId: string,
): Promise<BenchmarkGroundTruthTx[]> {
  const rows = await all<Record<string, unknown>>(
    env.DB,
    `SELECT ticker, asset_name, tx_date, tx_type, amount_min, amount_max,
            owner, asset_type, asset_type_name, is_option, cap_gains_over_200,
            filing_status, subholding, location, description, supplemental_text
       FROM transactions t
      WHERE t.doc_id = ? AND t.source IN ('primary', 'manual')
        AND t.deprecated_at IS NULL
        AND EXISTS (
          SELECT 1 FROM review_queue rq
           WHERE rq.doc_id = t.doc_id
             AND ${benchmarkHumanResolvedSql('t.doc_id')}
        )
      ORDER BY t.cursor_seq, t.id`,
    [docId],
  );
  return rows.map((row) => ({
    ticker: typeof row.ticker === 'string' ? row.ticker : null,
    assetName: String(row.asset_name ?? ''),
    txDate: String(row.tx_date ?? ''),
    txType: String(row.tx_type ?? ''),
    amountMin: typeof row.amount_min === 'number' ? row.amount_min : null,
    amountMax: typeof row.amount_max === 'number' ? row.amount_max : null,
    owner: typeof row.owner === 'string' ? row.owner : null,
    assetType: typeof row.asset_type === 'string' ? row.asset_type : null,
    assetTypeName: typeof row.asset_type_name === 'string' ? row.asset_type_name : null,
    isOption: row.is_option === 1,
    capGainsOver200: row.cap_gains_over_200 === 1,
    filingStatus: typeof row.filing_status === 'string' ? row.filing_status : null,
    subholding: typeof row.subholding === 'string' ? row.subholding : null,
    location: typeof row.location === 'string' ? row.location : null,
    description: typeof row.description === 'string' ? row.description : null,
    supplementalText: typeof row.supplemental_text === 'string' ? row.supplemental_text : null,
  }));
}

async function loadBenchmarkDocuments(
  env: Env,
  input: {
    chamber: BenchmarkChamber;
    limit: number;
    docIds?: string[];
    resolvedOnly?: boolean;
  },
): Promise<BenchmarkDocumentSnapshot[]> {
  type FilingRow = { doc_id: string; resolved: number };
  let rows: FilingRow[] = [];
  if (input.docIds?.length) {
    for (const docId of input.docIds.slice(0, input.limit)) {
      const row = await get<FilingRow>(
        env.DB,
        `SELECT f.doc_id,
                CASE WHEN ${benchmarkHumanResolvedSql('f.doc_id')} THEN 1 ELSE 0 END AS resolved
           FROM filings f
           LEFT JOIN review_queue rq ON rq.doc_id = f.doc_id
          WHERE f.doc_id = ? AND LOWER(f.chamber) = ?
            AND f.raw_object_key IS NOT NULL`,
        [docId, input.chamber],
      );
      if (row && (!input.resolvedOnly || row.resolved === 1)) rows.push(row);
    }
  } else {
    rows = await all<FilingRow>(
      env.DB,
      `SELECT f.doc_id,
              CASE WHEN ${benchmarkHumanResolvedSql('f.doc_id')} THEN 1 ELSE 0 END AS resolved
         FROM filings f
         LEFT JOIN review_queue rq ON rq.doc_id = f.doc_id
        WHERE LOWER(f.chamber) = ? AND f.raw_object_key IS NOT NULL
          ${input.resolvedOnly ? `AND ${benchmarkHumanResolvedSql('f.doc_id')}` : ''}
        ORDER BY resolved DESC, f.filed_date DESC, f.doc_id DESC
        LIMIT ?`,
      [input.chamber, input.limit],
    );
  }
  return Promise.all(rows.map(async (row) => ({
    docId: row.doc_id,
    resolved: row.resolved === 1,
    groundTruth: row.resolved === 1 ? await loadBenchmarkGroundTruth(env, row.doc_id) : null,
  })));
}

export class BenchmarkCallReservationError extends Error {
  constructor(
    readonly reason: 'cap_reached' | 'ledger_unavailable',
    readonly usedToday: number,
    readonly dailyCap: number,
    readonly reservationCause?: unknown,
  ) {
    super(reason === 'cap_reached'
      ? 'benchmark daily call cap reached'
      : 'benchmark daily call reservation ledger unavailable');
  }
}

/**
 * Atomically reserve calls against the UTC day when authorization is granted.
 * An already-admitted in-flight request remains charged to that reservation
 * day even if the provider response completes after midnight.
 */
export async function reserveBenchmarkCalls(env: Env, plannedCalls: number): Promise<{
  usedToday: number;
  dailyCap: number;
  reservedDay: string;
}> {
  const envWithCap = env as Env & { BENCHMARK_DAILY_CALL_CAP?: string; BAKEOFF_DAILY_CALL_CAP?: string };
  const configuredCap = Number(
    envWithCap.BENCHMARK_DAILY_CALL_CAP ?? envWithCap.BAKEOFF_DAILY_CALL_CAP ?? '500',
  );
  const dailyCap = Number.isSafeInteger(configuredCap) && configuredCap > 0 ? configuredCap : 500;
  if (!Number.isSafeInteger(plannedCalls) || plannedCalls <= 0) {
    throw new BenchmarkCallReservationError(
      'ledger_unavailable',
      0,
      dailyCap,
      new Error('plannedCalls must be a positive safe integer'),
    );
  }
  const now = new Date().toISOString();
  const day = now.slice(0, 10);
  let results: D1Result[];
  try {
    results = await batchPrepared(env.DB, [
      env.DB.prepare(
        `INSERT OR IGNORE INTO benchmark_daily_call_usage
           (day, reserved_calls, updated_at)
         VALUES (?, 0, ?)`,
      ).bind(day, now),
      env.DB.prepare(
        `UPDATE benchmark_daily_call_usage
            SET reserved_calls = reserved_calls + ?, updated_at = ?
          WHERE day = ? AND reserved_calls + ? <= ?`,
      ).bind(plannedCalls, now, day, plannedCalls, dailyCap),
      env.DB.prepare(
        `SELECT reserved_calls
           FROM benchmark_daily_call_usage
          WHERE day = ?`,
      ).bind(day),
    ]);
  } catch (error) {
    throw new BenchmarkCallReservationError('ledger_unavailable', 0, dailyCap, error);
  }

  const changed = Number(results[1]?.meta?.changes ?? 0);
  const usageRow = (results[2]?.results?.[0] ?? null) as { reserved_calls?: unknown } | null;
  const usedToday = Number(usageRow?.reserved_calls);
  if (!Number.isSafeInteger(usedToday) || usedToday < 0) {
    throw new BenchmarkCallReservationError(
      'ledger_unavailable',
      0,
      dailyCap,
      new Error('benchmark reservation ledger returned an invalid count'),
    );
  }
  if (changed !== 1) {
    throw new BenchmarkCallReservationError('cap_reached', usedToday, dailyCap);
  }
  return { usedToday, dailyCap, reservedDay: day };
}

function benchmarkReservationFailure(
  error: unknown,
  plannedCalls: number,
): {
  status: 429 | 503;
  body: Record<string, unknown>;
} {
  if (!(error instanceof BenchmarkCallReservationError)) throw error;
  return error.reason === 'ledger_unavailable'
    ? {
        status: 503,
        body: {
          error: 'benchmark daily call reservation is temporarily unavailable',
          code: 'benchmark_call_reservation_unavailable',
          plannedCalls,
          dailyCap: error.dailyCap,
          retryable: true,
        },
      }
    : {
        status: 429,
        body: {
          error: 'benchmark daily call cap reached',
          plannedCalls,
          usedToday: error.usedToday,
          dailyCap: error.dailyCap,
        },
      };
}

export interface BenchmarkSettingsLease {
  chamber: BenchmarkChamber;
  ownerToken: string;
  leaseUntil: string;
}

export class BenchmarkSettingsLeaseBusyError extends Error {
  constructor(readonly leaseUntil: string | null) {
    super('benchmark lineup settings are already being updated');
  }
}

export class BenchmarkSettingsLeaseLostError extends Error {
  constructor(readonly leaseUntil: string | null) {
    super('benchmark lineup settings lease was lost or expired');
  }
}

/**
 * Own one chamber's multi-key Infisical mutation. D1 serializes the conditional
 * UPSERT; owner-token release cannot unlock a newer lease after expiry/takeover.
 */
export async function acquireBenchmarkSettingsLease(
  db: D1Database,
  chamber: BenchmarkChamber,
  options: { now?: string; leaseMs?: number; ownerToken?: string } = {},
): Promise<BenchmarkSettingsLease> {
  const now = options.now ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(now))) throw new Error('now must be an ISO timestamp');
  const leaseMs = options.leaseMs ?? 10 * 60_000;
  if (!Number.isFinite(leaseMs) || leaseMs < 30_000 || leaseMs > 10 * 60_000) {
    throw new Error('leaseMs must be between 30000 and 600000');
  }
  const ownerToken = options.ownerToken?.trim() || uuid();
  const leaseUntil = new Date(Date.parse(now) + leaseMs).toISOString();
  const result = await run(
    db,
    `INSERT INTO benchmark_settings_leases
       (chamber, owner_token, lease_until, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(chamber) DO UPDATE SET
       owner_token = excluded.owner_token,
       lease_until = excluded.lease_until,
       updated_at = excluded.updated_at
     WHERE benchmark_settings_leases.lease_until <= excluded.created_at`,
    [chamber, ownerToken, leaseUntil, now, now],
  );
  if (Number(result.meta?.changes ?? 0) !== 1) {
    const current = await get<{ lease_until: string | null }>(
      db,
      'SELECT lease_until FROM benchmark_settings_leases WHERE chamber = ?',
      [chamber],
    );
    throw new BenchmarkSettingsLeaseBusyError(current?.lease_until ?? null);
  }
  return { chamber, ownerToken, leaseUntil };
}

export async function releaseBenchmarkSettingsLease(
  db: D1Database,
  lease: BenchmarkSettingsLease,
): Promise<boolean> {
  const result = await run(
    db,
    'DELETE FROM benchmark_settings_leases WHERE chamber = ? AND owner_token = ?',
    [lease.chamber, lease.ownerToken],
  );
  return Number(result.meta?.changes ?? 0) === 1;
}

/** Fence every external mutation against the exact D1 lease owner. */
export async function assertBenchmarkSettingsLease(
  db: D1Database,
  lease: BenchmarkSettingsLease,
  now = new Date().toISOString(),
): Promise<void> {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error('now must be an ISO timestamp');
  const current = await get<{ owner_token: string; lease_until: string | null }>(
    db,
    `SELECT owner_token, lease_until
       FROM benchmark_settings_leases
      WHERE chamber = ?`,
    [lease.chamber],
  );
  const leaseUntilMs = Date.parse(current?.lease_until ?? '');
  if (
    !current
    || current.owner_token !== lease.ownerToken
    || !Number.isFinite(leaseUntilMs)
    || leaseUntilMs <= nowMs
  ) {
    throw new BenchmarkSettingsLeaseLostError(current?.lease_until ?? null);
  }
}

function rowsFromBenchmarkResult(result: unknown): ParsedTx[] {
  if (Array.isArray(result)) return result as ParsedTx[];
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: ParsedTx[] }).rows;
  }
  return [];
}

function persistedCandidate(
  result: BenchmarkRunDetail['results'][number],
): CandidateDocResult {
  const rows = rowsFromBenchmarkResult(result.result);
  return {
    provider: result.provider as Provider,
    model: result.model,
    docId: result.docId,
    ok: result.ok,
    ...(result.error ? { error: result.error } : {}),
    latencyMs: result.latencyMs ?? 0,
    rowCount: rows.length,
    rowKeys: [],
    avgConfidence: result.avgConfidence ?? 0,
    rows,
    ...(result.usage && typeof result.usage === 'object' ? { usage: result.usage as CandidateDocResult['usage'] } : {}),
  };
}

function consensusBenchmarkRows(reads: CandidateDocResult[]): ParsedTx[] | null {
  if (reads.length !== 3 || reads.some((read) => !read.ok)) return null;
  const consensus = buildConsensusRows(reads.map((read) => ({
    model: `${read.provider}:${read.model}`,
    rows: read.rows,
  })));
  if (!consensus.rows.length) return null;
  if (consensus.rows.some((row) => row.rowConsensus === 'contested' || row.occurrence > 1)) return null;
  return consensus.rows.map((row) => {
    const amount = row.fields.amount.value as { amountMin: number | null; amountMax: number | null };
    return {
      ticker: row.fields.ticker.value as string | null,
      assetName: String(row.fields.assetName.value ?? ''),
      txDate: String(row.fields.transactionDate.value ?? ''),
      txType: row.fields.txType.value as ParsedTx['txType'],
      amountMin: amount?.amountMin ?? null,
      amountMax: amount?.amountMax ?? null,
      owner: row.fields.owner.value as ParsedTx['owner'],
      assetType: row.fields.assetType.value as ParsedTx['assetType'],
      assetTypeName: row.fields.assetTypeName.value as ParsedTx['assetTypeName'],
      isOption: row.fields.isOption.value === true,
      capGainsOver200: row.fields.capGainsOver200.value === true,
      filingStatus: row.fields.filingStatus.value as ParsedTx['filingStatus'],
      subholding: row.fields.subholding.value as ParsedTx['subholding'],
      location: row.fields.location.value as ParsedTx['location'],
      description: row.fields.description.value as ParsedTx['description'],
      supplementalText: row.fields.supplementalText.value as ParsedTx['supplementalText'],
      rawText: 'benchmark consensus simulation',
      confidence: Math.max(...reads.map((read) => read.avgConfidence)),
    };
  });
}

const BENCHMARK_SELECTION_AUDIT_WARNING =
  'Settings were saved and verified, but the benchmark selection receipt could not be persisted.';

export async function persistBenchmarkSelectionAudit(
  persist: () => Promise<void>,
): Promise<{ auditPersisted: boolean; warning?: string }> {
  try {
    await persist();
    return { auditPersisted: true };
  } catch (error) {
    console.error(
      'benchmark settings saved but selection audit persistence failed',
      error instanceof Error ? error.name : 'unknown',
    );
    return { auditPersisted: false, warning: BENCHMARK_SELECTION_AUDIT_WARNING };
  }
}

export function benchmarkReadIsAutonomous(outcome: string, rowCount: number): boolean {
  return outcome === 'would_publish' && rowCount > 0;
}

export function benchmarkUsageHasProviderReportedCost(
  usage: CandidateDocResult['usage'],
): boolean {
  const costInUsdTicks = usage?.costInUsdTicks;
  return typeof costInUsdTicks === 'number'
    && Number.isFinite(costInUsdTicks)
    && costInUsdTicks >= 0;
}

const BENCHMARK_REQUEST_PROFILE = Object.freeze({
  version: 'ct-benchmark-profile-v1',
  scoringProfile: BENCHMARK_SCORING_PROFILE,
  promptVersion: EXTRACTION_PROMPT_VERSION,
  schemaVersion: EXTRACTION_SCHEMA_VERSION,
  extractionAdapter: 'runCandidateOnDoc',
  openai: {
    pdfDetail: 'high',
    reasoningEffort: 'none',
    serviceTier: 'default',
    maxOutputTokens: 8_000,
    structuredOutputSchema: 'transaction_annotation_v1',
  },
  execution: { oneProviderModelPerCell: true },
});

interface BenchmarkPaidCallAuthorization {
  version: 1;
  scope: 'initial_model_document_cells';
  reservedDay: string | null;
  reservedCalls: number;
  documentCount: number;
  models: BenchmarkModelRef[];
}

function benchmarkPaidCallAuthorization(
  documentCount: number,
  configuredModels: Array<BenchmarkModelRef & { configured?: boolean }>,
  reservedDay: string | null,
  reservedCalls = documentCount * configuredModels.length,
): BenchmarkPaidCallAuthorization {
  return {
    version: 1,
    scope: 'initial_model_document_cells',
    reservedDay,
    reservedCalls,
    documentCount,
    models: configuredModels.map(({ provider, model }) => ({ provider, model })),
  };
}

function benchmarkRunAuthorizesInitialCell(
  runRecord: BenchmarkRunDetail,
  candidate: BenchmarkModelRef,
): boolean {
  if (!runRecord.requestProfile || typeof runRecord.requestProfile !== 'object') return false;
  const authorization = (runRecord.requestProfile as {
    paidCallAuthorization?: Partial<BenchmarkPaidCallAuthorization>;
  }).paidCallAuthorization;
  if (
    authorization?.version !== 1
    || authorization.scope !== 'initial_model_document_cells'
    || authorization.reservedDay !== new Date().toISOString().slice(0, 10)
    || authorization.documentCount !== runRecord.documents.length
    || !Array.isArray(authorization.models)
    || typeof authorization.reservedCalls !== 'number'
    || authorization.reservedCalls < 0
    || authorization.reservedCalls > runRecord.documents.length * authorization.models.length
  ) return false;
  return authorization.models.some(
    (model) => model?.provider === candidate.provider && model?.model === candidate.model,
  );
}

type BenchmarkSavedMeasurement = BenchmarkRunDetail['results'][number];
type PersistedBenchmarkDocument = BenchmarkRunDetail['documents'][number];

interface BenchmarkStoredResult {
  rows?: ParsedTx[];
  flags?: string[];
  failure?: ProviderFailureStatus;
  blockedBy?: ProviderFailureSource;
}

function benchmarkStoredResult(value: unknown): BenchmarkStoredResult {
  return value && typeof value === 'object' ? value as BenchmarkStoredResult : {};
}

function cachedBenchmarkCellPayload(
  runId: string,
  snapshot: PersistedBenchmarkDocument,
  existing: BenchmarkSavedMeasurement,
): Record<string, unknown> {
  const savedResult = benchmarkStoredResult(existing.result);
  return {
    runId,
    docId: existing.docId,
    outcome: existing.outcome,
    flags: savedResult.flags,
    rowCount: existing.rowCount,
    rows: savedResult.rows ?? [],
    comparison: existing.perfectMatch == null ? null : {
      resolved: true,
      perfectMatch: existing.perfectMatch,
      tp: existing.truePositive ?? 0,
      fp: existing.falsePositive ?? 0,
      fn: existing.falseNegative ?? 0,
      gtCount: Array.isArray(snapshot.groundTruth) ? snapshot.groundTruth.length : 0,
      candCount: existing.rowCount,
    },
    groundTruth: snapshot.groundTruth,
    ok: existing.ok,
    invoked: existing.invoked,
    error: existing.error,
    latencyMs: existing.latencyMs,
    usage: existing.usage,
    costUsd: existing.costUsd,
    costSource: existing.costSource,
    costDetail: existing.costDetail,
    resolvedModel: existing.resolvedModel,
    providerRequestId: existing.providerRequestId,
    ...(savedResult.failure ? { failure: savedResult.failure } : {}),
    ...(savedResult.blockedBy ? { blockedBy: savedResult.blockedBy } : {}),
    cached: true,
  };
}

async function fillBenchmarkProviderFailure(
  db: D1Database,
  runRecord: BenchmarkRunDetail,
  candidate: BenchmarkModelRef,
  block: ProviderFailureBlock,
): Promise<void> {
  const affectedModels = modelsAffectedByProviderFailure(
    runRecord.models,
    candidate,
    block.failure,
  );
  await saveUnavailableBenchmarkMeasurementsIfAbsent(
    db,
    affectedModels.flatMap((model) => runRecord.documents.map((document) => {
      const cost = priceBenchmarkUsage({
        provider: model.provider,
        model: model.model,
        invoked: false,
      });
      return {
        runId: runRecord.id,
        docId: document.docId,
        provider: model.provider,
        model: model.model,
        error: block.failure.code,
        costDetail: cost.costDetail,
        result: {
          rows: [],
          flags: [],
          failure: block.failure,
          blockedBy: block.source,
        },
      };
    })),
  );
}

/**
 * Keep a doc off GET /scanned-filings/pending?worker=local after the Mac
 * worker has already submitted a decision (rows, honest empty, or skip).
 * Unresolved stamp — does not fake-resolve the review row.
 */
async function stampLocalVisionSubmitted(
  env: Env,
  docId: string,
  extraTag?: string,
): Promise<void> {
  const tag = extraTag ? `local_vision_submitted,${extraTag}` : 'local_vision_submitted';
  const nowIso = new Date().toISOString();
  const open = await get<{ reason: string | null }>(
    env.DB,
    `SELECT reason FROM review_queue WHERE doc_id = ? AND resolved = 0 LIMIT 1`,
    [docId],
  );
  if (open) {
    await run(
      env.DB,
      `UPDATE review_queue
          SET reason = CASE
            WHEN reason LIKE '%local_vision_submitted%' THEN reason
            WHEN reason IS NULL OR TRIM(reason) = '' THEN ?
            ELSE reason || ',' || ?
          END
        WHERE doc_id = ? AND resolved = 0`,
      [tag, tag, docId],
    );
  } else {
    const insertResult = await run(
      env.DB,
      `INSERT OR IGNORE INTO review_queue (doc_id, reason, payload, created_at, resolved)
       VALUES (?, ?, ?, ?, 0)`,
      [docId, tag, JSON.stringify({ kind: 'local_vision_submitted', extraTag: extraTag ?? null, at: nowIso }), nowIso],
    );
    if ((insertResult.meta?.changes ?? 0) > 0) {
      void notifyReviewQueuePublisher(env, {
        docId,
        reason: tag,
        kind: 'insert',
        at: nowIso,
      });
    }
  }
  await run(
    env.DB,
    `UPDATE filings
        SET ingest_status = 'needs_review'
      WHERE doc_id = ?
        AND ingest_status NOT IN ('persisted', 'extracted')`,
    [docId],
  );
}

export const createAdminApp = buildAdminRouter;

export function buildAdminRouter(): Hono<{ Bindings: Env }> {

  const r = new Hono<{ Bindings: Env }>();


  // Auth gate applied to every admin route: full admin (bearer token OR
  // Cloudflare Access), or one of the SCOPED tokens — INGEST_TOKEN for
  // /securities/import only (sibling app pushes shared data), and
  // ADMIN_MAINTENANCE_TOKEN for the idempotent backlog-drain endpoints only
  // (agent/automation sessions never hold the full ADMIN_TOKEN).
  r.use('*', async (c, next) => {
    const env = c.env as EnvWithAdmin;
    const authorization = c.req.header('Authorization');
    if (await isAuthorizedIngest(env, c.req.path, authorization)) return next();
    if (await isAuthorizedMaintenance(env, c.req.path, authorization)) return next();
    // Always resolve the session email, even when an Authorization header is
    // present. Cookie `ct_session` covers the website; native iOS sends the
    // same opaque session as `Authorization: Bearer <session>`. A stale
    // ADMIN_TOKEN in web localStorage used to skip this path (only looked up
    // when !authorization), so allowlisted Google sessions got 401 on Review
    // Queue while the UI still showed the admin tabs. isAuthorized still
    // prefers a valid bearer ADMIN_TOKEN; a bad bearer falls through to
    // session / Access. Native session bearers are not ADMIN_TOKEN — they
    // resolve here via getCurrentUserFromRequest.
    let sessionEmail: string | undefined;
    try {
      sessionEmail = (await getCurrentUserFromRequest(c))?.email ?? undefined;
    } catch {
      sessionEmail = undefined;
    }
    const ok = await isAuthorized(env, {
      authorization,
      accessJwt: c.req.header('Cf-Access-Jwt-Assertion'),
      sessionEmail,
    });
    if (!ok) return c.json({ error: 'unauthorized' }, 401);
    await next();
  });

  // --- GET /poll-config ---------------------------------------------------
  r.get('/poll-config', async (c) => {
    const cfg = await getConfig(c.env);
    return c.json(cfg);
  });

  // --- PUT /poll-config ---------------------------------------------------
  // Accepts { schedule?: PollWindow[], aggressiveMode?: boolean }. Persists via
  // setConfig (D1 + KV cache); effective within ~60s (watcher reads getConfig).
  r.put('/poll-config', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const current = await getConfig(c.env);
    const next: PollConfig = {
      schedule: current.schedule,
      aggressiveMode: current.aggressiveMode,
      updatedAt: current.updatedAt,
    };

    if (body.schedule !== undefined) {
      const err = validateSchedule(body.schedule);
      if (err) return c.json({ error: err }, 400);
      next.schedule = body.schedule as PollWindow[];
    }
    if (body.aggressiveMode !== undefined) {
      if (typeof body.aggressiveMode !== 'boolean') {
        return c.json({ error: 'aggressiveMode must be a boolean' }, 400);
      }
      next.aggressiveMode = body.aggressiveMode;
    }

    const saved = await setConfig(c.env, next);
    return c.json(saved);
  });

  // --- GET /poll-config/aggressive ---------------------------------------
  r.get('/poll-config/aggressive', async (c) => {
    const cfg = await getConfig(c.env);
    return c.json({ aggressiveMode: cfg.aggressiveMode });
  });

  // --- GET /review-queue --------------------------------------------------
  // ?resolved=1 lists already-reviewed items (history) instead of the pending
  // queue (default 0). ingest_status distinguishes confirmed (persisted) from
  // rejected (error) for resolved items.
  //
  // Cursor-paginated, newest-first (keyset on created_at+doc_id — see
  // reviewQueueFilterWhere/encodeReviewQueueCursor above). ?limit= (default
  // 50, max 200) + ?cursor= (opaque; encodes the last row's created_at+doc_id
  // seen so far). The response carries `nextCursor` (null on the last page)
  // and `totals` — a handful of cheap COUNT/GROUP BY aggregates so the
  // dashboard header stays accurate without re-scanning the whole table.
  //
  // Filters: ?chamber= (exact match against filings.chamber) and ?reason=
  // (exact token match against the stored comma-joined reason string).
  //
  // Back-compat: a caller supplying neither `limit` nor `cursor` (the
  // pre-pagination contract) gets one page capped at REVIEW_QUEUE_MAX_LIMIT
  // rows with `truncated: true` if the queue holds more than that, instead of
  // the old unbounded (4.8MB+ at current backlog size) response.
  //
  // Per-model extraction runs are fetched only for the current page's
  // doc_ids, batched into IN (...) chunks of REVIEW_QUEUE_IN_CHUNK (<=90) to
  // stay under D1's ~100 bound-parameter-per-statement limit. Previously this
  // was a single unchunked IN (...) over the ENTIRE queue: once the pending
  // backlog passed ~100 docs, D1's bind() throws ("too many SQL variables"),
  // and that throw landed inside a catch-all try/catch here (added only to
  // tolerate a not-yet-migrated extraction_runs table) — so the whole
  // per-model payload silently degraded to `[]` for every row, with no error
  // surfaced anywhere. Chunking fixes that; each chunk still degrades
  // independently (and harmlessly) if extraction_runs doesn't exist yet.
  r.get('/review-queue', async (c) => {
    const resolved = c.req.query('resolved') === '1' ? 1 : 0;
    const chamber = c.req.query('chamber') || null;
    const reasonPrefix = c.req.query('reason') || null;

    const hasLimitParam = c.req.query('limit') !== undefined;
    const hasCursorParam = c.req.query('cursor') !== undefined;
    const legacyUnbounded = !hasLimitParam && !hasCursorParam;

    let limit = REVIEW_QUEUE_DEFAULT_LIMIT;
    if (hasLimitParam) {
      const rawLimit = parseInt(c.req.query('limit') || '', 10);
      if (Number.isFinite(rawLimit) && rawLimit > 0) limit = rawLimit;
    }
    limit = Math.min(limit, REVIEW_QUEUE_MAX_LIMIT);
    if (legacyUnbounded) limit = REVIEW_QUEUE_MAX_LIMIT;

    let cursor: ReviewQueueCursor | null = null;
    if (hasCursorParam) {
      cursor = decodeReviewQueueCursor(c.req.query('cursor') || '');
      if (!cursor) return c.json({ error: 'invalid cursor' }, 400);
    }

    const filters: ReviewQueueFilters = { resolved, chamber, reasonPrefix };
    const baseWhere = reviewQueueFilterWhere(filters);
    const clauses = [baseWhere.clause];
    const params: SqlParam[] = [...baseWhere.params];
    if (cursor) {
      clauses.push('(rq.created_at < ? OR (rq.created_at = ? AND rq.doc_id < ?))');
      params.push(cursor.createdAt, cursor.createdAt, cursor.docId);
    }

    // Fetch one extra row past the page size so we know whether another page
    // follows without a separate COUNT query.
    const rows = await all<
      ReviewRow & { ingest_status?: string | null; manual_rows?: number | null; live_rows?: number | null }
    >(
      c.env.DB,
      `SELECT
          rq.doc_id,
          rq.reason,
          rq.payload,
          rq.created_at,
          rq.resolved,
          rq.agreement_suppressed_at,
          rq.agreement_suppression_reason,
          rq.review_revision,
          rq.resolution_kind,
          rq.resolution_reason,
          rq.resolved_at,
          f.source_url,
          f.raw_object_key,
          f.doc_kind,
          f.chamber,
          f.ingest_status,
          (SELECT COUNT(*) FROM transactions t
             WHERE t.doc_id = rq.doc_id AND t.source = 'manual' AND t.deprecated_at IS NULL) AS manual_rows,
          (SELECT COUNT(*) FROM transactions t
             WHERE t.doc_id = rq.doc_id AND t.deprecated_at IS NULL) AS live_rows
        FROM review_queue rq
        LEFT JOIN filings f ON f.doc_id = rq.doc_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY rq.created_at DESC, rq.doc_id DESC
        LIMIT ?`,
      [...params, limit + 1],
    );

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && lastRow
        ? encodeReviewQueueCursor({ createdAt: lastRow.created_at ?? '', docId: lastRow.doc_id })
        : null;

    // Attach per-model extraction results (latest run per provider:model per
    // doc) — only for this page's doc_ids, chunked (see comment above).
    const modelsByDoc = new Map<string, Array<Record<string, unknown>>>();
    for (const idChunk of chunkArray(
      pageRows.map((r) => r.doc_id),
      REVIEW_QUEUE_IN_CHUNK,
    )) {
      if (!idChunk.length) continue;
      try {
        const placeholders = idChunk.map(() => '?').join(',');
        const runs = await all<{
          doc_id: string;
          provider: string;
          model: string;
          kind: string;
          ok: number;
          error: string | null;
          row_count: number;
          latency_ms: number | null;
          avg_confidence: number | null;
          created_at: string;
        }>(
          c.env.DB,
          `SELECT doc_id, provider, model, kind, ok, error, row_count, latency_ms, avg_confidence, created_at
             FROM extraction_runs WHERE doc_id IN (${placeholders})
            ORDER BY created_at DESC`,
          idChunk,
        );
        for (const er of runs) {
          const list = modelsByDoc.get(er.doc_id) ?? [];
          // Keep only the most recent run per provider:model (rows are DESC by time).
          if (list.some((m) => m.provider === er.provider && m.model === er.model)) continue;
          list.push({
            provider: er.provider,
            model: er.model,
            kind: er.kind,
            ok: er.ok === 1,
            error: er.error,
            rowCount: er.row_count,
            latencyMs: er.latency_ms,
            avgConfidence: er.avg_confidence,
            createdAt: er.created_at,
          });
          modelsByDoc.set(er.doc_id, list);
        }
      } catch {
        /* extraction_runs not migrated yet — no per-model data for this
           chunk's docs (never for the whole page: chunking keeps one bad/
           missing-table chunk from taking every other chunk down with it). */
      }
    }

    const items = pageRows.map((row) => {
      const manual = (row.manual_rows ?? 0) > 0;
      // Honest status, derived from resolution_kind (migration 0082) rather
      // than a bare "resolved" boolean — see docs/EFFORT-LOG.md for the
      // production bug this replaced (review_queue.resolved=1 for 738 docs
      // with zero live transactions, reported as an undifferentiated
      // 'resolved'). 'unverified_empty' is the tell for a legacy row this
      // migration's backfill could not honestly classify — a resolved queue
      // item with no live transactions and no recorded resolution_kind —
      // left for lane-2 recovery to find via this exact label.
      const status = !row.resolved || row.resolved === 0
        ? 'pending'
        : row.resolution_kind === 'rejected' || row.ingest_status === 'error'
          ? 'rejected'
          : row.resolution_kind === 'orphan_deleted'
            ? 'orphan_deleted'
            : manual
              ? 'modified'
              : (row.live_rows ?? 0) > 0
                ? 'published'
                : row.resolution_kind === 'verified_empty'
                  ? 'verified_empty'
                  : 'unverified_empty';
      return {
        docId: row.doc_id,
        reason: row.reason ?? '',
        payload: row.payload ? safeJson(row.payload) : null,
        createdAt: row.created_at ?? '',
        resolved: row.resolved === 1,
        status,
        resolutionKind: row.resolution_kind ?? null,
        resolutionReason: row.resolution_reason ?? null,
        resolvedAt: row.resolved_at ?? null,
        ingestStatus: row.ingest_status ?? '',
        sourceUrl: row.source_url ?? '',
        // Admin UI opens stored R2 bytes only (never government source_url).
        // /api/documents/.../pdf is Premium-gated; admin raw accepts admin auth.
        pdfUrl: `/api/admin/filings/${encodeURIComponent(row.doc_id)}/raw`,
        storedDocumentUrl: `/api/admin/filings/${encodeURIComponent(row.doc_id)}/raw`,
        rawObjectKey: row.raw_object_key ?? '',
        docKind: row.doc_kind ?? '',
        chamber: row.chamber ?? '',
        agreementSuppressedAt: row.agreement_suppressed_at ?? '',
        agreementSuppressionReason: row.agreement_suppression_reason ?? '',
        reviewRevision: row.review_revision ?? 1,
        models: modelsByDoc.get(row.doc_id) ?? [],
      };
    });

    const totals = await reviewQueueTotals(c.env.DB, filters);

    const body: Record<string, unknown> = {
      items,
      count: items.length,
      resolved: resolved === 1,
      nextCursor,
      totals,
    };
    // Only surface `truncated` on the legacy unbounded call shape — an
    // explicit limit/cursor caller asked for a bounded page on purpose, that
    // isn't "truncation".
    if (legacyUnbounded) body.truncated = hasMore;
    return c.json(body);
  });

  // --- GET /ingestion-decisions ------------------------------------------
  // Append-only filing/trade decision history. Unlike review_queue, this also
  // includes clean auto-published filings that never needed human review.
  r.get('/ingestion-decisions', async (c) => {
    const rawLimit = parseInt(c.req.query('limit') || '100', 10);
    const limit = Number.isFinite(rawLimit) ? rawLimit : 100;
    const docId = c.req.query('docId') || null;
    try {
      const items = await listIngestionDecisions(c.env.DB, { limit, docId });
      return c.json({ items, count: items.length, available: true });
    } catch (err) {
      const msg = (err as Error).message;
      if (/no such table|ingestion_decisions/i.test(msg)) {
        return c.json({ items: [], count: 0, available: false });
      }
      return c.json({ error: msg }, 500);
    }
  });

  // --- GET /review/:docId/extractions -------------------------------------
  // Full stored readings (result_json) for one document, newest first — powers
  // the dashboard's "view each model's reading" panel. Separate from the list
  // endpoint so the heavy result_json is only fetched on demand.
  r.get('/review/:docId/extractions', async (c) => {
    const docId = c.req.param('docId');
    let runs: Array<Record<string, unknown>> = [];
    let consensus: ReturnType<typeof buildConsensusRows> | null = null;
    let consensusStatus: {
      batchId: string;
      kind: string;
      createdAt: string;
      attemptedModels: string[];
      successfulModels: string[];
      failedModels: Array<{ model: string; error: string | null }>;
      blockedReason: string | null;
    } | null = null;
    try {
      const rowsE = await all<{
        id: string;
        batch_id: string | null;
        provider: string;
        model: string;
        kind: string;
        ok: number;
        error: string | null;
        row_count: number;
        latency_ms: number | null;
        avg_confidence: number | null;
        result_json: string | null;
        created_at: string;
      }>(
        c.env.DB,
        `SELECT id, batch_id, provider, model, kind, ok, error, row_count, latency_ms, avg_confidence, result_json, created_at
           FROM extraction_runs WHERE doc_id = ? ORDER BY created_at DESC`,
        [docId],
      );
      runs = rowsE.map((er) => ({
        id: er.id,
        batchId: er.batch_id,
        provider: er.provider,
        model: er.model,
        kind: er.kind,
        ok: er.ok === 1,
        error: er.error,
        rowCount: er.row_count,
        latencyMs: er.latency_ms,
        avgConfidence: er.avg_confidence,
        rows: er.result_json ? safeJson(er.result_json) : [],
        createdAt: er.created_at,
      }));

      // Consensus must come from ONE coherent invocation. Never assemble a
      // synthetic electorate from unrelated batches or replace a newer failed
      // attempt with an older success from the same model: that can make stale
      // readings look current and unanimous. A single-model batch is not a
      // consensus attempt, so it does not supersede the latest batch that
      // actually attempted at least two distinct models.
      const CONSENSUS_KINDS = new Set(['agreement', 'bakeoff', 'batch']);
      type ExtractionRunRow = (typeof rowsE)[number];
      const runSets = new Map<string, {
        batchId: string;
        kind: string;
        createdAt: string;
        byModel: Map<string, ExtractionRunRow>;
      }>();
      for (const er of rowsE) {
        if (!er.batch_id || !CONSENSUS_KINDS.has(er.kind)) continue;
        const runSetKey = `${er.kind}:${er.batch_id}`;
        let runSet = runSets.get(runSetKey);
        if (!runSet) {
          runSet = {
            batchId: er.batch_id,
            kind: er.kind,
            createdAt: er.created_at,
            byModel: new Map(),
          };
          runSets.set(runSetKey, runSet);
        } else if (er.created_at > runSet.createdAt) {
          runSet.createdAt = er.created_at;
        }

        const modelKey = `${er.provider}:${er.model}`;
        const prior = runSet.byModel.get(modelKey);
        // Duplicate model rows in one batch are abnormal. Use the newest; when
        // timestamps tie, prefer the failure so ambiguous persistence cannot
        // manufacture a successful vote.
        if (
          !prior ||
          er.created_at > prior.created_at ||
          (er.created_at === prior.created_at && er.ok !== 1 && prior.ok === 1)
        ) {
          runSet.byModel.set(modelKey, er);
        }
      }

      const latestComparable = [...runSets.values()]
        .filter((runSet) => runSet.byModel.size >= 2)
        .sort((a, b) =>
          b.createdAt.localeCompare(a.createdAt) ||
          b.batchId.localeCompare(a.batchId) ||
          b.kind.localeCompare(a.kind),
        )[0];

      if (latestComparable) {
        const attemptedModels = [...latestComparable.byModel.keys()].sort();
        const successfulModels: string[] = [];
        const failedModels: Array<{ model: string; error: string | null }> = [];
        const coherentRuns: ConsensusRun[] = [];
        for (const model of attemptedModels) {
          const er = latestComparable.byModel.get(model);
          if (!er) continue;
          if (er.ok !== 1) {
            failedModels.push({ model, error: er.error });
            coherentRuns.push({ model, rows: [] });
            continue;
          }
          const parsed = er.result_json ? safeJson(er.result_json) : [];
          if (!Array.isArray(parsed)) {
            failedModels.push({ model, error: 'stored result is not a transaction array' });
            coherentRuns.push({ model, rows: [] });
            continue;
          }
          successfulModels.push(model);
          coherentRuns.push({
            model,
            rows: parsed as ConsensusRun['rows'],
          });
        }

        const blockedReason = successfulModels.length < 2
          ? 'Latest comparable run set has fewer than two successful model readings; older successes were not mixed in.'
          : null;
        consensusStatus = {
          batchId: latestComparable.batchId,
          kind: latestComparable.kind,
          createdAt: latestComparable.createdAt,
          attemptedModels,
          successfulModels,
          failedModels,
          blockedReason,
        };
        if (!blockedReason) consensus = buildConsensusRows(coherentRuns);
      }
    } catch {
      /* extraction_runs not migrated yet */
    }
    return c.json({ docId, runs, count: runs.length, consensus, consensusStatus });
  });

  // --- POST /review/:docId ------------------------------------------------
  // Body: { decision: 'confirm'|'reject'|'manual', reviewRevision, edits?: EditedTx[] }
  //   confirm -> insert corrected transactions (source='primary'), mark review
  //              resolved, set filing persisted, enqueue delivery.dispatch each.
  //   manual  -> same as confirm but recorded as source='manual' — the admin
  //              hand-entered the rows because the automated read was wrong / too
  //              low-confidence to trust. Flagged so admins can tell them apart.
  //   reject  -> mark review resolved + filing status 'error'.
  r.post('/review/:docId', async (c) => {
    const docId = c.req.param('docId');
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const decision = body.decision;
    if (decision !== 'confirm' && decision !== 'reject' && decision !== 'manual') {
      return c.json({ error: "decision must be 'confirm', 'reject', or 'manual'" }, 400);
    }

    let review: ReviewRow | null;
    try {
      review = await get<ReviewRow>(
        c.env.DB,
        `SELECT doc_id, reason, payload, created_at, resolved, review_revision
           FROM review_queue WHERE doc_id = ?`,
        [docId],
      );
    } catch (err) {
      if (/review_revision|no such column/i.test((err as Error).message)) {
        return c.json({ error: 'review revision migration is not applied yet' }, 503);
      }
      throw err;
    }
    if (!review) return c.json({ error: 'review item not found' }, 404);
    if (review.resolved === 1) {
      return c.json({ error: 'review item already resolved' }, 409);
    }
    if (!Number.isInteger(body.reviewRevision) || Number(body.reviewRevision) < 1) {
      return c.json({ error: 'reviewRevision must be a positive integer from the review queue item' }, 400);
    }
    const reviewRevision = review.review_revision ?? 1;
    if (body.reviewRevision !== reviewRevision) {
      return c.json({ error: 'review item changed; reload it before deciding' }, 409);
    }

    if (decision === 'reject') {
      const nowIso = new Date().toISOString();
      const rejectionReason = `rejected: ${review.reason ?? 'rejected by admin'}`;
      const rejectResults = await batch(c.env.DB, [
        [
          `UPDATE transactions
              SET deprecated_at = ?, deprecated_reason = ?
            WHERE doc_id = ? AND source IN (${PIPELINE_TX_SOURCES_SQL})
              AND deprecated_at IS NULL
              AND EXISTS (SELECT 1 FROM review_queue
                WHERE doc_id = ? AND resolved = 0 AND review_revision = ?)`,
          [nowIso, rejectionReason, docId, docId, reviewRevision],
        ],
        [
          `UPDATE filings SET ingest_status = ?
            WHERE doc_id = ? AND EXISTS (
              SELECT 1 FROM review_queue
               WHERE doc_id = ? AND resolved = 0 AND review_revision = ?
            )`,
          ['error', docId, docId, reviewRevision],
        ],
        [
          `UPDATE review_queue
              SET resolved = 1,
                  reason = ?,
                  agreement_suppressed_at = ?,
                  agreement_suppression_reason = ?,
                  resolution_kind = 'rejected',
                  resolution_reason = ?,
                  resolved_at = ?,
                  review_revision = review_revision + 1
            WHERE doc_id = ? AND resolved = 0 AND review_revision = ?`,
          [rejectionReason, nowIso, rejectionReason, rejectionReason, nowIso, docId, reviewRevision],
        ],
      ]);
      if ((rejectResults[rejectResults.length - 1]?.meta?.changes ?? 0) === 0) {
        return c.json({ error: 'review item changed; reload it before deciding' }, 409);
      }
      try {
        await recordIngestionDecision(c.env.DB, {
          docId,
          action: 'rejected',
          source: 'admin',
          actor: adminActor(c),
          reason: review.reason ?? 'rejected',
          payload: {
            reviewCreatedAt: review.created_at,
            reviewPayload: review.payload ? safeJson(review.payload) : null,
          },
          createdAt: nowIso,
        });
      } catch (err) {
        console.error('review reject: audit receipt failed', docId, (err as Error).message);
      }
      return c.json({ docId, decision: 'reject', resolved: true });
    }

    // confirm/manual: insert the (corrected or hand-entered) transactions.
    // 'manual' tags provenance so admins can tell hand-entered rows from machine reads.
    const source: TxSource = decision === 'manual' ? 'manual' : 'primary';
    if (!Array.isArray(body.edits)) {
      return c.json(
        {
          error:
            decision === 'confirm'
              ? 'confirm requires explicit transaction edits; choose a model, edit the queued rows, or reject the item'
              : 'manual review requires explicit transaction edits',
        },
        400,
      );
    }
    const rawEdits = body.edits as unknown[];
    if (rawEdits.length === 0) {
      return c.json(
        {
          error:
            decision === 'confirm'
              ? 'confirm requires at least one explicit transaction edit; use Manual to add rows or Reject to discard'
              : 'manual review requires at least one transaction edit',
        },
        400,
      );
    }
    // N-of-M under-transcription guard: don't let confirm/manual silently
    // shrink a filing to fewer rows than the stored extraction itself
    // claimed/held. This is what let Kupor (E-2026-scott-a-kupor-01-09-2026-278t)
    // get manually confirmed with 1 of 3 real transactions — nothing compared
    // the confirm against the extraction's own completeness signal.
    const storedCount = storedReviewTransactionCount(review.payload);
    if (storedCount > rawEdits.length && body.acknowledgeUnderTranscription !== true) {
      return c.json(
        {
          error: `confirm has fewer transactions (${rawEdits.length}) than the stored extraction found (${storedCount}) — pass acknowledgeUnderTranscription: true to confirm anyway, or add the missing rows`,
        },
        409,
      );
    }

    const filing = await get<{ filer_id: string | null; first_seen_at: string | null; filed_date: string | null; filing_status: string | null }>(
      c.env.DB,
      'SELECT filer_id, first_seen_at, filed_date, filing_status FROM filings WHERE doc_id = ?',
      [docId],
    );
    if (!filing) {
      await run(
        c.env.DB,
        `UPDATE review_queue
            SET resolved = 1,
                reason = 'orphan_filing_deleted',
                resolution_kind = 'orphan_deleted',
                resolution_reason = 'orphan_filing_deleted',
                resolved_at = CURRENT_TIMESTAMP
          WHERE doc_id = ? AND resolved = 0`,
        [docId],
      );
      return c.json({ docId, decision: 'orphan_resolved', resolved: true });
    }
    const filingFilerId = filing?.filer_id ?? null;
    const validated = validateReviewEdits(rawEdits, filing.filed_date);
    if ('error' in validated) return c.json({ error: validated.error }, 400);
    const edits = validated.edits;

    const nowIso = new Date().toISOString();
    const insertRows: Array<Record<string, string | number | null>> = [];
    const rowKeys: string[] = [];
    const proposedIds: string[] = [];
    for (const [rowIndex, e] of edits.entries()) {
      const id = uuid();
      const assetTypeName = reviewAssetTypeName(e);
      const rowKey = transactionRowKey(source, rowIndex, {
        txDate: e.txDate,
        owner: e.owner,
        assetName: e.assetName ?? '',
        ticker: e.ticker ?? null,
        assetType: e.assetType ?? null,
        assetTypeName,
        txType: e.txType,
        amountMin: e.amountMin ?? null,
        amountMax: e.amountMax ?? null,
        isOption: Boolean(e.isOption),
        capGainsOver200: Boolean(e.capGainsOver200),
        rawText: e.rawText ?? '',
        filingStatus: e.filingStatus ?? null,
        subholding: e.subholding ?? null,
        location: e.location ?? null,
        description: e.description ?? null,
        supplementalText: e.supplementalText ?? null,
      });
      rowKeys.push(rowKey);
      proposedIds.push(id);
      insertRows.push({
        id,
        docId,
        filerId: e.filerId ?? filingFilerId,
        txDate: e.txDate,
        owner: e.owner,
        assetName: e.assetName ?? '',
        ticker: e.ticker ?? null,
        assetType: e.assetType ?? null,
        txType: e.txType,
        amountMin: e.amountMin ?? null,
        amountMax: e.amountMax ?? null,
        isOption: e.isOption ? 1 : 0,
        capGainsOver200: e.capGainsOver200 ? 1 : 0,
        rawText: e.rawText ?? '',
        assetTypeName,
        filingStatus: e.filingStatus ?? null,
        subholding: e.subholding ?? null,
        location: e.location ?? null,
        description: e.description ?? null,
        supplementalText: e.supplementalText ?? null,
        rowKey,
        confidence: e.confidence ?? 1,
        source,
        createdAt: nowIso,
        firstSeenAt: filing.first_seen_at ?? null,
        filedDate: filing.filed_date ?? null,
        estValue: estimateTransactionValue(e.amountMin, e.amountMax),
      });
    }

    const rowKeysJson = JSON.stringify(rowKeys);
    const insertRowsJson = JSON.stringify(insertRows);
    const completeLiveSet = `(SELECT COUNT(*) FROM transactions
      WHERE doc_id = ? AND source = ? AND deprecated_at IS NULL
        AND row_key IN (SELECT value FROM json_each(?))) = ?
      AND (SELECT COUNT(*) FROM transactions
        WHERE doc_id = ? AND source IN (${PIPELINE_TX_SOURCES_SQL})
          AND deprecated_at IS NULL) = ?`;
    let persistResults: D1Result[];
    try {
      persistResults = await batch(c.env.DB, [
        // One JSON-backed INSERT keeps even the 223-row live backlog item well
        // below D1's per-invocation query and per-query parameter ceilings.
        [
          `INSERT OR IGNORE INTO transactions (
             id, doc_id, filer_id, tx_date, owner, asset_name, ticker, asset_type,
             tx_type, amount_min, amount_max, is_option, cap_gains_over_200,
             raw_text, asset_type_name, filing_status, subholding, location,
             description, supplemental_text, row_key, confidence, source,
             created_at, cursor_seq, first_seen_at, filed_date, est_value
           ) SELECT
             json_extract(value, '$.id'), json_extract(value, '$.docId'),
             json_extract(value, '$.filerId'), json_extract(value, '$.txDate'),
             json_extract(value, '$.owner'), json_extract(value, '$.assetName'),
             json_extract(value, '$.ticker'), json_extract(value, '$.assetType'),
             json_extract(value, '$.txType'), json_extract(value, '$.amountMin'),
             json_extract(value, '$.amountMax'), json_extract(value, '$.isOption'),
             json_extract(value, '$.capGainsOver200'), json_extract(value, '$.rawText'),
             json_extract(value, '$.assetTypeName'), json_extract(value, '$.filingStatus'),
             json_extract(value, '$.subholding'), json_extract(value, '$.location'),
             json_extract(value, '$.description'), json_extract(value, '$.supplementalText'),
             json_extract(value, '$.rowKey'), json_extract(value, '$.confidence'),
             json_extract(value, '$.source'), json_extract(value, '$.createdAt'), NULL,
             json_extract(value, '$.firstSeenAt'), json_extract(value, '$.filedDate'),
             json_extract(value, '$.estValue')
           FROM json_each(?)
           WHERE EXISTS (
             SELECT 1 FROM review_queue
              WHERE doc_id = ? AND resolved = 0 AND review_revision = ?
           )`,
          [insertRowsJson, docId, reviewRevision],
        ],
        // Force a primary-key error when the post-insert live set is not exact.
        // D1 then rolls back the whole batch; a zero-change final UPDATE alone
        // would still commit preceding inserts.
        [
          `INSERT INTO review_queue (doc_id)
            SELECT ?
             WHERE EXISTS (
               SELECT 1 FROM review_queue
                WHERE doc_id = ? AND resolved = 0 AND review_revision = ?
             )
               AND NOT (${completeLiveSet})`,
          [
            docId, docId, reviewRevision,
            docId, source, rowKeysJson, rowKeys.length,
            docId, rowKeys.length,
          ],
        ],
        [
          `INSERT OR IGNORE INTO delivery_outbox
             (tx_id, status, attempts, available_at, last_error, created_at, updated_at)
            SELECT id, 'pending', 0, ?, NULL, ?, ? FROM transactions
             WHERE doc_id = ? AND source = ? AND deprecated_at IS NULL
               AND row_key IN (SELECT value FROM json_each(?))
               AND EXISTS (
                 SELECT 1 FROM review_queue
                  WHERE doc_id = ? AND resolved = 0 AND review_revision = ?
               )`,
          [nowIso, nowIso, nowIso, docId, source, rowKeysJson, docId, reviewRevision],
        ],
        [
          `UPDATE filings SET ingest_status = ?
            WHERE doc_id = ?
              AND EXISTS (SELECT 1 FROM review_queue
                WHERE doc_id = ? AND resolved = 0 AND review_revision = ?)
              AND ${completeLiveSet}`,
          [
            'persisted', docId, docId, reviewRevision,
            docId, source, rowKeysJson, rowKeys.length,
            docId, rowKeys.length,
          ],
        ],
        [
          `UPDATE review_queue
              SET resolved = 1,
                  agreement_suppressed_at = NULL,
                  agreement_suppression_reason = NULL,
                  resolution_kind = 'published',
                  resolution_reason = ?,
                  resolved_at = CURRENT_TIMESTAMP,
                  review_revision = review_revision + 1
            WHERE doc_id = ? AND resolved = 0 AND review_revision = ?
              AND ${completeLiveSet}`,
          [
            decision === 'manual' ? 'admin_manual' : 'admin_confirmed',
            docId, reviewRevision,
            docId, source, rowKeysJson, rowKeys.length,
            docId, rowKeys.length,
          ],
        ],
      ]);
    } catch (err) {
      if (/UNIQUE constraint failed: review_queue\.doc_id/i.test((err as Error).message)) {
        return c.json({ error: 'edited rows do not exactly replace the live filing rows' }, 409);
      }
      throw err;
    }
    const resolvedResult = persistResults[persistResults.length - 1];
    if ((resolvedResult?.meta?.changes ?? 0) === 0) {
      return c.json({ error: 'review item changed or not all edited rows could be persisted' }, 409);
    }
    const insertedCount = persistResults[0]?.meta?.changes ?? 0;
    const newlyInsertedIds = insertedCount === proposedIds.length ? proposedIds : [];
    let transactionIds = newlyInsertedIds;
    try {
      const liveRows = await all<{ id: string }>(
        c.env.DB,
        `SELECT id FROM transactions
          WHERE doc_id = ? AND source = ? AND deprecated_at IS NULL
            AND row_key IN (SELECT value FROM json_each(?))`,
        [docId, source, rowKeysJson],
      );
      transactionIds = liveRows.map((row) => row.id);
    } catch (err) {
      console.error('review confirm: live transaction lookup failed', docId, (err as Error).message);
    }

    // Best-effort immediate flush; the independent delivery-outbox cron owns
    // durable recovery for any enqueue failure or rows beyond this pass.
    const delivery = await flushDeliveryOutbox(c.env, {
      txIds: transactionIds,
      limit: Math.max(transactionIds.length, 1),
    }).catch((err) => {
      console.warn('review confirm: delivery outbox flush failed', docId, (err as Error).message);
      return null;
    });

    let deprecatedPredecessors = 0;
    const isAmendment = /amend|\(2\)|278t\(\d+\)/i.test(docId) || (filing.filing_status && /amend/i.test(filing.filing_status));
    if (isAmendment && filingFilerId) {
      deprecatedPredecessors = await deprecatePredecessorFilingTransactions(
        c.env.DB,
        docId,
        filingFilerId,
        filing.filed_date ?? null,
        nowIso,
      );
    }

    try {
      await recordIngestionDecision(c.env.DB, {
        docId,
        action: decision === 'manual' ? 'manual' : 'confirmed',
        source: 'admin',
        actor: adminActor(c),
        reason: review.reason ?? null,
        transactionIds,
        payload: {
          source,
          editCount: edits.length,
          inserted: insertedCount,
          deprecatedPredecessors,
          reviewCreatedAt: review.created_at,
        },
        createdAt: nowIso,
      });
    } catch (err) {
      console.error('review confirm: audit receipt failed', docId, (err as Error).message);
    }

    return c.json({
      docId,
      decision,
      source,
      resolved: true,
      inserted: insertedCount,
      transactionIds,
      delivery,
    });
  });

  // --- POST /review/:docId/unpublish --------------------------------------
  // Retract a previously-published filing: soft-delete its pipeline transactions
  // (primary/manual/local_mac/server_cpu), revert the filing to 'needs_review',
  // and re-open the review item so it returns to the pending queue. Soft-delete
  // (not hard delete) keeps history and lets every feed/analytics/stream/filing-detail
  // read exclude the rows via
  // `deprecated_at IS NULL`. Already-delivered webhook/SSE events cannot be
  // recalled — this stops the rows being served going forward.
  // Body: { reviewRevision: number, reason?: string }
  r.post('/review/:docId/unpublish', async (c) => {
    const docId = c.req.param('docId');
    let body: Record<string, unknown> = {};
    try {
      const raw = await c.req.text();
      if (raw) body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const reason = typeof body.reason === 'string' && body.reason.length ? body.reason : 'unpublished by admin';
    if (!Number.isInteger(body.reviewRevision) || Number(body.reviewRevision) < 1) {
      return c.json({ error: 'reviewRevision must be a positive integer from the review queue item' }, 400);
    }

    let review: { resolved: number; review_revision: number; ingest_status: string | null } | null;
    try {
      review = await get(
        c.env.DB,
        `SELECT rq.resolved, rq.review_revision, f.ingest_status
           FROM review_queue rq JOIN filings f ON f.doc_id = rq.doc_id
          WHERE rq.doc_id = ?`,
        [docId],
      );
    } catch (err) {
      if (/review_revision|no such column/i.test((err as Error).message)) {
        return c.json({ error: 'review revision migration is not applied yet' }, 503);
      }
      throw err;
    }
    if (!review) return c.json({ error: 'review item or filing not found' }, 404);
    if (review.resolved !== 1) return c.json({ error: 'review item is already pending' }, 409);
    const reviewRevision = Number(body.reviewRevision);
    if (review.review_revision !== reviewRevision) {
      return c.json({ error: 'review item changed; reload it before unpublishing' }, 409);
    }

    const nowIso = new Date().toISOString();
    const holdReason = 'unpublished: ' + reason;
    const deprecatedSql = `UPDATE transactions
      SET deprecated_at = ?, deprecated_reason = ?
      WHERE doc_id = ? AND source IN (${PIPELINE_TX_SOURCES_SQL}) AND deprecated_at IS NULL
        AND EXISTS (SELECT 1 FROM review_queue
          WHERE doc_id = ? AND resolved = 1 AND review_revision = ?)`;
    const filingSql = `UPDATE filings SET ingest_status = ?
      WHERE doc_id = ? AND EXISTS (SELECT 1 FROM review_queue
        WHERE doc_id = ? AND resolved = 1 AND review_revision = ?)`;
    let results;
    try {
      results = await batch(c.env.DB, [
        [deprecatedSql, [nowIso, reason, docId, docId, reviewRevision]],
        [filingSql, ['needs_review', docId, docId, reviewRevision]],
        [
          `UPDATE review_queue
              SET resolved = 0,
                  reason = ?,
                  created_at = ?,
                  agreement_attempted_at = NULL,
                  agreement_attempts = 0,
                  agreement_tier = NULL,
                  agreement_next_attempt_at = NULL,
                  agreement_claim_token = NULL,
                  agreement_claimed_at = NULL,
                  agreement_suppressed_at = ?,
                  agreement_suppression_reason = ?,
                  resolution_kind = NULL,
                  resolution_reason = NULL,
                  resolved_at = NULL,
                  review_revision = review_revision + 1
            WHERE doc_id = ? AND resolved = 1 AND review_revision = ?`,
          [holdReason, nowIso, nowIso, holdReason, docId, reviewRevision],
        ],
      ]);
    } catch (err) {
      console.error('review unpublish batch failed', docId, (err as Error).message);
      return c.json({ error: 'unpublish failed', detail: (err as Error).message }, 500);
    }
    if ((results[results.length - 1]?.meta?.changes ?? 0) === 0) {
      return c.json({ error: 'review item changed before it could be unpublished' }, 409);
    }
    const deprecated = results[0]?.meta?.changes ?? 0;
    void notifyReviewQueuePublisher(c.env, {
      docId,
      reason: holdReason,
      kind: 'reopen',
      at: nowIso,
    });

    try {
      await recordIngestionDecision(c.env.DB, {
        docId,
        action: 'unpublished',
        source: 'admin',
        actor: adminActor(c),
        reason,
        payload: { deprecatedTransactions: deprecated },
        createdAt: nowIso,
      });
    } catch (err) {
      console.error('review unpublish: audit receipt failed', docId, (err as Error).message);
    }

    return c.json({
      docId,
      unpublished: true,
      deprecatedTransactions: deprecated,
      reason,
      reviewRevision: reviewRevision + 1,
    });
  });

  // --- POST /review/:docId/reopen-rejected --------------------------------
  // Reopen a terminal reject for manual extraction/confirm. Separate from
  // /unpublish, which targets previously published rows and currently returns
  // an opaque HTTP 500 for some rejected executive 278-Ts (e.g. Trump).
  // Body: { reviewRevision: number, reason?: string }
  r.post('/review/:docId/reopen-rejected', async (c) => {
    const docId = c.req.param('docId');
    let body: Record<string, unknown> = {};
    try {
      const raw = await c.req.text();
      if (raw) body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const reason =
      typeof body.reason === 'string' && body.reason.length
        ? body.reason
        : 'reopened after reject for manual extraction';
    if (!Number.isInteger(body.reviewRevision) || Number(body.reviewRevision) < 1) {
      return c.json({ error: 'reviewRevision must be a positive integer from the review queue item' }, 400);
    }

    let review: {
      resolved: number;
      review_revision: number;
      resolution_kind: string | null;
    } | null;
    try {
      review = await get(
        c.env.DB,
        `SELECT rq.resolved, rq.review_revision, rq.resolution_kind
           FROM review_queue rq
          WHERE rq.doc_id = ?`,
        [docId],
      );
    } catch (err) {
      return c.json({ error: 'review schema unavailable', detail: (err as Error).message }, 503);
    }
    if (!review) return c.json({ error: 'review item not found' }, 404);
    if (review.resolved !== 1) return c.json({ error: 'review item is already pending' }, 409);
    if (review.resolution_kind !== 'rejected') {
      return c.json({
        error: 'review item is not a reject; use /unpublish for published rows',
        resolutionKind: review.resolution_kind,
      }, 409);
    }
    const reviewRevision = Number(body.reviewRevision);
    if (review.review_revision !== reviewRevision) {
      return c.json({ error: 'review item changed; reload it before reopening' }, 409);
    }

    const nowIso = new Date().toISOString();
    const holdReason = 'reopened_after_reject: ' + reason;
    try {
      const results = await batch(c.env.DB, [
        [
          `UPDATE review_queue
              SET resolved = 0,
                  reason = ?,
                  agreement_attempted_at = NULL,
                  agreement_attempts = 0,
                  agreement_tier = NULL,
                  agreement_next_attempt_at = NULL,
                  agreement_claim_token = NULL,
                  agreement_claimed_at = NULL,
                  agreement_suppressed_at = ?,
                  agreement_suppression_reason = ?,
                  resolution_kind = NULL,
                  resolution_reason = NULL,
                  resolved_at = NULL,
                  review_revision = review_revision + 1
            WHERE doc_id = ? AND resolved = 1 AND review_revision = ? AND resolution_kind = 'rejected'`,
          [holdReason, nowIso, holdReason, docId, reviewRevision],
        ],
        [
          `UPDATE filings SET ingest_status = 'needs_review' WHERE doc_id = ?`,
          [docId],
        ],
      ]);
      if ((results[0]?.meta?.changes ?? 0) === 0) {
        return c.json({ error: 'review item changed before it could be reopened' }, 409);
      }
    } catch (err) {
      console.error('reopen-rejected failed', docId, (err as Error).message);
      return c.json({ error: 'reopen-rejected failed', detail: (err as Error).message }, 500);
    }

    void notifyReviewQueuePublisher(c.env, {
      docId,
      reason: holdReason,
      kind: 'reopen',
      at: nowIso,
    });

    try {
      await recordIngestionDecision(c.env.DB, {
        docId,
        action: 'reopened_after_reject',
        source: 'admin',
        actor: adminActor(c),
        reason,
        payload: {},
        createdAt: nowIso,
      });
    } catch (err) {
      console.error('reopen-rejected: audit receipt failed', docId, (err as Error).message);
    }

    return c.json({
      docId,
      reopened: true,
      reason,
      reviewRevision: reviewRevision + 1,
    });
  });

  // --- GET /diagnostics/source-overlap -----------------------------------
  // Same-doc_id live rows in more than one of primary/manual/local_mac/
  // server_cpu. Confirm-then-chunk leftover (H-2025-8221264) is this class.
  r.get('/diagnostics/source-overlap', async (c) => {
    const rows = await all<{
      doc_id: string;
      primary_n: number;
      manual_n: number;
      local_mac_n: number;
      server_cpu_n: number;
    }>(
      c.env.DB,
      `SELECT doc_id,
              SUM(CASE WHEN source = 'primary' THEN 1 ELSE 0 END) AS primary_n,
              SUM(CASE WHEN source = 'manual' THEN 1 ELSE 0 END) AS manual_n,
              SUM(CASE WHEN source = 'local_mac' THEN 1 ELSE 0 END) AS local_mac_n,
              SUM(CASE WHEN source = 'server_cpu' THEN 1 ELSE 0 END) AS server_cpu_n
         FROM transactions
        WHERE deprecated_at IS NULL
          AND source IN (${PIPELINE_TX_SOURCES_SQL})
        GROUP BY doc_id
       HAVING (
                (SUM(CASE WHEN source = 'primary' THEN 1 ELSE 0 END) > 0)
              + (SUM(CASE WHEN source = 'manual' THEN 1 ELSE 0 END) > 0)
              + (SUM(CASE WHEN source = 'local_mac' THEN 1 ELSE 0 END) > 0)
              + (SUM(CASE WHEN source = 'server_cpu' THEN 1 ELSE 0 END) > 0)
              ) > 1
        LIMIT 200`,
      [],
    );
    return c.json({
      count: rows.length,
      docs: rows.map((row) => ({
        docId: row.doc_id,
        primary: Number(row.primary_n) || 0,
        manual: Number(row.manual_n) || 0,
        localMac: Number(row.local_mac_n) || 0,
        serverCpu: Number(row.server_cpu_n) || 0,
      })),
    });
  });

  // --- POST /review/:docId/retire-superseded-sources ---------------------
  // Repair: a complete local_mac/server_cpu set is already live, but leftover
  // primary/manual rows from a truncated confirm still sit on the same doc_id.
  // Soft-deletes those leftovers. Does not reopen review or insert rows.
  // Body: { reviewRevision: number }
  r.post('/review/:docId/retire-superseded-sources', async (c) => {
    const docId = c.req.param('docId');
    let body: Record<string, unknown> = {};
    try {
      const raw = await c.req.text();
      if (raw) body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if (!Number.isInteger(body.reviewRevision) || Number(body.reviewRevision) < 1) {
      return c.json({ error: 'reviewRevision must be a positive integer from the review queue item' }, 400);
    }

    const review = await get<{
      resolved: number;
      review_revision: number;
      ingest_status: string | null;
    }>(
      c.env.DB,
      `SELECT rq.resolved, rq.review_revision, f.ingest_status
         FROM review_queue rq JOIN filings f ON f.doc_id = rq.doc_id
        WHERE rq.doc_id = ?`,
      [docId],
    );
    if (!review) return c.json({ error: 'review item or filing not found' }, 404);
    if (review.resolved !== 1) return c.json({ error: 'review item is still pending' }, 409);
    const reviewRevision = Number(body.reviewRevision);
    if (review.review_revision !== reviewRevision) {
      return c.json({ error: 'review item changed; reload it before retiring sources' }, 409);
    }
    if (review.ingest_status !== 'persisted') {
      return c.json({ error: 'filing is not persisted' }, 409);
    }

    const live = await get<{ vision_n: number; leftover_n: number }>(
      c.env.DB,
      `SELECT
          SUM(CASE WHEN source IN ('local_mac', 'server_cpu') THEN 1 ELSE 0 END) AS vision_n,
          SUM(CASE WHEN source IN ('primary', 'manual') THEN 1 ELSE 0 END) AS leftover_n
         FROM transactions
        WHERE doc_id = ? AND deprecated_at IS NULL
          AND source IN (${PIPELINE_TX_SOURCES_SQL})`,
      [docId],
    );
    const visionN = Number(live?.vision_n) || 0;
    const leftoverN = Number(live?.leftover_n) || 0;
    if (visionN <= 0) {
      return c.json({ error: 'no live local_mac/server_cpu rows to keep' }, 409);
    }
    if (leftoverN <= 0) {
      return c.json({
        docId,
        retired: false,
        deprecatedTransactions: 0,
        reason: 'no leftover primary/manual rows',
        reviewRevision,
      });
    }

    const nowIso = new Date().toISOString();
    const results = await batch(c.env.DB, [
      [
        `UPDATE transactions
            SET deprecated_at = ?, deprecated_reason = ?
          WHERE doc_id = ? AND source IN ('primary', 'manual') AND deprecated_at IS NULL
            AND EXISTS (SELECT 1 FROM transactions
              WHERE doc_id = ? AND source IN ('local_mac', 'server_cpu') AND deprecated_at IS NULL)
            AND EXISTS (SELECT 1 FROM review_queue
              WHERE doc_id = ? AND resolved = 1 AND review_revision = ?)`,
        [nowIso, VISION_SUPERSEDE_REASON, docId, docId, docId, reviewRevision],
      ],
      [
        `UPDATE review_queue
            SET review_revision = review_revision + 1
          WHERE doc_id = ? AND resolved = 1 AND review_revision = ?
            AND NOT EXISTS (
              SELECT 1 FROM transactions
               WHERE doc_id = ? AND source IN ('primary', 'manual') AND deprecated_at IS NULL
            )`,
        [docId, reviewRevision, docId],
      ],
    ]);
    if ((results[results.length - 1]?.meta?.changes ?? 0) === 0) {
      return c.json({ error: 'review item changed or leftover rows did not retire' }, 409);
    }
    const deprecated = results[0]?.meta?.changes ?? 0;
    try {
      await recordIngestionDecision(c.env.DB, {
        docId,
        action: 'auto_published',
        source: 'admin',
        actor: adminActor(c),
        reason: 'superseded_prior_sources',
        payload: { deprecatedTransactions: deprecated, keptVisionRows: visionN },
        createdAt: nowIso,
      });
    } catch (err) {
      console.error('retire superseded sources: audit receipt failed', docId, (err as Error).message);
    }
    return c.json({
      docId,
      retired: true,
      deprecatedTransactions: deprecated,
      keptVisionRows: visionN,
      reviewRevision: reviewRevision + 1,
    });
  });

  // --- POST /review/:docId/retry-auto ------------------------------------
  // Explicitly releases a durable Unpublish human hold. Reject is a terminal
  // discard decision and is deliberately never eligible for this route.
  // This is the
  // only path (besides a completed human confirm/manual action) that lets the
  // autonomous agreement cascade reconsider the unchanged source document.
  r.post('/review/:docId/retry-auto', async (c) => {
    const docId = c.req.param('docId');
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if (!Number.isInteger(body.reviewRevision) || Number(body.reviewRevision) < 1) {
      return c.json({ error: 'reviewRevision must be a positive integer from the review queue item' }, 400);
    }
    let held: {
      resolved: number;
      agreement_suppressed_at: string | null;
      agreement_suppression_reason: string | null;
      raw_object_key: string | null;
      review_revision: number;
    } | null;
    try {
      held = await get(
        c.env.DB,
        `SELECT rq.resolved, rq.agreement_suppressed_at, rq.agreement_suppression_reason,
                rq.review_revision, f.raw_object_key
           FROM review_queue rq LEFT JOIN filings f ON f.doc_id = rq.doc_id
          WHERE rq.doc_id = ?`,
        [docId],
      );
    } catch (err) {
      if (/agreement_suppressed_at|review_revision|no such column/i.test((err as Error).message)) {
        return c.json({ error: 'review safety migration is not applied yet' }, 503);
      }
      throw err;
    }
    if (!held) return c.json({ error: 'review item not found' }, 404);
    if (held.resolved === 1) return c.json({ error: 'review item is already resolved' }, 409);
    const reviewRevision = Number(body.reviewRevision);
    if (held.review_revision !== reviewRevision) {
      return c.json({ error: 'review item changed; reload it before retrying' }, 409);
    }
    if (!held.agreement_suppressed_at) return c.json({ error: 'review item is not held from automation' }, 409);
    if (!held.raw_object_key) return c.json({ error: 'review item has no source object for automatic retry' }, 409);

    const priorReason = held.agreement_suppression_reason ?? 'human hold';
    const released = await run(
      c.env.DB,
      `UPDATE review_queue
          SET agreement_suppressed_at = NULL,
              agreement_suppression_reason = NULL,
              agreement_attempted_at = NULL,
              agreement_attempts = 0,
              agreement_tier = NULL,
              agreement_next_attempt_at = NULL,
              agreement_claim_token = NULL,
              agreement_claimed_at = NULL,
              reason = ?,
              review_revision = review_revision + 1
        WHERE doc_id = ? AND resolved = 0 AND agreement_suppressed_at = ?
          AND review_revision = ?`,
      [`auto_retry_requested: ${priorReason}`, docId, held.agreement_suppressed_at, reviewRevision],
    );
    if ((released.meta?.changes ?? 0) === 0) {
      return c.json({ error: 'review item changed before the hold could be released' }, 409);
    }

    try {
      await recordIngestionDecision(c.env.DB, {
        docId,
        action: 'auto_retry_requested',
        source: 'admin',
        actor: adminActor(c),
        reason: priorReason,
        payload: { priorSuppressedAt: held.agreement_suppressed_at },
      });
    } catch (err) {
      console.error('review retry-auto: audit receipt failed', docId, (err as Error).message);
    }
    const enqueued = await enqueueAgreementCheck(c.env, docId, held.raw_object_key);
    return c.json({ docId, released: true, enqueued, reviewRevision: reviewRevision + 1 });
  });

  // --- GET /sources/health ------------------------------------------------
  // Recent ingest_log aggregates per source: last poll, last new filing, and the
  // observed average interval between polls (seconds).
  r.get('/sources/health', async (c) => {
    const latencyResetAt = await getLatencyResetAt(c.env);
    const now = new Date();
    const config = await getConfig(c.env);
    const window = activeWindow(now, config);
    const effectivePollIntervalSec = window
      ? effectiveInterval(window, config)
      : Math.max(60, ...config.schedule.map((entry) => entry.intervalSec));
    const staleAfterSec = Math.max(300, effectivePollIntervalSec * 3);
    const rows = await all<{
      source: string;
      last_polled_at: string | null;
      poll_count: number;
      total_new: number;
      last_new_at: string | null;
    }>(
      c.env.DB,
      `SELECT CASE WHEN lower(source) IN ('oge', 'exec') THEN 'executive' ELSE source END AS source,
              MAX(polled_at)                              AS last_polled_at,
              COUNT(*)                                    AS poll_count,
              COALESCE(SUM(new_count), 0)                 AS total_new,
              MAX(CASE WHEN new_count > 0 THEN polled_at END) AS last_new_at
         FROM ingest_log
        GROUP BY 1`,
    );

    const attempts = await optionalAll<{
      id: number;
      source: string;
      attempted_at: string;
      outcome: string;
      new_count: number;
      error: string | null;
    }>(
      c.env,
      `WITH ranked AS (
         SELECT id,
                CASE WHEN lower(source) IN ('oge', 'exec') THEN 'executive' ELSE source END AS source,
                attempted_at, outcome, new_count, error,
                ROW_NUMBER() OVER (
                  PARTITION BY CASE WHEN lower(source) IN ('oge', 'exec') THEN 'executive' ELSE source END
                  ORDER BY attempted_at DESC, id DESC
                ) AS rn
           FROM source_attempts
       )
       SELECT id, source, attempted_at, outcome, new_count, error
         FROM ranked
        WHERE rn <= ?
        ORDER BY source ASC, attempted_at DESC, id DESC`,
      [100],
    );
    const attemptsBySource = new Map<string, typeof attempts>();
    for (const attempt of attempts) {
      const list = attemptsBySource.get(attempt.source) ?? [];
      list.push(attempt);
      attemptsBySource.set(attempt.source, list);
    }
    const aggregateBySource = new Map(rows.map((row) => [row.source, row]));
    const sourceNames = new Set<string>(['house', 'senate', 'executive', ...rows.map((row) => row.source), ...attempts.map((row) => row.source)]);

    const sources = [];
    for (const source of sourceNames) {
      const row = aggregateBySource.get(source);
      const history = attemptsBySource.get(source) ?? [];
      const latest = history[0];
      const lastSuccess = history.find((attempt) => attempt.outcome === 'success');
      const lastFailure = history.find((attempt) => attempt.outcome === 'failure');
      let consecutiveFailures = 0;
      for (const attempt of history) {
        if (attempt.outcome !== 'failure') break;
        consecutiveFailures += 1;
      }
      const lastAttemptAt = latest?.attempted_at ?? row?.last_polled_at ?? null;
      const lastAttemptMs = lastAttemptAt ? Date.parse(lastAttemptAt) : Number.NaN;
      // Executive weekday floor is 15 min; weekend is hourly like House.
      // Staleness uses 3× the weekend floor so a healthy weekend poller is
      // not marked stale between hourly ticks.
      const sourceStaleAfterSec = source === 'executive' || source === 'oge' ? 3600 * 3 : staleAfterSec;
      const stale = !Number.isFinite(lastAttemptMs)
        || now.getTime() - lastAttemptMs > sourceStaleAfterSec * 1000;
      const status = latest?.outcome === 'failure'
        ? 'error'
        : stale
          ? 'stale'
          : latest?.outcome === 'success'
            ? 'ok'
            : 'unknown';
      sources.push({
        source,
        status,
        stale,
        staleAfterSec: sourceStaleAfterSec,
        effectivePollIntervalSec,
        lastAttemptAt,
        lastSuccessAt: lastSuccess?.attempted_at ?? row?.last_polled_at ?? null,
        lastFailureAt: lastFailure?.attempted_at ?? null,
        lastError: latest?.outcome === 'failure' ? latest.error : null,
        consecutiveFailures,
        lastPolledAt: row?.last_polled_at ?? null,
        lastNewFilingAt: row?.last_new_at ?? null,
        pollCount: row?.poll_count ?? 0,
        totalNew: row?.total_new ?? 0,
        avgIntervalSec: await observedAvgInterval(c.env, source),
        avgReleasedToSeenSec: await observedReleasedToSeenLag(c.env, source, latencyResetAt),
        avgSeenToImportedSec: await observedSeenToImportedLag(c.env, source, latencyResetAt),
      });
    }
    const sourceOrder = ['house', 'senate', 'executive'];
    sources.sort((a, b) => {
      const ia = sourceOrder.indexOf(a.source);
      const ib = sourceOrder.indexOf(b.source);
      if (ia < 0 && ib < 0) return a.source.localeCompare(b.source);
      if (ia < 0) return 1;
      if (ib < 0) return -1;
      return ia - ib;
    });

    const timeline = await optionalAll<{
      source: string;
      hour: string;
      total: number;
      failures: number;
      successes: number;
      new_filings: number;
    }>(
      c.env,
      `SELECT 
         CASE WHEN lower(source) IN ('oge', 'exec') THEN 'executive' ELSE source END AS source,
         strftime('%Y-%m-%dT%H:00:00.000Z', attempted_at) AS hour,
         COUNT(*) AS total,
         SUM(CASE WHEN outcome = 'failure' THEN 1 ELSE 0 END) AS failures,
         SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS successes,
         COALESCE(SUM(new_count), 0) AS new_filings
        FROM source_attempts
       WHERE attempted_at >= datetime('now', '-24 hours')
       GROUP BY 1, hour
       ORDER BY hour ASC`,
    );

    const recentFailures = await optionalAll<{
      id: number;
      source: string;
      attempted_at: string;
      error: string | null;
    }>(
      c.env,
      `SELECT id,
              CASE WHEN lower(source) IN ('oge', 'exec') THEN 'executive' ELSE source END AS source,
              attempted_at, error
         FROM source_attempts
        WHERE outcome = 'failure'
        ORDER BY attempted_at DESC, id DESC
        LIMIT 10`,
    );

    return c.json({ sources, count: sources.length, timeline, recentFailures, latencyResetAt });
  });

  // --- POST /sources/health/latency-reset ---------------------------------
  // Reset only the observed latency baseline. Historical rows stay untouched;
  // future Source Health averages ignore rows first seen before this timestamp.
  r.post('/sources/health/latency-reset', async (c) => {
    const latencyResetAt = new Date().toISOString();
    await setLatencyResetAt(c.env, latencyResetAt);
    return c.json({ ok: true, latencyResetAt });
  });

  // --- GET /disclosure-latency/summary ------------------------------------
  // Aggregate provider-race metrics. `publicSummary` intentionally excludes
  // filing/member detail so it can be reviewed before any public sharing.
  r.get('/disclosure-latency/summary', async (c) => {
    return c.json(await getDisclosureLatencySummary(c.env));
  });

  // --- GET /disclosure-latency -------------------------------------------
  // congress.trade-vs-provider race monitor. `providerDeltaSec` is provider
  // monitor first-observed minus congress.trade first_seen_at: positive means we
  // observed first; negative means the provider was already observed first.
  r.get('/disclosure-latency', async (c) => {
    const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '50', 10) || 50, 1), 200);
    const provider = (c.req.query('provider') || '').trim().toLowerCase();
    const where = provider ? 'WHERE provider = ?' : '';
    const params: SqlParam[] = provider ? [provider, limit] : [limit];
    const rows = await optionalAll<{
      trade_hash: string;
      doc_id: string;
      provider: string;
      chamber: string;
      source_url: string | null;
      filed_date: string | null;
      filer_name: string | null;
      congress_first_seen_at: string;
      provider_key: string | null;
      provider_first_seen_at: string | null;
      provider_published_at: string | null;
      match_method: string | null;
      status: string;
      attempts: number;
      last_checked_at: string | null;
      error: string | null;
      created_at: string;
      updated_at: string;
    }>(
      c.env,
      `SELECT trade_hash, doc_id, provider, chamber, source_url, filed_date, filer_name,
              congress_first_seen_at, provider_key, provider_first_seen_at, provider_published_at,
              match_method, status, attempts, last_checked_at, error,
              created_at, updated_at
         FROM trade_latency_candidates
        ${where}
        ORDER BY created_at DESC
        LIMIT ?`,
      params,
    );
    const items = rows.map((row) => ({
      tradeHash: row.trade_hash,
      docId: row.doc_id,
      provider: row.provider,
      chamber: row.chamber,
      sourceUrl: row.source_url,
      filedDate: row.filed_date,
      filerName: row.filer_name,
      congressFirstSeenAt: row.congress_first_seen_at,
      providerKey: row.provider_key,
      providerFirstSeenAt: row.provider_first_seen_at,
      providerDeltaSec: deltaSeconds(row.provider_first_seen_at, row.congress_first_seen_at),
      providerPublishedAt: row.provider_published_at,
      providerPublishedDeltaSec: deltaSeconds(row.provider_published_at, row.congress_first_seen_at),
      matchMethod: row.match_method,
      status: row.status,
      attempts: row.attempts,
      lastCheckedAt: row.last_checked_at,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
    return c.json({ count: items.length, items });
  });

  // --- GET /disclosure-latency/quality-crosscheck --------------------------
  // Compares parsed transactions in our database against provider observations
  // to calculate quality edge and identify discrepancy issues.
  r.get('/disclosure-latency/quality-crosscheck', async (c) => {
    try {
      const report = await getQualityCrosscheck(c.env);
      return c.json(report);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // --- POST /disclosure-latency/probe -------------------------------------
  // Force a one-off provider latest probe, useful immediately after new filings
  // land or before turning on the continuous cron switch. Optional query:
  // ?providers=fmp,unusual_whales,quiver
  r.post('/disclosure-latency/probe', async (c) => {
    const providers = (c.req.query('providers') || c.req.query('provider') || '')
      .split(/[,\s]+/)
      .map((part) => part.trim())
      .filter(Boolean);
    const result = await runDisclosureLatencyProbe(c.env, new Date(), fetch, { force: true, providers });
    return c.json({ ok: result.errors.length === 0, ...result });
  });

  // --- POST /disclosure-latency/backfill-candidates -----------------------
  // Seed trade_latency_candidates from recent persisted transactions so the
  // FMP/UW/QQ race can score historical rows after schema/config repairs.
  // Body (optional): { limit?: number, days?: number }
  r.post('/disclosure-latency/backfill-candidates', async (c) => {
    let body: { limit?: unknown; days?: unknown } = {};
    try {
      const text = await c.req.text();
      if (text) body = JSON.parse(text) as { limit?: unknown; days?: unknown };
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const limit = typeof body.limit === 'number' ? body.limit : undefined;
    const days = typeof body.days === 'number' ? body.days : undefined;
    const result = await backfillTradeLatencyCandidates(c.env, { limit, days });
    return c.json({ ok: true, ...result });
  });

  // --- POST /disclosure-latency/rematch -----------------------------------
  // Heal bulk first_seen stamps, reverse-seed from provider observations,
  // and rematch the pending backlog (cross-chamber exact hash + fuzzy).
  // Use after matching/heal fixes land so concurrent race density recovers
  // without waiting for organic probe cadence.
  r.post('/disclosure-latency/rematch', async (c) => {
    const result = await rematchAndHealLatencyRaces(c.env, new Date());
    return c.json({ ok: true, ...result });
  });

  // --- GET /config-sources --------------------------------------------------
  // Single-source-of-truth audit for the Infisical consolidation: for every
  // known config key/knob, report where its LIVE value currently comes from —
  // 'infisical' (edit there; wins over env), 'env' (wrangler var / Worker
  // secret fallback), or 'missing'. Names and sources ONLY, never values.
  // Env-only bootstrap vars (sync-read or resolver-circular) are listed
  // separately so the registry is complete.
  r.get('/config-sources', async (c) => {
    const REGISTRY: Record<string, string[]> = {
      'provider-keys': [
        'FMP_API_KEY', 'FMP_LATENCY_API_KEY', 'FMP_RAPIDAPI_KEY', 'RAPIDAPI_KEY', 'TIINGO_API_KEY', 'MASSIVE_API_KEY', 'INTRINIO_API_KEY', 'TWELVEDATA_API_KEY',
        'UNUSUAL_WHALES_API_KEY', 'UNUSUALWHALES_API_KEY',
        'FINNHUB_API_KEY', 'QUIVER_API_KEY', 'QUIVER_API_TOKEN', 'AINVEST_API_KEY',
        'LOGODEV_PUBLISHABLE_KEY', 'LOGO_DEV_TOKEN',
      ],
      'model-keys': [
        'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'MISTRAL_API_KEY', 'XAI_API_KEY',
        'OPENROUTER_API_KEY', 'LLAMAPARSE_API_KEY', 'ARBITRATION_API_KEY',
      ],
      'auth-billing': [
        'ADMIN_TOKEN', 'INGEST_TOKEN', 'ADMIN_MAINTENANCE_TOKEN', 'ADMIN_EMAILS', 'ACCESS_AUD', 'ACCESS_TEAM_DOMAIN',
        'REVIEW_QUEUE_PUBLISHER_WEBHOOK_URL', 'REVIEW_QUEUE_PUBLISHER_WEBHOOK_SECRET',
        'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'WEBHOOK_SIGNING_KEY',
        'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PRICE_MONTHLY', 'STRIPE_PRICE_ANNUAL',
        'STRIPE_TRIAL_DAYS', 'STRIPE_MANAGED_PAYMENTS', 'RESEND_API_KEY', 'EMAIL_FROM', 'ALERT_EMAIL',
        'APPLE_BUNDLE_ID', 'APPLE_SIGNIN_ENABLED', 'APPLE_IAP_ENABLED',
        'APPLE_PRODUCT_MONTHLY', 'APPLE_PRODUCT_ANNUAL',
      ],
      integrations: [
        'APP_B_IMPORT_URL', 'APP_B_INGEST_TOKEN', 'USAGE_MONITOR_ENABLED', 'USAGE_MONITOR_INGEST_URL',
        'USAGE_MONITOR_INGEST_TOKEN', 'USAGE_MONITOR_ENVIRONMENT',
        'DD_API_KEY', 'DD_APP_KEY', 'DD_SITE', 'DD_SERVICE', 'DD_ENV',
        'DD_CLIENT_TOKEN', 'DD_RUM_CLIENT_TOKEN', 'NEXT_PUBLIC_DD_CLIENT_TOKEN',
        'NEXT_PUBLIC_DD_RUM_CLIENT_TOKEN', 'DD_APPLICATION_ID', 'DD_RUM_APPLICATION_ID',
        'NEXT_PUBLIC_DD_APPLICATION_ID', 'NEXT_PUBLIC_DD_RUM_APPLICATION_ID', 'NEXT_PUBLIC_DD_SITE',
        'DD_HOSTNAME', 'DD_RUM_ENABLED', 'NEXT_PUBLIC_DD_RUM_ENABLED',
      ],
      tunables: [
        'LLM_DOC_USD_CEILING', 'LLM_DAILY_USD_CEILING', 'OPENROUTER_DAILY_USD_CEILING', 'OPENROUTER_MIN_BALANCE_USD', 'LLAMAPARSE_DAILY_CREDIT_CEILING', 'LLAMAPARSE_DAILY_CREDITS_CEILING', 'LLAMAPARSE_DAILY_USD_CEILING',
        'APP_BASE_URL', 'PRICE_PROVIDER', 'FMP_DAILY_CALL_CAP', 'FMP_MAX_PER_MINUTE', 'EDGAR_MAX_PER_MINUTE',
        'SCRAPE_GUARD_ENABLED', 'DISCLOSURE_LATENCY_WATCH_ENABLED', 'DISCLOSURE_LATENCY_PROVIDERS',
        'DISCLOSURE_LATENCY_WATCH_LIMIT', 'FMP_DISCLOSURE_WATCH_ENABLED', 'FMP_DISCLOSURE_WATCH_LIMIT',
        'FMP_LATENCY_PROBE_ENABLED', 'FMP_LATENCY_PATHS', 'FMP_STABLE_BASE_URL',
        'FMP_RAPIDAPI_BASE_URL', 'FMP_RAPIDAPI_HOST', 'FMP_LATENCY_DAILY_CAP',
        'FMP_RAPIDAPI_DAILY_CAP', 'UW_LATENCY_DAILY_CAP', 'QUIVER_LATENCY_DAILY_CAP',
        'UW_DEEP_MATCH_DATES_PER_RUN',
        'HOUSE_LIVE_SEARCH_ENABLED', 'HOUSE_PRIOR_YEAR_OVERLAP_DAYS',
        'SENATE_LOOKBACK_DAYS', 'SENATE_MAX_LOOKBACK_DAYS',
        'SEED_HOUSE_URL', 'SEED_SENATE_URL',
        'OGE_WATCH_ENABLED', 'OGE_INDEX_URL', 'OGE_POLL_INTERVAL_SEC', 'OGE_MAX_VISION_BYTES',
        'VISION_PRIMARY_MODEL', 'ARBITRATION_ENABLED', 'ARBITRATION_MODEL',
        'OPENROUTER_MODEL', 'OPENROUTER_PDF_ENGINE_TEXT', 'OPENROUTER_PDF_ENGINE_SCANNED', 'OPENROUTER_MAX_PRICE',
        'AGREEMENT_AUTOPUBLISH_ENABLED', 'AGREEMENT_AUTOPUBLISH_LIMIT', 'AGREEMENT_MAX_ATTEMPTS', 'AGREEMENT_DAILY_LLM_BUDGET',
        'AGREEMENT_BIG_DOC_START_TIER2', 'AGREEMENT_BIG_DOC_PAGE_THRESHOLD', 'AGREEMENT_BIG_DOC_BYTES_THRESHOLD',
        'AGREEMENT_TEXT_NORMALIZATION',
        'AGREEMENT_HOUSE_MODEL_A', 'AGREEMENT_HOUSE_MODEL_B', 'AGREEMENT_HOUSE_MODEL_C',
        'AGREEMENT_HOUSE_MODEL_D', 'AGREEMENT_HOUSE_MODEL_E',
        'AGREEMENT_SENATE_MODEL_A', 'AGREEMENT_SENATE_MODEL_B', 'AGREEMENT_SENATE_MODEL_C',
        'AGREEMENT_SENATE_MODEL_D', 'AGREEMENT_SENATE_MODEL_E',
        'AGREEMENT_EXEC_MODEL_A', 'AGREEMENT_EXEC_MODEL_B', 'AGREEMENT_EXEC_MODEL_C',
        'AGREEMENT_EXEC_MODEL_D', 'AGREEMENT_EXEC_MODEL_E',
        'PROVIDER_HEALTH_WINDOW_MINUTES', 'PROVIDER_HEALTH_CONSECUTIVE_THRESHOLD',
        'PROVIDER_HEALTH_FAILURE_RATE', 'PROVIDER_HEALTH_MIN_SAMPLES',
        'PROVIDER_OVERLAY_ENABLED', 'PROVIDER_OVERLAY_COST_RATIO_LIMIT',
        'PROVIDER_MODEL_BAN_TTL_SECONDS',
        'AUTOPILOT_ENABLED', 'AUTOPILOT_BACKLOG_THRESHOLD', 'AUTOPILOT_DAILY_USD_BUDGET',
        'AUTOPILOT_MAX_DOCS_PER_RUN', 'AUTOPILOT_ERROR_CLASS_HALT_THRESHOLD',
        'AUTOPILOT_MIN_INTERVAL_MINUTES', 'AUTOPILOT_BATCH_PRESEED',
        'DOC_CLASSIFIER_ENABLED', 'DOC_CLASSIFIER_MODEL', 'DOC_CLASSIFIER_PARSE_ENGINE',
        'DOC_CLASS_EMPTY_SPOTCHECK_RATE',
        'ADMIN_OPEN_IN_DEV',
        'IMPORT_MAX_BYTES', 'IMPORT_MAX_REFS', 'IMPORT_MAX_SPX', 'IMPORT_MAX_PRICES',
        'IMPORT_MAX_CLOSES_PER_TICKER', 'IMPORT_MAX_INSIDER', 'IMPORT_MAX_SHORT_VOLUME',
      ],
    };
    /** Env-only: sync-read at Worker init (Sentry) — the async resolver cannot serve these. */
    const ENV_ONLY = ['SENTRY_DSN', 'SENTRY_ENVIRONMENT', 'SENTRY_TRACES_SAMPLE_RATE'];
    /** Resolver bootstrap: cannot resolve themselves through Infisical. */
    const BOOTSTRAP = [
      'INFISICAL_BASE_URL', 'INFISICAL_ENV', 'INFISICAL_CACHE_TTL_SECONDS', 'INFISICAL_ALLOW_ENV_FALLBACK',
      'INFISICAL_APP_PROJECT_ID', 'INFISICAL_APP_CLIENT_ID', 'INFISICAL_APP_CLIENT_SECRET', 'INFISICAL_APP_SECRET_PATH',
      'INFISICAL_SHARED_PROJECT_ID', 'INFISICAL_SHARED_CLIENT_ID', 'INFISICAL_SHARED_CLIENT_SECRET', 'INFISICAL_SHARED_SECRET_PATH',
    ];
    const envx = c.env as unknown as Record<string, unknown>;
    const items: Array<{ key: string; category: string; source: string }> = [];
    for (const [category, keys] of Object.entries(REGISTRY)) {
      for (const key of keys) {
        const { source } = await resolveSecret(c.env, key as keyof Env & string);
        items.push({ key, category, source });
      }
    }
    return c.json({
      resolver: getSecretResolverStatus(c.env),
      items,
      envOnly: ENV_ONLY.map((key) => ({ key, configured: Boolean(envx[key]) })),
      bootstrap: BOOTSTRAP.map((key) => ({ key, configured: Boolean(envx[key]) })),
      note: 'Sources only, never values. infisical = live-editable there (wins over env); env = wrangler var / Worker secret fallback.',
    });
  });

  // --- POST /runtime-tick -------------------------------------------------
  // Drive one watcher + outbox + durable-queue tick from outside Deno Deploy
  // (Coolify cron / GitHub Actions). Used with DENO_DISABLE_INTERNAL_CRON=true
  // so free-tier Deploy only serves HTTP. ADMIN_TOKEN or ADMIN_MAINTENANCE_TOKEN.
  r.post('/runtime-tick', async (c) => {
    const envx = c.env as Env & Record<string, string | undefined>;
    // Prefer Deploy-safe CT_* names (DENO_* prefixes are rejected by Deno Deploy).
    const profile = resolveDenoCostProfile(envx);
    const result = await runScheduledTick(
      c.env,
      createRuntimeQueueHandlers(),
      profile,
    );
    return c.json({
      ok: result.errors.length === 0,
      ...result,
    }, result.errors.length === 0 ? 200 : 207);
  });

  // --- GET /coverage-scorecard --------------------------------------------
  // Honest universe-vs-us report (owner 2026-08-07). complete is computed only.
  r.get('/coverage-scorecard', async (c) => {
    const scorecard = await buildCoverageScorecard(c.env);
    const [llmSpend, orCircuit, orKnobs] = await Promise.all([
      readLlmSpend(c.env),
      readOpenRouterBudgetCircuit(c.env),
      resolveOpenRouterBudgetCircuitKnobs(c.env),
    ]);
    return c.json({
      ok: true,
      scorecard,
      llmSpend,
      openRouterBudgetCircuit: {
        ...orCircuit,
        knobs: orKnobs,
      },
    });
  });

  // --- GET /llm-spend-report -----------------------------------------------
  // Per-model LLM spend (last 7 / last 30 days, doc counts + USD, grouped by
  // provider+model) plus the live LlamaParse free-credit balance across every
  // key in LLAMAPARSE_API_KEY. Two genuinely different data sources: the
  // spend report reads this app's own metered-cost ledger
  // (llm_spend_settlements); the LlamaParse credits are fetched live from
  // LlamaIndex Cloud's own account API (each key is its own free-tier org
  // with its own 10k/month grant and reset date -- nothing in this repo's
  // ledger knows that number). Pass ?refreshCredits=1 to bypass the 5-minute
  // LlamaParse credits cache (each refresh costs 2 external calls per key).
  r.get('/llm-spend-report', async (c) => {
    const forceRefresh = c.req.query('refreshCredits') === '1';
    const [spend, credits] = await Promise.all([
      readLlmSpendWeekAndMonth(c.env),
      fetchLlamaParseCredits(c.env, { forceRefresh }),
    ]);
    return c.json({ ok: true, spend, llamaParseCredits: credits });
  });

  // --- GET /instrument-pricing --------------------------------------------
  // Capability matrix for Equities (long) / Crypto / Options / Event Contracts
  // plus observed-vs-claimed snapshot provenance. Exact-time lookup is the
  // sibling GET /instrument-pricing/at.
  r.get('/instrument-pricing', async (c) => {
    return c.json(await instrumentPricingPayload(c.env));
  });

  r.get('/instrument-pricing/at', async (c) => {
    const result = await lookupExactPriceForAdmin(c.env, {
      ticker: c.req.query('ticker'),
      at: c.req.query('at'),
      isOption: c.req.query('isOption'),
      assetType: c.req.query('assetType'),
      assetName: c.req.query('assetName'),
    });
    return c.json(result);
  });

  // --- GET /diagnostics ---------------------------------------------------
  // Admin operational snapshot: provider/source connection status, usage counts,
  // and recent errors collected from existing D1 tables. This intentionally
  // reports only whether secrets are configured, never their values.
  r.get('/diagnostics', async (c) => {
    const now = new Date();
    const last24 = hoursAgoIso(24, now);
    const today = dayStartIso(now);
    const runtimeSecrets = await resolveSecrets(c.env, [
      'GEMINI_API_KEY',
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'MISTRAL_API_KEY',
      'XAI_API_KEY',
      'OPENROUTER_API_KEY',
      'LLAMAPARSE_API_KEY',
      'ARBITRATION_API_KEY',
      'FMP_API_KEY',
      'MASSIVE_API_KEY',
      'INTRINIO_API_KEY',
      'TWELVEDATA_API_KEY',
      'FINNHUB_API_KEY',
      'LOGODEV_PUBLISHABLE_KEY',
      'LOGO_DEV_TOKEN',
      'APP_B_IMPORT_URL',
      'APP_B_INGEST_TOKEN',
      'INGEST_TOKEN',
      'WEBHOOK_SIGNING_KEY',
      'GOOGLE_OAUTH_CLIENT_ID',
      'RESEND_API_KEY',
      'EMAIL_FROM',
      'STRIPE_SECRET_KEY',
      'PRICE_PROVIDER',
      'TIINGO_API_KEY',
      'USAGE_MONITOR_ENABLED',
      'USAGE_MONITOR_INGEST_URL',
      'USAGE_MONITOR_INGEST_TOKEN',
      'USAGE_MONITOR_ENVIRONMENT',
    ]);
    const secretStatus = getSecretResolverStatus(c.env);
    const adminConfig = await adminRuntimeConfig(c.env);

    const connections: DiagnosticConnection[] = [];
    const infisicalFailures = secretStatus.sources.filter((s) => s.configured && !s.ok).length;
    connections.push({
      id: 'secrets:infisical',
      label: 'Infisical Runtime Secrets',
      status: !secretStatus.enabled ? 'warn' : infisicalFailures || secretStatus.errors.length ? 'error' : 'ok',
      configured: secretStatus.enabled,
      lastUsedAt: secretStatus.lastRefreshAt,
      callsTotal: secretStatus.sources.reduce((sum, s) => sum + s.count, 0),
      callsLast24h: 0,
      callsToday: 0,
      errorsLast24h: secretStatus.errors.length,
      note: secretStatus.enabled
        ? `Cache ${secretStatus.cacheReady ? 'ready' : 'empty'}; expires in ${secretStatus.cacheExpiresInSeconds ?? 0}s; env fallback ${secretStatus.envFallbackAllowed ? 'allowed' : 'disabled'}`
        : 'Infisical machine identity bootstrap secrets are not available to this Worker runtime',
    });

    const usageMonitorExplicitlyDisabled = /^(0|false|no|off)$/i.test(
      (runtimeSecrets.USAGE_MONITOR_ENABLED ?? '').trim(),
    );
    const usageMonitorUrlConfigured = Boolean(runtimeSecrets.USAGE_MONITOR_INGEST_URL?.trim());
    const usageMonitorTokenConfigured = Boolean(runtimeSecrets.USAGE_MONITOR_INGEST_TOKEN?.trim());
    const usageMonitorEnvironmentConfigured = Boolean(runtimeSecrets.USAGE_MONITOR_ENVIRONMENT?.trim());
    const usageMonitorQueueConfigured = typeof (c.env as Partial<Env>).INGEST_QUEUE?.send === 'function';
    const usageMonitorFallback = await inspectUsageTelemetryFallback(c.env);
    const usageMonitorMissing = [
      ...(!usageMonitorUrlConfigured ? ['ingest URL'] : []),
      ...(!usageMonitorTokenConfigured ? ['ingest token'] : []),
    ];
    const usageMonitorConfigured = !usageMonitorExplicitlyDisabled && usageMonitorMissing.length === 0;
    const usageMonitorState = usageMonitorExplicitlyDisabled
      ? 'disabled' as const
      : usageMonitorMissing.length > 0
        ? 'missing' as const
        : 'configured' as const;
    const usageMonitorFallbackPending = usageMonitorFallback.pending ?? 0;
    const usageMonitorStatus: DiagnosticConnection['status'] =
      usageMonitorExplicitlyDisabled ? 'warn'
      : usageMonitorMissing.length > 0 ? 'error'
      : !usageMonitorQueueConfigured && !usageMonitorFallback.available ? 'error'
      : usageMonitorFallback.pending == null
        || usageMonitorFallbackPending > 0
        || usageMonitorFallback.truncated
        || usageMonitorFallback.circuitOpen
        || !usageMonitorEnvironmentConfigured
        || !usageMonitorQueueConfigured
        ? 'warn'
        : 'ok';
    const fallbackNote = usageMonitorFallback.pending == null
      ? 'R2 fallback health unavailable'
      : `R2 fallback ${usageMonitorFallbackPending}${usageMonitorFallback.truncated ? '+' : ''} pending`;
    const usageMonitorNote = usageMonitorExplicitlyDisabled
      ? 'Explicitly disabled by USAGE_MONITOR_ENABLED'
      : usageMonitorMissing.length > 0
        ? `Missing ${usageMonitorMissing.join(' and ')}`
        : [
            'Ingest URL/token configured',
            usageMonitorEnvironmentConfigured ? 'environment configured' : 'environment defaults at runtime',
            usageMonitorQueueConfigured ? 'Queue bound' : 'Queue binding unavailable',
            fallbackNote,
            usageMonitorFallback.circuitOpen ? 'circuit breaker OPEN: live delivery suppressed' : 'circuit breaker closed',
            'receiver delivery receipts are not persisted locally',
          ].join('; ');
    connections.push({
      id: 'telemetry:usage-monitor',
      label: 'API Usage Monitor Telemetry',
      status: usageMonitorStatus,
      configured: usageMonitorConfigured,
      lastUsedAt: null,
      callsTotal: 0,
      callsLast24h: 0,
      callsToday: 0,
      errorsLast24h: 0,
      note: usageMonitorNote,
    });

    const sourceRows = await optionalAll<{
      source: string;
      last_used_at: string | null;
      calls_total: number;
      calls_last_24h: number;
      calls_today: number;
    }>(
      c.env,
      `SELECT source,
              MAX(polled_at) AS last_used_at,
              COUNT(*) AS calls_total,
              SUM(CASE WHEN polled_at >= ? THEN 1 ELSE 0 END) AS calls_last_24h,
              SUM(CASE WHEN polled_at >= ? THEN 1 ELSE 0 END) AS calls_today
         FROM ingest_log
        GROUP BY source`,
      [last24, today],
    );
    for (const row of sourceRows) {
      connections.push({
        id: `source:${row.source}`,
        label: `${titleCaseSource(row.source)} Source`,
        status: connectionStatus(true, 0, row.last_used_at),
        configured: true,
        lastUsedAt: row.last_used_at,
        callsTotal: row.calls_total,
        callsLast24h: row.calls_last_24h,
        callsToday: row.calls_today,
        errorsLast24h: 0,
        note: 'Source checks recorded by ingest_log',
      });
    }

    const extractionRows = await optionalAll<{
      provider: string;
      calls_total: number;
      calls_last_24h: number;
      calls_today: number;
      last_used_at: string | null;
      errors_last_24h: number;
    }>(
      c.env,
      `SELECT provider,
              COUNT(*) AS calls_total,
              SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS calls_last_24h,
              SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS calls_today,
              MAX(created_at) AS last_used_at,
              SUM(CASE WHEN ok = 0 AND created_at >= ? THEN 1 ELSE 0 END) AS errors_last_24h
         FROM extraction_runs
        GROUP BY provider`,
      [last24, today, last24],
    );
    const extractionByProvider = new Map(extractionRows.map((row) => [row.provider.toLowerCase(), row]));

    const geminiArray = await optionalAll<{
      calls_total: number;
      calls_last_24h: number;
      calls_today: number;
      last_used_at: string | null;
      errors_last_24h: number;
    }>(
      c.env,
      `SELECT COUNT(*) AS calls_total,
              SUM(CASE WHEN first_seen_at >= ? THEN 1 ELSE 0 END) AS calls_last_24h,
              SUM(CASE WHEN first_seen_at >= ? THEN 1 ELSE 0 END) AS calls_today,
              MAX(first_seen_at) AS last_used_at,
              SUM(CASE WHEN error IS NOT NULL AND error != '' AND first_seen_at >= ? THEN 1 ELSE 0 END) AS errors_last_24h
         FROM filings
        WHERE extractor = 'visionLlm'
           OR model_version LIKE 'gemini%'
           OR error LIKE '%Gemini%'
           OR error LIKE '%visionLlm%'`,
      [last24, today, last24],
    );
    const gemini = geminiArray[0];
    const geminiExtract = extractionByProvider.get('gemini');
    const geminiLastUsed = maxIso(gemini?.last_used_at ?? null, geminiExtract?.last_used_at ?? null);
    const geminiErrors = (gemini?.errors_last_24h ?? 0) + (geminiExtract?.errors_last_24h ?? 0);
    connections.push({
      id: 'provider:gemini',
      label: 'Gemini OCR',
      status: connectionStatus(!!runtimeSecrets.GEMINI_API_KEY, geminiErrors, geminiLastUsed),
      configured: !!runtimeSecrets.GEMINI_API_KEY,
      lastUsedAt: geminiLastUsed,
      callsTotal: (gemini?.calls_total ?? 0) + (geminiExtract?.calls_total ?? 0),
      callsLast24h: (gemini?.calls_last_24h ?? 0) + (geminiExtract?.calls_last_24h ?? 0),
      callsToday: (gemini?.calls_today ?? 0) + (geminiExtract?.calls_today ?? 0),
      errorsLast24h: geminiErrors,
      note: runtimeSecrets.GEMINI_API_KEY ? 'Production OCR + bake-off extraction runs' : 'GEMINI_API_KEY is not available to this Worker runtime',
    });

    const modelProviders: Array<{ id: string; provider: string; label: string; configured: boolean; note: string }> = [
      {
        id: 'provider:openai',
        provider: 'openai',
        label: 'OpenAI OCR',
        configured: !!runtimeSecrets.OPENAI_API_KEY,
        note: runtimeSecrets.OPENAI_API_KEY ? 'Bake-off / review extraction candidate' : 'OPENAI_API_KEY is not available to this Worker runtime',
      },
      {
        id: 'provider:anthropic',
        provider: 'anthropic',
        label: 'Anthropic OCR',
        configured: !!runtimeSecrets.ANTHROPIC_API_KEY,
        note: runtimeSecrets.ANTHROPIC_API_KEY ? 'Bake-off / review extraction candidate' : 'ANTHROPIC_API_KEY is not available to this Worker runtime',
      },
      {
        id: 'provider:mistral',
        provider: 'mistral',
        label: 'Mistral OCR',
        configured: !!runtimeSecrets.MISTRAL_API_KEY,
        note: runtimeSecrets.MISTRAL_API_KEY ? 'Bake-off / batch OCR candidate' : 'MISTRAL_API_KEY is not available to this Worker runtime',
      },
      {
        id: 'provider:xai',
        provider: 'xai',
        label: 'xAI OCR',
        configured: !!runtimeSecrets.XAI_API_KEY,
        note: runtimeSecrets.XAI_API_KEY ? 'Bake-off / batch OCR candidate' : 'XAI_API_KEY is not available to this Worker runtime',
      },
      {
        id: 'provider:openrouter',
        provider: 'openrouter',
        label: 'OpenRouter LLM Gateway',
        configured: !!runtimeSecrets.OPENROUTER_API_KEY,
        note: runtimeSecrets.OPENROUTER_API_KEY
          ? 'Unified transport for live LLM extraction (agreement trio + benchmark candidates)'
          : 'OPENROUTER_API_KEY is not available to this Worker runtime',
      },
      {
        id: 'provider:llamaparse',
        provider: 'llamaparse',
        label: 'LlamaParse OCR',
        configured: !!runtimeSecrets.LLAMAPARSE_API_KEY,
        note: runtimeSecrets.LLAMAPARSE_API_KEY
          ? 'LlamaIndex Cloud parser candidate'
          : 'LLAMAPARSE_API_KEY is not available to this Worker runtime',
      },
    ];
    for (const provider of modelProviders) {
      const row = extractionByProvider.get(provider.provider);
      connections.push({
        id: provider.id,
        label: provider.label,
        status: connectionStatus(provider.configured, row?.errors_last_24h ?? 0, row?.last_used_at ?? null),
        configured: provider.configured,
        lastUsedAt: row?.last_used_at ?? null,
        callsTotal: row?.calls_total ?? 0,
        callsLast24h: row?.calls_last_24h ?? 0,
        callsToday: row?.calls_today ?? 0,
        errorsLast24h: row?.errors_last_24h ?? 0,
        note: provider.note,
      });
    }

    connections.push({
      id: 'provider:arbitration',
      label: 'Arbitration Model',
      status: runtimeSecrets.ARBITRATION_API_KEY ? 'ok' : 'warn',
      configured: !!runtimeSecrets.ARBITRATION_API_KEY,
      lastUsedAt: null,
      callsTotal: 0,
      callsLast24h: 0,
      callsToday: 0,
      errorsLast24h: 0,
      note: runtimeSecrets.ARBITRATION_API_KEY ? 'Secondary arbitration key available' : 'ARBITRATION_API_KEY is not available to this Worker runtime',
    });

    // Cross-app trade delivery health: outbound push to peer apps (Agentic
    // Trading) over webhook + SSE subscriptions. Surfaces 24h delivery outcomes
    // and any dead-lettered messages so a silently-broken peer connection is
    // visible to admins instead of failing unseen.
    const deliveryStats = await optionalAll<{
      total: number;
      delivered: number;
      failed: number;
      pending: number;
      today: number;
      last_delivered: string | null;
      last_failed: string | null;
    }>(
      c.env,
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN updated_at >= ? THEN 1 ELSE 0 END) AS today,
              MAX(CASE WHEN status = 'delivered' THEN updated_at END) AS last_delivered,
              MAX(CASE WHEN status = 'failed' THEN updated_at END) AS last_failed
         FROM deliveries
        WHERE updated_at >= ?`,
      [today, last24],
    );
    const subCounts = await optionalAll<{ active: number; webhook: number; sse: number }>(
      c.env,
      `SELECT COUNT(*) AS active,
              SUM(CASE WHEN delivery = 'webhook' THEN 1 ELSE 0 END) AS webhook,
              SUM(CASE WHEN delivery = 'sse' THEN 1 ELSE 0 END) AS sse
         FROM subscriptions WHERE active = 1`,
    );
    const dlq = await optionalAll<{ n: number; last_at: string | null }>(
      c.env,
      `SELECT COUNT(*) AS n, MAX(created_at) AS last_at FROM dead_letter_events
        WHERE queue LIKE '%delivery%' AND created_at >= ?`,
      [last24],
    );
    const ds = deliveryStats[0] ?? { total: 0, delivered: 0, failed: 0, pending: 0, today: 0, last_delivered: null, last_failed: null };
    const sc = subCounts[0] ?? { active: 0, webhook: 0, sse: 0 };
    const dlqCount = dlq[0]?.n ?? 0;
    const crossAppErrors = (ds.failed ?? 0) + dlqCount;
    connections.push({
      id: 'delivery:cross-app',
      label: 'Cross-App Trade Delivery',
      status:
        dlqCount > 0 ? 'error'
        : crossAppErrors > 0 ? 'warn'
        : (sc.active ?? 0) === 0 ? 'unknown'
        : (ds.delivered ?? 0) > 0 ? 'ok'
        : 'unknown',
      configured: (sc.active ?? 0) > 0,
      lastUsedAt: maxIso(ds.last_delivered, ds.last_failed),
      callsTotal: ds.total ?? 0,
      callsLast24h: ds.total ?? 0,
      callsToday: ds.today ?? 0,
      errorsLast24h: crossAppErrors,
      note:
        `${sc.active ?? 0} active subscription(s) (${sc.webhook ?? 0} webhook, ${sc.sse ?? 0} SSE); ` +
        `24h: ${ds.delivered ?? 0} delivered, ${ds.failed ?? 0} failed, ${ds.pending ?? 0} pending` +
        (dlqCount ? `; ${dlqCount} dead-lettered (see delivery DLQ)` : ''),
    });

    const fmp = await optionalAll<{
      calls_total: number;
      calls_last_24h: number;
      calls_today: number;
      last_used_at: string | null;
      errors_last_24h: number;
    }>(
      c.env,
      `SELECT COUNT(*) AS calls_total,
              SUM(CASE WHEN enriched_at >= ? THEN 1 ELSE 0 END) AS calls_last_24h,
              SUM(CASE WHEN enriched_at >= ? THEN 1 ELSE 0 END) AS calls_today,
              MAX(enriched_at) AS last_used_at,
              SUM(CASE WHEN enrichment_error IS NOT NULL AND enrichment_error != '' AND enriched_at >= ? THEN 1 ELSE 0 END) AS errors_last_24h
         FROM securities_ref`,
      [last24, today, last24],
    );
    const fmpRow = fmp[0];
    // Market-data FMP enrichment is intentionally disabled (latency-only keys).
    // Show as OFF (grey), not error/stopped — no spend until product re-enables.
    connections.push({
      id: 'provider:fmp',
      label: 'FMP Market Data (enrichment)',
      status: 'off',
      configured: !!runtimeSecrets.FMP_API_KEY,
      lastUsedAt: fmpRow?.last_used_at ?? null,
      callsTotal: fmpRow?.calls_total ?? 0,
      callsLast24h: fmpRow?.calls_last_24h ?? 0,
      callsToday: fmpRow?.calls_today ?? 0,
      errorsLast24h: fmpRow?.errors_last_24h ?? 0,
      note: 'OFF: FMP free keys reserved for disclosure-latency probes only (not enrichment/prices)',
    });

    // FMP latency family (stable + RapidAPI) — CT latency system only; default OFF.
    const { getDisclosureLatencyProviderStatuses, listFmpLatencyPathRegistry } = await import(
      '../ingestion/tradeLatency.ts'
    );
    const latencyStatuses = await getDisclosureLatencyProviderStatuses(c.env);
    for (const path of listFmpLatencyPathRegistry()) {
      const st = latencyStatuses.find((s) => s.id === path.providerId);
      const op = st?.operationalStatus ?? 'off';
      const diagStatus: DiagnosticConnection['status'] =
        op === 'off' ? 'off'
        : op === 'running' ? 'ok'
        : op === 'error' ? 'error'
        : op === 'stopped' ? 'warn'
        : 'unknown';
      const probeStats = await optionalAll<{
        last_used_at: string | null;
        calls_total: number;
        calls_last_24h: number;
        calls_today: number;
        errors_last_24h: number;
      }>(
        c.env,
        `SELECT MAX(ran_at) AS last_used_at,
                COUNT(*) AS calls_total,
                SUM(CASE WHEN ran_at >= ? THEN 1 ELSE 0 END) AS calls_last_24h,
                SUM(CASE WHEN ran_at >= ? THEN 1 ELSE 0 END) AS calls_today,
                SUM(CASE WHEN ok = 0 AND ran_at >= ? THEN 1 ELSE 0 END) AS errors_last_24h
           FROM provider_probe_runs
          WHERE provider = ?`,
        [last24, today, last24, path.providerId],
      );
      const ps = probeStats[0];
      connections.push({
        id: `latency:${path.providerId}`,
        label: `Latency · ${path.label}`,
        status: diagStatus,
        configured: st?.configured ?? false,
        lastUsedAt: ps?.last_used_at ?? null,
        callsTotal: ps?.calls_total ?? 0,
        callsLast24h: ps?.calls_last_24h ?? 0,
        callsToday: ps?.calls_today ?? 0,
        errorsLast24h: ps?.errors_last_24h ?? 0,
        note: st?.reason ?? `Default OFF. Path ${path.pathId} → ${path.defaultBaseUrl}`,
      });
    }

    const appBReceivedRows = await optionalAll<{
      imported_refs: number;
      fundamentals_rows: number;
      analyst_rows: number;
      latest_import_at: string | null;
    }>(
      c.env,
      `SELECT
         (SELECT COUNT(*) FROM securities_ref WHERE source = 'imported') AS imported_refs,
         (SELECT COUNT(*) FROM fundamentals_eod WHERE source = 'imported') AS fundamentals_rows,
         (SELECT COUNT(*) FROM analyst_consensus WHERE source = 'imported') AS analyst_rows,
         (SELECT MAX(updated_at)
            FROM (
              SELECT updated_at FROM fundamentals_eod WHERE source = 'imported'
              UNION ALL
              SELECT updated_at FROM analyst_consensus WHERE source = 'imported'
            )) AS latest_import_at`,
    );
    const appBReceived = appBReceivedRows[0];
    const appBReceivedTotal =
      (appBReceived?.imported_refs ?? 0) + (appBReceived?.fundamentals_rows ?? 0) + (appBReceived?.analyst_rows ?? 0);
    connections.push({
      id: 'app-b:receive',
      label: 'App B → congress.trade Import',
      status: connectionStatus(!!runtimeSecrets.INGEST_TOKEN, 0, appBReceived?.latest_import_at ?? null),
      configured: !!runtimeSecrets.INGEST_TOKEN,
      lastUsedAt: appBReceived?.latest_import_at ?? null,
      callsTotal: appBReceivedTotal,
      callsLast24h: 0,
      callsToday: 0,
      errorsLast24h: 0,
      note: runtimeSecrets.INGEST_TOKEN
        ? 'Scoped import token configured; activity inferred from imported market-data rows'
        : 'INGEST_TOKEN is not available to receive App B imports',
    });

    const appBPushConfigured = !!(runtimeSecrets.APP_B_IMPORT_URL && runtimeSecrets.APP_B_INGEST_TOKEN);
    connections.push({
      id: 'app-b:send',
      label: 'congress.trade → App B Push',
      status: appBPushConfigured ? 'ok' : 'warn',
      configured: appBPushConfigured,
      lastUsedAt: null,
      callsTotal: 0,
      callsLast24h: 0,
      callsToday: 0,
      errorsLast24h: 0,
      note: appBPushConfigured
        ? 'Outbound shared-data push is configured; no send audit table exists yet'
        : 'APP_B_IMPORT_URL/APP_B_INGEST_TOKEN is missing or incomplete',
    });

    const providerRows = await optionalAll<{
      provider: string;
      calls_total: number;
      calls_last_24h: number;
      calls_today: number;
      last_used_at: string | null;
      errors_last_24h: number;
    }>(
      c.env,
      `SELECT CASE
                WHEN lower(source) LIKE '%socratic%' THEN 'socratic'
                WHEN lower(source) LIKE '%massive%' THEN 'massive'
                WHEN lower(source) LIKE '%intrinio%' THEN 'intrinio'
                WHEN lower(source) LIKE '%twelvedata%' THEN 'twelvedata'
                WHEN lower(source) LIKE '%finnhub%' THEN 'finnhub'
                WHEN lower(source) LIKE '%edgar%' THEN 'edgar'
                ELSE 'other'
              END AS provider,
              COUNT(*) AS calls_total,
              SUM(CASE WHEN enriched_at >= ? THEN 1 ELSE 0 END) AS calls_last_24h,
              SUM(CASE WHEN enriched_at >= ? THEN 1 ELSE 0 END) AS calls_today,
              MAX(enriched_at) AS last_used_at,
              SUM(CASE WHEN enrichment_error IS NOT NULL AND enrichment_error != '' AND enriched_at >= ? THEN 1 ELSE 0 END) AS errors_last_24h
         FROM securities_ref
        WHERE source IS NOT NULL AND source != ''
        GROUP BY provider`,
      [last24, today, last24],
    );
    const providerUsage = new Map(providerRows.map((row) => [row.provider, row]));
    const addMarketProvider = (id: string, label: string, configured: boolean, note: string) => {
      const row = providerUsage.get(id);
      connections.push({
        id: `provider:${id}`,
        label,
        status: connectionStatus(configured, row?.errors_last_24h ?? 0, row?.last_used_at ?? null),
        configured,
        lastUsedAt: row?.last_used_at ?? null,
        callsTotal: row?.calls_total ?? 0,
        callsLast24h: row?.calls_last_24h ?? 0,
        callsToday: row?.calls_today ?? 0,
        errorsLast24h: row?.errors_last_24h ?? 0,
        note,
      });
    };
    const socraticConfigured = !!(runtimeSecrets.APP_B_IMPORT_URL && runtimeSecrets.APP_B_INGEST_TOKEN);
    addMarketProvider(
      'socratic',
      'Socratic.Trade',
      socraticConfigured,
      socraticConfigured
        ? 'Company profiles, quotes, and EOD prices. FMP is not a fallback.'
        : 'APP_B_IMPORT_URL and APP_B_INGEST_TOKEN are required. FMP is not a fallback.',
    );
    addMarketProvider('massive', 'Massive Market Data', false, 'Not on the enrichment or price path. Market data comes from Socratic.Trade.');
    addMarketProvider('intrinio', 'Intrinio Reference Data', false, 'Not on the enrichment or price path. Market data comes from Socratic.Trade.');
    addMarketProvider('twelvedata', 'Twelve Data Reference', false, 'Not on the enrichment or price path. Market data comes from Socratic.Trade.');
    addMarketProvider('finnhub', 'Finnhub Reference', false, 'Not on the enrichment or price path. Market data comes from Socratic.Trade.');
    addMarketProvider('tiingo', 'Tiingo Reference', false, 'Not on the enrichment or price path. Market data comes from Socratic.Trade.');
    addMarketProvider('edgar', 'SEC EDGAR Reference', true, 'Public CIK/SIC baseline when Socratic.Trade has no profile. No secret required.');

    const logoDevToken = runtimeSecrets.LOGODEV_PUBLISHABLE_KEY || runtimeSecrets.LOGO_DEV_TOKEN;
    connections.push({
      id: 'provider:logodev',
      label: 'Logo.dev',
      status: logoDevToken ? 'ok' : 'warn',
      configured: !!logoDevToken,
      lastUsedAt: null,
      callsTotal: 0,
      callsLast24h: 0,
      callsToday: 0,
      errorsLast24h: 0,
      note: logoDevToken
        ? (runtimeSecrets.LOGODEV_PUBLISHABLE_KEY
          ? 'Ticker logo proxy token available (LOGODEV_PUBLISHABLE_KEY)'
          : 'Ticker logo proxy token available via LOGO_DEV_TOKEN alias')
        : 'Neither LOGODEV_PUBLISHABLE_KEY nor LOGO_DEV_TOKEN is available to this runtime',
    });

    // Read the maintained, indexed securities_ref.latest_price_date instead of
    // MAX(date) over the ~1.43M-row price_eod table (no date-leading index there,
    // so that was a full scan on every /diagnostics poll).
    const priceRows = await optionalAll<{ last_used_at: string | null }>(
      c.env,
      `SELECT MAX(latest_price_date) AS last_used_at FROM securities_ref`
    );
    const priceRow = priceRows[0];
    const hasPriceProvider = !!(runtimeSecrets.APP_B_IMPORT_URL && runtimeSecrets.APP_B_INGEST_TOKEN);
    connections.push({
      id: 'cache:prices',
      label: 'Asset Price Cache',
      status: connectionStatus(hasPriceProvider, 0, priceRow?.last_used_at ?? null),
      configured: hasPriceProvider,
      lastUsedAt: priceRow?.last_used_at ?? null,
      callsTotal: 0,
      callsLast24h: 0,
      callsToday: 0,
      errorsLast24h: 0,
      note: hasPriceProvider
        ? 'EOD history from Socratic.Trade. Counts show cached assets/rows, not raw API calls.'
        : 'APP_B_IMPORT_URL and APP_B_INGEST_TOKEN are required. FMP is not a price source.',
    });

    const spxRows = await optionalAll<{ last_used_at: string | null }>(
      c.env,
      `SELECT MAX(date) AS last_used_at FROM spx_eod`
    );
    const spxRow = spxRows[0];
    connections.push({
      id: 'cache:spx',
      label: 'S&P Benchmark Cache',
      status: connectionStatus(hasPriceProvider, 0, spxRow?.last_used_at ?? null),
      configured: hasPriceProvider,
      lastUsedAt: spxRow?.last_used_at ?? null,
      callsTotal: 0,
      callsLast24h: 0,
      callsToday: 0,
      errorsLast24h: 0,
      note: 'SPY-adjusted close history used as the S&P comparison baseline',
    });

    const perfRows = await optionalAll<{ last_used_at: string | null }>(
      c.env,
      `SELECT MAX(computed_at) AS last_used_at FROM tx_performance`
    );
    const perfRow = perfRows[0];
    connections.push({
      id: 'cache:performance',
      label: 'Trade Performance Anchors',
      status: connectionStatus(hasPriceProvider, 0, perfRow?.last_used_at ?? null),
      configured: hasPriceProvider,
      lastUsedAt: perfRow?.last_used_at ?? null,
      callsTotal: 0,
      callsLast24h: 0,
      callsToday: 0,
      errorsLast24h: 0,
      note: 'Required for per-trade and member S&P-relative performance',
    });

    const webhooks = await optionalAll<{
      calls_total: number;
      calls_last_24h: number;
      calls_today: number;
      last_used_at: string | null;
      errors_last_24h: number;
    }>(
      c.env,
      `SELECT COUNT(*) AS calls_total,
              SUM(CASE WHEN updated_at >= ? THEN 1 ELSE 0 END) AS calls_last_24h,
              SUM(CASE WHEN updated_at >= ? THEN 1 ELSE 0 END) AS calls_today,
              MAX(updated_at) AS last_used_at,
              SUM(CASE WHEN last_error IS NOT NULL AND last_error != '' AND updated_at >= ? THEN 1 ELSE 0 END) AS errors_last_24h
         FROM deliveries`,
      [last24, today, last24],
    );
    const wh = webhooks[0];
    connections.push({
      id: 'delivery:webhook',
      label: 'Webhook Delivery',
      status: connectionStatus(!!runtimeSecrets.WEBHOOK_SIGNING_KEY, wh?.errors_last_24h ?? 0, wh?.last_used_at ?? null),
      configured: !!runtimeSecrets.WEBHOOK_SIGNING_KEY,
      lastUsedAt: wh?.last_used_at ?? null,
      callsTotal: wh?.calls_total ?? 0,
      callsLast24h: wh?.calls_last_24h ?? 0,
      callsToday: wh?.calls_today ?? 0,
      errorsLast24h: wh?.errors_last_24h ?? 0,
      note: runtimeSecrets.WEBHOOK_SIGNING_KEY ? 'Delivery attempts recorded' : 'WEBHOOK_SIGNING_KEY is not available to this Worker runtime',
    });

    const apnsConfig = await resolveApnsConfig(c.env);
    const apnsReady = apnsConfigured(apnsConfig);
    const apnsFanout = await inspectApnsFanoutDiagnostics(c.env).catch(() => null);
    const apnsLaneError = apnsFanout?.lastLaneError ?? null;
    const apnsLaneErrorRecent = apnsLaneErrorIsRecent(apnsLaneError?.at, now);
    const apnsQueryError = apnsFanout && !apnsFanout.queryOk ? apnsFanout.queryError : null;
    const apnsErrorCount = (apnsLaneErrorRecent ? 1 : 0) + (apnsQueryError ? 1 : 0);
    const apnsNoteParts = [
      apnsReady ? 'APNs credentials present' : 'APNs credentials are not available to this runtime',
      `${apnsFanout?.activeDevices ?? 0} active device${(apnsFanout?.activeDevices ?? 0) === 1 ? '' : 's'}`,
    ];
    if (apnsQueryError) apnsNoteParts.push(`trade query failed: ${apnsQueryError}`);
    else if (apnsFanout) apnsNoteParts.push('trade query ok');
    if (apnsLaneErrorRecent) apnsNoteParts.push(`last lane error: ${apnsLaneError.message}`);
    else if (apnsLaneError) apnsNoteParts.push(`last lane error (older than 24h): ${apnsLaneError.message}`);
    connections.push({
      id: 'delivery:apns',
      label: 'APNs Fan-out',
      status: apnsErrorCount > 0
        ? 'error'
        : !apnsReady
          ? 'warn'
          : (apnsFanout?.activeDevices ?? 0) === 0
            ? 'warn'
            : connectionStatus(true, 0, apnsFanout?.lastTradeAt ?? apnsFanout?.lastReviewAt ?? null),
      configured: apnsReady,
      lastUsedAt: apnsFanout?.lastTradeAt ?? apnsFanout?.lastReviewAt ?? null,
      callsTotal: 0,
      callsLast24h: 0,
      callsToday: 0,
      errorsLast24h: apnsErrorCount,
      note: apnsNoteParts.join('; '),
    });

    connections.push({
      id: 'auth:google',
      label: 'Google Sign-In',
      status: runtimeSecrets.GOOGLE_OAUTH_CLIENT_ID ? 'ok' : 'warn',
      configured: !!runtimeSecrets.GOOGLE_OAUTH_CLIENT_ID,
      lastUsedAt: null,
      callsTotal: 0,
      callsLast24h: 0,
      callsToday: 0,
      errorsLast24h: 0,
      note: runtimeSecrets.GOOGLE_OAUTH_CLIENT_ID ? 'Client id available' : 'GOOGLE_OAUTH_CLIENT_ID is not available to this Worker runtime',
    });
    connections.push({
      id: 'email:resend',
      label: 'Email',
      status: runtimeSecrets.RESEND_API_KEY && runtimeSecrets.EMAIL_FROM ? 'ok' : 'warn',
      configured: !!(runtimeSecrets.RESEND_API_KEY && runtimeSecrets.EMAIL_FROM),
      lastUsedAt: null,
      callsTotal: 0,
      callsLast24h: 0,
      callsToday: 0,
      errorsLast24h: 0,
      note: runtimeSecrets.RESEND_API_KEY && runtimeSecrets.EMAIL_FROM ? 'Resend sender available' : 'RESEND_API_KEY/EMAIL_FROM unavailable or incomplete',
    });
    connections.push({
      id: 'billing:stripe',
      label: 'Stripe Billing',
      status: runtimeSecrets.STRIPE_SECRET_KEY ? 'ok' : 'warn',
      configured: !!runtimeSecrets.STRIPE_SECRET_KEY,
      lastUsedAt: null,
      callsTotal: 0,
      callsLast24h: 0,
      callsToday: 0,
      errorsLast24h: 0,
      note: runtimeSecrets.STRIPE_SECRET_KEY ? 'Secret key available' : 'STRIPE_SECRET_KEY is not available to this Worker runtime',
    });

    const errors: DiagnosticError[] = [];
    if (apnsQueryError) {
      errors.push({
        at: now.toISOString(),
        area: 'APNs Fan-out',
        severity: 'error',
        subject: 'apns_fanout',
        message: apnsQueryError,
      });
    }
    if (apnsLaneErrorRecent && apnsLaneError) {
      errors.push({
        at: apnsLaneError.at,
        area: 'APNs Fan-out',
        severity: 'error',
        subject: 'apns_fanout',
        message: apnsLaneError.message,
      });
    }
    for (const source of secretStatus.sources) {
      if (source.configured && !source.ok) {
        errors.push({
          at: secretStatus.lastRefreshAt ?? now.toISOString(),
          area: 'Infisical',
          severity: 'error',
          subject: source.name,
          message: source.error ?? 'Secret source failed to refresh',
        });
      }
    }
    if (!runtimeSecrets.APP_B_IMPORT_URL || !runtimeSecrets.APP_B_INGEST_TOKEN) {
      errors.push({
        at: now.toISOString(),
        area: 'Socratic.Trade',
        severity: 'warning',
        subject: 'Market data',
        message:
          'APP_B_IMPORT_URL and APP_B_INGEST_TOKEN are required for company profiles, quotes, and EOD prices. FMP is latency probes only and is not a fallback.',
      });
    }
    const filingErrors = await optionalAll<{
      first_seen_at: string | null;
      doc_id: string;
      error: string;
    }>(
      c.env,
      // A provider-only stub closed as verified_empty can keep its
      // provider-only:{provider}:{raw key} marker in filings.error (the
      // autonomy sweep preserves it when the review payload is truncated JSON,
      // so the official-side reconcile can still match the raw key).  That is
      // a closed lead, not a failure: leave it out so it neither shows as a
      // prod error nor pushes real filing errors out of the newest 40.
      // When the official filing lands later, rejectProviderMissingStubAsDuplicate
      // flips the stub to ingest_status = 'error' but leaves the marker in
      // place; that closed duplicate is not a failure either.  Only a stub whose
      // review row carries that duplicate rejection is excluded, so any other
      // error-status row (including a stub that still has only its marker) shows.
      `SELECT first_seen_at, doc_id, error
         FROM filings
        WHERE error IS NOT NULL AND error != ''
          AND NOT (
            error LIKE 'provider-only:%'
            AND (
              ingest_status = 'verified_empty'
              OR (
                ingest_status = 'error'
                AND EXISTS (
                  SELECT 1 FROM review_queue rq
                   WHERE rq.doc_id = filings.doc_id
                     AND rq.resolved = 1
                     AND rq.resolution_kind = 'rejected'
                     AND substr(rq.resolution_reason, 1, length(?)) = ?
                )
              )
            )
          )
        ORDER BY first_seen_at DESC
        LIMIT 40`,
      [PROVIDER_STUB_DUPLICATE_REJECT_PREFIX, PROVIDER_STUB_DUPLICATE_REJECT_PREFIX],
    );
    for (const e of filingErrors) {
      errors.push({ at: e.first_seen_at, area: 'Filing', severity: 'error', subject: e.doc_id, message: e.error });
    }

    const reviewErrors = await optionalAll<{
      created_at: string | null;
      doc_id: string;
      reason: string | null;
    }>(
      c.env,
      `SELECT created_at, doc_id, reason
         FROM review_queue
        WHERE resolved = 0
        ORDER BY created_at DESC
        LIMIT 40`,
    );
    for (const e of reviewErrors) {
      errors.push({
        at: e.created_at,
        area: 'Review Queue',
        severity: 'warning',
        subject: e.doc_id,
        message: e.reason ?? 'Needs review',
      });
    }

    const deliveryErrors = await optionalAll<{
      updated_at: string | null;
      id: string;
      last_error: string | null;
    }>(
      c.env,
      `SELECT updated_at, id, last_error
         FROM deliveries
        WHERE last_error IS NOT NULL AND last_error != ''
        ORDER BY updated_at DESC
        LIMIT 40`,
    );
    for (const e of deliveryErrors) {
      errors.push({ at: e.updated_at, area: 'Delivery', severity: 'error', subject: e.id, message: e.last_error ?? '' });
    }

    const enrichmentErrors = await optionalAll<{
      enriched_at: string | null;
      ticker: string;
      enrichment_error: string | null;
    }>(
      c.env,
      `SELECT enriched_at, ticker, enrichment_error
         FROM securities_ref
        WHERE enrichment_error IS NOT NULL AND enrichment_error != ''
        ORDER BY enriched_at DESC
        LIMIT 40`,
    );
    for (const e of enrichmentErrors) {
      errors.push({
        at: e.enriched_at,
        area: 'Enrichment',
        severity: 'error',
        subject: e.ticker,
        message: e.enrichment_error ?? '',
      });
    }

    const commandErrors = await optionalAll<{
      updated_at: string | null;
      id: string;
      type: string;
      error: string | null;
    }>(
      c.env,
      `SELECT updated_at, id, type, error
         FROM client_commands
        WHERE error IS NOT NULL AND error != ''
        ORDER BY updated_at DESC
        LIMIT 40`,
    );
    for (const e of commandErrors) {
      errors.push({
        at: e.updated_at,
        area: 'Client Command',
        severity: 'error',
        subject: `${e.type} ${e.id}`,
        message: e.error ?? '',
      });
    }

    const userRows = await optionalAll<{
      total_users: number;
      subscribed_users: number;
      logins_last_24h: number;
    }>(
      c.env,
      `SELECT COUNT(*) AS total_users,
              SUM(CASE WHEN subscription_status IN ('active', 'trialing') THEN 1 ELSE 0 END) AS subscribed_users,
              SUM(CASE WHEN last_login_at >= ? THEN 1 ELSE 0 END) AS logins_last_24h
         FROM users`,
      [last24],
    );
    const deliverySubRows = await optionalAll<{
      total: number;
      active: number;
    }>(
      c.env,
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) AS active
         FROM subscriptions`,
    );
    const recentLogins = await optionalAll<{
      email: string;
      name: string | null;
      last_login_at: string | null;
      plan: string | null;
      subscription_status: string | null;
    }>(
      c.env,
      `SELECT email, name, last_login_at, plan, subscription_status
         FROM users
        WHERE last_login_at IS NOT NULL
        ORDER BY last_login_at DESC
        LIMIT 10`,
    );
    const userRow = userRows[0];
    const deliverySubRow = deliverySubRows[0];
    const premiumCounts = await localPremiumCounts(c.env).catch(() => ({
      premiumUsers: userRow?.subscribed_users ?? 0,
      trialUsers: 0,
      paidUsers: 0,
      stripeUsers: userRow?.subscribed_users ?? 0,
      appleUsers: 0,
    }));
    const userStats: DiagnosticUserStats = {
      totalUsers: userRow?.total_users ?? 0,
      subscribedUsers: premiumCounts.premiumUsers,
      premiumUsers: premiumCounts.premiumUsers,
      trialUsers: premiumCounts.trialUsers,
      paidUsers: premiumCounts.paidUsers,
      stripeUsers: premiumCounts.stripeUsers,
      appleUsers: premiumCounts.appleUsers,
      deliverySubscriptions: deliverySubRow?.total ?? 0,
      activeDeliverySubscriptions: deliverySubRow?.active ?? 0,
      adminUsers: adminConfig.allow.size,
      loginsLast24h: userRow?.logins_last_24h ?? 0,
      recentLogins: recentLogins.map((row) => ({
        email: row.email,
        name: row.name,
        lastLoginAt: row.last_login_at,
        plan: row.plan,
        subscriptionStatus: row.subscription_status,
      })),
    };

    errors.sort((a, b) => Date.parse(b.at ?? '') - Date.parse(a.at ?? ''));
    // Provider-health overlay state: open circuit breakers (per provider AND
    // per concrete provider:model) + rolling per-model health windows. Null
    // when KV is unavailable. Names/counters only, never secrets.
    const providerHealth = await providerHealthDiagnostics(c.env).catch(() => null);

    // --- Hard resource governors (owner mandate 2026-07-18) ---------------
    // One line each: today's LLM dollars vs ceiling, today's D1 rows vs
    // budget + write-governor quarantines, and every known outbound target
    // circuit with its parked/quarantined backlog.
    const llmSpend = await inspectLlmSpend(c.env).catch(() => null);
    const d1BudgetRows = await optionalAll<{ rows_read: number; rows_written: number }>(
      c.env,
      'SELECT rows_read, rows_written FROM d1_budget WHERE day = ?',
      [now.toISOString().slice(0, 10)],
    );
    const writeQuarantineRows = await optionalAll<{ events: number; dropped: number }>(
      c.env,
      `SELECT COUNT(*) AS events, COALESCE(SUM(dropped), 0) AS dropped
         FROM d1_write_quarantine WHERE day = ?`,
      [now.toISOString().slice(0, 10)],
    );
    const outboundTargets = await readTargetCircuits(c.env, 25).catch(() => []);
    const parkedRows = await optionalAll<{ parked: number; quarantined: number }>(
      c.env,
      `SELECT SUM(CASE WHEN status = 'parked' THEN 1 ELSE 0 END) AS parked,
              SUM(CASE WHEN status = 'quarantined' THEN 1 ELSE 0 END) AS quarantined
         FROM deliveries`,
    );
    const resourceGovernors = {
      llmSpend,
      d1: {
        today: d1BudgetRows[0] ?? null,
        writeQuarantineToday: writeQuarantineRows[0] ?? null,
      },
      outbound: {
        targets: outboundTargets,
        parkedDeliveries: Number(parkedRows[0]?.parked ?? 0),
        quarantinedDeliveries: Number(parkedRows[0]?.quarantined ?? 0),
      },
    };

    return c.json({
      generatedAt: now.toISOString(),
      providerHealth,
      resourceGovernors,
      connections,
      usageTelemetry: {
        state: usageMonitorState,
        enabled: !usageMonitorExplicitlyDisabled,
        ingestUrlConfigured: usageMonitorUrlConfigured,
        ingestTokenConfigured: usageMonitorTokenConfigured,
        environmentConfigured: usageMonitorEnvironmentConfigured,
        queueConfigured: usageMonitorQueueConfigured,
        fallback: usageMonitorFallback,
        receiverDeliveryObservability: 'not_persisted_locally',
      },
      secrets: secretStatus,
      userStats,
      errors: errors.slice(0, 75),
      errorCount: errors.length,
    });
  });

  // --- GET /premium-roster ------------------------------------------------
  // Admin Premium Members: email, plan, Trial|Paid, Stripe|Apple
  // (Sandbox vs Production), with a live Stripe overlay.  Heals stale
  // local `trialing` when Stripe already shows `active`.
  r.get('/premium-roster', async (c) => {
    return c.json(await buildPremiumRoster(c.env));
  });

  // --- POST /diagnostics/secrets/refresh ----------------------------------
  // Force-refresh the Infisical secret cache. This does not write plaintext
  // secrets into KV/D1/Cloudflare vars; optional KV cache entries are encrypted.
  r.post('/diagnostics/secrets/refresh', async (c) => {
    return c.json({ secrets: await refreshSecrets(c.env) });
  });

  // --- POST /diagnostics/secrets/update -----------------------------------
  // Update a secret in Infisical and then refresh the cache.
  r.post('/diagnostics/secrets/update', async (c) => {
    if (isPreviewDeployment(c.env)) {
      return c.json({
        ok: false,
        error: 'Infisical secret updates are disabled in preview deployments',
        code: 'preview_write_protected',
      }, 403);
    }
    const { source, key, value } = await c.req.json();
    if (!source || !key || value === undefined) {
      return c.json({ ok: false, error: 'Missing source, key, or value' }, 400);
    }
    if (source !== 'app' && source !== 'shared') {
      return c.json({ ok: false, error: 'Invalid source (must be app or shared)' }, 400);
    }
    await updateSecret(c.env, source, key, value);
    // Refresh the local cache to pull down the newly updated secret
    return c.json({ ok: true, secrets: await refreshSecrets(c.env) });
  });

  // --- GET /ui-settings ---------------------------------------------------
  // Site-wide UI settings the admin controls for ALL visitors (logo style).
  r.get('/ui-settings', async (c) => {
    return c.json({ logoDisplay: await getLogoDisplay(c.env) });
  });

  // --- PUT /ui-settings ---------------------------------------------------
  // Update the site-wide logo style. Body: { logoDisplay: 'tile'|'transparent'|'off' }.
  r.put('/ui-settings', async (c) => {
    let body: Record<string, unknown> = {};
    try {
      const text = await c.req.text();
      if (text) body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const logoDisplay = await setLogoDisplay(c.env, body.logoDisplay);
    return c.json({ logoDisplay });
  });

  // --- GET /admins ----------------------------------------------------------
  // List admins: the env-configured root allowlist (read-only bootstrap —
  // "configured in the environment, not editable here") and every
  // additionally-granted email, with who granted it and when.  This route
  // sits behind the same admin-only auth gate as every other /api/admin/*
  // route (see r.use('*', ...) above) — there is no separate unauthenticated
  // read path, so a non-admin can never enumerate the admin list.
  r.get('/admins', async (c) => {
    const cfg = await adminRuntimeConfig(c.env);
    const granted = await listGrantedAdmins(c.env.DB);
    return c.json({
      adminEmails: [...cfg.envAllow].sort(),
      granted,
      total: cfg.allow.size,
    });
  });

  // --- POST /admins/grant ----------------------------------------------------
  // Body: { email }.  Grants admin access to an email IN ADDITION to
  // ADMIN_EMAILS, which stays the env-configured root bootstrap escape hatch
  // and is never written here.  Emails are trimmed + lowercased on write.
  r.post('/admins/grant', async (c) => {
    let body: Record<string, unknown> = {};
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const rawEmail = typeof body.email === 'string' ? body.email : '';
    if (!rawEmail.trim()) return c.json({ error: 'email is required' }, 400);

    const cfg = await adminRuntimeConfig(c.env);
    const actor = await resolveAdminActor(c);
    const result = await grantAdmin(c.env.DB, { email: rawEmail, actor, envAllow: cfg.envAllow });
    if (!result.ok) return c.json({ error: result.error }, 400);

    try {
      console.log(
        'admin allowlist audit:',
        JSON.stringify({ action: 'grant', email: normalizeAdminEmail(rawEmail), actor, at: new Date().toISOString() }),
      );
    } catch {
      /* console logging is best-effort; the DB audit row above already landed */
    }
    return c.json({ ok: true, granted: await listGrantedAdmins(c.env.DB) });
  });

  // --- POST /admins/revoke ---------------------------------------------------
  // Body: { email }.  Revokes a previously-granted admin.  Refuses to touch an
  // ADMIN_EMAILS address (edit the environment instead — this table never
  // overrides it) and refuses to remove the last remaining admin, whether
  // that's someone else's only access or the caller's own — a clear 400
  // error either way, never a silent no-op.
  r.post('/admins/revoke', async (c) => {
    let body: Record<string, unknown> = {};
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const rawEmail = typeof body.email === 'string' ? body.email : '';
    if (!rawEmail.trim()) return c.json({ error: 'email is required' }, 400);

    const cfg = await adminRuntimeConfig(c.env);
    const actor = await resolveAdminActor(c);
    const result = await revokeAdmin(c.env.DB, {
      email: rawEmail,
      actor,
      actorEmail: actor,
      envAllow: cfg.envAllow,
    });
    if (!result.ok) return c.json({ error: result.error }, 400);

    try {
      console.log(
        'admin allowlist audit:',
        JSON.stringify({ action: 'revoke', email: normalizeAdminEmail(rawEmail), actor, at: new Date().toISOString() }),
      );
    } catch {
      /* console logging is best-effort; the DB audit row above already landed */
    }
    return c.json({ ok: true, granted: await listGrantedAdmins(c.env.DB) });
  });

  // --- POST /backfill -----------------------------------------------------
  // Trigger the historic-trades seed backfill (runSeedBackfill). Pulls the
  // pre-aggregated community datasets and idempotently upserts them as
  // source='seed_dataset' rows. Body (all optional):
  //   { chambers?: ('house'|'senate')[], sinceYear?: number,
  //     limit?: number, dryRun?: boolean }
  // SEED_HOUSE_URL / SEED_SENATE_URL env vars override the (often-gated) source
  // URLs. Runs inline and returns the SeedBackfillResult; per-source failures
  // are reported in `errors` rather than aborting the run.
  r.post('/backfill', async (c) => {
    let body: Record<string, unknown> = {};
    try {
      const text = await c.req.text();
      if (text) body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const opts: Parameters<typeof runSeedBackfillFromEnv>[1] = {};

    if (body.chambers !== undefined) {
      if (
        !Array.isArray(body.chambers) ||
        !body.chambers.every((x) => x === 'house' || x === 'senate')
      ) {
        return c.json({ error: "chambers must be an array of 'house'|'senate'" }, 400);
      }
      opts.chambers = body.chambers as Array<'house' | 'senate'>;
    }
    if (body.sinceYear !== undefined) {
      if (typeof body.sinceYear !== 'number' || !Number.isFinite(body.sinceYear)) {
        return c.json({ error: 'sinceYear must be a number' }, 400);
      }
      opts.sinceYear = body.sinceYear;
    }
    if (body.limit !== undefined) {
      if (typeof body.limit !== 'number' || body.limit <= 0) {
        return c.json({ error: 'limit must be a positive number' }, 400);
      }
      opts.limit = body.limit;
    }
    if (body.dryRun !== undefined) {
      if (typeof body.dryRun !== 'boolean') {
        return c.json({ error: 'dryRun must be a boolean' }, 400);
      }
      opts.dryRun = body.dryRun;
    }

    try {
      const result = await runSeedBackfillFromEnv(c.env, opts);
      return c.json({ ok: result.errors.length === 0, ...result });
    } catch (err) {
      return c.json({ error: `backfill failed: ${(err as Error).message}` }, 500);
    }
  });

  // --- POST /fmp-senate-recovery -----------------------------------------
  // RETIRED: runFmpSenateRecovery refuses every invocation (FMP is latency-only).
  // Route kept so operators get a clear error instead of a silent 404.
  r.post('/fmp-senate-recovery', async (c) => {
    let body: Record<string, unknown> = {};
    try {
      const text = await c.req.text();
      if (text) body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const fromPage = body.fromPage ?? 0;
    const toPage = body.toPage ?? fromPage;
    const dryRun = body.dryRun ?? false;
    if (!Number.isInteger(fromPage) || !Number.isInteger(toPage)) {
      return c.json({ error: 'fromPage and toPage must be integers' }, 400);
    }
    if (
      (fromPage as number) < 0 ||
      (toPage as number) < (fromPage as number) ||
      (toPage as number) > 100 ||
      (toPage as number) - (fromPage as number) + 1 > 5
    ) {
      return c.json({ error: 'pages must satisfy 0 <= fromPage <= toPage <= 100 with at most 5 pages per run' }, 400);
    }
    if (typeof dryRun !== 'boolean') {
      return c.json({ error: 'dryRun must be a boolean' }, 400);
    }

    try {
      const result = await runFmpSenateRecovery(c.env, {
        fromPage: fromPage as number,
        toPage: toPage as number,
        dryRun,
      });
      return c.json(result);
    } catch (err) {
      return c.json({ error: `FMP Senate recovery failed: ${(err as Error).message}` }, 500);
    }
  });

  // --- GET /data-recovery/status -----------------------------------------
  // Secret-safe production receipt for migration/backfill work. Counts are
  // grouped server-side so operators can prove live-source progress without
  // downloading the corpus or exposing filing/member payloads.
  r.get('/data-recovery/status', async (c) => {
    const [filings, transactions, ingestionOutbox, deliveryOutbox, runtimeQueue, filers, prices] = await Promise.all([
      all<{ chamber: string; ingest_status: string; count: number }>(
        c.env.DB,
        `SELECT chamber, COALESCE(ingest_status, 'unknown') AS ingest_status, COUNT(*) AS count
           FROM filings GROUP BY chamber, COALESCE(ingest_status, 'unknown')
           ORDER BY chamber, ingest_status`,
      ),
      all<{ chamber: string; source: string; count: number; latest_created_at: string | null; recent_90d: number }>(
        c.env.DB,
        `SELECT COALESCE(f.chamber, 'unknown') AS chamber,
                t.source,
                COUNT(*) AS count,
                MAX(t.created_at) AS latest_created_at,
                SUM(CASE WHEN t.tx_date >= date('now', '-90 days') THEN 1 ELSE 0 END) AS recent_90d
           FROM transactions t
           LEFT JOIN filings f ON f.doc_id = t.doc_id
          GROUP BY COALESCE(f.chamber, 'unknown'), t.source
          ORDER BY chamber, t.source`,
      ),
      all<{ status: string; count: number; oldest_available_at: string | null }>(
        c.env.DB,
        `SELECT status, COUNT(*) AS count, MIN(available_at) AS oldest_available_at
           FROM ingestion_outbox GROUP BY status ORDER BY status`,
      ),
      all<{ status: string; count: number; oldest_available_at: string | null }>(
        c.env.DB,
        `SELECT status, COUNT(*) AS count, MIN(available_at) AS oldest_available_at
           FROM delivery_outbox GROUP BY status ORDER BY status`,
      ),
      optionalAll<{ queue_name: string; status: string; count: number; oldest_available_at: string | null }>(
        c.env,
        `SELECT queue_name, status, COUNT(*) AS count, MIN(available_at) AS oldest_available_at
           FROM deno_runtime_queue GROUP BY queue_name, status ORDER BY queue_name, status`,
      ),
      all<{ total: number; missing_party: number; missing_state: number; missing_photo: number }>(
        c.env.DB,
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN party IS NULL OR TRIM(party) = '' THEN 1 ELSE 0 END), 0) AS missing_party,
                COALESCE(SUM(CASE WHEN state IS NULL OR TRIM(state) = '' THEN 1 ELSE 0 END), 0) AS missing_state,
                COALESCE(SUM(CASE WHEN photo_url IS NULL OR TRIM(photo_url) = '' THEN 1 ELSE 0 END), 0) AS missing_photo
           FROM filers`,
      ),
      all<{ rows: number | null; tickers: number; latest_date: string | null }>(
        c.env.DB,
        // Never full-scan price_eod (~2.3M rows). Tickers + freshness come from
        // the maintained securities_ref.latest_price_date index; exact row
        // count is served from the singleton price_eod_stats (seeded once by
        // migrate 0058, cheap to read thereafter).
        `SELECT
            (SELECT row_count FROM price_eod_stats WHERE id = 1) AS rows,
            COALESCE((
              SELECT COUNT(*) FROM securities_ref WHERE latest_price_date IS NOT NULL
            ), 0) AS tickers,
            (SELECT MAX(latest_price_date) FROM securities_ref) AS latest_date`,
      ),
    ]);
    return c.json({
      ok: true,
      asOf: new Date().toISOString(),
      filings,
      transactions,
      queues: { ingestionOutbox, deliveryOutbox, runtimeQueue },
      filers: filers[0] ?? { total: 0, missing_party: 0, missing_state: 0, missing_photo: 0 },
      prices: prices[0] ?? { rows: 0, tickers: 0, latest_date: null },
    });
  });

  // --- POST /storage-smoke ------------------------------------------------
  // Authenticated, bounded put/get/content/delete proof for the live RAW_FILES
  // binding. The response deliberately excludes provider errors and object keys.
  r.post('/storage-smoke', async (c) => {
    try {
      return c.json(await verifyRawFilesStorage(c.env.RAW_FILES));
    } catch (err) {
      const stage = err && typeof err === 'object' && 'stage' in err
        ? String((err as { stage: unknown }).stage)
        : 'unknown';
      return c.json({ ok: false, error: 'RAW_FILES storage verification failed', stage }, 503);
    }
  });

  // --- POST /repair-member-identity -----------------------------------------
  // Merge curated legal-name / competitor filer forks onto the preferred
  // official identity (e.g. house-ca17-rohit-khanna + MANUAL-KHANNA →
  // house-ca17-ro-khanna / "Ro Khanna"). Idempotent; safe to re-run.
  r.post('/repair-member-identity', async (c) => {
    try {
      const result = await repairMemberIdentityMerges(c.env);
      return c.json({ ok: true, ...result });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // --- POST /dedupe-filer-identities -----------------------------------------
  // Generic (non-curated) counterpart to /repair-member-identity: finds
  // `filers` rows that forked for the same real member across three passes —
  // (A) middle-initial/punctuation/suffix name variance within the same
  // chamber+state (e.g. "Michael T. McCaul" vs "Michael McCaul" — issue
  // #1452), (B) any rows already sharing (resolved_bioguide_id, chamber),
  // and (C) chamber='executive' rows sharing a name-key once ERM/date/year
  // noise is stripped (state is never consulted for exec rows — they don't
  // carry one) — and merges them. Never deletes a row — aliases are
  // tombstoned via `merged_into` and every rewrite is recorded in
  // filer_identity_merges (migration 0078) so it stays auditable/reversible.
  // Idempotent; safe to re-run (e.g. from a cron alongside /repair-member-identity).
  // Accepts ?dryRun=1 to report clustersFound + details without writing.
  r.post('/dedupe-filer-identities', async (c) => {
    try {
      const dryRun = c.req.query('dryRun') === '1';
      const result = await dedupeSplitFilerIdentities(c.env, { dryRun });
      return c.json({ ok: true, dryRun, ...result });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // --- POST /repair-competitor-executive ------------------------------------
  // One-shot hygiene for competitor_backfill rows on EXEC-* filers:
  //   1) promote raw_text.notes → asset_name when asset is Unknown
  //   2) reassign last-name-collided rows (e.g. Rich McCormick → MANUAL-*)
  //   3) canonicalize sale_full/purchase/buy/exchange → S/P/E
  // Does NOT delete rows. Safe to re-run.
  r.post('/repair-competitor-executive', async (c) => {
    const { canonicalizeTxType } = await import('../shared/txType.ts');
    const {
      assetNameFromCompetitorPayload,
      resolveExecutiveFilerIdFromName,
    } = await import('../shared/executiveIdentity.ts');
    const toTx = canonicalizeTxType;

    const rows = await all<{
      id: string;
      filer_id: string | null;
      asset_name: string | null;
      ticker: string | null;
      tx_type: string | null;
      raw_text: string | null;
    }>(
      c.env.DB,
      `SELECT id, filer_id, asset_name, ticker, tx_type, raw_text
         FROM transactions
        WHERE source = 'competitor_backfill'
          AND deprecated_at IS NULL
          AND (filer_id LIKE 'EXEC-%' OR tx_type NOT IN ('B','P','S','E')
               OR lower(COALESCE(asset_name,'')) IN ('unknown',''))
        LIMIT 20000`,
    );

    let notesPromoted = 0;
    let filerReassigned = 0;
    let typesFixed = 0;
    const filersEnsured = new Set<string>();

    for (const row of rows) {
      let assetName = row.asset_name;
      let filerId = row.filer_id;
      let txType = row.tx_type;
      let changed = false;

      // 1) notes → asset_name
      if (!assetName || /^unknown$/i.test(assetName)) {
        const promoted = assetNameFromCompetitorPayload(row.raw_text, row.ticker);
        if (promoted && !/^unknown$/i.test(promoted) && promoted !== assetName) {
          assetName = promoted;
          notesPromoted += 1;
          changed = true;
        }
      }

      // 2) mis-attribution: EXEC-* only when full name matches curated alias
      if (filerId && filerId.startsWith('EXEC-')) {
        let payloadName = '';
        try {
          const o = row.raw_text ? JSON.parse(row.raw_text) as Record<string, unknown> : null;
          payloadName = String(o?.name ?? o?.Representative ?? o?.politician ?? o?.reporter ?? '');
        } catch {
          payloadName = '';
        }
        if (payloadName) {
          const correct = resolveExecutiveFilerIdFromName(payloadName);
          if (correct !== filerId) {
            if (correct) {
              filerId = correct;
            } else {
              // Demote to MANUAL-{LAST} (House/other) — never keep wrong EXEC slot.
              const last = payloadName
                .replace(/,/g, ' ')
                .trim()
                .split(/\s+/)
                .filter(Boolean)
                .pop()
                ?.toUpperCase()
                .replace(/[^A-Z]/g, '') || 'UNKNOWN';
              filerId = `MANUAL-${last}`;
              if (!filersEnsured.has(filerId)) {
                await run(
                  c.env.DB,
                  `INSERT OR IGNORE INTO filers (bioguide_id, full_name, chamber)
                   VALUES (?, ?, 'house')`,
                  [filerId, payloadName],
                );
                filersEnsured.add(filerId);
              }
            }
            filerReassigned += 1;
            changed = true;
          }
        }
      }

      // 3) tx_type aliases
      const canon = toTx(txType);
      if (canon && canon !== txType) {
        txType = canon;
        typesFixed += 1;
        changed = true;
      }

      if (changed) {
        await run(
          c.env.DB,
          `UPDATE transactions
              SET asset_name = ?, filer_id = ?, tx_type = ?
            WHERE id = ?`,
          [assetName, filerId, txType, row.id],
        );
      }
    }

    return c.json({
      ok: true,
      scanned: rows.length,
      notesPromoted,
      filerReassigned,
      typesFixed,
    });
  });

  // --- POST /repair-competitor-attribution ----------------------------------
  // Repairs source='competitor_backfill' rows (doc_id LIKE 'COMPETITOR-%')
  // whose filer_id was resolved by LAST NAME ONLY (verified in production —
  // e.g. Rep. Mike Collins GA-10's crypto trades landing on Sen. Susan M.
  // Collins ME) by re-deriving the TRUE reporter from raw_text and
  // reassigning when chamber/state/resolved-bioguide clearly disagree with
  // the assigned filer. In the same pass, reclassifies crypto disclosures
  // mis-stored as asset_type='stock' (raw notes carry a '[CT]' marker or a
  // crypto keyword) to the House 'CT' asset-type code. ?dryRun=1 reports
  // without writing. Never deletes rows; safe to re-run.
  r.post('/repair-competitor-attribution', async (c) => {
    const { repairCompetitorAttribution } = await import('./competitorAttributionRepair.ts');
    const dryRunParam = c.req.query('dryRun');
    const dryRun = dryRunParam === '1' || dryRunParam === 'true';
    try {
      const result = await repairCompetitorAttribution(c.env, { dryRun });
      return c.json(result);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // --- POST /oge-backfill ---------------------------------------------------
  // Force-poll the OGE President/VP + PAS indexes and enqueue any new executive
  // 278-T filings through the normal pipeline (same filing.new message the cron
  // watcher emits). Idempotent: INSERT OR IGNORE means re-runs only pick up
  // genuinely-new filings.
  r.post('/oge-backfill', async (c) => {
    let body: Record<string, unknown> = {};
    try {
      const raw = await c.req.text();
      if (raw) body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if (body.maxFilings !== undefined && (typeof body.maxFilings !== 'number' || body.maxFilings <= 0)) {
      return c.json({ error: 'maxFilings must be a positive number' }, 400);
    }
    if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') {
      return c.json({ error: 'dryRun must be a boolean' }, 400);
    }
    try {
      const dryRun = body.dryRun === true;
      const newCount = await pollExecutive(c.env, new Date(), {
        force: true,
        maxFilings: typeof body.maxFilings === 'number' ? body.maxFilings : undefined,
        dryRun,
      });
      return c.json({ ok: true, dryRun, candidateFilings: dryRun ? newCount ?? 0 : undefined, newFilings: dryRun ? 0 : newCount ?? 0 });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // --- POST /house-backfill -----------------------------------------------
  // High-fidelity House history from the official yearly bulk ZIP indexes:
  // walks the House Clerk per-year indexes and feeds every PTR into the live
  // ingestion pipeline (emits the same filing.new INGEST_QUEUE message the cron
  // watcher does), populating House history into `transactions` with
  // source='primary'.
  // Body (all optional):
  //   { fromYear?: number, toYear?: number, maxFilings?: number, dryRun?: boolean }
  // maxFilings defaults to 500. dryRun only counts matching PTRs; it does not
  // write filings rows or enqueue pipeline work.
  r.post('/house-backfill', async (c) => {
    let body: Record<string, unknown> = {};
    try {
      const raw = await c.req.text();
      if (raw) body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    try {
      const result = await runHouseHistoricalBackfill(c.env, {
        fromYear: typeof body.fromYear === 'number' ? body.fromYear : undefined,
        toYear: typeof body.toYear === 'number' ? body.toYear : undefined,
        maxFilings: typeof body.maxFilings === 'number' ? body.maxFilings : undefined,
        dryRun: body.dryRun === true,
      });
      return c.json(result);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // --- POST /senate-backfill ---------------------------------------------
  // Search official Senate eFD PTR history in explicit date windows and hand
  // genuinely-new filings to the same durable outbox/queue as the live watcher.
  r.post('/senate-backfill', async (c) => {
    let body: Record<string, unknown> = {};
    try {
      const raw = await c.req.text();
      if (raw) body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if (typeof body.fromDate !== 'string' || typeof body.toDate !== 'string') {
      return c.json({ error: 'fromDate and toDate are required date strings' }, 400);
    }
    if (body.maxFilings !== undefined && typeof body.maxFilings !== 'number') {
      return c.json({ error: 'maxFilings must be a number' }, 400);
    }
    if (body.maxSourceQueries !== undefined && typeof body.maxSourceQueries !== 'number') {
      return c.json({ error: 'maxSourceQueries must be a number' }, 400);
    }
    if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') {
      return c.json({ error: 'dryRun must be a boolean' }, 400);
    }
    try {
      const result = await runSenateBackfill(c.env, {
        fromDate: body.fromDate,
        toDate: body.toDate,
        maxFilings: body.maxFilings as number | undefined,
        maxSourceQueries: body.maxSourceQueries as number | undefined,
        dryRun: body.dryRun === true,
      });
      return c.json({
        ok: result.errors.length === 0 && !result.sourceLimitReached,
        ...result,
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // --- POST /queue-requeue-failed -----------------------------------------
  // Reset terminally-failed deno_runtime_queue rows (status='failed') back to
  // 'pending' after a systemic consumer fix — the durable-queue analogue of
  // /ingest-requeue-failed (which covers the ingestion_outbox table). Used for
  // incidents like the 2026-07 DLQ replay bug that permanently dead-lettered
  // non-filing.new ingest messages. Idempotent; rows whose dedupe key is held
  // by an active sibling are skipped. Body (all optional):
  //   { queue?: 'ingest'|'delivery' (default 'ingest'), type?: string,
  //     limit?: number (default 500, max 5000), dryRun?: boolean,
  //     transientOnly?: boolean }
  r.post('/queue-requeue-failed', async (c) => {
    let body: Record<string, unknown> = {};
    try {
      const raw = await c.req.text();
      if (raw) body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const queueRaw = body.queue === undefined ? undefined : String(body.queue);
    if (queueRaw !== undefined && queueRaw !== 'ingest' && queueRaw !== 'delivery') {
      return c.json({ error: "queue must be 'ingest' or 'delivery'" }, 400);
    }
    const queue = queueRaw as 'ingest' | 'delivery' | undefined;
    try {
      if (body.transientOnly === true) {
        return c.json(
          await requeueTransientFailedDurableJobs(c.env, {
            queue,
            limit: typeof body.limit === 'number' ? body.limit : undefined,
            dryRun: body.dryRun === true,
          }),
        );
      }
      return c.json(
        await requeueFailedDurableJobs(c.env, {
          queue,
          type: typeof body.type === 'string' ? body.type : undefined,
          limit: typeof body.limit === 'number' ? body.limit : undefined,
          dryRun: body.dryRun === true,
        }),
      );
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // --- POST /ingest-requeue-failed ------------------------------------------
  // Reopen dead-lettered ingestion_outbox rows (status='failed') after a deploy
  // fixes a systemic fetch failure, then flush a first batch immediately; the
  // per-minute scheduled flush drains the rest. Idempotent: only rows still in
  // 'failed' are touched, and re-fetching an errored filing is safe (same R2
  // key, ingest_status transitions back through 'fetched').
  // Body (all optional): { docIdPrefix?: string, dryRun?: boolean, transientOnly?: boolean }
  r.post('/ingest-requeue-failed', async (c) => {
    let body: Record<string, unknown> = {};
    try {
      const raw = await c.req.text();
      if (raw) body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const docIdPrefix = typeof body.docIdPrefix === 'string' ? body.docIdPrefix : undefined;
    try {
      if (body.transientOnly === true) {
        const result = await requeueTransientFailedIngestionOutbox(c.env, {
          dryRun: body.dryRun === true,
          limit: typeof body.limit === 'number' ? body.limit : undefined,
        });
        const flushed = result.dryRun
          ? 0
          : (await flushIngestionOutbox(c.env, { limit: 100 }));
        return c.json({ ...result, flushed });
      }
      if (body.dryRun === true) {
        const prefix = docIdPrefix?.replace(/[%_]/g, '') ?? '';
        const rows = await all<{ n: number }>(
          c.env.DB,
          `SELECT COUNT(*) AS n FROM ingestion_outbox WHERE status = 'failed'${prefix ? ' AND doc_id LIKE ?' : ''}`,
          prefix ? [`${prefix}%`] : [],
        );
        return c.json({ ok: true, dryRun: true, failedRows: rows[0]?.n ?? 0 });
      }
      const requeued = await requeueFailedIngestionOutbox(c.env, { docIdPrefix });
      const flushed = await flushIngestionOutbox(c.env, { limit: 100 });
      return c.json({ ok: true, requeued, flushed });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // --- POST /ingest-retry-errored -------------------------------------------
  // Re-enqueue extraction-stage casualties: filings stuck in ingest_status=
  // 'error' that ALREADY have raw bytes in R2 re-enter the pipeline at
  // filing.fetched (classify -> extract -> review/publish) — no re-fetch and no
  // model spend on healthy docs (unlike /reprocess, which re-extracts every
  // recent filing). Fetch-stage errors (no raw bytes) are the outbox's job:
  // POST /ingest-requeue-failed. Idempotent: re-running re-enqueues whatever
  // is still errored, and the pipeline overwrites ingest_status on progress.
  // Body (all optional):
  //   { chamber?: 'house'|'senate'|'executive', limit?: number, dryRun?: boolean }
  r.post('/ingest-retry-errored', async (c) => {
    let body: Record<string, unknown> = {};
    try {
      const raw = await c.req.text();
      if (raw) body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const chamber = typeof body.chamber === 'string' ? body.chamber : undefined;
    if (chamber !== undefined && !['house', 'senate', 'executive'].includes(chamber)) {
      return c.json({ error: "chamber must be 'house', 'senate' or 'executive'" }, 400);
    }
    let limit = typeof body.limit === 'number' && body.limit > 0 ? Math.floor(body.limit) : 500;
    if (limit > 2000) limit = 2000;
    // Cover BOTH error shapes: rows that were fetched (raw bytes in R2) and
    // failed downstream resume at filing.fetched; rows that failed at the
    // FETCH stage itself (raw_object_key IS NULL — e.g. the 2026-08-01 House
    // transient-403 incident) must restart from filing.new with chamber +
    // sourceUrl, or the fetch stage never re-runs.
    const params: SqlParam[] = [];
    let where = "ingest_status = 'error'";
    if (chamber) {
      where += ' AND chamber = ?';
      params.push(chamber);
    }
    params.push(limit);
    const rows = await all<{ doc_id: string; chamber: string | null; source_url: string | null; raw_object_key: string | null }>(
      c.env.DB,
      `SELECT doc_id, chamber, source_url, raw_object_key FROM filings WHERE ${where} ORDER BY first_seen_at ASC LIMIT ?`,
      params,
    );
    if (body.dryRun === true) {
      return c.json({ ok: true, dryRun: true, matched: rows.length });
    }
    let enqueued = 0;
    let skipped = 0;
    const errors: string[] = [];
    for (const row of rows) {
      try {
        if (row.raw_object_key) {
          await c.env.INGEST_QUEUE.send({ type: 'filing.fetched', docId: row.doc_id });
        } else if (row.source_url && row.chamber && ['house', 'senate', 'executive'].includes(row.chamber)) {
          await c.env.INGEST_QUEUE.send({
            type: 'filing.new',
            docId: row.doc_id,
            chamber: row.chamber as 'house' | 'senate' | 'executive',
            sourceUrl: row.source_url,
          });
        } else {
          skipped += 1; // no source URL to refetch from — nothing safe to enqueue
          continue;
        }
        enqueued += 1;
      } catch (err) {
        errors.push(`${row.doc_id}: ${(err as Error).message}`);
        if (errors.length >= 5) break; // queue outage — bail early; re-run is safe
      }
    }
    return c.json({ ok: true, matched: rows.length, enqueued, skipped, errors });
  });

  // --- POST /filings-hygiene ------------------------------------------------
  // #1576 + #1574.  Default is dry-run.  Writes require apply:true AND
  // dryRun !== true.  Probe delete is exact-doc_id and refuses if any
  // transaction rows exist.  Never deletes a real filing.
  // Body (all optional):
  //   { apply?: boolean, dryRun?: boolean, deleteProbe?: boolean,
  //     reconcileDesync?: boolean, limit?: number }
  r.post('/filings-hygiene', async (c) => {
    let body: Record<string, unknown> = {};
    try {
      const raw = await c.req.text();
      if (raw) body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const apply = body.apply === true && body.dryRun !== true;
    let limit = typeof body.limit === 'number' && body.limit > 0 ? Math.floor(body.limit) : 600;
    if (limit > 2000) limit = 2000;
    const result = await runFilingsHygiene(c.env, {
      apply,
      deleteProbe: body.deleteProbe !== false,
      reconcileDesync: body.reconcileDesync !== false,
      limit,
    });
    return c.json({ ok: true, dryRun: !apply, ...result });
  });


  // --- POST /sweep-already-published --------------------------------------
  // On-demand trigger for sweepAlreadyPublishedReviewRows. The hourly
  // autonomy-sweeps lane already runs this, but deadline abort / lock races
  // can leave terminal-with-live orphans in the review queue (observed
  // 2026-09-25: 16 form_chrome_only + 13 agreement_cascade, all with live
  // txs + publish decisions; reject/confirm unsafe). Body (all optional):
  //   { apply?: boolean, dryRun?: boolean, includeAgreementCascade?: boolean,
  //     limit?: number }
  // Default is dry-run. Writes require apply:true AND dryRun !== true.
  r.post('/sweep-already-published', async (c) => {
    let body: Record<string, unknown> = {};
    try {
      const raw = await c.req.text();
      if (raw) body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const apply = body.apply === true && body.dryRun !== true;
    const includeAgreementCascade = body.includeAgreementCascade === true;
    let limit = typeof body.limit === 'number' && body.limit > 0 ? Math.floor(body.limit) : 500;
    if (limit > 2000) limit = 2000;
    const candidates = await listAlreadyPublishedReviewCandidates(c.env, {
      limit,
      includeAgreementCascade,
    });
    if (!apply) {
      return c.json({
        ok: true,
        dryRun: true,
        includeAgreementCascade,
        candidateCount: candidates.length,
        candidates,
      });
    }
    const result = await sweepAlreadyPublishedReviewRows(c.env, {
      limit,
      includeAgreementCascade,
    });
    return c.json({
      ok: true,
      dryRun: false,
      includeAgreementCascade,
      candidateCount: candidates.length,
      candidates,
      ...result,
    });
  });

  // --- GET /scanned-filings/pending ---------------------------------------
  // Returns pending scanned_pdf filings for local vision worker processing.
  // Includes:
  //   • extraction_pending_local / classified (wait window no longer gates —
  //     expired waits used to hide the whole backlog once kimi/local workers
  //     stalled)
  //   • needs_review extract_empty / ocr_unusable scanned PDFs (server_cpu
  //     letterhead floods — reclaim for local vision, not human review)
  //   • error + stored raw + no live txs (honest reject of garbage OCR must
  //     still be re-claimable by Mac/server_cpu vision — 2026-08-10 drain)
  //   • ?worker=local (the Mac Grok-CLI worker) additionally reclaims EVERY
  //     unresolved needs_review scan with stored raw bytes — cascade
  //     disagreements, extraction_row_limit garbage, low-confidence flags —
  //     because local vision is free (subscription) and strictly better than
  //     the server_cpu OCR that created those flags. Docs already submitted
  //     (`local_vision_submitted`) stay out so the worker cannot re-OCR the
  //     same 17/93-row extracts forever (2026-08-21). The Coolify scan-cpu
  //     worker (no param / worker=server_cpu) keeps the conservative reason
  //     set so it never re-generates garbage on hard scans.
  // Skips published live-transaction docs and local_vision_exhausted parks
  // (worker retry-cap terminal class — #1575 vision-spend bucket) so workers
  // don't burn subscription quota on no-ops.
  //
  // STORED COPY ONLY (2026-08-10): requires raw_object_key. Workers must pull
  // bytes via GET /filings/:docId/raw — never re-hit Clerk/eFD/OGE from the
  // Mac/residential IP. source_url is metadata only.
  r.get('/scanned-filings/pending', async (c) => {
    try {
      const worker = typeof c.req.query('worker') === 'string'
        ? c.req.query('worker').trim().toLowerCase()
        : '';
      // Local (Mac Grok-CLI) workers get the broad reclaim set; the CPU OCR
      // worker keeps the conservative reasons so it cannot re-generate
      // garbage on hard scans it already failed.
      const localWorker = worker.includes('local');
      const reviewReasonMatch = localWorker
        ? `rq.reason NOT LIKE '%local_vision_exhausted%'
           AND rq.reason NOT LIKE '%local_vision_submitted%'`
        : `(
             rq.reason LIKE '%extract_empty%'
             OR rq.reason LIKE '%no_transactions_extracted%'
             OR rq.reason LIKE '%ocr_unusable%'
             OR rq.reason LIKE '%form_chrome%'
           )
           AND rq.reason NOT LIKE '%local_vision_exhausted%'
           AND rq.reason NOT LIKE '%local_vision_submitted%'`;
      const rows = await all<{
        doc_id: string;
        chamber: string | null;
        filing_type: string | null;
        filed_date: string | null;
        source_url: string | null;
        raw_object_key: string;
        ingest_status: string;
        doc_kind: string;
        local_wait_expires_at: string | null;
        first_seen_at: string;
      }>(
        c.env.DB,
        `SELECT f.doc_id, f.chamber, f.filing_type, f.filed_date, f.source_url, f.raw_object_key,
                f.ingest_status, f.doc_kind, f.local_wait_expires_at, f.first_seen_at
           FROM filings f
          WHERE f.doc_kind = 'scanned_pdf'
            AND f.raw_object_key IS NOT NULL
            AND TRIM(f.raw_object_key) != ''
            AND (
              f.ingest_status IN ('extraction_pending_local', 'classified', 'error')
              OR (
                f.ingest_status = 'needs_review'
                AND EXISTS (
                  SELECT 1 FROM review_queue rq
                   WHERE rq.doc_id = f.doc_id
                     AND rq.resolved = 0
                     AND ${reviewReasonMatch}
                )
              )
            )
            AND (f.error IS NULL OR f.error NOT LIKE 'local_vision_exhausted%')
            AND NOT EXISTS (
              SELECT 1 FROM review_queue rq
               WHERE rq.doc_id = f.doc_id
                 AND rq.resolved = 0
                 AND rq.reason LIKE '%local_vision_exhausted%'
            )
            -- Never advertise a doc whose result the ingest path will throw away.
            --
            -- normalize() treats ANY resolved review row as authoritative and
            -- returns {published:false, needsReview:false} without persisting
            -- (extraction/normalizer.ts, "a completed decision is authoritative").
            -- This used to exclude only resolution_kind='published', so docs
            -- resolved as rejected/verified_empty stayed in this list forever —
            -- and 1,081 rows were closed as agreement_cascade_unresolved during
            -- an OpenRouter budget outage, i.e. closed by a spend artifact rather
            -- than a judgement about the document.
            --
            -- Cost of the old predicate, measured 2026-08-12: scan-cpu-worker sat
            -- at 283% CPU (3 of 8 cores) continuously re-OCRing those documents
            -- and logging "published=False needsReview=False" on every submit —
            -- full OCR work, every result discarded, forever.
            AND NOT EXISTS (
              SELECT 1 FROM review_queue rq
               WHERE rq.doc_id = f.doc_id
                 AND rq.resolved = 1
            )
            -- Stamp lives on the review row even when ingest_status is still
            -- classified / extraction_pending_local / error (honest empty
            -- noRows never used to leave needs_review, so those 1-pagers
            -- stayed on this list and the Mac worker re-OCR'd them all day).
            AND NOT EXISTS (
              SELECT 1 FROM review_queue rq
               WHERE rq.doc_id = f.doc_id
                 AND rq.reason LIKE '%local_vision_submitted%'
            )
            AND NOT EXISTS (
              SELECT 1 FROM transactions tx
               WHERE tx.doc_id = f.doc_id AND tx.deprecated_at IS NULL
            )
          ORDER BY
            CASE f.ingest_status
              WHEN 'extraction_pending_local' THEN 0
              WHEN 'classified' THEN 1
              WHEN 'error' THEN 2
              ELSE 3
            END,
            f.first_seen_at DESC
          LIMIT 50`,
      );
      const filings = rows.map((row) => ({
        ...row,
        // Absolute path under /api/admin — workers prepend CONGRESS_TRADE_API_URL.
        stored_document_url: `/api/admin/filings/${encodeURIComponent(row.doc_id)}/raw`,
      }));
      return c.json({ ok: true, count: filings.length, filings });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  // --- GET /filings/:docId/raw --------------------------------------------
  // Serve the durable R2/object-store bytes for a filing. Admin-auth only.
  // NEVER redirects to Clerk/eFD/OGE — workers and ops must use this so
  // residential egress does not re-hit primary sources (IP reputation +
  // consistency with the copy used for reviews).
  // PDF and HTML (and any other stored content-type) are returned as-is.
  r.get('/filings/:docId/raw', async (c) => {
    const docId = c.req.param('docId');
    if (!docId?.trim()) return c.json({ error: 'docId is required' }, 400);
    try {
      const filingRow = await get<{ raw_object_key: string | null; source_url: string | null }>(
        c.env.DB,
        `SELECT raw_object_key, source_url FROM filings WHERE doc_id = ?`,
        [docId],
      );
      if (!filingRow?.raw_object_key) {
        return c.json({
          error: 'stored copy not available',
          docId,
          detail: 'filings.raw_object_key is null — fetch stage has not stored this document yet',
        }, 404);
      }
      const obj = await c.env.RAW_FILES.get(filingRow.raw_object_key);
      if (!obj) {
        return c.json({
          error: 'stored copy missing from object store',
          docId,
          rawObjectKey: filingRow.raw_object_key,
        }, 404);
      }
      const contentType = obj.httpMetadata?.contentType || 'application/pdf';
      const headers: Record<string, string> = {
        'content-type': contentType,
        'content-disposition': 'inline',
        'cache-control': 'private, max-age=300',
        'x-content-type-options': 'nosniff',
        'x-congress-trade-source': 'stored-raw',
        'x-congress-trade-doc-id': docId,
      };
      if (contentType.toLowerCase().includes('html')) {
        headers['content-security-policy'] = 'sandbox';
        const rawText = typeof (obj as any).text === 'function'
          ? await (obj as any).text()
          : await new Response(obj.body).text();
        const enhanced = enhanceSenateHtmlDocument(rawText, docId, filingRow.source_url);
        return new Response(enhanced, { headers });
      }
      return new Response(obj.body, { headers });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isObjectStoreAuthError(message)) {
        return c.json({
          error: 'stored copy unavailable',
          detail: 'object store rejected credentials',
        }, 503);
      }
      return c.json({ error: 'stored copy read failed' }, 500);
    }
  });

  // --- POST /local-worker/heartbeat ----------------------------------------
  // Updates local vision worker heartbeat timestamp.
  r.post('/local-worker/heartbeat', async (c) => {
    let body: Record<string, unknown> = {};
    try {
      const raw = await c.req.text();
      if (raw) body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const workerId = typeof body.workerId === 'string' && body.workerId.trim() ? body.workerId.trim() : 'local_mac_1';
    const statusJson = body.statusJson ? JSON.stringify(body.statusJson) : null;
    const nowIso = new Date().toISOString();
    try {
      await run(
        c.env.DB,
        `INSERT INTO local_worker_heartbeat (worker_id, last_heartbeat_at, status_json)
         VALUES (?, ?, ?)
         ON CONFLICT(worker_id) DO UPDATE SET
           last_heartbeat_at = excluded.last_heartbeat_at,
           status_json = excluded.status_json`,
        [workerId, nowIso, statusJson],
      );
      return c.json({ ok: true, workerId, lastHeartbeatAt: nowIso });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // --- POST /local-vision-park --------------------------------------------
  // Terminal park after the Mac/server local-vision lane exhausts retries on a
  // doc (max attempts / zero-row / hard failure). Honest, visible class —
  // NOT a fake review "rejected" resolution.
  //
  // Side effects:
  //   • filings.ingest_status = needs_review
  //   • filings.error = local_vision_exhausted: attempts=N; last=...
  //   • unresolved review_queue.reason includes local_vision_exhausted
  //     (+ scanned_pdf_vision_spend so it lands in the #1575 owner-spend bucket)
  //   • does NOT set resolved=1 — keeps review_resolution_integrity clean
  //   • pending query excludes these so workers stop re-burning quota
  r.post('/local-vision-park', async (c) => {
    let body: Record<string, unknown> = {};
    try {
      const raw = await c.req.text();
      if (raw) body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const docId = typeof body.docId === 'string' ? body.docId.trim() : '';
    if (!docId) return c.json({ error: 'docId is required' }, 400);

    const attemptsRaw = body.attempts;
    const attempts =
      typeof attemptsRaw === 'number' && Number.isFinite(attemptsRaw)
        ? Math.max(0, Math.floor(attemptsRaw))
        : typeof attemptsRaw === 'string' && Number.isFinite(Number(attemptsRaw))
          ? Math.max(0, Math.floor(Number(attemptsRaw)))
          : null;
    const lastError =
      typeof body.lastError === 'string' && body.lastError.trim()
        ? body.lastError.trim().slice(0, 500)
        : 'unknown';
    const workerId =
      typeof body.workerId === 'string' && body.workerId.trim()
        ? body.workerId.trim().slice(0, 120)
        : 'local_mac_1';
    const extractor =
      typeof body.extractor === 'string' && body.extractor.trim()
        ? body.extractor.trim().slice(0, 120)
        : null;

    // Reason class for pending exclusion + #1575 spend bucket. Never mark
    // resolved — integrity check fires on resolved rows missing a reason, and
    // owner still needs to decide paid vision for these docs.
    const reason = 'local_vision_exhausted,scanned_pdf_vision_spend';
    const errorDetail =
      `local_vision_exhausted: attempts=${attempts ?? '?'} last=${lastError} worker=${workerId}`;
    const nowIso = new Date().toISOString();
    const payload = JSON.stringify({
      kind: 'local_vision_exhausted',
      attempts,
      lastError,
      workerId,
      extractor,
      parkedAt: nowIso,
    });

    try {
      const filingRow = await get<{ doc_id: string; ingest_status: string | null }>(
        c.env.DB,
        `SELECT doc_id, ingest_status FROM filings WHERE doc_id = ?`,
        [docId],
      );
      if (!filingRow) {
        return c.json({ error: `Filing ${docId} not found` }, 404);
      }

      await run(
        c.env.DB,
        `UPDATE filings
            SET ingest_status = 'needs_review',
                error = ?,
                local_wait_expires_at = NULL,
                extractor = COALESCE(?, extractor)
          WHERE doc_id = ?`,
        [errorDetail.slice(0, 1000), extractor, docId],
      );

      // Prefer updating an open review row; insert if none. Never touch resolved=1.
      const open = await get<{ doc_id: string }>(
        c.env.DB,
        `SELECT doc_id FROM review_queue WHERE doc_id = ? AND resolved = 0 LIMIT 1`,
        [docId],
      );
      if (open) {
        await run(
          c.env.DB,
          `UPDATE review_queue
              SET reason = ?,
                  payload = ?
            WHERE doc_id = ? AND resolved = 0`,
          [reason, payload, docId],
        );
      } else {
        const insertResult = await run(
          c.env.DB,
          `INSERT OR IGNORE INTO review_queue (doc_id, reason, payload, created_at, resolved)
           VALUES (?, ?, ?, ?, 0)`,
          [docId, reason, payload, nowIso],
        );
        if ((insertResult.meta?.changes ?? 0) > 0) {
          void notifyReviewQueuePublisher(c.env, {
            docId,
            reason,
            kind: 'insert',
            at: nowIso,
          });
        }
        // If a resolved row already owns the PK, leave it alone (do not reopen).
        // Integrity prefers not resurrecting closed reviews.
      }

      try {
        await run(
          c.env.DB,
          `INSERT OR IGNORE INTO ingestion_decisions
             (id, doc_id, action, source, actor, reason, payload, transaction_ids, created_at)
           VALUES (?, ?, 'local_vision_exhausted', 'local_worker', ?, ?, ?, '[]', ?)`,
          [
            `decision:local_vision_exhausted:${docId}:${nowIso}`,
            docId,
            workerId,
            reason,
            payload,
            nowIso,
          ],
        );
      } catch {
        // decisions table may lag in some local fixtures — park still lands.
      }

      // local_mac_1 is supplemental only.  After local exhaustion, hand the
      // doc to the hosted extraction path instead of leaving it parked.
      let hostedFallbackEnqueued = false;
      try {
        await c.env.INGEST_QUEUE.send({ type: 'filing.extracted', docId });
        hostedFallbackEnqueued = true;
      } catch (err) {
        console.warn('local-vision-park: hosted fallback enqueue failed', docId, (err as Error).message);
      }

      return c.json({
        ok: true,
        docId,
        reason,
        attempts,
        lastError,
        previousStatus: filingRow.ingest_status,
        ingestStatus: 'needs_review',
        hostedFallbackEnqueued,
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // --- POST /ingest-local-vision ------------------------------------------
  // Receives extracted transactions from a local/server vision worker.
  // source: 'local_mac' (Mac Vision / kimi-cli) or 'server_cpu' (Coolify CPU pipeline).
  // Normalizes and persists transactions; filing → extracted / needs_review / persisted.
  r.post('/ingest-local-vision', async (c) => {
    let body: Record<string, unknown> = {};
    try {
      const raw = await c.req.text();
      if (raw) body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const docId = typeof body.docId === 'string' ? body.docId.trim() : undefined;
    if (!docId) {
      return c.json({ error: 'docId is required' }, 400);
    }
    const parsedTx = Array.isArray(body.transactions) ? (body.transactions as ParsedTx[]) : [];
    const extractor = typeof body.extractor === 'string' ? body.extractor : 'mac_vision_v1';
    const workerId = typeof body.workerId === 'string' ? body.workerId : 'local_mac_1';
    // Mac worker → local_mac; Coolify CPU worker → server_cpu; default local_mac for back-compat.
    const rawSource = typeof body.source === 'string' ? body.source.trim() : '';
    const txSource: TxSource =
      rawSource === 'server_cpu' || extractor.startsWith('server_cpu')
        ? 'server_cpu'
        : 'local_mac';

    try {
      const existingReview = await get<{ reason: string | null; payload: string | null }>(
        c.env.DB,
        `SELECT reason, payload FROM review_queue WHERE doc_id = ? AND resolved = 0`,
        [docId],
      );
      if (
        existingReview
        && storedReviewBlocksSmallerVisionSubmit(
          existingReview.reason,
          existingReview.payload,
          parsedTx.length,
          parsedTx.filter((tx) => typeof tx.txDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(tx.txDate)).length,
        )
      ) {
        if (txSource === 'local_mac') {
          await stampLocalVisionSubmitted(c.env, docId);
        }
        return c.json({
          ok: true,
          docId,
          published: false,
          needsReview: true,
          skipped: 'smaller_than_stored_review',
          txCount: parsedTx.length,
        });
      }

      const noRows = body.noRows === true;
      if (noRows && parsedTx.length === 0 && txSource === 'local_mac') {
        await stampLocalVisionSubmitted(c.env, docId, 'nothing_to_report');
        return c.json({
          ok: true,
          docId,
          published: false,
          needsReview: true,
          noRows: true,
          txCount: 0,
        });
      }

      const filingRow = await loadFilingRow(c.env, docId);
      if (!filingRow) {
        return c.json({ error: `Filing ${docId} not found` }, 404);
      }
      const filing: Filing = {
        docId: filingRow.doc_id,
        chamber: (filingRow.chamber as Chamber) ?? 'house',
        filerId: filingRow.filer_id,
        filingType: filingRow.filing_type ?? 'P',
        filedDate: filingRow.filed_date,
        sourceUrl: filingRow.source_url ?? '',
        rawObjectKey: filingRow.raw_object_key,
        ingestStatus: (filingRow.ingest_status as Filing['ingestStatus']) ?? 'classified',
        docKind: (filingRow.doc_kind as DocKind) ?? 'unknown',
        extractor: filingRow.extractor,
        modelVersion: filingRow.model_version,
        confidence: filingRow.confidence,
        firstSeenAt: filingRow.first_seen_at ?? new Date().toISOString(),
        sourceUpdatedAt: filingRow.source_updated_at,
        error: filingRow.error,
      };

      const result = await normalize(c.env, filing, parsedTx, {
        extractor,
        modelVersion: workerId,
        source: txSource,
      });

      if (txSource === 'local_mac' && result.needsReview) {
        await stampLocalVisionSubmitted(c.env, docId);
      }

      return c.json({
        ok: true,
        docId,
        published: result.published,
        needsReview: result.needsReview,
        minConfidence: result.minConfidence,
        txCount: result.transactions.length,
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // --- POST /reprocess ----------------------------------------------------
  // Re-evaluate already-ingested filings under the CURRENT normalizer rubric,
  // without re-fetching from the source (re-extracts from the stored R2 raw).
  // Two cases per filing:
  //   • already in the feed (primary rows exist): recompute confidence and
  //     UPDATE those rows IN PLACE — same id + cursor_seq, so NO duplicate rows
  //     and NO re-fired delivery webhooks. Matched in cursor_seq order (parsing
  //     the same bytes is deterministic); a row-count mismatch is skipped, never
  //     guessed.
  //   • stuck in review (no primary rows): if it now clears the bar, persist +
  //     deliver it (first-time delivery, which is correct) and mark its
  //     review_queue row resolved. If it still fails, it's left in review.
  //   { chamber?: 'house'|'senate'|'executive', limit?: number, dryRun?: boolean }

  r.get('/debug-extract/:id', async (c) => {
    try {
      const filing = await loadFilingRow(c.env, c.req.param("id"));
      if (!filing) return c.json({ error: "no filing" });
      if (!filing.raw_object_key) return c.json({ error: "no rawObjectKey", filing });
      const obj = await c.env.RAW_FILES.get(filing.raw_object_key);
      if (!obj) return c.json({ error: "no r2 object", filing });
      const extracted = await extractParsed(c.env, c.req.param("id"));
      return c.json(extracted);
    } catch (e) {
      return c.json({ error: (e as Error).message });
    }
  });

  // --- GET /debug-raw-text/:id ----------------------------------------------
  // Diagnostic-only, read-only: fetches the filing's raw R2 bytes and, for PDFs,
  // runs the SAME unpdf.extractText({mergePages:true}) call every text-layer
  // extractor (textPdf/ogeText) uses, returning a bounded snippet. Exists to
  // debug "extractor picked correctly but yielded 0 rows" cases (a stored R2
  // copy that differs from the live source, an unexpected OCR text layer,
  // etc.) without guessing from ExtractorResult.raw, which extractParsed()
  // deliberately drops before returning (see /debug-extract/:id above).
  // Query: ?limit=<chars> (default 4000, max 20000).
  r.get('/debug-raw-text/:id', async (c) => {
    try {
      const filing = await loadFilingRow(c.env, c.req.param('id'));
      if (!filing) return c.json({ error: 'no filing' });
      if (!filing.raw_object_key) return c.json({ error: 'no rawObjectKey', filing });
      const obj = await c.env.RAW_FILES.get(filing.raw_object_key);
      if (!obj) return c.json({ error: 'no r2 object', filing });
      const bytes = await obj.arrayBuffer();
      const limitParam = Number(c.req.query('limit'));
      const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 20000) : 4000;
      const isPdf = new Uint8Array(bytes.slice(0, 5)).every(
        (b, i) => b === [0x25, 0x50, 0x44, 0x46, 0x2d][i],
      );
      if (!isPdf) {
        const text = new TextDecoder('utf-8').decode(new Uint8Array(bytes));
        return c.json({ docId: filing.doc_id, byteLength: bytes.byteLength, isPdf: false, text: text.slice(0, limit) });
      }
      const { getDocumentProxy, extractText } = await import('unpdf');
      const pdf = await getDocumentProxy(new Uint8Array(bytes.slice(0)));
      const { text } = await extractText(pdf, { mergePages: true });
      const merged = typeof text === 'string' ? text : (text as string[]).join('\n');
      return c.json({
        docId: filing.doc_id,
        byteLength: bytes.byteLength,
        isPdf: true,
        pageCount: typeof pdf.numPages === 'number' ? pdf.numPages : null,
        textLength: merged.length,
        text: merged.slice(0, limit),
      });
    } catch (e) {
      return c.json({ error: (e as Error).message });
    }
  });

  r.get('/debug-members', async (c) => {
    try {
      const members = await all(c.env.DB, "SELECT bioguide_id, full_name, chamber FROM filers WHERE full_name LIKE '%Manual%' OR full_name LIKE '%manual%' LIMIT 10", []);
      return c.json(members);
    } catch (e) {
      return c.json({ error: (e as Error).message });
    }
  });
  r.post('/reprocess', async (c) => {
    let body: Record<string, unknown> = {};
    try {
      const raw = await c.req.text();
      if (raw) body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const chamber = body.chamber === undefined ? 'house' : body.chamber;
    if (chamber !== 'house' && chamber !== 'senate' && chamber !== 'executive') {
      return c.json({ error: "chamber must be 'house', 'senate', or 'executive'" }, 400);
    }
    const dryRun = body.dryRun === true;
    const forceVision = body.forceVision === true;
    let limit = typeof body.limit === 'number' && body.limit > 0 ? Math.floor(body.limit) : 500;
    if (limit > 2000) limit = 2000;

    // Filings for this chamber that we can re-extract (have a raw R2 object).
    let filings: Array<{ doc_id: string }>;
    if (Array.isArray(body.docIds) && body.docIds.length > 0) {
      const ids = body.docIds.filter((x): x is string => typeof x === 'string').slice(0, limit);
      filings = ids.map(id => ({ doc_id: id }));
    } else {
      filings = await all<{ doc_id: string }>(
        c.env.DB,
        `SELECT doc_id FROM filings
          WHERE chamber = ? AND raw_object_key IS NOT NULL
          ORDER BY first_seen_at DESC
          LIMIT ?`,
        [chamber, limit],
      );
    }

    const summary = {
      chamber,
      dryRun,
      forceVision,
      filingsScanned: 0,
      rowsUpdatedInPlace: 0, // already-in-feed rows whose confidence changed
      filingsPromoted: 0, //    review -> feed (now clears the bar)
      rowsPromoted: 0,
      filingsStillInReview: 0,
      settledZeroRow: 0, //      zero-row reads normalize() settled (empty/unreadable)
      skippedNoExtract: 0,
      skippedCountMismatch: 0,
      errors: [] as string[],
    };

    for (const { doc_id } of filings) {
      summary.filingsScanned += 1;
      let extracted;
      try {
        extracted = await extractParsed(c.env, doc_id, undefined, { forceVision });
      } catch (err) {
        summary.errors.push(`${doc_id}: extract failed: ${(err as Error).message}`);
        continue;
      }
      if (!extracted || extracted.transactions.length === 0) {
        // An executive zero-row read carrying a parse disposition is a
        // terminal signal, not "no extract": normalize() closes the filing
        // verified_empty / ocr_unusable (or stages recovered rows) instead of
        // leaving the row parked for the next reprocess pass.
        if (
          !dryRun
          && extracted?.filing.chamber === 'executive'
          && extracted.parseDisposition
        ) {
          try {
            const norm = await normalize(c.env, extracted.filing, [], {
              extractor: extracted.extractor,
              modelVersion: extracted.modelVersion,
              sourceText: extracted.raw || null,
              parseDisposition: extracted.parseDisposition,
            });
            // A settled zero-row read is a success, not a skip: counting it
            // skippedNoExtract and pushing a "no extract" error would report
            // ok:false for a pass that closed the filing.  But normalize()
            // declines the terminal close without throwing when the close is
            // refused (candidates staged for review instead): that filing is
            // still in review, not settled.
            if (norm.needsReview) {
              summary.filingsStillInReview += 1;
            } else {
              // A concurrent revision can make BOTH the close and the
              // routeToReview CAS lose: normalize() then returns
              // needsReview:false without settling anything.  Count settled
              // only when the review row actually resolved.
              const review = await get<{ resolved: number }>(
                c.env.DB,
                'SELECT resolved FROM review_queue WHERE doc_id = ?',
                [doc_id],
              ).catch(() => null);
              if (review?.resolved === 1) summary.settledZeroRow += 1;
              else summary.filingsStillInReview += 1;
            }
            continue;
          } catch (err) {
            summary.errors.push(`${doc_id}: zero-row normalize failed: ${(err as Error).message}`);
          }
        }
        summary.skippedNoExtract += 1; summary.errors.push(`${doc_id}: no extract, extractor=${extracted?.extractor}, txCount=${extracted?.transactions?.length}`);
        continue;
      }

      const flagged = await recomputeTransactions(c.env, extracted.filing, extracted.transactions);
      const newMin = Math.min(...flagged.map((f) => f.tx.confidence));
      const hasHardFailure = hasHardFailureFlags(flagged);

      const existing = await all<{ id: string }>(
        c.env.DB,
        `SELECT id FROM transactions WHERE doc_id = ? AND source = 'primary' ORDER BY cursor_seq ASC`,
        [doc_id],
      );

      if (existing.length > 0) {
        // Already in the feed: update confidence (+ snapped amount / resolved
        // ticker) in place. Never touch id or cursor_seq -> no re-delivery.
        if (existing.length !== flagged.length) {
          summary.skippedCountMismatch += 1;
          continue;
        }
        if (!dryRun) {
          for (let i = 0; i < existing.length; i++) {
            const { tx } = flagged[i];
            await run(
              c.env.DB,
              `UPDATE transactions
                  SET confidence = ?, amount_min = ?, amount_max = ?, est_value = ?, ticker = ?
                WHERE id = ?`,
              [
                tx.confidence,
                tx.amountMin,
                tx.amountMax,
                estimateTransactionValue(tx.amountMin, tx.amountMax),
                tx.ticker,
                existing[i].id,
              ],
            );
          }
          await run(c.env.DB, 'UPDATE filings SET confidence = ? WHERE doc_id = ?', [
            newMin,
            doc_id,
          ]);
        }
        summary.rowsUpdatedInPlace += flagged.length;
        continue;
      }

      // Not in the feed yet (sitting in review / error). Does it clear the bar now?
      const passesNow = newMin >= CONFIDENCE_THRESHOLD && !hasHardFailure;
      if (passesNow) {
        let promoted = true;
        if (!dryRun) {
          // normalize() atomically persists + resolves only if this re-read's
          // captured review revision is still current.
          const normalized = await normalize(c.env, extracted.filing, extracted.transactions, {
            extractor: extracted.extractor,
            modelVersion: extracted.modelVersion ?? null,
          });
          promoted = normalized.published;
        }
        if (promoted) {
          summary.filingsPromoted += 1;
          summary.rowsPromoted += flagged.length;
        } else {
          summary.filingsStillInReview += 1;
        }
      } else {
        summary.filingsStillInReview += 1;
      }
    }

    return c.json({ ok: summary.errors.length === 0, ...summary });
  });

  // --- POST /bakeoff ------------------------------------------------------
  // Run N House PTR PDFs through several vision models (Gemini/OpenAI/Anthropic/Mistral/xAI)
  // and report row recall, failures, latency, and cross-model agreement so we
  // can pick the best extractor before reprocessing the whole corpus. Read-only:
  // it never writes transactions. Body: { n?, models?: [{provider,model}], docIds? }.
  r.post('/bakeoff', async (c) => {
    let body: Record<string, unknown> = {};
    try {
      const raw = await c.req.text();
      if (raw) body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    // Candidate lineup (default provider-neutral set, overridable).
    let candidates: BakeoffCandidate[] = DEFAULT_CANDIDATES;
    if (Array.isArray(body.models)) {
      const valid: Provider[] = ['gemini', 'openai', 'anthropic', 'mistral', 'xai', 'llamaparse', 'openrouter'];
      const parsed: BakeoffCandidate[] = [];
      for (const m of body.models) {
        const o = m as { provider?: unknown; model?: unknown };
        if (!valid.includes(o.provider as Provider) || typeof o.model !== 'string') {
          return c.json({ error: 'each model must be {provider:gemini|openai|anthropic|mistral|xai|llamaparse|openrouter, model:string}' }, 400);
        }
        const candidate = { provider: o.provider as Provider, model: o.model };
        if (isRetiredDisclosureCandidate(candidate)) {
          return c.json({ error: 'GPT-4o is retired for new disclosure extraction; use gpt-5.6-terra, gpt-5.6-luna, or gpt-5.6-sol' }, 400);
        }
        parsed.push(candidate);
      }
      if (parsed.length === 0) return c.json({ error: 'models must be a non-empty array' }, 400);
      candidates = parsed;
    }

    let n = typeof body.n === 'number' && body.n > 0 ? Math.floor(body.n) : 20;
    if (n > 50) n = 50; // cap fan-out (n docs * candidates LLM calls)

    const rawChamber = body.chamber;
    const chamber = rawChamber === 'senate' ? 'senate'
      : rawChamber === 'executive' ? 'executive'
      : rawChamber == null || rawChamber === 'house' ? 'house'
      : null;
    if (!chamber) {
      return c.json({ error: "chamber must be 'house', 'senate' or 'executive'" }, 400);
    }

    // Pick the documents: explicit docIds, else the most recent PTRs with a raw PDF for the given chamber.
    let docs: Array<{ doc_id: string; raw_object_key: string | null }>;
    if (Array.isArray(body.docIds) && body.docIds.length > 0) {
      const ids = body.docIds.filter((x): x is string => typeof x === 'string').slice(0, n);
      docs = [];
      for (const id of ids) {
        const row = await get<{ doc_id: string; raw_object_key: string | null }>(
          c.env.DB,
          'SELECT doc_id, raw_object_key FROM filings WHERE doc_id = ?',
          [id],
        );
        if (row) docs.push(row);
      }
    } else {
      docs = await all<{ doc_id: string; raw_object_key: string | null }>(
        c.env.DB,
        `SELECT doc_id, raw_object_key FROM filings
          WHERE chamber = ? AND raw_object_key IS NOT NULL
          ORDER BY first_seen_at DESC
          LIMIT ?`,
        [chamber, n],
      );
    }

    // Only docs with a stored raw PDF actually reach runCandidateOnDoc below;
    // filter before charging the cap so a request full of explicit docIds with
    // no raw_object_key can't burn the whole daily quota on rows that will be
    // skipped without calling any provider.
    docs = docs.filter((d) => d.raw_object_key);

    if (docs.length === 0) {
      return c.json({ error: `no ${chamber} filings with a stored PDF were found to test` }, 404);
    }

    // Daily spend guardrail. A bake-off fans out (docs × candidates) external
    // vision-model calls; an admin running n=50 with the 6-model default fires
    // ~300 paid calls in one request with no metering. Cap the per-day total so
    // a single request (or a busy day) can't run up an unbounded LLM bill.
    // Approximate (KV fixed window); raise BAKEOFF_DAILY_CALL_CAP to lift it.
    // Only candidates with a configured API key actually reach a provider
    // (runCandidateOnDoc below short-circuits to an "API key not configured"
    // result otherwise) — charge the cap for those only, so an environment
    // with just one or two providers configured doesn't exhaust the daily
    // budget on calls that were never going to happen.
    const candidateInvocationKeys = await Promise.all(
      candidates.map((candidate) => keyFor(c.env, candidate.provider)),
    );
    const configuredCount = candidateInvocationKeys.filter(Boolean).length;
    const plannedCalls = docs.length * configuredCount;
    const dailyCap =
      Number((c.env as { BAKEOFF_DAILY_CALL_CAP?: string }).BAKEOFF_DAILY_CALL_CAP ?? '200') || 200;
    const capDay = new Date().toISOString().slice(0, 10);
    const capKey = `bakeoff:calls:${capDay}`;
    let usedToday = 0;
    try {
      usedToday = parseInt((await c.env.CONFIG_KV.get(capKey)) || '0', 10) || 0;
    } catch {
      /* fail open on KV read error */
    }
    if (usedToday + plannedCalls > dailyCap) {
      return c.json(
        {
          error: 'bake-off daily call cap reached',
          plannedCalls,
          usedToday,
          dailyCap,
          hint: 'reduce n or models, or raise BAKEOFF_DAILY_CALL_CAP',
        },
        429,
      );
    }
    try {
      await c.env.CONFIG_KV.put(capKey, String(usedToday + plannedCalls), { expirationTtl: 172800 });
    } catch {
      /* fail open on KV write error */
    }

    // Persist each model's reading by default (set persist:false to skip) so the
    // results land in extraction_runs for the review dashboard + later learning.
    const persist = body.persist !== false;
    const batchId = uuid();
    const nowIso = new Date().toISOString();

    const results: CandidateDocResult[] = [];
    const skipped: string[] = [];
    let persistErrors = 0;
    for (const { doc_id, raw_object_key } of docs) {
      if (!raw_object_key) {
        skipped.push(`${doc_id}: no raw_object_key`);
        continue;
      }
      const obj = await c.env.RAW_FILES.get(raw_object_key);
      if (!obj) {
        skipped.push(`${doc_id}: R2 object ${raw_object_key} missing`);
        continue;
      }
      const bytes = await obj.arrayBuffer();
      // Sequential per doc keeps memory + provider rate-limits sane.
      for (const [candidateIndex, candidate] of candidates.entries()) {
        const res = await runCandidateOnDoc(c.env, candidate, doc_id, bytes, {
          apiKey: candidateInvocationKeys[candidateIndex] ?? null,
          skipCache: true,
        });
        results.push(res);
        await pushExtractionTelemetry(c.env, res, 'bakeoff');
        if (persist) {
          try {
            await run(
              c.env.DB,
              `INSERT INTO extraction_runs
                 (id, batch_id, doc_id, provider, model, kind, ok, error, row_count, latency_ms, avg_confidence, result_json, usage_json, created_at)
               VALUES (?, ?, ?, ?, ?, 'bakeoff', ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                uuid(),
                batchId,
                res.docId,
                res.provider,
                res.model,
                res.ok ? 1 : 0,
                res.error ?? null,
                res.rowCount,
                res.latencyMs,
                res.avgConfidence,
                JSON.stringify(res.rows ?? []),
                res.usage ? JSON.stringify(res.usage) : null,
                nowIso,
              ],
            );
          } catch {
            // Table may not exist yet (pre-migration) — keep the bake-off read-only-safe.
            persistErrors++;
          }
        }
      }
    }

    // Per-document row-count matrix (model label -> rowCount | "ERR").
    const perDoc: Record<string, Record<string, number | string>> = {};
    for (const r of results) {
      const lbl = `${r.provider}:${r.model}`;
      (perDoc[r.docId] ??= {})[lbl] = r.ok ? r.rowCount : 'ERR';
    }

    return c.json({
      ok: true,
      docsTested: docs.length - skipped.length,
      skipped,
      persisted: persist && persistErrors === 0,
      batchId: persist ? batchId : null,
      models: summarizeModels(candidates, results),
      perDoc,
    });
  });

  // --- POST /batch-submit -------------------------------------------------
  // Kick off an async, ~50%-cheaper batch extraction for a set of docs (backlog
  // reprocessing — NOT the live feed). Body: { provider, model, docIds?, n? }.
  // Returns immediately with a jobId to poll via /batch-status/:jobId.
  r.post('/batch-submit', async (c) => {
    let body: Record<string, unknown> = {};
    try {
      const raw = await c.req.text();
      if (raw) body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if (!isBatchProvider(body.provider)) {
      return c.json({ error: 'provider must be anthropic | openai | mistral | xai' }, 400);
    }
    const provider = body.provider;
    const model =
      typeof body.model === 'string' && body.model
        ? body.model
        : provider === 'anthropic' ? 'claude-sonnet-5'
        : provider === 'openai' ? 'gpt-5.6-terra'
        : provider === 'xai' ? 'grok-4.6'
        : 'mistral-ocr-latest';
    if (isRetiredDisclosureCandidate({ provider, model })) {
      return c.json({ error: 'GPT-4o is retired for new disclosure extraction; use gpt-5.6-terra, gpt-5.6-luna, or gpt-5.6-sol' }, 400);
    }

    let n = typeof body.n === 'number' && body.n > 0 ? Math.floor(body.n) : 50;
    if (n > 200) n = 200;

    let docRows: Array<{ doc_id: string; raw_object_key: string | null; chamber: string | null }>;
    if (Object.prototype.hasOwnProperty.call(body, 'docIds')) {
      if (!Array.isArray(body.docIds)) {
        return c.json({ error: 'docIds must be an array of non-empty strings' }, 400);
      }
      const invalidDocIdCount = body.docIds.filter(
        (value) => typeof value !== 'string' || value.trim().length === 0,
      ).length;
      if (invalidDocIdCount > 0 || body.docIds.length === 0) {
        return c.json({
          error: 'docIds must contain only non-empty strings',
          requestedDocCount: body.docIds.length,
          invalidDocIdCount,
        }, 400);
      }
      const ids = [...new Set(body.docIds.map((value) => (value as string).trim()))].slice(0, n);
      docRows = [];
      for (const id of ids) {
        const row = await get<{ doc_id: string; raw_object_key: string | null; chamber: string | null }>(
          c.env.DB,
          'SELECT doc_id, raw_object_key, chamber FROM filings WHERE doc_id = ?',
          [id],
        );
        if (row) docRows.push(row);
      }
    } else {
      // Default target: the unresolved review backlog (what batch is cheapest for).
      docRows = await all<{ doc_id: string; raw_object_key: string | null; chamber: string | null }>(
        c.env.DB,
        `SELECT f.doc_id, f.raw_object_key, f.chamber
           FROM review_queue rq JOIN filings f ON f.doc_id = rq.doc_id
          WHERE rq.resolved = 0 AND f.raw_object_key IS NOT NULL
          ORDER BY rq.created_at DESC LIMIT ?`,
        [n],
      );
    }

    const docs: BatchDoc[] = [];
    const skipped: string[] = [];
    for (const { doc_id, raw_object_key, chamber } of docRows) {
      if (!raw_object_key) { skipped.push(`${doc_id}: no raw_object_key`); continue; }
      const obj = await c.env.RAW_FILES.get(raw_object_key);
      if (!obj) { skipped.push(`${doc_id}: R2 object missing`); continue; }
      docs.push({
        docId: doc_id,
        chamber: normalizeBatchChamber(chamber, doc_id),
        bytes: await obj.arrayBuffer(),
      });
    }
    if (docs.length === 0) return c.json({ error: 'no documents with a stored PDF to batch', skipped }, 404);

    let providerBatchId: string;
    try {
      providerBatchId = await submitBatch(c.env, provider, model, docs);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }

    const jobId = uuid();
    const accountingPendingSummary = JSON.stringify({
      state: 'accounting_pending',
      accountingProtocol: BATCH_ACCOUNTING_PROTOCOL_VERSION,
    });
    await run(
      c.env.DB,
      `INSERT INTO batch_jobs
         (id, provider, model, provider_batch_id, doc_ids, status, submitted_at, result_summary)
       VALUES (?, ?, ?, ?, ?, 'submitted', ?, ?)`,
      [
        jobId,
        provider,
        model,
        providerBatchId,
        JSON.stringify(docs.map((d) => d.docId)),
        new Date().toISOString(),
        accountingPendingSummary,
      ],
    );
    return c.json({ jobId, provider, model, providerBatchId, docCount: docs.length, skipped, poll: `/api/admin/batch-status/${jobId}` });
  });

  // --- GET /batch-jobs ----------------------------------------------------
  r.get('/batch-jobs', async (c) => {
    let jobs: Array<Record<string, unknown>> = [];
    try {
      const rowsB = await all<Record<string, unknown>>(
        c.env.DB,
        `SELECT id, provider, model, provider_batch_id, doc_ids, status, submitted_at, completed_at, turnaround_ms, result_summary, error
           FROM batch_jobs ORDER BY submitted_at DESC LIMIT 50`,
      );
      jobs = rowsB.map((j) => ({
        ...j,
        doc_ids: typeof j.doc_ids === 'string' ? safeJson(j.doc_ids) : j.doc_ids,
        result_summary: typeof j.result_summary === 'string' ? safeJson(j.result_summary) : j.result_summary,
      }));
    } catch {
      /* table not migrated */
    }
    return c.json({ jobs, count: jobs.length });
  });

  // --- POST /batch-status/:jobId ------------------------------------------
  // Poll the provider; when finished, persist each doc's reading into
  // extraction_runs (kind='batch') and record the real turnaround on batch_jobs.
  r.post('/batch-status/:jobId', async (c) => {
    const jobId = c.req.param('jobId');
    const job = await get<{
      id: string; provider: string; model: string; provider_batch_id: string | null;
      doc_ids: string; status: string; submitted_at: string | null; completed_at: string | null;
      result_summary: string | null;
    }>(
      c.env.DB,
      `SELECT id, provider, model, provider_batch_id, doc_ids, status, submitted_at, completed_at, result_summary
         FROM batch_jobs WHERE id = ?`,
      [jobId],
    );
    if (!job) return c.json({ error: 'batch job not found' }, 404);
    if (!isBatchProvider(job.provider) || !job.provider_batch_id) {
      return c.json({ error: 'job missing provider batch id' }, 409);
    }
    if (job.status === 'completed' || job.status === 'failed') {
      return c.json({ jobId, status: job.status, alreadyFinished: true });
    }
    let storedDocIds: unknown;
    try {
      storedDocIds = JSON.parse(job.doc_ids);
    } catch {
      return c.json({ error: 'job has invalid document ids' }, 409);
    }
    if (!Array.isArray(storedDocIds)) {
      return c.json({ error: 'job has invalid document ids' }, 409);
    }
    const expectedDocIdList = storedDocIds.map((value) => (
      typeof value === 'string' ? value : ''
    ));
    const expectedDocIds = new Set(expectedDocIdList);
    if (expectedDocIdList.length === 0
      || expectedDocIdList.some((docId) => !docId)
      || expectedDocIdList.some((docId) => docId !== docId.trim())
      || expectedDocIds.size !== expectedDocIdList.length) {
      return c.json({ error: 'job has invalid document ids' }, 409);
    }

    type PersistedBatchExtractionState = {
      persistedDocIds: Set<string>;
      legacyPersistedDocIds: Set<string>;
      hasPersistedRows: boolean;
      hasLegacyRandomIds: boolean;
    };
    let persistedExtractionState: PersistedBatchExtractionState | null = null;
    const loadPersistedExtractionState = async (): Promise<PersistedBatchExtractionState> => {
      if (persistedExtractionState) return persistedExtractionState;
      const rows = await all<{ id: string; doc_id: string }>(
        c.env.DB,
        `SELECT id, doc_id
           FROM extraction_runs
          WHERE batch_id = ? AND kind = 'batch'`,
        [jobId],
      );
      const persistedDocIds = new Set(rows.flatMap((row) => (
        typeof row.doc_id === 'string' && row.doc_id.length > 0 ? [row.doc_id] : []
      )));
      const legacyPersistedDocIds = new Set(rows.flatMap((row) => (
        (typeof row.id !== 'string' || !/^ct-batch-run-[0-9a-f]{64}$/.test(row.id))
          && typeof row.doc_id === 'string' && row.doc_id.length > 0
          ? [row.doc_id]
          : []
      )));
      persistedExtractionState = {
        persistedDocIds,
        legacyPersistedDocIds,
        hasPersistedRows: rows.length > 0,
        hasLegacyRandomIds: legacyPersistedDocIds.size > 0,
      };
      return persistedExtractionState;
    };

    const claimAccountingPlan = async (aggregateUsage?: BatchUsage): Promise<{
      accountingPlan: BatchAccountingPlan;
      legacyAccounting: boolean;
      resultSummary: string;
    } | null> => {
      const rewriteLegacyPlan = async (expectedResultSummary: string | null) => {
        await run(
          c.env.DB,
          `UPDATE batch_jobs
              SET result_summary = ?
            WHERE id = ?
              AND status IN ('submitted', 'running')
              AND ((result_summary IS NULL AND ? IS NULL) OR result_summary = ?)`,
          [
            JSON.stringify({
              state: 'accounting_planned',
              accountingProtocol: BATCH_ACCOUNTING_PROTOCOL_VERSION,
              accountingPlan: { version: 1, tokenMode: 'per-result' },
              legacyAccounting: LEGACY_BATCH_ACCOUNTING_MARKER,
            }),
            jobId,
            expectedResultSummary,
            expectedResultSummary,
          ],
        );
        const rewritten = await get<{ status: string; result_summary: string | null }>(
          c.env.DB,
          'SELECT status, result_summary FROM batch_jobs WHERE id = ?',
          [jobId],
        );
        const rewrittenPlan = parseBatchAccountingPlan(rewritten?.result_summary);
        if (!rewrittenPlan || !hasCurrentBatchAccountingProtocol(rewritten?.result_summary)) {
          return null;
        }
        if (hasLegacyBatchAccountingMarker(rewritten?.result_summary)
          && rewrittenPlan.tokenMode !== 'per-result') return null;
        return {
          accountingPlan: rewrittenPlan,
          legacyAccounting: hasLegacyBatchAccountingMarker(rewritten?.result_summary),
          resultSummary: rewritten?.result_summary ?? '',
        };
      };

      const existingPlan = parseBatchAccountingPlan(job.result_summary);
      if (existingPlan && hasCurrentBatchAccountingProtocol(job.result_summary)
        && !(hasLegacyBatchAccountingMarker(job.result_summary)
          && existingPlan.tokenMode !== 'per-result')) {
        return {
          accountingPlan: existingPlan,
          legacyAccounting: hasLegacyBatchAccountingMarker(job.result_summary),
          resultSummary: job.result_summary ?? '',
        };
      }
      if (existingPlan) {
        // Never rewrite an in-flight terminal claim: its exact summary is the
        // final commit fence. Pre-protocol plans that have not begun settlement
        // are atomically converted to conservative per-result suppression.
        if (job.status === 'settling') return null;
        return rewriteLegacyPlan(job.result_summary ?? null);
      }

      const extractionState = await loadPersistedExtractionState();
      // Jobs submitted before accountingProtocol=1 may already have stable
      // per-result events in the receiver even when a legacy extraction row is
      // absent. Keep every unversioned job on per-result accounting. Any
      // unplanned persisted result is the same compatibility signal.
      const legacyAccounting = !hasCurrentBatchAccountingProtocol(job.result_summary)
        || extractionState.hasPersistedRows
        || extractionState.hasLegacyRandomIds;
      const proposedPlan = legacyAccounting
        ? { version: 1, tokenMode: 'per-result' } as const
        : proposedBatchAccountingPlan(aggregateUsage);
      const expectedResultSummary = job.result_summary ?? null;
      await run(
        c.env.DB,
        `UPDATE batch_jobs
            SET result_summary = ?
          WHERE id = ?
            AND status IN ('submitted', 'running')
            AND ((result_summary IS NULL AND ? IS NULL) OR result_summary = ?)`,
        [
          JSON.stringify({
            state: 'accounting_planned',
            accountingProtocol: BATCH_ACCOUNTING_PROTOCOL_VERSION,
            accountingPlan: proposedPlan,
            ...(legacyAccounting ? { legacyAccounting: LEGACY_BATCH_ACCOUNTING_MARKER } : {}),
          }),
          jobId,
          expectedResultSummary,
          expectedResultSummary,
        ],
      );
      const claimed = await get<{ status: string; result_summary: string | null }>(
        c.env.DB,
        'SELECT status, result_summary FROM batch_jobs WHERE id = ?',
        [jobId],
      );
      const accountingPlan = parseBatchAccountingPlan(claimed?.result_summary);
      if (!accountingPlan) return null;
      if (!hasCurrentBatchAccountingProtocol(claimed?.result_summary)) {
        if (claimed?.status === 'settling') return null;
        return rewriteLegacyPlan(claimed?.result_summary ?? null);
      }
      if (hasLegacyBatchAccountingMarker(claimed?.result_summary)
        && accountingPlan.tokenMode !== 'per-result') {
        if (claimed?.status === 'settling') return null;
        return rewriteLegacyPlan(claimed?.result_summary ?? null);
      }
      return {
        accountingPlan,
        legacyAccounting: hasLegacyBatchAccountingMarker(claimed?.result_summary)
          || (legacyAccounting && accountingPlan.tokenMode === 'per-result'),
        resultSummary: claimed?.result_summary ?? '',
      };
    };

    const lifecycleForDecision = (input: {
      submittedAt?: string;
      terminalAt?: string;
    }): Pick<BatchTerminalDecision, 'submittedAt' | 'completedAt' | 'turnaroundMs'> => {
      const observedAt = new Date().toISOString();
      const completedAt = canonicalBatchTimestamp(job.completed_at)
        ?? canonicalBatchTimestamp(input.terminalAt)
        ?? observedAt;
      const completedTime = Date.parse(completedAt);
      const providerSubmittedAt = canonicalBatchTimestamp(input.submittedAt);
      const persistedSubmittedAt = canonicalBatchTimestamp(job.submitted_at);
      const submittedAt = persistedSubmittedAt && Date.parse(persistedSubmittedAt) <= completedTime
        ? persistedSubmittedAt
        : providerSubmittedAt && Date.parse(providerSubmittedAt) <= completedTime
          ? providerSubmittedAt
          : completedAt;
      return {
        submittedAt,
        completedAt,
        turnaroundMs: Math.max(0, completedTime - Date.parse(submittedAt)),
      };
    };

    const terminalWinnerResponse = async () => {
      const winner = await get<{ status: string; result_summary: string | null }>(
        c.env.DB,
        'SELECT status, result_summary FROM batch_jobs WHERE id = ?',
        [jobId],
      );
      const winnerDecision = parseBatchTerminalDecision(winner?.result_summary);
      return c.json({
        jobId,
        status: winner?.status ?? 'settling',
        ...(winner?.status === 'completed' || winner?.status === 'failed'
          ? { alreadyFinished: true }
          : { settlementInProgress: true }),
        ...(winnerDecision ? { terminalDecision: winnerDecision.kind } : {}),
      });
    };

    const claimTerminalDecision = async (
      accounting: NonNullable<Awaited<ReturnType<typeof claimAccountingPlan>>>,
      decisionWithoutFingerprint: Omit<BatchTerminalDecision, 'fingerprint'>,
      canonicalOutcome: unknown,
    ): Promise<{ decision: BatchTerminalDecision; claimSummary: string } | null> => {
      const fingerprint = await batchTerminalFingerprint(jobId, {
        decision: decisionWithoutFingerprint,
        accountingPlan: accounting.accountingPlan,
        outcome: canonicalOutcome,
      });
      const proposedDecision: BatchTerminalDecision = {
        ...decisionWithoutFingerprint,
        fingerprint,
      };
      const accountingSummary = parseBatchResultSummary(accounting.resultSummary) ?? {};
      const proposedClaimSummary = JSON.stringify({
        ...accountingSummary,
        state: 'settling',
        accountingProtocol: BATCH_ACCOUNTING_PROTOCOL_VERSION,
        accountingPlan: accounting.accountingPlan,
        ...(accounting.legacyAccounting
          ? { legacyAccounting: LEGACY_BATCH_ACCOUNTING_MARKER }
          : {}),
        terminalDecision: proposedDecision,
      });
      await run(
        c.env.DB,
        `UPDATE batch_jobs
            SET status = 'settling', result_summary = ?
          WHERE id = ?
            AND status IN ('submitted', 'running')
            AND result_summary = ?`,
        [proposedClaimSummary, jobId, accounting.resultSummary],
      );
      const claimed = await get<{ status: string; result_summary: string | null }>(
        c.env.DB,
        'SELECT status, result_summary FROM batch_jobs WHERE id = ?',
        [jobId],
      );
      const claimedDecision = parseBatchTerminalDecision(claimed?.result_summary);
      if (claimed?.status !== 'settling' || !claimedDecision
        || claimedDecision.fingerprint !== fingerprint) return null;
      return { decision: claimedDecision, claimSummary: claimed?.result_summary ?? '' };
    };

    const finalizeInvalidDecision = async (input: {
      accounting: NonNullable<Awaited<ReturnType<typeof claimAccountingPlan>>>;
      decision: BatchTerminalDecision & { kind: 'invalid'; reason: NonNullable<BatchTerminalDecision['reason']> };
      claimSummary: string;
    }) => {
      const { accounting, decision } = input;
      const aggregateUsage = accounting.accountingPlan.tokenMode === 'aggregate'
        ? accounting.accountingPlan.aggregateUsage
        : undefined;
      if (aggregateUsage) {
        const recorded = await recordMeasuredThirdPartyUsage(c.env, {
          provider: job.provider,
          service: 'llm-batch',
          operation: 'batch-job-tokens',
          idempotencyKey: await stableMeasuredUsageIdempotencyKey(
            'batch-job', 'tokens', jobId,
          ),
          occurredAt: decision.completedAt,
          model: job.model,
          quantity: aggregateUsage.promptTokens + aggregateUsage.completionTokens,
          unit: 'token',
          billingMode: 'actual',
          confidence: 'actual',
          metadata: {
            promptTokens: aggregateUsage.promptTokens,
            completionTokens: aggregateUsage.completionTokens,
            ...(aggregateUsage.cachedTokens == null
              ? {}
              : { cachedTokens: aggregateUsage.cachedTokens }),
            success: false,
          },
        });
        if (!recorded) {
          return c.json({ error: 'batch measured usage could not be persisted' }, 503);
        }
      }
      const safeReason = decision.reason === 'malformed_result_jsonl'
        ? 'provider returned malformed terminal result data'
        : decision.reason === 'invalid_result_identity'
          ? 'provider returned invalid or duplicate result identities'
          : 'provider returned results outside the submitted document set';
      const providerErrors = decision.providerErrors?.summaries
        .map((summary) => `provider batch error: ${summary}`) ?? [];
      const summary = {
        docs: 0,
        expectedDocs: expectedDocIdList.length,
        returnedDocs: decision.returnedDocs,
        recognizedDocs: decision.recognizedDocs,
        missingDocs: decision.missingDocs,
        ...(decision.identityObservationTruncated ? { missingDocsExact: false } : {}),
        providerStatus: decision.providerStatus,
        ok: 0,
        rows: 0,
        errorCount: (decision.violationCount ?? 1)
          + decision.missingDocs
          + (decision.providerErrors?.count ?? 0),
        errors: [...providerErrors, safeReason].slice(0, 20),
        terminalPayloadError: decision.reason,
        accountingProtocol: BATCH_ACCOUNTING_PROTOCOL_VERSION,
        accountingPlan: accounting.accountingPlan,
        terminalDecision: decision,
        ...(accounting.legacyAccounting
          ? {
              legacyAccounting: LEGACY_BATCH_ACCOUNTING_MARKER,
              legacyAccountingAmbiguous: true,
              measuredUsageStatus: 'suppressed_unknown',
            }
          : {}),
        ...(decision.providerErrors ? {
          providerErrorCount: decision.providerErrors.count,
          providerErrors: decision.providerErrors.summaries,
        } : {}),
        ...(aggregateUsage ? { aggregateUsage } : {}),
      };
      const settled = await run(
        c.env.DB,
        `UPDATE batch_jobs
            SET status = 'failed', submitted_at = ?, completed_at = ?, turnaround_ms = ?,
                result_summary = ?, error = ?
          WHERE id = ? AND status = 'settling' AND result_summary = ?`,
        [
          decision.submittedAt,
          decision.completedAt,
          decision.turnaroundMs,
          JSON.stringify(summary),
          decision.reason,
          jobId,
          input.claimSummary,
        ],
      );
      if ((settled.meta.changes ?? 0) === 0) return terminalWinnerResponse();
      return c.json({
        jobId,
        status: 'failed',
        turnaroundMs: decision.turnaroundMs,
        turnaroundMin: Math.round((decision.turnaroundMs / 60000) * 10) / 10,
        summary,
      });
    };

    const settleInvalidTerminalPayload = async (input: {
      reason: 'malformed_result_jsonl' | 'invalid_result_identity' | 'unknown_result_identity';
      providerStatus: string;
      returnedDocs: number;
      violationCount: number;
      observedDocIds?: Array<string | null>;
      identityObservationTruncated?: boolean;
      providerErrors?: SafeBatchProviderErrors;
      aggregateUsage?: BatchUsage;
      submittedAt?: string;
      terminalAt?: string;
    }) => {
      let accounting;
      try {
        accounting = await claimAccountingPlan(input.aggregateUsage);
      } catch {
        return c.json({ error: 'batch accounting state could not be loaded' }, 503);
      }
      if (!accounting) {
        return c.json({ error: 'batch accounting plan could not be persisted' }, 503);
      }
      const existingDecision = parseBatchTerminalDecision(job.result_summary);
      if (job.status === 'settling' && existingDecision?.kind === 'invalid'
        && existingDecision.reason) {
        return finalizeInvalidDecision({
          accounting,
          decision: existingDecision as BatchTerminalDecision & {
            kind: 'invalid'; reason: NonNullable<BatchTerminalDecision['reason']>;
          },
          claimSummary: job.result_summary ?? '',
        });
      }
      const observedExpectedDocIds = new Set(
        (input.observedDocIds ?? []).flatMap((docId) => (
          typeof docId === 'string' && expectedDocIds.has(docId) ? [docId] : []
        )),
      );
      const lifecycle = lifecycleForDecision(input);
      const decisionWithoutFingerprint: Omit<BatchTerminalDecision, 'fingerprint'> = {
        version: 1,
        kind: 'invalid',
        finalStatus: 'failed',
        providerStatus: safeBatchProviderStatus(input.providerStatus),
        ...lifecycle,
        returnedDocs: Math.max(0, input.returnedDocs),
        recognizedDocs: observedExpectedDocIds.size,
        missingDocs: Math.max(0, expectedDocIdList.length - observedExpectedDocIds.size),
        reason: input.reason,
        violationCount: Math.max(1, input.violationCount),
        ...(input.providerErrors ? { providerErrors: input.providerErrors } : {}),
        ...(input.identityObservationTruncated ? { identityObservationTruncated: true } : {}),
      };
      const claim = await claimTerminalDecision(accounting, decisionWithoutFingerprint, {
        kind: 'invalid',
        reason: input.reason,
        providerStatus: decisionWithoutFingerprint.providerStatus,
        returnedDocs: decisionWithoutFingerprint.returnedDocs,
        recognizedDocs: decisionWithoutFingerprint.recognizedDocs,
        missingDocs: decisionWithoutFingerprint.missingDocs,
        providerErrors: decisionWithoutFingerprint.providerErrors,
        lifecycle,
      });
      if (!claim || claim.decision.kind !== 'invalid' || !claim.decision.reason) {
        return terminalWinnerResponse();
      }
      return finalizeInvalidDecision({
        accounting,
        decision: claim.decision as BatchTerminalDecision & {
          kind: 'invalid'; reason: NonNullable<BatchTerminalDecision['reason']>;
        },
        claimSummary: claim.claimSummary,
      });
    };

    const persistedTerminalDecision = parseBatchTerminalDecision(job.result_summary);
    if (job.status === 'settling' && persistedTerminalDecision?.kind === 'invalid'
      && persistedTerminalDecision.reason) {
      const accounting = await claimAccountingPlan();
      if (!accounting) return c.json({ error: 'batch accounting plan could not be loaded' }, 503);
      return finalizeInvalidDecision({
        accounting,
        decision: persistedTerminalDecision as BatchTerminalDecision & {
          kind: 'invalid'; reason: NonNullable<BatchTerminalDecision['reason']>;
        },
        claimSummary: job.result_summary ?? '',
      });
    }
    if (job.status === 'settling' && !persistedTerminalDecision) {
      return c.json({ error: 'batch terminal settlement claim is invalid' }, 503);
    }

    let poll;
    try {
      poll = await pollBatch(c.env, job.provider, job.provider_batch_id);
    } catch (err) {
      if (err instanceof BatchTerminalPayloadError) {
        return settleInvalidTerminalPayload({
          reason: err.code,
          providerStatus: err.providerStatus,
          returnedDocs: err.context.returnedDocs ?? 0,
          violationCount: 1,
          observedDocIds: err.context.observedDocIds,
          identityObservationTruncated: err.context.observedDocIdsTruncated,
          providerErrors: err.context.providerErrors,
          aggregateUsage: err.context.aggregateUsage,
          submittedAt: err.context.submittedAt,
          terminalAt: err.context.terminalAt,
        });
      }
      return c.json({ error: (err as Error).message }, 502);
    }

    if (!poll.done) {
      if (job.status === 'settling') {
        return c.json({ error: 'batch terminal settlement is in progress' }, 503);
      }
      const markedRunning = await run(
        c.env.DB,
        `UPDATE batch_jobs SET status = 'running'
          WHERE id = ? AND status IN ('submitted', 'running')`,
        [jobId],
      );
      if ((markedRunning.meta.changes ?? 0) === 0) return terminalWinnerResponse();
      return c.json({ jobId, status: 'running', providerStatus: poll.status });
    }

    const normalizedResults = [] as typeof poll.results;
    const resultDocIds = new Set<string>();
    let invalidResultDocIdCount = 0;
    let duplicateResultDocIdCount = 0;
    for (const result of poll.results) {
      const rawDocId = result.docId;
      if (typeof rawDocId !== 'string' || !rawDocId || rawDocId !== rawDocId.trim()) {
        invalidResultDocIdCount++;
        continue;
      }
      const docId = rawDocId;
      if (resultDocIds.has(docId)) {
        duplicateResultDocIdCount++;
        continue;
      }
      resultDocIds.add(docId);
      normalizedResults.push({ ...result, docId });
    }
    if (invalidResultDocIdCount > 0 || duplicateResultDocIdCount > 0) {
      return settleInvalidTerminalPayload({
        reason: 'invalid_result_identity',
        providerStatus: poll.status,
        returnedDocs: poll.results.length,
        violationCount: invalidResultDocIdCount + duplicateResultDocIdCount,
        observedDocIds: poll.results.map((result) => (
          typeof result.docId === 'string' ? result.docId : null
        )),
        providerErrors: poll.providerErrors,
        aggregateUsage: poll.aggregateUsage,
        submittedAt: poll.submittedAt,
        terminalAt: poll.terminalAt,
      });
    }
    const unknownResultDocIdCount = normalizedResults.reduce(
      (count, result) => count + (expectedDocIds.has(result.docId) ? 0 : 1),
      0,
    );
    if (unknownResultDocIdCount > 0) {
      return settleInvalidTerminalPayload({
        reason: 'unknown_result_identity',
        providerStatus: poll.status,
        returnedDocs: normalizedResults.length,
        violationCount: unknownResultDocIdCount,
        observedDocIds: normalizedResults.map((result) => result.docId),
        providerErrors: poll.providerErrors,
        aggregateUsage: poll.aggregateUsage,
        submittedAt: poll.submittedAt,
        terminalAt: poll.terminalAt,
      });
    }
    const missingDocIds = expectedDocIdList.filter((docId) => !resultDocIds.has(docId));

    let accounting;
    try {
      accounting = await claimAccountingPlan(poll.aggregateUsage);
    } catch {
      return c.json({ error: 'batch accounting state could not be loaded' }, 503);
    }
    if (!accounting) {
      return c.json({ error: 'batch accounting plan could not be persisted' }, 503);
    }
    const { accountingPlan } = accounting;
    const existingValidDecision = job.status === 'settling'
      && persistedTerminalDecision?.kind === 'valid'
      ? persistedTerminalDecision
      : null;
    const lifecycle = existingValidDecision
      ? {
          submittedAt: existingValidDecision.submittedAt,
          completedAt: existingValidDecision.completedAt,
          turnaroundMs: existingValidDecision.turnaroundMs,
        }
      : lifecycleForDecision(poll);
    const providerErrors = existingValidDecision?.providerErrors
      ?? parseSafeBatchProviderErrors(poll.providerErrors);
    const decisionWithoutFingerprint: Omit<BatchTerminalDecision, 'fingerprint'> = {
      version: 1,
      kind: 'valid',
      finalStatus: existingValidDecision?.finalStatus ?? (poll.failed ? 'failed' : 'completed'),
      providerStatus: existingValidDecision?.providerStatus ?? safeBatchProviderStatus(poll.status),
      ...lifecycle,
      returnedDocs: existingValidDecision?.returnedDocs ?? normalizedResults.length,
      recognizedDocs: existingValidDecision?.recognizedDocs ?? normalizedResults.length,
      missingDocs: existingValidDecision?.missingDocs ?? missingDocIds.length,
      ...(providerErrors ? { providerErrors } : {}),
    };
    const canonicalResults = normalizedResults
      .map((result) => ({
        docId: result.docId,
        ok: result.ok,
        error: result.error,
        rows: result.rows
          .map((row) => canonicalBatchFingerprintValue(row))
          .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
        usage: result.usage,
        resolvedModel: result.resolvedModel,
      }))
      .sort((left, right) => left.docId.localeCompare(right.docId));
    const terminalClaim = await claimTerminalDecision(accounting, decisionWithoutFingerprint, {
      kind: 'valid',
      providerStatus: decisionWithoutFingerprint.providerStatus,
      finalStatus: decisionWithoutFingerprint.finalStatus,
      lifecycle,
      providerErrors,
      results: canonicalResults,
    });
    if (!terminalClaim || terminalClaim.decision.kind !== 'valid') {
      return terminalWinnerResponse();
    }
    const terminalDecision = terminalClaim.decision;
    const completedAt = terminalDecision.completedAt;
    const submittedAt = terminalDecision.submittedAt;
    const turnaroundMs = terminalDecision.turnaroundMs;
    let extractionState: PersistedBatchExtractionState;
    try {
      extractionState = await loadPersistedExtractionState();
    } catch {
      return c.json({ error: 'batch extraction state could not be loaded' }, 503);
    }

    let okCount = 0;
    let rowTotal = 0;
    let resultErrorCount = 0;
    const providerErrorCount = terminalDecision.providerErrors?.count ?? 0;
    const errors: string[] = (terminalDecision.providerErrors?.summaries ?? [])
      .slice(0, 20)
      .map((summary) => `provider batch error: ${summary.slice(0, 64)}`);
    const aggregateUsage = accountingPlan.tokenMode === 'aggregate'
      ? accountingPlan.aggregateUsage
      : undefined;
    const hasCompleteAggregateTokenUsage = aggregateUsage != null;

    if (aggregateUsage) {
      const { promptTokens: aggregatePromptTokens, completionTokens: aggregateCompletionTokens } = aggregateUsage;
      const metadata: Record<string, string | number | boolean | null> = {
        promptTokens: aggregatePromptTokens,
        completionTokens: aggregateCompletionTokens,
        success: terminalDecision.finalStatus === 'completed',
      };
      if (aggregateUsage?.cachedTokens != null) {
        metadata.cachedTokens = aggregateUsage.cachedTokens;
      }
      const recorded = await recordMeasuredThirdPartyUsage(c.env, {
        provider: job.provider,
        service: 'llm-batch',
        operation: 'batch-job-tokens',
        idempotencyKey: await stableMeasuredUsageIdempotencyKey(
          'batch-job', 'tokens', jobId,
        ),
        occurredAt: completedAt,
        model: job.model,
        quantity: aggregatePromptTokens + aggregateCompletionTokens,
        unit: 'token',
        billingMode: 'actual',
        confidence: 'actual',
        metadata,
      });
      if (!recorded) {
        return c.json({ error: 'batch measured usage could not be persisted' }, 503);
      }
    }

    for (const res of normalizedResults) {
        if (res.ok) {
          okCount++;
          rowTotal += res.rows.length;
        } else {
          resultErrorCount++;
          if (errors.length < 20) errors.push(`${res.docId}: ${res.error ?? 'failed'}`.slice(0, 300));
        }
        const avg = res.rows.length ? res.rows.reduce((s, x) => s + (x.confidence ?? 0), 0) / res.rows.length : 0;
        if (!extractionState.persistedDocIds.has(res.docId)) {
          try {
            const extractionRunId = await stableBatchExtractionRunId(jobId, res.docId);
            await run(
              c.env.DB,
              `INSERT OR IGNORE INTO extraction_runs
                 (id, batch_id, doc_id, provider, model, kind, ok, error, row_count, latency_ms, avg_confidence, result_json, usage_json, created_at)
               VALUES (?, ?, ?, ?, ?, 'batch', ?, ?, ?, ?, ?, ?, ?, ?)`,
              [extractionRunId, jobId, res.docId, job.provider, job.model, res.ok ? 1 : 0, res.error ?? null,
               res.rows.length, turnaroundMs, Math.round(avg * 1000) / 1000, JSON.stringify(res.rows),
               res.usage ? JSON.stringify(res.usage) : null, completedAt],
            );
          } catch {
            // Keep the job retryable. Deterministic ids plus INSERT OR IGNORE
            // make concurrent/replayed inserts safe, while legacy random-id
            // rows are preserved without creating a second result for the doc.
            return c.json({ error: 'batch results could not be persisted' }, 503);
          }
        }

        // Pre-protocol rows may already have emitted the historical index-keyed
        // usage event. Do not emit a second doc-keyed family for those rows.
        // Newly persisted deterministic rows still retry their stable events.
        const legacyMeasuredUsageAmbiguous = accounting.legacyAccounting
          || extractionState.legacyPersistedDocIds.has(res.docId);

        // The request/poll attempts are metered by trackedFetch. Add only the
        // provider-reported units here, with stable keys so a status retry
        // cannot double count them. Never infer a missing token component.
        const promptTokens = nonNegativeSafeInteger(res.usage?.promptTokens);
        const completionTokens = nonNegativeSafeInteger(res.usage?.completionTokens);
        const tokenTotal = promptTokens == null || completionTokens == null
          ? null
          : promptTokens + completionTokens;
        if (!legacyMeasuredUsageAmbiguous
          && !hasCompleteAggregateTokenUsage
          && promptTokens != null
          && completionTokens != null
          && tokenTotal != null
          && Number.isSafeInteger(tokenTotal)) {
          const metadata: Record<string, string | number | boolean | null> = {
            promptTokens,
            completionTokens,
            success: res.ok,
          };
          if (res.usage?.cachedTokens != null) metadata.cachedTokens = res.usage.cachedTokens;
          const recorded = await recordMeasuredThirdPartyUsage(c.env, {
            provider: job.provider,
            service: 'llm-batch',
            operation: 'batch-result-tokens',
            idempotencyKey: await stableMeasuredUsageIdempotencyKey(
              'batch-result', 'tokens', jobId, res.docId,
            ),
            occurredAt: completedAt,
            model: job.model,
            quantity: tokenTotal,
            unit: 'token',
            billingMode: 'actual',
            confidence: 'actual',
            metadata,
          });
          if (!recorded) return c.json({ error: 'batch measured usage could not be persisted' }, 503);
        }
        if (!legacyMeasuredUsageAmbiguous && res.usage?.pagesProcessed != null) {
          const recorded = await recordMeasuredThirdPartyUsage(c.env, {
            provider: job.provider,
            service: 'ocr-batch',
            operation: 'batch-result-pages',
            idempotencyKey: await stableMeasuredUsageIdempotencyKey(
              'batch-result', 'pages', jobId, res.docId,
            ),
            occurredAt: completedAt,
            model: job.model,
            quantity: res.usage.pagesProcessed,
            unit: 'page',
            billingMode: 'actual',
            confidence: 'actual',
            metadata: { pagesProcessed: res.usage.pagesProcessed, success: res.ok },
          });
          if (!recorded) return c.json({ error: 'batch measured usage could not be persisted' }, 503);
        }
        if (!legacyMeasuredUsageAmbiguous && res.usage?.costInUsdTicks != null) {
          const costUsd = res.usage.costInUsdTicks / 10_000_000_000;
          const recorded = await recordMeasuredThirdPartyUsage(c.env, {
            provider: job.provider,
            service: 'llm-batch',
            operation: 'batch-result-provider-cost',
            idempotencyKey: await stableMeasuredUsageIdempotencyKey(
              'batch-result', 'cost', jobId, res.docId,
            ),
            occurredAt: completedAt,
            model: res.resolvedModel ?? job.model,
            metricType: 'cost',
            quantity: costUsd,
            unit: 'usd',
            costUsd,
            billingMode: 'actual',
            confidence: 'actual',
            metadata: {
              costInUsdTicks: res.usage.costInUsdTicks,
              success: res.ok,
              ...(res.usage.attachmentSearchCalls == null
                ? {}
                : { attachmentSearchCalls: res.usage.attachmentSearchCalls }),
            },
          });
          if (!recorded) return c.json({ error: 'batch measured usage could not be persisted' }, 503);
        }
        if (!legacyMeasuredUsageAmbiguous && res.usage?.attachmentSearchCalls != null) {
          const recorded = await recordMeasuredThirdPartyUsage(c.env, {
            provider: job.provider,
            service: 'llm-batch',
            operation: 'batch-result-attachment-search',
            idempotencyKey: await stableMeasuredUsageIdempotencyKey(
              'batch-result', 'attachment-search', jobId, res.docId,
            ),
            occurredAt: completedAt,
            model: res.resolvedModel ?? job.model,
            quantity: res.usage.attachmentSearchCalls,
            unit: 'call',
            billingMode: 'actual',
            confidence: 'actual',
            metadata: {
              toolName: 'attachment_search',
              attachmentSearchCalls: res.usage.attachmentSearchCalls,
              success: res.ok,
            },
          });
          if (!recorded) return c.json({ error: 'batch measured usage could not be persisted' }, 503);
        }
      }

    const errorCount = providerErrorCount + resultErrorCount + missingDocIds.length;
    const summaryErrors = errors.slice(0, 20);
    for (const missingDocId of missingDocIds) {
      if (summaryErrors.length >= 20) break;
      summaryErrors.push(`${missingDocId}: missing provider result`);
    }
    const summary = {
      docs: normalizedResults.length,
      expectedDocs: expectedDocIdList.length,
      returnedDocs: normalizedResults.length,
      missingDocs: missingDocIds.length,
      providerStatus: terminalDecision.providerStatus,
      ok: okCount,
      rows: rowTotal,
      errorCount,
      errors: summaryErrors,
      accountingProtocol: BATCH_ACCOUNTING_PROTOCOL_VERSION,
      accountingPlan,
      terminalDecision,
      ...(accounting.legacyAccounting
        ? { legacyAccounting: LEGACY_BATCH_ACCOUNTING_MARKER }
        : {}),
      ...(accounting.legacyAccounting || extractionState.legacyPersistedDocIds.size > 0
        ? {
            legacyAccountingAmbiguous: true,
            legacyAccountingAmbiguousDocs: accounting.legacyAccounting
              ? expectedDocIdList.length
              : extractionState.legacyPersistedDocIds.size,
            measuredUsageStatus: 'suppressed_unknown',
          }
        : {}),
      ...(missingDocIds.length === 0 ? {} : { missingDocIds: missingDocIds.slice(0, 20) }),
      ...(providerErrorCount === 0 ? {} : {
        providerErrorCount,
        providerErrors: (terminalDecision.providerErrors?.summaries ?? []).slice(0, 20),
      }),
      ...(aggregateUsage ? { aggregateUsage } : {}),
    };
    const settled = await run(
      c.env.DB,
      `UPDATE batch_jobs
          SET status = ?, submitted_at = ?, completed_at = ?,
              turnaround_ms = ?, result_summary = ?, error = ?
        WHERE id = ? AND status = 'settling' AND result_summary = ?`,
      [
        terminalDecision.finalStatus,
        submittedAt,
        completedAt,
        turnaroundMs,
        JSON.stringify(summary),
        terminalDecision.finalStatus === 'failed' ? terminalDecision.providerStatus : null,
        jobId,
        terminalClaim.claimSummary,
      ],
    );
    if ((settled.meta.changes ?? 0) === 0) return terminalWinnerResponse();
    return c.json({
      jobId,
      status: terminalDecision.finalStatus,
      turnaroundMs,
      turnaroundMin: Math.round((turnaroundMs / 60000) * 10) / 10,
      summary,
    });
  });

  // --- GET /autopilot/status ----------------------------------------------
  // Backlog-autopilot operational snapshot: knobs, backlog size, today's USD
  // spend vs budget, the last 10 run receipts (per-doc outcomes, error-class
  // counts, sample errors, spend), and any unacknowledged halt blocking new
  // runs. Values are knob settings and receipts only — never secrets.
  r.get('/autopilot/status', async (c) => {
    return c.json(await getAutopilotStatus(c.env));
  });

  // --- POST /autopilot/acknowledge ----------------------------------------
  // Acknowledge a halted autopilot run (error-class kill-switch, stalled
  // consumer, or enqueue failure). The cron will not start a new run while an
  // unacknowledged halted run exists — a human must look at the receipt
  // first. Body: { runId? } (defaults to the most recent halted run).
  r.post('/autopilot/acknowledge', async (c) => {
    let body: Record<string, unknown> = {};
    try {
      const raw = await c.req.text();
      if (raw) body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const runId = typeof body.runId === 'string' && body.runId.trim() ? body.runId.trim() : undefined;
    const acknowledged = await acknowledgeAutopilotHalt(c.env, {
      runId,
      actor: adminActor(c),
    });
    if (!acknowledged) {
      return c.json({ error: 'no halted autopilot run to acknowledge' }, 404);
    }
    return c.json({ acknowledged });
  });

  // --- POST /agreement-reprocess ------------------------------------------
  // Agreement-based auto-publish for the backlog. For each doc, run TWO
  // independent (cross-vendor) models; when they FULLY agree on the row set
  // (every row's ticker|date|type matches), the read is trusted and published
  // (ticker-resolved + bracket-validated via the normalizer) instead of held in
  // review — agreement substitutes for the conservative 0.60 vision-confidence
  // cap. Disagreements (or hard structural failures) stay in review.
  //
  // Body: { docIds?, n?, models:[{provider,model},{provider,model}],
  //         requireThird?:{provider,model}, dryRun?:boolean (default TRUE) }
  // dryRun reports what WOULD publish without writing — always preview first.
  r.post('/agreement-reprocess', async (c) => {
    let body: Record<string, unknown> = {};
    try {
      const raw = await c.req.text();
      if (raw) body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    // Structural parse only (provider + model presence). Catalog membership is
    // enforced below via validateBenchmarkModel, so the accepted set auto-tracks
    // the OpenRouter-only offerings (DEFAULT_CANDIDATES) plus llamaparse and the
    // legacy direct-provider decode entries — no hardcoded provider whitelist to
    // drift out of sync with the catalog.
    const parseModel = (m: unknown): BakeoffCandidate | null => {
      const o = m as { provider?: unknown; model?: unknown };
      if (typeof o.provider !== 'string' || typeof o.model !== 'string') return null;
      const provider = o.provider.trim().toLowerCase();
      const model = o.model.trim();
      return provider && model ? { provider: provider as Provider, model } : null;
    };
    const parsed = Array.isArray(body.models) ? body.models.map(parseModel) : [];
    if (parsed.length !== 2 || parsed.some((m) => !m)) {
      return c.json({ error: 'models must be exactly two {provider,model} entries from the benchmark model catalog' }, 400);
    }
    const [rawA, rawB] = parsed as BakeoffCandidate[];
    const rawC = body.requireThird ? parseModel(body.requireThird) : null;
    if (body.requireThird && !rawC) return c.json({ error: 'requireThird must be {provider,model}' }, 400);
    // Retired-candidate guard runs BEFORE catalog validation so a GPT-4o request
    // still receives its explicit retirement message (GPT-4o is absent from the
    // catalog and would otherwise fail with the generic not-in-catalog error).
    if ([rawA, rawB, rawC].some((model) => model && isRetiredDisclosureCandidate(model))) {
      return c.json({ error: 'GPT-4o is retired for new disclosure extraction; use gpt-5.6-terra, gpt-5.6-luna, or gpt-5.6-sol' }, 400);
    }
    let mA: BakeoffCandidate, mB: BakeoffCandidate, mC: BakeoffCandidate | null;
    try {
      mA = validateBenchmarkModel(rawA, 'models[0]');
      mB = validateBenchmarkModel(rawB, 'models[1]');
      mC = rawC ? validateBenchmarkModel(rawC, 'requireThird') : null;
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
    // Model-label distinctness only — same underlying vendor is allowed so
    // all-OpenRouter cascades can still form agreement votes.
    const lineupError = duplicateLineupReason([mA, mB, ...(mC ? [mC] : [])]);
    if (lineupError) {
      return c.json({
        error: 'models must be distinct',
        code: lineupError,
      }, 400);
    }
    const dryRun = body.dryRun !== false; // default true — preview unless explicitly false

    let n = typeof body.n === 'number' && body.n > 0 ? Math.floor(body.n) : 25;
    if (n > 100) n = 100;

    let docRows: Array<{ doc_id: string; raw_object_key: string | null }>;
    if (Array.isArray(body.docIds) && body.docIds.length > 0) {
      const ids = body.docIds.filter((x): x is string => typeof x === 'string').slice(0, n);
      docRows = [];
      for (const id of ids) {
        const row = await get<{ doc_id: string; raw_object_key: string | null }>(
          c.env.DB,
          'SELECT doc_id, raw_object_key FROM filings WHERE doc_id = ?',
          [id],
        );
        if (row) docRows.push(row);
      }
    } else {
      // Same deterministic-format exclusion the autonomous lane applies
      // (agreement.ts selectAgreementCandidates). Without it this operator
      // route re-opens the exact lane that burned 2,086 model calls on
      // senate_html for ZERO rows: the cascade corroborates a MODEL's read,
      // and these formats are parsed deterministically — there is nothing to
      // corroborate, and the vision models receive bytes they cannot parse.
      docRows = await all<{ doc_id: string; raw_object_key: string | null }>(
        c.env.DB,
        `SELECT f.doc_id, f.raw_object_key
           FROM review_queue rq JOIN filings f ON f.doc_id = rq.doc_id
          WHERE rq.resolved = 0 AND f.raw_object_key IS NOT NULL
            AND LOWER(COALESCE(f.doc_kind, '')) NOT IN ('text_pdf', 'senate_html', 'oge_html', 'oge_text')
            AND LOWER(COALESCE(f.extractor, '')) NOT IN ('textpdf', 'text_pdf', 'senatehtml', 'senate_html', 'ogetext', 'oge_text', 'oge-text')
          ORDER BY rq.created_at DESC LIMIT ?`,
        [n],
      );
    }

    const agModels: AgreementModels = { a: mA, b: mB, c: mC };
    const results: Array<Record<string, unknown>> = [];
    let published = 0, wouldPublish = 0, disagree = 0, hardfail = 0, skipped = 0;

    for (const { doc_id, raw_object_key } of docRows) {
      const res = await processAgreementDoc(c.env, agModels, doc_id, raw_object_key, dryRun);
      results.push(res as unknown as Record<string, unknown>);
      if (res.outcome === 'published') published++;
      else if (res.outcome === 'would_publish') wouldPublish++;
      else if (res.outcome === 'disagree') disagree++;
      else if (res.outcome === 'agree_but_hardfail') hardfail++;
      else skipped++;
    }

    return c.json({
      ok: true,
      dryRun,
      models: { a: `${mA.provider}:${mA.model}`, b: `${mB.provider}:${mB.model}`, ...(mC ? { c: `${mC.provider}:${mC.model}` } : {}) },
      docsProcessed: docRows.length,
      summary: { published, wouldPublish, disagree, hardfail, skipped },
      results,
    });
  });

  // --- Durable benchmark runs ----------------------------------------------
  r.get('/benchmark/model-access/openai', async (c) => {
    const refresh = c.req.query('refresh') === '1' || c.req.query('refresh') === 'true';
    let models = DEFAULT_CANDIDATES
      .filter((candidate) => candidate.provider === 'openai')
      .map((candidate) => candidate.model);
    if (!models.length) models = [...OPENAI_BENCHMARK_ACCESS_MODELS];
    return c.json({ access: await checkOpenAiModelAccess(c.env, { models, refresh }) });
  });

  r.post('/benchmark/runs', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const chamber = benchmarkChamber(body.chamber);
    if (!chamber) return c.json({ error: "chamber must be 'house', 'senate', or 'executive'" }, 400);
    if (!Array.isArray(body.models) || body.models.length === 0 || body.models.length > 20) {
      return c.json({ error: 'models must be a non-empty array with at most 20 entries' }, 400);
    }
    let models: BakeoffCandidate[];
    try {
      models = body.models.map((model, index) => validateBenchmarkModel(
        model as BenchmarkModelRef,
        `models[${index}]`,
      ));
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
    if (new Set(models.map((model) => `${model.provider}:${model.model}`)).size !== models.length) {
      return c.json({ error: 'models must be unique' }, 400);
    }
    const alreadyRunning = await getRunningBenchmarkRun(c.env.DB, chamber);
    if (alreadyRunning) {
      return c.json({
        error: `${chamber} already has a running benchmark`,
        code: 'benchmark_run_already_active',
        existingRunId: alreadyRunning.id,
        run: alreadyRunning,
      }, 409);
    }
    const defaultLimit = chamber === 'executive' ? 5 : 25;
    const limit = Math.min(Math.max(Math.floor(Number(body.limit) || defaultLimit), 1), 25);
    let docIds: string[] | undefined;
    if (body.docIds !== undefined) {
      if (!Array.isArray(body.docIds) || !body.docIds.every((value) => typeof value === 'string')) {
        return c.json({ error: 'docIds must be an array of strings' }, 400);
      }
      docIds = [...new Set(body.docIds.map((value) => String(value).trim()).filter(Boolean))].slice(0, 25);
      if (!docIds.length) return c.json({ error: 'docIds must not be empty' }, 400);
    }
    if (body.resolvedOnly !== undefined && typeof body.resolvedOnly !== 'boolean') {
      return c.json({ error: 'resolvedOnly must be a boolean' }, 400);
    }
    const documents = await loadBenchmarkDocuments(c.env, {
      chamber,
      limit,
      docIds,
      resolvedOnly: body.resolvedOnly === true,
    });
    if (!documents.length) {
      return c.json({
        error: body.resolvedOnly
          ? `no resolved ${chamber} filings with stored documents were found`
          : `no ${chamber} filings with stored documents were found`,
      }, 404);
    }
    let configured = await Promise.all(models.map(async (model) => ({
      ...model,
      configured: Boolean(await keyFor(c.env, model.provider)),
    })));
    let configuredModels = configured.filter((model) => model.configured);
    let plannedCalls = documents.length * configuredModels.length;
    if (plannedCalls > 0 && body.confirmPaidRun !== true) {
      return c.json({
        error: 'confirmPaidRun=true is required before reserving paid provider calls',
        requiresConfirmation: true,
        plannedCalls,
        documentCount: documents.length,
        configuredModels,
      }, 409);
    }
    let modelAccess: Awaited<ReturnType<typeof checkOpenAiModelAccess>> | null = null;
    let skippedModels: Array<BenchmarkModelRef & {
      reason: 'known_unavailable';
      failure: Awaited<ReturnType<typeof checkOpenAiModelAccess>>['models'][number]['failure'];
    }> = [];
    const selectedOpenAi = models.filter((model) => model.provider === 'openai');
    const needsOpenAiAccessCheck = selectedOpenAi.some((model) => model.model.startsWith('gpt-5.6'));
    if (body.confirmPaidRun === true && needsOpenAiAccessCheck) {
      modelAccess = await checkOpenAiModelAccess(c.env, {
        models: selectedOpenAi.map((model) => model.model),
      });
      const inconclusive = selectedOpenAi.filter(
        (model) => openAiModelAccessDecision(modelAccess as NonNullable<typeof modelAccess>, model.model) === 'unknown',
      );
      if (inconclusive.length) {
        return c.json({
          error: 'OpenAI model access could not be verified; no benchmark run or paid-call reservation was created',
          code: 'benchmark_model_access_unknown',
          retryable: true,
          models: inconclusive,
          access: modelAccess,
        }, 503);
      }
      skippedModels = modelAccess.models
        .filter((entry) => entry.availability === 'unavailable')
        .map((entry) => ({
          provider: entry.provider,
          model: entry.model,
          reason: 'known_unavailable' as const,
          failure: entry.failure,
        }));
      const skippedKeys = new Set(skippedModels.map((model) => `${model.provider}:${model.model}`));
      models = models.filter((model) => !skippedKeys.has(`${model.provider}:${model.model}`));
      if (!models.length) {
        return c.json({
          error: 'none of the requested benchmark models are currently available',
          code: 'benchmark_models_unavailable',
          skippedModels,
          access: modelAccess,
        }, 409);
      }
      configured = await Promise.all(models.map(async (model) => ({
        ...model,
        configured: Boolean(await keyFor(c.env, model.provider)),
      })));
      configuredModels = configured.filter((model) => model.configured);
      plannedCalls = documents.length * configuredModels.length;
    }
    const provisionalProfile = {
      ...BENCHMARK_REQUEST_PROFILE,
      // No model/document cell is authorized until the durable daily ledger
      // reservation below succeeds.
      paidCallAuthorization: benchmarkPaidCallAuthorization(documents.length, [], null),
      ...(modelAccess ? { modelAccess } : {}),
    };
    let runRecord: BenchmarkRunDetail | Awaited<ReturnType<typeof beginBenchmarkRun>>;
    try {
      // The partial unique index on running chamber rows makes this insert the
      // atomic admission point. It happens before call reservation so a losing
      // browser cannot consume daily paid-call capacity.
      runRecord = await beginBenchmarkRun(c.env.DB, {
        chamber,
        models,
        requestProfile: provisionalProfile,
        documents: documents.map((document) => ({
          docId: document.docId,
          resolved: document.resolved,
          groundTruth: document.groundTruth,
        })),
      });
    } catch (error) {
      if (error instanceof BenchmarkActiveRunConflictError) {
        const existing = await getBenchmarkRun(c.env.DB, error.existingRunId);
        return c.json({
          error: error.message,
          code: 'benchmark_run_already_active',
          existingRunId: error.existingRunId,
          ...(existing ? { run: existing } : {}),
        }, 409);
      }
      throw error;
    }

    const reused = await reuseSuccessfulBenchmarkMeasurements(c.env.DB, {
      runId: runRecord.id,
      chamber,
      models,
      billableModels: configuredModels,
      documents: documents.map((document) => ({
        docId: document.docId,
        resolved: document.resolved,
        groundTruth: document.groundTruth,
      })),
    });
    const callsNeedingReservation = Math.max(0, plannedCalls - reused.reusedBillable);
    let cap: { usedToday: number; dailyCap: number; reservedDay: string } | null = null;
    if (callsNeedingReservation > 0) {
      try {
        cap = await reserveBenchmarkCalls(c.env, callsNeedingReservation);
      } catch (error) {
        try {
          await failBenchmarkRun(c.env.DB, runRecord.id, 'paid_call_reservation_failed');
        } catch (terminalizeError) {
          console.error(
            'benchmark reservation failed and provisional run could not be terminalized',
            terminalizeError instanceof Error ? terminalizeError.name : 'unknown',
          );
        }
        if (!(error instanceof BenchmarkCallReservationError)) throw error;
        if (error.reason === 'ledger_unavailable') {
          return c.json({
            error: 'benchmark daily call reservation is temporarily unavailable',
            code: 'benchmark_call_reservation_unavailable',
            plannedCalls: callsNeedingReservation,
            reusedCalls: reused.reusedBillable,
            dailyCap: error.dailyCap,
            retryable: true,
          }, 503);
        }
        return c.json({
          error: 'benchmark daily call cap reached',
          plannedCalls: callsNeedingReservation,
          reusedCalls: reused.reusedBillable,
          usedToday: error.usedToday,
          dailyCap: error.dailyCap,
        }, 429);
      }
    }
    const authorizedProfile = {
      ...provisionalProfile,
      paidCallAuthorization: benchmarkPaidCallAuthorization(
        documents.length,
        configuredModels,
        cap?.reservedDay ?? null,
        callsNeedingReservation,
      ),
    };
    if (callsNeedingReservation > 0) {
      const authorized = await updateBenchmarkRunRequestProfile(
        c.env.DB,
        runRecord.id,
        authorizedProfile,
      );
      if (!authorized) {
        await failBenchmarkRun(c.env.DB, runRecord.id, 'paid_call_authorization_persistence_failed');
        return c.json({
          error: 'benchmark paid-call authorization could not be persisted; no provider calls were started',
          code: 'benchmark_call_authorization_unavailable',
          retryable: true,
        }, 503);
      }
      runRecord = { ...runRecord, requestProfile: authorizedProfile };
    }
    return c.json({
      run: runRecord,
      docs: documents.map(({ docId, resolved }) => ({ docId, resolved })),
      resolvedDocumentCount: documents.filter((document) => document.resolved).length,
      plannedCalls,
      callsNeedingReservation,
      reusedCells: reused.reused,
      reusedBillableCells: reused.reusedBillable,
      reuseEligibleCells: reused.attempted,
      configuredModels,
      skippedModels,
      modelAccess,
      cap,
    }, 201);
  });

  r.get('/benchmark/runs', async (c) => {
    const rawChamber = c.req.query('chamber');
    const chamber = rawChamber ? benchmarkChamber(rawChamber) : undefined;
    if (rawChamber && !chamber) return c.json({ error: 'invalid chamber' }, 400);
    const limit = Math.min(Math.max(Math.floor(Number(c.req.query('limit')) || 20), 1), 100);
    return c.json({ runs: await listBenchmarkRuns(c.env.DB, chamber ?? undefined, limit) });
  });

  r.delete('/benchmark/runs', async (c) => {
    const rawChamber = c.req.query('chamber');
    const chamber = rawChamber ? benchmarkChamber(rawChamber) : null;
    if (!chamber) return c.json({ error: "chamber query must be 'house', 'senate', or 'executive'" }, 400);
    try {
      return c.json({ ok: true, chamber, ...await clearBenchmarkRuns(c.env.DB, chamber) });
    } catch (error) {
      if (error instanceof BenchmarkActiveRunConflictError) {
        return c.json({
          error: 'stop the running benchmark before clearing this chamber history',
          code: 'benchmark_run_already_active',
          existingRunId: error.existingRunId,
        }, 409);
      }
      throw error;
    }
  });

  r.get('/benchmark/runs/:runId', async (c) => {
    const runRecord = await getBenchmarkRun(c.env.DB, c.req.param('runId'));
    return runRecord ? c.json({ run: runRecord }) : c.json({ error: 'benchmark run not found' }, 404);
  });

  // Recompute accuracy/F1 from saved model rows and the run's ground-truth
  // snapshot. This route performs no provider calls and consumes no paid-call
  // reservation; it repairs historical scoring semantics in place.
  r.post('/benchmark/runs/:runId/rescore', async (c) => {
    const result = await rescoreBenchmarkRun(c.env.DB, c.req.param('runId'));
    return result ? c.json(result) : c.json({ error: 'benchmark run not found' }, 404);
  });

  // Stop browser-orchestrated work without deleting its partial measurements.
  // The status-fenced UPDATE prevents a concurrent completion from being
  // overwritten, while repeating an already-successful cancel is idempotent.
  r.post('/benchmark/runs/:runId/cancel', async (c) => {
    const runId = c.req.param('runId');
    const before = await getBenchmarkRun(c.env.DB, runId);
    if (!before) return c.json({ error: 'benchmark run not found' }, 404);
    if (before.status === 'failed' && before.error === 'cancelled_by_operator') {
      return c.json({ run: before });
    }
    if (before.status !== 'running') {
      return c.json({ error: `benchmark run is ${before.status}` }, 409);
    }

    const cancelled = await failBenchmarkRun(c.env.DB, runId, 'cancelled_by_operator');
    const after = await getBenchmarkRun(c.env.DB, runId);
    if (!after) return c.json({ error: 'benchmark run not found' }, 404);
    if (!cancelled && !(after.status === 'failed' && after.error === 'cancelled_by_operator')) {
      return c.json({ error: `benchmark run is ${after.status}` }, 409);
    }
    return c.json({ run: after });
  });

  r.post('/benchmark/runs/:runId/complete', async (c) => {
    const runRecord = await getBenchmarkRun(c.env.DB, c.req.param('runId'));
    if (!runRecord) return c.json({ error: 'benchmark run not found' }, 404);
    if (runRecord.status === 'completed') return c.json({ run: runRecord });
    if (runRecord.status !== 'running') return c.json({ error: `benchmark run is ${runRecord.status}` }, 409);
    const expectedMeasurements = runRecord.documents.length * runRecord.models.length;
    const completedMeasurements = runRecord.results.filter((result) => result.outcome !== 'running').length;
    if (completedMeasurements !== expectedMeasurements) {
      return c.json({
        error: 'benchmark run still has unmeasured document/model cells',
        expectedMeasurements,
        completedMeasurements,
        missingMeasurements: expectedMeasurements - completedMeasurements,
      }, 409);
    }
    try {
      return c.json({ run: await completeBenchmarkRun(c.env.DB, runRecord.id) });
    } catch (error) {
      if (error instanceof BenchmarkRunStateConflictError) {
        return c.json({ error: error.message }, 409);
      }
      throw error;
    }
  });

  r.post('/benchmark/runs/:runId/simulate', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    let lineup: BenchmarkSelectedLineup;
    try {
      lineup = validateBenchmarkLineup(body as unknown as {
        a: BenchmarkModelRef;
        b: BenchmarkModelRef;
        c: BenchmarkModelRef;
      });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
    const runRecord = await getBenchmarkRun(c.env.DB, c.req.param('runId'));
    if (!runRecord) return c.json({ error: 'benchmark run not found' }, 404);
    const selected = [lineup.a, lineup.b, lineup.c as BenchmarkModelRef];
    const runModels = new Set(runRecord.models.map((model) => `${model.provider}:${model.model}`));
    const absent = selected.filter((model) => !runModels.has(`${model.provider}:${model.model}`));
    if (absent.length) {
      return c.json({ error: 'every simulated model must have measurements in this run', absent }, 400);
    }

    let documentsSimulated = 0;
    let incompleteDocuments = 0;
    let tier1Published = 0;
    let cascadePublished = 0;
    let resolvedDocuments = 0;
    let autopublishedResolvedDocuments = 0;
    let perfectMatches = 0;
    let requiredCalls = 0;
    let invokedCalls = 0;
    let costCoveredCalls = 0;
    let knownCostUsd = 0;
    const wallClockSamples: number[] = [];
    const key = (model: BenchmarkModelRef) => `${model.provider}:${model.model}`;

    for (const document of runRecord.documents) {
      const results = new Map(
        runRecord.results
          .filter((result) => result.docId === document.docId)
          .map((result) => [`${result.provider}:${result.model}`, result]),
      );
      const resultA = results.get(key(lineup.a));
      const resultB = results.get(key(lineup.b));
      if (!resultA || !resultB) {
        requiredCalls += 2;
        for (const result of [resultA, resultB]) {
          if (!result?.invoked) continue;
          invokedCalls += 1;
          if (result.costUsd != null) {
            costCoveredCalls += 1;
            knownCostUsd += result.costUsd;
          }
        }
        incompleteDocuments += 1;
        continue;
      }
      const readA = persistedCandidate(resultA);
      const readB = persistedCandidate(resultB);
      const agreesAtTier1 = sameRowSet(readA, readB);
      const escalated = readA.ok && readB.ok && !agreesAtTier1;
      const resultC = escalated ? results.get(key(lineup.c as BenchmarkModelRef)) : undefined;
      const documentMetrics = simulateCascadeDocumentMetrics({
        a: resultA,
        b: resultB,
        c: resultC,
        escalated,
      });
      requiredCalls += documentMetrics.requiredCalls;
      invokedCalls += documentMetrics.invokedCalls;
      costCoveredCalls += documentMetrics.costCoveredCalls;
      knownCostUsd += documentMetrics.knownCostUsd;
      if ((escalated && !resultC) || documentMetrics.invokedCalls !== documentMetrics.requiredCalls) {
        incompleteDocuments += 1;
        continue;
      }
      if (documentMetrics.wallClockMs != null) wallClockSamples.push(documentMetrics.wallClockMs);

      documentsSimulated += 1;
      let publishedRows: ParsedTx[] | null = null;
      if (agreesAtTier1 && resultA.autonomous && resultB.autonomous) {
        tier1Published += 1;
        publishedRows = readA.rows;
      } else if (escalated && resultC) {
        const readC = persistedCandidate(resultC);
        const allAgree = sameRowSet(readA, readC) && sameRowSet(readB, readC);
        if (allAgree && [resultA, resultB, resultC].filter((result) => result.autonomous).length >= 2) {
          publishedRows = readA.rows;
        } else if ([resultA, resultB, resultC].filter((result) => result.autonomous).length >= 2) {
          publishedRows = consensusBenchmarkRows([readA, readB, readC]);
        }
      }
      if (publishedRows) cascadePublished += 1;
      if (document.resolved) {
        resolvedDocuments += 1;
        if (publishedRows) {
          autopublishedResolvedDocuments += 1;
          const comparison = compareBenchmarkRows(
            publishedRows as unknown as Array<Record<string, unknown>>,
            Array.isArray(document.groundTruth)
              ? document.groundTruth as Array<Record<string, unknown>>
              : [],
          );
          if (comparison.perfectMatch) perfectMatches += 1;
        }
      }
    }
    const latency = summarizeBenchmarkLatency(wallClockSamples.map((latencyMs) => ({
      invoked: true,
      latencyMs,
    })));
    const fullCostCoverage = requiredCalls > 0 && costCoveredCalls === requiredCalls;
    return c.json({
      runId: runRecord.id,
      chamber: runRecord.chamber,
      lineup,
      documentsTotal: runRecord.documents.length,
      documentsSimulated,
      incompleteDocuments,
      tier1AutonomyRate: documentsSimulated ? tier1Published / documentsSimulated : null,
      cascadeAutonomyRate: documentsSimulated ? cascadePublished / documentsSimulated : null,
      humanReviewRate: documentsSimulated ? (documentsSimulated - cascadePublished) / documentsSimulated : null,
      resolvedDocuments,
      autopublishedResolvedDocuments,
      perfectMatches,
      accuracyRate: autopublishedResolvedDocuments
        ? perfectMatches / autopublishedResolvedDocuments
        : null,
      endToEndPerfectRate: resolvedDocuments ? perfectMatches / resolvedDocuments : null,
      requiredCalls,
      invokedCalls,
      costCoveredCalls,
      costCoverageRate: requiredCalls ? costCoveredCalls / requiredCalls : null,
      knownCostUsd,
      actualCostPerDocumentUsd: fullCostCoverage && documentsSimulated
        ? knownCostUsd / documentsSimulated
        : null,
      avgWallClockMs: latency.averageMs,
      p50WallClockMs: latency.p50Ms,
      p95WallClockMs: latency.p95Ms,
    });
  });

  // --- Chamber-specific A/B/C agreement settings --------------------------
  r.get('/benchmark/settings/:chamber', async (c) => {
    const chamber = benchmarkChamber(c.req.param('chamber'));
    if (!chamber) return c.json({ error: 'invalid chamber' }, 400);
    return c.json({
      ...await readBenchmarkLineupSettings(c.env, chamber),
      writeProtected: isPreviewDeployment(c.env),
    });
  });

  r.put('/benchmark/settings/:chamber', async (c) => {
    const chamber = benchmarkChamber(c.req.param('chamber'));
    if (!chamber) return c.json({ error: 'invalid chamber' }, 400);
    if (isPreviewDeployment(c.env)) {
      return c.json({
        error: 'benchmark lineup settings are read-only in preview deployments',
        code: 'preview_write_protected',
      }, 403);
    }
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const sourceRunId = typeof body.sourceRunId === 'string' ? body.sourceRunId.trim() : '';
    const allowIncompleteBenchmarkEvidence = body.allowIncompleteBenchmarkEvidence === true;
    const sourceRun = sourceRunId ? await getBenchmarkRun(c.env.DB, sourceRunId) : null;
    if (sourceRunId && !sourceRun) return c.json({ error: 'source benchmark run not found' }, 404);
    if (sourceRun && sourceRun.chamber !== chamber) {
      return c.json({ error: 'source benchmark run belongs to a different chamber' }, 409);
    }
    if (sourceRun && sourceRun.status !== 'completed' && !allowIncompleteBenchmarkEvidence) {
      return c.json({ error: 'source benchmark run must be completed before saving its lineup' }, 409);
    }
    let lineup: BenchmarkSelectedLineup;
    try {
      lineup = validateBenchmarkLineup(body as unknown as {
        a: BenchmarkModelRef;
        b: BenchmarkModelRef;
        c: BenchmarkModelRef;
      });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
    let invalidModelCoverage: Array<Record<string, unknown>> = [];
    let unmeasured: BenchmarkModelRef[] = [];
    if (sourceRun) {
      const measured = new Set(sourceRun.models.map((model) => `${model.provider}:${model.model}`));
      unmeasured = [lineup.a, lineup.b, lineup.c as BenchmarkModelRef]
        .filter((model) => !measured.has(`${model.provider}:${model.model}`));
      if (unmeasured.length && !allowIncompleteBenchmarkEvidence) {
        return c.json({ error: 'selected models must be part of the source run', unmeasured }, 400);
      }
    }
    const selectedModels = [lineup.a, lineup.b, lineup.c as BenchmarkModelRef];
    invalidModelCoverage = sourceRun ? selectedModels.flatMap((model) => {
      const readings = sourceRun.results.filter(
        (result) => result.provider === model.provider && result.model === model.model,
      );
      const invoked = readings.filter((result) => result.invoked);
      const successful = invoked.filter((result) => result.ok);
      const autonomous = successful.filter((result) => result.autonomous);
      const scored = successful.filter((result) => result.perfectMatch != null);
      return readings.length === sourceRun.documents.length
        && invoked.length === sourceRun.documents.length
        && successful.length === sourceRun.documents.length
        && autonomous.length > 0
        && scored.length > 0
        ? []
        : [{
            model,
            requiredReadings: sourceRun.documents.length,
            measuredReadings: readings.length,
            invokedReadings: invoked.length,
            successfulReadings: successful.length,
            failedReadings: invoked.length - successful.length,
            autonomousReadings: autonomous.length,
            scoredReadings: scored.length,
          }];
    }) : [];
    if (invalidModelCoverage.length && !allowIncompleteBenchmarkEvidence) {
      return c.json({
        error: 'selected models require full successful coverage plus autonomous and scored evidence',
        invalidModelCoverage,
      }, 409);
    }
    let settingsLease: BenchmarkSettingsLease | null = null;
    try {
      settingsLease = await acquireBenchmarkSettingsLease(c.env.DB, chamber);
      const saved = await saveBenchmarkLineupSettings(c.env, {
        chamber,
        a: lineup.a,
        b: lineup.b,
        c: lineup.c as BenchmarkModelRef,
        expectedVersion: typeof body.expectedVersion === 'string' ? body.expectedVersion : '',
      }, {}, {
        operationTimeoutMs: 15_000,
        assertLease: () => assertBenchmarkSettingsLease(c.env.DB, settingsLease!),
      });
      const selectionAudit = {
        ...saved.audit,
        sourceRunId: sourceRunId || null,
        mode: sourceRunId ? (allowIncompleteBenchmarkEvidence ? 'benchmark_incomplete_override' : 'benchmark_supported') : 'manual',
        unmeasured,
        invalidModelCoverage,
        actor: adminActor(c),
      };
      const auditPersistence = sourceRunId ? await persistBenchmarkSelectionAudit(() =>
        recordBenchmarkSelection(c.env.DB, sourceRunId, {
          lineup,
          audit: selectionAudit,
        })) : { auditPersisted: false };
      return c.json({
        ok: true,
        settings: saved.settings,
        sourceRunId: sourceRunId || null,
        audit: selectionAudit,
        ...auditPersistence,
      });
    } catch (error) {
      if (error instanceof BenchmarkSettingsLeaseBusyError) {
        return c.json({
          error: error.message,
          code: 'benchmark_settings_update_in_progress',
          leaseUntil: error.leaseUntil,
          retryable: true,
        }, 409);
      }
      if (error instanceof BenchmarkSettingsConflictError) {
        return c.json({ error: error.message, current: error.current }, 409);
      }
      if (error instanceof BenchmarkSettingsValidationError) {
        return c.json({ error: error.message }, 400);
      }
      if (error instanceof BenchmarkSettingsWriteError) {
        const selectionAudit = {
          ...error.audit,
          sourceRunId: sourceRunId || null,
          actor: adminActor(c),
        };
        if (sourceRunId) {
          await recordBenchmarkSelection(c.env.DB, sourceRunId, {
            lineup,
            error: error.message,
            audit: selectionAudit,
          });
        }
        return c.json({ error: error.message, audit: selectionAudit }, 502);
      }
      throw error;
    } finally {
      if (settingsLease) {
        await releaseBenchmarkSettingsLease(c.env.DB, settingsLease).catch((error) => {
          console.error(
            'benchmark settings lease release failed',
            chamber,
            (error as Error).message,
          );
        });
      }
    }
  });

  // --- Chamber-specific PRIMARY/FAILOVER live-ingestion roles --------------
  r.get('/benchmark/roles/:chamber', async (c) => {
    const chamber = benchmarkChamber(c.req.param('chamber'));
    if (!chamber) return c.json({ error: 'invalid chamber' }, 400);
    return c.json({
      ...await readBenchmarkRoleSettings(c.env, chamber),
      writeProtected: isPreviewDeployment(c.env),
    });
  });

  r.put('/benchmark/roles/:chamber', async (c) => {
    const chamber = benchmarkChamber(c.req.param('chamber'));
    if (!chamber) return c.json({ error: 'invalid chamber' }, 400);
    if (isPreviewDeployment(c.env)) {
      return c.json({
        error: 'benchmark role settings are read-only in preview deployments',
        code: 'preview_write_protected',
      }, 403);
    }
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    let roles: BenchmarkSelectedRoles;
    try {
      roles = validateBenchmarkRoles(body as unknown as {
        primary: BenchmarkModelRef;
        failover: BenchmarkModelRef;
      });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
    let settingsLease: BenchmarkSettingsLease | null = null;
    try {
      settingsLease = await acquireBenchmarkSettingsLease(c.env.DB, chamber);
      const saved = await saveBenchmarkRoleSettings(c.env, {
        chamber,
        primary: roles.primary,
        failover: roles.failover,
        expectedVersion: typeof body.expectedVersion === 'string' ? body.expectedVersion : '',
      }, {}, {
        operationTimeoutMs: 15_000,
        assertLease: () => assertBenchmarkSettingsLease(c.env.DB, settingsLease!),
      });
      return c.json({
        ok: true,
        settings: saved.settings,
        audit: { ...saved.audit, actor: adminActor(c) },
      });
    } catch (error) {
      if (error instanceof BenchmarkSettingsLeaseBusyError) {
        return c.json({
          error: error.message,
          code: 'benchmark_settings_update_in_progress',
          leaseUntil: error.leaseUntil,
          retryable: true,
        }, 409);
      }
      if (error instanceof BenchmarkSettingsConflictError) {
        return c.json({ error: error.message, current: error.current }, 409);
      }
      if (error instanceof BenchmarkSettingsValidationError) {
        return c.json({ error: error.message }, 400);
      }
      if (error instanceof BenchmarkSettingsWriteError) {
        return c.json({
          error: error.message,
          audit: { ...error.audit, actor: adminActor(c) },
        }, 502);
      }
      throw error;
    } finally {
      if (settingsLease) {
        await releaseBenchmarkSettingsLease(c.env.DB, settingsLease).catch((error) => {
          console.error(
            'benchmark role settings lease release failed',
            chamber,
            (error as Error).message,
          );
        });
      }
    }
  });

  // --- GET /benchmark/ground-truth-docs (legacy compatibility) -------------
  r.get('/benchmark/ground-truth-docs', async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 200);
    const rawChamber = c.req.query('chamber');
    const chamber = rawChamber ? benchmarkChamber(rawChamber) : null;
    if (rawChamber && !chamber) return c.json({ error: 'invalid chamber' }, 400);
    let query = `SELECT f.doc_id, f.page_count, f.raw_bytes,
                        CASE WHEN ${benchmarkHumanResolvedSql('f.doc_id')} THEN 1 ELSE 0 END AS resolved
                   FROM filings f
                   LEFT JOIN review_queue rq ON f.doc_id = rq.doc_id
                  WHERE f.raw_object_key IS NOT NULL`;
    const params: Array<string | number> = [];
    if (chamber) {
      query += ' AND LOWER(f.chamber) = ?';
      params.push(chamber);
    }
    query += ' ORDER BY resolved DESC, f.filed_date DESC, f.doc_id DESC LIMIT ?';
    params.push(limit);
    const rows = await all<{ doc_id: string; resolved: number; page_count: number | null; raw_bytes: number | null }>(c.env.DB, query, params);
    return c.json({
      docs: rows.map((row) => ({ docId: row.doc_id, resolved: row.resolved === 1, pageCount: row.page_count, rawBytes: row.raw_bytes })),
      resolvedDocumentCount: rows.filter((row) => row.resolved === 1).length,
      documentCount: rows.length,
    });
  });

  // --- POST /benchmark/dry-run/:docId --------------------------------------
  // Legacy callers may omit runId. Durable benchmark clients pass runId; a
  // repeated run/doc/model cell returns its persisted result without another
  // paid provider request.
  r.post('/benchmark/dry-run/:docId', async (c) => {
    const docId = c.req.param('docId');
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if (
      body.confirmRetryAfterUnknownOutcome !== undefined
      && typeof body.confirmRetryAfterUnknownOutcome !== 'boolean'
    ) {
      return c.json({ error: 'confirmRetryAfterUnknownOutcome must be a boolean' }, 400);
    }
    if (body.confirmPaidRun !== undefined && typeof body.confirmPaidRun !== 'boolean') {
      return c.json({ error: 'confirmPaidRun must be a boolean' }, 400);
    }
    const models = body.models as { a?: BenchmarkModelRef; b?: BenchmarkModelRef; c?: BenchmarkModelRef } | undefined;
    if (!models?.a) return c.json({ error: 'models.a is required' }, 400);
    if (models.b) {
      // Preserve the pre-existing agreement dry-run contract. Durable benchmark
      // runs execute every model independently, then use /simulate.
      let agModels: AgreementModels;
      try {
        agModels = {
          a: validateBenchmarkModel(models.a, 'models.a'),
          b: validateBenchmarkModel(models.b, 'models.b'),
          c: models.c ? validateBenchmarkModel(models.c, 'models.c') : null,
        };
      } catch (error) {
        return c.json({ error: (error as Error).message }, 400);
      }
      const lineup = [agModels.a, agModels.b, ...(agModels.c ? [agModels.c] : [])];
      if (lineup.some(isOpenRouterAuto)) {
        return c.json({
          error: 'openrouter/auto cannot be used in agreement benchmarks because its routing is unpredictable',
        }, 400);
      }
      if (new Set(lineup.map((model) => `${model.provider}:${model.model}`)).size !== lineup.length) {
        return c.json({ error: 'agreement benchmark models must be distinct' }, 400);
      }
      const filing = await get<{ raw_object_key: string | null }>(
        c.env.DB,
        'SELECT raw_object_key FROM filings WHERE doc_id = ?',
        [docId],
      );
      if (!filing?.raw_object_key) return c.json({ error: 'not found or no raw obj' }, 404);
      const invocationPlans = await Promise.all(lineup.map(async (model) => ({
        model,
        apiKey: await keyFor(c.env, model.provider),
      })));
      const configuredModels = invocationPlans.filter((entry) => Boolean(entry.apiKey));
      const plannedCalls = configuredModels.length;
      if (plannedCalls > 0 && body.confirmPaidRun !== true) {
        return c.json({
          error: 'confirmPaidRun=true is required before reserving paid provider calls',
          requiresConfirmation: true,
          plannedCalls,
          configuredModels: configuredModels.map((entry) => entry.model),
        }, 409);
      }
      if (plannedCalls > 0) {
        try {
          await reserveBenchmarkCalls(c.env, plannedCalls);
        } catch (error) {
          const failure = benchmarkReservationFailure(error, plannedCalls);
          return c.json(failure.body, failure.status);
        }
      }
      return c.json(await processAgreementDoc(
        c.env,
        agModels,
        docId,
        filing.raw_object_key,
        true,
        undefined,
        { invocations: invocationPlans.map(({ apiKey }) => ({ apiKey })) },
      ));
    }
    let candidate: BakeoffCandidate;
    try {
      candidate = validateBenchmarkModel(models.a, 'models.a');
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }

    const runId = typeof body.runId === 'string' ? body.runId.trim() : '';
    let claimToken: string | undefined;
    let unknownPriorAttempt = false;
    let configured = false;
    let invocationKey: string | null = null;
    let runRecord: BenchmarkRunDetail | null = null;
    let snapshot: BenchmarkRunDetail['documents'][number] | null = null;
    if (runId) {
      runRecord = await getBenchmarkRun(c.env.DB, runId);
      if (!runRecord) return c.json({ error: 'benchmark run not found' }, 404);
      snapshot = runRecord.documents.find((document) => document.docId === docId) ?? null;
      if (!snapshot) return c.json({ error: 'document is not part of this benchmark run' }, 409);
      if (!runRecord.models.some((model) => model.provider === candidate.provider && model.model === candidate.model)) {
        return c.json({ error: 'model is not part of this benchmark run' }, 409);
      }
      const existing = runRecord.results.find((result) =>
        result.docId === docId
          && result.provider === candidate.provider
          && result.model === candidate.model,
      );
      if (existing && existing.outcome !== 'running') {
        return c.json(cachedBenchmarkCellPayload(runId, snapshot, existing));
      }
      if (runRecord.status !== 'running') {
        return c.json({ error: `benchmark run is ${runRecord.status}` }, 409);
      }

      const providerFailureBlock = findProviderFailureBlock(runRecord.results, candidate);
      if (providerFailureBlock) {
        await fillBenchmarkProviderFailure(c.env.DB, runRecord, candidate, providerFailureBlock);
        const refreshed = await getBenchmarkRun(c.env.DB, runId);
        const blockedCell = refreshed?.results.find((result) =>
          result.docId === docId
            && result.provider === candidate.provider
            && result.model === candidate.model
            && result.outcome !== 'running',
        );
        if (blockedCell) {
          return c.json(cachedBenchmarkCellPayload(runId, snapshot, blockedCell));
        }
        // An in-flight claim wins the INSERT ... DO NOTHING race. Never start
        // another provider request; let the client poll until that owner saves.
        return c.json({
          runId,
          docId,
          pending: true,
          state: 'provider_failure_blocked',
          failure: providerFailureBlock.failure,
          blockedBy: providerFailureBlock.source,
          retryAfterMs: 2_000,
        }, 202);
      }

      const canary = benchmarkCanaryTarget(
        runRecord.documents,
        runRecord.results,
        runRecord.models,
        candidate,
      );
      if (canary && (
        canary.docId !== docId
        || canary.provider !== candidate.provider
        || canary.model !== candidate.model
      )) {
        return c.json({
          runId,
          docId,
          pending: true,
          state: canary.scope === 'provider' ? 'provider_canary' : 'model_canary',
          canaryDocId: canary.docId,
          canaryModel: { provider: canary.provider, model: canary.model },
          retryAfterMs: 1_000,
        }, 202);
      }
      invocationKey = await keyFor(c.env, candidate.provider);
      configured = Boolean(invocationKey);
      const initiallyAuthorized = benchmarkRunAuthorizesInitialCell(runRecord, candidate);
      const needsFreshReservationConfirmation = !existing && configured && !initiallyAuthorized;
      if (needsFreshReservationConfirmation) {
        if (body.confirmPaidRun !== true) {
          return c.json({
            error: 'this run cell has no paid-call reservation; confirmPaidRun=true is required',
            code: 'benchmark_cell_reservation_required',
            requiresConfirmation: true,
            plannedCalls: 1,
          }, 409);
        }
      }

      let claim = await claimBenchmarkMeasurement(c.env.DB, {
        runId,
        docId,
        provider: candidate.provider,
        model: candidate.model,
        allowRetryAfterUnknownOutcome: false,
      });
      if (claim.state === 'inactive') {
        return c.json({ error: 'benchmark run is no longer running' }, 409);
      }
      if (!claim.claimed && claim.state === 'orphaned') {
        if (body.confirmRetryAfterUnknownOutcome !== true) {
          return c.json({
            error: 'the prior paid attempt expired with an unknown provider outcome',
            code: 'benchmark_attempt_outcome_unknown',
            runId,
            docId,
            state: claim.state,
            leaseUntil: claim.leaseUntil,
            requiresRetryConfirmation: true,
          }, 409);
        }
        // The run's original reservation authorizes only its first attempt.
        // A confirmed retry is a new possible provider charge. Claim first so
        // concurrent delivery cannot reserve the same retry more than once.
        claim = await claimBenchmarkMeasurement(c.env.DB, {
          runId,
          docId,
          provider: candidate.provider,
          model: candidate.model,
          allowRetryAfterUnknownOutcome: true,
        });
        if (claim.state === 'inactive') {
          return c.json({ error: 'benchmark run is no longer running' }, 409);
        }
      }
      if (!claim.claimed || !claim.claimToken) {
        return c.json({
          runId,
          docId,
          pending: true,
          state: claim.state,
          leaseUntil: claim.leaseUntil,
          retryAfterMs: 2_000,
        }, 202);
      }
      claimToken = claim.claimToken;
      unknownPriorAttempt = claim.reclaimedUnknownOutcome;
      // A stale concurrent read may have observed another worker's running row
      // just before that worker released an unreserved claim. Re-check the
      // confirmation after owning the cell so that race cannot bypass consent.
      if (
        configured
        && !initiallyAuthorized
        && !unknownPriorAttempt
        && body.confirmPaidRun !== true
      ) {
        await releaseBenchmarkMeasurementClaim(c.env.DB, {
          runId,
          docId,
          provider: candidate.provider,
          model: candidate.model,
          claimToken,
          preserveUnknownOutcome: false,
        });
        return c.json({
          error: 'this run cell has no paid-call reservation; confirmPaidRun=true is required',
          code: 'benchmark_cell_reservation_required',
          requiresConfirmation: true,
          plannedCalls: 1,
        }, 409);
      }
      if (configured && (!initiallyAuthorized || unknownPriorAttempt)) {
        try {
          await reserveBenchmarkCalls(c.env, 1);
        } catch (error) {
          await releaseBenchmarkMeasurementClaim(c.env.DB, {
            runId,
            docId,
            provider: candidate.provider,
            model: candidate.model,
            claimToken,
            preserveUnknownOutcome: unknownPriorAttempt,
          });
          const failure = benchmarkReservationFailure(error, 1);
          return c.json(failure.body, failure.status);
        }
      }
    } else {
      invocationKey = await keyFor(c.env, candidate.provider);
      configured = Boolean(invocationKey);
      if (configured && body.confirmPaidRun !== true) {
        return c.json({
          error: 'confirmPaidRun=true is required before reserving paid provider calls',
          requiresConfirmation: true,
          plannedCalls: 1,
          configuredModels: [candidate],
        }, 409);
      }
      if (configured) {
        try {
          await reserveBenchmarkCalls(c.env, 1);
        } catch (error) {
          const failure = benchmarkReservationFailure(error, 1);
          return c.json(failure.body, failure.status);
        }
      }
    }

    const costForPersistence = (measured: ReturnType<typeof priceBenchmarkUsage>) =>
      unknownPriorAttempt
        ? {
            costUsd: null,
            costSource: 'unknown' as const,
            costDetail: {
              ...measured.costDetail,
              pricingBasis: null,
              unknownReason: 'prior_attempt_outcome_unknown',
              knownRetryAttemptCostUsd: measured.costUsd,
            },
          }
        : measured;

    const filing = await get<{ raw_object_key: string | null }>(
      c.env.DB,
      'SELECT raw_object_key FROM filings WHERE doc_id = ?',
      [docId],
    );
    if (!filing?.raw_object_key) {
      if (runId) {
        const cost = priceBenchmarkUsage({
          provider: candidate.provider,
          model: candidate.model,
          invoked: false,
        });
        const persistedCost = costForPersistence(cost);
        await saveBenchmarkMeasurement(c.env.DB, {
          runId,
          docId,
          provider: candidate.provider,
          model: candidate.model,
          invoked: unknownPriorAttempt,
          ok: false,
          outcome: 'skipped',
          autonomous: false,
          error: 'filing_or_raw_object_missing',
          rowCount: 0,
          latencyMs: null,
          costUsd: persistedCost.costUsd,
          costSource: persistedCost.costSource,
          costDetail: persistedCost.costDetail,
          result: { rows: [], flags: [] },
          perfectMatch: null,
          claimToken,
        });
        return c.json({
          runId,
          docId,
          outcome: 'skipped',
          reason: 'filing_or_raw_object_missing',
          ok: false,
          invoked: unknownPriorAttempt,
          rowCount: 0,
          rows: [],
          latencyMs: null,
          costUsd: persistedCost.costUsd,
          costSource: persistedCost.costSource,
          costDetail: persistedCost.costDetail,
        });
      }
      return c.json({ error: 'not found or no raw obj' }, 404);
    }
    const loaded = await loadDocBytes(c.env, docId, filing.raw_object_key);
    if ('skip' in loaded) {
      const reason = 'reason' in loaded.skip ? String(loaded.skip.reason) : 'document_load_failed';
      const cost = priceBenchmarkUsage({
        provider: candidate.provider,
        model: candidate.model,
        invoked: false,
      });
      const persistedCost = costForPersistence(cost);
      if (runId) {
        await saveBenchmarkMeasurement(c.env.DB, {
          runId,
          docId,
          provider: candidate.provider,
          model: candidate.model,
          invoked: unknownPriorAttempt,
          ok: false,
          outcome: 'skipped',
          autonomous: false,
          error: reason,
          rowCount: 0,
          latencyMs: null,
          costUsd: persistedCost.costUsd,
          costSource: persistedCost.costSource,
          costDetail: persistedCost.costDetail,
          result: { rows: [], flags: [] },
          perfectMatch: null,
          claimToken,
        });
      }
      return c.json({
        ...loaded.skip,
        runId: runId || null,
        ok: false,
        invoked: unknownPriorAttempt,
        rowCount: 0,
        rows: [],
        latencyMs: null,
        costUsd: persistedCost.costUsd,
        costSource: persistedCost.costSource,
        costDetail: persistedCost.costDetail,
      });
    }

    const startedAt = new Date().toISOString();
    const read = await runCandidateOnDoc(c.env, candidate, docId, loaded.bytes, {
      apiKey: invocationKey,
      skipCache: true,
    });
    const completedAt = new Date().toISOString();
    const cost = priceBenchmarkUsage({
      provider: candidate.provider,
      model: candidate.model,
      resolvedModel: read.resolvedModel ?? null,
      invoked: configured,
      usage: read.usage,
    });
    const persistedCost = costForPersistence(cost);
    const invocationPossible = configured || unknownPriorAttempt;
    // Request-attempt telemetry is emitted by trackedFetch inside the adapter;
    // these awaited events add the provider-reported billed units and the
    // measured, rate-card-priced dollars for this exact benchmark read.
    await pushExtractionTelemetry(c.env, read, 'benchmark');
    if (cost.costUsd != null && !benchmarkUsageHasProviderReportedCost(read.usage)) {
      await recordMeasuredThirdPartyUsage(c.env, {
        provider: candidate.provider,
        service: 'benchmark',
        operation: 'benchmark-cost',
        model: read.resolvedModel ?? candidate.model,
        metricType: 'cost',
        quantity: cost.costUsd,
        unit: 'usd',
        costUsd: cost.costUsd,
        billingMode: 'actual',
        confidence: 'actual',
        metadata: {
          costSource: cost.costSource,
          benchmarkRunId: runId || null,
        },
      });
    }
    const groundTruth = snapshot?.resolved
      ? Array.isArray(snapshot.groundTruth) ? snapshot.groundTruth as BenchmarkGroundTruthTx[] : []
      : runRecord
        ? null
        : await benchmarkDocumentIsHumanResolved(c.env, docId)
          ? await loadBenchmarkGroundTruth(c.env, docId)
          : null;

    if (!read.ok) {
      // Provider/account failures are reliability failures, not OCR readings.
      // Keep them out of the accuracy/F1 denominator; docsOk/failures reports
      // end-to-end availability separately.
      const comparison = null;
      const providerFailure = read.failure;
      const storedError = providerFailure?.code ?? read.error ?? 'read_failed';
      if (runId) {
        await saveBenchmarkMeasurement(c.env.DB, {
          runId,
          docId,
          provider: candidate.provider,
          model: candidate.model,
          resolvedModel: read.resolvedModel ?? null,
          invoked: invocationPossible,
          ok: false,
          outcome: 'skipped',
          autonomous: false,
          error: storedError,
          rowCount: 0,
          avgConfidence: read.avgConfidence,
          latencyMs: configured ? read.latencyMs : null,
          costUsd: persistedCost.costUsd,
          costSource: persistedCost.costSource,
          costDetail: persistedCost.costDetail,
          providerRequestId: read.providerRequestId ?? null,
          usage: read.usage,
          result: {
            rows: [],
            flags: [],
            ...(providerFailure ? { failure: providerFailure } : {}),
          },
          perfectMatch: null,
          truePositive: null,
          falsePositive: null,
          falseNegative: null,
          startedAt,
          completedAt,
          claimToken,
        });
        if (providerFailure && runRecord) {
          await fillBenchmarkProviderFailure(c.env.DB, runRecord, candidate, {
            failure: providerFailure,
            source: { provider: candidate.provider, model: candidate.model, docId },
          });
        }
      }
      return c.json({
        runId: runId || null,
        docId,
        outcome: 'skipped',
        reason: 'read_failed',
        error: providerFailure?.message ?? read.error,
        ...(providerFailure ? { failure: providerFailure } : {}),
        rowCount: 0,
        rows: [],
        comparison,
        groundTruth,
        ok: false,
        invoked: invocationPossible,
        latencyMs: configured ? read.latencyMs : null,
        usage: read.usage,
        costUsd: persistedCost.costUsd,
        costSource: persistedCost.costSource,
        costDetail: persistedCost.costDetail,
        resolvedModel: read.resolvedModel ?? null,
        providerRequestId: read.providerRequestId ?? null,
      });
    }

    const filingRow = await loadFilingRow(c.env, docId);
    if (!filingRow) {
      const comparison = null;
      if (runId) {
        await saveBenchmarkMeasurement(c.env.DB, {
          runId,
          docId,
          provider: candidate.provider,
          model: candidate.model,
          resolvedModel: read.resolvedModel ?? null,
          invoked: invocationPossible,
          ok: false,
          outcome: 'skipped',
          autonomous: false,
          error: 'filing_disappeared',
          rowCount: 0,
          avgConfidence: read.avgConfidence,
          latencyMs: configured ? read.latencyMs : null,
          costUsd: persistedCost.costUsd,
          costSource: persistedCost.costSource,
          costDetail: persistedCost.costDetail,
          providerRequestId: read.providerRequestId ?? null,
          usage: read.usage,
          result: { rows: read.rows, flags: [] },
          perfectMatch: null,
          truePositive: null,
          falsePositive: null,
          falseNegative: null,
          startedAt,
          completedAt,
          claimToken,
        });
      }
      return c.json({
        runId: runId || null,
        docId,
        outcome: 'skipped',
        reason: 'filing_disappeared',
        ok: false,
        invoked: invocationPossible,
        rowCount: 0,
        rows: [],
        comparison,
        groundTruth,
        latencyMs: configured ? read.latencyMs : null,
        usage: read.usage,
        costUsd: persistedCost.costUsd,
        costSource: persistedCost.costSource,
        costDetail: persistedCost.costDetail,
        resolvedModel: read.resolvedModel ?? null,
        providerRequestId: read.providerRequestId ?? null,
      });
    }
    const flagged = await recomputeTransactions(c.env, mapFiling(filingRow), read.rows);
    const blockingFlagSet = new Set<string>(HARD_FAILURE_FLAGS);
    const hardFlags = Array.from(new Set(
      flagged.flatMap((result) => result.flags).filter((flag) => blockingFlagSet.has(flag)),
    ));
    const flags = hardFlags.length
      ? hardFlags
      : flagged.length > 200
        ? ['row_limit_exceeded']
        : [];
    const outcome = flags.length ? 'agree_but_hardfail' : 'would_publish';
    const rows = flagged.map((result) => result.tx);
    // Agreement/autobuild autonomy means this read can clear structural
    // validation without a human. Vision confidence is deliberately capped at
    // 0.60 elsewhere, because cross-vendor agreement (not a single model's
    // self-reported confidence) is what authorizes production auto-publish.
    const autonomous = benchmarkReadIsAutonomous(outcome, rows.length);
    const comparison = groundTruth === null
      ? null
      : compareBenchmarkRows(
          rows as unknown as Array<Record<string, unknown>>,
          groundTruth as unknown as Array<Record<string, unknown>>,
        );
    if (runId) {
      await saveBenchmarkMeasurement(c.env.DB, {
        runId,
        docId,
        provider: candidate.provider,
        model: candidate.model,
        resolvedModel: read.resolvedModel ?? null,
        invoked: invocationPossible,
        ok: true,
        outcome,
        autonomous,
        rowCount: rows.length,
        avgConfidence: read.avgConfidence,
        latencyMs: configured ? read.latencyMs : null,
        costUsd: persistedCost.costUsd,
        costSource: persistedCost.costSource,
        costDetail: persistedCost.costDetail,
        providerRequestId: read.providerRequestId ?? null,
        usage: read.usage,
        result: { rows, flags },
        perfectMatch: comparison?.perfectMatch ?? null,
        truePositive: comparison?.tp ?? null,
        falsePositive: comparison?.fp ?? null,
        falseNegative: comparison?.fn ?? null,
        startedAt,
        completedAt,
        claimToken,
      });
    }
    return c.json({
      runId: runId || null,
      docId,
      outcome,
      ...(flags.length ? { flags } : {}),
      rowCount: rows.length,
      rows,
      comparison,
      groundTruth,
      ok: true,
      invoked: invocationPossible,
      latencyMs: configured ? read.latencyMs : null,
      usage: read.usage,
      costUsd: persistedCost.costUsd,
      costSource: persistedCost.costSource,
      costDetail: persistedCost.costDetail,
      resolvedModel: read.resolvedModel ?? null,
      providerRequestId: read.providerRequestId ?? null,
    });
  });

  // --- POST /debug-sql -----------------------------------------------------
  // Development ONLY tool for running arbitrary sql queries to debug state.
  // Fails closed in production: a stolen/XSS'd admin session must not turn
  // into arbitrary SQL against the live database (2026-08-31 full-stack audit).
  r.post('/debug-sql', async (c) => {
    if (await isProductionEnvironment(c.env as EnvWithAdmin)) {
      return c.json({ error: 'debug-sql is disabled in production' }, 403);
    }
    const { query, params = [] } = (await c.req.json().catch(() => ({}))) as { query?: string; params?: any[] };
    if (!query) {
      return c.json({ error: 'query is required' }, 400);
    }

    try {
      const results = await all(c.env.DB, query, params);
      return c.json({ ok: true, results });
    } catch (err: any) {
      return c.json({ ok: false, error: err.message }, 500);
    }
  });

  // --- POST /migrate ------------------------------------------------------
  // Apply schema changes via the Worker's D1 binding (sidesteps the wrangler
  // CLI's --remote D1 auth issues). Idempotent: "duplicate column" is treated
  // as already-applied. ANY other SQL error is fatal: the route returns 500 with a
  // structured failed[] list and a checkReadiness() schema postcondition, so
  // scripts/ship.sh aborts the deploy instead of reporting a green migration.
  const MIGRATE_IDEMPOTENT_ERROR_PATTERNS: readonly RegExp[] = [
    /duplicate column name/i,
    /\b(?:table|index|trigger|view)\s+\S+\s+already exists/i,
  ];

  function isIdempotentMigrationError(message: string): boolean {
    return MIGRATE_IDEMPOTENT_ERROR_PATTERNS.some((re) => re.test(message));
  }

  r.post('/migrate', async (c) => {
    const statements = [
      ...BASE_SCHEMA_STATEMENTS,
      'ALTER TABLE filers ADD COLUMN photo_url TEXT',
      // 0003_users.sql — end-user accounts (public-site auth). Idempotent.
      `CREATE TABLE IF NOT EXISTS users (
         id             TEXT PRIMARY KEY,
         email          TEXT NOT NULL UNIQUE,
         name           TEXT,
         picture        TEXT,
         google_sub     TEXT UNIQUE,
         email_verified INTEGER NOT NULL DEFAULT 0,
         created_at     TEXT NOT NULL,
         last_login_at  TEXT
       )`,
      'CREATE INDEX IF NOT EXISTS idx_users_email ON users (email)',
      // 0004_billing.sql — Stripe billing columns on users. Idempotent.
      'ALTER TABLE users ADD COLUMN stripe_customer_id TEXT',
      'ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT',
      'ALTER TABLE users ADD COLUMN subscription_status TEXT',
      'ALTER TABLE users ADD COLUMN plan TEXT',
      'ALTER TABLE users ADD COLUMN current_period_end TEXT',
      'ALTER TABLE users ADD COLUMN cancel_at_period_end INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE users ADD COLUMN trial_end TEXT',
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_stripe_customer ON users (stripe_customer_id)',
      // 0005_securities_ref.sql — asset reference data (sector, market cap, …).
      `CREATE TABLE IF NOT EXISTS securities_ref (
         ticker            TEXT PRIMARY KEY,
         company_name      TEXT, sector TEXT, industry TEXT, asset_class TEXT,
         is_etf INTEGER NOT NULL DEFAULT 0, is_adr INTEGER NOT NULL DEFAULT 0,
         country TEXT, state_hq TEXT, state_of_incorp TEXT,
         exchange TEXT, exchange_short TEXT, currency TEXT,
         market_cap INTEGER, market_cap_bucket TEXT, ipo_date TEXT,
         cik TEXT, sic_code TEXT, sic_description TEXT,
         source TEXT, enriched_at TEXT, enrichment_error TEXT
       )`,
      'CREATE INDEX IF NOT EXISTS idx_secref_sector ON securities_ref (sector)',
      'CREATE INDEX IF NOT EXISTS idx_secref_bucket ON securities_ref (market_cap_bucket)',
      'CREATE INDEX IF NOT EXISTS idx_secref_enriched ON securities_ref (enriched_at)',
      // 0006_prices.sql — price history + per-trade performance vs S&P 500.
      `CREATE TABLE IF NOT EXISTS price_eod (
         ticker TEXT NOT NULL, date TEXT NOT NULL, close REAL NOT NULL,
         PRIMARY KEY (ticker, date)
       )`,
      'CREATE INDEX IF NOT EXISTS idx_price_eod_ticker_date ON price_eod (ticker, date DESC)',
      'CREATE TABLE IF NOT EXISTS spx_eod (date TEXT PRIMARY KEY, close REAL NOT NULL)',
      `CREATE TABLE IF NOT EXISTS tx_performance (
         tx_id TEXT PRIMARY KEY, price_at_trade REAL, spx_at_trade REAL, computed_at TEXT
       )`,
      'ALTER TABLE securities_ref ADD COLUMN current_price REAL',
      'ALTER TABLE securities_ref ADD COLUMN current_price_date TEXT',
      // 0007_market_extras.sql — daily volume + insider / short-volume datasets.
      'ALTER TABLE price_eod ADD COLUMN volume INTEGER',
      `CREATE TABLE IF NOT EXISTS insider_eod (
         ticker TEXT NOT NULL, date TEXT NOT NULL, sentiment REAL,
         buy_filings INTEGER, sell_filings INTEGER, buy_shares REAL, sell_shares REAL,
         owners TEXT, PRIMARY KEY (ticker, date)
       )`,
      `CREATE TABLE IF NOT EXISTS short_volume_eod (
         ticker TEXT NOT NULL, date TEXT NOT NULL, short_volume_ratio REAL,
         elevated INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (ticker, date)
       )`,
      // 0008_idempotency_keys.sql — at-least-once retry guards.
      'ALTER TABLE transactions ADD COLUMN row_key TEXT',
      // NOTE: the strict idx_transactions_doc_source_rowkey that 0008 created
      // is deliberately NOT replayed here. A later statement in this same list
      // (REVIEW_AGREEMENT_SUPPRESSION_SCHEMA_STATEMENTS) supersedes it with
      // idx_transactions_live_doc_source_rowkey — which additionally requires
      // deprecated_at IS NULL — and then DROPs this one. Recreating it on every
      // run was dead work that also throws "UNIQUE constraint failed" whenever a
      // deprecated row shares (doc_id, source, row_key) with a live one, which
      // is precisely why it was superseded. Harmless while /migrate swallowed
      // errors; since that route fails closed it would 500 the whole migration
      // and block the deploy.
      `DELETE FROM deliveries
         WHERE rowid NOT IN (
           SELECT MAX(rowid)
             FROM deliveries
            GROUP BY subscription_id, tx_id
         )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_subscription_tx
         ON deliveries (subscription_id, tx_id)`,
      // 0009_client_api.sql — shared PWA / SwiftUI client state.
      `CREATE TABLE IF NOT EXISTS user_preferences (
         user_id TEXT PRIMARY KEY,
         saved_filters TEXT NOT NULL DEFAULT '{}',
         watchlist TEXT NOT NULL DEFAULT '[]',
         notification_settings TEXT NOT NULL DEFAULT '{}',
         default_window TEXT,
         updated_at TEXT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS client_commands (
         id TEXT PRIMARY KEY,
         user_id TEXT NOT NULL,
         type TEXT NOT NULL,
         status TEXT NOT NULL,
         idempotency_key TEXT,
         payload TEXT NOT NULL DEFAULT '{}',
         result TEXT,
         error TEXT,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         started_at TEXT,
         finished_at TEXT
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_client_commands_user_idempotency
         ON client_commands (user_id, idempotency_key)
         WHERE idempotency_key IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_client_commands_user_created
         ON client_commands (user_id, created_at DESC)`,
      'CREATE INDEX IF NOT EXISTS idx_client_commands_status ON client_commands (status)',
      // 0010_fundamentals.sql — sibling-app fundamentals + analyst consensus cache.
      `CREATE TABLE IF NOT EXISTS fundamentals_eod (
         ticker TEXT NOT NULL, date TEXT NOT NULL, pe_ratio REAL, eps REAL, beta REAL,
         dividend_yield REAL, week52_high REAL, week52_low REAL, fcf_yield REAL,
         debt_to_equity REAL, eps_growth REAL, source TEXT, updated_at TEXT NOT NULL,
         PRIMARY KEY (ticker, date)
       )`,
      `CREATE TABLE IF NOT EXISTS analyst_consensus (
         ticker TEXT NOT NULL, date TEXT NOT NULL, rating TEXT, target_mean REAL,
         target_high REAL, target_low REAL, target_median REAL, analyst_count INTEGER,
         strong_buy INTEGER, buy INTEGER, hold INTEGER, sell INTEGER, strong_sell INTEGER,
         source TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (ticker, date)
       )`,
      // 0011_transaction_row_details.sql — row-specific House PTR details.
      'ALTER TABLE transactions ADD COLUMN asset_type_name TEXT',
      'ALTER TABLE transactions ADD COLUMN filing_status TEXT',
      'ALTER TABLE transactions ADD COLUMN subholding TEXT',
      'ALTER TABLE transactions ADD COLUMN location TEXT',
      'ALTER TABLE transactions ADD COLUMN description TEXT',
      'ALTER TABLE transactions ADD COLUMN supplemental_text TEXT',
      'CREATE INDEX IF NOT EXISTS idx_tx_asset_type_name ON transactions (asset_type_name)',
      // 0012_shares_outstanding.sql — keep market cap current off the daily close.
      'ALTER TABLE securities_ref ADD COLUMN shares_outstanding REAL',
      `UPDATE securities_ref SET shares_outstanding = market_cap / current_price
         WHERE shares_outstanding IS NULL AND market_cap IS NOT NULL
           AND current_price IS NOT NULL AND current_price > 0`,
      // 0013_tx_deprecation.sql — soft-delete so admins can un-publish filings.
      'ALTER TABLE transactions ADD COLUMN deprecated_at TEXT',
      'ALTER TABLE transactions ADD COLUMN deprecated_reason TEXT',
      'CREATE INDEX IF NOT EXISTS idx_tx_deprecated_at ON transactions (deprecated_at)',
      // 0014_tx_perf_filing_anchors.sql — disclosure-date performance anchors.
      'ALTER TABLE tx_performance ADD COLUMN price_at_filing REAL',
      'ALTER TABLE tx_performance ADD COLUMN spx_at_filing REAL',
      // 0015_extraction_runs.sql — per-doc per-model extraction results (bake-off + review dashboard).
      `CREATE TABLE IF NOT EXISTS extraction_runs (
         id TEXT PRIMARY KEY, batch_id TEXT, doc_id TEXT NOT NULL,
         provider TEXT NOT NULL, model TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'bakeoff',
         ok INTEGER NOT NULL DEFAULT 0, error TEXT, row_count INTEGER NOT NULL DEFAULT 0,
         latency_ms INTEGER, avg_confidence REAL, result_json TEXT, created_at TEXT NOT NULL)`,
      'CREATE INDEX IF NOT EXISTS idx_extraction_runs_doc ON extraction_runs (doc_id)',
      'CREATE INDEX IF NOT EXISTS idx_extraction_runs_batch ON extraction_runs (batch_id)',
      'CREATE INDEX IF NOT EXISTS idx_extraction_runs_created ON extraction_runs (created_at)',
      // 0016_batch_jobs.sql — async batch reprocessing jobs (cheaper backlog path).
      `CREATE TABLE IF NOT EXISTS batch_jobs (
         id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL,
         provider_batch_id TEXT, doc_ids TEXT NOT NULL, status TEXT NOT NULL,
         submitted_at TEXT NOT NULL, completed_at TEXT, turnaround_ms INTEGER,
         result_summary TEXT, error TEXT)`,
      'CREATE INDEX IF NOT EXISTS idx_batch_jobs_status ON batch_jobs (status)',
      'CREATE INDEX IF NOT EXISTS idx_batch_jobs_submitted ON batch_jobs (submitted_at)',
      // 0017_fb_meta_remap.sql — Facebook's old "FB" ticker was reassigned by the
      // SEC to a ProShares ETF after Meta moved to "META", so congressional FB
      // trades were showing the ProShares name. Remap stored FB rows to META and
      // fix the cached names. Idempotent (UPDATEs).
      "UPDATE transactions SET ticker = 'META' WHERE ticker = 'FB' AND deprecated_at IS NULL",
      "UPDATE securities_ref SET company_name = 'Meta Platforms, Inc.' WHERE ticker = 'META' AND (company_name IS NULL OR company_name = '' OR company_name LIKE '%ProShares%')",
      "UPDATE securities_master SET name = 'Meta Platforms, Inc.' WHERE ticker = 'META'",
      // 0018_agreement_attempted.sql — one autonomous agreement attempt per review doc.
      'ALTER TABLE review_queue ADD COLUMN agreement_attempted_at TEXT',
      'CREATE INDEX IF NOT EXISTS idx_review_queue_agreement ON review_queue (agreement_attempted_at)',
      // 0019_ingestion_decisions.sql — append-only audit trail for publication/review decisions.
      `CREATE TABLE IF NOT EXISTS ingestion_decisions (
         id TEXT PRIMARY KEY,
         doc_id TEXT NOT NULL,
         action TEXT NOT NULL,
         source TEXT NOT NULL,
         actor TEXT,
         reason TEXT,
         payload TEXT,
         transaction_ids TEXT NOT NULL DEFAULT '[]',
         created_at TEXT NOT NULL
       )`,
      'CREATE INDEX IF NOT EXISTS idx_ingestion_decisions_doc ON ingestion_decisions (doc_id, created_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_ingestion_decisions_created ON ingestion_decisions (created_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_ingestion_decisions_action ON ingestion_decisions (action, created_at DESC)',
      // 0020_disclosure_available_generated.sql — generated column for disclosure availability.
      ...DISCLOSURE_AVAILABLE_SCHEMA_STATEMENTS,
      // 0021_disclosure_latency_watch.sql — congress.trade-vs-FMP disclosure race monitor.
      `CREATE TABLE IF NOT EXISTS disclosure_latency_candidates (
         doc_id TEXT NOT NULL,
         provider TEXT NOT NULL DEFAULT 'fmp',
         chamber TEXT NOT NULL,
         source_url TEXT,
         filed_date TEXT,
         filer_name TEXT,
         congress_first_seen_at TEXT NOT NULL,
         provider_key TEXT,
         provider_first_seen_at TEXT,
         provider_published_at TEXT,
         match_method TEXT,
         status TEXT NOT NULL DEFAULT 'pending',
         attempts INTEGER NOT NULL DEFAULT 0,
         last_checked_at TEXT,
         error TEXT,
         payload TEXT,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         PRIMARY KEY (doc_id, provider)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_disc_latency_candidates_status
         ON disclosure_latency_candidates (provider, status, created_at DESC)`,
      `CREATE TABLE IF NOT EXISTS disclosure_provider_observations (
         provider TEXT NOT NULL,
         chamber TEXT NOT NULL,
         provider_key TEXT NOT NULL,
         first_observed_at TEXT NOT NULL,
         last_observed_at TEXT NOT NULL,
         provider_published_at TEXT,
         source_url TEXT,
         filed_date TEXT,
         filer_name TEXT,
         payload TEXT,
         PRIMARY KEY (provider, chamber, provider_key)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_disc_provider_seen
         ON disclosure_provider_observations (provider, chamber, first_observed_at DESC)`,
      // 0022_stripe_webhook_events.sql — durable Stripe webhook idempotency ledger.
      `CREATE TABLE IF NOT EXISTS stripe_webhook_events (
         event_id TEXT PRIMARY KEY,
         event_type TEXT NOT NULL,
         received_at TEXT NOT NULL,
         processed_at TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_received
         ON stripe_webhook_events (received_at DESC)`,
      // 0023_disclosure_provider_timestamps.sql — provider-side publish/upload timestamp when available.
      'ALTER TABLE disclosure_latency_candidates ADD COLUMN provider_published_at TEXT',
      'ALTER TABLE disclosure_provider_observations ADD COLUMN provider_published_at TEXT',
      // 0024_dead_letter_events.sql — operator log for terminally-failed queue messages.
      `CREATE TABLE IF NOT EXISTS dead_letter_events (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         queue TEXT NOT NULL,
         msg_type TEXT,
         doc_id TEXT,
         tx_id TEXT,
         attempts INTEGER,
         error TEXT,
         created_at TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_dead_letter_created ON dead_letter_events(created_at)`,
      // 0087_latency_price_snapshots.sql
      `CREATE TABLE IF NOT EXISTS latency_price_snapshots (
         trade_hash TEXT NOT NULL,
         ticker TEXT NOT NULL,
         provider TEXT NOT NULL,
         event TEXT NOT NULL,
         due_at TEXT NOT NULL,
         captured_at TEXT,
         price REAL,
         source TEXT,
         error TEXT,
         created_at TEXT NOT NULL,
         PRIMARY KEY (trade_hash, provider, event)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_latency_price_due ON latency_price_snapshots (captured_at, due_at)`,
      // 0025_amendment_trump_deprecation.sql — soft-deprecate unamended Trump report rows superseded by amendment.
      `UPDATE transactions
          SET deprecated_at = '2026-07-28T17:00:00.000Z',
              deprecated_reason = 'superseded by amendment E-2025-donald-j-trump-08-12-2025-278t-2-amended'
        WHERE doc_id = 'E-2025-donald-j-trump-08-12-2025-278t-3'
          AND deprecated_at IS NULL
          AND EXISTS (
            SELECT 1 FROM transactions WHERE doc_id = 'E-2025-donald-j-trump-08-12-2025-278t-2-amended' AND deprecated_at IS NULL
          )`,
      `CREATE INDEX IF NOT EXISTS idx_filings_filer_amend ON filings(filer_id, ingest_status, filed_date)`,
      // 0026_retroactive_amendment_deprecation_sweep.sql — soft-deprecate all historical predecessor filing transactions superseded by amended filings across all chambers (indexed and bounded to 50 per run for instant response).
      `UPDATE transactions
          SET deprecated_at = '2026-07-28T17:15:00.000Z',
              deprecated_reason = 'retroactive amendment cleanup: superseded by newer amended filing'
        WHERE deprecated_at IS NULL
          AND doc_id IN (
            SELECT f_orig.doc_id
              FROM filings f_amend
              JOIN filings f_orig
                ON f_amend.filer_id = f_orig.filer_id
               AND f_amend.filed_date = f_orig.filed_date
               AND f_amend.doc_id <> f_orig.doc_id
             WHERE f_amend.ingest_status = 'persisted'
               AND f_orig.ingest_status = 'persisted'
               AND (f_amend.filing_status = 'Amended' OR f_amend.doc_id LIKE '%amend%' OR f_amend.source_url LIKE '%amend%')
             LIMIT 50
          )`,
      // 0029-0039 — canonical value, reliability, Stripe, review, and benchmark tail.
      ...POST_0024_SCHEMA_STATEMENTS,
    ];
    const applied: string[] = [];
    const skipped: string[] = [];
    const failed: Array<{ sql: string; error: string }> = [];
    await run(c.env.DB, 'PRAGMA busy_timeout = 10000').catch(() => {});
    for (const sql of statements) {
      let attempts = 0;
      let lastErr: Error | null = null;
      while (attempts < 3) {
        attempts++;
        try {
          await run(c.env.DB, sql);
          applied.push(sql);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err as Error;
          const msg = lastErr.message || String(lastErr);
          if (isIdempotentMigrationError(msg)) {
            skipped.push(sql);
            lastErr = null;
            break;
          }
          if (/\bSQLITE_BUSY\b/i.test(msg) && attempts < 3) {
            await new Promise((r) => setTimeout(r, attempts * 75));
            continue;
          }
          break;
        }
      }
      if (lastErr) {
        const msg = lastErr.message || String(lastErr);
        console.error(`[MIGRATE ERROR] ${msg} on statement: ${sql}`);
        failed.push({ sql, error: msg });
      }
    }

    const body = await c.req.json<{ skipSchemaVerify?: boolean }>().catch(() => ({} as { skipSchemaVerify?: boolean }));
    const skipSchemaVerify = 'skipSchemaVerify' in body && body.skipSchemaVerify === true;
    const readiness = skipSchemaVerify
      ? { ok: true, db: true, schema: true, missing: ['(schema verification skipped)'] }
      : await checkReadiness(c.env.DB);
    // `!readiness.db` must NOT excuse a failure: checkReadiness reports
    // db:false precisely when it cannot reach the database, which is the
    // condition this postcondition exists to catch. Treating it as "fine"
    // failed open on the worst case.
    const ok = failed.length === 0 && readiness.ok;
    if (!ok) {
      console.error(
        `[MIGRATE FAILED] ${failed.length} statement error(s); missing=${readiness.missing.join(',')}`,
      );
    }
    return c.json({ ok, applied, skipped, failed, readiness }, ok ? 200 : 500);
  });

  // --- POST /analyze ------------------------------------------------------
  // Refresh the SQLite query-planner statistics (sqlite_stat1) via the Worker's
  // D1 binding, so the planner has up-to-date selectivity after new indexes /
  // large backfills. Operator-triggered and idempotent — deliberately NOT part
  // of /migrate: ANALYZE reads rows (a cost we are otherwise cutting) and would
  // re-run on every deploy, and a single unsupported statement in the migrate
  // loop 500s the whole migration. Runs whole-DB by default, or a single table
  // via { table }. Fails soft: if D1 rejects ANALYZE, report it, never throw.
  // (Single-column equality indexes like idx_tx_doc are used without stats; run
  // this only if you want the planner's cost estimates refreshed globally.)
  r.post('/analyze', async (c) => {
    let table: string | undefined;
    try {
      const raw = await c.req.text();
      if (raw) {
        const body = JSON.parse(raw) as Record<string, unknown>;
        if (body.table !== undefined) {
          if (typeof body.table !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(body.table)) {
            return c.json({ error: 'table must be a valid SQLite identifier' }, 400);
          }
          table = body.table;
        }
      }
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const sql = table ? `ANALYZE "${table}"` : 'ANALYZE';
    try {
      await run(c.env.DB, sql);
      return c.json({ ok: true, analyzed: table ?? 'all' });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message, sql }, 200);
    }
  });

  // --- POST /enrich-securities --------------------------------------------
  // Budgeted asset enrichment: SEC EDGAR (free) + FMP (key-gated). Processes the
  // tickers that most need it (newest-traded first, then backfilling older ones),
  // spending at most the day's remaining FMP budget. Body (optional):
  //   { max?: number, dryRun?: boolean }
  // Re-run daily (or wire to cron) to slowly backfill history within the cap.
  r.post('/enrich-securities', async (c) => {
    let body: Record<string, unknown> = {};
    try {
      const raw = await c.req.text();
      if (raw) body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const opts: { max?: number; dryRun?: boolean; maxPerMinute?: number } = {};
    if (typeof body.max === 'number' && body.max > 0) opts.max = Math.floor(body.max);
    if (typeof body.maxPerMinute === 'number' && body.maxPerMinute > 0) opts.maxPerMinute = Math.floor(body.maxPerMinute);
    if (body.dryRun === true) opts.dryRun = true;
    try {
      const result = await runEnrichment(c.env, opts);
      return c.json({ ok: result.errors.length === 0, ...result });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // --- GET /enrich-securities/status --------------------------------------
  // Today's FMP call usage + how many tickers still need enrichment.
  r.get('/enrich-securities/status', async (c) => {
    const used = await getDailyUsed(c.env);
    const retryIncomplete = await hasConfiguredKeyedEnrichmentProvider(c.env);
    const row = await first<{ pending: number }>(
      c.env.DB,
      `SELECT COUNT(*) AS pending FROM (
         SELECT t.ticker FROM transactions t
         LEFT JOIN securities_ref sr ON sr.ticker = t.ticker
         WHERE t.ticker IS NOT NULL AND t.ticker <> ''
           AND ${enrichmentNeededSql('sr', retryIncomplete)}
         GROUP BY t.ticker)`,
    );
    const enriched = await first<{ n: number }>(
      c.env.DB,
      'SELECT COUNT(*) AS n FROM securities_ref WHERE enriched_at IS NOT NULL',
    );
    const pending = await marketPending(c.env);
    const coverage = await marketCoverage(c.env);
    return c.json({
      fmpCallsToday: used,
      pendingTickers: row?.pending ?? 0,
      pricePendingTickers: pending.prices,
      enrichedTickers: enriched?.n ?? 0,
      coverage,
      hasFmpKey: false,
      hasSocraticPeer: retryIncomplete,
      hasKeyedEnrichmentProvider: retryIncomplete,
    });
  });

  // --- POST /refresh-prices -----------------------------------------------
  // Budgeted price + performance refresh (FMP-only): updates the S&P series and,
  // for tickers needing it, caches daily closes + computes per-trade anchors.
  // Shares the daily FMP budget with enrichment. Body: { max?, dryRun? }.
  r.post('/refresh-prices', async (c) => {
    let body: Record<string, unknown> = {};
    try {
      const raw = await c.req.text();
      if (raw) body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const opts: { max?: number; dryRun?: boolean; maxPerMinute?: number } = {};
    if (typeof body.max === 'number' && body.max > 0) opts.max = Math.floor(body.max);
    if (typeof body.maxPerMinute === 'number' && body.maxPerMinute > 0) opts.maxPerMinute = Math.floor(body.maxPerMinute);
    if (body.dryRun === true) opts.dryRun = true;
    try {
      const result = await runPriceRefresh(c.env, opts);
      return c.json({ ok: result.errors.length === 0, ...result });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // --- POST /recover-pipeline ---------------------------------------------
  // One-click operator recovery for the 2026-09-20 class of failures: a
  // daily lane (price refresh, snapshot, filer, retention) silently parked
  // because of a prior stamp-before-run race + transient failure, or the
  // price cache went stale (FMP 401/403, plan lapsed, missing key). This
  // route does two bounded things:
  //   1) clears the stamp-on-success KV keys for the requested lanes so
  //      the NEXT hourly cron tick re-runs them (cross-worker overlap is
  //      still prevented by the DB singleton lock in deno/cronLanes.ts);
  //   2) optionally calls runPriceRefresh directly to recover the S&P /
  //      price cache immediately, sharing the daily FMP budget.
  //
  // Body (all optional):
  //   { lanes?: string[];         // which daily lanes to unstamp; default
  //                                // ['market-data','snapshot','filer','retention']
  //     priceRefresh?: boolean;    // also call runPriceRefresh inline; default true
  //     max?: number;              // forwarded to runPriceRefresh when true
  //     maxPerMinute?: number;
  //     dryRun?: boolean; }
  //
  // ADMIN_TOKEN or ADMIN_MAINTENANCE_TOKEN required (no INGEST_TOKEN scope —
  // this route writes daily stamps and calls paid price APIs).
  r.post('/recover-pipeline', async (c) => {
    let body: Record<string, unknown> = {};
    try {
      const raw = await c.req.text();
      if (raw) body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const dryRun = body.dryRun === true;
    const lanesInput = Array.isArray(body.lanes) ? body.lanes.filter((x): x is string => typeof x === 'string') : null;
    const defaultLanes = ['market-data', 'snapshot', 'filer', 'retention'];
    const lanes = lanesInput && lanesInput.length > 0 ? lanesInput : defaultLanes;
    const validLanes = new Set(defaultLanes);
    const bad = lanes.filter((l) => !validLanes.has(l));
    if (bad.length > 0) {
      return c.json({ error: `unknown lane(s): ${bad.join(', ')}; valid: ${[...validLanes].join(', ')}` }, 400);
    }
    const priceRefresh = body.priceRefresh !== false; // default ON
    const max = typeof body.max === 'number' && body.max > 0 ? Math.floor(body.max) : undefined;
    const maxPerMinute = typeof body.maxPerMinute === 'number' && body.maxPerMinute > 0 ? Math.floor(body.maxPerMinute) : undefined;

    const today = new Date().toISOString().slice(0, 10);
    const dayKey = (lane: string) => `jobs:daily:lastok:${lane}`;
    const summary: Record<string, unknown> = {
      requestedAt: new Date().toISOString(),
      day: today,
      dryRun,
      lanesUnstamped: [] as string[],
      priceRefresh: priceRefresh ? { ran: false } : { skipped: 'body.priceRefresh === false' },
    };

    // 1) Clear the stamp-on-success keys so the next hourly cron tick
    //    re-runs these lanes. We only DELETE the day key if it exists,
    //    which is a no-op when the lane already hasn't run today.
    if (!dryRun) {
      const kv = (c.env as Env).CONFIG_KV;
      for (const lane of lanes) {
        const k = dayKey(lane);
        try {
          const existing = await kv.get(k);
          if (existing) {
            await kv.delete(k);
            (summary.lanesUnstamped as string[]).push(lane);
          }
        } catch (err) {
          console.warn(`recover-pipeline: KV delete ${k} failed:`, (err as Error).message);
        }
      }
    } else {
      summary.lanesUnstamped = [...lanes];
      summary.dryRunNote = 'lane stamps were NOT cleared (dryRun=true); values above are the keys that WOULD be cleared';
    }

    // 2) Inline price refresh — same call as /refresh-prices but flagged
    //    explicitly as a recovery action so the run summary can include
    //    the operator context.
    if (priceRefresh && !dryRun) {
      try {
        const opts: { max?: number; dryRun?: boolean; maxPerMinute?: number } = {};
        if (max !== undefined) opts.max = max;
        if (maxPerMinute !== undefined) opts.maxPerMinute = maxPerMinute;
        const r = await runPriceRefresh(c.env, opts);
        (summary.priceRefresh as { ran: boolean; [k: string]: unknown }).ran = true;
        (summary.priceRefresh as { ran: boolean; [k: string]: unknown }).errors = r.errors;
        (summary.priceRefresh as { ran: boolean; [k: string]: unknown }).fmpCalls = r.fmpCalls;
        (summary.priceRefresh as { ran: boolean; [k: string]: unknown }).aborted = r.aborted;
      } catch (err) {
        (summary.priceRefresh as { ran: boolean; [k: string]: unknown }).error = (err as Error).message;
      }
    }

    return c.json({ ok: true, ...summary });
  });

  // --- POST /backfill-market ----------------------------------------------
  // One bounded pass of enrichment + price refresh in a single call, for fast
  // paid-tier history backfilling. A single Worker invocation is capped by
  // Cloudflare's per-request subrequest/CPU limits, so this does ONE safe batch
  // and reports what's left — loop it (see scripts/backfill-market.sh) until
  // `done` is true. Body (all optional):
  //   { max?: number,           // tickers per pass for EACH of enrich + prices (default 40)
  //     maxPerMinute?: number,  // throttle FMP calls/min (paid tier ~300; avoids 429s)
  //     dryRun?: boolean }
  r.post('/backfill-market', async (c) => {
    let body: Record<string, unknown> = {};
    try {
      const raw = await c.req.text();
      if (raw) body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const max = typeof body.max === 'number' && body.max > 0 ? Math.floor(body.max) : 40;
    const maxPerMinute =
      typeof body.maxPerMinute === 'number' && body.maxPerMinute > 0 ? Math.floor(body.maxPerMinute) : undefined;
    const dryRun = body.dryRun === true;
    try {
      const enrich = await runEnrichment(c.env, { max, maxPerMinute, dryRun });
      const prices = await runPriceRefresh(c.env, { max, maxPerMinute, dryRun });
      const pending = await marketPending(c.env);
      return c.json({
        ok: enrich.errors.length === 0 && prices.errors.length === 0,
        done: pending.enrich === 0 && pending.prices === 0,
        pending,
        enrich,
        prices,
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // --- POST /securities/import --------------------------------------------
  // Share FMP data fetched by ANOTHER app (e.g. a local Next.js app) into this
  // Worker's cache, so a fetch by either app serves both — no duplicate FMP
  // calls here. Body (all optional):
  //   { refs?: [{ ticker, sector?, marketCap?, country?, exchangeShort?, ... }],
  //     spx?: [{ date, close }],
  //     prices?: [{ ticker, closes?: [{date,close,volume?}], currentPrice?, currentPriceDate? }],
  //     insider?: [{ ticker, date, sentiment?, buyFilings?, sellFilings?, buyShares?, sellShares?, owners? }],
  //     shortVolume?: [{ ticker, date, ratio, elevated? }],
  //     fundamentals?: [{ ticker, date, peRatio?, eps?, beta?, dividendYield?,
  //                       week52High?, week52Low?, fcfYield?, debtToEquity?, epsGrowth? }],
  //     analyst?: [{ ticker, date, rating?, targetMean?, targetHigh?, targetLow?,
  //                  targetMedian?, analystCount?, strongBuy?, buy?, hold?, sell?, strongSell? }] }
  // Upserts securities_ref / spx_eod / price_eod / insider_eod / short_volume_eod /
  // fundamentals_eod / analyst_consensus and recomputes per-trade
  // performance anchors for imported tickers. Idempotent. Authorized by the
  // full ADMIN_TOKEN/Access OR the scoped INGEST_TOKEN (this endpoint only).
  r.post('/securities/import', async (c) => {
    // This endpoint runs inside a normal Worker request. Keep callers honest.
    // Paid Workers allow larger batches, but the cap remains configurable so
    // the app can be dialed back without code changes.
    const limits = await importLimits(c.env);
    const contentLength = Number(c.req.header('content-length') ?? 0);
    if (contentLength > limits.bytes) {
      return c.json(
        {
          error: 'import payload too large; split into smaller batches',
          maxBytes: limits.bytes,
          receivedBytes: contentLength,
          suggestedLimits: importLimitResponse(limits),
        },
        413,
      );
    }

    let body: Record<string, unknown> = {};
    try {
      const raw = await c.req.text();
      if (raw) body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const summary = {
      refs: 0, spxRows: 0, pricedTickers: 0, priceRows: 0, perfTickers: 0,
      insiderRows: 0, shortVolumeRows: 0, fundamentalsRows: 0, analystRows: 0,
      errors: [] as string[],
    };
    const nowIso = new Date().toISOString();
    // Size-limit checks before schema work so oversized batches still get a
    // cheap 413 without walking every row through Zod.
    const oversized =
      countArray(body.refs) > limits.refs ||
      countArray(body.spx) > limits.spx ||
      countArray(body.prices) > limits.prices ||
      countArray(body.insider) > limits.insider ||
      countArray(body.shortVolume) > limits.shortVolume ||
      (Array.isArray(body.prices) &&
        (body.prices as Array<{ closes?: unknown }>).some((p) => countArray(p.closes) > limits.closesPerTicker));
    if (oversized) {
      return c.json(
        {
          error: 'import batch too large; split into smaller batches',
          limits: importLimitResponse(limits),
        },
        413,
      );
    }
    // Per-row shared-schema filter (same contract App B uses in dropInvalidShareRows).
    // Invalid / incomplete rows are dropped rather than rejecting the whole batch —
    // producers may include ticker-less stubs that the import path has always skipped.
    if (body.origin != null && typeof body.origin !== 'string') {
      return c.json({ error: 'invalid shared payload: origin must be a string' }, 400);
    }
    body = {
      ...body,
      refs: filterShareRows(body.refs, SecurityRefInputSchema),
      prices: filterShareRows(body.prices, PriceSeriesSchema),
      spx: filterShareRows(body.spx, PriceCloseSchema),
      insider: filterShareRows(body.insider, InsiderRowSchema),
      shortVolume: filterShareRows(body.shortVolume, ShortVolumeRowSchema),
      fundamentals: filterShareRows(body.fundamentals, FundamentalRowSchema, normalizeFundamentalAliases),
      analyst: filterShareRows(body.analyst, AnalystRowSchema),
    };

    const REF_KEYS = [
      'companyName', 'sector', 'industry', 'assetClass', 'isEtf', 'isAdr', 'country',
      'stateHq', 'stateOfIncorp', 'exchange', 'exchangeShort', 'currency', 'marketCap',
      'sharesOutstanding', 'ipoDate', 'cik', 'sicCode', 'sicDescription',
    ] as const;

    // 1) Company reference rows. Build all upsert statements first, then flush
    // them through DB.batch in chunks of 100 (the same pattern every other slot
    // below uses). The previous per-row `await` serialized one D1 round trip per
    // ref — with batches near the 2000-ref cap that repeatedly tripped the
    // Worker CPU limit and overloaded D1. On a chunk failure we fall back to
    // per-row writes for that chunk so a single bad ref still gets attributed.
    if (Array.isArray(body.refs)) {
      const refStmts: { ticker: string; stmt: D1PreparedStatement }[] = [];
      for (const raw of body.refs as unknown[]) {
        const o = raw as Record<string, unknown>;
        const ticker = typeof o.ticker === 'string' ? o.ticker.toUpperCase() : null;
        if (!ticker) continue;
        const partial: Partial<SecurityRef> = { source: 'imported' };
        for (const k of REF_KEYS) if (o[k] !== undefined) (partial as Record<string, unknown>)[k] = o[k];
        refStmts.push({ ticker, stmt: prepareImportSecurityRef(c.env, mergeRefs(ticker, [partial])) });
      }
      for (let i = 0; i < refStmts.length; i += 100) {
        const chunk = refStmts.slice(i, i + 100);
        try {
          await batchPrepared(c.env.DB, chunk.map((r) => r.stmt));
          summary.refs += chunk.length;
        } catch {
          // Batch failed as a unit — retry the chunk row-by-row to surface the
          // specific ticker(s) at fault without dropping the whole chunk.
          for (const r of chunk) {
            try {
              await r.stmt.run();
              summary.refs++;
            } catch (e) {
              summary.errors.push(r.ticker + ' ref: ' + (e as Error).message);
            }
          }
        }
      }
    }

    // 2) S&P 500 closes.
    if (Array.isArray(body.spx)) {
      const rows = (body.spx as Array<{ date?: unknown; close?: unknown }>)
        .filter((x) => typeof x.date === 'string' && typeof x.close === 'number')
        .slice(0, limits.spx);
      for (let i = 0; i < rows.length; i += 100) {
        await batchPrepared(c.env.DB,
          rows.slice(i, i + 100).map((x) =>
            c.env.DB.prepare(
              'INSERT INTO spx_eod (date, close) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET close=excluded.close',
            ).bind((x.date as string).slice(0, 10), x.close as number),
          ),
        );
      }
      summary.spxRows += rows.length;
    }

    // 3) Per-ticker price history (+ current price), then recompute anchors.
    if (Array.isArray(body.prices)) {
      for (const raw of body.prices as unknown[]) {
        const o = raw as { ticker?: unknown; closes?: unknown; currentPrice?: unknown; currentPriceDate?: unknown };
        const ticker = typeof o.ticker === 'string' ? o.ticker.toUpperCase() : null;
        if (!ticker) continue;
        const closes = Array.isArray(o.closes)
          ? (o.closes as Array<{ date?: unknown; close?: unknown; volume?: unknown }>)
              .filter((x) => typeof x.date === 'string' && typeof x.close === 'number')
              .slice(0, limits.closesPerTicker)
          : [];
        try {
          for (let i = 0; i < closes.length; i += 100) {
            await batchPrepared(c.env.DB,
              closes.slice(i, i + 100).map((x) =>
                c.env.DB.prepare(
                  `INSERT INTO price_eod (ticker, date, close, volume) VALUES (?, ?, ?, ?)
                   ON CONFLICT(ticker, date) DO UPDATE SET close=excluded.close,
                     volume=COALESCE(excluded.volume, price_eod.volume)`,
                ).bind(
                  ticker,
                  (x.date as string).slice(0, 10),
                  x.close as number,
                  typeof x.volume === 'number' ? Math.round(x.volume) : null,
                ),
              ),
            );
          }
          summary.priceRows += closes.length;
          // The latest cached close (date + value) AFTER writing this import's
          // closes — the single source for both current-price and freshness
          // bookkeeping. Reading the MAX cached row (not just the imported delta)
          // means a backfill of OLDER closes never regresses a newer current price
          // or latest_price_date.
          const latestCached =
            closes.length || typeof o.currentPrice === 'number'
              ? await get<{ d: string | null; c: number | null }>(
                  c.env.DB,
                  'SELECT date AS d, close AS c FROM price_eod WHERE ticker = ? ORDER BY date DESC LIMIT 1',
                  [ticker],
                )
              : null;

          // Current-price anchor. An explicit currentPrice wins (unchanged
          // behavior); otherwise derive it from the latest cached close so a
          // closes-only push still populates current_price/current_price_date —
          // the ticker is marked fresh below and won't be re-selected to fill them,
          // so leaving them null would strand current-return analytics.
          let currentPrice: number | null = null;
          let currentPriceDate = nowIso.slice(0, 10);
          if (typeof o.currentPrice === 'number') {
            currentPrice = o.currentPrice;
            if (typeof o.currentPriceDate === 'string') currentPriceDate = o.currentPriceDate;
          } else if (latestCached?.c != null && latestCached.d) {
            currentPrice = latestCached.c;
            currentPriceDate = latestCached.d;
          }
          if (currentPrice !== null) {
            await run(
              c.env.DB,
              `INSERT INTO securities_ref (ticker, current_price, current_price_date) VALUES (?, ?, ?)
               ON CONFLICT(ticker) DO UPDATE SET current_price=excluded.current_price, current_price_date=excluded.current_price_date`,
              [ticker, currentPrice, currentPriceDate],
            );
          }
          // Freshness: derive latest_price_date ONLY from the true max cached CLOSE
          // date — never today() or a bare currentPriceDate, which would mark a
          // ticker fresh-through-today while price_eod holds only old rows and
          // defeat the re-selection guard. A dateless import with no cached rows
          // leaves latest_price_date UNCHANGED (guard below), so it's never
          // advanced without real data. Clearing price_unavailable + stamping
          // price_checked_at mirrors runPriceRefresh on a successful upsert, so an
          // import rescues a previously negative-cached ticker.
          if (latestCached?.d) {
            await run(
              c.env.DB,
              `INSERT INTO securities_ref (ticker, latest_price_date, price_unavailable, price_checked_at)
                 VALUES (?, ?, 0, ?)
               ON CONFLICT(ticker) DO UPDATE SET
                 latest_price_date = excluded.latest_price_date,
                 price_unavailable = 0,
                 price_checked_at = excluded.price_checked_at`,
              [ticker, latestCached.d, nowIso],
            );
          }
          // Recompute BOTH the trade-date and filing-date anchors for this ticker
          // from the cached series, mirroring runPriceRefresh. The import now marks
          // the ticker fresh (above), so the daily refresh won't re-select it to
          // fill these later — if we only wrote the trade anchors here,
          // price_at_filing/spx_at_filing would stay null and the
          // member-performance/skill queries (which use the filing anchor) would
          // permanently exclude these trades. Filing anchor = the close on/before
          // the disclosure date, falling back to the trade date.
          await run(
            c.env.DB,
            `INSERT INTO tx_performance (tx_id, price_at_trade, spx_at_trade, price_at_filing, spx_at_filing, computed_at)
             SELECT t.id,
               (SELECT close FROM price_eod p WHERE p.ticker = t.ticker AND p.date <= t.tx_date ORDER BY p.date DESC LIMIT 1),
               (SELECT close FROM spx_eod s WHERE s.date <= t.tx_date ORDER BY s.date DESC LIMIT 1),
               (SELECT close FROM price_eod p WHERE p.ticker = t.ticker AND p.date <= COALESCE(f.filed_date, f.first_seen_at, t.tx_date) ORDER BY p.date DESC LIMIT 1),
               (SELECT close FROM spx_eod s WHERE s.date <= COALESCE(f.filed_date, f.first_seen_at, t.tx_date) ORDER BY s.date DESC LIMIT 1),
               ?
             FROM transactions t
             LEFT JOIN filings f ON f.doc_id = t.doc_id
             WHERE t.ticker = ? AND t.tx_date IS NOT NULL AND t.tx_date <> ''
             ON CONFLICT(tx_id) DO UPDATE SET
               price_at_trade=excluded.price_at_trade, spx_at_trade=excluded.spx_at_trade,
               price_at_filing=excluded.price_at_filing, spx_at_filing=excluded.spx_at_filing,
               computed_at=excluded.computed_at`,
            [nowIso, ticker],
          );
          summary.pricedTickers++;
          summary.perfTickers++;
        } catch (e) {
          summary.errors.push(ticker + ' price: ' + (e as Error).message);
        }
      }
    }

    // 4) Insider (SEC Form 4) daily aggregates: [{ ticker, date, sentiment?,
    //    buyFilings?, sellFilings?, buyShares?, sellShares?, owners?:[...] }].
    if (Array.isArray(body.insider)) {
      const rows = (body.insider as Array<Record<string, unknown>>)
        .filter((o) => typeof o.ticker === 'string' && typeof o.date === 'string')
        .slice(0, limits.insider);
      for (let i = 0; i < rows.length; i += 100) {
        await batchPrepared(c.env.DB,
          rows.slice(i, i + 100).map((o) =>
            c.env.DB.prepare(
              `INSERT INTO insider_eod (ticker, date, sentiment, buy_filings, sell_filings, buy_shares, sell_shares, owners)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(ticker, date) DO UPDATE SET
                 sentiment=COALESCE(excluded.sentiment, insider_eod.sentiment),
                 buy_filings=COALESCE(excluded.buy_filings, insider_eod.buy_filings),
                 sell_filings=COALESCE(excluded.sell_filings, insider_eod.sell_filings),
                 buy_shares=COALESCE(excluded.buy_shares, insider_eod.buy_shares),
                 sell_shares=COALESCE(excluded.sell_shares, insider_eod.sell_shares),
                 owners=COALESCE(excluded.owners, insider_eod.owners)`,
            ).bind(
              (o.ticker as string).toUpperCase(),
              (o.date as string).slice(0, 10),
              numOrNull(o.sentiment),
              intOrNull(o.buyFilings),
              intOrNull(o.sellFilings),
              numOrNull(o.buyShares),
              numOrNull(o.sellShares),
              Array.isArray(o.owners) ? JSON.stringify(o.owners) : null,
            ),
          ),
        );
      }
      summary.insiderRows += rows.length;
    }

    // 5) FINRA short-volume daily: [{ ticker, date, ratio, elevated? }].
    if (Array.isArray(body.shortVolume)) {
      const rows = (body.shortVolume as Array<Record<string, unknown>>)
        .filter((o) => typeof o.ticker === 'string' && typeof o.date === 'string')
        .slice(0, limits.shortVolume);
      for (let i = 0; i < rows.length; i += 100) {
        await batchPrepared(c.env.DB,
          rows.slice(i, i + 100).map((o) =>
            c.env.DB.prepare(
              `INSERT INTO short_volume_eod (ticker, date, short_volume_ratio, elevated)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(ticker, date) DO UPDATE SET
                 short_volume_ratio=COALESCE(excluded.short_volume_ratio, short_volume_eod.short_volume_ratio),
                 elevated=excluded.elevated`,
            ).bind(
              (o.ticker as string).toUpperCase(),
              (o.date as string).slice(0, 10),
              numOrNull(o.ratio),
              o.elevated ? 1 : 0,
            ),
          ),
        );
      }
      summary.shortVolumeRows += rows.length;
    }

    // 6) Fundamentals daily snapshot pushed by a sibling app (saves our FMP
    //    quota). [{ ticker, date, peRatio?, eps?, beta?, dividendYield?,
    //    week52High?, week52Low?, fcfYield?, debtToEquity?, epsGrowth? }].
    //    week52High/Low also accept the `52wHigh`/`52wLow` aliases.
    if (Array.isArray(body.fundamentals)) {
      const rows = (body.fundamentals as Array<Record<string, unknown>>)
        .filter((o) => typeof o.ticker === 'string' && typeof o.date === 'string')
        .slice(0, 20000);
      for (let i = 0; i < rows.length; i += 100) {
        await batchPrepared(c.env.DB,
          rows.slice(i, i + 100).map((o) =>
            c.env.DB.prepare(
              `INSERT INTO fundamentals_eod (ticker, date, pe_ratio, eps, beta, dividend_yield,
                 week52_high, week52_low, fcf_yield, debt_to_equity, eps_growth, source, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'imported', ?)
               ON CONFLICT(ticker, date) DO UPDATE SET
                 pe_ratio=COALESCE(excluded.pe_ratio, fundamentals_eod.pe_ratio),
                 eps=COALESCE(excluded.eps, fundamentals_eod.eps),
                 beta=COALESCE(excluded.beta, fundamentals_eod.beta),
                 dividend_yield=COALESCE(excluded.dividend_yield, fundamentals_eod.dividend_yield),
                 week52_high=COALESCE(excluded.week52_high, fundamentals_eod.week52_high),
                 week52_low=COALESCE(excluded.week52_low, fundamentals_eod.week52_low),
                 fcf_yield=COALESCE(excluded.fcf_yield, fundamentals_eod.fcf_yield),
                 debt_to_equity=COALESCE(excluded.debt_to_equity, fundamentals_eod.debt_to_equity),
                 eps_growth=COALESCE(excluded.eps_growth, fundamentals_eod.eps_growth),
                 source=excluded.source, updated_at=excluded.updated_at`,
            ).bind(
              (o.ticker as string).toUpperCase(),
              (o.date as string).slice(0, 10),
              numOrNull(o.peRatio),
              numOrNull(o.eps),
              numOrNull(o.beta),
              numOrNull(o.dividendYield),
              numOrNull(o.week52High ?? o['52wHigh']),
              numOrNull(o.week52Low ?? o['52wLow']),
              numOrNull(o.fcfYield),
              numOrNull(o.debtToEquity),
              numOrNull(o.epsGrowth),
              nowIso,
            ),
          ),
        );
      }
      summary.fundamentalsRows += rows.length;
    }

    // 7) Analyst consensus snapshot. [{ ticker, date, rating?, targetMean?,
    //    targetHigh?, targetLow?, targetMedian?, analystCount?, strongBuy?,
    //    buy?, hold?, sell?, strongSell? }].
    if (Array.isArray(body.analyst)) {
      const rows = (body.analyst as Array<Record<string, unknown>>)
        .filter((o) => typeof o.ticker === 'string' && typeof o.date === 'string')
        .slice(0, 20000);
      for (let i = 0; i < rows.length; i += 100) {
        await batchPrepared(c.env.DB,
          rows.slice(i, i + 100).map((o) =>
            c.env.DB.prepare(
              `INSERT INTO analyst_consensus (ticker, date, rating, target_mean, target_high,
                 target_low, target_median, analyst_count, strong_buy, buy, hold, sell, strong_sell,
                 source, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'imported', ?)
               ON CONFLICT(ticker, date) DO UPDATE SET
                 rating=COALESCE(excluded.rating, analyst_consensus.rating),
                 target_mean=COALESCE(excluded.target_mean, analyst_consensus.target_mean),
                 target_high=COALESCE(excluded.target_high, analyst_consensus.target_high),
                 target_low=COALESCE(excluded.target_low, analyst_consensus.target_low),
                 target_median=COALESCE(excluded.target_median, analyst_consensus.target_median),
                 analyst_count=COALESCE(excluded.analyst_count, analyst_consensus.analyst_count),
                 strong_buy=COALESCE(excluded.strong_buy, analyst_consensus.strong_buy),
                 buy=COALESCE(excluded.buy, analyst_consensus.buy),
                 hold=COALESCE(excluded.hold, analyst_consensus.hold),
                 sell=COALESCE(excluded.sell, analyst_consensus.sell),
                 strong_sell=COALESCE(excluded.strong_sell, analyst_consensus.strong_sell),
                 source=excluded.source, updated_at=excluded.updated_at`,
            ).bind(
              (o.ticker as string).toUpperCase(),
              (o.date as string).slice(0, 10),
              typeof o.rating === 'string' ? o.rating : null,
              numOrNull(o.targetMean),
              numOrNull(o.targetHigh),
              numOrNull(o.targetLow),
              numOrNull(o.targetMedian),
              intOrNull(o.analystCount),
              intOrNull(o.strongBuy),
              intOrNull(o.buy),
              intOrNull(o.hold),
              intOrNull(o.sell),
              intOrNull(o.strongSell),
              nowIso,
            ),
          ),
        );
      }
      summary.analystRows += rows.length;
    }

    return c.json({ ok: summary.errors.length === 0, ...summary });
  });

  // --- POST /enrich-photos ------------------------------------------------
  // Resolve each filer's name -> bioguide (congress-legislators) and store the
  // public headshot URL. Safe to re-run; unmatched filers stay null (the UI
  // falls back to initials).
  r.post('/enrich-photos', async (c) => {
    try {
      return c.json(await runPhotoEnrichment(c.env));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // --- POST /committees/sync ----------------------------------------------
  // Populate filers.committees from the unitedstates/congress-legislators
  // hosted JSON (committee membership keyed by bioguide, subcommittees rolled
  // up to their parent committee). Idempotent; only filers with a resolved
  // bioguide_id are considered. Returns { updated, skipped, unmatched }.
  r.post('/committees/sync', async (c) => {
    try {
      return c.json(await runCommitteeSync(c.env));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // --- POST /identity/sync -------------------------------------------------
  // Bioguide-driven identity sync: backfills missing filers.resolved_bioguide_id
  // for house/senate filers (never overwrites an existing one), sets
  // filers.display_name to each resolved filer's congress-legislators
  // official_full ("campaign sign" name — Bernie Moreno, not Bernardo Moreno),
  // overwrites party/state/district from the legislator's latest term for
  // resolved filers, and cleans up display_name for filers that never resolve
  // (executive branch, MANUAL-* competitor injects, blank-name rows). Accepts
  // ?dryRun=1 to return the full plan without writing. See
  // src/enrichment/identitySync.ts for the resolution rules.
  r.post('/identity/sync', async (c) => {
    try {
      const dryRun = c.req.query('dryRun') === '1';
      return c.json(await runIdentitySync(c.env, { dryRun }));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // --- POST /r2-usage-summary ---------------------------------------------
  // On-demand trigger for the daily R2 free-tier usage summary (Cloudflare
  // GraphQL analytics → Pushover). The daily-jobs cron lane also runs this
  // once per UTC day; this endpoint exists for verification and for testing
  // Pushover delivery after rotating credentials. Returns the computed
  // summary plus the delivery result.
  r.post('/r2-usage-summary', async (c) => {
    try {
      return c.json(await runR2UsageSummary(c.env));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // --- POST /resolve-tickers ----------------------------------------------
  // Backfill: re-run ticker resolution over already-stored ticker-less rows and
  // preferred/depositary share rows that may have been collapsed to the common
  // issuer. No PDF re-extraction — just the deterministic resolver over the
  // stored asset name. Safe to re-run; bounded by ?limit (default 5000).
  r.post('/resolve-tickers', async (c) => {
    try {
      const limit = Number(c.req.query('limit')) || 5000;
      // ?after=<transaction id> pages by id (start with ?after= empty); the response's
      // lastId is the next cursor.  Without it the legacy ordering applies.
      const after = c.req.query('after');
      return c.json(await runTickerBackfill(c.env, limit, after === undefined ? {} : { afterId: after }));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // --- POST /clean-oge-row-numbers ----------------------------------------
  // Strip the 278-T "#" column that the scanned path glued onto executive asset
  // names ("3641 Microsoft Corp. Com"), re-resolve tickers over the cleaned
  // names, and recompute row_key.  Per filing, only when the filing's own rows
  // show the column.  DRY RUN BY DEFAULT: pass ?dryRun=0 to write.  ?limit caps
  // the filings per call (default 200).  raw_text is never modified.
  r.post('/clean-oge-row-numbers', async (c) => {
    try {
      const { cleanOgeRowIndexes } = await import('./ogeRowIndexCleanup.ts');
      const dryRun = c.req.query('dryRun') !== '0';
      const docLimit = Number(c.req.query('limit')) || undefined;
      return c.json({ ok: true, ...(await cleanOgeRowIndexes(c.env, { dryRun, docLimit })) });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // --- GET /subscriptions -------------------------------------------------
  r.get('/subscriptions', async (c) => {
    const activeOnly = c.req.query('active') === 'true';
    const subs = await listSubscriptions(c.env, activeOnly);
    return c.json({ subscriptions: subs.map(adminSubscription), count: subs.length });
  });

  r.post('/clean-asset-names', async (c) => {
    // Note: D1 query limit is 100 statements or results.
    // We will page through transactions and clean the asset names.
    const { offset = 0, limit = 500 } = c.req.query() as { offset?: string | number, limit?: string | number };
    const numOffset = Number(offset);
    const numLimit = Number(limit);
    
    const rows = await all<{ id: string, asset_name: string, ticker: string | null }>(
      c.env.DB,
      'SELECT id, asset_name, ticker FROM transactions ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [numLimit, numOffset]
    );
    
    if (rows.length === 0) return c.json({ ok: true, cleaned: 0, done: true });

    let cleaned = 0;
    const { cleanAssetString } = await import('../extraction/nameNormalizer.ts');

    // Run sequentially to avoid D1 limits on concurrent batches
    for (const row of rows) {
      const cleanName = cleanAssetString(row.asset_name, row.ticker);
      if (cleanName !== row.asset_name) {
        await c.env.DB.prepare('UPDATE transactions SET asset_name = ? WHERE id = ?').bind(cleanName, row.id).run();
        cleaned++;
      }
    }

    return c.json({ ok: true, cleaned, processed: rows.length, nextOffset: numOffset + numLimit, done: rows.length < numLimit });
  });

  r.post('/securities/standardize-names', async (c) => {
    const rows = await all<{ ticker: string; company_name: string | null }>(
      c.env.DB,
      'SELECT ticker, company_name FROM securities_ref WHERE company_name IS NOT NULL AND company_name <> ""'
    );
    let updated = 0;
    const statements: any[] = [];
    for (const row of rows) {
      const normalized = normalizeCompanyName(row.company_name, row.ticker);
      if (normalized && normalized !== row.company_name) {
        statements.push(
          c.env.DB.prepare('UPDATE securities_ref SET company_name = ? WHERE ticker = ?').bind(
            normalized,
            row.ticker
          )
        );
        updated++;
      }
    }
    // Execute in chunks of 100 to prevent D1 timeout / batch size limits
    const chunkSize = 100;
    for (let i = 0; i < statements.length; i += chunkSize) {
      const chunk = statements.slice(i, i + chunkSize);
      await batchPrepared(c.env.DB, chunk);
    }
    return c.json({ ok: true, scanned: rows.length, updated });
  });

  // --- POST /backfill-fmp-dumps ---------------------------------------------
  r.post('/backfill-fmp-dumps', async (c) => {
    let body: any = {};
    try { body = await c.req.json(); } catch {}
    const { chamber, data } = body;
    if (!chamber || !Array.isArray(data)) return c.json({ error: 'invalid payload' }, 400);

    let inserted = 0;
    for (const item of data) {
      try {
        const payload = JSON.stringify(item);
        const doc_id = item.doc_id || item.link || 'fmp_unknown';
        
        await c.env.DB.prepare(`
          INSERT INTO disclosure_provider_observations
          (provider, chamber, provider_key, first_observed_at, last_observed_at, source_url, filed_date, filer_name, payload)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(provider, chamber, provider_key) DO UPDATE SET
            last_observed_at = excluded.last_observed_at,
            payload = excluded.payload
        `).bind(
          'fmp',
          chamber,
          item.link || doc_id,
          new Date().toISOString(),
          new Date().toISOString(),
          item.link || null,
          item.disclosureDate || item.filed_date || null,
          (item.firstName || '') + ' ' + (item.lastName || ''),
          payload
        ).run();
        inserted++;
      } catch (e) {
        console.error('Failed to insert FMP observation:', e);
      }
    }
    return c.json({ ok: true, inserted });
  });

  // --- POST /backfill-massive-tickers ---------------------------------------
  r.post('/backfill-massive-tickers', async (c) => {
    let data: any[] = [];
    try { data = await c.req.json(); } catch {}
    if (!Array.isArray(data)) return c.json({ error: 'invalid payload' }, 400);

    let inserted = 0;
    for (const item of data) {
      try {
        await c.env.DB.prepare(`
          INSERT INTO securities_ref (ticker, company_name)
          VALUES (?, ?)
          ON CONFLICT(ticker) DO UPDATE SET company_name = excluded.company_name
        `).bind(
          item.ticker,
          item.name
        ).run();
        inserted++;
      } catch (e) {
        console.error('Failed to insert massive ticker:', e);
      }
    }
    return c.json({ ok: true, inserted });
  });

  // --- POST /backfill-observations ------------------------------------------
  r.post('/backfill-observations', async (c) => {
    let data: any[] = [];
    try { data = await c.req.json(); } catch {}
    if (!Array.isArray(data)) return c.json({ error: 'invalid payload' }, 400);

    let inserted = 0;
    for (const item of data) {
      try {
        await c.env.DB.prepare(`
          INSERT INTO trade_provider_observations
          (provider, chamber, trade_hash, first_observed_at, last_observed_at, source_url, filed_date, filer_name, payload)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(provider, chamber, trade_hash) DO UPDATE SET
            last_observed_at = excluded.last_observed_at,
            payload = excluded.payload
        `).bind(
          item.provider,
          item.chamber,
          item.provider_key,
          item.first_observed_at || new Date().toISOString(),
          item.last_observed_at || new Date().toISOString(),
          item.source_url || null,
          item.filed_date || null,
          item.filer_name || null,
          item.payload ? JSON.stringify(item.payload) : null
        ).run();
        inserted++;
      } catch (e) {
        console.error('Failed to insert observation:', e);
      }
    }
    return c.json({ ok: true, inserted });
  });

  // Operator provisioning keeps explicit integration client ids; end-user
  // routes derive ownership from the authenticated account instead.
  r.post('/subscriptions', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : '';
    if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(clientId)) {
      return c.json({ error: 'clientId must be 1-128 URL-safe characters' }, 400);
    }
    const delivery = body.delivery;
    if (delivery !== 'webhook' && delivery !== 'sse') {
      return c.json({ error: "delivery must be 'webhook' or 'sse'" }, 400);
    }
    const targetUrl = delivery === 'webhook' && typeof body.targetUrl === 'string'
      ? body.targetUrl.trim()
      : null;
    const targetLengthError = webhookTargetLengthError(targetUrl);
    if (targetLengthError) return c.json({ error: targetLengthError }, 400);
    if (delivery === 'webhook') {
      const targetError = await validatePublicWebhookTarget(targetUrl, {
        allowLocalhost: localWebhookTargetsAllowed(c.env, c.req.url),
      });
      if (targetError) return c.json({ error: targetError }, 400);
    }
    const validatedFilters = await validateAndResolveSubscriptionFilters(c.env, body.filters);
    if (!validatedFilters.ok) {
      return c.json(
        {
          error: validatedFilters.error,
          ...(validatedFilters.unresolvedMembers?.length
            ? { unresolvedMembers: validatedFilters.unresolvedMembers }
            : {}),
        },
        400,
      );
    }
    const secretError = subscriptionSecretError(body.secret);
    if (secretError) return c.json({ error: secretError }, 400);
    const secret = typeof body.secret === 'string' ? body.secret : undefined;
    try {
      await assertSubscriptionQuota(c.env, clientId, { creating: true });
      const sub = await createSubscription(c.env, {
        clientId,
        delivery,
        targetUrl,
        secret: secret ?? null,
        filters: validatedFilters.filters,
      });
      return c.json({
        ...adminSubscription(sub),
        secret: sub.secret,
        ...(delivery === 'sse' && sub.secret
          ? { streamUrl: `/api/stream?subscription=${encodeURIComponent(sub.id)}&token=${encodeURIComponent(sub.secret)}` }
          : {}),
      }, 201);
    } catch (err) {
      if (err instanceof SubscriptionQuotaError) return c.json({ error: err.message }, 409);
      throw err;
    }
  });

  // --- POST /subscriptions/:id/rotate-secret ------------------------------
  // Rotate a subscription's signing secret without exposing it. Body:
  //   { secret?: string }  — caller-supplied secret (32-256 chars, no
  //   whitespace), or omitted to auto-generate like creation does.
  // Response mirrors the create endpoint's shown-once semantics: an
  // auto-generated secret is returned exactly once; a caller-supplied secret
  // is NEVER echoed back. This unblocks incident remediation (CT-AUD-003):
  // a compromised or drifted webhook HMAC key can be replaced with a value
  // that never transits any response or log.
  r.post('/subscriptions/:id/rotate-secret', async (c) => {
    const id = c.req.param('id');
    let body: Record<string, unknown> = {};
    try {
      const raw = await c.req.text();
      if (raw) body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    let secret: string | undefined;
    if (body.secret !== undefined) {
      const secretError = rotateSubscriptionSecretError(body.secret);
      if (secretError) return c.json({ error: secretError }, 400);
      secret = body.secret as string;
    }
    const existing = await getSubscription(c.env, id);
    if (!existing) return c.json({ error: 'subscription not found' }, 404);
    const { subscription, generated } = await rotateSubscriptionSecret(c.env, id, secret);
    auditAdminSubscriptionAction(c, 'rotate-secret', id, { generated });
    return c.json({
      ok: true,
      secretSet: true,
      ...adminSubscription(subscription),
      // Shown-once: only a server-generated secret is ever echoed, matching
      // the create endpoint. A caller-supplied secret never round-trips.
      ...(generated && subscription.secret ? { secret: subscription.secret } : {}),
      ...(generated && subscription.delivery === 'sse' && subscription.secret
        ? { streamUrl: `/api/stream?subscription=${encodeURIComponent(subscription.id)}&token=${encodeURIComponent(subscription.secret)}` }
        : {}),
    });
  });

  // --- POST /users/grant-premium ------------------------------------------
  // Operator grant: set trialing/active Premium for an email so they can
  // create/edit Delivery. User must have signed in once (row exists).
  r.post('/users/grant-premium', async (c) => {
    let body: {
      email?: unknown;
      plan?: unknown;
      trialDays?: unknown;
      status?: unknown;
      seedDelivery?: unknown;
    };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: 'invalid JSON' }, 400);
    }
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!email || !email.includes('@')) return c.json({ error: 'email required' }, 400);
    const plan = body.plan === 'annual' ? 'annual' : 'monthly';
    const trialDaysRaw = Number(body.trialDays);
    const trialDays = Number.isFinite(trialDaysRaw) && trialDaysRaw >= 0 ? Math.min(trialDaysRaw, 365) : 30;
    const status = body.status === 'active' ? 'active' : 'trialing';
    const { getUserByEmail, getUserById } = await import('../auth/users.ts');
    const user = await getUserByEmail(c.env, email);
    if (!user) {
      return c.json({
        error: 'user not found — have them sign in once (Google or magic link) first',
        email,
      }, 404);
    }
    const now = new Date();
    const trialEnd = new Date(now.getTime() + trialDays * 86400000).toISOString();
    const periodEnd = trialEnd;
    await run(
      c.env.DB,
      `UPDATE users
          SET subscription_status = ?,
              plan = ?,
              trial_end = ?,
              current_period_end = ?,
              cancel_at_period_end = 0
        WHERE id = ?`,
      [status, plan, status === 'trialing' ? trialEnd : null, periodEnd, user.id],
    );
    const refreshed = await getUserById(c.env, user.id);
    let seed: { subscriptionId?: string; secret?: string; streamUrl?: string } | null = null;
    if (body.seedDelivery === true || body.seedDelivery === 'sse') {
      try {
        const clientId = `user:${user.id}`;
        const sub = await createSubscription(c.env, {
          clientId,
          delivery: 'sse',
          targetUrl: null,
          secret: null,
          filters: {},
        });
        seed = {
          subscriptionId: sub.id,
          secret: sub.secret,
          streamUrl: `/api/stream?subscription=${encodeURIComponent(sub.id)}&token=${encodeURIComponent(sub.secret)}`,
        };
      } catch (err) {
        return c.json({
          ok: true,
          user: refreshed
            ? {
                id: refreshed.id,
                email: refreshed.email,
                subscriptionStatus: refreshed.subscriptionStatus,
                plan: refreshed.plan,
                trialEnd: refreshed.trialEnd,
              }
            : null,
          seedError: (err as Error).message,
        });
      }
    }
    return c.json({
      ok: true,
      user: refreshed
        ? {
            id: refreshed.id,
            email: refreshed.email,
            subscriptionStatus: refreshed.subscriptionStatus,
            plan: refreshed.plan,
            trialEnd: refreshed.trialEnd,
            currentPeriodEnd: refreshed.currentPeriodEnd,
          }
        : null,
      seed,
      note: seed?.secret
        ? 'Save the seed delivery secret now — it will not be shown again.'
        : undefined,
    });
  });

  // --- POST /subscriptions/:id/deactivate ---------------------------------
  // Set a subscription inactive: webhook/SSE fanout already filters on
  // active = 1, so a deactivated subscription stops receiving deliveries, and
  // the creation quota counts only active rows, so its slot is freed (fixes
  // the lifetime-lockout where 20 historical rows blocked new creations with
  // no delete path). Idempotent.
  r.post('/subscriptions/:id/deactivate', async (c) => {
    const id = c.req.param('id');
    const existing = await getSubscription(c.env, id);
    if (!existing) return c.json({ error: 'subscription not found' }, 404);
    const subscription = existing.active ? await deactivateSubscription(c.env, id) : existing;
    auditAdminSubscriptionAction(c, 'deactivate', id, { wasActive: existing.active });
    return c.json({ ok: true, ...adminSubscription(subscription) });
  });

  return r;
}

function ratio(n: number, d: number): number | null {
  if (!d) return null;
  return Math.round((n / d) * 10_000) / 10_000;
}

interface MarketCoverage {
  trades: {
    total: number;
    tickered: number;
    companyName: number;
    sector: number;
    country: number;
    marketCap: number;
    companyNamePctOfTickered: number | null;
    sectorPctOfTickered: number | null;
    countryPctOfTickered: number | null;
    marketCapPctOfTickered: number | null;
  };
  assets: {
    total: number;
    companyName: number;
    sector: number;
    country: number;
    marketCap: number;
    companyNamePct: number | null;
    sectorPct: number | null;
    countryPct: number | null;
    marketCapPct: number | null;
  };
  missingSamples: Array<{
    ticker: string;
    name: string | null;
    trades: number;
    missing: string[];
    source: string | null;
    enrichedAt: string | null;
    enrichmentError: string | null;
  }>;
}

async function marketCoverage(env: Env): Promise<MarketCoverage> {
  const trade = await get<{
    total: number;
    tickered: number;
    company_name: number;
    sector: number;
    country: number;
    market_cap: number;
  }>(
    env.DB,
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN t.ticker IS NOT NULL AND t.ticker <> '' THEN 1 ELSE 0 END) AS tickered,
            SUM(CASE WHEN t.ticker IS NOT NULL AND t.ticker <> '' AND sr.company_name IS NOT NULL AND sr.company_name <> '' THEN 1 ELSE 0 END) AS company_name,
            SUM(CASE WHEN t.ticker IS NOT NULL AND t.ticker <> '' AND sr.sector IS NOT NULL AND sr.sector <> '' THEN 1 ELSE 0 END) AS sector,
            SUM(CASE WHEN t.ticker IS NOT NULL AND t.ticker <> '' AND sr.country IS NOT NULL AND sr.country <> '' THEN 1 ELSE 0 END) AS country,
            SUM(CASE WHEN t.ticker IS NOT NULL AND t.ticker <> '' AND (sr.market_cap IS NOT NULL OR (sr.market_cap_bucket IS NOT NULL AND sr.market_cap_bucket <> '')) THEN 1 ELSE 0 END) AS market_cap
       FROM transactions t
       LEFT JOIN securities_ref sr ON sr.ticker = t.ticker
      WHERE t.deprecated_at IS NULL`,
  );
  const asset = await get<{
    total: number;
    company_name: number;
    sector: number;
    country: number;
    market_cap: number;
  }>(
    env.DB,
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN company_name IS NOT NULL AND company_name <> '' THEN 1 ELSE 0 END) AS company_name,
            SUM(CASE WHEN sector IS NOT NULL AND sector <> '' THEN 1 ELSE 0 END) AS sector,
            SUM(CASE WHEN country IS NOT NULL AND country <> '' THEN 1 ELSE 0 END) AS country,
            SUM(CASE WHEN market_cap IS NOT NULL OR (market_cap_bucket IS NOT NULL AND market_cap_bucket <> '') THEN 1 ELSE 0 END) AS market_cap
       FROM (
         SELECT t.ticker,
                MAX(sr.company_name) AS company_name,
                MAX(sr.sector) AS sector,
                MAX(sr.country) AS country,
                MAX(sr.market_cap) AS market_cap,
                MAX(sr.market_cap_bucket) AS market_cap_bucket
           FROM transactions t
           LEFT JOIN securities_ref sr ON sr.ticker = t.ticker
          WHERE t.deprecated_at IS NULL AND t.ticker IS NOT NULL AND t.ticker <> ''
          GROUP BY t.ticker
       )`,
  );
  const samples = await all<{
    ticker: string;
    name: string | null;
    trades: number;
    company_name: string | null;
    sector: string | null;
    country: string | null;
    market_cap: number | null;
    market_cap_bucket: string | null;
    source: string | null;
    enriched_at: string | null;
    enrichment_error: string | null;
  }>(
    env.DB,
    `SELECT t.ticker,
            COALESCE(MAX(sr.company_name), MAX(sm.name), MAX(t.asset_name)) AS name,
            COUNT(*) AS trades,
            MAX(sr.company_name) AS company_name,
            MAX(sr.sector) AS sector,
            MAX(sr.country) AS country,
            MAX(sr.market_cap) AS market_cap,
            MAX(sr.market_cap_bucket) AS market_cap_bucket,
            MAX(sr.source) AS source,
            MAX(sr.enriched_at) AS enriched_at,
            MAX(sr.enrichment_error) AS enrichment_error
       FROM transactions t
       LEFT JOIN securities_ref sr ON sr.ticker = t.ticker
       LEFT JOIN securities_master sm ON sm.ticker = t.ticker
      WHERE t.deprecated_at IS NULL AND t.ticker IS NOT NULL AND t.ticker <> ''
      GROUP BY t.ticker
     HAVING company_name IS NULL OR company_name = ''
         OR sector IS NULL OR sector = ''
         OR country IS NULL OR country = ''
         OR (market_cap IS NULL AND (market_cap_bucket IS NULL OR market_cap_bucket = ''))
      ORDER BY trades DESC
      LIMIT 20`,
  );
  const tickered = trade?.tickered ?? 0;
  const totalAssets = asset?.total ?? 0;
  return {
    trades: {
      total: trade?.total ?? 0,
      tickered,
      companyName: trade?.company_name ?? 0,
      sector: trade?.sector ?? 0,
      country: trade?.country ?? 0,
      marketCap: trade?.market_cap ?? 0,
      companyNamePctOfTickered: ratio(trade?.company_name ?? 0, tickered),
      sectorPctOfTickered: ratio(trade?.sector ?? 0, tickered),
      countryPctOfTickered: ratio(trade?.country ?? 0, tickered),
      marketCapPctOfTickered: ratio(trade?.market_cap ?? 0, tickered),
    },
    assets: {
      total: totalAssets,
      companyName: asset?.company_name ?? 0,
      sector: asset?.sector ?? 0,
      country: asset?.country ?? 0,
      marketCap: asset?.market_cap ?? 0,
      companyNamePct: ratio(asset?.company_name ?? 0, totalAssets),
      sectorPct: ratio(asset?.sector ?? 0, totalAssets),
      countryPct: ratio(asset?.country ?? 0, totalAssets),
      marketCapPct: ratio(asset?.market_cap ?? 0, totalAssets),
    },
    missingSamples: samples.map((s) => {
      const missing: string[] = [];
      if (!s.company_name) missing.push('companyName');
      if (!s.sector) missing.push('sector');
      if (!s.country) missing.push('country');
      if (s.market_cap == null && !s.market_cap_bucket) missing.push('marketCap');
      return {
        ticker: s.ticker,
        name: s.name,
        trades: s.trades,
        missing,
        source: s.source,
        enrichedAt: s.enriched_at,
        enrichmentError: s.enrichment_error,
      };
    }),
  };
}

/**
 * Count tickers still needing work: `enrich` = traded tickers with no useful
 * securities_ref coverage; `prices` = traded (dated) tickers with no cached
 * price_eod that are NOT negative-cached as un-priceable. Drives the `done` flag
 * for the backfill-market loop.
 *
 * Two things make `prices` reach 0 (so `done:true` is reachable) instead of
 * plateauing at the ~544 never-priceable tickers that ran the loop forever:
 *   1. `NOT EXISTS` instead of `LEFT JOIN price_eod ... WHERE pe.ticker IS NULL`
 *      — the anti-join materialized every one of a ticker's ~1,578 price_eod rows
 *      before discarding them; NOT EXISTS index-seeks and stops at the first row.
 *   2. excluding tickers marked `price_unavailable` within the re-check TTL, which
 *      the price refresh sets when the EOD history API returns empty for them.
 *      Mirrors `selectTickersNeedingPrices`'s own two-stage CASE: a FIRST
 *      consecutive not-found result (`price_unavailable = 1`) uses the shorter
 *      7-day cutoff, while a second-or-later miss or a stalled listing (2 or 3)
 *      uses the slower 30-day cutoff — else this count would over-report
 *      "pending" for rows the price-refresh selector has already excluded,
 *      making `done:true` unreachable again for exactly the tickers this two-
 *      stage backoff targets.
 */
export async function marketPending(env: Env): Promise<{ enrich: number; prices: number }> {
  const retryIncomplete = await hasConfiguredKeyedEnrichmentProvider(env);
  const e = await first<{ n: number }>(
    env.DB,
    `SELECT COUNT(*) AS n FROM (
       SELECT t.ticker FROM transactions t
       LEFT JOIN securities_ref sr ON sr.ticker = t.ticker
       WHERE t.ticker IS NOT NULL AND t.ticker <> ''
         AND ${enrichmentNeededSql('sr', retryIncomplete)}
       GROUP BY t.ticker)`,
  );
  const p = await first<{ n: number }>(
    env.DB,
    `SELECT COUNT(*) AS n FROM (
       SELECT t.ticker FROM transactions t
       LEFT JOIN securities_ref sr ON sr.ticker = t.ticker
       WHERE t.ticker IS NOT NULL AND t.ticker <> '' AND t.tx_date IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM price_eod pe WHERE pe.ticker = t.ticker)
         AND NOT (
           COALESCE(sr.price_unavailable, 0) <> 0
           AND sr.price_checked_at IS NOT NULL
           AND sr.price_checked_at >= CASE
                 WHEN sr.price_unavailable = ${PRICE_UNAVAILABLE_NOT_FOUND_FIRST} THEN ?
                 ELSE ?
               END
         )
       GROUP BY t.ticker)`,
    [priceUnavailableFirstRecheckCutoffIso(), priceUnavailableCutoffIso()],
  );
  return { enrich: e?.n ?? 0, prices: p?.n ?? 0 };
}

async function getLatencyResetAt(env: Env): Promise<string | null> {
  try {
    const raw = await env.CONFIG_KV.get(LATENCY_RESET_KEY);
    return raw && Number.isFinite(Date.parse(raw)) ? raw : null;
  } catch {
    return null;
  }
}

async function setLatencyResetAt(env: Env, value: string): Promise<void> {
  await env.CONFIG_KV.put(LATENCY_RESET_KEY, value);
}

/** Observed average seconds between the most recent polls for a source. */
async function observedAvgInterval(env: Env, source: string): Promise<number | null> {
  const aliases = source === 'executive' ? ['executive', 'oge', 'exec'] : [source];
  const placeholders = aliases.map(() => '?').join(', ');
  const rows = await all<{ polled_at: string }>(
    env.DB,
    `SELECT polled_at FROM ingest_log WHERE source IN (${placeholders}) ORDER BY polled_at DESC LIMIT 50`,
    aliases,
  );
  if (rows.length < 2) return null;
  // rows are DESC; compute deltas between consecutive timestamps.
  let total = 0;
  let n = 0;
  for (let i = 0; i < rows.length - 1; i++) {
    const newer = Date.parse(rows[i].polled_at);
    const older = Date.parse(rows[i + 1].polled_at);
    if (Number.isFinite(newer) && Number.isFinite(older) && newer > older) {
      total += (newer - older) / 1000;
      n++;
    }
  }
  return n > 0 ? Math.round(total / n) : null;
}

/**
 * Average "Released → Seen" lag (seconds): from a filing's official release
 * (filed_date) to when our watcher first recorded it (first_seen_at), per
 * chamber. filed_date is day-granular (the disclosure systems publish no exact
 * release time), so this is APPROXIMATE; we average only non-negative diffs over
 * recent filings. Returns null when there isn't enough dated data.
 */
async function observedReleasedToSeenLag(env: Env, source: string, sinceIso: string | null): Promise<number | null> {
  const chamber = source === 'oge' ? 'executive' : source;
  const row = await get<{ avg_sec: number | null }>(
    env.DB,
    `SELECT AVG((julianday(first_seen_at) - julianday(filed_date)) * 86400.0) AS avg_sec
       FROM (
         SELECT first_seen_at, filed_date
           FROM filings
          WHERE chamber = ?
            AND filed_date IS NOT NULL
            AND first_seen_at IS NOT NULL
            AND julianday(first_seen_at) >= julianday(filed_date)
            AND (? IS NULL OR first_seen_at >= ?)
          ORDER BY first_seen_at DESC
          LIMIT 200
       )`,
    [chamber, sinceIso, sinceIso],
  );
  return row && row.avg_sec != null ? Math.round(row.avg_sec) : null;
}

/**
 * Average "Seen → Imported" lag (seconds): from when our watcher first saw a
 * filing (filings.first_seen_at) to when we wrote its parsed rows
 * (transactions.created_at), per chamber. Both are our own timestamps, so this
 * is PRECISE. Only live-pipeline rows (source='primary') are meaningful.
 */
async function observedSeenToImportedLag(env: Env, source: string, sinceIso: string | null): Promise<number | null> {
  const chamber = source === 'oge' ? 'executive' : source;
  const row = await get<{ avg_sec: number | null }>(
    env.DB,
    `SELECT AVG((julianday(t.created_at) - julianday(f.first_seen_at)) * 86400.0) AS avg_sec
       FROM transactions t
       JOIN filings f ON f.doc_id = t.doc_id
      WHERE f.chamber = ?
        AND t.source = 'primary'
        AND f.first_seen_at IS NOT NULL
        AND t.created_at IS NOT NULL
        AND julianday(t.created_at) >= julianday(f.first_seen_at)
        AND (? IS NULL OR f.first_seen_at >= ?)`,
    [chamber, sinceIso, sinceIso],
  );
  return row && row.avg_sec != null ? Math.round(row.avg_sec) : null;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

type ImportLimits = {
  bytes: number;
  refs: number;
  spx: number;
  prices: number;
  closesPerTicker: number;
  insider: number;
  shortVolume: number;
};

const DEFAULT_IMPORT_LIMITS: ImportLimits = {
  bytes: 1_500_000,
  refs: 2_000,
  spx: 5_000,
  prices: 100,
  closesPerTicker: 1_500,
  insider: 5_000,
  shortVolume: 5_000,
};

const MAX_IMPORT_LIMITS: ImportLimits = {
  bytes: 3_000_000,
  refs: 5_000,
  spx: 10_000,
  prices: 250,
  closesPerTicker: 3_000,
  insider: 10_000,
  shortVolume: 10_000,
};

function positiveIntSetting(raw: string | undefined, fallback: number, max: number): number {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

async function importLimits(env: Env): Promise<ImportLimits> {
  const secrets = await resolveSecrets(env, [
    'IMPORT_MAX_BYTES',
    'IMPORT_MAX_REFS',
    'IMPORT_MAX_SPX',
    'IMPORT_MAX_PRICES',
    'IMPORT_MAX_CLOSES_PER_TICKER',
    'IMPORT_MAX_INSIDER',
    'IMPORT_MAX_SHORT_VOLUME',
  ]);
  return {
    bytes: positiveIntSetting(secrets.IMPORT_MAX_BYTES, DEFAULT_IMPORT_LIMITS.bytes, MAX_IMPORT_LIMITS.bytes),
    refs: positiveIntSetting(secrets.IMPORT_MAX_REFS, DEFAULT_IMPORT_LIMITS.refs, MAX_IMPORT_LIMITS.refs),
    spx: positiveIntSetting(secrets.IMPORT_MAX_SPX, DEFAULT_IMPORT_LIMITS.spx, MAX_IMPORT_LIMITS.spx),
    prices: positiveIntSetting(secrets.IMPORT_MAX_PRICES, DEFAULT_IMPORT_LIMITS.prices, MAX_IMPORT_LIMITS.prices),
    closesPerTicker: positiveIntSetting(
      secrets.IMPORT_MAX_CLOSES_PER_TICKER,
      DEFAULT_IMPORT_LIMITS.closesPerTicker,
      MAX_IMPORT_LIMITS.closesPerTicker,
    ),
    insider: positiveIntSetting(secrets.IMPORT_MAX_INSIDER, DEFAULT_IMPORT_LIMITS.insider, MAX_IMPORT_LIMITS.insider),
    shortVolume: positiveIntSetting(
      secrets.IMPORT_MAX_SHORT_VOLUME,
      DEFAULT_IMPORT_LIMITS.shortVolume,
      MAX_IMPORT_LIMITS.shortVolume,
    ),
  };
}

function importLimitResponse(limits: ImportLimits): Omit<ImportLimits, 'bytes'> {
  return {
    refs: limits.refs,
    spx: limits.spx,
    prices: limits.prices,
    closesPerTicker: limits.closesPerTicker,
    insider: limits.insider,
    shortVolume: limits.shortVolume,
  };
}

function countArray(v: unknown): number {
  return Array.isArray(v) ? v.length : 0;
}

/**
 * Drop rows that fail a shared Zod row schema. Mirrors App B's
 * `dropInvalidShareRows` — keep the original object (so App-A-only aliases like
 * `52wHigh` / `analystCount` survive) when the shared schema accepts it.
 */
function filterShareRows(
  rows: unknown,
  schema: { safeParse: (v: unknown) => { success: boolean } },
  normalize?: (row: Record<string, unknown>) => Record<string, unknown>,
): unknown[] | undefined {
  if (!Array.isArray(rows)) return undefined;
  const out: unknown[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const candidate = normalize ? normalize(row as Record<string, unknown>) : (row as Record<string, unknown>);
    if (schema.safeParse(candidate).success) out.push(candidate);
  }
  return out;
}

/** Map App-A-accepted `52wHigh`/`52wLow` aliases onto shared FundamentalRow fields. */
function normalizeFundamentalAliases(row: Record<string, unknown>): Record<string, unknown> {
  const out = { ...row };
  if (out.week52High == null && out['52wHigh'] != null) out.week52High = out['52wHigh'];
  if (out.week52Low == null && out['52wLow'] != null) out.week52Low = out['52wLow'];
  return out;
}

/** Coerce an unknown to a finite number or null (for defensive ingest). */
function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
/** Coerce an unknown to a rounded integer or null. */
function intOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null;
}
