import { describe, expect, it } from "vitest";

import {
  AiUsageSchema,
  aiTokensFromAnthropicUsage,
  aiTokensFromGeminiUsage,
  aiTokensFromOpenAiUsage,
  aiTokensFromSdkUsage,
  aiUsageTotalTokens,
  buildAiUsage,
  detectAiSdkUsageShape,
} from "../aiUsage";
import {
  USAGE_TELEMETRY_KNOWN_PROVIDERS,
  USAGE_TELEMETRY_PRODUCERS,
  UsageTelemetryV2BatchSchema,
  UsageTelemetryV2EventSchema,
  createUsageTelemetryV2Event,
} from "../usageTelemetry";

describe("AiUsageSchema", () => {
  it("accepts the full canonical block", () => {
    const parsed = AiUsageSchema.parse({
      model: { requested: "claude-opus-5-5[1m]", served: "claude-opus-5-5" },
      harness: "claude-code",
      seat: "CLAUDE",
      tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite5m: 40, cacheWrite1h: 50, reasoning: 5 },
      durationMs: 1234.5,
      ttftMs: 321,
      billingMode: "subscription",
      costSource: "estimated",
    });
    expect(parsed.tokens?.cacheWrite1h).toBe(50);
    expect(parsed.billingMode).toBe("subscription");
  });

  it("accepts an empty block", () => {
    expect(AiUsageSchema.parse({})).toEqual({});
  });

  it("is strict at every level", () => {
    expect(AiUsageSchema.safeParse({ promptTokens: 1 }).success).toBe(false);
    expect(AiUsageSchema.safeParse({ tokens: { cacheWrite: 1 } }).success).toBe(false);
    expect(AiUsageSchema.safeParse({ model: { name: "x" } }).success).toBe(false);
  });

  it("rejects negative, fractional and unknown values", () => {
    expect(AiUsageSchema.safeParse({ tokens: { input: -1 } }).success).toBe(false);
    expect(AiUsageSchema.safeParse({ tokens: { output: 1.5 } }).success).toBe(false);
    expect(AiUsageSchema.safeParse({ ttftMs: -1 }).success).toBe(false);
    expect(AiUsageSchema.safeParse({ billingMode: "actual" }).success).toBe(false);
    expect(AiUsageSchema.safeParse({ costSource: "manual" }).success).toBe(false);
    expect(AiUsageSchema.safeParse({ seat: "" }).success).toBe(false);
  });
});

describe("v2 event ai block", () => {
  const base = { eventId: "evt-1", provider: "anthropic", unit: "token" as const, quantity: 30 };

  it("rides the strict v2 event and batch", () => {
    const event = UsageTelemetryV2EventSchema.parse({
      ...base,
      ai: { model: { served: "claude-sonnet-5-5" }, tokens: { input: 10, output: 20 } },
    });
    expect(event.ai?.tokens).toEqual({ input: 10, output: 20 });
    const batch = UsageTelemetryV2BatchSchema.parse({
      schemaVersion: 2,
      producerId: "botfleet",
      events: [event],
    });
    expect(batch.events[0]?.ai?.model?.served).toBe("claude-sonnet-5-5");
  });

  it("stays optional so existing events are unchanged", () => {
    const event = createUsageTelemetryV2Event(base);
    expect(event.ai).toBeUndefined();
  });

  it("rejects an invalid ai block on the event", () => {
    expect(UsageTelemetryV2EventSchema.safeParse({ ...base, ai: { tokens: { input: -5 } } }).success).toBe(false);
    expect(UsageTelemetryV2EventSchema.safeParse({ ...base, ai: { extra: true } }).success).toBe(false);
  });
});

describe("producer and provider lists", () => {
  it("cover the fleet producers", () => {
    for (const id of [
      "botfleet", "codecaps", "claude-code", "openai-codex", "grok-build", "deepseek-dsh", "opencode", "fx",
    ]) {
      expect(USAGE_TELEMETRY_PRODUCERS).toContain(id);
    }
  });

  it("cover the AI providers", () => {
    for (const id of ["minimax", "deepseek", "xai", "moonshot", "anthropic", "openai", "google-ai"]) {
      expect(USAGE_TELEMETRY_KNOWN_PROVIDERS).toContain(id);
    }
  });
});

describe("aiTokensFromAnthropicUsage", () => {
  it("splits cache writes by TTL", () => {
    expect(aiTokensFromAnthropicUsage({
      input_tokens: 12,
      output_tokens: 340,
      cache_read_input_tokens: 5000,
      cache_creation_input_tokens: 900,
      cache_creation: { ephemeral_5m_input_tokens: 600, ephemeral_1h_input_tokens: 300 },
    })).toEqual({ input: 12, output: 340, cacheRead: 5000, cacheWrite5m: 600, cacheWrite1h: 300 });
  });

  it("treats an undifferentiated cache write as 5-minute", () => {
    expect(aiTokensFromAnthropicUsage({
      input_tokens: 1,
      output_tokens: 2,
      cache_creation_input_tokens: 70,
    })).toEqual({ input: 1, output: 2, cacheWrite5m: 70 });
  });

  it("assigns cache writes the TTL breakdown misses to 5-minute", () => {
    expect(aiTokensFromAnthropicUsage({
      cache_creation_input_tokens: 100,
      cache_creation: { ephemeral_1h_input_tokens: 40 },
    })).toEqual({ cacheWrite5m: 60, cacheWrite1h: 40 });
  });
});

