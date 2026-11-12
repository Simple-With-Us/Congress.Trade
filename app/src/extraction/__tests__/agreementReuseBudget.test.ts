import { describe, expect, it, afterEach, vi } from 'vitest';
import type { ParsedTx } from '../../shared/types.ts';
import type { CandidateDocResult } from '../bakeoff.ts';
import {
  decideAgreementPublish,
  orderModelsCheapFirst,
  qualityGateAgreementRead,
  resolveAgreedRows,
  sameRowSet,
} from '../agreement.ts';
import { estimateLiveReadCostUsd, runCandidateOnDoc, unaffordableCandidateResult, type BakeoffCandidate } from '../bakeoff.ts';
import { DEFAULT_LLM_DOC_USD_CEILING } from '../../shared/llmSpend.ts';

const DOC = 'H-2026-9116328';

const tx = (over: Partial<ParsedTx> = {}): ParsedTx => ({
  txDate: '2026-06-19',
  owner: 'self',
  assetName: 'Apple Inc.',
  ticker: 'AAPL',
  assetType: 'ST',
  txType: 'B',
  amountMin: 1_001,
  amountMax: 15_000,
  isOption: false,
  capGainsOver200: false,
  rawText: 'AAPL buy',
  confidence: 0.9,
  ...over,
});

function read(
  model: string,
  rows: ParsedTx[],
  extra: Partial<CandidateDocResult> = {},
): CandidateDocResult {
  return {
    provider: 'openrouter',
    model,
    docId: DOC,
    ok: true,
    latencyMs: 0,
    rowCount: rows.length,
    rowKeys: [],
    avgConfidence: rows.reduce((sum, row) => sum + (row.confidence ?? 0), 0) / Math.max(rows.length, 1),
    rows,
    ...extra,
  };
}

