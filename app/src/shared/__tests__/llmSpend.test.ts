/**
 * GOVERNOR 1 unit tests — the daily LLM USD ceiling meter.
 *
 * Pins the fail-closed contract: at/over the global ceiling (default $10) or a
 * per-provider sub-ceiling every further call is denied with error-class
 * 'budget'; below it calls pass; a broken meter fails OPEN (a D1 blip must not
 * take extraction down, and spend cannot accrue without the same D1 anyway).
 */
import { describe, expect, it } from 'vitest';
import type { Env } from '../types.ts';
import {
  DEFAULT_LLM_DAILY_USD_CEILING,
  LlmBudgetExceededError,
  assertLlmSpendWithinCeiling,
  checkLlmSpendCeiling,
  isLlmBudgetHalt,
  llmBudgetHaltMessage,
  readLlmSpend,
  LlmSpendSettlementError,
  settleLlmSpend,
} from '../llmSpend.ts';

interface SpendRow {
  provider: string;
  usd: number;
}

interface SettlementRow extends SpendRow {
  settlementId: string;
  providerResponseId: string | null;
  receiptHash: string;
  day: string;
}

/** In-memory llm_spend table keyed by day, mimicking the atomic upsert. */
function spendEnv(rows: SpendRow[], vars: Record<string, string> = {}): {
  env: Env;
  rows: SpendRow[];
  settlements: SettlementRow[];
  failures: { reads: boolean; writes: boolean };
} {
  const failures = { reads: false, writes: false };
  const settlements: SettlementRow[] = [];
  const prepare = (sql: string) => ({
    params: [] as unknown[],
    bind(...params: unknown[]) {
      this.params = params;
      return this;
    },
    async all() {
      if (failures.reads) throw new Error('D1 unavailable');
      if (/FROM llm_spend_settlement_totals/i.test(sql)) {
        const day = String(this.params[0]);
        const totals = new Map<string, number>();
        for (const row of settlements.filter((candidate) => candidate.day === day)) {
          totals.set(row.provider, (totals.get(row.provider) ?? 0) + row.usd);
        }
        return {
          results: Array.from(totals, ([provider, usd]) => ({ provider, usd })),
        };
      }
      if (/FROM llm_spend_settlements/i.test(sql)) {
        const day = String(this.params[0]);
        return { results: settlements.filter((r) => r.day === day).map((r) => ({ ...r })) };
      }
      if (/FROM llm_spend\s+WHERE/i.test(sql)) return { results: rows.map((r) => ({ ...r })) };
      return { results: [] };
    },
    async run() {
      if (failures.writes) throw new Error('D1 unavailable');
      if (/INSERT OR IGNORE INTO llm_spend_settlements/i.test(sql)) {
        // Pre-0077: 12 binds (…, doc_id, usd, receipt_hash, created_at)
        // Post-0077: 13 binds (…, doc_id, purpose, usd, receipt_hash, created_at)
        const p = this.params as unknown[];
        const settlementId = p[0] as string;
        const provider = p[1] as string;
        const providerResponseId = p[2] as string | null;
        const day = p[4] as string;
        const hasPurpose = p.length >= 13 || /purpose/i.test(sql);
        const usd = (hasPurpose ? p[10] : p[9]) as number;
        const receiptHash = (hasPurpose ? p[11] : p[10]) as string;
        const existing = settlements.find((row) =>
          row.settlementId === settlementId
          || (providerResponseId !== null
            && row.provider === provider
            && row.providerResponseId === providerResponseId));
        if (existing) return { success: true, meta: { changes: 0 } };
        settlements.push({ settlementId, provider, providerResponseId, day, usd, receiptHash });
        return { success: true, meta: { changes: 1 } };
      }
      return { success: true, meta: { changes: 1 } };
    },
    async first() {
      if (/SELECT receipt_hash FROM llm_spend_settlements/i.test(sql)) {
        const [settlementId, providerResponseId, provider] = this.params as [string, string | null, string, string | null];
        const existing = settlements.find((row) =>
          row.settlementId === settlementId
          || (providerResponseId !== null
            && row.provider === provider
            && row.providerResponseId === providerResponseId));
        return existing ? { receipt_hash: existing.receiptHash } : null;
      }
      return null;
    },
  });
  const env = { DB: { prepare } as unknown as D1Database, ...vars } as unknown as Env;
  return { env, rows, settlements, failures };
}

