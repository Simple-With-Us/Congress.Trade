/**
 * Pure accounting/performance helpers for extraction benchmarks.
 *
 * A dollar value is emitted only when it is backed by either a provider-
 * reported charge or complete measured usage and a dated rate-card entry.
 * Unknown models/meters stay unknown: callers must not substitute a default
 * request price or infer pages from file size.
 */

export type BenchmarkCostSource = 'provider_reported' | 'usage_priced' | 'unknown';

export interface BenchmarkUsage {
  /** Total billed input tokens, including cached input tokens. */
  promptTokens?: number;
  /** Total billed output tokens, including reasoning/thinking tokens. */
  completionTokens?: number;
  /** Subset of promptTokens billed at the cached-input rate. */
  cachedTokens?: number;
  /** Subset of promptTokens written to cache; some providers bill a premium. */
  cacheWriteTokens?: number;
  /** Subset written to a one-hour cache when the provider reports TTL detail. */
  cacheWriteOneHourTokens?: number;
  /** Effective provider service tier returned with the usage record. */
  serviceTier?: string;
  /** Provider-reported pages processed; never derive this from byte size. */
  pagesProcessed?: number;
  /** Exact xAI request charge in ticks (1 USD = 10^10 ticks). */
  costInUsdTicks?: number;
  /** Provider-reported dollar charge (OpenRouter usage accounting `usage.cost`). */
  costUsd?: number;
  /** Successful billable attachment_search executions reported by xAI. */
  attachmentSearchCalls?: number;
}

interface RateMetadata {
  provider: string;
  models: readonly string[];
  version: string;
  effectiveDate: string;
  sourceUrl: string;
  note: string;
}

export interface TokenRate extends RateMetadata {
  meter: 'tokens';
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
  /** Cache-write price as a multiplier of ordinary input. */
  cacheWriteInputMultiplier?: number;
  cacheWriteOneHourInputMultiplier?: number;
  outputUsdPerMillion: number;
  supportedServiceTiers?: readonly string[];
  /** Multipliers applied to the final token cost based on the service tier (e.g. batch = 0.5) */
  serviceTierMultipliers?: Record<string, number>;
  /** Full-request multiplier once billed input crosses the provider threshold. */
  longContextThresholdTokens?: number;
  longContextInputMultiplier?: number;
  longContextOutputMultiplier?: number;
  /** Require the provider's exact request charge when token pricing omits billable tools. */
  requiresProviderReportedCost?: boolean;
}

export interface PageRate extends RateMetadata {
  meter: 'pages';
  usdPerPage: number;
  pageKind: 'annotated';
}

export type BenchmarkRate = TokenRate | PageRate;

/**
 * Public on-demand rates captured on 2026-07-13. These are deliberately
 * versioned because provider aliases and prices change. They represent actual
 * measured usage priced at the recorded public rate, not invoice
 * reconciliation (free tiers, negotiated discounts, taxes, and committed-use
 * plans can differ).
 */
