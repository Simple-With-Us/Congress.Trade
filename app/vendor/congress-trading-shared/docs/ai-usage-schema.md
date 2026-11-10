# Canonical AI Usage Schema (usage telemetry v2 `ai` block)

UM-1592.  Added in `v2.8.0`.  Additive and backward compatible:  an event without `ai` is unchanged.

Every producer used to invent its own token metadata keys (`promptTokens`, `cachedTokens`,
`inputTokens`, `tokenType` slices, and so on), so Usage Monitor could not aggregate or price AI
usage the same way across producers.  The v2 event now has one optional, strict `ai` block.

## Fields

| Field | Type | Meaning |
| --- | --- | --- |
| `ai.model.requested` | string, 1-160 | The model the caller asked for, alias allowed (`claude-opus-5-5[1m]`, `sonnet`). |
| `ai.model.served` | string, 1-160 | The model the provider says served the request (response `model` / `modelVersion`). |
| `ai.harness` | string, 1-80 | The agent harness or app that made the call (`claude-code`, `openai-codex`, `botfleet`, `congress-trade`). |
| `ai.seat` | string, 1-80 | The fleet seat the call belongs to (`CLAUDE`, `CODEX`, `GROK`), when there is one. |
| `ai.tokens.input` | integer >= 0 | Uncached input tokens only. |
| `ai.tokens.output` | integer >= 0 | Every billed output token, reasoning included. |
| `ai.tokens.cacheRead` | integer >= 0 | Input tokens served from the prompt cache. |
| `ai.tokens.cacheWrite5m` | integer >= 0 | Input tokens written to a 5-minute cache, or to a cache whose TTL the provider does not report. |
| `ai.tokens.cacheWrite1h` | integer >= 0 | Input tokens written to a 1-hour cache. |
| `ai.tokens.reasoning` | integer >= 0 | The reasoning share of `output`.  Informational:  it is already inside `output` and is never added again. |
| `ai.durationMs` | number >= 0 | Wall-clock duration of the request or turn. |
| `ai.ttftMs` | number >= 0 | Time to first token. |
| `ai.billingMode` | `subscription` \| `payg` \| `free` | How the call is paid for.  Not the event-level `billingMode` (`actual`/`estimated`/`manual`), which still describes `costUsd`. |
| `ai.costSource` | `billed` \| `estimated` | Whether `costUsd` is the provider's billed figure or a producer estimate. |

Every field is optional and every object is strict:  an unknown key rejects the event.

Total billed tokens = `input + output + cacheRead + cacheWrite5m + cacheWrite1h`.  Use that as the
event `quantity` (with `unit: "token"`).  Use `aiUsageTotalTokens(tokens)`.

## Rules for producers

1. **One event per request (or per turn) carries `ai.tokens`.**  Do not split a request into one
   event per token type, and do not repeat the same `ai.tokens` on a sibling cost event.  Usage
   Monitor sums `ai.tokens` across events, so a repeat is a double count.
2. Send `metricType: "usage"`, `unit: "token"`, `quantity` = total billed tokens, `requests: 1`.
   Put `costUsd` on the same event when you have it, and say where it came from in `ai.costSource`.
3. Keep the model in `producerKeyRef` as today if you already do;  Usage Monitor prices by
   `ai.model.served`, then `ai.model.requested`, then `producerKeyRef`.
4. You may keep sending the old metadata keys during the migration.  When `ai` is present Usage
   Monitor ignores them for token accounting.
5. **Do not send `ai` before Usage Monitor runs a build on shared `v2.8.0` or later.**  Older
   builds parse events with the strict v2.7 schema and reject an event that has `ai`.  Check
   `https://usage.jays.services/api/health`.

## Helper

```ts
import { buildAiUsage, aiUsageTotalTokens, createUsageTelemetryV2Event } from "@jaywedgeworth22/congress-trading-shared";

const ai = buildAiUsage({
  usage: response,            // whole SDK response or its usage / usageMetadata object
  requestedModel: "claude-sonnet-5-5",
  harness: "botfleet",
  seat: "CLAUDE",
  durationMs, ttftMs,
  billingMode: "subscription",
  costSource: "estimated",
});
const event = createUsageTelemetryV2Event({
  provider: "anthropic",
  metricType: "usage",
  unit: "token",
  quantity: aiUsageTotalTokens(ai.tokens),
  requests: 1,
  producerKeyRef: ai.model?.served,
  ai,
});
```

`buildAiUsage` reads these SDK shapes (also exported one by one as `aiTokensFromAnthropicUsage`,
`aiTokensFromOpenAiUsage`, `aiTokensFromGeminiUsage`):

| SDK | Mapping |
| --- | --- |
| Anthropic `usage` | `input_tokens` -> input;  `output_tokens` -> output;  `cache_read_input_tokens` -> cacheRead;  `cache_creation.ephemeral_5m_input_tokens` -> cacheWrite5m;  `cache_creation.ephemeral_1h_input_tokens` -> cacheWrite1h.  Without the TTL breakdown, `cache_creation_input_tokens` -> cacheWrite5m. |
| OpenAI Chat Completions `usage` (also OpenRouter, xAI, Moonshot, MiniMax, DeepSeek) | `prompt_tokens - prompt_tokens_details.cached_tokens` -> input;  `completion_tokens` -> output;  `cached_tokens` -> cacheRead;  `completion_tokens_details.reasoning_tokens` -> reasoning.  DeepSeek `prompt_cache_hit_tokens` -> cacheRead.  OpenRouter `prompt_tokens_details.cache_write_tokens` -> cacheWrite5m (and out of input). |
| OpenAI Responses `usage` | `input_tokens - input_tokens_details.cached_tokens` -> input;  `output_tokens` -> output;  `output_tokens_details.reasoning_tokens` -> reasoning. |
| Gemini `usageMetadata` | `promptTokenCount + toolUsePromptTokenCount - cachedContentTokenCount` -> input;  `candidatesTokenCount + thoughtsTokenCount` -> output;  `cachedContentTokenCount` -> cacheRead;  `thoughtsTokenCount` -> reasoning. |

