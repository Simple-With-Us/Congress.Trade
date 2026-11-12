/**
 * OpenRouter app attribution + call-purpose tagging for Congress.Trade.
 *
 * Two complementary layers:
 *
 * 1. **App sends purpose** (this module) — free, deterministic, zero latency.
 *    Every OpenRouter chat/completions body gets:
 *      - headers: HTTP-Referer + X-OpenRouter-Title (app page)
 *      - user / session_id (Activity dimensions external_user / session_id)
 *      - trace: sourceApp, environment, service, feature, purpose,
 *        generation_name, keyRef, gitSha, optional chamber
 *
 * 2. **Workspace Custom Classifier** (OpenRouter dashboard, async ML tags) —
 *    configured at https://openrouter.ai/workspaces/congress-trade/classifiers
 *    See docs/ops/openrouter-ct-workspace-classifier.md. No public create API;
 *    must be activated by a workspace admin in the UI.
 *
 * Contract for static fields: shared package `openrouterRequestEnrichment`
 * (sourceApp/environment/service/feature/keyRef/gitSha). Extra purpose keys
 * are merged onto `trace` after the shared builder (OpenRouter accepts any
 * trace keys for Broadcast/Activity).
 */

import {
  openrouterRequestEnrichment,
  type OpenRouterRequestEnrichment,
} from '@jaywedgeworth22/congress-trading-shared';
import type { Env } from './types.ts';
import { environmentName } from './thirdPartyTelemetry.ts';

/** Canonical producer / OpenRouter app identity for Congress.Trade. */
export const OPENROUTER_SOURCE_APP = 'congress-trade' as const;

/** Primary domain for OpenRouter app rankings (HTTP-Referer). */
export const OPENROUTER_APP_REFERER = 'https://congress.trade';

/** Display name on OpenRouter Activity / Apps (X-OpenRouter-Title + X-Title). */
export const OPENROUTER_APP_TITLE = 'Congress.Trade';

/**
 * Default Infisical/env secret name for the primary OpenRouter inference key.
 * Used as `keyRef` / `producerKeyRef` for Usage-Monitor key attribution.
 */
export const OPENROUTER_PRIMARY_KEY_REF = 'OPENROUTER_API_KEY';

/**
 * Stable call-purpose taxonomy for CT OpenRouter traffic.
 * Keep in sync with docs/ops/openrouter-ct-workspace-classifier.md so the
 * workspace ML classifier and app-sent tags use the same vocabulary.
 */
export const OPENROUTER_PURPOSE = {
  /** Primary/failover vision extraction of a PTR/278-T PDF. */
  VISION_EXTRACT: 'vision_extract',
  /** Cheap text-only extract (no Files attachment). */
  TEXT_EXTRACT: 'text_extract',
  /** Pre-extraction doc_class model call (typed/clean_scan/hard_scan/…). */
  DOC_CLASS: 'doc_class',
  /** Senate paper PTR page-image OCR. */
  SENATE_PAPER_OCR: 'senate_paper_ocr',
  /** Agreement-cascade / multi-model re-read (still via vision extractor). */
  AGREEMENT_READ: 'agreement_read',
  /** Benchmark / bakeoff / admin re-read. */
  BENCHMARK: 'benchmark',
  /** Anything else — should be rare; expand the enum instead of abusing this. */
  OTHER: 'other',
} as const;

export type OpenRouterPurpose = (typeof OPENROUTER_PURPOSE)[keyof typeof OPENROUTER_PURPOSE];

/** Human labels for Activity generation_name / workspace classifier prompts. */
export const OPENROUTER_PURPOSE_LABEL: Record<OpenRouterPurpose, string> = {
  vision_extract: 'PTR vision extraction',
  text_extract: 'PTR text extract',
  doc_class: 'Document class routing',
  senate_paper_ocr: 'Senate paper page OCR',
  agreement_read: 'Agreement cascade re-read',
  benchmark: 'Benchmark / bakeoff',
  other: 'Other LLM call',
};

