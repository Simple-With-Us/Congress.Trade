import { describe, expect, it } from 'vitest';
import type { Env } from '../../shared/types.ts';
import { buildCoverageScorecard } from '../coverageScorecard.ts';

type Row = Record<string, unknown>;

function memDb(state: {
  filings: Row[];
  transactions: Row[];
}) {
  return {
    prepare(sql: string) {
      const self = {
        params: [] as unknown[],
        bind(...params: unknown[]) {
          self.params = params;
          return self;
        },
        async first<T>() {
          const all = await self.all<T>();
          return (all.results?.[0] ?? null) as T | null;
        },
        async all<T>() {
          if (/COUNT\(\*\) AS n FROM filings\s*$/i.test(sql.trim()) || /COUNT\(\*\) AS n FROM filings$/i.test(sql)) {
            return { results: [{ n: state.filings.length } as T] };
          }
          if (/GROUP BY 1/i.test(sql) && /chamber/i.test(sql)) {
            const map = new Map<string, number>();
            for (const f of state.filings) {
              const k = String(f.chamber ?? 'unknown');
              map.set(k, (map.get(k) ?? 0) + 1);
            }
            return { results: [...map].map(([k, n]) => ({ k, n }) as T) };
          }
          if (/GROUP BY 1/i.test(sql) && /ingest_status/i.test(sql)) {
            const map = new Map<string, number>();
            for (const f of state.filings) {
              const k = String(f.ingest_status ?? 'unknown');
              map.set(k, (map.get(k) ?? 0) + 1);
            }
            return { results: [...map].map(([k, n]) => ({ k, n }) as T) };
          }
          if (/MIN\(first_seen_at\)/i.test(sql)) {
            const firsts = state.filings.map((f) => f.first_seen_at as string).filter(Boolean).sort();
            const filed = state.filings.map((f) => f.filed_date as string).filter(Boolean).sort();
            return {
              results: [{
                earliest_first_seen: firsts[0] ?? null,
                latest_first_seen: firsts[firsts.length - 1] ?? null,
                earliest_filed: filed[0] ?? null,
                latest_filed: filed[filed.length - 1] ?? null,
              } as T],
            };
          }
          if (/COUNT\(\*\) AS n FROM transactions/i.test(sql)) {
            return { results: [{ n: state.transactions.length } as T] };
          }
          if (/FROM filings f/i.test(sql) && /EXISTS/i.test(sql) && /transactions/i.test(sql)) {
            const txDocs = new Set(state.transactions.map((t) => t.doc_id));
            // memDb filings lack doc_id; treat one tx as covering first filing.
            const n = Math.min(txDocs.size, state.filings.length);
            return { results: [{ n } as T] };
          }
          if (/COUNT\(DISTINCT doc_id\)/i.test(sql)) {
            const docs = new Set(state.transactions.map((t) => t.doc_id));
            return { results: [{ n: docs.size } as T] };
          }
          if (/substr\(first_seen_at/i.test(sql)) {
            return { results: [] };
          }
          return { results: [] };
        },
      };
      return self;
    },
  };
}

describe('buildCoverageScorecard', () => {
  it('reports incomplete when filings lack transactions', async () => {
    const env = {
      DB: memDb({
        filings: [
          { chamber: 'house', ingest_status: 'fetched', first_seen_at: '2026-08-07T01:00:00Z', filed_date: '2026-08-06' },
          { chamber: 'house', ingest_status: 'classified', first_seen_at: '2026-08-07T01:00:00Z', filed_date: '2026-08-06' },
        ],
        transactions: [],
      }),
    } as unknown as Env;

    const card = await buildCoverageScorecard(env, new Date('2026-08-07T12:00:00Z'));
    expect(card.filings.total).toBe(2);
    expect(card.transactions.docsWithTransactions).toBe(0);
    expect(card.complete).toBe(false);
    expect(card.completeReasons.length).toBeGreaterThan(0);
    expect(card.extractionCoveragePct).toBe(0);
  });

  it('is complete when every non-terminal filing has transactions', async () => {
    const env = {
      DB: memDb({
        filings: [
          { chamber: 'house', ingest_status: 'extracted', first_seen_at: '2026-08-01T00:00:00Z', filed_date: '2026-07-01' },
          { chamber: 'senate', ingest_status: 'error', first_seen_at: '2026-08-01T00:00:00Z', filed_date: '2026-07-02' },
        ],
        transactions: [{ doc_id: 'H-1' }],
      }),
    } as unknown as Env;

    const card = await buildCoverageScorecard(env, new Date('2026-08-07T12:00:00Z'));
    expect(card.filings.total).toBe(2);
    expect(card.transactions.docsWithTransactions).toBe(1);
    expect(card.complete).toBe(true);
    expect(card.completeReasons).toEqual([]);
  });
});
