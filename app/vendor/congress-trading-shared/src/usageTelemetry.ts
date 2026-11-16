import { z } from "zod";

import { AiUsageSchema } from "./aiUsage";

export const USAGE_TELEMETRY_SCHEMA_VERSION = 2 as const;
export const API_USAGE_MONITOR_INGEST_PATH = "/api/ingest/usage";
export const API_USAGE_MONITOR_HEALTH_PATH = "/api/health";
export const API_USAGE_MONITOR_READY_PATH = "/api/ready";

/**
 * Known v2 producer ids (the batch `producerId`, persisted as `sourceApp`).  Informational:
 * the wire schema accepts any producerId, and Usage Monitor authorizes each one by its
 * scoped ingest token.
 */
export const USAGE_TELEMETRY_PRODUCERS = [
  "congress-trade",
  "socratic-trade",
  "usage-monitor",
  "botfleet",
  "codecaps",
  "claude-code",
  "openai-codex",
  "grok-build",
  "github-copilot",
  "minimax-code",
  "deepseek-dsh",
  "opencode",
  "fx",
  "antigravity-cli",
  "antigravity-statusline",
  "cursor-agent",
  "cursor-admin",
  "muse",
  "muse-code",
  "gbu",
  "mac-host",
  "fleet-usage-collector",
  "admin-usage-poller",
  "manual-billing-adjustment",
] as const;
export const UsageTelemetryProducerSchema = z.enum(USAGE_TELEMETRY_PRODUCERS);

export const USAGE_TELEMETRY_KNOWN_PROVIDERS = [
  "openrouter",
  "openai",
  "anthropic",
  "google-ai",
  "mistral",
  "minimax",
  "deepseek",
  "xai",
  "moonshot",
  "github-copilot",
  "cursor",
  "finnhub",
  "fmp",
  "unusual-whales",
  "firecrawl",
  "sec-edgar",
  "alpaca",
  "polygon",
  "quantconnect",
  "hetzner",
  "cloudflare",
  "massive",
  "tiingo",
  "infisical",
  "peer-app",
  "external-api",
  "seed-source",
  "filing-source",
  "subscriber-webhook",
] as const;
export const UsageTelemetryKnownProviderSchema = z.enum(USAGE_TELEMETRY_KNOWN_PROVIDERS);

export const UsageTelemetryMetricTypeSchema = z.enum([
  "usage",
  "cost",
  "quota",
  "tier",
  "health",
  "balance",
  "limit",
  "quota_sync",
  "credit_balance",
  "subscription",
]);

export const UsageTelemetryUnitSchema = z.enum([
  "request",
  "call",
  "token",
  "credit",
  "usd",
  "page",
  "job",
  "document",
  "row",
  "byte",
]);

export const UsageTelemetryBillingModeSchema = z.enum(["actual", "estimated", "manual"]);
export const UsageTelemetryConfidenceSchema = z.enum(["actual", "estimated", "manual"]);
export const UsageTelemetryLimitWindowSchema = z.enum(["minute", "day", "month", "run"]);

export const UsageTelemetryCoverageScopeSchema = z.enum([
  "api_key",
  "project",
  "provider_connection",
  "billing_account",
]);
export const UsageTelemetryCoverageModeSchema = z.enum(["point", "window", "cumulative"]);
export const UsageTelemetryCoverageRelationshipSchema = z.enum([
  "disjoint",
  "overlaps",
  "supersedes",
  "unknown",
]);
export const UsageTelemetryCoverageSchema = z.object({
  scope: UsageTelemetryCoverageScopeSchema,
  mode: UsageTelemetryCoverageModeSchema,
  relationship: UsageTelemetryCoverageRelationshipSchema.default("unknown"),
  reportThrough: z.string().datetime().optional(),
}).strict();

export const UsageTelemetryMetadataSchema = z.record(
  z.string(),
  z.union([z.string(), z.number().finite(), z.boolean(), z.null()]),
).transform((metadata) => {
  const clean: Record<string, string | number | boolean | null> = {};
  for (const [rawKey, rawValue] of Object.entries(metadata).slice(0, 50)) {
    const key = rawKey.trim().slice(0, 80);
    if (!key) continue;
    clean[key] = typeof rawValue === "string" ? rawValue.slice(0, 500) : rawValue;
  }
  return clean;
});