describe('orderModelsCheapFirst', () => {
  it('calls cheaper models before expensive ones', () => {
    const grok: BakeoffCandidate = { provider: 'openrouter', model: 'x-ai/grok-4.5' };
    const flash: BakeoffCandidate = { provider: 'openrouter', model: '~google/gemini-flash-latest' };
    const haiku: BakeoffCandidate = { provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' };
    const ordered = orderModelsCheapFirst([grok, flash, haiku]);
    expect(estimateLiveReadCostUsd(ordered[0])).toBeLessThanOrEqual(estimateLiveReadCostUsd(ordered[1]));
    expect(estimateLiveReadCostUsd(ordered[1])).toBeLessThanOrEqual(estimateLiveReadCostUsd(ordered[2]));
    expect(ordered[ordered.length - 1].model).toBe('x-ai/grok-4.5');
  });
});

describe('quality-gated agree-to-publish', () => {
  const lunaRows = Array.from({ length: 3 }, (_, i) => tx({
    ticker: `T${i}`,
    assetName: `Ticker ${i} Inc.`,
  }));
  const flashRows = lunaRows.map((row) => ({ ...row, confidence: 0.8 }));
  const haikuJunk = lunaRows.map((row) => tx({
    ticker: row.ticker,
    assetName: '........................................',
    amountMin: null,
    amountMax: null,
    confidence: 0.99,
  }));

  it('rejects placeholder + null-amount extracts from the quality set', () => {
    expect(qualityGateAgreementRead(read('anthropic/claude-haiku-4.5', haikuJunk))).toBeNull();
    expect(qualityGateAgreementRead(read('openai/gpt-5.6-luna', lunaRows))?.rowCount).toBe(3);
  });

  it('publishes when a stored good extract agrees with a coherent sibling despite haiku junk', () => {
    const decision = decideAgreementPublish(
      [
        read('~google/gemini-flash-latest', flashRows),
        read('anthropic/claude-haiku-4.5', haikuJunk),
      ],
      [read('openai/gpt-5.6-luna', lunaRows)],
      true,
    );
    expect(decision.action).toBe('publish');
    if (decision.action === 'publish') {
      expect(decision.rows).toHaveLength(3);
      expect(decision.qualityModels).toEqual(
        expect.arrayContaining(['openrouter:~google/gemini-flash-latest', 'openrouter:openai/gpt-5.6-luna']),
      );
      expect(decision.qualityModels).not.toContain('openrouter:anthropic/claude-haiku-4.5');
    }
  });

  it('publishes a single stored quality survivor (stored-only evidence, empty lineup)', () => {
    const decision = decideAgreementPublish(
      [],
      [read('openai/gpt-5.6-luna', lunaRows)],
      true,
    );
    expect(decision.action).toBe('publish');
    if (decision.action === 'publish') {
      expect(decision.rows).toHaveLength(3);
      expect(decision.qualityModels).toEqual(['openrouter:openai/gpt-5.6-luna']);
    }
  });

  it('promotes a quality survivor instead of empty human review when later slots miss quota', () => {
    const decision = decideAgreementPublish(
      [
        read('openai/gpt-5.6-luna', lunaRows),
        read('anthropic/claude-haiku-4.5', haikuJunk),
        {
          ...read('x-ai/grok-4.5', []),
          ok: false,
          skippedUnaffordable: true,
          error: 'llm per-doc usd budget exceeded',
        },
      ],
      [],
      true,
    );
    expect(decision.action).toBe('publish');
    if (decision.action === 'publish') {
      expect(decision.rows).toHaveLength(3);
      expect(decision.qualityModels).toEqual(['openrouter:openai/gpt-5.6-luna']);
    }
  });

  it('reuses a prior coherent extract when this batch dies on quota', () => {
    const decision = decideAgreementPublish(
      [
        {
          ...read('anthropic/claude-haiku-4.5', []),
          ok: false,
          skippedUnaffordable: true,
          error: 'llm per-doc usd budget exceeded',
        },
        {
          ...read('x-ai/grok-4.5', []),
          ok: false,
          skippedUnaffordable: true,
          error: 'llm daily usd budget exceeded',
        },
      ],
      [read('openai/gpt-5.6-luna', lunaRows)],
      true,
    );
    expect(decision.action).toBe('publish');
    if (decision.action === 'publish') {
      expect(decision.rows).toHaveLength(3);
      expect(decision.qualityModels).toEqual(['openrouter:openai/gpt-5.6-luna']);
    }
  });

  it('retries a transient sibling failure instead of publishing the lone quality read', () => {
    const decision = decideAgreementPublish(
      [
        read('openai/gpt-5.6-luna', lunaRows),
        {
          ...read('anthropic/claude-sonnet-5', []),
          ok: false,
          error: 'rate limited',
        },
      ],
      [],
      true,
    );
    expect(decision.action).toBe('model_read_failed');
  });

  it('stops on per-doc budget only when no quality extract remains', () => {
    const decision = decideAgreementPublish(
      [
        {
          ...read('x-ai/grok-4.5', []),
          ok: false,
          skippedUnaffordable: true,
          error: 'llm per-doc usd budget exceeded',
        },
      ],
      [],
      true,
    );
    expect(decision.action).toBe('budget_stop');
  });

  it('does not let a high-confidence placeholder row beat a coherent sibling', () => {
    const coherent = tx({ assetName: 'Apple Inc.', confidence: 0.7 });
    const placeholder = tx({
      assetName: '........................................',
      ticker: 'AAPL',
      confidence: 0.99,
    });
    expect(sameRowSet(
      read('openai/gpt-5.6-luna', [coherent]),
      read('anthropic/claude-haiku-4.5', [placeholder, coherent]),
      true,
    )).toBe(true);
    const resolved = resolveAgreedRows([
      read('anthropic/claude-haiku-4.5', [placeholder, coherent]),
      read('openai/gpt-5.6-luna', [coherent]),
    ], true);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].assetName).toBe('Apple Inc.');
  });

  it('flags an all-junk lineup instead of publishing it', () => {
    const decision = decideAgreementPublish(
      [read('anthropic/claude-haiku-4.5', haikuJunk), read('other/junk', haikuJunk)],
      [],
      true,
    );
    expect(decision.action).toBe('junk');
    if (decision.action === 'junk') {
      expect(decision.flags.some((flag) => flag === 'placeholder_asset' || flag === 'null_amount')).toBe(true);
    }
  });
});

