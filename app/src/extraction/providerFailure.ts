/**
 * Stable, secret-safe provider failure categories used by durable benchmarks.
 *
 * Only failures that deterministically block another request are classified.
 * Transient rate limits, transport failures, parse errors, refusals, and
 * document-specific invalid requests intentionally return null so a benchmark
 * run does not suppress potentially valid reads.
 *
 * Example of a document-specific case that stays unclassified on purpose:
 * `anthropic: invalid PDF (unparseable by pdf-lib)` (see
 * `validatePdfForAnthropic` in visionLlm.ts) — the message is stable and
 * deterministic for that one document's bytes, but it says nothing about
 * whether the provider/model will reject the NEXT document, so it must not
 * become a provider- or model-scoped block the way an auth/quota failure does.
 */

export type ProviderFailureCode =
  | 'provider_not_configured'
  | 'provider_authentication_failed'
  | 'model_access_denied'
  | 'provider_credits_depleted'
  | 'provider_usage_limit'
  /** Error-class 'budget': the app's own daily LLM USD ceiling halted the
   *  call BEFORE spending (shared/llmSpend.ts). Terminal for the attempt and
   *  never a failover trigger — the whole point is that no pricier model may
   *  be invoked once the ceiling is reached. */
  | 'llm_budget_exceeded'
  /** A paid response could not be durably receipted. Terminal: failover would
   *  spend again while the hard meter is known incomplete. */
  | 'llm_spend_settlement_failed';

export type ProviderFailureScope = 'provider' | 'model';

export interface ProviderFailureStatus {
  code: ProviderFailureCode;
  scope: ProviderFailureScope;
  retryable: false;
  message: string;
  retryAt?: string;
}

export interface ProviderFailureSource {
  provider: string;
  model: string;
  docId: string;
}

export interface ProviderFailureBlock {
  failure: ProviderFailureStatus;
  source: ProviderFailureSource;
}

export interface BenchmarkCanaryTarget extends ProviderFailureSource {
  scope: 'provider' | 'model';
}

interface ProviderResultLike extends ProviderFailureSource {
  invoked: boolean;
  ok: boolean;
  outcome: string | null;
  error: string | null;
  result?: unknown;
}

interface BenchmarkDocumentLike {
  docId: string;
  ordinal: number;
}

interface BenchmarkModelLike {
  provider: string;
  model: string;
}

function retryAtFromMessage(message: string): string | undefined {
  const match = message.match(
    /regain access on (\d{4}-\d{2}-\d{2}) at (\d{2}):(\d{2})(?::(\d{2}))? UTC/i,
  );
  if (!match) return undefined;
  return `${match[1]}T${match[2]}:${match[3]}:${match[4] ?? '00'}.000Z`;
}

/** Classify a raw adapter error without retaining provider request/project ids. */
export function classifyProviderFailure(
  provider: string,
  model: string,
  error: string | null | undefined,
): ProviderFailureStatus | null {
  const message = (error ?? '').trim();
  if (!message) return null;
  const lower = message.toLowerCase();

  // Matches LLM_BUDGET_ERROR_MARKER / LLM_DOC_BUDGET_ERROR_MARKER in
  // shared/llmSpend.ts (kept literal here so this module stays dependency-free
  // for the benchmark decode path). Per-doc already-extracted skips stay
  // unclassified (document-specific, not a provider outage).
  if (
    lower.includes('llm daily usd budget exceeded')
    || lower.includes('llm per-doc usd budget exceeded')
  ) {
    return {
      code: 'llm_budget_exceeded',
      scope: 'provider',
      retryable: false,
      message: `${provider} calls are halted: an app LLM USD budget is exhausted.`,
    };
  }

  if (lower.includes('llm spend settlement failed')) {
    return {
      code: 'llm_spend_settlement_failed',
      scope: 'provider',
      retryable: false,
      message: `${provider} calls are halted: paid-response accounting is unavailable.`,
    };
  }

  if (lower.includes('api key not configured')) {
    return {
      code: 'provider_not_configured',
      scope: 'provider',
      retryable: false,
      message: `${provider} is not configured for this benchmark run.`,
    };
  }

  if (
    lower.includes('model_not_found')
    || lower.includes('does not have access to model')
    || lower.includes('model is not available for this project')
  ) {
    return {
      code: 'model_access_denied',
      scope: 'model',
      retryable: false,
      message: `The current ${provider} project does not have access to ${model}.`,
    };
  }

  if (
    lower.includes('prepayment credits are depleted')
    || lower.includes('insufficient_quota')
    || lower.includes('billing hard limit')
    || lower.includes('credit balance is too low')
    || lower.includes('budget limit')
    || lower.includes('api key budget')
    || lower.includes('key budget')
    || lower.includes('weekly limit')
  ) {
    return {
      code: 'provider_credits_depleted',
      scope: 'provider',
      retryable: false,
      message: `${provider} credits are depleted for the current account.`,
    };
  }

  if (
    lower.includes('reached your specified api usage limits')
    || lower.includes('account usage limit')
    || lower.includes('monthly usage limit')
    || lower.includes('key limit exceeded')
    || lower.includes('exceeded your monthly')
  ) {
    const retryAt = retryAtFromMessage(message);
    return {
      code: 'provider_usage_limit',
      scope: 'provider',
      retryable: false,
      message: `${provider} rejected the request because the account usage limit was reached.`,
      ...(retryAt ? { retryAt } : {}),
    };
  }

  if (
    /\b401\b/.test(lower)
    || (/\b403\b/.test(lower) && !lower.includes('budget'))
    || lower.includes('forbidden')
    || lower.includes('invalid_api_key')
    || lower.includes('invalid api key')
    || lower.includes('authentication_error')
    || lower.includes('authentication failed')
  ) {
    return {
      code: 'provider_authentication_failed',
      scope: 'provider',
      retryable: false,
      message: `${provider} rejected the configured credential.`,
    };
  }

  return null;
}

