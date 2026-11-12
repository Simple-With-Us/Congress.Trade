import { describe, it, expect } from 'vitest';
import { buildAdminRouter } from '../routes.ts';
import type { ParsedTx } from '../../shared/types.ts';

/**
 * GET /review/:docId/extractions — consensus block.
 *
 * The endpoint reconciles one coherent batch/revision via buildConsensusRows().
 * It never mixes independent batches or backfills a newer failed model attempt
 * with an older successful reading. Existing `runs`/`count` fields are unchanged
 * — see extractionRunsE2e.test.ts for that coverage.
 */

const app = buildAdminRouter();
const AUTH = { Authorization: 'Bearer admin-secret' };

/** Build a minimal extraction_runs row as D1 would return it. */
function extractionRunRow(over: {
  provider: string;
  model: string;
  kind: string;
  ok: number;
  createdAt: string;
  rows: ParsedTx[];
  batchId?: string | null;
  error?: string | null;
}) {
  return {
    id: `${over.provider}-${over.model}-${over.createdAt}`,
    batch_id: over.batchId ?? null,
    provider: over.provider,
    model: over.model,
    kind: over.kind,
    ok: over.ok,
    error: over.error ?? null,
    row_count: over.rows.length,
    latency_ms: 100,
    avg_confidence: 0.9,
    result_json: JSON.stringify(over.rows),
    created_at: over.createdAt,
  };
}

/** Build a ParsedTx with sensible defaults, overridable per-field. */
function tx(over: Partial<ParsedTx> = {}): ParsedTx {
  return {
    txDate: '2026-01-15',
    owner: 'self',
    assetName: 'Apple Inc',
    ticker: 'AAPL',
    assetType: 'ST',
    txType: 'B',
    amountMin: 15000,
    amountMax: 50000,
    isOption: false,
    capGainsOver200: false,
    rawText: 'row',
    confidence: 0.9,
    ...over,
  } as ParsedTx;
}

/** fakeDb whose extraction_runs SELECT returns `rows` verbatim (already DESC by created_at). */
function fakeDb(rows: unknown[]) {
  return {
    prepare() {
      return {
        bind() {
          return this;
        },
        async all<T>() {
          return { results: rows as T[] };
        },
        async first<T>() {
          return null as T | null;
        },
        async run() {
          return { success: true, meta: { changes: 1 } };
        },
      };
    },
  } as unknown as D1Database;
}

