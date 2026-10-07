/**
 * Complete outbound-call accounting for congress.trade.
 *
 * Every deployed Worker-owned third-party HTTP attempt passes through `trackedFetch`.
 * The active Worker invocation's Env is carried with AsyncLocalStorage, so
 * provider adapters can remain test-injectable without threading Env through
 * every helper. Each attempt (including retries and failures) is durably handed
 * to INGEST_QUEUE (or the failure-only R2 outbox) and delivered to
 * usage.jays.services.
 *
 * Security invariant: the queued event never contains a URL, host, path, query,
 * header, request/response body, user identifier, or provider error message.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import {
  API_USAGE_MONITOR_INGEST_PATH,
  createUsageTelemetryClient,
  LegacyUsageTelemetryOutboxEventSchema,
  UsageTelemetryV2EventSchema,
} from '@jaywedgeworth22/congress-trading-shared';
import type { LegacyUsageTelemetryOutboxEventInput } from '@jaywedgeworth22/congress-trading-shared';
import { resolveSecrets } from '../secrets/infisical.ts';
import { startDatadogSpan } from './datadog.ts';
import { withDatadogLlmObs } from './datadogLlmobs.ts';
import type { Env, ThirdPartyUsageTelemetryEvent } from './types.ts';

interface TelemetryContext {
  env: Env;
  /** Prevent self-observation while resolving/sending Usage Monitor events. */
  suppressed: boolean;
}

const context = new AsyncLocalStorage<TelemetryContext>();
const USAGE_TELEMETRY_FALLBACK_PREFIX = '_ops/usage-telemetry/';
const USAGE_TELEMETRY_QUARANTINE_PREFIX = '_ops/usage-telemetry-quarantine/';

// --- Circuit breaker + legacy-D1-drain durable markers ----------------------
// Both live in CONFIG_KV as a single key each (not per-event), so an outage
// that generates many events never multiplies KV writes with event volume.
/** Consecutive-failure count + open-until timestamp; see isUsageTelemetryCircuitOpen. */
const USAGE_TELEMETRY_CIRCUIT_KV_KEY = 'usage_telemetry_circuit_breaker';
/** Set once the legacy D1 fallback table is observed empty, so the scheduled
 *  flush stops re-querying an empty table forever. */
const USAGE_TELEMETRY_D1_DRAIN_COMPLETE_KV_KEY = 'usage_telemetry_d1_drain_complete';
/** Best-effort pending-R2-outbox object count, so the capacity cap is an O(1) KV
 *  read on the write path instead of an unbounded (and thus unenforceable) R2
 *  list. Reconciled during flush; see usageTelemetryOutboxAtCapacity. */
const USAGE_TELEMETRY_OUTBOX_COUNT_KV_KEY = 'usage_telemetry_outbox_count';
/** A legacy D1 fallback row is dropped after this many failed drain attempts so a
 *  poison/undeliverable row can't wedge the oldest-first drain. Small on purpose:
 *  the table is legacy and is only ever drained while the receiver is healthy. */
const USAGE_TELEMETRY_D1_MAX_ROW_ATTEMPTS = 5;

type LegacyThirdPartyUsageTelemetryEvent = LegacyUsageTelemetryOutboxEventInput & {
  idempotencyKey: string;
  sourceApp: 'congress-trade';
};
type DeliverableUsageTelemetryEvent =
  | ThirdPartyUsageTelemetryEvent
  | LegacyThirdPartyUsageTelemetryEvent;

function isV2UsageTelemetryEvent(
  event: DeliverableUsageTelemetryEvent,
): event is ThirdPartyUsageTelemetryEvent {
  return 'eventId' in event && typeof event.eventId === 'string';
}

function usageTelemetryEventIdentity(event: DeliverableUsageTelemetryEvent): string {
  return isV2UsageTelemetryEvent(event) ? event.eventId : event.idempotencyKey;
}

export interface UsageTelemetryFallbackHealth {
  available: boolean;
  pending: number | null;
  truncated: boolean;
  /** True while the circuit breaker is suppressing live delivery attempts. */
  circuitOpen: boolean;
}

/** Secret-free local durability snapshot for admin diagnostics. */
export async function inspectUsageTelemetryFallback(
  env: Env,
  limit = 1_000,
): Promise<UsageTelemetryFallbackHealth> {
  const storage = (env as Partial<Env>).RAW_FILES;
  const boundedLimit = Math.max(1, Math.min(1_000, Math.floor(limit)));
  let available = false;
  let pending = 0;
  let truncated = false;
  try {
    if (storage?.list) {
      const listed = await storage.list({
        prefix: USAGE_TELEMETRY_FALLBACK_PREFIX,
        limit: boundedLimit,
      });
      available = true;
      pending += listed.objects.length;
      truncated = listed.truncated === true;
    }
  } catch {}
  try {
    const row = await env.DB.prepare(
      'SELECT COUNT(*) AS pending FROM usage_telemetry_fallback_events',
    ).first<{ pending: number }>();
    available = true;
    pending += Math.max(0, Number(row?.pending ?? 0));
  } catch {}
  const circuitOpen = await isUsageTelemetryCircuitOpen(env);
  return available
    ? { available, pending, truncated, circuitOpen }
    : { available: false, pending: null, truncated: false, circuitOpen };
}

export type DynamicThirdPartyTarget =
  | 'subscriber-webhook'
  | 'peer-app'
  | 'filing-source'
  | 'seed-source'
  | 'infisical';

export interface TrackedFetchDescriptor {
  /** Stable product surface, for example `llm`, `market-data`, or `oauth`. */
  service: string;
  /** Stable operation name. Never pass a URL/path/user value here. */
  operation: string;
  /** Concrete model/version when this is a model call. */
  model?: string;
  /** Required only when the destination is intentionally operator/user configured. */
  dynamicTarget?: DynamicThirdPartyTarget;
}

interface MeasuredThirdPartyUsageFields {
  provider: string;
  service: string;
  operation: string;
  model?: string;
  metricType?: 'usage' | 'cost' | 'limit';
  quantity?: number;
  unit?: ThirdPartyUsageTelemetryEvent['unit'];
  costUsd?: number;
  requests?: number;
  credits?: number;
  billingMode?: ThirdPartyUsageTelemetryEvent['billingMode'];
  confidence?: ThirdPartyUsageTelemetryEvent['confidence'];
  metadata?: Record<string, string | number | boolean | null>;
  /**
   * Secret-name alias for the key that produced this measurement (never the
   * raw secret). Usage-Monitor key attribution binds this to a project/app —
   * e.g. OPENROUTER_API_KEY → congress-trade. Optional.
   */
  producerKeyRef?: string;
  /**
   * Provider-side call/generation id (e.g. OpenRouter's `id` on a completions
   * response), for monitor-side spend verification (`GET
   * /api/v1/generation?id=...`). Callers must pass `undefined` — never `""`
   * — when absent; an empty string would fail the shared schema's `min(1)`
   * constraint on delivery. Never part of the idempotency-key basis (see
   * measuredUsageKey/baseEvent below), matching the shared package contract.
   */
  providerRequestId?: string;
}

/**
 * Stable measured events must carry the stable time of the source occurrence.
 * Reconstructing the same key with a fresh timestamp changes the receiver's
 * collision-checked payload and is therefore not a valid idempotent replay.
 */
export type MeasuredThirdPartyUsage = MeasuredThirdPartyUsageFields & (
  | {
      idempotencyKey: string;
      occurredAt: string;
    }
  | {
      idempotencyKey?: undefined;
      occurredAt?: string;
    }
);