export const STANDARD_BENCHMARK_RATE_CARD = [
  {
    provider: 'openrouter',
    models: ['openai/gpt-5.6-terra'],
    meter: 'tokens',
    inputUsdPerMillion: 2.5,
    cachedInputUsdPerMillion: 0.25,
    cacheWriteInputMultiplier: 1.25,
    outputUsdPerMillion: 15,
    longContextThresholdTokens: 272_000,
    longContextInputMultiplier: 2,
    longContextOutputMultiplier: 1.5,
    version: 'openrouter-static-2026-07-23',
    effectiveDate: '2026-07-23',
    sourceUrl: 'https://openrouter.ai/docs#models',
    note: 'OpenRouter passthrough of OpenAI GPT-5.6 Terra pricing; replaces a prior openrouter-dummy shadow row that underpriced cached input.',
  },
  {
    provider: 'openrouter',
    models: ['openai/gpt-5.6-luna'],
    meter: 'tokens',
    inputUsdPerMillion: 1,
    cachedInputUsdPerMillion: 0.1,
    cacheWriteInputMultiplier: 1.25,
    outputUsdPerMillion: 6,
    longContextThresholdTokens: 272_000,
    longContextInputMultiplier: 2,
    longContextOutputMultiplier: 1.5,
    version: 'openrouter-static-2026-07-23',
    effectiveDate: '2026-07-23',
    sourceUrl: 'https://openrouter.ai/docs#models',
    note: 'OpenRouter passthrough of OpenAI GPT-5.6 Luna pricing; replaces a prior openrouter-dummy shadow row that underpriced output ($2 vs $6).',
  },

  {
    provider: 'openrouter',
    models: ['qwen/qwen-2.5-vl-72b-instruct:free', 'google/gemini-2.0-flash-thinking-exp:free'],
    meter: 'tokens',
    inputUsdPerMillion: 0,
    cachedInputUsdPerMillion: 0, // OpenRouter cache discounts vary, using base for benchmark
    outputUsdPerMillion: 0,
    version: 'openrouter-static-2026-07-16',
    effectiveDate: '2026-07-16',
    sourceUrl: 'https://openrouter.ai/docs#models',
    note: 'OpenRouter static pricing.',
  },
  {
    provider: 'openrouter',
    models: ['deepseek/deepseek-chat', 'deepseek/deepseek-coder'],
    meter: 'tokens',
    inputUsdPerMillion: 0.14,
    cachedInputUsdPerMillion: 0.14, // OpenRouter cache discounts vary, using base for benchmark
    outputUsdPerMillion: 0.28,
    version: 'openrouter-static-2026-07-16',
    effectiveDate: '2026-07-16',
    sourceUrl: 'https://openrouter.ai/docs#models',
    note: 'OpenRouter static pricing.',
  },
  {
    provider: 'openrouter',
    models: ['anthropic/claude-sonnet-5'],
    meter: 'tokens',
    inputUsdPerMillion: 2,
    cachedInputUsdPerMillion: 2, // OpenRouter cache discounts vary, using base for benchmark
    outputUsdPerMillion: 10,
    version: 'openrouter-static-2026-07-16',
    effectiveDate: '2026-07-16',
    sourceUrl: 'https://openrouter.ai/docs#models',
    note: 'OpenRouter passthrough of Anthropic Sonnet 5 introductory pricing ($2/$10 through 2026-08-31); verified against the live /api/v1/models listing 2026-07-16.',
  },
  {
    provider: 'openrouter',
    models: ['anthropic/claude-sonnet'],
    meter: 'tokens',
    inputUsdPerMillion: 3,
    cachedInputUsdPerMillion: 3, // OpenRouter cache discounts vary, using base for benchmark
    outputUsdPerMillion: 15,
    version: 'openrouter-static-2026-07-16',
    effectiveDate: '2026-07-16',
    sourceUrl: 'https://openrouter.ai/docs#models',
    note: 'OpenRouter static pricing.',
  },
  {
    provider: 'openrouter',
    models: ['anthropic/claude-3.5-haiku'],
    meter: 'tokens',
    inputUsdPerMillion: 1,
    cachedInputUsdPerMillion: 1, // OpenRouter cache discounts vary, using base for benchmark
    outputUsdPerMillion: 5,
    version: 'openrouter-static-2026-07-16',
    effectiveDate: '2026-07-16',
    sourceUrl: 'https://openrouter.ai/docs#models',
    note: 'OpenRouter static pricing.',
  },
  {
    provider: 'openrouter',
    models: ['anthropic/claude-3.7-opus'],
    meter: 'tokens',
    inputUsdPerMillion: 15,
    cachedInputUsdPerMillion: 15, // OpenRouter cache discounts vary, using base for benchmark
    outputUsdPerMillion: 75,
    version: 'openrouter-static-2026-07-16',
    effectiveDate: '2026-07-16',
    sourceUrl: 'https://openrouter.ai/docs#models',
    note: 'OpenRouter static pricing.',
  },
  {
    provider: 'openrouter',
    models: ['openai/gpt-4o'],
    meter: 'tokens',
    inputUsdPerMillion: 2.5,
    cachedInputUsdPerMillion: 2.5, // OpenRouter cache discounts vary, using base for benchmark
    outputUsdPerMillion: 10,
    version: 'openrouter-static-2026-07-16',
    effectiveDate: '2026-07-16',
    sourceUrl: 'https://openrouter.ai/docs#models',
    note: 'OpenRouter static pricing.',
  },
  {
    provider: 'openrouter',
    models: ['openai/gpt-4o-mini'],
    meter: 'tokens',
    inputUsdPerMillion: 0.15,
    cachedInputUsdPerMillion: 0.15, // OpenRouter cache discounts vary, using base for benchmark
    outputUsdPerMillion: 0.6,
    version: 'openrouter-static-2026-07-16',
    effectiveDate: '2026-07-16',
    sourceUrl: 'https://openrouter.ai/docs#models',
    note: 'OpenRouter static pricing.',
  },
  {
    provider: 'openrouter',
    models: ['qwen/qwen-2.5-72b-instruct'],
    meter: 'tokens',
    inputUsdPerMillion: 0.35,
    cachedInputUsdPerMillion: 0.35, // OpenRouter cache discounts vary, using base for benchmark
    outputUsdPerMillion: 0.4,
    version: 'openrouter-static-2026-07-16',
    effectiveDate: '2026-07-16',
    sourceUrl: 'https://openrouter.ai/docs#models',
    note: 'OpenRouter static pricing.',
  },
  {
    provider: 'openrouter',
    models: ['qwen/qwen-max'],
    meter: 'tokens',
    inputUsdPerMillion: 1.2,
    cachedInputUsdPerMillion: 1.2, // OpenRouter cache discounts vary, using base for benchmark
    outputUsdPerMillion: 1.2,
    version: 'openrouter-static-2026-07-16',
    effectiveDate: '2026-07-16',
    sourceUrl: 'https://openrouter.ai/docs#models',
    note: 'OpenRouter static pricing.',
  },
  {
    provider: 'openrouter',
    models: ['google/gemini-pro-1.5'],
    meter: 'tokens',
    inputUsdPerMillion: 1.25,
    cachedInputUsdPerMillion: 1.25, // OpenRouter cache discounts vary, using base for benchmark
    outputUsdPerMillion: 5,
    version: 'openrouter-static-2026-07-16',
    effectiveDate: '2026-07-16',
    sourceUrl: 'https://openrouter.ai/docs#models',
    note: 'OpenRouter static pricing.',
  },
  {
    provider: 'openrouter',
    models: ['google/gemini-flash-1.5'],
    meter: 'tokens',
    inputUsdPerMillion: 0.075,
    cachedInputUsdPerMillion: 0.075, // OpenRouter cache discounts vary, using base for benchmark
    outputUsdPerMillion: 0.3,
    version: 'openrouter-static-2026-07-16',
    effectiveDate: '2026-07-16',
    sourceUrl: 'https://openrouter.ai/docs#models',
    note: 'OpenRouter static pricing.',
  },
  {
    provider: 'openrouter',
    models: ['mistralai/mistral-large-2411'],
    meter: 'tokens',
    inputUsdPerMillion: 2,
    cachedInputUsdPerMillion: 2, // OpenRouter cache discounts vary, using base for benchmark
    outputUsdPerMillion: 6,
    version: 'openrouter-static-2026-07-16',
    effectiveDate: '2026-07-16',
    sourceUrl: 'https://openrouter.ai/docs#models',
    note: 'OpenRouter static pricing.',
  },
  {
    provider: 'openrouter',
    models: ['x-ai/grok-2-vision-1212'],
    meter: 'tokens',
    inputUsdPerMillion: 2,
    cachedInputUsdPerMillion: 2, // OpenRouter cache discounts vary, using base for benchmark
    outputUsdPerMillion: 10,
    version: 'openrouter-static-2026-07-16',
    effectiveDate: '2026-07-16',
    sourceUrl: 'https://openrouter.ai/docs#models',
    note: 'OpenRouter static pricing.',
  },
  {
    provider: 'openrouter',
    models: ['01-ai/yi-large', 'moonshotai/kimi-chat', 'minimax/minimax-hep-lite'],
    meter: 'tokens',
    inputUsdPerMillion: 0.2,
    cachedInputUsdPerMillion: 0.2, // OpenRouter cache discounts vary, using base for benchmark
    outputUsdPerMillion: 0.2,
    version: 'openrouter-static-2026-07-16',
    effectiveDate: '2026-07-16',
    sourceUrl: 'https://openrouter.ai/docs#models',
    note: 'OpenRouter static pricing.',
  },
  {
    provider: 'gemini',
    models: ['gemini-3.5-flash'],
    meter: 'tokens',
    inputUsdPerMillion: 1.5,
    cachedInputUsdPerMillion: 0.15,
    outputUsdPerMillion: 9,
    version: 'google-standard-2026-07-13',
    effectiveDate: '2026-07-13',
    sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
    note: 'Gemini Developer API paid standard tier; output must include thinking tokens.',
  },
  {
    provider: 'openai',
    models: ['gpt-5.6-sol', 'gpt-5.6'],
    meter: 'tokens',
    inputUsdPerMillion: 5,
    cachedInputUsdPerMillion: 0.5,
    cacheWriteInputMultiplier: 1.25,
    outputUsdPerMillion: 30,
    supportedServiceTiers: ['default', 'batch'],
    serviceTierMultipliers: { batch: 0.5 },
    longContextThresholdTokens: 272_000,
    longContextInputMultiplier: 2,
    longContextOutputMultiplier: 1.5,
    version: 'openai-gpt-5.6-standard-2026-07-13',
    effectiveDate: '2026-07-13',
    sourceUrl: 'https://developers.openai.com/api/docs/pricing',
    note: 'GPT-5.6 Sol standard/default processing; cache writes are 1.25x input; prompts above 272K input tokens use full-request long-context multipliers.',
  },
  {
    provider: 'openai',
    models: ['gpt-5.6-terra'],
    meter: 'tokens',
    inputUsdPerMillion: 2.5,
    cachedInputUsdPerMillion: 0.25,
    cacheWriteInputMultiplier: 1.25,
    outputUsdPerMillion: 15,
    supportedServiceTiers: ['default', 'batch'],
    serviceTierMultipliers: { batch: 0.5 },
    longContextThresholdTokens: 272_000,
    longContextInputMultiplier: 2,
    longContextOutputMultiplier: 1.5,
    version: 'openai-gpt-5.6-standard-2026-07-13',
    effectiveDate: '2026-07-13',
    sourceUrl: 'https://developers.openai.com/api/docs/pricing',
    note: 'GPT-5.6 Terra standard/default processing; cache writes are 1.25x input; prompts above 272K input tokens use full-request long-context multipliers.',
  },
  {
    provider: 'openai',
    models: ['gpt-5.6-luna'],
    meter: 'tokens',
    inputUsdPerMillion: 1,
    cachedInputUsdPerMillion: 0.1,
    cacheWriteInputMultiplier: 1.25,
    outputUsdPerMillion: 6,
    supportedServiceTiers: ['default', 'batch'],
    serviceTierMultipliers: { batch: 0.5 },
    longContextThresholdTokens: 272_000,
    longContextInputMultiplier: 2,
    longContextOutputMultiplier: 1.5,
    version: 'openai-gpt-5.6-standard-2026-07-13',
    effectiveDate: '2026-07-13',
    sourceUrl: 'https://developers.openai.com/api/docs/pricing',
    note: 'GPT-5.6 Luna standard/default processing; cache writes are 1.25x input; prompts above 272K input tokens use full-request long-context multipliers.',
  },
  {
    provider: 'openai',
    models: ['gpt-4o', 'gpt-4o-2024-08-06', 'gpt-4o-2024-11-20'],
    meter: 'tokens',
    inputUsdPerMillion: 2.5,
    cachedInputUsdPerMillion: 1.25,
    outputUsdPerMillion: 10,
    supportedServiceTiers: ['default', 'batch'],
    serviceTierMultipliers: { batch: 0.5 },
    version: 'openai-standard-2026-07-13',
    effectiveDate: '2026-07-13',
    sourceUrl: 'https://developers.openai.com/api/docs/models/gpt-4o',
    note: 'OpenAI API standard processing.',
  },
  {
    provider: 'anthropic',
    models: ['claude-sonnet-5'],
    meter: 'tokens',
    inputUsdPerMillion: 2,
    cachedInputUsdPerMillion: 0.2,
    cacheWriteInputMultiplier: 1.25,
    cacheWriteOneHourInputMultiplier: 2,
    outputUsdPerMillion: 10,
    version: 'anthropic-sonnet5-intro-2026-07-16',
    effectiveDate: '2026-07-16',
    sourceUrl: 'https://docs.anthropic.com/en/docs/about-claude/models/whats-new-sonnet-5',
    note: 'Introductory pricing $2/$10 per MTok through August 31, 2026; cache reads are 0.1x, 5-minute writes 1.25x, and 1-hour writes 2x base input.',
  },
  {
    provider: 'anthropic',
    models: ['claude-haiku-4-5'],
    meter: 'tokens',
    inputUsdPerMillion: 1,
    cachedInputUsdPerMillion: 0.1,
    cacheWriteInputMultiplier: 1.25,
    cacheWriteOneHourInputMultiplier: 2,
    outputUsdPerMillion: 5,
    version: 'anthropic-standard-2026-07-13',
    effectiveDate: '2026-07-13',
    sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
    note: 'Claude API standard global pricing; cache reads are 0.1x, 5-minute writes 1.25x, and 1-hour writes 2x base input.',
  },
  {
    provider: 'xai',
    models: ['grok-4.3'],
    meter: 'tokens',
    inputUsdPerMillion: 1.25,
    cachedInputUsdPerMillion: 0.2,
    outputUsdPerMillion: 2.5,
    requiresProviderReportedCost: true,
    version: 'xai-standard-2026-07-13',
    effectiveDate: '2026-07-13',
    sourceUrl: 'https://docs.x.ai/developers/pricing',
    note: 'xAI Responses exact request cost is required because PDF attachments invoke the separately billed attachment_search tool; token-only pricing would be incomplete.',
  },
  {
    provider: 'mistral',
    models: ['mistral-ocr-latest', 'mistral-ocr-4-0'],
    meter: 'pages',
    usdPerPage: 0.005,
    pageKind: 'annotated',
    version: 'mistral-ocr4-annotated-2026-07-13',
    effectiveDate: '2026-07-13',
    sourceUrl: 'https://docs.mistral.ai/models/model-cards/ocr-4-0',
    note: 'OCR 4 annotated-page price; this app requests document_annotation_format.',
  },
  {
    provider: 'openrouter',
    models: ['openai/gpt-5.6-terra-pro'],
    meter: 'tokens',
    inputUsdPerMillion: 2.5,
    cachedInputUsdPerMillion: 0.25,
    cacheWriteInputMultiplier: 1.25,
    outputUsdPerMillion: 15,
    longContextThresholdTokens: 272_000,
    longContextInputMultiplier: 2,
    longContextOutputMultiplier: 1.5,
    version: 'openrouter-static-2026-07-17',
    effectiveDate: '2026-07-17',
    sourceUrl: 'https://openrouter.ai/docs#models',
    note: 'OpenRouter passthrough of OpenAI GPT-5.6 Terra Pro pricing; verified against the live /api/v1/models listing 2026-07-17.',
  },
  {
    provider: 'openrouter',
    models: ['anthropic/claude-haiku-4.5'],
    meter: 'tokens',
    inputUsdPerMillion: 1,
    cachedInputUsdPerMillion: 0.1,
    cacheWriteInputMultiplier: 1.25,
    cacheWriteOneHourInputMultiplier: 2,
    outputUsdPerMillion: 5,
    version: 'openrouter-static-2026-07-17',
    effectiveDate: '2026-07-17',
    sourceUrl: 'https://openrouter.ai/docs#models',
    note: 'OpenRouter passthrough of Anthropic Claude Haiku 4.5 pricing; verified against the live /api/v1/models listing 2026-07-17.',
  },
  {
    provider: 'openrouter',
    models: ['anthropic/claude-opus-5'],
    meter: 'tokens',
    inputUsdPerMillion: 5,
    cachedInputUsdPerMillion: 0.5,
    cacheWriteInputMultiplier: 1.25,
    cacheWriteOneHourInputMultiplier: 2,
    outputUsdPerMillion: 25,
    version: 'openrouter-static-2026-09-18',
    effectiveDate: '2026-09-18',
    sourceUrl: 'https://openrouter.ai/docs#models',
    note: 'OpenRouter passthrough of Anthropic Claude Opus 5 pricing (per-M rates carried over from claude-opus-4.8 while OpenRouter finalizes listing); verified against the live /api/v1/models listing 2026-09-18. Refresh pricing on the next OpenRouter catalog cycle.',
  },
  {
    provider: 'openrouter',
    models: ['mistral/mistral-ocr-latest'],
    meter: 'pages',
    usdPerPage: 0.002,
    pageKind: 'annotated',
    version: 'openrouter-mistral-ocr-2026-07-17',
    effectiveDate: '2026-07-17',
    sourceUrl: 'https://openrouter.ai/docs/features/multimodal/pdfs',
    note: 'OpenRouter mistral-ocr file-parser plugin price ($2 per 1,000 pages).',
  },
  // --- Live DEFAULT_CANDIDATES coverage (verified against the OpenRouter
  // /api/v1/models listing 2026-07-18). Every offered openrouter slug must
  // resolve a rate (drift gate in benchmarkMetrics.test.ts); openrouter/auto
  // is the sole documented exemption — its routing is unpredictable, so its
  // cost is captured from provider-reported usage accounting instead.
  {
    provider: 'openrouter',
    models: ['deepseek/deepseek-v4-pro'],
    meter: 'tokens',
    inputUsdPerMillion: 0.435,
    cachedInputUsdPerMillion: 0.003625,
    outputUsdPerMillion: 0.87,
    version: 'openrouter-static-2026-07-18',
    effectiveDate: '2026-07-18',
    sourceUrl: 'https://openrouter.ai/docs#models',
    note: 'OpenRouter DeepSeek V4 Pro pricing; verified against the live /api/v1/models listing 2026-07-18.',
  },
  {
    provider: 'openrouter',
    models: ['deepseek/deepseek-v4-flash'],
    meter: 'tokens',
    inputUsdPerMillion: 0.098,
    cachedInputUsdPerMillion: 0.0196,
    outputUsdPerMillion: 0.196,
    version: 'openrouter-static-2026-07-18',
    effectiveDate: '2026-07-18',
    sourceUrl: 'https://openrouter.ai/docs#models',
    note: 'OpenRouter DeepSeek V4 Flash pricing; verified against the live /api/v1/models listing 2026-07-18.',
  },
  {
    provider: 'openrouter',
    models: ['qwen/qwen3-vl-30b-a3b-instruct'],
    meter: 'tokens',
    inputUsdPerMillion: 0.13,
    cachedInputUsdPerMillion: 0.13, // no cached-input discount listed; base rate
    outputUsdPerMillion: 0.52,
    version: 'openrouter-static-2026-07-18',
    effectiveDate: '2026-07-18',
    sourceUrl: 'https://openrouter.ai/docs#models',
    note: 'OpenRouter Qwen3 VL 30B A3B Instruct pricing; verified against the live /api/v1/models listing 2026-07-18.',
  },
  {
    provider: 'openrouter',
    models: ['qwen/qwen3-vl-8b-instruct'],
    meter: 'tokens',
    inputUsdPerMillion: 0.117,
    cachedInputUsdPerMillion: 0.117, // no cached-input discount listed; base rate
    outputUsdPerMillion: 0.455,
    version: 'openrouter-static-2026-07-18',
    effectiveDate: '2026-07-18',
    sourceUrl: 'https://openrouter.ai/docs#models',
    note: 'OpenRouter Qwen3 VL 8B Instruct pricing; verified against the live /api/v1/models listing 2026-07-18.',
  },
  {
    provider: 'openrouter',
    models: ['google/gemini-2.5-flash-lite'],
    meter: 'tokens',
    inputUsdPerMillion: 0.1,
    cachedInputUsdPerMillion: 0.01,
    outputUsdPerMillion: 0.4,
    version: 'openrouter-static-2026-07-18',
    effectiveDate: '2026-07-18',
    sourceUrl: 'https://openrouter.ai/docs#models',
    note: 'OpenRouter Gemini 2.5 Flash Lite pricing; verified against the live /api/v1/models listing 2026-07-18.',
  },
  {
    provider: 'openrouter',
    models: ['google/gemini-3.5-flash-lite'],
    meter: 'tokens',
    inputUsdPerMillion: 0.3,
    cachedInputUsdPerMillion: 0.03,
    outputUsdPerMillion: 2.5,
    version: 'openrouter-static-2026-08-14',
    effectiveDate: '2026-08-14',
    sourceUrl: 'https://openrouter.ai/docs#models',
    note: 'OpenRouter Gemini 3.5 Flash Lite pricing; verified against the live /api/v1/models listing 2026-08-14.',
  },
  {
    provider: 'openrouter',
    models: ['google/gemini-3.5-flash'],
    meter: 'tokens',
    inputUsdPerMillion: 1.5,
    cachedInputUsdPerMillion: 0.15,
    outputUsdPerMillion: 9,
    version: 'openrouter-static-2026-07-18',
    effectiveDate: '2026-07-18',
    sourceUrl: 'https://openrouter.ai/docs#models',
    note: 'OpenRouter passthrough of Gemini 3.5 Flash pricing (matches the direct Google rate row); verified against the live /api/v1/models listing 2026-07-18.',
  },
  {
    provider: 'openrouter',
    models: ['google/gemini-3.8-flash', '~google/gemini-flash-latest'],
    meter: 'tokens',
    inputUsdPerMillion: 0.375,
    cachedInputUsdPerMillion: 0.0375,
    outputUsdPerMillion: 1.875,
    version: 'openrouter-static-2026-09-18',
    effectiveDate: '2026-09-18',
    sourceUrl: 'https://openrouter.ai/docs#models',
    note: 'OpenRouter Gemini 3.8 Flash interactive pricing on the Vertex/`Google` endpoint (75% off list $1.50/$7.50).  3.8 strictly dominates 3.7 at identical per-M rates and 1.05M context, so the 3.7 row was retired on the same bump; verified against /api/v1/models + /endpoints 2026-09-18.',
  },
  {
    provider: 'openrouter',
    models: ['google/gemini-3.8-flash:batch'],
    meter: 'tokens',
    inputUsdPerMillion: 0.1875,
    cachedInputUsdPerMillion: 0.01875,
    outputUsdPerMillion: 0.9375,
    version: 'openrouter-static-2026-09-18',
    effectiveDate: '2026-09-18',
    sourceUrl: 'https://openrouter.ai/docs#models',
    note: 'OpenRouter Gemini 3.8 Flash batch/offline pricing; same rates as 3.7 batch; verified against the live /api/v1/models listing 2026-09-18.',
  },
  {
    provider: 'openrouter',
    models: ['amazon/nova-lite-v1'],
    meter: 'tokens',
    inputUsdPerMillion: 0.06,
    cachedInputUsdPerMillion: 0.06, // no cached-input discount listed; base rate
    outputUsdPerMillion: 0.24,
    version: 'openrouter-static-2026-07-18',
    effectiveDate: '2026-07-18',
    sourceUrl: 'https://openrouter.ai/docs#models',
    note: 'OpenRouter Amazon Nova Lite 1.0 pricing; verified against the live /api/v1/models listing 2026-07-18.',
  },
  {
    provider: 'openrouter',
    models: ['z-ai/glm-4.6v'],
    meter: 'tokens',
    inputUsdPerMillion: 0.3,
    cachedInputUsdPerMillion: 0.055,
    outputUsdPerMillion: 0.9,
    version: 'openrouter-static-2026-07-18',
    effectiveDate: '2026-07-18',
    sourceUrl: 'https://openrouter.ai/docs#models',
    note: 'OpenRouter Z.ai GLM 4.6V pricing; verified against the live /api/v1/models listing 2026-07-18.',
  },
  {
    provider: 'openrouter',
    models: ['x-ai/grok-4.6'],
    meter: 'tokens',
    inputUsdPerMillion: 2,
    cachedInputUsdPerMillion: 0.3,
    outputUsdPerMillion: 6,
    longContextThresholdTokens: 200_000,
    longContextInputMultiplier: 2,
    longContextOutputMultiplier: 2,
    version: 'openrouter-static-2026-09-18',
    effectiveDate: '2026-09-18',
    sourceUrl: 'https://openrouter.ai/docs#models',
    note: 'OpenRouter Grok 4.6 pricing ($2/$6 per 1M; cache $0.30; 2x input/output above 200K prompt tokens). Per-M rates carried over from grok-4.5 while OpenRouter finalizes 4.6 listing — same shape, refreshed release. Verified against live /api/v1/models listing 2026-09-18. Token pricing is complete on this transport — the direct-xAI attachment_search surcharge does not apply via OpenRouter.',
  },
  {
    provider: 'openrouter',
    models: ['x-ai/grok-4.3'],
    meter: 'tokens',
    inputUsdPerMillion: 1.25,
    cachedInputUsdPerMillion: 0.2,
    outputUsdPerMillion: 2.5,
    longContextThresholdTokens: 200_000,
    longContextInputMultiplier: 2,
    longContextOutputMultiplier: 2,
    version: 'openrouter-static-2026-07-18',
    effectiveDate: '2026-07-18',
    sourceUrl: 'https://openrouter.ai/docs#models',
    note: 'OpenRouter Grok 4.3 pricing (2x input/output above 200K prompt tokens); retained for historical extraction_runs. Token pricing is complete on this transport — the direct-xAI attachment_search surcharge does not apply via OpenRouter. Verified against the live /api/v1/models listing 2026-07-18.',
  },
  {
    provider: 'llamaparse',
    models: ['fast'],
    meter: 'pages',
    usdPerPage: 0.00125,
    pageKind: 'annotated',
    version: 'llamaparse-credit-list-2026-07-13',
    effectiveDate: '2026-07-13',
    sourceUrl: 'https://developers.llamaindex.ai/llamaparse/general/pricing/',
    note: 'Fast mode: 1 credit/page; public pay-as-you-go conversion is 1,000 credits for $1.25.',
  },
  {
    provider: 'llamaparse',
    models: ['cost-effective'],
    meter: 'pages',
    usdPerPage: 0.00375,
    pageKind: 'annotated',
    version: 'llamaparse-credit-list-2026-07-13',
    effectiveDate: '2026-07-13',
    sourceUrl: 'https://developers.llamaindex.ai/llamaparse/general/pricing/',
    note: 'Cost-effective mode: 3 credits/page; public pay-as-you-go conversion is 1,000 credits for $1.25.',
  },
  {
    provider: 'llamaparse',
    models: ['agentic'],
    meter: 'pages',
    usdPerPage: 0.0125,
    pageKind: 'annotated',
    version: 'llamaparse-credit-list-2026-07-13',
    effectiveDate: '2026-07-13',
    sourceUrl: 'https://developers.llamaindex.ai/llamaparse/general/pricing/',
    note: 'Agentic mode with Gemini 2.5 Flash: 10 credits/page; public pay-as-you-go conversion is 1,000 credits for $1.25.',
  },
] as const satisfies readonly BenchmarkRate[];