export type OpenRouterClassifierOpts = {
  /** Logical service (extractor / subsystem name). */
  service: string;
  /**
   * Stable purpose from OPENROUTER_PURPOSE — primary filter for "what was this
   * call for?" in Activity/logs.
   */
  purpose: OpenRouterPurpose;
  /**
   * Finer call-site tag. Defaults to purpose; prefer chamber-qualified tags
   * like vision-extract-house when known.
   */
  feature?: string;
  /** Human-readable name for Broadcast generation_name (defaults from purpose). */
  generationName?: string;
  /** Chamber when known (house|senate|executive). */
  chamber?: string | null;
  /** Secret name alias (never the raw key). Defaults to OPENROUTER_API_KEY. */
  keyRef?: string;
  /**
   * Deterministic per-doc/job id → OpenRouter top-level `user` (max 128).
   * Blank/undefined is omitted (never sent as "").
   */
  user?: string | null;
  /**
   * Run/session id → OpenRouter `session_id` (groups multi-model agreement /
   * cascade steps). Blank/undefined is omitted.
   */
  sessionId?: string | null;
};

/**
 * HTTP headers that create/maintain the OpenRouter app page for Congress.Trade.
 * Always include both X-OpenRouter-Title (current) and X-Title (back-compat).
 */
export function openRouterAttributionHeaders(): Record<string, string> {
  return {
    'HTTP-Referer': OPENROUTER_APP_REFERER,
    'X-OpenRouter-Title': OPENROUTER_APP_TITLE,
    // Back-compat: older OpenRouter analytics still honor X-Title.
    'X-Title': OPENROUTER_APP_TITLE,
  };
}

/**
 * Build request-body enrichment for an OpenRouter completions call.
 * Best-effort: returns undefined on any builder failure so a misconfigured
 * static field never blocks a paid extraction.
 *
 * Shape:
 *   { user?, session_id?, trace: { sourceApp, purpose, generation_name, … } }
 */
export function buildOpenRouterClassifier(
  env: Env,
  opts: OpenRouterClassifierOpts,
): OpenRouterRequestEnrichment | undefined {
  try {
    const feature = opts.feature || opts.purpose;
    const generationName =
      opts.generationName || OPENROUTER_PURPOSE_LABEL[opts.purpose] || opts.purpose;
    const base = openrouterRequestEnrichment({
      sourceApp: OPENROUTER_SOURCE_APP,
      environment: environmentName(env),
      service: opts.service,
      feature,
      keyRef: opts.keyRef || OPENROUTER_PRIMARY_KEY_REF,
      gitSha: env.CF_VERSION_METADATA?.id || env.CF_VERSION_METADATA?.tag || undefined,
      user: opts.user || undefined,
      sessionId: opts.sessionId || undefined,
    });
    // OpenRouter accepts arbitrary keys on `trace` (Broadcast + Activity).
    // Shared package only types the static classifier set; purpose tags ride
    // alongside for call-purpose reporting without a shared-package bump.
    const trace: OpenRouterRequestEnrichment['trace'] & Record<string, string> = {
      ...base.trace,
      purpose: opts.purpose,
      generation_name: generationName,
    };
    if (opts.chamber) trace.chamber = opts.chamber;
    return { ...base, trace };
  } catch (err) {
    console.warn(
      'openRouterAttribution: classifier enrichment failed; sending request without it:',
      (err as Error).message,
    );
    return undefined;
  }
}

/**
 * Flat metadata map for Usage-Monitor pushed events — mirrors classifier keys
 * so dashboard filters can group by purpose without parsing OR Activity alone.
 */
export function openRouterTelemetryMetadata(
  env: Env,
  opts: OpenRouterClassifierOpts,
): Record<string, string> {
  const enrichment = buildOpenRouterClassifier(env, opts);
  const meta: Record<string, string> = {
    sourceApp: OPENROUTER_SOURCE_APP,
    keyRef: opts.keyRef || OPENROUTER_PRIMARY_KEY_REF,
    purpose: opts.purpose,
  };
  if (enrichment?.trace.environment) meta.environment = enrichment.trace.environment;
  if (enrichment?.trace.service) meta.service = enrichment.trace.service;
  if (enrichment?.trace.feature) meta.feature = enrichment.trace.feature;
  if (enrichment?.trace.gitSha) meta.gitSha = enrichment.trace.gitSha;
  if (opts.chamber) meta.chamber = opts.chamber;
  if (opts.user) meta.user = String(opts.user).slice(0, 128);
  if (opts.sessionId) meta.sessionId = String(opts.sessionId).slice(0, 128);
  return meta;
}