const UsageTelemetryMeasurementFields = {
  environment: z.string().trim().min(1).max(80).optional(),
  provider: z.string().trim().min(1).max(80),
  service: z.string().trim().min(1).max(120).optional(),
  project: z.string().trim().min(1).max(120).optional(),
  label: z.string().trim().min(1).max(160).optional(),
  producerKeyRef: z.string().trim().min(1).max(160).optional(),
  providerConnectionRef: z.string().trim().min(1).max(160).optional(),
  billingAccountRef: z.string().trim().min(1).max(160).optional(),
  coverage: UsageTelemetryCoverageSchema.optional(),
  billingMode: UsageTelemetryBillingModeSchema.default("estimated"),
  metricType: UsageTelemetryMetricTypeSchema.default("usage"),
  quantity: z.number().finite().nonnegative().optional(),
  unit: UsageTelemetryUnitSchema.optional(),
  costUsd: z.number().finite().nonnegative().optional(),
  requests: z.number().int().nonnegative().optional(),
  credits: z.number().finite().nonnegative().optional(),
  limit: z.number().finite().nonnegative().optional(),
  limitWindow: UsageTelemetryLimitWindowSchema.optional(),
  tier: z.string().trim().min(1).max(80).optional(),
  confidence: UsageTelemetryConfidenceSchema.default("estimated"),
  windowStart: z.string().datetime().optional(),
  windowEnd: z.string().datetime().optional(),
  occurredAt: z.string().datetime().optional(),
  providerRequestId: z.string().trim().min(1).max(200).optional(),
  metadata: UsageTelemetryMetadataSchema.optional(),
  /** Canonical AI usage (model, tokens, timing, seat, billing).  See `aiUsage.ts` (UM-1592). */
  ai: AiUsageSchema.optional(),
} as const;

/** The only v2 event shape sent over the wire. */
export const UsageTelemetryV2EventSchema = z.object({
  eventId: z.string().trim().min(1).max(200),
  ...UsageTelemetryMeasurementFields,
}).strict();

/** The v2 wire envelope. Producer identity belongs to the batch, not mutable event metadata. */
export const UsageTelemetryV2BatchSchema = z.object({
  schemaVersion: z.literal(USAGE_TELEMETRY_SCHEMA_VERSION),
  producerId: z.string().trim().min(1).max(80),
  producerInstanceId: z.string().trim().min(1).max(160).optional(),
  events: z.array(UsageTelemetryV2EventSchema).min(1).max(100),
}).strict();

export const UsageTelemetryV2IngestAckSchema = z.object({
  ok: z.literal(true),
  schemaVersion: z.literal(USAGE_TELEMETRY_SCHEMA_VERSION),
  received: z.number().int().nonnegative(),
  persisted: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
  pruned: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
}).strict().superRefine((ack, ctx) => {
  if (ack.persisted + ack.duplicates + ack.pruned + ack.rejected !== ack.received) {
    ctx.addIssue({
      code: "custom",
      message: "Usage telemetry acknowledgement counts must sum to received",
    });
  }
});

export const UsageTelemetryErrorCodeSchema = z.enum([
  "invalid_request",
  "unauthorized",
  "forbidden",
  "rate_limited",
  "receiver_busy",
  "idempotency_conflict",
  "payload_too_large",
  "not_configured",
  "internal_error",
]);
export const UsageTelemetryV2ErrorResponseSchema = z.object({
  ok: z.literal(false),
  schemaVersion: z.literal(USAGE_TELEMETRY_SCHEMA_VERSION),
  error: z.object({
    code: UsageTelemetryErrorCodeSchema,
    message: z.string().trim().min(1).max(500),
    retryable: z.boolean(),
    retryAfterSeconds: z.number().int().nonnegative().optional(),
  }).strict(),
}).strict();

/**
 * Producer draft retained as an in-process migration boundary. It is never a v2 wire shape.
 * Existing durable v1 rows can be drained by using their idempotencyKey as eventId.
 */
export const UsageTelemetryEventSchema = z.object({
  sourceApp: z.string().trim().min(1).max(80),
  eventId: z.string().trim().min(1).max(200).optional(),
  keyRef: z.string().trim().min(1).max(160).optional(),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
  ...UsageTelemetryMeasurementFields,
});
export const UsageTelemetryBatchSchema = z.object({
  events: z.array(UsageTelemetryEventSchema).min(1).max(100),
});
export const LegacyUsageTelemetryOutboxEventSchema = UsageTelemetryEventSchema.extend({
  idempotencyKey: z.string().trim().min(1).max(200),
});
export const LegacyUsageTelemetryOutboxBatchSchema = z.object({
  events: z.array(LegacyUsageTelemetryOutboxEventSchema).min(1).max(100),
});