const HOST_PROVIDERS = new Map<string, string>([
  ['api.openai.com', 'openai'],
  ['api.anthropic.com', 'anthropic'],
  ['api.mistral.ai', 'mistral'],
  ['api.x.ai', 'xai'],
  ['generativelanguage.googleapis.com', 'gemini'],
  ['api.cloud.llamaindex.ai', 'llamaparse'],
  ['financialmodelingprep.com', 'fmp'],
  ['financial-modeling-prep.p.rapidapi.com', 'fmp'],
  ['fmp-api.p.rapidapi.com', 'fmp'],
  ['api.unusualwhales.com', 'unusual-whales'],
  ['api.quiverquant.com', 'quiver-quant'],
  ['api.massive.com', 'massive'],
  ['finnhub.io', 'finnhub'],
  ['api.twelvedata.com', 'twelve-data'],
  ['api-v2.intrinio.com', 'intrinio'],
  ['api.tiingo.com', 'tiingo'],
  ['www.sec.gov', 'sec-edgar'],
  ['data.sec.gov', 'sec-edgar'],
  ['disclosures-clerk.house.gov', 'house-disclosures'],
  ['efdsearch.senate.gov', 'senate-disclosures'],
  ['extapps2.oge.gov', 'oge'],
  ['raw.githubusercontent.com', 'github'],
  ['unitedstates.github.io', 'github'],
  ['house-stock-watcher-data.s3-us-west-2.amazonaws.com', 'house-stock-watcher'],
  ['img.logo.dev', 'logo-dev'],
  ['api.resend.com', 'resend'],
  ['api.stripe.com', 'stripe'],
  ['oauth2.googleapis.com', 'google'],
  ['openidconnect.googleapis.com', 'google'],
  ['cloudflare-dns.com', 'cloudflare-dns'],
  ['app.infisical.com', 'infisical'],
  ['usage.jays.services', 'usage-monitor'],
  ['openrouter.ai', 'openrouter'],
]);

const HOST_SUFFIX_PROVIDERS: Array<[suffix: string, provider: string]> = [
  ['.cloudflareaccess.com', 'cloudflare-access'],
  ['.sentry.io', 'sentry'],
  ['.datadoghq.com', 'datadog'],
  ['.datadoghq.eu', 'datadog'],
];

const DYNAMIC_PROVIDERS: Record<DynamicThirdPartyTarget, string> = {
  'subscriber-webhook': 'webhook',
  'peer-app': 'peer-app',
  'filing-source': 'filing-source',
  'seed-source': 'seed-source',
  infisical: 'infisical',
};

const SAFE_METADATA_KEYS = new Set([
  'model',
  'success',
  'status',
  'latencyMs',
  'rateLimited',
  'errorType',
  'promptTokens',
  'completionTokens',
  'cachedTokens',
  'cacheWriteTokens',
  'cacheWriteOneHourTokens',
  'serviceTier',
  'toolName',
  'attachmentSearchCalls',
  'costInUsdTicks',
  'pagesProcessed',
  'costSource',
  'costCoverage',
  'benchmarkRunId',
  'job',
  'fmpCallsThisRun',
  'priceProvider',
  'errors',
  'transport',
]);

function stableTag(value: string, fallback: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return (normalized || fallback).slice(0, 80);
}

function safeMetadata(
  metadata: Record<string, string | number | boolean | null> | undefined,
): Record<string, string | number | boolean | null> {
  const safe: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (!SAFE_METADATA_KEYS.has(key)) continue;
    if (typeof value === 'number') {
      if (Number.isFinite(value) && value >= 0) safe[key] = value;
    } else if (typeof value === 'string') {
      safe[key] = stableTag(value, 'unknown');
    } else {
      safe[key] = value;
    }
  }
  return safe;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

export function providerForThirdPartyRequest(
  input: RequestInfo | URL,
  dynamicTarget?: DynamicThirdPartyTarget,
): string {
  if (dynamicTarget) return DYNAMIC_PROVIDERS[dynamicTarget];
  try {
    const hostname = new URL(requestUrl(input)).hostname.toLowerCase().replace(/\.$/, '');
    return HOST_PROVIDERS.get(hostname)
      ?? HOST_SUFFIX_PROVIDERS.find(([suffix]) => hostname.endsWith(suffix))?.[1]
      ?? 'external-api';
  } catch {
    return 'external-api';
  }
}

export function remapOpenRouterTelemetry(provider: string, model?: string): { provider: string; model?: string; transport?: string } {
  if (provider === 'openrouter' && model) {
    const parts = model.split('/');
    if (parts.length > 1) {
      const orProvider = parts[0].toLowerCase();
      // map known openrouter prefixes to our internal provider names
      let mappedProvider = orProvider;
      if (orProvider === 'google') mappedProvider = 'gemini';
      else if (orProvider === 'x-ai') mappedProvider = 'xai';

      const mappedModel = parts.slice(1).join('/');
      return { provider: mappedProvider, model: mappedModel, transport: 'openrouter' };
    }
  }
  return { provider, model };
}

/**
 * Remapping OpenRouter events changes the receiver-visible provider/model
 * dimensions. Version an existing stable key when that happens so a replay of
 * a pre-remap event cannot collide with the new payload under the old key.
 */
function measuredUsageKey(
  idempotencyKey: string | undefined,
  transport: string | undefined,
): string | undefined {
  return idempotencyKey && transport ? `${idempotencyKey}:transport-v2` : idempotencyKey;
}

/**
 * Exported so other call sites (e.g. the OpenRouter classifier-metadata
 * enrichment built for the outbound request in openRouterVision.ts) can stay
 * byte-identical with the environment value this module actually pushes on
 * every telemetry event, instead of re-deriving their own definition.
 */
export function environmentName(env: Env): string {
  return (env.USAGE_MONITOR_ENVIRONMENT || env.INFISICAL_ENV || 'production').trim() || 'production';
}

function eventId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

function encodeStableKeyField(value: string): string {
  return `${new TextEncoder().encode(value).byteLength}:${value}`;
}

/**
 * Fixed-length key for independently reconstructed measured events. Dimension
 * is part of the length-prefixed preimage before hashing, so long or similarly
 * normalized provider identifiers cannot collapse distinct usage dimensions.
 */
export async function stableMeasuredUsageIdempotencyKey(
  namespace: string,
  dimension: string,
  ...identity: string[]
): Promise<string> {
  const preimage = ['congress-trade', namespace, dimension, ...identity]
    .map(encodeStableKeyField)
    .join('');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(preimage));
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `ct-measured-${hex}`;
}

function nonNegativeFinite(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function canonicalOccurredAt(value: string | undefined): string {
  if (value == null) return new Date().toISOString();
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new TypeError('telemetry occurredAt must be a valid timestamp');
  return new Date(timestamp).toISOString();
}

function rejectMeasuredUsage(errorType: 'missingOccurredAt' | 'invalidOccurredAt'): false {
  // Never include the key, timestamp, provider payload, or arbitrary caller
  // values in this diagnostic; measured telemetry must remain product-safe.
  console.error('usage telemetry event rejected', { errorType });
  return false;
}

/**
 * Defensive clamp matching the shared package's `UsageTelemetryEventSchema`
 * (`.trim().min(1).max(200)`) so a pathological provider-returned id can
 * never throw inside `createUsageTelemetryClient().send()` and take down
 * delivery of an otherwise-valid event. Blank/whitespace-only collapses to
 * `undefined` — never an empty string on the wire.
 */
function sanitizeProviderRequestId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 200) : undefined;
}

function baseEvent(
  env: Env,
  input: {
    provider: string;
    service: string;
    operation: string;
    idempotencyKey?: string;
    occurredAt?: string;
    model?: string;
    metricType: 'usage' | 'cost' | 'limit';
    billingMode: ThirdPartyUsageTelemetryEvent['billingMode'];
    confidence: ThirdPartyUsageTelemetryEvent['confidence'];
    providerRequestId?: string;
    producerKeyRef?: string;
  },
): ThirdPartyUsageTelemetryEvent {
  const service = stableTag(input.service, 'external-api');
  const operation = stableTag(input.operation, 'request');
  const idempotencyKey = input.idempotencyKey
    ? stableTag(input.idempotencyKey, 'ct-third-party')
    : eventId('ct-third-party');
  const producerKeyRef = input.producerKeyRef?.trim()
    ? stableTag(input.producerKeyRef, 'key-ref')
    : undefined;
  return {
    eventId: idempotencyKey,
    environment: environmentName(env),
    provider: stableTag(input.provider, 'external-api'),
    service,
    project: 'congress-trade',
    label: operation,
    ...(producerKeyRef ? { producerKeyRef } : {}),
    billingMode: input.billingMode,
    metricType: input.metricType,
    confidence: input.confidence,
    occurredAt: canonicalOccurredAt(input.occurredAt),
    metadata: input.model ? { model: stableTag(input.model, 'unknown-model') } : undefined,
    providerRequestId: sanitizeProviderRequestId(input.providerRequestId),
  };
}

/**
 * Queue one event without ever failing the product call that generated it.
 * Queue rejection falls back to R2; only exhaustion of both paths is logged.
 */
export async function enqueueUsageTelemetryEvent(
  env: Env,
  event: ThirdPartyUsageTelemetryEvent,
  options: { silentFailure?: boolean } = {},
): Promise<boolean> {
  try {
    await env.INGEST_QUEUE.send({ type: 'usage.telemetry', event });
    return true;
  } catch {
    // Failure-only durable outbox. RAW_FILES is an existing strongly-consistent
    // R2 binding, and the receiver idempotency key makes Queue/R2 races safe.
    return persistUsageTelemetryFallback(env, event, options);
  }
}

