import { describe, it, expect, vi } from 'vitest';
import type { Env } from '../../shared/types.ts';
import type { BakeoffCandidate } from '../bakeoff.ts';
import {
  classifyProviderErrorClass,
  describeAutopilotHaltReason,
  isFalseSourceAuthError,
  isFalseSourceAuthHalt,
  isTransientFilesPrepaidError,
  isTransientFilesPrepaidHalt,
  isTransientInfrastructureHalt,
  summarizeProviderHaltCause,
  healthWindowKey,
  modelBanKey,
  pruneHealthWindow,
  providerModelBanRetryAfter,
  recordProviderHealth,
  selectOverlaySubstitute,
  shouldTripModelBreaker,
  summarizeHealthWindow,
  DEFAULT_HEALTH_THRESHOLDS,
  type ProviderHealthWindow,
} from '../providerHealth.ts';

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

describe('classifyProviderErrorClass', () => {
  it('classifies billing failures (402 / credits / insufficient_quota)', () => {
    expect(classifyProviderErrorClass('openai 402 payment required')).toBe('billing');
    expect(classifyProviderErrorClass('Your prepayment credits are depleted')).toBe('billing');
    expect(classifyProviderErrorClass('insufficient_quota for this request')).toBe('billing');
    expect(classifyProviderErrorClass('credit balance is too low')).toBe('billing');
  });

  it('classifies auth failures (401 / bad key)', () => {
    expect(classifyProviderErrorClass('anthropic 401 unauthorized')).toBe('auth');
    expect(classifyProviderErrorClass('invalid_api_key')).toBe('auth');
    expect(classifyProviderErrorClass('openrouter API key not configured')).toBe('auth');
    expect(classifyProviderErrorClass(
      'openRouterVision: OpenRouter API 401 Unauthorized {"error":{"message":"User not found.","code":401}}',
    )).toBe('auth');
    expect(classifyProviderErrorClass(
      'openRouterText: OpenRouter API 401 Unauthorized',
    )).toBe('other');
    expect(classifyProviderErrorClass(
      'openRouterText: OpenRouter API 401 Unauthorized {"error":{"message":"Unauthorized","code":401}}',
    )).toBe('other');
    expect(classifyProviderErrorClass(
      'openRouterReply:unauth_reply: 401 Unauthorized',
    )).toBe('other');
    expect(classifyProviderErrorClass(
      'openRouterVision: could not parse model JSON: Unexpected token <',
    )).toBe('other');
  });

  it('does not treat source-fetch or admin Unauthorized as a dead LLM key', () => {
    expect(classifyProviderErrorClass('Unauthorized')).toBe('other');
    expect(classifyProviderErrorClass('fetcher: Unauthorized')).toBe('other');
    expect(classifyProviderErrorClass('Unauthorized — paste your admin token in the Admin tab access box.')).toBe('other');
    expect(classifyProviderErrorClass('house live search -> HTTP 401')).toBe('other');
    expect(classifyProviderErrorClass('admin 401 unauthorized')).toBe('other');
    expect(classifyProviderErrorClass('filing.extracted HTTP 401')).toBe('other');
    expect(isFalseSourceAuthError('Unauthorized')).toBe(true);
    expect(isFalseSourceAuthError('fetcher: Unauthorized')).toBe(true);
    expect(isFalseSourceAuthError('invalid_api_key')).toBe(false);
    expect(isFalseSourceAuthHalt('error_class:auth', { auth: 'Unauthorized' })).toBe(true);
    expect(isFalseSourceAuthHalt('error_class:auth', { auth: 'invalid_api_key' })).toBe(false);
    expect(isFalseSourceAuthHalt('error_class:auth', {
      auth: 'openRouterVision: OpenRouter API 401 Unauthorized {"error":{"message":"User not found.","code":401}}',
    })).toBe(false);
    expect(summarizeProviderHaltCause('Unauthorized')).toContain('source-fetch or admin unauthorized');
  });

  it('classifies rate-limit as rate_limit, not quota', () => {
    expect(classifyProviderErrorClass('gemini 429 too many requests')).toBe('rate_limit');
    expect(classifyProviderErrorClass('provider rate-limit hit, slow down')).toBe('rate_limit');
  });

  it('does not treat stale circuit wrappers or transient 403 as quota', () => {
    expect(classifyProviderErrorClass(
      'openrouter key budget circuit open: cool-down 3067s (last: HTTP 402 {"error":{"message":"This request requires at least $0.50 in balance for files","code":402}})',
    )).toBe('billing');
    expect(classifyProviderErrorClass('openrouter key budget circuit open: cool-down 3600s')).toBe('other');
    expect(classifyProviderErrorClass('senate GET /search/ -> HTTP 403')).toBe('other');
    expect(classifyProviderErrorClass('openrouter 403 forbidden')).toBe('other');
    expect(classifyProviderErrorClass('llm skip: doc already has transactions (H-2024-1)')).toBe('other');
  });

  it('keeps real app-budget and usage-limit failures as quota', () => {
    expect(classifyProviderErrorClass('llm daily usd budget exceeded')).toBe('quota');
    expect(classifyProviderErrorClass('account usage limit reached')).toBe('quota');
  });

  it('describes a stored quota halt from the 402 files-balance sample', () => {
    const sample = {
      quota: 'openrouter key budget circuit open: cool-down 3067s (last: HTTP 402 {"error":{"message":"This request requires at least $0.50 in balance for files","code":402}})',
    };
    expect(describeAutopilotHaltReason('error_class:quota', sample)).toContain('error_class:billing');
    expect(describeAutopilotHaltReason('error_class:quota', sample)).toContain('stored as quota');
    expect(describeAutopilotHaltReason('error_class:quota', sample)).toContain('files-endpoint prepaid');
    expect(summarizeProviderHaltCause(sample.quota)).toContain('files-endpoint prepaid');
    expect(isTransientFilesPrepaidError(sample.quota)).toBe(true);
    expect(isTransientFilesPrepaidHalt('error_class:quota', sample)).toBe(true);
    expect(isTransientFilesPrepaidHalt('error_class:auth', { auth: 'invalid_api_key' })).toBe(false);
    expect(isTransientFilesPrepaidError('openrouter key budget circuit open: cool-down 3600s')).toBe(false);
    expect(isTransientFilesPrepaidError('Your prepayment credits are depleted')).toBe(false);
  });

  it('classifies timeouts and parse failures', () => {
    expect(classifyProviderErrorClass('request timed out after 120000ms')).toBe('timeout');
    expect(classifyProviderErrorClass('The operation was aborted')).toBe('timeout');
    expect(classifyProviderErrorClass('SQLITE_BUSY: database is locked')).toBe('other');
    expect(classifyProviderErrorClass('Deno cron tick exceeded 45000ms deadline')).toBe('other');
    expect(classifyProviderErrorClass('scheduled tick aborted')).toBe('other');
    expect(classifyProviderErrorClass('could not parse model JSON: unexpected token')).toBe('parse');
    expect(classifyProviderErrorClass('openai: empty completion')).toBe('parse');
  });

  it('auto-resumes only infrastructure halts, not a real provider timeout', () => {
    expect(isTransientInfrastructureHalt('error_class:timeout', {
      lock: 'SQLITE_BUSY: database is locked',
    })).toBe(true);
    expect(isTransientInfrastructureHalt('error_class:timeout', {
      provider: 'request timed out after 120000ms',
    })).toBe(false);
    expect(isTransientInfrastructureHalt('error_class:timeout', {
      lock: 'SQLITE_BUSY: database is locked',
      provider: 'request timed out after 120000ms',
    })).toBe(false);
  });

  it('returns other for unknown failures and null for no error', () => {
    expect(classifyProviderErrorClass('some novel provider explosion')).toBe('other');
    expect(classifyProviderErrorClass(null)).toBeNull();
    expect(classifyProviderErrorClass('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Health-window transitions
// ---------------------------------------------------------------------------

const T0 = 1_000_000_000_000;
const bill = (t: number) => ({ t, ok: false, cls: 'billing' as const });
const okAt = (t: number) => ({ t, ok: true });

describe('health window transitions', () => {
  it('prunes events outside the rolling window', () => {
    const window: ProviderHealthWindow = {
      events: [bill(T0 - 16 * 60_000), bill(T0 - 60_000), okAt(T0)],
    };
    const pruned = pruneHealthWindow(window, T0, 15 * 60_000);
    expect(pruned.events).toHaveLength(2);
    expect(pruned.events[0].t).toBe(T0 - 60_000);
  });

  it('summarizes attempts, failure rate, and consecutive billing/auth failures', () => {
    const summary = summarizeHealthWindow({
      events: [okAt(T0 - 4), bill(T0 - 3), bill(T0 - 2), bill(T0 - 1)],
    });
    expect(summary.attempts).toBe(4);
    expect(summary.failures).toBe(3);
    expect(summary.failureRate).toBeCloseTo(0.75);
    expect(summary.consecutiveBreakerFailures).toBe(3);
    expect(summary.byClass.billing).toBe(3);
  });

  it('resets the consecutive counter on success or a non-breaker class', () => {
    const afterSuccess = summarizeHealthWindow({
      events: [bill(T0 - 3), bill(T0 - 2), okAt(T0 - 1), bill(T0)],
    });
    expect(afterSuccess.consecutiveBreakerFailures).toBe(1);
    const afterQuota = summarizeHealthWindow({
      events: [bill(T0 - 2), { t: T0 - 1, ok: false, cls: 'quota' }, bill(T0)],
    });
    expect(afterQuota.consecutiveBreakerFailures).toBe(1);
  });

  it('trips on the consecutive rule and on the windowed-rate rule only', () => {
    const consecutive = summarizeHealthWindow({
      events: [bill(T0 - 5), bill(T0 - 4), bill(T0 - 3), bill(T0 - 2), bill(T0 - 1)],
    });
    expect(shouldTripModelBreaker(consecutive, DEFAULT_HEALTH_THRESHOLDS)).toBe(true);

    // 4 billing failures out of 5 attempts = 80% with min samples met.
    const rate = summarizeHealthWindow({
      events: [okAt(T0 - 5), bill(T0 - 4), bill(T0 - 3), bill(T0 - 2), bill(T0 - 1)],
    });
    expect(rate.consecutiveBreakerFailures).toBe(4);
    expect(shouldTripModelBreaker(rate, DEFAULT_HEALTH_THRESHOLDS)).toBe(true);

    // Below both thresholds: no trip.
    const healthy = summarizeHealthWindow({
      events: [okAt(T0 - 3), okAt(T0 - 2), bill(T0 - 1)],
    });
    expect(shouldTripModelBreaker(healthy, DEFAULT_HEALTH_THRESHOLDS)).toBe(false);
  });

  it('never trips on quota/parse/timeout failures alone', () => {
    const quotaStorm = summarizeHealthWindow({
      events: Array.from({ length: 8 }, (_, i) => ({ t: T0 - i, ok: false, cls: 'quota' as const })),
    });
    expect(shouldTripModelBreaker(quotaStorm, DEFAULT_HEALTH_THRESHOLDS)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// recordProviderHealth + the per-model breaker (mock KV)
// ---------------------------------------------------------------------------

function kvEnv(): { env: Env; store: Map<string, string> } {
  const store = new Map<string, string>();
  const env = {
    CONFIG_KV: {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
    },
  } as unknown as Env;
  return { env, store };
}

const knobs = {
  ...DEFAULT_HEALTH_THRESHOLDS,
  overlayEnabled: true,
  costRatioLimit: 3,
  modelBanTtlSeconds: 3600,
};

const candidate = { provider: 'openrouter', model: 'openai/gpt-5.6-luna' };

describe('recordProviderHealth', () => {
  it('opens the per-model breaker after 5 consecutive billing failures', async () => {
    const { env, store } = kvEnv();
    let tripped = false;
    for (let i = 0; i < 5; i++) {
      const result = await recordProviderHealth(
        env, candidate, false, 'openrouter 402 payment required', knobs, T0 + i,
      );
      tripped = result?.tripped ?? false;
    }
    expect(tripped).toBe(true);
    expect(store.has(modelBanKey(candidate))).toBe(true);
    expect(store.has(healthWindowKey(candidate))).toBe(true);
    // The ban is scoped to the concrete provider:model, not the provider.
    expect(store.has('provider_ban:openrouter')).toBe(false);
    // recordProviderHealth wrote the ban relative to the injected T0 clock
    // (not wall-clock Date.now()), so the read must use the same clock.
    const retryAfter = await providerModelBanRetryAfter(env, candidate, T0 + 4);
    expect(retryAfter).toBeGreaterThan(0);
  });

  it('does not trip below the threshold or for quota errors', async () => {
    const { env, store } = kvEnv();
    for (let i = 0; i < 4; i++) {
      await recordProviderHealth(env, candidate, false, '402 payment required', knobs, T0 + i);
    }
    expect(store.has(modelBanKey(candidate))).toBe(false);
    for (let i = 0; i < 10; i++) {
      await recordProviderHealth(env, candidate, false, '429 too many requests', knobs, T0 + 10 + i);
    }
    expect(store.has(modelBanKey(candidate))).toBe(false);
  });

  it('successes reset the consecutive count and dilute the window rate', async () => {
    const { env, store } = kvEnv();
    // 4 billing failures, 2 successes, 1 more failure: consecutive = 1 and the
    // window rate is 5/7 ≈ 71% — below both thresholds, breaker stays closed.
    for (let i = 0; i < 4; i++) {
      await recordProviderHealth(env, candidate, false, '402 payment required', knobs, T0 + i);
    }
    await recordProviderHealth(env, candidate, true, null, knobs, T0 + 4);
    await recordProviderHealth(env, candidate, true, null, knobs, T0 + 5);
    await recordProviderHealth(env, candidate, false, '402 payment required', knobs, T0 + 6);
    expect(store.has(modelBanKey(candidate))).toBe(false);
  });

  it('is best-effort: a missing KV binding returns null without throwing', async () => {
    const result = await recordProviderHealth({} as Env, candidate, false, '402', knobs);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Overlay substitution + cost guard
// ---------------------------------------------------------------------------

describe('selectOverlaySubstitute', () => {
  const deps = {
    keyChecker: vi.fn(async () => 'configured-key'),
    banChecker: vi.fn(async () => false),
  };

  it('picks the cheapest healthy rate-card-priced candidate from the catalog', async () => {
    const { env } = kvEnv();
    const substitute = await selectOverlaySubstitute(
      env,
      { provider: 'openai', model: 'gpt-5.6-terra' },
      { excludeLabels: ['openai:gpt-5.6-terra', 'anthropic:claude-sonnet-5'], deps },
    );
    // Cheapest offered candidate with a rate-card entry:
    // openrouter:amazon/nova-lite-v1 at (8K*0.06 + 2K*0.24)/1M = $0.00096.
    expect(substitute).not.toBeNull();
    expect(substitute!.candidate).toEqual({ provider: 'openrouter', model: 'amazon/nova-lite-v1' });
    expect(substitute!.nominalCostUsd).toBeCloseTo(0.00096, 6);
    // Far cheaper than the configured slot → not cost-flagged.
    expect(substitute!.configuredCostUsd).toBeCloseTo(0.05, 6);
    expect(substitute!.flagged).toBe(false);
  });

  it('flags a substitute that costs more than the ratio limit', async () => {
    const { env } = kvEnv();
    // Configured slot is the ultra-cheap OpenRouter mistral-ocr page rate
    // ($0.008 nominal); every token-priced substitute exceeds 3x that.
    const substitute = await selectOverlaySubstitute(
      env,
      { provider: 'openrouter', model: 'mistral/mistral-ocr-latest' },
      { excludeLabels: ['openrouter:mistral/mistral-ocr-latest'], deps },
    );
    expect(substitute).not.toBeNull();
    expect(substitute!.costRatio).not.toBeNull();
    if ((substitute!.costRatio ?? 0) > 3) {
      expect(substitute!.flagged).toBe(true);
    }
  });

  it('never selects a >3x substitute silently (this week: cheap primary -> sonnet-5 burn)', async () => {
    const { env } = kvEnv();
    // Restrict the catalog so ONLY an expensive frontier model is available.
    const substitute = await selectOverlaySubstitute(
      env,
      { provider: 'openrouter', model: 'mistral/mistral-ocr-latest' },
      {
        excludeLabels: ['openrouter:mistral/mistral-ocr-latest'],
        deps: {
          ...deps,
          catalog: [{ provider: 'openrouter', model: 'anthropic/claude-sonnet-5' }],
        },
      },
    );
    expect(substitute).not.toBeNull();
    expect(substitute!.candidate.model).toBe('anthropic/claude-sonnet-5');
    // ~$0.036 vs $0.008 → ratio > 3 → must be flagged for the audit trail.
    expect(substitute!.costRatio).toBeGreaterThan(3);
    expect(substitute!.flagged).toBe(true);
  });

  it('respects underlying-provider exclusions and open breakers', async () => {
    const { env } = kvEnv();
    const substitute = await selectOverlaySubstitute(
      env,
      { provider: 'openai', model: 'gpt-5.6-terra' },
      {
        excludeLabels: [],
        excludeUnderlyingProviders: ['qwen'],
        deps: {
          ...deps,
          banChecker: vi.fn(
            async (_env: Env, c: BakeoffCandidate) => c.model === 'mistral/mistral-ocr-latest',
          ),
        },
      },
    );
    // qwen excluded (other slot's vendor), mistral-ocr banned → next cheapest.
    expect(substitute).not.toBeNull();
    expect(substitute!.candidate.model).not.toBe('qwen/qwen-2.5-72b-instruct');
    expect(substitute!.candidate.model).not.toBe('mistral/mistral-ocr-latest');
  });

  it('returns null when no credentialed candidate exists', async () => {
    const { env } = kvEnv();
    const substitute = await selectOverlaySubstitute(
      env,
      { provider: 'openai', model: 'gpt-5.6-terra' },
      { deps: { ...deps, keyChecker: vi.fn(async () => null) } },
    );
    expect(substitute).toBeNull();
  });
});