export type UsageTelemetryMetricType = z.infer<typeof UsageTelemetryMetricTypeSchema>;
export type UsageTelemetryProducer = z.infer<typeof UsageTelemetryProducerSchema>;
export type UsageTelemetryKnownProvider = z.infer<typeof UsageTelemetryKnownProviderSchema>;
export type UsageTelemetryUnit = z.infer<typeof UsageTelemetryUnitSchema>;
export type UsageTelemetryBillingMode = z.infer<typeof UsageTelemetryBillingModeSchema>;
export type UsageTelemetryConfidence = z.infer<typeof UsageTelemetryConfidenceSchema>;
export type UsageTelemetryLimitWindow = z.infer<typeof UsageTelemetryLimitWindowSchema>;
export type UsageTelemetryCoverage = z.infer<typeof UsageTelemetryCoverageSchema>;
export type UsageTelemetryEventInput = z.input<typeof UsageTelemetryEventSchema>;
export type UsageTelemetryEvent = z.infer<typeof UsageTelemetryEventSchema>;
export type UsageTelemetryBatchInput = z.input<typeof UsageTelemetryBatchSchema>;
export type UsageTelemetryBatch = z.infer<typeof UsageTelemetryBatchSchema>;
export type LegacyUsageTelemetryOutboxEventInput = z.input<typeof LegacyUsageTelemetryOutboxEventSchema>;
export type UsageTelemetryV2EventInput = z.input<typeof UsageTelemetryV2EventSchema>;
export type UsageTelemetryV2Event = z.infer<typeof UsageTelemetryV2EventSchema>;
export type UsageTelemetryV2BatchInput = z.input<typeof UsageTelemetryV2BatchSchema>;
export type UsageTelemetryV2Batch = z.infer<typeof UsageTelemetryV2BatchSchema>;
export type UsageTelemetryIngestResponse = z.infer<typeof UsageTelemetryV2IngestAckSchema>;
export type UsageTelemetryV2ErrorResponse = z.infer<typeof UsageTelemetryV2ErrorResponseSchema>;
export type UsageTelemetryErrorCode = z.infer<typeof UsageTelemetryErrorCodeSchema>;

function generateFallbackUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "evt_" + Date.now().toString(36) + "_" + Math.random().toString(36).substring(2, 10);
}

/**
 * Creates and validates a strict v2 UsageTelemetryEvent.
 * Auto-generates an eventId if one is not supplied.
 */
export function createUsageTelemetryV2Event(
  input: Omit<UsageTelemetryV2EventInput, "eventId"> & { eventId?: string },
): UsageTelemetryV2Event {
  const eventId = input.eventId ?? generateFallbackUuid();
  return UsageTelemetryV2EventSchema.parse({
    ...input,
    eventId,
  });
}

