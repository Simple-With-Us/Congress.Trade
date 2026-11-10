import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DD_LLMOBS_DAILY_CAP,
  resetDatadogLlmObsForTests,
  withDatadogLlmObs,
} from '../datadogLlmobs.ts';

afterEach(() => {
  resetDatadogLlmObsForTests();
  delete (globalThis as { _ddtrace?: unknown })._ddtrace;
});

describe('Datadog LLM Observability (CT)', () => {
  it('does not wrap Infisical or price providers', async () => {
    const wrap = vi.fn(async (_opts: unknown, fn: () => Promise<unknown>) => fn());
    (globalThis as { _ddtrace?: { llmobs: { wrap: typeof wrap } } })._ddtrace = { llmobs: { wrap } };
    await withDatadogLlmObs('infisical', undefined, async () => 'ok');
    await withDatadogLlmObs('fmp', 'none', async () => 'ok');
    expect(wrap).not.toHaveBeenCalled();
  });

  it('wraps OpenRouter vision/chat calls', async () => {
    const wrap = vi.fn(async (_opts: unknown, fn: () => Promise<unknown>) => fn());
    (globalThis as { _ddtrace?: { llmobs: { wrap: typeof wrap } } })._ddtrace = { llmobs: { wrap } };
    await expect(withDatadogLlmObs('openrouter', '~google/gemini-flash-latest', async () => 7)).resolves.toBe(7);
    expect(wrap).toHaveBeenCalledOnce();
    expect(wrap.mock.calls[0][0]).toMatchObject({
      kind: 'llm',
      modelProvider: 'openrouter',
      mlApp: 'congress-trade',
    });
  });

  it('honors the daily Free-tier cap', async () => {
    const wrap = vi.fn(async (_opts: unknown, fn: () => Promise<unknown>) => fn());
    (globalThis as { _ddtrace?: { llmobs: { wrap: typeof wrap } } })._ddtrace = { llmobs: { wrap } };
    for (let i = 0; i < DD_LLMOBS_DAILY_CAP + 2; i++) {
      await withDatadogLlmObs('openrouter', 'm', async () => i);
    }
    expect(wrap).toHaveBeenCalledTimes(DD_LLMOBS_DAILY_CAP);
  });
});