describe('runCandidateOnDoc reuses cache before the per-doc ceiling', () => {
  const bytes = new TextEncoder().encode('%PDF-1.4 fake').buffer as ArrayBuffer;
  const candidate: BakeoffCandidate = { provider: 'openai', model: 'gpt-5.6-luna' };
  const cachedRow = tx();

  afterEach(() => vi.unstubAllGlobals());

  it('returns the prior extract without a provider call when the doc ceiling is exhausted', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const env = {
      OPENAI_API_KEY: 'openai-test',
      DB: {
        prepare(sql: string) {
          return {
            bind() {
              return this;
            },
            async first() {
              if (/FROM extraction_runs/i.test(sql)) {
                return { result_json: JSON.stringify([cachedRow]) };
              }
              if (/SUM\(usd\).*doc_id/i.test(sql)) {
                return { usd: DEFAULT_LLM_DOC_USD_CEILING };
              }
              return null;
            },
          };
        },
      },
    } as unknown as import('../../shared/types.ts').Env;

    const result = await runCandidateOnDoc(env, candidate, DOC, bytes);
    expect(result.ok).toBe(true);
    expect(result.cached).toBe(true);
    expect(result.rows).toEqual([cachedRow]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not block the LlamaParse free path behind the OpenRouter per-doc USD latch', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => 'nope',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const env = {
      LLAMAPARSE_API_KEY: 'lp-test',
      DB: {
        prepare(sql: string) {
          return {
            bind() {
              return this;
            },
            async first() {
              if (/SUM\(usd\).*doc_id/i.test(sql)) {
                return { usd: DEFAULT_LLM_DOC_USD_CEILING };
              }
              return null;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      },
    } as unknown as import('../../shared/types.ts').Env;

    const result = await runCandidateOnDoc(
      env,
      { provider: 'llamaparse', model: 'fast' },
      DOC,
      bytes,
      { apiKey: 'lp-test', skipCache: true },
    );
    expect(result.skippedUnaffordable).toBeUndefined();
    expect(fetchMock).toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });

  it('marks daily USD/credit ceiling rejection as skippedUnaffordable', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const env = {
      OPENROUTER_API_KEY: 'sk-or-test',
      LLM_DAILY_USD_CEILING: '0.01',
      DB: {
        prepare(sql: string) {
          return {
            bind() {
              return this;
            },
            async first() {
              if (/SUM\(usd\).*doc_id/i.test(sql)) {
                return { usd: 0 };
              }
              if (/FROM extraction_runs/i.test(sql)) {
                return null;
              }
              return null;
            },
            async all() {
              if (/FROM llm_spend\b/i.test(sql) || /llm_spend_settlement/i.test(sql)) {
                return { results: [{ provider: 'openrouter', usd: 10 }] };
              }
              return { results: [] };
            },
            async run() {
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      },
    } as unknown as import('../../shared/types.ts').Env;

    const result = await runCandidateOnDoc(
      env,
      { provider: 'openrouter', model: 'openai/gpt-5.6-luna' },
      DOC,
      bytes,
      { apiKey: 'sk-or-test', skipCache: true },
    );
    expect(result.ok).toBe(false);
    expect(result.skippedUnaffordable).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('unaffordableCandidateResult sets skippedUnaffordable for callers', () => {
    const result = unaffordableCandidateResult(
      { provider: 'openrouter', model: 'x-ai/grok-4.5' },
      DOC,
      'llm daily usd budget exceeded',
    );
    expect(result.ok).toBe(false);
    expect(result.skippedUnaffordable).toBe(true);
  });

  it('still latches a live OpenRouter call once the per-doc USD ceiling is spent', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const env = {
      OPENROUTER_API_KEY: 'sk-or-test',
      DB: {
        prepare(sql: string) {
          return {
            bind() {
              return this;
            },
            async first() {
              if (/SUM\(usd\).*doc_id/i.test(sql)) {
                return { usd: DEFAULT_LLM_DOC_USD_CEILING };
              }
              return null;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      },
    } as unknown as import('../../shared/types.ts').Env;

    const result = await runCandidateOnDoc(
      env,
      { provider: 'openrouter', model: 'openai/gpt-5.6-luna' },
      DOC,
      bytes,
      { apiKey: 'sk-or-test', skipCache: true },
    );
    expect(result.ok).toBe(false);
    expect(result.skippedUnaffordable).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
