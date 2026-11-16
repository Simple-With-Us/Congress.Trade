/**
 * src/extraction/configuredVision.ts
 *
 * Provider-generic PRIMARY/FAILOVER live-ingestion extractor. Reads the
 * per-chamber AGREEMENT_{HOUSE|SENATE|EXEC}_MODEL_A (primary) / _B (failover)
 * Infisical keys and runs the configured candidate through the shared bake-off
 * harness (runCandidateOnDoc), so operators can swap the production extraction
 * model — including non-vision-LLM providers such as mistral OCR or LlamaParse
 * — without a redeploy.
 *
 * Unconfigured chambers (no AGREEMENT_*_MODEL_A) deliberately keep today's
 * behavior by delegating whole-hog to the legacy vision extractor chain (dev
 * environments, or a chamber not yet migrated onto the new key scheme). Once a
 * primary IS configured, that explicit operator choice is authoritative: a
 * failed primary tries the failover (when configured and a different
 * provider), and a failed/absent failover is a hard failure — this extractor
 * never silently reverts to the legacy vision chain once an operator has
 * opted a chamber into explicit model control.
 */

import type { Env, Filing } from '../shared/types.ts';
import { IngestRetryError } from '../ingestion/fetcher.ts';
import { resolveSecrets } from '../secrets/infisical.ts';
import {
  runCandidateOnDoc,
  upgradeRetiredDisclosureCandidate,
  type BakeoffCandidate,
  type CandidateDocResult,
} from './bakeoff.ts';
import { parseCandidate } from './agreement.ts';
import {
  providerModelBanRetryAfter,
  recordProviderHealth,
  resolveProviderHealthKnobs,
  selectOverlaySubstitute,
  type OverlaySubstitute,
} from './providerHealth.ts';
import { getUnderlyingProvider } from '../benchmark/settings.ts';
import { recordIngestionDecision } from '../shared/ingestionDecisions.ts';
import { isLlmBudgetHalt, isLlmSpendSettlementFailure } from '../shared/llmSpend.ts';
import type { Extractor, ExtractorInput, ExtractorResult, ExtractorUsage } from '../extractors/types.ts';

/** Conservative confidence ceiling shared with visionLlm.ts's DEFAULT_CONFIDENCE
 *  convention — most scanned docs should still lean toward human review rather
 *  than a runaway-high model self-reported confidence. */
const DEFAULT_CONFIDENCE = 0.6;

export interface PrimaryFailoverEnv {
  AGREEMENT_SENATE_MODEL_A?: string;
  AGREEMENT_SENATE_MODEL_B?: string;
  AGREEMENT_HOUSE_MODEL_A?: string;
  AGREEMENT_HOUSE_MODEL_B?: string;
  AGREEMENT_EXEC_MODEL_A?: string;
  AGREEMENT_EXEC_MODEL_B?: string;
}

export interface PrimaryFailoverModels {
  primary: BakeoffCandidate | null;
  failover: BakeoffCandidate | null;
}

/** Resolve the explicit per-chamber A (primary) / B (failover) candidates. Either may be null. */
export async function resolvePrimaryFailoverModels(env: Env, chamber: string): Promise<PrimaryFailoverModels> {
  const e = (await resolveSecrets(env, [
    'AGREEMENT_SENATE_MODEL_A',
    'AGREEMENT_SENATE_MODEL_B',
    'AGREEMENT_HOUSE_MODEL_A',
    'AGREEMENT_HOUSE_MODEL_B',
    'AGREEMENT_EXEC_MODEL_A',
    'AGREEMENT_EXEC_MODEL_B',
  ])) as PrimaryFailoverEnv;
  const primaryKey = (chamber === 'senate'
    ? e.AGREEMENT_SENATE_MODEL_A
    : chamber === 'executive' ? e.AGREEMENT_EXEC_MODEL_A : e.AGREEMENT_HOUSE_MODEL_A)
    || 'openrouter:x-ai/grok-4.6';
  const failoverKey = chamber === 'senate'
    ? e.AGREEMENT_SENATE_MODEL_B
    : chamber === 'executive' ? e.AGREEMENT_EXEC_MODEL_B : e.AGREEMENT_HOUSE_MODEL_B;
  const primary = parseCandidate(primaryKey);
  const failover = parseCandidate(failoverKey);
  return {
    primary: primary ? upgradeRetiredDisclosureCandidate(primary) : null,
    failover: failover ? upgradeRetiredDisclosureCandidate(failover) : null,
  };
}

const candidateLabel = (c: BakeoffCandidate): string => `${c.provider}:${c.model}`;

const PROVIDER_BAN_TTL_SECONDS = 60 * 60;

function isProviderRateLimit(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(429|402|too many requests|quota exceeded|rate[- ]?limit|payment required)\b/i.test(message);
}

