/**
 * GOVERNOR 1 integration tests — the ceiling enforced at the provider-call
 * choke point (runCandidateOnDoc) and the no-failover contract in
 * ConfiguredVisionExtractor.
 *
 * Pins the exact "$20 sonnet storm" vector: once today's metered dollars are
 * at the ceiling, (1) runCandidateOnDoc returns a terminal 'llm_budget_exceeded'
 * failure WITHOUT making any network call, and (2) a budget-halted primary is
 * never failed over to another (potentially pricier) model — zero provider
 * HTTP requests happen in either case.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../shared/types.ts';
import { candidateSpendUsd, runCandidateOnDoc, type BakeoffCandidate } from '../bakeoff.ts';
import { ConfiguredVisionExtractor } from '../configuredVision.ts';
import { classifyProviderFailure } from '../providerFailure.ts';
import { LLM_BUDGET_ERROR_MARKER } from '../../shared/llmSpend.ts';
import type { Extractor } from '../../extractors/types.ts';

/** Env whose llm_spend meter reports `spentUsd` for today under 'openrouter'. */
function spendEnv(spentUsd: number, vars: Record<string, string> = {}): Env {
  const prepare = (sql: string) => ({
    params: [] as unknown[],
    bind(...params: unknown[]) {
      this.params = params;
      return this;
    },
    async all() {
      if (/FROM llm_spend/i.test(sql)) {
        return { results: [{ provider: 'openrouter', usd: spentUsd }] };
      }
      return { results: [] };
    },
    async first() {
      return null;
    },
    async run() {
      return { success: true, meta: { changes: 1 } };
    },
  });
  return {
    DB: { prepare } as unknown as D1Database,
    OPENROUTER_API_KEY: 'sk-or-test',
    ...vars,
  } as unknown as Env;
}

const bytes = new TextEncoder().encode('%PDF-1.4 fake').buffer as ArrayBuffer;

afterEach(() => vi.unstubAllGlobals());

describe('runCandidateOnDoc under the USD ceiling governor', () => {
  const candidate: BakeoffCandidate = { provider: 'openrouter', model: 'anthropic/claude-sonnet-5' };

  it('halts fail-closed with failure code llm_budget_exceeded and makes NO provider call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const env = spendEnv(10); // at the default $10 ceiling
    const result = await runCandidateOnDoc(env, candidate, 'H-doc-1', bytes, {
      apiKey: 'sk-or-test',
      skipCache: true,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain(LLM_BUDGET_ERROR_MARKER);
    expect(result.failure?.code).toBe('llm_budget_exceeded');
    expect(result.failure?.retryable).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('lets the call through (and meters its cost) below the ceiling', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ({
          ok: true,
          json: async () => ({
            choices: [{ message: { content: '[{"assetName":"Apple Inc.","ticker":"AAPL","txType": "B","amountRange":"$1,001 - $15,000","isOption":false,"capGainsOver200":false,"confidence":0.9}]' } }],
            usage: { prompt_tokens: 1000, completion_tokens: 100 },
          }),
        }) as unknown as Response,
      ),
    );
    const env = spendEnv(1);
    const result = await runCandidateOnDoc(env, candidate, 'H-doc-1', bytes, {
      apiKey: 'sk-or-test',
      skipCache: true,
    });
    expect(result.ok).toBe(true);
    expect(result.rowCount).toBe(1);
  });
});

describe('candidateSpendUsd pricing', () => {
  it('prefers the provider-reported charge (xAI cost ticks)', () => {
    expect(
      candidateSpendUsd('xai', 'grok-4.3', undefined, { costInUsdTicks: 25_000_000_000 }),
    ).toBeCloseTo(2.5);
  });

  it('falls back to the shared rate card for token usage', () => {
    const usd = candidateSpendUsd('anthropic', 'claude-sonnet-5', undefined, {
      promptTokens: 1_000_000,
      completionTokens: 0,
    });
    expect(usd).not.toBeNull();
    expect(usd!).toBeGreaterThan(0);
  });

  it('returns null (never invents dollars) for unpriceable usage', () => {
    expect(candidateSpendUsd('openrouter', 'made-up/never-a-model', undefined, {
      promptTokens: 10,
      completionTokens: 10,
    })).toBeNull();
    expect(candidateSpendUsd('openrouter', 'openrouter/auto', undefined, undefined)).toBeNull();
  });
});

describe('ConfiguredVisionExtractor: budget halts never fail over', () => {
  const legacy: Extractor = {
    name: 'legacy',
    canHandle: () => true,
    extract: async () => {
      throw new Error('legacy chain must not run when a primary is configured');
    },
  };

  it('stops the cascade on a budget halt — the failover model is never invoked', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const env = spendEnv(10, {
      AGREEMENT_HOUSE_MODEL_A: 'openrouter:openai/gpt-5.6-luna',
      AGREEMENT_HOUSE_MODEL_B: 'openrouter:anthropic/claude-sonnet-5',
    });
    const extractor = new ConfiguredVisionExtractor(env, legacy);
    let caught: Error | null = null;
    try {
      await extractor.extract({
        filing: { docId: 'H-doc-1', docKind: 'scanned_pdf', chamber: 'house' } as never,
        bytes,
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain(LLM_BUDGET_ERROR_MARKER);
    // The terminal budget halt broke the cascade before the failover candidate:
    // its slot reports "no distinct failover" style absence, not a second halt.
    expect(caught!.message).toContain('failover failed (no distinct failover configured)');
    // And crucially: ZERO provider HTTP calls for either candidate.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('classifyProviderFailure: budget error class', () => {
  it('classifies the stable marker as a terminal provider-scoped budget failure', () => {
    const failure = classifyProviderFailure(
      'openrouter',
      'anthropic/claude-sonnet-5',
      `${LLM_BUDGET_ERROR_MARKER} (total): $10.0000 of $10.00 spent today`,
    );
    expect(failure).toMatchObject({
      code: 'llm_budget_exceeded',
      scope: 'provider',
      retryable: false,
    });
  });
});