function storedFailure(result: ProviderResultLike): ProviderFailureStatus | null {
  const failure = result.result && typeof result.result === 'object'
    ? (result.result as { failure?: unknown }).failure
    : null;
  if (failure && typeof failure === 'object') {
    const value = failure as Partial<ProviderFailureStatus>;
    if (
      typeof value.code === 'string'
      && (value.scope === 'provider' || value.scope === 'model')
      && value.retryable === false
      && typeof value.message === 'string'
    ) {
      return value as ProviderFailureStatus;
    }
  }
  return classifyProviderFailure(result.provider, result.model, result.error);
}

/** Find a terminal failure that blocks this exact model or its whole provider. */
export function findProviderFailureBlock(
  results: readonly ProviderResultLike[],
  candidate: BenchmarkModelLike,
): ProviderFailureBlock | null {
  for (const result of results) {
    if (result.ok || result.outcome === 'running') continue;
    const failure = storedFailure(result);
    if (!failure) continue;
    const matches = failure.scope === 'provider'
      ? result.provider === candidate.provider
      : result.provider === candidate.provider && result.model === candidate.model;
    if (matches) {
      return {
        failure,
        source: {
          provider: result.provider,
          model: result.model,
          docId: result.docId,
        },
      };
    }
  }
  return null;
}

/**
 * Gate a model's first provider-invoked document as a canary. A local document
 * failure does not prove provider admission, so the canary advances to the next
 * document instead of releasing the rest of the chunk concurrently.
 */
export function benchmarkCanaryTarget(
  documents: readonly BenchmarkDocumentLike[],
  results: readonly ProviderResultLike[],
  models: readonly BenchmarkModelLike[],
  candidate: BenchmarkModelLike,
): BenchmarkCanaryTarget | null {
  const orderedDocuments = [...documents].sort((a, b) => a.ordinal - b.ordinal);
  const hasInvokedTerminalReading = (model: BenchmarkModelLike): boolean => results.some((result) =>
    result.provider === model.provider
    && result.model === model.model
    && result.invoked
    && result.outcome !== 'running');
  const nextCanaryDocument = (model: BenchmarkModelLike): BenchmarkDocumentLike | undefined =>
    orderedDocuments.find((document) => {
      const reading = results.find((result) =>
        result.docId === document.docId
        && result.provider === model.provider
        && result.model === model.model);
      return !reading || reading.outcome === 'running' || reading.invoked;
    });

  const providerHasInvokedTerminalReading = results.some((result) =>
    result.provider === candidate.provider
    && result.invoked
    && result.outcome !== 'running');
  if (!providerHasInvokedTerminalReading) {
    const providerCanary = models.find((model) => model.provider === candidate.provider) ?? candidate;
    const document = nextCanaryDocument(providerCanary);
    if (!document) return null;
    return {
      provider: providerCanary.provider,
      model: providerCanary.model,
      docId: document.docId,
      scope: 'provider',
    };
  }

  if (hasInvokedTerminalReading(candidate)) return null;
  const document = nextCanaryDocument(candidate);
  if (!document) return null;
  return {
    provider: candidate.provider,
    model: candidate.model,
    docId: document.docId,
    scope: 'model',
  };
}

/** Select every model blocked by a provider failure, or only the failed model. */
export function modelsAffectedByProviderFailure(
  models: readonly BenchmarkModelLike[],
  candidate: BenchmarkModelLike,
  failure: ProviderFailureStatus,
): BenchmarkModelLike[] {
  return models.filter((model) => failure.scope === 'provider'
    ? model.provider === candidate.provider
    : model.provider === candidate.provider && model.model === candidate.model);
}