async function providerBanRetryAfter(env: Env, provider: string): Promise<number | null> {
  if (!env.CONFIG_KV) return null;
  try {
    const raw = await env.CONFIG_KV.get(`provider_ban:${provider}`);
    if (!raw) return null;
    const until = Number(raw);
    if (!Number.isFinite(until) || until <= Date.now()) return null;
    return Math.max(1, Math.min(PROVIDER_BAN_TTL_SECONDS, Math.ceil((until - Date.now()) / 1000)));
  } catch {
    return null;
  }
}

async function recordProviderBan(env: Env, provider: string): Promise<void> {
  if (!env.CONFIG_KV) return;
  try {
    await env.CONFIG_KV.put(
      `provider_ban:${provider}`,
      String(Date.now() + PROVIDER_BAN_TTL_SECONDS * 1000),
      { expirationTtl: PROVIDER_BAN_TTL_SECONDS },
    );
  } catch {
    // A down KV must not hide the provider failure from the queue retry path.
  }
}

/** Stable, secret-safe error string for one candidate's failed read. */
function candidateErrorString(candidate: BakeoffCandidate, result: CandidateDocResult): string {
  return `${candidateLabel(candidate)}: ${result.error ?? 'extraction failed'}`;
}

function toExtractorUsage(usage: CandidateDocResult['usage']): ExtractorUsage | undefined {
  if (!usage) return undefined;
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    cachedTokens: usage.cachedTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    cacheWriteOneHourTokens: usage.cacheWriteOneHourTokens,
    pagesProcessed: usage.pagesProcessed,
    serviceTier: usage.serviceTier,
  };
}

/** Map one successful candidate read into the Extractor contract's result shape. */
function toExtractorResult(
  candidate: BakeoffCandidate,
  result: CandidateDocResult,
  overlayFor?: string,
): ExtractorResult {
  const usage = toExtractorUsage(result.usage);
  const modelVersion = result.resolvedModel ?? candidate.model;
  const extractor = `configured(${candidateLabel(candidate)})`;
  return {
    transactions: result.rows,
    // Cap at the same conservative ceiling visionLlm.ts uses so an
    // over-confident model reading doesn't skip the review-routing safety net.
    confidence: Math.min(result.avgConfidence, DEFAULT_CONFIDENCE),
    raw: JSON.stringify({
      source: 'configuredVision',
      provider: candidate.provider,
      model: candidate.model,
      rowCount: result.rowCount,
      // Runtime health-overlay provenance: which configured slot this read
      // substituted for (audit lives in ingestion_decisions as well).
      ...(overlayFor ? { overlayFor } : {}),
    }),
    extractor,
    modelVersion,
    providerRequestId: result.providerRequestId,
    usage,
    modelRuns: [{ extractor, modelVersion, providerRequestId: result.providerRequestId, usage }],
  };
}

/**
 * Provider-generic primary/failover extractor. Wraps the legacy vision-LLM
 * fallback chain (FallbackExtractor(geminiVision, anthropicVision)) so an
 * unmigrated/dev chamber keeps today's behavior, while a migrated chamber's
 * explicit AGREEMENT_*_MODEL_A/_B configuration becomes authoritative.
 */
export class ConfiguredVisionExtractor implements Extractor {
  readonly name = 'configuredVision';

  constructor(
    private readonly env: Env,
    private readonly legacy: Extractor,
  ) {}

  canHandle(f: Filing): boolean {
    return this.legacy.canHandle(f);
  }