export function usageMonitorIngestUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${API_USAGE_MONITOR_INGEST_PATH}`;
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function encodeIdempotencyField(value: string): string {
  return `${new TextEncoder().encode(value).length}:${value}`;
}

/** Legacy v1 helper used only to assign a stable eventId while old durable rows drain. */
export async function deriveUsageTelemetryIdempotencyKey(event: {
  sourceApp: string;
  provider: string;
  metricType: string;
  keyRef?: string;
  occurredAt?: string;
}): Promise<string | undefined> {
  if (!event.occurredAt) return undefined;
  const basis = [event.sourceApp, event.provider, event.metricType, event.keyRef ?? "", event.occurredAt]
    .map(encodeIdempotencyField)
    .join("");
  return sha256Hex(basis);
}

/** Canonical v2 persistence identity. Mutable measurement fields never participate. */
export async function deriveUsageTelemetryV2IdempotencyKey(input: {
  producerId: string;
  eventId: string;
}): Promise<string> {
  const basis = ["usage-telemetry-v2", input.producerId, input.eventId]
    .map(encodeIdempotencyField)
    .join("");
  return sha256Hex(basis);
}

export interface UsageTelemetryClientOptions {
  baseUrl: string;
  token: string;
  producerId: string;
  producerInstanceId?: string;
  fetchImpl?: typeof fetch;
}

export class UsageTelemetryApiError extends Error {
  readonly status: number;
  readonly code: UsageTelemetryErrorCode;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;

  constructor(input: {
    status: number;
    code: UsageTelemetryErrorCode;
    message: string;
    retryable: boolean;
    retryAfterSeconds?: number;
  }) {
    super(`Usage telemetry ingest failed: ${input.message}`);
    this.name = "UsageTelemetryApiError";
    this.status = input.status;
    this.code = input.code;
    this.retryable = input.retryable;
    this.retryAfterSeconds = input.retryAfterSeconds;
  }
}

function retryAfterSeconds(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(header);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, Math.ceil((date - Date.now()) / 1_000));
}

function fallbackErrorCode(status: number): UsageTelemetryErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 409) return "idempotency_conflict";
  if (status === 413) return "payload_too_large";
  if (status === 429) return "rate_limited";
  if (status === 503) return "receiver_busy";
  if (status >= 500) return "internal_error";
  return "invalid_request";
}

/**
 * Wave H / C1: historical producer catch name. Same constructor as
 * UsageTelemetryApiError so `instanceof UsageTelemetryIngestError` matches
 * failures thrown by createUsageTelemetryClient (Retry-After included).
 */
export { UsageTelemetryApiError as UsageTelemetryIngestError };

export function createUsageTelemetryClient(options: UsageTelemetryClientOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = usageMonitorIngestUrl(options.baseUrl);
  const producerId = z.string().trim().min(1).max(80).parse(options.producerId);
  const producerInstanceId = options.producerInstanceId == null
    ? undefined
    : z.string().trim().min(1).max(160).parse(options.producerInstanceId);

  async function post(wireEvents: UsageTelemetryV2Event[]): Promise<UsageTelemetryIngestResponse> {
    const body = UsageTelemetryV2BatchSchema.parse({
      schemaVersion: USAGE_TELEMETRY_SCHEMA_VERSION,
      producerId,
      producerInstanceId,
      events: wireEvents,
    });
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.token}`,
        "content-type": "application/json",
        "x-usage-telemetry-version": String(USAGE_TELEMETRY_SCHEMA_VERSION),
      },
      body: JSON.stringify(body),
    });
    const payload: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      const parsedError = UsageTelemetryV2ErrorResponseSchema.safeParse(payload);
      const headerRetryAfter = retryAfterSeconds(res.headers.get("retry-after"));
      if (parsedError.success) {
        throw new UsageTelemetryApiError({
          status: res.status,
          ...parsedError.data.error,
          retryAfterSeconds: parsedError.data.error.retryAfterSeconds ?? headerRetryAfter,
        });
      }
      const code = fallbackErrorCode(res.status);
      const message = typeof payload === "object" && payload && "error" in payload
        ? String((payload as { error?: unknown }).error)
        : `HTTP ${res.status}`;
      throw new UsageTelemetryApiError({
        status: res.status,
        code,
        message,
        retryable: res.status === 429 || res.status >= 500,
        retryAfterSeconds: headerRetryAfter,
      });
    }
    return UsageTelemetryV2IngestAckSchema.parse(payload);
  }

  return {
    /** Fresh producers send the strict v2 event shape: eventId is required and sourceApp is absent. */
    async send(events: UsageTelemetryV2EventInput[]): Promise<UsageTelemetryIngestResponse> {
      const wireEvents = events.map((event) => UsageTelemetryV2EventSchema.parse(event));
      return post(wireEvents);
    },

    /**
     * Bounded migration path for already-persisted v1 rows only. Their durable idempotencyKey is
     * promoted to v2 eventId. Missing identity or source/producer drift fails before any request.
     */
    async sendLegacyOutbox(
      events: LegacyUsageTelemetryOutboxEventInput[],
    ): Promise<UsageTelemetryIngestResponse> {
      const parsed = LegacyUsageTelemetryOutboxBatchSchema.parse({ events });
      const wireEvents = parsed.events.map((event, index) => {
        if (event.sourceApp !== producerId) {
          throw new Error(
            `Legacy usage telemetry event ${index} sourceApp must match producerId ${producerId}`,
          );
        }
        const { sourceApp: _sourceApp, idempotencyKey: _idempotencyKey, keyRef, ...measurement } = event;
        return UsageTelemetryV2EventSchema.parse({
          ...measurement,
          eventId: event.idempotencyKey,
          producerKeyRef: event.producerKeyRef ?? keyRef,
        });
      });
      return post(wireEvents);
    },
  };
}