describe('checkLlmSpendCeiling', () => {
  it('allows spend below the default $10 global ceiling', async () => {
    const { env } = spendEnv([{ provider: 'openrouter', usd: 9.99 }]);
    const decision = await checkLlmSpendCeiling(env, 'openrouter');
    expect(decision.allowed).toBe(true);
    expect(decision.ceilingUsd).toBe(DEFAULT_LLM_DAILY_USD_CEILING);
  });

  it('fails closed at the global ceiling — for EVERY provider, so no failover to a pricier model can spend', async () => {
    const { env } = spendEnv([{ provider: 'openrouter', usd: 10 }]);
    const primary = await checkLlmSpendCeiling(env, 'openrouter');
    expect(primary.allowed).toBe(false);
    expect(primary.scope).toBe('total');
    // The would-be failover provider is equally halted: the ceiling is global.
    const failover = await checkLlmSpendCeiling(env, 'anthropic');
    expect(failover.allowed).toBe(false);
    expect(failover.scope).toBe('total');
  });

  it('honors a configured global ceiling override', async () => {
    const { env } = spendEnv(
      [{ provider: 'openrouter', usd: 3 }],
      { LLM_DAILY_USD_CEILING: '2.50' },
    );
    const decision = await checkLlmSpendCeiling(env, 'openrouter');
    expect(decision.allowed).toBe(false);
    expect(decision.ceilingUsd).toBe(2.5);
  });

  it('enforces a per-provider sub-ceiling without blocking other providers', async () => {
    const { env } = spendEnv(
      [{ provider: 'openrouter', usd: 4 }],
      { LLM_DAILY_USD_CEILING_OPENROUTER: '4' },
    );
    const blocked = await checkLlmSpendCeiling(env, 'openrouter');
    expect(blocked.allowed).toBe(false);
    expect(blocked.scope).toBe('provider');
    expect(blocked.ceilingUsd).toBe(4);
    const other = await checkLlmSpendCeiling(env, 'mistral');
    expect(other.allowed).toBe(true);
  });

  it('fails open when the meter is unreadable', async () => {
    const { env, failures } = spendEnv([{ provider: 'openrouter', usd: 999 }]);
    failures.reads = true;
    const decision = await checkLlmSpendCeiling(env, 'openrouter');
    expect(decision.allowed).toBe(true);
  });
});

describe('assertLlmSpendWithinCeiling + error class', () => {
  it('throws a terminal LlmBudgetExceededError with error-class budget', async () => {
    const { env } = spendEnv([{ provider: 'openrouter', usd: 25 }]);
    let caught: unknown;
    try {
      await assertLlmSpendWithinCeiling(env, 'openrouter');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LlmBudgetExceededError);
    expect((caught as LlmBudgetExceededError).errorClass).toBe('budget');
    expect(isLlmBudgetHalt(caught)).toBe(true);
  });

  it('budget halt messages never match the transient rate-limit regex (no retry storms)', () => {
    const message = llmBudgetHaltMessage({
      allowed: false,
      scope: 'total',
      provider: 'openrouter',
      spentUsd: 20,
      ceilingUsd: 10,
    });
    // configuredVision.isProviderRateLimit's pattern — a budget halt matching it
    // would be mistaken for a transient 429 and re-queued instead of halted.
    expect(/\b(429|402|too many requests|quota exceeded|rate[- ]?limit|payment required)\b/i.test(message)).toBe(false);
    expect(isLlmBudgetHalt(message)).toBe(true);
    expect(isLlmBudgetHalt('anthropic 429 too many requests')).toBe(false);
  });
});

