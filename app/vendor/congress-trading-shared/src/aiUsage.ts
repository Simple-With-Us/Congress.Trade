import { z } from "zod";

// =============================================================================
// Canonical AI usage block for usage telemetry v2 (UM-1592)
// =============================================================================
//
// One optional, strict `ai` block on a v2 event carries everything Usage
// Monitor needs to aggregate and price an AI request the same way for every
// producer.  It is additive: an event without `ai` is unchanged.
//
// Token semantics are fixed so that every bucket is priced exactly once:
//
//   input         uncached input tokens only (Anthropic `input_tokens`;
//                 OpenAI `prompt_tokens - cached_tokens`)
//   output        every billed output token, reasoning included
//   cacheRead     input tokens served from the prompt cache
//   cacheWrite5m  input tokens written to a 5-minute cache (Anthropic default
//                 TTL; also any provider that reports one undifferentiated
//                 cache-write figure)
//   cacheWrite1h  input tokens written to a 1-hour cache
//   reasoning     the reasoning share of `output`.  Informational only: it is
//                 already counted in `output` and must never be added again.
//
// Total billed tokens = input + output + cacheRead + cacheWrite5m + cacheWrite1h.

export const AI_BILLING_MODES = ["subscription", "payg", "free"] as const;
export const AiBillingModeSchema = z.enum(AI_BILLING_MODES);

export const AI_COST_SOURCES = ["billed", "estimated"] as const;
export const AiCostSourceSchema = z.enum(AI_COST_SOURCES);

const tokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const milliseconds = z.number().finite().nonnegative();
const shortTag = z.string().trim().min(1).max(80);
const modelName = z.string().trim().min(1).max(160);

export const AiUsageModelSchema = z.object({
  /** The model the caller asked for (alias allowed, e.g. `claude-opus-5-5[1m]`). */
  requested: modelName.optional(),
  /** The model the provider says actually served the request. */
  served: modelName.optional(),
}).strict();

export const AiUsageTokensSchema = z.object({
  input: tokenCount.optional(),
  output: tokenCount.optional(),
  cacheRead: tokenCount.optional(),
  cacheWrite5m: tokenCount.optional(),
  cacheWrite1h: tokenCount.optional(),
  reasoning: tokenCount.optional(),
}).strict();

export const AiUsageSchema = z.object({
  model: AiUsageModelSchema.optional(),
  /** The agent harness or app that made the call: `claude-code`, `openai-codex`, `botfleet`, ... */
  harness: shortTag.optional(),
  /** The fleet seat the call is attributed to: `CLAUDE`, `CODEX`, ... */
  seat: shortTag.optional(),
  tokens: AiUsageTokensSchema.optional(),
  /** Wall-clock duration of the request or turn, in milliseconds. */
  durationMs: milliseconds.optional(),
  /** Time to first token, in milliseconds. */
  ttftMs: milliseconds.optional(),
  /** How the call is paid for.  Distinct from the event-level `billingMode` (actual/estimated/manual). */
  billingMode: AiBillingModeSchema.optional(),
  /** Whether the event's `costUsd` is the provider's billed figure or a producer estimate. */
  costSource: AiCostSourceSchema.optional(),
}).strict();

export type AiBillingMode = z.infer<typeof AiBillingModeSchema>;
export type AiCostSource = z.infer<typeof AiCostSourceSchema>;
export type AiUsageModel = z.infer<typeof AiUsageModelSchema>;
export type AiUsageTokens = z.infer<typeof AiUsageTokensSchema>;
export type AiUsageInput = z.input<typeof AiUsageSchema>;
export type AiUsage = z.infer<typeof AiUsageSchema>;

/** The token buckets that are billed.  `reasoning` is a subset of `output` and is excluded. */
export const AI_BILLED_TOKEN_KEYS = ["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"] as const;

/** Sum of the billed token buckets (reasoning is never added on top of output). */
export function aiUsageTotalTokens(tokens: AiUsageTokens | undefined): number {
  if (!tokens) return 0;
  let total = 0;
  for (const key of AI_BILLED_TOKEN_KEYS) total += tokens[key] ?? 0;
  return total;
}

// -----------------------------------------------------------------------------
// SDK usage shapes
// -----------------------------------------------------------------------------

/** Anthropic Messages API `usage`. */
export interface AnthropicSdkUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number | null;
    ephemeral_1h_input_tokens?: number | null;
  } | null;
}

/**
 * OpenAI `usage`: Chat Completions (`prompt_tokens`/`completion_tokens`) or Responses
 * (`input_tokens`/`output_tokens`).  OpenAI-compatible providers (OpenRouter, xAI, Moonshot,
 * MiniMax, DeepSeek) use the same shape; DeepSeek's `prompt_cache_hit_tokens` is honoured.
 */
