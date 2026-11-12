/**
 * readLlmSpendByModel / readLlmSpendWeekAndMonth — the per-model, date-ranged
 * spend report behind the admin "LLM Spend & LlamaParse Credits" panel.
 * Distinct from llmSpend.test.ts's settlement-writer/ceiling coverage: these
 * are pure reads against a pre-seeded `llm_spend_settlements` ledger, so the
 * fixture here seeds rows directly rather than going through settleLlmSpend.
 */
import { describe, expect, it } from 'vitest';
import type { Env } from '../types.ts';
import { readLlmSpendByModel, readLlmSpendWeekAndMonth } from '../llmSpend.ts';

interface SettlementRow {
  provider: string;
  requested_model: string;
  resolved_model: string | null;
  doc_id: string | null;
  usd: number;
  day: string;
}

function ledgerEnv(rows: SettlementRow[], opts: { failReads?: boolean } = {}): Env {
  const prepare = (sql: string) => ({
    params: [] as unknown[],
    bind(...params: unknown[]) {
      this.params = params;
      return this;
    },
    async all() {
      if (opts.failReads) throw new Error('D1 unavailable');
      if (/GROUP BY provider, model/i.test(sql)) {
        const [since, through] = this.params as [string, string];
        const inRange = rows.filter((r) => r.day >= since && r.day <= through);
        const grouped = new Map<string, { provider: string; model: string; calls: number; docs: Set<string>; usd: number }>();
        for (const r of inRange) {
          const model = r.resolved_model ?? r.requested_model;
          const key = `${r.provider}::${model}`;
          const g = grouped.get(key) ?? { provider: r.provider, model, calls: 0, docs: new Set<string>(), usd: 0 };
          g.calls += 1;
          if (r.doc_id) g.docs.add(r.doc_id);
          g.usd += r.usd;
          grouped.set(key, g);
        }
        const results = Array.from(grouped.values())
          .map((g) => ({ provider: g.provider, model: g.model, call_count: g.calls, doc_count: g.docs.size, total_usd: g.usd }))
          .sort((a, b) => b.total_usd - a.total_usd);
        return { results };
      }
      return { results: [] };
    },
    async first() {
      if (opts.failReads) throw new Error('D1 unavailable');
      if (/COUNT\(DISTINCT doc_id\) AS n/i.test(sql)) {
        const [since, through] = this.params as [string, string];
        const docs = new Set(
          rows.filter((r) => r.day >= since && r.day <= through && r.doc_id).map((r) => r.doc_id),
        );
        return { n: docs.size };
      }
      return null;
    },
  });
  return { DB: { prepare } as unknown as D1Database } as unknown as Env;
}

describe('readLlmSpendByModel', () => {
  it('groups by provider + resolved model (falling back to requested model), summing cost and counting distinct docs', async () => {
    const env = ledgerEnv([
      { provider: 'llamaparse', requested_model: 'cost-effective', resolved_model: null, doc_id: 'H-1', usd: 0.01, day: '2026-08-10' },
      { provider: 'llamaparse', requested_model: 'cost-effective', resolved_model: null, doc_id: 'H-1', usd: 0.01, day: '2026-08-10' }, // retry, same doc
      { provider: 'llamaparse', requested_model: 'cost-effective', resolved_model: null, doc_id: 'H-2', usd: 0.01, day: '2026-08-11' },
      { provider: 'openrouter', requested_model: 'x-ai/grok-4.5', resolved_model: 'x-ai/grok-4.5', doc_id: 'H-2', usd: 0.05, day: '2026-08-11' },
    ]);
    const report = await readLlmSpendByModel(env, '2026-08-10', '2026-08-11');
    expect(report).not.toBeNull();
    expect(report?.byModel).toEqual([
      { provider: 'openrouter', model: 'x-ai/grok-4.5', callCount: 1, docCount: 1, totalUsd: 0.05 },
      { provider: 'llamaparse', model: 'cost-effective', callCount: 3, docCount: 2, totalUsd: 0.03 },
    ]);
    expect(report?.totalUsd).toBeCloseTo(0.08);
    expect(report?.totalCalls).toBe(4);
    // 2 distinct docs total (H-1, H-2) even though llamaparse+openrouter both touched H-2 --
    // this must NOT double-count across models, unlike summing per-model docCount would.
    expect(report?.totalDocs).toBe(2);
  });

  it('prefers resolved_model over requested_model when a fallback substitution happened', async () => {
    const env = ledgerEnv([
      { provider: 'openrouter', requested_model: 'openai/gpt-5.6-luna', resolved_model: 'anthropic/claude-haiku-4.5', doc_id: 'H-1', usd: 0.02, day: '2026-08-10' },
    ]);
    const report = await readLlmSpendByModel(env, '2026-08-10', '2026-08-10');
    expect(report?.byModel).toEqual([
      { provider: 'openrouter', model: 'anthropic/claude-haiku-4.5', callCount: 1, docCount: 1, totalUsd: 0.02 },
    ]);
  });

  it('excludes rows outside the requested day range', async () => {
    const env = ledgerEnv([
      { provider: 'llamaparse', requested_model: 'fast', resolved_model: null, doc_id: 'H-1', usd: 0.01, day: '2026-07-01' },
    ]);
    const report = await readLlmSpendByModel(env, '2026-08-01', '2026-08-11');
    expect(report?.byModel).toEqual([]);
    expect(report?.totalUsd).toBe(0);
    expect(report?.totalDocs).toBe(0);
  });

  it('returns an empty (not null) report for a genuinely quiet range, and null only when the meter is unreadable', async () => {
    const quiet = await readLlmSpendByModel(ledgerEnv([]), '2026-08-01', '2026-08-11');
    expect(quiet).not.toBeNull();
    expect(quiet?.byModel).toEqual([]);

    const unreadable = await readLlmSpendByModel(ledgerEnv([], { failReads: true }), '2026-08-01', '2026-08-11');
    expect(unreadable).toBeNull();
  });
});

describe('readLlmSpendWeekAndMonth', () => {
  it('computes a 7-day window and a 30-day window ending today, both inclusive of today', async () => {
    const env = ledgerEnv([
      { provider: 'llamaparse', requested_model: 'cost-effective', resolved_model: null, doc_id: 'H-1', usd: 0.03, day: '2026-08-11' }, // today
      { provider: 'llamaparse', requested_model: 'cost-effective', resolved_model: null, doc_id: 'H-2', usd: 0.03, day: '2026-08-06' }, // 5 days ago -- in week
      { provider: 'llamaparse', requested_model: 'cost-effective', resolved_model: null, doc_id: 'H-3', usd: 0.03, day: '2026-07-20' }, // 22 days ago -- in month, not week
      { provider: 'llamaparse', requested_model: 'cost-effective', resolved_model: null, doc_id: 'H-4', usd: 0.03, day: '2026-06-01' }, // outside both
    ]);
    const now = new Date('2026-08-11T12:00:00.000Z');
    const { week, month } = await readLlmSpendWeekAndMonth(env, now);
    expect(week?.totalDocs).toBe(2); // H-1, H-2
    expect(month?.totalDocs).toBe(3); // H-1, H-2, H-3
    expect(week?.rangeEnd).toBe('2026-08-11');
    expect(month?.rangeStart).toBe('2026-07-13');
  });
});