describe('GET /review/:docId/extractions — consensus', () => {
  it('3 stored runs across 3 distinct models -> consensus present with majority fields', async () => {
    // Same row (AAPL / 2026-01-15 / P) read by 3 models; owner disagrees 2-1
    // (self, self, spouse) so the row reconciles as 'majority' with owner's
    // dissenter recorded, matching buildConsensusRows's voting contract.
    const rowsDesc = [
      extractionRunRow({
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        kind: 'bakeoff',
        ok: 1,
        createdAt: '2026-06-25T00:00:03.000Z',
        batchId: 'coherent-1',
        rows: [tx({ owner: 'spouse' })],
      }),
      extractionRunRow({
        provider: 'openai',
        model: 'gpt-4o',
        kind: 'bakeoff',
        ok: 1,
        createdAt: '2026-06-25T00:00:02.000Z',
        batchId: 'coherent-1',
        rows: [tx({ owner: 'self' })],
      }),
      extractionRunRow({
        provider: 'mistral',
        model: 'mistral-ocr-latest',
        kind: 'bakeoff',
        ok: 1,
        createdAt: '2026-06-25T00:00:01.000Z',
        batchId: 'coherent-1',
        rows: [tx({ owner: 'self' })],
      }),
    ];

    const res = await app.request(
      '/review/H-CONSENSUS-1/extractions',
      { headers: AUTH },
      { ADMIN_TOKEN: 'admin-secret', DB: fakeDb(rowsDesc) } as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      runs: unknown[];
      count: number;
      consensus: {
        rows: Array<{
          rowConsensus: string;
          presentIn: string[];
          fields: Record<string, { value: unknown; votes: number; total: number }>;
        }>;
        summary: { models: string[]; rowsMajority: number };
      } | null;
      consensusStatus: {
        batchId: string;
        attemptedModels: string[];
        failedModels: Array<{ model: string }>;
        blockedReason: string | null;
      } | null;
    };

    // Existing fields untouched.
    expect(body.count).toBe(3);
    expect(body.runs).toHaveLength(3);

    // New consensus block.
    expect(body.consensus).not.toBeNull();
    const consensus = body.consensus!;
    expect(consensus.summary.models).toEqual([
      'anthropic:claude-sonnet-5',
      'mistral:mistral-ocr-latest',
      'openai:gpt-4o',
    ]);
    expect(consensus.rows).toHaveLength(1);
    const row = consensus.rows[0];
    expect(row.presentIn).toEqual([
      'anthropic:claude-sonnet-5',
      'mistral:mistral-ocr-latest',
      'openai:gpt-4o',
    ]);
    expect(row.rowConsensus).toBe('majority');
    expect(row.fields.owner).toMatchObject({ value: 'self', votes: 2, total: 3 });
    expect(consensus.summary.rowsMajority).toBe(1);
    expect(body.consensusStatus).toMatchObject({
      batchId: 'coherent-1',
      attemptedModels: [
        'anthropic:claude-sonnet-5',
        'mistral:mistral-ocr-latest',
        'openai:gpt-4o',
      ],
      failedModels: [],
      blockedReason: null,
    });
  });

  it('1 distinct model (even with 2 stored runs for it) -> consensus null', async () => {
    // Two runs for the SAME provider:model (a re-run) — still just one
    // distinct model, so consensus stays null; the newer run is listed first
    // (DESC by created_at) as the real SQL query returns it.
    const rowsDesc = [
      extractionRunRow({
        provider: 'gemini',
        model: 'gemini-3.5-flash',
        kind: 'bakeoff',
        ok: 1,
        createdAt: '2026-06-25T01:00:00.000Z',
        batchId: 'single-new',
        rows: [tx()],
      }),
      extractionRunRow({
        provider: 'gemini',
        model: 'gemini-3.5-flash',
        kind: 'bakeoff',
        ok: 1,
        createdAt: '2026-06-24T01:00:00.000Z',
        batchId: 'single-old',
        rows: [tx()],
      }),
    ];

    const res = await app.request(
      '/review/H-CONSENSUS-2/extractions',
      { headers: AUTH },
      { ADMIN_TOKEN: 'admin-secret', DB: fakeDb(rowsDesc) } as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number; consensus: unknown; consensusStatus: unknown };
    expect(body.count).toBe(2);
    expect(body.consensus).toBeNull();
    expect(body.consensusStatus).toBeNull();
  });

  it('a failed run does not count toward the distinct-model threshold', async () => {
    // 2 stored runs, but one is ok=0 (failed) — only 1 successful model
    // reading exists, so consensus should still be null.
    const rowsDesc = [
      extractionRunRow({
        provider: 'xai',
        model: 'grok-4.3',
        kind: 'bakeoff',
        ok: 0,
        createdAt: '2026-06-25T02:00:00.000Z',
        batchId: 'failed-pair',
        error: 'provider unavailable',
        rows: [],
      }),
      extractionRunRow({
        provider: 'gemini',
        model: 'gemini-3.5-flash',
        kind: 'bakeoff',
        ok: 1,
        createdAt: '2026-06-25T01:00:00.000Z',
        batchId: 'failed-pair',
        rows: [tx()],
      }),
    ];

    const res = await app.request(
      '/review/H-CONSENSUS-3/extractions',
      { headers: AUTH },
      { ADMIN_TOKEN: 'admin-secret', DB: fakeDb(rowsDesc) } as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      consensus: unknown;
      consensusStatus: {
        batchId: string;
        failedModels: Array<{ model: string; error: string }>;
        blockedReason: string | null;
      };
    };
    expect(body.consensus).toBeNull();
    expect(body.consensusStatus.batchId).toBe('failed-pair');
    expect(body.consensusStatus.failedModels).toEqual([
      { model: 'xai:grok-4.3', error: 'provider unavailable' },
    ]);
    expect(body.consensusStatus.blockedReason).toMatch(/fewer than two successful/i);
  });

  it('does not mix successful models from different batches', async () => {
    const rowsDesc = [
      extractionRunRow({
        provider: 'openai', model: 'gpt-4o', kind: 'bakeoff', ok: 1,
        createdAt: '2026-06-25T03:00:00.000Z', batchId: 'openai-only', rows: [tx()],
      }),
      extractionRunRow({
        provider: 'anthropic', model: 'claude-sonnet-5', kind: 'bakeoff', ok: 1,
        createdAt: '2026-06-25T02:00:00.000Z', batchId: 'anthropic-only', rows: [tx()],
      }),
    ];

    const res = await app.request(
      '/review/H-CONSENSUS-4/extractions',
      { headers: AUTH },
      { ADMIN_TOKEN: 'admin-secret', DB: fakeDb(rowsDesc) } as never,
    );
    const body = (await res.json()) as { consensus: unknown; consensusStatus: unknown };
    expect(body.consensus).toBeNull();
    expect(body.consensusStatus).toBeNull();
  });

  it('a newer failed comparable batch blocks fallback to an older successful batch', async () => {
    const rowsDesc = [
      // Latest two-model revision: one model failed. It must be selected and
      // reported as blocked instead of borrowing anthropic's older success.
      extractionRunRow({
        provider: 'openai', model: 'gpt-4o', kind: 'bakeoff', ok: 1,
        createdAt: '2026-06-26T02:00:00.000Z', batchId: 'new-revision',
        rows: [tx({ owner: 'joint' })],
      }),
      extractionRunRow({
        provider: 'anthropic', model: 'claude-sonnet-5', kind: 'bakeoff', ok: 0,
        createdAt: '2026-06-26T02:00:00.000Z', batchId: 'new-revision',
        error: 'timeout', rows: [],
      }),
      extractionRunRow({
        provider: 'openai', model: 'gpt-4o', kind: 'bakeoff', ok: 1,
        createdAt: '2026-06-25T02:00:00.000Z', batchId: 'old-revision', rows: [tx()],
      }),
      extractionRunRow({
        provider: 'anthropic', model: 'claude-sonnet-5', kind: 'bakeoff', ok: 1,
        createdAt: '2026-06-25T02:00:00.000Z', batchId: 'old-revision', rows: [tx()],
      }),
    ];

    const res = await app.request(
      '/review/H-CONSENSUS-5/extractions',
      { headers: AUTH },
      { ADMIN_TOKEN: 'admin-secret', DB: fakeDb(rowsDesc) } as never,
    );
    const body = (await res.json()) as {
      consensus: unknown;
      consensusStatus: {
        batchId: string;
        successfulModels: string[];
        failedModels: Array<{ model: string; error: string }>;
        blockedReason: string | null;
      };
    };
    expect(body.consensus).toBeNull();
    expect(body.consensusStatus).toMatchObject({
      batchId: 'new-revision',
      successfulModels: ['openai:gpt-4o'],
      failedModels: [{ model: 'anthropic:claude-sonnet-5', error: 'timeout' }],
    });
    expect(body.consensusStatus.blockedReason).toContain('older successes were not mixed in');
  });
});