## Per-producer migration

Each producer migrates in its own lane after Usage Monitor ships the reader.

### Socratic-Trade (`src/lib/usage-monitor-push.ts`, `llmUsageEvent`)

Today:  `promptTokens`, `completionTokens` in metadata, `quantity: totalTokens`.  Carry the
provider's raw `usage` object on `LlmUsageMonitorEntry` and add:

```ts
ai: buildAiUsage({
  usage: entry.rawUsage,                 // OpenRouter / OpenAI chat usage
  requestedModel: entry.model,
  servedModel: entry.servedModel,        // response.model when available
  harness: "socratic-trade",
  billingMode: "payg",
  costSource: hasCost ? "billed" : undefined,
}),
```

Set `quantity` to `aiUsageTotalTokens(ai.tokens)`.  When the raw usage is not available, pass
`tokens: { input: promptTokens - cachedTokens, output: completionTokens }`.

### Congress.Trade (`app/src/extraction/telemetry.ts` token measurement, `app/src/shared/thirdPartyTelemetry.ts`)

Today:  `promptTokens` (includes cache), `completionTokens`, `cachedTokens`, `cacheWriteTokens`,
`cacheWriteOneHourTokens`, `latencyMs`, `serviceTier`.  On the `*-tokens` measurement add:

```ts
ai: {
  model: { requested: result.model, served: result.resolvedModel ?? undefined },
  harness: "congress-trade",
  tokens: {
    input: promptTokens - cachedTokens - cacheWriteTokens - cacheWriteOneHourTokens,
    output: completionTokens,
    cacheRead: cachedTokens,
    cacheWrite5m: cacheWriteTokens,
    cacheWrite1h: cacheWriteOneHourTokens,
  },
  durationMs: result.latencyMs,
  billingMode: "payg",
  costSource: xaiTicks ? "billed" : "estimated",
}
```

`thirdPartyTelemetry.ts` must pass `ai` through to the v2 event (it is a typed field, not
metadata, so `SAFE_METADATA_KEYS` does not apply).  Keep the separate `*-provider-cost` event
without `ai.tokens`.

### BotFleet (`server/telemetry.ts`, `buildTurnEvents`)

Today:  three slice events per turn (`tokenType` input/cacheRead/output) that each repeat the
turn's `inputTokens`, `outputTokens`, `cachedInputTokens`.  Replace the slices with one event per
turn:

```ts
{
  eventId: `${prefix}:turn`,
  metricType: "usage", unit: "token", requests: 1,
  quantity: aiUsageTotalTokens(ai.tokens),
  costUsd: cost ?? undefined,
  ai: {
    model: { requested: params.modelId, served: params.servedModelId },
    harness: "botfleet",
    seat: params.seat,                  // when the bot runs for a seat
    tokens: { input, output, cacheRead, cacheWrite5m, cacheWrite1h, reasoning },
    durationMs: params.latencyMs,
    ttftMs: params.ttftMs,
    billingMode: params.billingMode === "estimated" ? "subscription" : "payg",
    costSource: params.billingMode === "estimated" ? "estimated" : "billed",
  },
}
```

`drivers/claude.ts` must stop folding `cache_read_input_tokens` and `cache_creation_input_tokens`
into `inputTokens`;  use `aiTokensFromAnthropicUsage(usage)` (or `buildAiUsage`) on the raw usage
instead so the 5-minute and 1-hour cache writes survive.

### Usage Monitor collectors and OTLP mapper (`claude-code`, `openai-codex`, `grok-build`, `github-copilot`, `minimax-code`, `deepseek-dsh`, `opencode`, `fx`, `antigravity-*`, `cursor-agent`, `muse`, `muse-code`)

Today:  one row per `tokenType` (`input`, `output`, `cacheRead`, `cacheCreation`) with
`label: token:<type>`.  Emit one event per session-turn (or per collection window and model) with
every token type in `ai.tokens`, `ai.harness` set to the producer id, `ai.seat` when the session
belongs to one, `ai.billingMode: "subscription"` for plan seats (`"payg"` for API keys), and
`ai.model.served` set to the model.  Claude Code OTLP `claude_code.api_request` events carry
`cache_creation` TTL detail only in logs (UM-1590);  until then send `cacheCreation` as
`cacheWrite5m`.

### CodeCaps and any new producer

Send the block from day one, built with `buildAiUsage` from the provider response.

## How Usage Monitor reads it

Usage Monitor persists the block into event metadata under reserved keys (producers cannot set
them directly):  `_aiModelRequested`, `_aiModelServed`, `_aiHarness`, `_aiSeat`, `_aiTokensInput`,
`_aiTokensOutput`, `_aiTokensCacheRead`, `_aiTokensCacheWrite5m`, `_aiTokensCacheWrite1h`,
`_aiTokensReasoning`, `_aiDurationMs`, `_aiTtftMs`, `_aiBillingMode`, `_aiCostSource`, and
`_aiSource` (`block` or `legacy`).  Events from producers that have not migrated are mapped from
the old keys onto the same `_ai*` keys at ingest, so both aggregate the same way.  Cost derivation
prices the canonical tokens, including the 1-hour cache-write rate.