describe('settleLlmSpend / readLlmSpend', () => {
  const receipt = (
    attemptId: string,
    usd: number,
    over: Partial<Parameters<typeof settleLlmSpend>[1]> = {},
  ): Parameters<typeof settleLlmSpend>[1] => ({
    provider: 'openrouter',
    requestedModel: 'openai/gpt-5.6-terra',
    attemptId,
    usd,
    occurredAt: '2026-07-22T12:00:00.000Z',
    ...over,
  });

  it('accumulates immutable receipts on top of the legacy baseline', async () => {
    // Pin the clock to the receipt helper's occurredAt day (2026-07-22). After
    // that calendar day, default readLlmSpend(now=new Date()) only sees the
    // legacy baseline and would under-report the immutable ledger.
    const now = new Date('2026-07-22T18:00:00.000Z');
    const { env } = spendEnv([{ provider: 'openrouter', usd: 0.25 }]);
    await settleLlmSpend(env, receipt('attempt-1', 0.5));
    await settleLlmSpend(env, receipt('attempt-2', 1, {
      provider: 'anthropic',
      requestedModel: 'claude-sonnet-5',
    }));
    const spend = await readLlmSpend(env, now);
    expect(spend?.totalUsd).toBeCloseTo(1.75);
    expect(spend?.perProvider.openrouter).toBeCloseTo(0.75);
    expect(spend?.perProvider.anthropic).toBeCloseTo(1);
  });

  it('treats an identical provider-response replay as a no-op', async () => {
    const { env, settlements } = spendEnv([]);
    const input = receipt('attempt-a', 0.5, { providerResponseId: 'resp-1' });
    await expect(settleLlmSpend(env, input)).resolves.toBe('inserted');
    await expect(settleLlmSpend(env, { ...input, attemptId: 'worker-replay-attempt' }))
      .resolves.toBe('duplicate');
    expect(settlements).toHaveLength(1);
  });

  it('rejects a provider-response replay with conflicting accounting data', async () => {
    const { env } = spendEnv([]);
    await settleLlmSpend(env, receipt('attempt-a', 0.5, { providerResponseId: 'resp-1' }));
    await expect(settleLlmSpend(
      env,
      receipt('attempt-b', 0.75, { providerResponseId: 'resp-1' }),
    )).rejects.toBeInstanceOf(LlmSpendSettlementError);
  });

  it('keeps the original occurrence day when a receipt is replayed after midnight', async () => {
    const { env } = spendEnv([]);
    const input = receipt('midnight-attempt', 0.5, {
      providerResponseId: 'resp-midnight',
      occurredAt: '2026-07-21T23:59:59.000Z',
    });
    await settleLlmSpend(env, input);
    await settleLlmSpend(env, input);
    expect((await readLlmSpend(env, new Date('2026-07-21T23:59:59.500Z')))?.totalUsd).toBe(0.5);
    expect((await readLlmSpend(env, new Date('2026-07-22T00:00:01.000Z')))?.totalUsd).toBe(0);
  });

  it('ignores invalid amounts and surfaces durable-write failure', async () => {
    const { env, settlements, failures } = spendEnv([]);
    await expect(settleLlmSpend(env, receipt('zero', 0))).resolves.toBe('ignored');
    await expect(settleLlmSpend(env, receipt('negative', -1))).resolves.toBe('ignored');
    await expect(settleLlmSpend(env, receipt('nan', Number.NaN))).resolves.toBe('ignored');
    expect(settlements).toHaveLength(0);
    failures.writes = true;
    await expect(settleLlmSpend(env, receipt('failed', 1)))
      .rejects.toBeInstanceOf(LlmSpendSettlementError);
  });

  it('enforces LLAMAPARSE_DAILY_CREDIT_CEILING in credits rather than USD', async () => {
    // $1.25 spent = 1,000 credits spent (at 800 credits/$1.00 or $0.00125/credit)
    const { env } = spendEnv(
      [{ provider: 'llamaparse', usd: 1.25 }],
      { LLAMAPARSE_DAILY_CREDIT_CEILING: '1000' },
    );
    const decision = await checkLlmSpendCeiling(env, 'llamaparse');
    expect(decision.allowed).toBe(false);
    expect(decision.scope).toBe('provider');
    expect(decision.spentCredits).toBeCloseTo(1000);
    expect(decision.ceilingCredits).toBe(1000);
    expect(isLlmBudgetHalt(llmBudgetHaltMessage(decision))).toBe(true);
    expect(llmBudgetHaltMessage(decision)).toContain('1000 of 1000 credits spent today');
  });
});