export type CostUnknownReason =
  | 'not_invoked'
  | 'invalid_provider_reported_cost'
  | 'rate_not_configured'
  | 'usage_not_reported'
  | 'token_usage_incomplete'
  | 'invalid_token_usage'
  | 'provider_cost_not_reported'
  | 'unsupported_service_tier'
  | 'page_usage_not_reported'
  | 'invalid_page_usage';

export interface BenchmarkCostDetail {
  requestedModel: string;
  resolvedModel: string | null;
  serviceTier: string | null;
  pricingBasis: 'provider_reported' | 'tokens' | 'annotated_pages' | null;
  rateCardVersion: string | null;
  rateEffectiveDate: string | null;
  rateSourceUrl: string | null;
  rateNote: string | null;
  billedUsage: {
    promptTokens?: number;
    uncachedPromptTokens?: number;
    cachedTokens?: number;
    cacheWriteTokens?: number;
    cacheWriteOneHourTokens?: number;
    completionTokens?: number;
    pagesProcessed?: number;
    costInUsdTicks?: number;
    costUsd?: number;
    attachmentSearchCalls?: number;
  } | null;
  rates: {
    inputUsdPerMillion?: number;
    cachedInputUsdPerMillion?: number;
    cacheWriteInputMultiplier?: number;
    cacheWriteOneHourInputMultiplier?: number;
    outputUsdPerMillion?: number;
    usdPerPage?: number;
    longContextApplied?: boolean;
    inputMultiplier?: number;
    outputMultiplier?: number;
    tierMultiplier?: number;
  } | null;
  unknownReason: CostUnknownReason | null;
}