export interface OpenAiSdkUsage {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  prompt_tokens_details?: { cached_tokens?: number | null; cache_write_tokens?: number | null } | null;
  input_tokens_details?: { cached_tokens?: number | null } | null;
  completion_tokens_details?: { reasoning_tokens?: number | null } | null;
  output_tokens_details?: { reasoning_tokens?: number | null } | null;
  prompt_cache_hit_tokens?: number | null;
}

/** Gemini `usageMetadata` (Google AI and Vertex). */
export interface GeminiSdkUsageMetadata {
  promptTokenCount?: number | null;
  candidatesTokenCount?: number | null;
  cachedContentTokenCount?: number | null;
  thoughtsTokenCount?: number | null;
  toolUsePromptTokenCount?: number | null;
}

export type AiSdkUsageShape = "anthropic" | "openai" | "gemini";

function count(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.round(value));
}

function compactTokens(tokens: Record<keyof AiUsageTokens, number | undefined>): AiUsageTokens {
  const out: AiUsageTokens = {};
  for (const [key, value] of Object.entries(tokens) as Array<[keyof AiUsageTokens, number | undefined]>) {
    if (value != null) out[key] = value;
  }
  return out;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Anthropic `usage` -> canonical tokens.  `input_tokens` already excludes cache reads and writes. */
export function aiTokensFromAnthropicUsage(usage: AnthropicSdkUsage): AiUsageTokens {
  const creationTotal = count(usage.cache_creation_input_tokens);
  const breakdown = asObject(usage.cache_creation);
  let cacheWrite5m: number | undefined;
  let cacheWrite1h: number | undefined;
  if (breakdown) {
    cacheWrite5m = count(breakdown.ephemeral_5m_input_tokens);
    cacheWrite1h = count(breakdown.ephemeral_1h_input_tokens);
    // Any cache-write tokens the TTL breakdown does not account for were written at the
    // default 5-minute TTL.
    const unaccounted = (creationTotal ?? 0) - (cacheWrite5m ?? 0) - (cacheWrite1h ?? 0);
    if (unaccounted > 0) cacheWrite5m = (cacheWrite5m ?? 0) + unaccounted;
  } else {
    cacheWrite5m = creationTotal;
  }
  return compactTokens({
    input: count(usage.input_tokens),
    output: count(usage.output_tokens),
    cacheRead: count(usage.cache_read_input_tokens),
    cacheWrite5m,
    cacheWrite1h,
    reasoning: undefined,
  });
}

/**
 * OpenAI `usage` -> canonical tokens.  OpenAI's prompt/input figure INCLUDES cached tokens, so
 * cached tokens are subtracted to get uncached input.  Reasoning tokens are already in the
 * completion/output figure.
 */
export function aiTokensFromOpenAiUsage(usage: OpenAiSdkUsage): AiUsageTokens {
  const promptDetails = asObject(usage.prompt_tokens_details);
  const inputDetails = asObject(usage.input_tokens_details);
  const completionDetails = asObject(usage.completion_tokens_details);
  const outputDetails = asObject(usage.output_tokens_details);

  const prompt = count(usage.prompt_tokens) ?? count(usage.input_tokens);
  const cacheRead =
    count(promptDetails?.cached_tokens) ??
    count(inputDetails?.cached_tokens) ??
    count(usage.prompt_cache_hit_tokens);
  const cacheWrite5m = count(promptDetails?.cache_write_tokens);
  const input = prompt == null
    ? undefined
    : Math.max(0, prompt - (cacheRead ?? 0) - (cacheWrite5m ?? 0));
  return compactTokens({
    input,
    output: count(usage.completion_tokens) ?? count(usage.output_tokens),
    cacheRead,
    cacheWrite5m,
    cacheWrite1h: undefined,
    reasoning: count(completionDetails?.reasoning_tokens) ?? count(outputDetails?.reasoning_tokens),
  });
}

/**
 * Gemini `usageMetadata` -> canonical tokens.  `promptTokenCount` includes cached content;
 * thinking tokens are billed as output but reported outside `candidatesTokenCount`.
 */
export function aiTokensFromGeminiUsage(usage: GeminiSdkUsageMetadata): AiUsageTokens {
  const prompt = count(usage.promptTokenCount);
  const toolPrompt = count(usage.toolUsePromptTokenCount);
  const cacheRead = count(usage.cachedContentTokenCount);
  const candidates = count(usage.candidatesTokenCount);
  const thoughts = count(usage.thoughtsTokenCount);
  const input = prompt == null && toolPrompt == null
    ? undefined
    : Math.max(0, (prompt ?? 0) + (toolPrompt ?? 0) - (cacheRead ?? 0));
  const output = candidates == null && thoughts == null ? undefined : (candidates ?? 0) + (thoughts ?? 0);
  return compactTokens({
    input,
    output,
    cacheRead,
    cacheWrite5m: undefined,
    cacheWrite1h: undefined,
    reasoning: thoughts,
  });
}

/**
 * Best-effort shape detection.  A bare `{ input_tokens, output_tokens }` with no cache or detail
 * fields is read as Anthropic;  that is safe for an OpenAI Responses object too, because without
 * `input_tokens_details` there is no cached count to subtract and both readings are identical.  Accepts a bare usage object or a whole response carrying
 * `usage` (Anthropic/OpenAI) or `usageMetadata` (Gemini).  Returns null when unrecognised.
 */
export function detectAiSdkUsageShape(value: unknown): AiSdkUsageShape | null {
  const usage = asObject(value);
  if (!usage) return null;
  if ("promptTokenCount" in usage || "candidatesTokenCount" in usage || "cachedContentTokenCount" in usage) {
    return "gemini";
  }
  if ("prompt_tokens" in usage || "completion_tokens" in usage) return "openai";
  if (
    "input_tokens_details" in usage ||
    "output_tokens_details" in usage ||
    "prompt_cache_hit_tokens" in usage
  ) {
    return "openai";
  }
  if (
    "cache_read_input_tokens" in usage ||
    "cache_creation_input_tokens" in usage ||
    "cache_creation" in usage ||
    "input_tokens" in usage ||
    "output_tokens" in usage
  ) {
    return "anthropic";
  }
  return null;
}

/** Canonical tokens from any supported SDK usage object (or a response that carries one). */
export function aiTokensFromSdkUsage(value: unknown, shape?: AiSdkUsageShape): AiUsageTokens | null {
  const root = asObject(value);
  if (!root) return null;
  const usage = asObject(root.usageMetadata) ?? asObject(root.usage) ?? root;
  const resolved = shape ?? detectAiSdkUsageShape(usage);
  if (resolved === "anthropic") return aiTokensFromAnthropicUsage(usage as AnthropicSdkUsage);
  if (resolved === "openai") return aiTokensFromOpenAiUsage(usage as OpenAiSdkUsage);
  if (resolved === "gemini") return aiTokensFromGeminiUsage(usage as GeminiSdkUsageMetadata);
  return null;
}

export interface BuildAiUsageOptions {
  /** SDK usage object, or a whole SDK response that carries `usage` / `usageMetadata`. */
  usage?: unknown;
  /** Force the SDK shape instead of detecting it. */
  usageShape?: AiSdkUsageShape;
  /** Explicit canonical tokens; merged over (and winning against) the ones read from `usage`. */
  tokens?: AiUsageTokens;
  requestedModel?: string | null;
  servedModel?: string | null;
  harness?: string | null;
  seat?: string | null;
  durationMs?: number | null;
  ttftMs?: number | null;
  billingMode?: AiBillingMode | null;
  costSource?: AiCostSource | null;
}

/**
 * Build a validated `ai` block from common SDK usage shapes plus request context.  When the
 * served model is unknown it is read from the response's `model` / `modelVersion` field if a
 * whole response was passed.  Throws (ZodError) only when an explicit option is invalid.
 */
export function buildAiUsage(options: BuildAiUsageOptions): AiUsage {
  const fromSdk = options.usage == null ? null : aiTokensFromSdkUsage(options.usage, options.usageShape);
  // Explicit tokens win, but an explicit `undefined` must not erase an SDK count or reach the
  // strict schema as a non-number.
  const tokens: AiUsageTokens = { ...(fromSdk ?? {}) };
  for (const [key, value] of Object.entries(options.tokens ?? {}) as Array<[keyof AiUsageTokens, number | undefined]>) {
    if (value != null) tokens[key] = value;
  }
  const response = asObject(options.usage);
  const responseModel =
    typeof response?.model === "string"
      ? response.model
      : typeof response?.modelVersion === "string"
        ? response.modelVersion
        : undefined;
  const served = options.servedModel ?? responseModel ?? undefined;
  const requested = options.requestedModel ?? undefined;

  const block: AiUsageInput = {};
  if (requested || served) {
    block.model = {
      ...(requested ? { requested } : {}),
      ...(served ? { served } : {}),
    };
  }
  if (options.harness) block.harness = options.harness;
  if (options.seat) block.seat = options.seat;
  if (Object.keys(tokens).length > 0) block.tokens = tokens;
  if (options.durationMs != null && Number.isFinite(options.durationMs)) block.durationMs = Math.max(0, options.durationMs);
  if (options.ttftMs != null && Number.isFinite(options.ttftMs)) block.ttftMs = Math.max(0, options.ttftMs);
  if (options.billingMode) block.billingMode = options.billingMode;
  if (options.costSource) block.costSource = options.costSource;
  return AiUsageSchema.parse(block);
}
