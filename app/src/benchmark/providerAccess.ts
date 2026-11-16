import type { Env } from '../shared/types.ts';
import { resolveSecret } from '../secrets/infisical.ts';
import { trackedFetch } from '../shared/thirdPartyTelemetry.ts';
import {
  classifyProviderFailure,
  type ProviderFailureStatus,
} from '../extraction/providerFailure.ts';

/**
 * Curated OpenAI models worth probing for disclosure-document benchmarks.
 * GPT-5.5/5.4 are access-dependent fallbacks, not automatic run candidates.
 * gpt-6-astra added 2026-09-18 (verified live on OpenRouter as openai/gpt-6-astra).
 */
export const OPENAI_BENCHMARK_ACCESS_MODELS = [
  'gpt-6-astra',
  'gpt-5.6-terra',
  'gpt-5.6-terra-pro',
  'gpt-5.6-luna',
  'gpt-5.6-sol',
  'gpt-5.5',
  'gpt-5.4',
] as const;

export type OpenAiModelAvailability = 'available' | 'unavailable' | 'unknown';
export type OpenAiModelAccessStatus = 'ready' | 'not_configured' | 'blocked' | 'error';

export interface OpenAiModelAccessEntry {
  provider: 'openai';
  model: string;
  availability: OpenAiModelAvailability;
  /** Convenience value for UI controls; null means the catalog check was inconclusive. */
  available: boolean | null;
  failure?: ProviderFailureStatus;
}

export interface OpenAiModelAccessReport {
  provider: 'openai';
  configured: boolean;
  status: OpenAiModelAccessStatus;
  catalogChecked: boolean;
  source: 'openai_v1_models';
  checkedAt: string;
  expiresAt: string | null;
  cached: boolean;
  models: OpenAiModelAccessEntry[];
  failure?: ProviderFailureStatus;
  errorCode?:
    | 'catalog_forbidden'
    | 'catalog_rate_limited'
    | 'catalog_unavailable'
    | 'invalid_catalog_response'
    | 'request_timeout'
    | 'network_error';
}

export interface OpenAiModelAccessOptions {
  models?: readonly string[];
  /** Ignore the in-isolate cache and perform a fresh, non-generation catalog request. */
  refresh?: boolean;
  cacheTtlMs?: number;
  errorCacheTtlMs?: number;
  timeoutMs?: number;
}

interface OpenAiModelAccessDependencies {
  resolveKey: (env: Env) => Promise<string | null>;
  request: typeof trackedFetch;
  now: () => number;
}

interface CacheEntry {
  expiresAtMs: number;
  report: OpenAiModelAccessReport;
}

const DEFAULT_CACHE_TTL_MS = 10 * 60_000;
const DEFAULT_ERROR_CACHE_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_CACHE_ENTRIES = 100;
const accessCache = new Map<string, CacheEntry>();

const DEFAULT_DEPENDENCIES: OpenAiModelAccessDependencies = {
  resolveKey: async (env) => (await resolveSecret(env, 'OPENAI_API_KEY')).value?.trim() || null,
  request: trackedFetch,
  now: () => Date.now(),
};

function boundedDuration(value: number | undefined, fallback: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1_000 && value <= max
    ? Math.floor(value)
    : fallback;
}

function requestedModels(input: readonly string[] | undefined): string[] {
  const source = input ?? OPENAI_BENCHMARK_ACCESS_MODELS;
  const models = [...new Set(source.map((model) => model.trim()).filter(Boolean))];
  if (!models.length) throw new Error('at least one OpenAI model is required');
  if (models.length > 50) throw new Error('at most 50 OpenAI models may be checked');
  return models;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, '0'))
    .join('');
}

function cloneReport(report: OpenAiModelAccessReport, cached: boolean): OpenAiModelAccessReport {
  return {
    ...report,
    cached,
    models: report.models.map((model) => ({ ...model })),
  };
}

function pruneCache(now: number): void {
  for (const [key, entry] of accessCache) {
    if (entry.expiresAtMs <= now) accessCache.delete(key);
  }
  while (accessCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = accessCache.keys().next().value as string | undefined;
    if (!oldest) break;
    accessCache.delete(oldest);
  }
}

function unavailableEntry(model: string, failure: ProviderFailureStatus): OpenAiModelAccessEntry {
  return {
    provider: 'openai',
    model,
    availability: 'unavailable',
    available: false,
    failure,
  };
}

function unknownEntry(model: string): OpenAiModelAccessEntry {
  return { provider: 'openai', model, availability: 'unknown', available: null };
}

function modelAccessFailure(model: string): ProviderFailureStatus {
  return {
    code: 'model_access_denied',
    scope: 'model',
    retryable: false,
    message: `The current openai project does not have access to ${model}.`,
  };
}

function providerNotConfiguredFailure(): ProviderFailureStatus {
  return {
    code: 'provider_not_configured',
    scope: 'provider',
    retryable: false,
    message: 'openai is not configured for this benchmark run.',
  };
}

async function readErrorClassification(
  response: Response,
): Promise<{ failure: ProviderFailureStatus | null; errorCode: OpenAiModelAccessReport['errorCode'] }> {
  let raw = '';
  try {
    raw = (await response.text()).slice(0, 4_000);
  } catch {
    // The status code still provides a stable, secret-safe classification.
  }
  const failure = response.status === 401
    ? {
        code: 'provider_authentication_failed',
        scope: 'provider',
        retryable: false,
        message: 'openai rejected the configured credential.',
      } satisfies ProviderFailureStatus
    : classifyProviderFailure('openai', 'model catalog', `openai ${response.status} ${raw}`);
  if (failure?.scope === 'provider') return { failure, errorCode: undefined };
  if (response.status === 403) return { failure: null, errorCode: 'catalog_forbidden' };
  if (response.status === 429) return { failure: null, errorCode: 'catalog_rate_limited' };
  if (response.status >= 500) return { failure: null, errorCode: 'catalog_unavailable' };
  return { failure: null, errorCode: 'invalid_catalog_response' };
}