export interface BenchmarkCostResult {
  costUsd: number | null;
  costSource: BenchmarkCostSource;
  costDetail: BenchmarkCostDetail;
}

export interface PriceBenchmarkUsageInput {
  provider: string;
  model: string;
  /** Concrete provider-returned model version when the request used an alias. */
  resolvedModel?: string | null;
  invoked: boolean;
  usage?: BenchmarkUsage | null;
  /** Use only when a provider actually returns the request's dollar charge. */
  providerReportedCostUsd?: number | null;
  rateCard?: readonly BenchmarkRate[];
}

function baseCostDetail(input: PriceBenchmarkUsageInput): BenchmarkCostDetail {
  return {
    requestedModel: input.model,
    resolvedModel: input.resolvedModel ?? null,
    serviceTier: input.usage?.serviceTier ?? null,
    pricingBasis: null,
    rateCardVersion: null,
    rateEffectiveDate: null,
    rateSourceUrl: null,
    rateNote: null,
    billedUsage: null,
    rates: null,
    unknownReason: null,
  };
}

function unknownCost(input: PriceBenchmarkUsageInput, reason: CostUnknownReason): BenchmarkCostResult {
  return {
    costUsd: null,
    costSource: 'unknown',
    costDetail: { ...baseCostDetail(input), unknownReason: reason },
  };
}