  async extract(input: ExtractorInput): Promise<ExtractorResult> {
    const { primary, failover } = await resolvePrimaryFailoverModels(this.env, input.filing.chamber);

    // Dev/unmigrated env: no explicit primary configured, keep today's behavior.
    if (!primary) return this.legacy.extract(input);

    if (!input.bytes) throw new Error(`${this.name}: no bytes provided on ExtractorInput`);
    const bytes = input.bytes;
    const docId = input.filing.docId;

    const candidates = [primary, failover].filter(
      (candidate, index, all): candidate is BakeoffCandidate =>
        Boolean(candidate) && all.findIndex((item) => candidateLabel(item!) === candidateLabel(candidate!)) === index,
    );
    const healthKnobs = await resolveProviderHealthKnobs(this.env);
    const configuredLabels = candidates.map(candidateLabel);
    const errors: string[] = [];
    let allFailuresWereRateLimits = true;
    let blockedRetryAfter = 0;

    for (const [slotIndex, candidate] of candidates.entries()) {
      input.signal?.throwIfAborted();
      const label = candidateLabel(candidate);
      const retryAfter = await providerBanRetryAfter(this.env, candidate.provider);
      const modelRetryAfter = await providerModelBanRetryAfter(this.env, candidate);
      // A blocked slot (per-provider rate-limit ban OR the per-model
      // billing/auth breaker) resolves to a runtime OVERLAY substitute when
      // one is healthy: the configured lineup stays authoritative in
      // Infisical and resumes as soon as the ban expires. When the overlay is
      // disabled or no healthy substitute exists, behavior is exactly the
      // pre-overlay behavior (slot skipped; retry-after bookkeeping).
      let effective = candidate;
      let overlay: OverlaySubstitute | null = null;
      if (retryAfter !== null || modelRetryAfter !== null) {
        if (healthKnobs.overlayEnabled) {
          const otherSlots = candidates.filter((_, index) => index !== slotIndex);
          overlay = await selectOverlaySubstitute(this.env, candidate, {
            excludeLabels: configuredLabels,
            excludeUnderlyingProviders: otherSlots.map((other) => getUnderlyingProvider(other)),
            costRatioLimit: healthKnobs.costRatioLimit,
          });
        }
        if (!overlay) {
          if (retryAfter !== null) {
            blockedRetryAfter = blockedRetryAfter === 0 ? retryAfter : Math.min(blockedRetryAfter, retryAfter);
            errors.push(`${label}: provider rate limit circuit breaker is open`);
          } else {
            errors.push(`${label}: provider-model circuit breaker is open (billing/auth failures)`);
            allFailuresWereRateLimits = false;
          }
          continue;
        }
        effective = overlay.candidate;
        const overlayPayload = {
          slot: slotIndex === 0 ? 'primary' : 'failover',
          configured: label,
          substitute: candidateLabel(overlay.candidate),
          reason: modelRetryAfter !== null ? 'model_breaker_open' : 'provider_breaker_open',
          nominalCostUsd: overlay.nominalCostUsd,
          configuredCostUsd: overlay.configuredCostUsd,
          costRatio: overlay.costRatio,
          costFlagged: overlay.flagged,
        };
        if (overlay.flagged) {
          console.warn(
            `${this.name}: overlay substitute ${overlayPayload.substitute} exceeds the `
            + `${healthKnobs.costRatioLimit}x rate-card cost guard for ${label} `
            + `(ratio ${overlay.costRatio == null ? 'unknown' : overlay.costRatio.toFixed(2)})`,
          );
        }
        await recordIngestionDecision(this.env.DB, {
          docId,
          action: 'provider_substituted',
          source: 'pipeline',
          reason: 'provider_health_overlay',
          payload: overlayPayload,
        }).catch(() => {});
      }

      const effectiveLabel = candidateLabel(effective);
      let result: CandidateDocResult;
      try {
        result = input.signal
          ? await runCandidateOnDoc(
              this.env,
              effective,
              docId,
              bytes,
              undefined,
              input.signal,
            )
          : await runCandidateOnDoc(this.env, effective, docId, bytes);
        input.signal?.throwIfAborted();
      } catch (error) {
        const message = `${effectiveLabel}: ${(error as Error).message}`;
        errors.push(message);
        await recordProviderHealth(this.env, effective, false, (error as Error).message, healthKnobs);
        // GOVERNOR 1: a budget halt (error-class 'budget') is terminal for the
        // attempt — never fail over to another (potentially pricier) model.
        if (isLlmBudgetHalt(error) || isLlmSpendSettlementFailure(error)) {
          allFailuresWereRateLimits = false;
          break;
        }
        if (isProviderRateLimit(error)) await recordProviderBan(this.env, effective.provider);
        else allFailuresWereRateLimits = false;
        continue;
      }
      if (!result.cached) {
        await recordProviderHealth(this.env, effective, result.ok, result.error, healthKnobs);
      }
      if (result.ok) return toExtractorResult(effective, result, overlay ? label : undefined);

      const message = candidateErrorString(effective, result);
      errors.push(message);
      // GOVERNOR 1: budget halts must not trigger the failover candidate — the
      // ceiling is global, so the only effect of continuing would be a second
      // (and on the storm vector, pricier) attempt that the choke point would
      // reject anyway. Stop the cascade outright.
      if (
        result.failure?.code === 'llm_budget_exceeded'
        || result.failure?.code === 'llm_spend_settlement_failed'
        || isLlmBudgetHalt(result.error)
      ) {
        allFailuresWereRateLimits = false;
        break;
      }
      if (isProviderRateLimit(result.error)) await recordProviderBan(this.env, effective.provider);
      else allFailuresWereRateLimits = false;
    }

    if (blockedRetryAfter > 0 && allFailuresWereRateLimits) {
      throw new IngestRetryError(
        `${this.name}: all configured providers are rate-limited; retry-after: ${blockedRetryAfter}s`,
        blockedRetryAfter,
      );
    }
    const primaryErr = errors[0] ?? `${candidateLabel(primary)}: extraction failed`;
    const failoverErr = errors[1] ?? 'no distinct failover configured';
    throw new Error(`${this.name}: primary failed (${primaryErr}); failover failed (${failoverErr})`);
  }
}