function usageTelemetryFallbackKey(event: ThirdPartyUsageTelemetryEvent): string {
  return `${USAGE_TELEMETRY_FALLBACK_PREFIX}${encodeURIComponent(event.eventId)}.json`;
}

function parseUsageTelemetryFallback(raw: string): DeliverableUsageTelemetryEvent {
  const input = JSON.parse(raw);
  const v2 = UsageTelemetryV2EventSchema.safeParse(input);
  if (v2.success) {
    const parsed = v2.data;
    if (
      parsed.project !== 'congress-trade'
      || !parsed.environment
      || !parsed.service
      || !parsed.label
      || !parsed.occurredAt
      || !['usage', 'cost', 'limit'].includes(parsed.metricType)
    ) {
      throw new Error('fallback telemetry event is not a congress.trade event');
    }
    return parsed as ThirdPartyUsageTelemetryEvent;
  }

  const parsed = LegacyUsageTelemetryOutboxEventSchema.parse(input);
  if (
    parsed.sourceApp !== 'congress-trade'
    || parsed.project !== 'congress-trade'
    || !parsed.environment
    || !parsed.service
    || !parsed.label
    || !parsed.occurredAt
    || !['usage', 'cost', 'limit'].includes(parsed.metricType)
  ) {
    throw new Error('fallback telemetry event is not a congress.trade event');
  }
  return parsed as LegacyThirdPartyUsageTelemetryEvent;
}