function reportedUsageDetail(usage: BenchmarkUsage | null | undefined): BenchmarkCostDetail['billedUsage'] {
  if (!usage) return null;
  const detail: NonNullable<BenchmarkCostDetail['billedUsage']> = {};
  if (usage.promptTokens != null) detail.promptTokens = usage.promptTokens;
  if (usage.cachedTokens != null) detail.cachedTokens = usage.cachedTokens;
  if (usage.cacheWriteTokens != null) detail.cacheWriteTokens = usage.cacheWriteTokens;
  if (usage.cacheWriteOneHourTokens != null) detail.cacheWriteOneHourTokens = usage.cacheWriteOneHourTokens;
  if (usage.completionTokens != null) detail.completionTokens = usage.completionTokens;
  if (usage.pagesProcessed != null) detail.pagesProcessed = usage.pagesProcessed;
  if (usage.costInUsdTicks != null) detail.costInUsdTicks = usage.costInUsdTicks;
  if (usage.costUsd != null) detail.costUsd = usage.costUsd;
  if (usage.attachmentSearchCalls != null) detail.attachmentSearchCalls = usage.attachmentSearchCalls;
  return Object.keys(detail).length ? detail : null;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function findRate(input: PriceBenchmarkUsageInput): BenchmarkRate | undefined {
  const rateCard = input.rateCard ?? STANDARD_BENCHMARK_RATE_CARD;
  const provider = input.provider.trim().toLowerCase();
  const models = [input.resolvedModel, input.model].filter((v): v is string => Boolean(v));
  
  const exact = rateCard.find((rate) =>
    rate.provider.toLowerCase() === provider &&
    models.some((model) => (rate.models as readonly string[]).includes(model)),
  );
  if (exact) return exact;

  if (provider === 'openrouter') {
    for (const model of models) {
      const parts = model.split('/');
      if (parts.length > 1) {
        const subProvider = parts[0].toLowerCase();
        const subModel = parts.slice(1).join('/');
        const mappedProvider = subProvider === 'google' ? 'gemini' : subProvider === 'x-ai' ? 'xai' : subProvider;
        const normalizedSubModel = subModel.replace(/\./g, '-');
        
        const subRate = rateCard.find((rate) =>
          rate.provider.toLowerCase() === mappedProvider &&
          (rate.models as readonly string[]).some((m) => m.toLowerCase() === subModel.toLowerCase() || m.toLowerCase() === normalizedSubModel.toLowerCase()),
        );
        if (subRate) {
          return {
            ...subRate,
            provider: 'openrouter',
            models: [model],
          } as any;
        }
      }
    }
  }
  return undefined;
}

/** Price one invoked provider call without inventing missing usage. */
export function priceBenchmarkUsage(input: PriceBenchmarkUsageInput): BenchmarkCostResult {
  if (!input.invoked) return unknownCost(input, 'not_invoked');

  const providerReportedCostUsd = input.providerReportedCostUsd != null
    ? input.providerReportedCostUsd
    : input.usage?.costInUsdTicks != null
      ? input.usage.costInUsdTicks / 10_000_000_000
      : input.usage?.costUsd != null
        ? input.usage.costUsd
        : null;
  if (providerReportedCostUsd != null) {
    if (!finiteNonNegative(providerReportedCostUsd)) {
      return unknownCost(input, 'invalid_provider_reported_cost');
    }
    return {
      costUsd: providerReportedCostUsd,
      costSource: 'provider_reported',
      costDetail: {
        ...baseCostDetail(input),
        pricingBasis: 'provider_reported',
        billedUsage: reportedUsageDetail(input.usage),
      },
    };
  }

  const rate = findRate(input);
  if (!rate) return unknownCost(input, 'rate_not_configured');
  if (!input.usage) return unknownCost(input, 'usage_not_reported');
  if (rate.meter === 'tokens' && rate.requiresProviderReportedCost) {
    return unknownCost(input, 'provider_cost_not_reported');
  }

  const rateDetail = {
    rateCardVersion: rate.version,
    rateEffectiveDate: rate.effectiveDate,
    rateSourceUrl: rate.sourceUrl,
    rateNote: rate.note,
  };

  if (rate.meter === 'tokens') {
    const promptTokens = input.usage.promptTokens;
    const completionTokens = input.usage.completionTokens;
    const cachedTokens = input.usage.cachedTokens ?? 0;
    const cacheWriteTokens = input.usage.cacheWriteTokens ?? 0;
    const cacheWriteOneHourTokens = input.usage.cacheWriteOneHourTokens ?? 0;
    if (promptTokens == null || completionTokens == null) {
      return unknownCost(input, 'token_usage_incomplete');
    }
    if (
      !finiteNonNegative(promptTokens) ||
      !finiteNonNegative(completionTokens) ||
      !finiteNonNegative(cachedTokens) ||
      !finiteNonNegative(cacheWriteTokens) ||
      !finiteNonNegative(cacheWriteOneHourTokens) ||
      cachedTokens + cacheWriteTokens + cacheWriteOneHourTokens > promptTokens
    ) {
      return unknownCost(input, 'invalid_token_usage');
    }
    if (
      input.usage.serviceTier &&
      rate.supportedServiceTiers &&
      !rate.supportedServiceTiers.includes(input.usage.serviceTier)
    ) {
      return unknownCost(input, 'unsupported_service_tier');
    }
    const uncachedPromptTokens = promptTokens - cachedTokens - cacheWriteTokens - cacheWriteOneHourTokens;
    const longContextApplied =
      rate.longContextThresholdTokens != null && promptTokens > rate.longContextThresholdTokens;
    const inputMultiplier = longContextApplied ? (rate.longContextInputMultiplier ?? 1) : 1;
    const outputMultiplier = longContextApplied ? (rate.longContextOutputMultiplier ?? 1) : 1;
    const tierMultiplier = input.usage.serviceTier ? (rate.serviceTierMultipliers?.[input.usage.serviceTier] ?? 1) : 1;
    const costUsd =
      (((uncachedPromptTokens * rate.inputUsdPerMillion +
        cachedTokens * rate.cachedInputUsdPerMillion +
        cacheWriteTokens * rate.inputUsdPerMillion * (rate.cacheWriteInputMultiplier ?? 1) +
        cacheWriteOneHourTokens * rate.inputUsdPerMillion * (rate.cacheWriteOneHourInputMultiplier ?? 1)) * inputMultiplier +
        completionTokens * rate.outputUsdPerMillion * outputMultiplier) * tierMultiplier) /
      1_000_000;
    return {
      costUsd,
      costSource: 'usage_priced',
      costDetail: {
        ...baseCostDetail(input),
        ...rateDetail,
        pricingBasis: 'tokens',
        billedUsage: {
          promptTokens,
          uncachedPromptTokens,
          cachedTokens,
          cacheWriteTokens,
          cacheWriteOneHourTokens,
          completionTokens,
        },
        rates: {
          inputUsdPerMillion: rate.inputUsdPerMillion,
          cachedInputUsdPerMillion: rate.cachedInputUsdPerMillion,
          cacheWriteInputMultiplier: rate.cacheWriteInputMultiplier ?? 1,
          cacheWriteOneHourInputMultiplier: rate.cacheWriteOneHourInputMultiplier ?? 1,
          outputUsdPerMillion: rate.outputUsdPerMillion,
          longContextApplied,
          inputMultiplier,
          outputMultiplier,
          tierMultiplier,
        },
      },
    };
  }

  const pagesProcessed = input.usage.pagesProcessed;
  if (pagesProcessed == null) return unknownCost(input, 'page_usage_not_reported');
  if (!finiteNonNegative(pagesProcessed) || !Number.isInteger(pagesProcessed)) {
    return unknownCost(input, 'invalid_page_usage');
  }
  return {
    costUsd: pagesProcessed * rate.usdPerPage,
    costSource: 'usage_priced',
    costDetail: {
      ...baseCostDetail(input),
      ...rateDetail,
      pricingBasis: 'annotated_pages',
      billedUsage: { pagesProcessed },
      rates: { usdPerPage: rate.usdPerPage },
    },
  };
}

// ---------------------------------------------------------------------------
// A-priori planning estimates (provider-health overlay + backlog autopilot)
// ---------------------------------------------------------------------------

/**
 * Nominal per-document read profile used ONLY for a-priori cost planning
 * (overlay substitution ordering, the 3x cost guard, and autopilot budget
 * reservations). Roughly one small scanned PTR: ~8K input tokens (prompt +
 * PDF pages) and ~2K output tokens, or 4 OCR pages. These are planning
 * constants, not accounting — measured usage is always settled afterwards via
 * priceBenchmarkUsage, which refuses to invent missing usage.
 */
export const NOMINAL_DOC_PROMPT_TOKENS = 8_000;
export const NOMINAL_DOC_COMPLETION_TOKENS = 2_000;
export const NOMINAL_DOC_PAGES = 4;

/**
 * Estimate the rate-card cost of ONE model read of a nominal document.
 * Returns null when the model has no rate-card entry (callers must treat an
 * unpriceable model as ineligible for cost-ranked substitution).
 *
 * Unlike priceBenchmarkUsage, this deliberately ignores
 * `requiresProviderReportedCost` (xAI): this is a planning estimate made
 * before any request exists, so token-only pricing is the best available
 * forecast and is never recorded as an actual cost.
 */
export function estimateNominalReadCostUsd(
  provider: string,
  model: string,
  opts: { pageCount?: number | null; rateCard?: readonly BenchmarkRate[] } = {},
): number | null {
  const rate = findRate({ provider, model, invoked: true, rateCard: opts.rateCard });
  if (!rate) return null;
  if (rate.meter === 'pages') {
    const pages = Math.max(1, Math.round(opts.pageCount ?? NOMINAL_DOC_PAGES));
    return pages * rate.usdPerPage;
  }
  return (
    NOMINAL_DOC_PROMPT_TOKENS * rate.inputUsdPerMillion
    + NOMINAL_DOC_COMPLETION_TOKENS * rate.outputUsdPerMillion
  ) / 1_000_000;
}

export interface CostObservation {
  invoked: boolean;
  costUsd: number | null;
}

export interface BenchmarkCostSummary {
  invokedCalls: number;
  coveredCalls: number;
  coverageRate: number | null;
  knownCostUsd: number;
  /** Null unless every invoked call has a measured/priced cost. */
  totalCostUsd: number | null;
  /** Null unless every invoked call is covered and documentsTested > 0. */
  costPerDocumentUsd: number | null;
}

/** Aggregate call costs while preserving incomplete-coverage truth. */
export function summarizeBenchmarkCosts(
  observations: readonly CostObservation[],
  documentsTested: number,
): BenchmarkCostSummary {
  const invoked = observations.filter((observation) => observation.invoked);
  const covered = invoked.filter((observation) => finiteNonNegative(observation.costUsd));
  const knownCostUsd = covered.reduce((sum, observation) => sum + (observation.costUsd ?? 0), 0);
  const complete = invoked.length > 0 && covered.length === invoked.length;
  return {
    invokedCalls: invoked.length,
    coveredCalls: covered.length,
    coverageRate: invoked.length ? covered.length / invoked.length : null,
    knownCostUsd,
    totalCostUsd: complete ? knownCostUsd : null,
    costPerDocumentUsd:
      complete && Number.isInteger(documentsTested) && documentsTested > 0
        ? knownCostUsd / documentsTested
        : null,
  };
}

export interface LatencyObservation {
  invoked: boolean;
  latencyMs: number | null | undefined;
}

export interface LatencySummary {
  sampleCount: number;
  averageMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  minMs: number | null;
  maxMs: number | null;
}

function nearestRank(sorted: readonly number[], percentile: number): number | null {
  if (!sorted.length) return null;
  const index = Math.max(0, Math.ceil(percentile * sorted.length) - 1);
  return sorted[Math.min(index, sorted.length - 1)];
}

/**
 * End-to-end provider latency across invoked calls, including provider/parse
 * failures. Non-invocations (for example, a missing API key) are excluded.
 */
export function summarizeBenchmarkLatency(observations: readonly LatencyObservation[]): LatencySummary {
  const samples = observations
    .filter((observation) => observation.invoked && finiteNonNegative(observation.latencyMs))
    .map((observation) => observation.latencyMs as number)
    .sort((a, b) => a - b);
  if (!samples.length) {
    return { sampleCount: 0, averageMs: null, p50Ms: null, p95Ms: null, minMs: null, maxMs: null };
  }
  return {
    sampleCount: samples.length,
    averageMs: samples.reduce((sum, sample) => sum + sample, 0) / samples.length,
    p50Ms: nearestRank(samples, 0.5),
    p95Ms: nearestRank(samples, 0.95),
    minMs: samples[0],
    maxMs: samples[samples.length - 1],
  };
}

export interface CascadeModelObservation {
  invoked: boolean;
  latencyMs: number | null | undefined;
  costUsd: number | null;
}

export interface CascadeDocumentMetrics {
  requiredCalls: number;
  invokedCalls: number;
  costCoveredCalls: number;
  knownCostUsd: number;
  costUsd: number | null;
  /** Tier 1 A+B, then fresh tier 2 A+B+C on disagreement (current sequential runtime). */
  wallClockMs: number | null;
}

/**
 * Counterfactual cascade metrics from measured per-document observations.
 * Production currently runs A then B at tier 1. A disagreement creates a fresh
 * queue hop whose tier-2 executor reads A, B, and C sequentially. Persisted benchmark
 * readings are reused as the counterfactual second A/B reads, so escalated cost
 * and wall time are both 2*A + 2*B + C for an escalated document.
 */
export function simulateCascadeDocumentMetrics(input: {
  a: CascadeModelObservation;
  b: CascadeModelObservation;
  c?: CascadeModelObservation | null;
  escalated: boolean;
}): CascadeDocumentMetrics {
  const required: Array<CascadeModelObservation | null> = [input.a, input.b];
  if (input.escalated) required.push(input.a, input.b, input.c ?? null);

  const invoked = required.filter(
    (observation): observation is CascadeModelObservation => Boolean(observation?.invoked),
  );
  const coveredCosts = invoked.filter((observation) => finiteNonNegative(observation.costUsd));
  const knownCostUsd = coveredCosts.reduce((sum, observation) => sum + (observation.costUsd ?? 0), 0);
  const allRequiredInvoked = invoked.length === required.length;
  const costUsd =
    allRequiredInvoked && coveredCosts.length === required.length
      ? knownCostUsd
      : null;

  const aLatency = input.a.invoked && finiteNonNegative(input.a.latencyMs) ? input.a.latencyMs : null;
  const bLatency = input.b.invoked && finiteNonNegative(input.b.latencyMs) ? input.b.latencyMs : null;
  const tier1WallClockMs: number | null =
    aLatency != null && bLatency != null ? aLatency + bLatency : null;
  let wallClockMs = tier1WallClockMs;
  if (input.escalated) {
    const cLatency =
      input.c?.invoked && finiteNonNegative(input.c.latencyMs) ? input.c.latencyMs : null;
    const tier2WallClockMs =
      aLatency != null && bLatency != null && cLatency != null
        ? aLatency + bLatency + cLatency
        : null;
    wallClockMs = tier1WallClockMs != null && tier2WallClockMs != null
      ? tier1WallClockMs + tier2WallClockMs
      : null;
  }

  return {
    requiredCalls: required.length,
    invokedCalls: invoked.length,
    costCoveredCalls: coveredCosts.length,
    knownCostUsd,
    costUsd,
    wallClockMs,
  };
}