describe("aiTokensFromOpenAiUsage", () => {
  it("subtracts cached tokens from Chat Completions prompt tokens", () => {
    expect(aiTokensFromOpenAiUsage({
      prompt_tokens: 1000,
      completion_tokens: 300,
      prompt_tokens_details: { cached_tokens: 800 },
      completion_tokens_details: { reasoning_tokens: 120 },
    })).toEqual({ input: 200, output: 300, cacheRead: 800, reasoning: 120 });
  });

  it("reads the Responses API shape", () => {
    expect(aiTokensFromOpenAiUsage({
      input_tokens: 50,
      output_tokens: 70,
      input_tokens_details: { cached_tokens: 10 },
      output_tokens_details: { reasoning_tokens: 30 },
    })).toEqual({ input: 40, output: 70, cacheRead: 10, reasoning: 30 });
  });

  it("reads DeepSeek cache hits and OpenRouter cache writes", () => {
    expect(aiTokensFromOpenAiUsage({ prompt_tokens: 100, completion_tokens: 1, prompt_cache_hit_tokens: 60 }))
      .toEqual({ input: 40, output: 1, cacheRead: 60 });
    expect(aiTokensFromOpenAiUsage({
      prompt_tokens: 100,
      completion_tokens: 1,
      prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 30 },
    })).toEqual({ input: 50, output: 1, cacheRead: 20, cacheWrite5m: 30 });
  });

  it("never reports negative input", () => {
    expect(aiTokensFromOpenAiUsage({ prompt_tokens: 5, prompt_tokens_details: { cached_tokens: 9 } }).input).toBe(0);
  });
});

describe("aiTokensFromGeminiUsage", () => {
  it("counts thoughts as output and removes cached content from input", () => {
    expect(aiTokensFromGeminiUsage({
      promptTokenCount: 1000,
      cachedContentTokenCount: 600,
      candidatesTokenCount: 200,
      thoughtsTokenCount: 50,
      toolUsePromptTokenCount: 10,
    })).toEqual({ input: 410, output: 250, cacheRead: 600, reasoning: 50 });
  });
});

describe("detectAiSdkUsageShape / aiTokensFromSdkUsage", () => {
  it("detects each shape", () => {
    expect(detectAiSdkUsageShape({ input_tokens: 1, cache_read_input_tokens: 0 })).toBe("anthropic");
    expect(detectAiSdkUsageShape({ prompt_tokens: 1 })).toBe("openai");
    expect(detectAiSdkUsageShape({ input_tokens: 1, input_tokens_details: {} })).toBe("openai");
    expect(detectAiSdkUsageShape({ promptTokenCount: 1 })).toBe("gemini");
    expect(detectAiSdkUsageShape({ foo: 1 })).toBeNull();
    expect(detectAiSdkUsageShape(null)).toBeNull();
  });

  it("unwraps whole responses", () => {
    expect(aiTokensFromSdkUsage({ usage: { prompt_tokens: 3, completion_tokens: 4 } }))
      .toEqual({ input: 3, output: 4 });
    expect(aiTokensFromSdkUsage({ usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4 } }))
      .toEqual({ input: 3, output: 4 });
    expect(aiTokensFromSdkUsage({ usage: { input_tokens: 3, output_tokens: 4 } }, "anthropic"))
      .toEqual({ input: 3, output: 4 });
    expect(aiTokensFromSdkUsage("nope")).toBeNull();
  });
});

describe("buildAiUsage", () => {
  it("builds a validated block from an Anthropic response", () => {
    const block = buildAiUsage({
      usage: {
        model: "claude-sonnet-5-5",
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 40,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 40 },
        },
      },
      requestedModel: "sonnet",
      harness: "botfleet",
      seat: "CLAUDE",
      durationMs: 900,
      ttftMs: 120,
      billingMode: "payg",
      costSource: "billed",
    });
    expect(block).toEqual({
      model: { requested: "sonnet", served: "claude-sonnet-5-5" },
      harness: "botfleet",
      seat: "CLAUDE",
      tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite5m: 0, cacheWrite1h: 40 },
      durationMs: 900,
      ttftMs: 120,
      billingMode: "payg",
      costSource: "billed",
    });
    expect(aiUsageTotalTokens(block.tokens)).toBe(100);
  });

  it("ignores explicit undefined tokens instead of failing or erasing SDK counts", () => {
    expect(buildAiUsage({ tokens: { input: undefined } })).toEqual({});
    expect(buildAiUsage({ usage: { prompt_tokens: 5, completion_tokens: 6 }, tokens: { input: undefined } }))
      .toEqual({ tokens: { input: 5, output: 6 } });
  });

  it("reads a bare input/output pair identically under either SDK reading", () => {
    const bare = { input_tokens: 100, output_tokens: 50 };
    expect(aiTokensFromSdkUsage(bare)).toEqual(aiTokensFromOpenAiUsage(bare));
  });

  it("lets explicit tokens win and omits empty fields", () => {
    expect(buildAiUsage({ usage: { prompt_tokens: 5, completion_tokens: 6 }, tokens: { output: 9 } }))
      .toEqual({ tokens: { input: 5, output: 9 } });
    expect(buildAiUsage({})).toEqual({});
  });

  it("never adds reasoning to the total", () => {
    expect(aiUsageTotalTokens({ input: 1, output: 10, reasoning: 8 })).toBe(11);
    expect(aiUsageTotalTokens(undefined)).toBe(0);
  });
});
