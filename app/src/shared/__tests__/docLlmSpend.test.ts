import { describe, expect, it } from 'vitest';
import type { Env } from '../types.ts';
import {
  DEFAULT_LLM_DOC_USD_CEILING,
  LlmDocBudgetExceededError,
  assertDocLlmSpendAllowed,
  checkDocLlmSpendAllowed,
  docHasExistingTransactions,
  isLlamaParseProvider,
  readDocLlmSpendUsd,
} from '../llmSpend.ts';

function envWith(
  settlements: Array<{ doc_id: string; usd: number; provider?: string }>,
  txDocIds: string[] = [],
  vars: Record<string, string> = {},
): Env {
  return {
    ...vars,
    DB: {
      prepare(sql: string) {
        const self = {
          params: [] as unknown[],
          bind(...params: unknown[]) {
            self.params = params;
            return self;
          },
          async first<T>() {
            if (/SUM\(usd\).*doc_id/i.test(sql)) {
              const docId = String(self.params[0]);
              const usd = settlements
                .filter((s) => s.doc_id === docId)
                .filter((s) => !/llamaparse/i.test(sql) || s.provider !== 'llamaparse')
                .reduce((a, s) => a + s.usd, 0);
              return { usd } as T;
            }
            if (/FROM transactions WHERE doc_id/i.test(sql)) {
              const docId = String(self.params[0]);
              return (txDocIds.includes(docId) ? { ok: 1 } : null) as T | null;
            }
            return null;
          },
        };
        return self;
      },
    },
  } as unknown as Env;
}

describe('per-doc LLM spend gates', () => {
  it('sums lifetime spend by doc_id', async () => {
    const env = envWith([
      { doc_id: 'H-1', usd: 1.2 },
      { doc_id: 'H-1', usd: 0.8 },
      { doc_id: 'H-2', usd: 9 },
    ]);
    expect(await readDocLlmSpendUsd(env, 'H-1')).toBeCloseTo(2.0);
  });

  it('skips when transactions already exist unless reprocess', async () => {
    const env = envWith([], ['H-1']);
    expect(await docHasExistingTransactions(env, 'H-1')).toBe(true);
    const decision = await checkDocLlmSpendAllowed(env, 'H-1');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('already_extracted');
    await expect(assertDocLlmSpendAllowed(env, 'H-1')).rejects.toBeInstanceOf(LlmDocBudgetExceededError);

    const reprocess = await checkDocLlmSpendAllowed(env, 'H-1', { reprocess: true });
    expect(reprocess.allowed).toBe(true);
  });

  it('blocks when per-doc ceiling is exhausted', async () => {
    const env = envWith(
      [{ doc_id: 'H-9', usd: DEFAULT_LLM_DOC_USD_CEILING }],
      [],
    );
    const decision = await checkDocLlmSpendAllowed(env, 'H-9', { reprocess: true });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('doc_ceiling');
  });

  it('stops a live call whose estimate would overshoot the remaining ceiling', async () => {
    const env = envWith(
      [{ doc_id: 'H-9116328', usd: DEFAULT_LLM_DOC_USD_CEILING - 0.01 }],
      [],
    );
    const overshoot = await checkDocLlmSpendAllowed(env, 'H-9116328', {
      reprocess: true,
      estimatedUsd: 0.05,
    });
    expect(overshoot.allowed).toBe(false);
    expect(overshoot.reason).toBe('doc_ceiling');

    const fits = await checkDocLlmSpendAllowed(env, 'H-9116328', {
      reprocess: true,
      estimatedUsd: 0.01,
    });
    expect(fits.allowed).toBe(true);
  });

  it('does not let LlamaParse credits latch the OpenRouter per-doc USD meter', async () => {
    expect(isLlamaParseProvider('llamaparse')).toBe(true);
    const env = envWith(
      [
        { doc_id: 'H-9116328', usd: DEFAULT_LLM_DOC_USD_CEILING, provider: 'openrouter' },
        { doc_id: 'H-9116328', usd: 0.04, provider: 'llamaparse' },
      ],
      [],
    );
    const orCall = await checkDocLlmSpendAllowed(env, 'H-9116328', {
      reprocess: true,
      estimatedUsd: 0.05,
      provider: 'openrouter',
    });
    expect(orCall.allowed).toBe(false);
    expect(orCall.reason).toBe('doc_ceiling');

    const llama = await checkDocLlmSpendAllowed(env, 'H-9116328', {
      reprocess: true,
      estimatedUsd: 0.05,
      provider: 'llamaparse',
    });
    expect(llama.allowed).toBe(true);
    expect(llama.reason).toBe('ok');
  });

  it('excludes LlamaParse settlements from the OpenRouter per-doc USD sum', async () => {
    const env = envWith(
      [
        { doc_id: 'H-1', usd: 0.10, provider: 'openrouter' },
        { doc_id: 'H-1', usd: 0.20, provider: 'llamaparse' },
      ],
      [],
    );
    expect(await readDocLlmSpendUsd(env, 'H-1')).toBeCloseTo(0.30);
    expect(await readDocLlmSpendUsd(env, 'H-1', { excludeLlamaParse: true })).toBeCloseTo(0.10);
    const nextOr = await checkDocLlmSpendAllowed(env, 'H-1', {
      reprocess: true,
      estimatedUsd: 0.10,
      provider: 'openrouter',
    });
    expect(nextOr.allowed).toBe(true);
  });
});