function expiresAtIso(now: number, ttlMs: number): string {
  return new Date(now + ttlMs).toISOString();
}

function cacheReport(key: string, report: OpenAiModelAccessReport, expiresAtMs: number): void {
  accessCache.set(key, { report: cloneReport(report, false), expiresAtMs });
}

/**
 * Check the credential's project-visible model catalog without generating
 * tokens. The tracked request is still reported to usage.jays.services.
 */
export async function checkOpenAiModelAccess(
  env: Env,
  options: OpenAiModelAccessOptions = {},
  dependencies: OpenAiModelAccessDependencies = DEFAULT_DEPENDENCIES,
): Promise<OpenAiModelAccessReport> {
  const models = requestedModels(options.models);
  const now = dependencies.now();
  const checkedAt = new Date(now).toISOString();
  const key = await dependencies.resolveKey(env);
  if (!key) {
    const failure = providerNotConfiguredFailure();
    return {
      provider: 'openai',
      configured: false,
      status: 'not_configured',
      catalogChecked: false,
      source: 'openai_v1_models',
      checkedAt,
      expiresAt: null,
      cached: false,
      models: models.map((model) => unavailableEntry(model, failure)),
      failure,
    };
  }

  const cacheTtlMs = boundedDuration(options.cacheTtlMs, DEFAULT_CACHE_TTL_MS, 60 * 60_000);
  const errorCacheTtlMs = boundedDuration(
    options.errorCacheTtlMs,
    DEFAULT_ERROR_CACHE_TTL_MS,
    10 * 60_000,
  );
  const timeoutMs = boundedDuration(options.timeoutMs, DEFAULT_TIMEOUT_MS, 60_000);
  const cacheKey = await sha256(`${key}\u0000${models.join('\u0000')}`);
  pruneCache(now);
  const cached = accessCache.get(cacheKey);
  if (!options.refresh && cached && cached.expiresAtMs > now) {
    return cloneReport(cached.report, true);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await dependencies.request(
      'https://api.openai.com/v1/models',
      {
        method: 'GET',
        headers: { authorization: `Bearer ${key}` },
        signal: controller.signal,
      },
      { service: 'llm', operation: 'list-model-access', model: 'catalog' },
      fetch,
      { envOverride: env, silentQueueFailure: true },
    );
  } catch {
    const errorCode = controller.signal.aborted ? 'request_timeout' : 'network_error';
    const ttl = errorCacheTtlMs;
    const report: OpenAiModelAccessReport = {
      provider: 'openai',
      configured: true,
      status: 'error',
      catalogChecked: false,
      source: 'openai_v1_models',
      checkedAt,
      expiresAt: expiresAtIso(now, ttl),
      cached: false,
      models: models.map(unknownEntry),
      errorCode,
    };
    cacheReport(cacheKey, report, now + ttl);
    return report;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const classified = await readErrorClassification(response);
    const ttl = classified.failure ? cacheTtlMs : errorCacheTtlMs;
    const report: OpenAiModelAccessReport = {
      provider: 'openai',
      configured: true,
      status: classified.failure ? 'blocked' : 'error',
      catalogChecked: false,
      source: 'openai_v1_models',
      checkedAt,
      expiresAt: expiresAtIso(now, ttl),
      cached: false,
      models: classified.failure
        ? models.map((model) => unavailableEntry(model, classified.failure as ProviderFailureStatus))
        : models.map(unknownEntry),
      ...(classified.failure ? { failure: classified.failure } : {}),
      ...(classified.errorCode ? { errorCode: classified.errorCode } : {}),
    };
    cacheReport(cacheKey, report, now + ttl);
    return report;
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  const data = payload && typeof payload === 'object'
    ? (payload as { data?: unknown }).data
    : null;
  if (!Array.isArray(data) || data.some((item) =>
    !item || typeof item !== 'object' || typeof (item as { id?: unknown }).id !== 'string')) {
    const report: OpenAiModelAccessReport = {
      provider: 'openai',
      configured: true,
      status: 'error',
      catalogChecked: false,
      source: 'openai_v1_models',
      checkedAt,
      expiresAt: expiresAtIso(now, errorCacheTtlMs),
      cached: false,
      models: models.map(unknownEntry),
      errorCode: 'invalid_catalog_response',
    };
    cacheReport(cacheKey, report, now + errorCacheTtlMs);
    return report;
  }

  const availableIds = new Set(data.map((item) => (item as { id: string }).id));
  const report: OpenAiModelAccessReport = {
    provider: 'openai',
    configured: true,
    status: 'ready',
    catalogChecked: true,
    source: 'openai_v1_models',
    checkedAt,
    expiresAt: expiresAtIso(now, cacheTtlMs),
    cached: false,
    models: models.map((model) => availableIds.has(model)
      ? { provider: 'openai', model, availability: 'available', available: true }
      : unavailableEntry(model, modelAccessFailure(model))),
  };
  cacheReport(cacheKey, report, now + cacheTtlMs);
  return report;
}

export function openAiModelAccessDecision(
  report: OpenAiModelAccessReport,
  model: string,
): OpenAiModelAvailability {
  return report.models.find((entry) => entry.model === model)?.availability ?? 'unknown';
}

/** Test isolation only; production refreshes through checkOpenAiModelAccess({refresh:true}). */
export function clearOpenAiModelAccessCacheForTests(): void {
  accessCache.clear();
}
