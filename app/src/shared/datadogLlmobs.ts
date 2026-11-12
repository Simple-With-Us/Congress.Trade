/**
 * Datadog LLM Observability for OpenRouter / Vision HTTP.
 *
 * One LLM span per provider call.  Never records prompt or PDF contents.
 * Daily in-process cap (~1,200) keeps the org under the 40k Free allotment.
 * Fail-soft when dd-trace LLMObs is absent.
 */

const LLM_PROVIDERS = new Set([
  'openrouter',
  'openai',
  'anthropic',
  'xai',
  'google',
  'gemini',
  'mistral',
  'deepseek',
]);

export const DD_LLMOBS_DAILY_CAP = 1_200;
export const DD_LLMOBS_ML_APP = 'congress-trade';

let emittedDay = '';
let emittedCount = 0;

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

export function resetDatadogLlmObsForTests(): void {
  emittedDay = '';
  emittedCount = 0;
}

function underDailyCap(): boolean {
  const today = utcDay();
  if (emittedDay !== today) {
    emittedDay = today;
    emittedCount = 0;
  }
  if (emittedCount >= DD_LLMOBS_DAILY_CAP) return false;
  emittedCount += 1;
  return true;
}

type WrapFn = (opts: Record<string, unknown>, fn: () => Promise<unknown>) => Promise<unknown>;

function loadWrap(): WrapFn | null {
  const tracer = (globalThis as { _ddtrace?: { llmobs?: { wrap?: WrapFn } } })._ddtrace;
  return typeof tracer?.llmobs?.wrap === 'function' ? tracer.llmobs.wrap : null;
}

export async function withDatadogLlmObs<T>(
  provider: string,
  model: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!LLM_PROVIDERS.has(provider)) return fn();
  if (!underDailyCap()) return fn();
  const wrap = loadWrap();
  if (!wrap) return fn();
  try {
    return (await wrap(
      {
        kind: 'llm',
        name: `${provider}.chat`,
        modelName: model || 'unknown',
        modelProvider: provider,
        mlApp: DD_LLMOBS_ML_APP,
      },
      fn,
    )) as T;
  } catch {
    return fn();
  }
}