function usageTelemetryErrorType(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

// --- Env-tunable circuit breaker + outbox limits (see types.ts for the Env
// fields; every one has a safe built-in default and none require a redeploy) --
//
// These are read from the immutable Worker env (like every other telemetry limit
// here and like SENTRY_TRACES_SAMPLE_RATE), NOT from the app's dynamic config
// source (D1 poll_config / CONFIG_KV cache / Infisical). That is deliberate:
// they are operational safety limits read synchronously on the hot path (every
// telemetry write and flush), so they must be O(1) and ALWAYS available — even
// during an incident where KV, D1, or Infisical is the very thing degraded.
// Routing an anti-overage safety limit through a runtime source that can itself
// be down (or that would add a per-write round-trip) is an anti-pattern. Worker
// vars are still operator-overridable via wrangler `[vars]` / Infisical-backed
// secrets without a code change.

function usageTelemetryCircuitFailureThreshold(env: Env): number {
  const n = Number.parseInt(env.USAGE_TELEMETRY_CIRCUIT_FAILURE_THRESHOLD ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 3;
}

function usageTelemetryCircuitBaseBackoffMs(env: Env): number {
  const n = Number.parseInt(env.USAGE_TELEMETRY_CIRCUIT_BASE_BACKOFF_MS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 30_000;
}

function usageTelemetryCircuitMaxBackoffMs(env: Env): number {
  const n = Number.parseInt(env.USAGE_TELEMETRY_CIRCUIT_MAX_BACKOFF_MS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 1_800_000;
}

function usageTelemetryDeliveryTimeoutMs(env: Env): number {
  const n = Number.parseInt(env.USAGE_TELEMETRY_DELIVERY_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 60_000) : 15_000;
}

function usageTelemetryCircuitProbeLeaseMs(env: Env): number {
  const timeoutFloor = usageTelemetryDeliveryTimeoutMs(env) + 5_000;
  const n = Number.parseInt(env.USAGE_TELEMETRY_CIRCUIT_PROBE_LEASE_MS ?? '', 10);
  const configured = Number.isFinite(n) && n > 0 ? n : 30_000;
  return Math.min(300_000, Math.max(timeoutFloor, configured));
}

function usageTelemetryFallbackMaxObjects(env: Env): number {
  const n = Number.parseInt(env.USAGE_TELEMETRY_FALLBACK_MAX_OBJECTS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 5_000;
}

function usageTelemetryFallbackTtlMs(env: Env): number {
  const n = Number.parseInt(env.USAGE_TELEMETRY_FALLBACK_TTL_DAYS ?? '', 10);
  const days = Number.isFinite(n) && n > 0 ? n : 14;
  return days * 24 * 60 * 60 * 1000;
}

function usageTelemetryD1DrainLimit(env: Env): number {
  const n = Number.parseInt(env.USAGE_TELEMETRY_D1_DRAIN_LIMIT ?? '', 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 500) : 100;
}

// --- Circuit breaker state (durable in CONFIG_KV; one key, not per-event) ---

interface UsageTelemetryCircuitState {
  consecutiveFailures: number;
  /** Epoch ms until which live delivery is suppressed; null means closed. */
  openUntil: number | null;
}

const CLOSED_USAGE_TELEMETRY_CIRCUIT: UsageTelemetryCircuitState = {
  consecutiveFailures: 0,
  openUntil: null,
};

async function readUsageTelemetryCircuitState(env: Env): Promise<UsageTelemetryCircuitState | null> {
  const kv = (env as Partial<Env>).CONFIG_KV;
  if (!kv) return CLOSED_USAGE_TELEMETRY_CIRCUIT;
  try {
    const stored = await kv.get<UsageTelemetryCircuitState>(USAGE_TELEMETRY_CIRCUIT_KV_KEY, 'json');
    if (stored == null) return CLOSED_USAGE_TELEMETRY_CIRCUIT;
    if (
      Number.isFinite(stored.consecutiveFailures)
      && stored.consecutiveFailures >= 0
      && (stored.openUntil == null || Number.isFinite(stored.openUntil))
    ) return stored;
    // A malformed persisted state is an unavailable control plane, not proof
    // that the receiver is healthy. Fail closed until it is repaired/expired.
    return null;
  } catch {
    // The breaker control plane is unavailable. Production always binds
    // CONFIG_KV, so fail closed to R2 rather than hammering a receiver whose
    // outage state cannot be read.
    return null;
  }
  return CLOSED_USAGE_TELEMETRY_CIRCUIT;
}

async function writeUsageTelemetryCircuitState(env: Env, state: UsageTelemetryCircuitState): Promise<boolean> {
  const kv = (env as Partial<Env>).CONFIG_KV;
  if (!kv) return false;
  try {
    // A week-long TTL just bounds worst-case staleness; every delivery attempt
    // (success or failure) rewrites this key on its own cadence regardless.
    await kv.put(USAGE_TELEMETRY_CIRCUIT_KV_KEY, JSON.stringify(state), { expirationTtl: 7 * 24 * 3600 });
    return true;
  } catch {
    return false;
  }
}

/** True while the circuit breaker is suppressing live delivery attempts. */
export async function isUsageTelemetryCircuitOpen(env: Env): Promise<boolean> {
  const state = await readUsageTelemetryCircuitState(env);
  if (!state) return true;
  return state.openUntil != null && Date.now() < state.openUntil;
}

/**
 * Reset on a successful delivery. Skips the KV write entirely when the
 * circuit is already closed, so a healthy receiver never pays a write per
 * delivered event — only actual state transitions touch KV.
 */
async function recordUsageTelemetryDeliverySuccess(env: Env): Promise<boolean> {
  const state = await readUsageTelemetryCircuitState(env);
  if (!state) return false;
  if (state.consecutiveFailures === 0 && state.openUntil == null) return true;
  return writeUsageTelemetryCircuitState(env, CLOSED_USAGE_TELEMETRY_CIRCUIT);
}

/** The later of two open-until deadlines; a set deadline always beats null. */
function laterUsageTelemetryOpenUntil(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.max(a, b);
}

/**
 * Claim the singleton D1 lease only when an open circuit's cooldown elapsed.
 * The conditional upsert is one atomic SQLite statement: exactly one contender
 * observes `meta.changes === 1`; every concurrent contender fails closed before
 * calling the receiver. Closed-circuit traffic never touches D1.
 */
async function claimUsageTelemetryHalfOpenProbe(
  env: Env,
  state: UsageTelemetryCircuitState,
): Promise<{ token: string; expiresAtMs: number } | null> {
  if (state.openUntil == null) return null;
  const nowMs = Date.now();
  if (nowMs < state.openUntil) throw new UsageTelemetryCircuitOpenError();
  const db = (env as Partial<Env>).DB;
  if (!db?.prepare) throw new UsageTelemetryProbeLeaseUnavailableError();
  const token = crypto.randomUUID();
  const now = new Date(nowMs).toISOString();
  const expiresAtMs = nowMs + usageTelemetryCircuitProbeLeaseMs(env);
  const expiresAt = new Date(expiresAtMs).toISOString();
  try {
    const result = await db.prepare(
      `INSERT INTO usage_telemetry_probe_lease (id, lease_token, expires_at, updated_at)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         lease_token = excluded.lease_token,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at
       WHERE usage_telemetry_probe_lease.expires_at <= excluded.updated_at`,
    )
      .bind(token, expiresAt, now)
      .run();
    if (Number(result.meta?.changes ?? 0) !== 1) {
      throw new UsageTelemetryProbeLeaseContendedError();
    }
    return { token, expiresAtMs };
  } catch (error) {
    if (error instanceof UsageTelemetryProbeLeaseContendedError) throw error;
    // Missing migration, D1 outage, or an unknown result all fail closed. A
    // half-open coordination failure must never turn into concurrent probes.
    throw new UsageTelemetryProbeLeaseUnavailableError();
  }
}

class UsageTelemetryDeliveryHttpError extends Error {
  constructor(readonly status: number, message?: string) {
    // Preserve the shared client's sanitized receiver message alongside the
    // status. Classification must distinguish an event-specific 400/409/422
    // from a receiver-wide contract or configuration failure.
    super(message || `usage telemetry receiver rejected request (HTTP ${status})`);
    this.name = 'UsageTelemetryDeliveryHttpError';
  }
}

/** A successful HTTP response is not proof that the receiver accepted this
 * event. Keep incomplete ACKs retryable, including malformed response bodies:
 * receiver contract failures must never be classified as poison event data. */
class UsageTelemetryDeliveryAckError extends Error {
  constructor() {
    super('usage telemetry receiver did not acknowledge delivery');
    this.name = 'UsageTelemetryDeliveryAckError';
  }
}

/** A valid ACK rejected this event, rather than failing the receiver. Queue
 * ownership may end only after a recoverable quarantine copy exists. */
class UsageTelemetryDeliveryEventRejectedError extends Error {
  constructor(readonly quarantined: boolean) {
    super(quarantined
      ? 'usage telemetry event rejected; preserved in quarantine for replay'
      : 'usage telemetry event rejected; quarantine unavailable');
    this.name = 'UsageTelemetryDeliveryEventRejectedError';
  }
}

/** The receiver adds bounded per-event details outside the shared ACK schema.
 * Validate their request identity before omitting only this known extension.
 * Counts and all remaining fields still pass the strict shared validator. */
function usageTelemetryAckPayload(payload: unknown, eventId: string): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || !('rejections' in payload)) return payload;
  const { rejections, ...ack } = payload as Record<string, unknown>;
  if (!Array.isArray(rejections) || rejections.length > 1
    || (rejections.length > 0 && (ack.received !== 1 || ack.rejected !== 1))
    || rejections.some((detail) => !detail || typeof detail !== 'object' || Array.isArray(detail)
      || Object.keys(detail).some((key) => !['index', 'eventId', 'issues'].includes(key))
      || detail.index !== 0
      || (detail.eventId !== undefined && detail.eventId !== eventId)
      || !Array.isArray(detail.issues) || !detail.issues.every((issue: unknown) => typeof issue === 'string'))) {
    throw new UsageTelemetryDeliveryAckError();
  }
  return ack;
}

function usageTelemetryErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as { status?: unknown; response?: { status?: unknown } };
  const status = candidate.status ?? candidate.response?.status;
  return typeof status === 'number' && Number.isInteger(status) ? status : null;
}

/** True for durably quarantined rejected events or deterministic legacy HTTP
 * rejections. Malformed/ambiguous ACKs always remain retryable. The plain-error
 * branch keeps the queue boundary compatible with a future shared client that
 * exposes status/message directly instead of the local HTTP wrapper. */
export function isTerminalUsageTelemetryDeliveryError(error: unknown): boolean {
  if (error instanceof UsageTelemetryCircuitOpenError || error instanceof UsageTelemetryDeliveryAckError) return false;
  if (error instanceof UsageTelemetryDeliveryEventRejectedError) return error.quarantined;
  if (error instanceof UsageTelemetryDeliveryHttpError) {
    const eventSpecific = /\b(?:schema|idempotency|invalid payload|malformed payload|required.*idempotency|event\s+\d+.*invalid)\b/i.test(error.message);
    return eventSpecific || (error.status === 400 && /\b(?:validation|field|property)\b/i.test(error.message));
  }
  const status = usageTelemetryErrorStatus(error);
  const message = error instanceof Error ? error.message : String(error ?? '');
  const eventSpecific = /\b(?:schema|idempotency|invalid payload|malformed payload|required.*idempotency|event\s+\d+.*invalid)\b/i.test(message);
  if (eventSpecific) return true;
  return status === 400 && /\b(?:validation|field|property)\b/i.test(message);
}

async function writeUsageTelemetryQuarantine(
  storage: R2Bucket | undefined,
  idempotencyKey: string,
  payload: string,
  reason: 'malformed' | 'terminal_receiver_rejection',
): Promise<boolean> {
  if (!storage?.put) return false;
  const quarantineKey = `${USAGE_TELEMETRY_QUARANTINE_PREFIX}${encodeURIComponent(idempotencyKey)}.json`;
  try {
    await storage.put(quarantineKey, payload, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { reason },
    });
    return true;
  } catch {
    return false;
  }
}

async function advanceTerminalLegacyUsageTelemetryRow(
  db: D1Database,
  storage: R2Bucket | undefined,
  row: { idempotency_key: string; event_json: string; attempts: number },
  reason: 'malformed' | 'terminal_receiver_rejection',
): Promise<void> {
  const attempts = Number(row.attempts ?? 0) + 1;
  if (attempts >= USAGE_TELEMETRY_D1_MAX_ROW_ATTEMPTS) {
    const quarantined = await writeUsageTelemetryQuarantine(
      storage,
      row.idempotency_key,
      row.event_json,
      reason,
    );
    if (!quarantined) {
      // Never delete the only durable copy if quarantine persistence fails.
      return;
    }
    await db.prepare(
      'DELETE FROM usage_telemetry_fallback_events WHERE idempotency_key = ?',
    )
      .bind(row.idempotency_key)
      .run();
    return;
  }
  await db.prepare(
    `UPDATE usage_telemetry_fallback_events
        SET attempts = ?, updated_at = ?
      WHERE idempotency_key = ?`,
  )
    .bind(attempts, new Date().toISOString(), row.idempotency_key)
    .run();
}

async function releaseUsageTelemetryHalfOpenProbe(env: Env, token: string): Promise<void> {
  try {
    await env.DB.prepare(
      'DELETE FROM usage_telemetry_probe_lease WHERE id = 1 AND lease_token = ?',
    )
      .bind(token)
      .run();
  } catch {
    // A stale lease expires on its own. Never weaken the breaker because
    // cleanup failed after the receiver was already proven healthy.
  }
}

/**
 * Exponential backoff keyed off consecutive failures past the threshold, capped
 * at usageTelemetryCircuitMaxBackoffMs. Once `openUntil` elapses, the next real
 * delivery must atomically claim the singleton D1 half-open lease. That keeps
 * only one receiver probe in flight across isolates. A successful probe closes
 * the KV circuit before releasing the lease; a failed probe reopens the circuit
 * and leaves the short lease to expire.
 *
 * Concurrency: CONFIG_KV has no atomic increment (an exact counter would need a
 * Durable Object, which is unjustified for a best-effort storm-brake and would
 * serialize every delivery through one instance). So concurrent recorders can
 * lose an increment during a receiver outage. This is deliberately tolerated
 * because the breaker only has to STOP a runaway storm, not count exactly, and
 * the dominant incident cost — D1 write amplification — is already eliminated
 * unconditionally (D1 is drain-only). To keep a lost update from doing HARM, the
 * write is monotonic: it re-reads immediately before persisting and merges, so a
 * racing writer can never (a) lower consecutiveFailures or (b) clear/shorten an
 * openUntil that another recorder just set. Net effect of a lost increment is
 * therefore bounded EXTRA failures before opening — never reset progress and
 * never a re-closed circuit. Only recordUsageTelemetryDeliverySuccess (a real
 * 2xx, i.e. the receiver is actually healthy) resets the state.
 */
async function recordUsageTelemetryDeliveryFailure(env: Env): Promise<boolean> {
  const state = await readUsageTelemetryCircuitState(env) ?? CLOSED_USAGE_TELEMETRY_CIRCUIT;
  const proposedFailures = state.consecutiveFailures + 1;
  const threshold = usageTelemetryCircuitFailureThreshold(env);
  const proposedOpenUntil = proposedFailures >= threshold
    ? Date.now() + Math.min(
        usageTelemetryCircuitMaxBackoffMs(env),
        usageTelemetryCircuitBaseBackoffMs(env) * 2 ** (proposedFailures - threshold),
      )
    : state.openUntil;
  // Monotonic merge-on-write: re-read the current stored state and never regress
  // below it, so a concurrent failure recorder's progress toward opening (or an
  // open circuit it just tripped) is never lost to this write. See note above.
  const current = await readUsageTelemetryCircuitState(env) ?? state;
  return writeUsageTelemetryCircuitState(env, {
    consecutiveFailures: Math.max(current.consecutiveFailures, proposedFailures),
    openUntil: laterUsageTelemetryOpenUntil(current.openUntil, proposedOpenUntil),
  });
}

async function isUsageTelemetryD1DrainComplete(env: Env): Promise<boolean> {
  const kv = (env as Partial<Env>).CONFIG_KV;
  if (!kv) return false;
  try {
    return (await kv.get(USAGE_TELEMETRY_D1_DRAIN_COMPLETE_KV_KEY)) != null;
  } catch {
    return false;
  }
}

async function markUsageTelemetryD1DrainComplete(env: Env): Promise<void> {
  const kv = (env as Partial<Env>).CONFIG_KV;
  if (!kv) return;
  try {
    await kv.put(USAGE_TELEMETRY_D1_DRAIN_COMPLETE_KV_KEY, '1');
  } catch {}
}

// --- R2 outbox object-count bookkeeping (durable in CONFIG_KV; one key) -------
// The cap must be enforced without an O(n) R2 list on the hot path: R2 `list`
// pages at ~1000 objects/call, so a single list can't even establish the count
// against a multi-thousand cap (the earlier list-based check could never
// actually enforce it). Instead we keep a best-effort object COUNT in KV — an
// O(1) read on admission, incremented on write and decremented on drain/expiry,
// reconciled during flush.

async function readUsageTelemetryOutboxCount(env: Env): Promise<number | null> {
  const kv = (env as Partial<Env>).CONFIG_KV;
  if (!kv) return null;
  try {
    const raw = await kv.get(USAGE_TELEMETRY_OUTBOX_COUNT_KV_KEY);
    if (raw == null) return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

async function writeUsageTelemetryOutboxCount(env: Env, count: number): Promise<void> {
  const kv = (env as Partial<Env>).CONFIG_KV;
  if (!kv) return;
  try {
    await kv.put(USAGE_TELEMETRY_OUTBOX_COUNT_KV_KEY, String(Math.max(0, Math.floor(count))));
  } catch {}
}

/** Best-effort adjust; a lost update only shifts the soft cap by a few objects
 *  and is re-reconciled on the next flush. No-op until a baseline exists. */
async function adjustUsageTelemetryOutboxCount(env: Env, delta: number): Promise<void> {
  if (delta === 0) return;
  const current = await readUsageTelemetryOutboxCount(env);
  if (current == null) return;
  await writeUsageTelemetryOutboxCount(env, current + delta);
}

/**
 * Bounded, paginated R2 count that short-circuits once it reaches `cap`, so it is
 * never an unbounded list. Returns null when R2 listing is unavailable. Used only
 * on the cold path — to seed the O(1) KV counter on a miss and to reconcile a
 * large outbox during flush — never per hot-path write.
 */
async function countUsageTelemetryOutboxObjects(
  storage: R2Bucket | undefined,
  cap: number,
): Promise<number | null> {
  if (!storage?.list) return null;
  let count = 0;
  let cursor: string | undefined;
  try {
    do {
      const listed = await storage.list({
        prefix: USAGE_TELEMETRY_FALLBACK_PREFIX,
        limit: 1_000,
        cursor,
      });
      count += listed.objects.length;
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor && count < cap);
  } catch {
    return null;
  }
  return count;
}

/**
 * USAGE_TELEMETRY_FALLBACK_MAX_OBJECTS bounds total pending R2 outbox objects so a
 * sustained receiver outage can't inflate storage without bound. Once at capacity
 * a new event is dropped outright — D1 is no longer a durable target for new
 * events (see below), so there is no further fallback left to spill into.
 *
 * This is a SOFT cap: R2 has no atomic list+write and the KV counter is
 * best-effort (no atomic KV increment either — see #3), so a handful of
 * concurrent writes near the boundary can overshoot slightly before the next
 * write or flush observes the cap. That is acceptable for an anti-unbounded-
 * growth guard (it bounds growth; it is not a hard quota). The check is an O(1)
 * KV counter read on the hot path; on a counter miss (fresh deploy / KV miss) it
 * seeds the counter once from a bounded, short-circuited paginated count so
 * subsequent writes stay O(1).
 */
async function usageTelemetryOutboxAtCapacity(env: Env, storage: R2Bucket | undefined): Promise<boolean> {
  const cap = usageTelemetryFallbackMaxObjects(env);
  const counted = await readUsageTelemetryOutboxCount(env);
  if (counted != null) return counted >= cap;
  const baseline = await countUsageTelemetryOutboxObjects(storage, cap);
  if (baseline == null) return false; // no R2 listing available; cannot bound here
  await writeUsageTelemetryOutboxCount(env, baseline);
  return baseline >= cap;
}

/**
 * Preserve an event when Queue delivery cannot proceed. R2 is the sole durable
 * outbox for new events — D1's `usage_telemetry_fallback_events` table is
 * legacy-drain-only from here on (see flushUsageTelemetryFallback) and is
 * never written to for a new event, which is what let a receiver outage churn
 * a growing D1 table into a large read/write overage previously.
 */
export async function persistUsageTelemetryFallback(
  env: Env,
  event: ThirdPartyUsageTelemetryEvent,
  options: { silentFailure?: boolean; throwOnFailure?: boolean } = {},
): Promise<boolean> {
  const storage = (env as Partial<Env>).RAW_FILES;
  if (await usageTelemetryOutboxAtCapacity(env, storage)) {
    if (!options.silentFailure) {
      console.log('usage telemetry outbox at capacity; dropping event', {
        provider: event.provider,
        service: event.service,
        label: event.label,
      });
    }
    if (options.throwOnFailure) {
      throw new Error('usage telemetry outbox is at capacity');
    }
    return false;
  }
  try {
    if (!storage) throw new Error('R2 fallback binding unavailable');
    const key = usageTelemetryFallbackKey(event);
    // Queue retries are idempotent. Do not count an existing object again when
    // the put merely refreshes its contents.
    let alreadyPresent = false;
    if (storage.head) {
      try {
        alreadyPresent = Boolean(await storage.head(key));
      } catch {
        // A failed best-effort probe must not turn a durable write into a
        // dropped event; the soft counter can be reconciled during flush.
      }
    }
    await storage.put(key, JSON.stringify(event), {
      httpMetadata: { contentType: 'application/json' },
    });
    // Best-effort O(1) increment so the next admission check stays list-free.
    if (!alreadyPresent) await adjustUsageTelemetryOutboxCount(env, 1);
    return true;
  } catch (error) {
    try {
      await deliverUsageTelemetryEvent(env, event);
      return true;
    } catch (directError) {
      // Sentry's own transport uses silentFailure: logging failure to meter the
      // logging transport would recursively create another Sentry envelope.
      if (!options.silentFailure) {
        console.error('usage telemetry durability exhausted', {
          provider: event.provider,
          service: event.service,
          label: event.label,
          fallbackErrorType: usageTelemetryErrorType(error),
          directErrorType: usageTelemetryErrorType(directError),
        });
      }
      if (options.throwOnFailure) throw directError;
      return false;
    }
  }
}

export interface TrackedFetchRuntimeOptions {
  /** Explicit Env for SDK-owned transports that flush outside the handler ALS scope. */
  envOverride?: Env;
  /** Prevent recursive logging when metering an observability transport itself. */
  silentQueueFailure?: boolean;
}

/** Add provider-reported tokens/pages/credits or priced cost alongside request attempts. */
export async function recordMeasuredThirdPartyUsage(
  env: Env,
  usage: MeasuredThirdPartyUsage,
): Promise<boolean> {
  if (usage.idempotencyKey !== undefined && !usage.occurredAt) {
    return rejectMeasuredUsage('missingOccurredAt');
  }
  let occurredAt: string | undefined;
  try {
    occurredAt = usage.occurredAt == null ? undefined : canonicalOccurredAt(usage.occurredAt);
  } catch {
    return rejectMeasuredUsage('invalidOccurredAt');
  }
  const mapped = remapOpenRouterTelemetry(usage.provider, usage.model);

  // Default OpenRouter spend to the primary CT key alias so Usage-Monitor
  // Key Attribution can bind OPENROUTER_API_KEY → congress-trade without
  // every call site having to remember the field.
  const defaultProducerKeyRef =
    mapped.provider === 'openrouter' && !usage.producerKeyRef
      ? 'OPENROUTER_API_KEY'
      : usage.producerKeyRef;
  const event = baseEvent(env, {
    provider: mapped.provider,
    service: usage.service,
    operation: usage.operation,
    idempotencyKey: measuredUsageKey(usage.idempotencyKey, mapped.transport),
    occurredAt,
    model: mapped.model,
    metricType: usage.metricType ?? (usage.costUsd != null ? 'cost' : 'usage'),
    billingMode: usage.billingMode ?? 'actual',
    confidence: usage.confidence ?? 'actual',
    providerRequestId: usage.providerRequestId,
    producerKeyRef: defaultProducerKeyRef,
  });
  event.quantity = nonNegativeFinite(usage.quantity);
  event.unit = usage.unit;
  event.costUsd = nonNegativeFinite(usage.costUsd);
  const requests = nonNegativeFinite(usage.requests);
  event.requests = requests == null ? undefined : Math.floor(requests);
  event.credits = nonNegativeFinite(usage.credits);
  const remappedMetadata: Record<string, string> = mapped.transport ? { transport: mapped.transport } : {};
  // Always stamp sourceApp on metadata so dashboards can filter without
  // depending only on the batch-level producerId.
  remappedMetadata.sourceApp = 'congress-trade';
  if (defaultProducerKeyRef) remappedMetadata.keyRef = defaultProducerKeyRef;
  event.metadata = safeMetadata({ ...(event.metadata ?? {}), ...(usage.metadata ?? {}), ...remappedMetadata });
  return enqueueUsageTelemetryEvent(env, event);
}

/** Run one Worker invocation inside the Env context consumed by trackedFetch. */
export function withThirdPartyTelemetry<T>(env: Env, fn: () => T): T {
  return context.run({ env, suppressed: false }, fn);
}

/**
 * Bootstrap escape hatch used only by the Usage Monitor delivery transport.
 * Without it, an Infisical cache miss while delivering telemetry would create
 * another telemetry event and could amplify indefinitely during an outage.
 */
export function withoutThirdPartyTelemetry<T>(env: Env, fn: () => T): T {
  return context.run({ env, suppressed: true }, fn);
}

/**
 * Fetch a third-party resource and report this exact network attempt. Repeated
 * calls made by retry loops therefore produce repeated attempt events.
 */
export async function trackedFetch(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  descriptor: TrackedFetchDescriptor,
  fetchImpl: typeof fetch = fetch,
  runtime: TrackedFetchRuntimeOptions = {},
): Promise<Response> {
  const activeContext = context.getStore();
  const env = activeContext?.suppressed ? undefined : (runtime.envOverride ?? activeContext?.env);
  const provider = providerForThirdPartyRequest(input, descriptor.dynamicTarget);
  // The Usage Monitor client intentionally uses its own explicit raw transport;
  // routing it through this function would recursively meter telemetry itself.
  if (provider === 'usage-monitor') {
    throw new Error('usage-monitor ingest must use the explicit telemetry transport');
  }

  const mapped = remapOpenRouterTelemetry(provider, descriptor.model);
  const span = startDatadogSpan('http.client.request', {
    resource: `${descriptor.service}.${descriptor.operation}`,
    type: 'http',
    tags: {
      'outbound.provider': mapped.provider,
      'outbound.service': descriptor.service,
      'outbound.operation': descriptor.operation,
      'outbound.model': mapped.model || 'none',
    },
  });

  const startedAt = Date.now();
  try {
    const response = await withDatadogLlmObs(mapped.provider, mapped.model, () => fetchImpl(input, init));
    span.setTag('http.status_code', String(response.status));
    if (!response.ok) {
      span.setTag('error', true);
    }
    span.finish();
    if (env) {
      const event = baseEvent(env, {
        provider: mapped.provider,
        service: descriptor.service,
        operation: descriptor.operation,
        model: mapped.model,
        metricType: 'usage',
        billingMode: 'actual',
        confidence: 'actual',
      });
      event.quantity = 1;
      event.unit = 'request';
      event.requests = 1;
      const remappedMetadata: Record<string, string> = mapped.transport ? { transport: mapped.transport } : {};
      event.metadata = {
        ...(event.metadata ?? {}),
        ...remappedMetadata,
        success: response.ok,
        status: response.status,
        latencyMs: Math.max(0, Date.now() - startedAt),
        rateLimited: response.status === 429,
      };
      await enqueueUsageTelemetryEvent(env, event, { silentFailure: runtime.silentQueueFailure });
    }
    return response;
  } catch (error) {
    span.setTag('error', true);
    span.setTag('error.type', error instanceof Error ? error.name : 'unknown');
    span.finish();
    if (env) {
      const event = baseEvent(env, {
        provider: mapped.provider,
        service: descriptor.service,
        operation: descriptor.operation,
        model: mapped.model,
        metricType: 'usage',
        billingMode: 'actual',
        confidence: 'actual',
      });
      event.quantity = 1;
      event.unit = 'request';
      event.requests = 1;
      const remappedMetadata: Record<string, string> = mapped.transport ? { transport: mapped.transport } : {};
      event.metadata = {
        ...(event.metadata ?? {}),
        ...remappedMetadata,
        success: false,
        status: null,
        latencyMs: Math.max(0, Date.now() - startedAt),
        rateLimited: false,
        errorType: stableTag(error instanceof Error ? error.name : 'unknown', 'unknown'),
        errors: stableTag(error instanceof Error ? error.name : 'unknown', 'unknown'),
      };
      await enqueueUsageTelemetryEvent(env, event, { silentFailure: runtime.silentQueueFailure });
    }
    throw error;
  }
}

/**
 * The shared client accepts a service base URL and appends its canonical ingest
 * path. Older congress.trade config stored the full endpoint, so strip that
 * suffix before constructing the client to avoid appending it twice.
 */
export function normalizeUsageMonitorBaseUrl(configuredUrl: string): string {
  let baseUrl = configuredUrl.trim().replace(/\/+$/, '');
  while (baseUrl.endsWith(API_USAGE_MONITOR_INGEST_PATH)) {
    baseUrl = baseUrl.slice(0, -API_USAGE_MONITOR_INGEST_PATH.length).replace(/\/+$/, '');
  }
  return baseUrl;
}

interface UsageTelemetryReceiverConfig {
  baseUrl: string;
  token: string;
}

async function resolveUsageTelemetryReceiverConfig(env: Env): Promise<UsageTelemetryReceiverConfig> {
  const secrets = await resolveSecrets(env, [
    'USAGE_MONITOR_INGEST_URL',
    'USAGE_MONITOR_INGEST_TOKEN',
  ]);
  const configuredUrl = secrets.USAGE_MONITOR_INGEST_URL?.trim();
  const token = secrets.USAGE_MONITOR_INGEST_TOKEN?.trim();
  if (!configuredUrl || !token) throw new Error('usage telemetry ingest is not configured');
  const baseUrl = normalizeUsageMonitorBaseUrl(configuredUrl);
  if (!baseUrl) throw new Error('usage telemetry ingest URL is invalid');
  return { baseUrl, token };
}

/** Thrown by deliverUsageTelemetryEvent when the circuit breaker is open. Never
 *  network-visible: fetchImpl is not reached on this path. */
export class UsageTelemetryCircuitOpenError extends Error {
  constructor() {
    super('usage telemetry circuit is open; live delivery suppressed');
    this.name = 'UsageTelemetryCircuitOpenError';
  }
}

class UsageTelemetryProbeLeaseContendedError extends UsageTelemetryCircuitOpenError {
  constructor() {
    super();
    this.name = 'UsageTelemetryProbeLeaseContendedError';
  }
}

class UsageTelemetryProbeLeaseUnavailableError extends UsageTelemetryCircuitOpenError {
  constructor() {
    super();
    this.name = 'UsageTelemetryProbeLeaseUnavailableError';
  }
}

class UsageTelemetryDeliveryTimeoutError extends Error {
  constructor() {
    super('usage telemetry receiver timed out');
    this.name = 'UsageTelemetryDeliveryTimeoutError';
  }
}

/** Explicit unmetered receiver primitive; telemetry must never meter itself. */
async function fetchUsageTelemetryReceiver(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  return fetchImpl(input, init);
}

/**
 * Queue-consumer + fallback-drain transport. The shared client is intentionally
 * not tracked. Gated by the durable circuit breaker: while open this throws
 * immediately without ever calling the receiver, and every real attempt
 * (success or failure) updates the same breaker state, so a sustained receiver
 * outage stops hammering it after a bounded number of consecutive failures
 * instead of retrying at full request volume for the outage's duration.
 */
export async function deliverUsageTelemetryEvent(
  env: Env,
  event: DeliverableUsageTelemetryEvent,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  let circuitState = await readUsageTelemetryCircuitState(env);
  if (!circuitState) throw new UsageTelemetryCircuitOpenError();
  if (circuitState.openUntil != null && Date.now() < circuitState.openUntil) {
    throw new UsageTelemetryCircuitOpenError();
  }
  let receiverConfig: UsageTelemetryReceiverConfig | null = null;
  if (circuitState.openUntil != null) {
    // Resolve Infisical before claiming the half-open lease. Secret resolution
    // has its own network path and is not AbortSignal-aware; holding the lease
    // across an unbounded resolution would let it expire before the receiver
    // call, allowing another isolate to overlap the supposed singleton probe.
    try {
      receiverConfig = await withoutThirdPartyTelemetry(
        env,
        () => resolveUsageTelemetryReceiverConfig(env),
      );
    } catch (error) {
      await recordUsageTelemetryDeliveryFailure(env);
      throw error;
    }

    // Resolution may have waited behind another isolate's successful probe.
    // Refresh the durable state before claiming from the stale expired state.
    const refreshedState = await readUsageTelemetryCircuitState(env);
    if (!refreshedState) throw new UsageTelemetryCircuitOpenError();
    if (refreshedState.openUntil != null && Date.now() < refreshedState.openUntil) {
      throw new UsageTelemetryCircuitOpenError();
    }
    circuitState = refreshedState;
  }
  let probeLease: { token: string; expiresAtMs: number } | null;
  try {
    probeLease = await claimUsageTelemetryHalfOpenProbe(env, circuitState);
  } catch (error) {
    // A contender is proof that one probe already owns the singleton lease;
    // it must not inflate failures or race that probe's eventual close. A real
    // coordination outage has no known owner, so reopen with normal backoff.
    if (error instanceof UsageTelemetryProbeLeaseUnavailableError) {
      await recordUsageTelemetryDeliveryFailure(env);
    }
    throw error;
  }
  if (probeLease) {
    const gatePersisted = await writeUsageTelemetryCircuitState(env, {
      consecutiveFailures: circuitState.consecutiveFailures,
      openUntil: probeLease.expiresAtMs,
    });
    if (!gatePersisted) {
      // Do not call the receiver unless the one-probe gate is durable. The D1
      // lease remains and expires by itself, preserving fail-closed behavior.
      throw new UsageTelemetryCircuitOpenError();
    }
  }
  try {
    await withoutThirdPartyTelemetry(env, async () => {
      const { baseUrl, token } = receiverConfig
        ?? await resolveUsageTelemetryReceiverConfig(env);
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        usageTelemetryDeliveryTimeoutMs(env),
      );
      let receiverStatus: number | null = null;
      let eventRejected = false;
      try {
        signal?.throwIfAborted();
        const client = createUsageTelemetryClient({
          baseUrl,
          token,
          producerId: 'congress-trade',
          fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
            const response = await fetchUsageTelemetryReceiver(
              input,
              {
                ...init,
                signal: signal
                  ? AbortSignal.any([controller.signal, signal])
                  : controller.signal,
              },
            );
            receiverStatus = response.status;
            if (response.ok && response.status !== 204 && response.status !== 205) {
              // Consume the body under the existing delivery deadline. Do not
              // log or retain receiver-provided rejection detail strings.
              const payload = usageTelemetryAckPayload(
                await response.json(), usageTelemetryEventIdentity(event),
              );
              return Response.json(payload, { status: response.status });
            }
            return response;
          },
        });
        const ack = isV2UsageTelemetryEvent(event)
          ? await client.send([event])
          : await client.sendLegacyOutbox([event]);
        // The shared client validates the v2 ACK shape and bucket sum. Bind
        // it to this one-event request before clearing any durable receipt.
        // Duplicates and pruned events are acknowledged by the v2 contract.
        if (ack.received !== 1) {
          throw new UsageTelemetryDeliveryAckError();
        }
        eventRejected = ack.rejected !== 0;
      } catch (error) {
        if (signal?.aborted) {
          throw signal.reason ?? new Error('durable queue lease lost');
        }
        if (controller.signal.aborted) throw new UsageTelemetryDeliveryTimeoutError();
        if (receiverStatus != null && receiverStatus >= 200 && receiverStatus < 300) {
          // Do not expose response bytes, or let a response-schema error
          // match the terminal-event classifier's schema/idempotency words.
          throw new UsageTelemetryDeliveryAckError();
        }
        if (receiverStatus != null) {
          const message = error instanceof Error ? error.message : String(error ?? '');
          throw new UsageTelemetryDeliveryHttpError(receiverStatus, message);
        }
        throw error;
      } finally {
        // Keep the same deadline active through response-body parsing and
        // response-schema validation, not just until fetch returns headers.
        clearTimeout(timer);
      }
      if (eventRejected) {
        // Persistence has its own failure mode; it must not inherit the
        // receiver deadline or turn a healthy receiver into a global outage.
        signal?.throwIfAborted();
        const quarantined = await writeUsageTelemetryQuarantine(
          (env as Partial<Env>).RAW_FILES,
          usageTelemetryEventIdentity(event),
          JSON.stringify(event),
          'terminal_receiver_rejection',
        );
        signal?.throwIfAborted();
        throw new UsageTelemetryDeliveryEventRejectedError(quarantined);
      }
    });
  } catch (error) {
    if (signal?.aborted) {
      throw signal.reason ?? new Error('durable queue lease lost');
    }
    if (error instanceof UsageTelemetryDeliveryEventRejectedError || isTerminalUsageTelemetryDeliveryError(error)) {
      // A fully validated per-event rejection proves the receiver is healthy.
      // Even a quarantine write failure must not trip the shared breaker and
      // prevent unrelated healthy events from making progress.
      const closedPersisted = await recordUsageTelemetryDeliverySuccess(env);
      if (probeLease && closedPersisted) {
        await releaseUsageTelemetryHalfOpenProbe(env, probeLease.token);
      }
      throw error;
    }
    await recordUsageTelemetryDeliveryFailure(env);
    throw error;
  }
  signal?.throwIfAborted();
  const closedPersisted = await recordUsageTelemetryDeliverySuccess(env);
  if (probeLease && closedPersisted) {
    await releaseUsageTelemetryHalfOpenProbe(env, probeLease.token);
  }
}

interface UsageTelemetryDrainCursor {
  r2?: string;
  d1?: { updatedAt: string; idempotencyKey: string };
}
const USAGE_TELEMETRY_DRAIN_CURSOR_KEY = 'usage_telemetry_drain_cursor';
const usageTelemetryDrainCursors = new WeakMap<Env, UsageTelemetryDrainCursor>();

async function readUsageTelemetryDrainCursor(env: Env): Promise<UsageTelemetryDrainCursor> {
  let value: unknown = usageTelemetryDrainCursors.get(env);
  try {
    if (value === undefined && env.CONFIG_KV?.get) value = await env.CONFIG_KV.get(USAGE_TELEMETRY_DRAIN_CURSOR_KEY, 'json');
  } catch { /* A cursor outage must not authorize removing retained data. */ }
  if (!value || typeof value !== 'object') return {};
  const cursor = value as UsageTelemetryDrainCursor;
  return {
    ...(typeof cursor.r2 === 'string' && cursor.r2 ? { r2: cursor.r2 } : {}),
    ...(cursor.d1 && typeof cursor.d1.updatedAt === 'string' && typeof cursor.d1.idempotencyKey === 'string'
      ? { d1: { ...cursor.d1 } } : {}),
  };
}

async function writeUsageTelemetryDrainCursor(env: Env, cursor: UsageTelemetryDrainCursor): Promise<void> {
  try {
    if (env.CONFIG_KV?.put) {
      await env.CONFIG_KV.put(USAGE_TELEMETRY_DRAIN_CURSOR_KEY, JSON.stringify(cursor));
      usageTelemetryDrainCursors.delete(env);
      return;
    }
  } catch { /* Keep same-isolate progress without weakening durability. */ }
  usageTelemetryDrainCursors.set(env, cursor);
}

export interface UsageTelemetryFallbackFlushResult {
  listed: number;
  delivered: number;
  failed: number;
  /** R2 objects discarded unsent for exceeding USAGE_TELEMETRY_FALLBACK_TTL_DAYS. */
  expired: number;
  /** True when the whole cycle was skipped because the circuit breaker is open. */
  skipped: boolean;
}

/**
 * Drain a bounded batch from the R2 outbox, plus a one-time drain of any
 * pre-existing legacy D1 rows. Transient receiver failures never rewrite the
 * row; only malformed or deterministic per-event rejections consume a bounded
 * five-update quarantine budget before deletion. A stalled receiver therefore
 * cannot churn a growing D1 table, which caused the prior D1 overage.
 * R2 is the sole durable outbox for new events; D1 only ever shrinks from here.
 * Receiver failures are retained without logging/Sentry capture to avoid
 * outage amplification.
 *
 * Backs off entirely (no R2 list, no D1 read) while the circuit breaker is
 * open: re-listing/re-attempting the whole outbox every cron tick during a
 * known outage is exactly the pattern that caused the incident. Once the
 * breaker's backoff window elapses, the next call here doubles as its
 * half-open probe (see isUsageTelemetryCircuitOpen).
 */
export async function flushUsageTelemetryFallback(
  env: Env,
  options: { limit?: number } = {},
): Promise<UsageTelemetryFallbackFlushResult> {
  if (await isUsageTelemetryCircuitOpen(env)) {
    return { listed: 0, delivered: 0, failed: 0, expired: 0, skipped: true };
  }
  const cursor = await readUsageTelemetryDrainCursor(env);
  const initialCursor = JSON.stringify(cursor);
  try {
    return await drainUsageTelemetryFallbackPage(env, options, cursor);
  } finally {
    if (JSON.stringify(cursor) !== initialCursor) await writeUsageTelemetryDrainCursor(env, cursor);
  }
}

async function drainUsageTelemetryFallbackPage(
  env: Env,
  options: { limit?: number },
  cursor: UsageTelemetryDrainCursor,
): Promise<UsageTelemetryFallbackFlushResult> {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 25)));
  const storage = (env as Partial<Env>).RAW_FILES;
  const db = (env as Partial<Env>).DB;
  const ttlMs = usageTelemetryFallbackTtlMs(env);
  const now = Date.now();
  const r2Available = Boolean(storage?.list);
  const startingR2Cursor = cursor.r2;
  const listed = storage?.list
    ? await storage.list({
        prefix: USAGE_TELEMETRY_FALLBACK_PREFIX,
        limit,
        ...(startingR2Cursor ? { cursor: startingR2Cursor } : {}),
      }).catch((error) => {
        // A stale continuation token must not permanently wedge the drain.
        delete cursor.r2;
        throw error;
      })
    : { objects: [] as R2Object[], truncated: false as const };
  if (r2Available) {
    if (listed.truncated && 'cursor' in listed) cursor.r2 = listed.cursor;
    else delete cursor.r2;
  }
  let delivered = 0;
  let failed = 0;
  let expired = 0;
  let r2Removed = 0; // outbox objects deleted this cycle (delivered + expired + quarantined)
  for (const object of listed.objects) {
    if (object.uploaded && now - object.uploaded.getTime() > ttlMs) {
      try {
        await storage?.delete(object.key);
        r2Removed += 1;
      } catch {}
      expired += 1;
      continue;
    }
    try {
      const body = await storage?.get(object.key);
      if (!body) continue;
      const raw = await body.text();
      let event: DeliverableUsageTelemetryEvent | null = null;
      try {
        event = parseUsageTelemetryFallback(raw);
        await deliverUsageTelemetryEvent(env, event);
        await storage?.delete(object.key);
        r2Removed += 1;
        delivered += 1;
      } catch (error) {
        // Keep transient receiver failures on the outbox. Deterministic
        // rejections and malformed payloads are quarantined before deletion so
        // poison R2 objects cannot monopolize the bounded list forever without
        // first preserving the exact bytes for operator inspection.
        const quarantineIdentity = event ? usageTelemetryEventIdentity(event) : object.key;
        const quarantineReason = event == null ? 'malformed' : 'terminal_receiver_rejection';
        if (event == null || isTerminalUsageTelemetryDeliveryError(error)) {
          const quarantined = await writeUsageTelemetryQuarantine(
            storage,
            quarantineIdentity,
            raw,
            quarantineReason,
          );
          if (quarantined) {
            await storage?.delete(object.key);
            r2Removed += 1;
          }
        }
        failed += 1;
      }
    } catch {
      failed += 1;
    }
  }
  // Maintain the O(1) admission counter. When the bounded list was the entire
  // outbox (not truncated and starting at the prefix), the exact remainder is known, so set it
  // authoritatively — this self-heals any drift, including R2 objects that
  // predate the counter. Otherwise best-effort decrement by what we removed.
  if (r2Available) {
    if (!listed.truncated && !startingR2Cursor) {
      await writeUsageTelemetryOutboxCount(env, Math.max(0, listed.objects.length - r2Removed));
    } else if (r2Removed > 0) {
      await adjustUsageTelemetryOutboxCount(env, -r2Removed);
    }
  }
  const remainingLimit = Math.max(0, limit - listed.objects.length);
  const d1DrainComplete = await isUsageTelemetryD1DrainComplete(env);
  if (remainingLimit > 0 && db?.prepare && !d1DrainComplete) {
    try {
      type LegacyRow = { idempotency_key: string; event_json: string; attempts: number; updated_at: string };
      const readPage = async (after?: UsageTelemetryDrainCursor['d1']) => {
        const where = after ? 'WHERE updated_at > ? OR (updated_at = ? AND idempotency_key > ?)' : '';
        const params: unknown[] = after ? [after.updatedAt, after.updatedAt, after.idempotencyKey] : [];
        return await db.prepare(
          `SELECT idempotency_key, event_json, attempts, updated_at
             FROM usage_telemetry_fallback_events
             ${where}
            ORDER BY updated_at ASC, idempotency_key ASC
            LIMIT ?`,
        ).bind(...params, Math.min(remainingLimit, usageTelemetryD1DrainLimit(env))).all<LegacyRow>();
      };
      let rows = await readPage(cursor.d1);
      if (cursor.d1 && !(rows.results?.length)) {
        // An empty suffix is not an empty table. Wrap and verify its head
        // before setting the one-time drain-complete marker.
        delete cursor.d1;
        rows = await readPage();
      }
      const results = rows.results ?? [];
      const lastRow = results.at(-1);
      if (lastRow) cursor.d1 = { updatedAt: lastRow.updated_at, idempotencyKey: lastRow.idempotency_key };
      else delete cursor.d1;
      for (const row of results) {
        let event: DeliverableUsageTelemetryEvent | null = null;
        try {
          event = parseUsageTelemetryFallback(row.event_json);
        } catch {
          failed += 1;
          // Only malformed/terminal rows are quarantined. Receiver failures
          // below retain the row regardless of how long the outage lasts.
          await advanceTerminalLegacyUsageTelemetryRow(db, storage, row, 'malformed');
          continue;
        }
        try {
          await deliverUsageTelemetryEvent(env, event);
          await db.prepare(
            'DELETE FROM usage_telemetry_fallback_events WHERE idempotency_key = ?',
          )
            .bind(row.idempotency_key)
            .run();
          delivered += 1;
        } catch (error) {
          // Keep valid rows intact across transient receiver/circuit failures.
          // Deterministic per-event rejections are bounded and moved to the
          // back so one poison row cannot wedge the legacy drain forever.
          if (isTerminalUsageTelemetryDeliveryError(error)) {
            await advanceTerminalLegacyUsageTelemetryRow(
              db,
              storage,
              row,
              'terminal_receiver_rejection',
            );
          }
          failed += 1;
        }
      }
      if (results.length === 0) await markUsageTelemetryD1DrainComplete(env);
      return { listed: listed.objects.length + results.length, delivered, failed, expired, skipped: false };
    } catch {
      return { listed: listed.objects.length, delivered, failed: failed + 1, expired, skipped: false };
    }
  }
  return { listed: listed.objects.length, delivered, failed, expired, skipped: false };
}
