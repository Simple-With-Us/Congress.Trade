/**
 * src/admin/__tests__/securitiesImportRefs.test.ts
 *
 * POST /securities/import `refs[]` are flushed through DB.batch in chunks of
 * 100 (previously a sequential `await` per row, which tripped the Worker CPU
 * limit / overloaded D1 on large batches). We assert with a fake D1 that:
 *   - refs go through batch() (not one run() per row) on the happy path,
 *   - rows without a ticker are skipped,
 *   - a chunk-level batch failure falls back to per-row writes so a single bad
 *     ticker is attributed without dropping the rest.
 */

import { describe, it, expect } from 'vitest';
import { buildAdminRouter } from '../routes.ts';

const app = buildAdminRouter();

function importReq(body: unknown, env: Record<string, unknown>) {
  return app.request(
    '/securities/import',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: 'Bearer ingest-secret' },
      body: JSON.stringify(body),
    },
    env as never,
  );
}

const baseEnv = { ADMIN_TOKEN: 'admin-secret', INGEST_TOKEN: 'ingest-secret' };

describe('POST /securities/import — refs batching', () => {
  it('writes all refs via batch() in one chunk and skips ticker-less rows', async () => {
    let batchCalls = 0;
    let batchedStmts = 0;
    let runCalls = 0;
    const db = {
      prepare: (_q: string) => ({ bind: (..._a: unknown[]) => ({ run: async () => { runCalls++; return {}; } }) }),
      batch: async (stmts: unknown[]) => {
        batchCalls++;
        batchedStmts += stmts.length;
        return [];
      },
    };
    const refs = Array.from({ length: 5 }, (_, i) => ({ ticker: 't' + i, companyName: 'Co ' + i }));
    refs.push({ companyName: 'No Ticker' } as never); // skipped

    const res = await importReq({ refs }, { ...baseEnv, DB: db });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; refs: number };
    expect(body.ok).toBe(true);
    expect(body.refs).toBe(5);
    expect(batchCalls).toBe(1); // single chunk (<100)
    expect(batchedStmts).toBe(5);
    expect(runCalls).toBe(1); // peer_import_receipts insert (refs still use batch, not per-row run)
  });

  it('chunks more than 100 refs into multiple batch() calls', async () => {
    let batchCalls = 0;
    const db = {
      prepare: (_q: string) => ({ bind: (..._a: unknown[]) => ({ run: async () => ({}) }) }),
      batch: async (_stmts: unknown[]) => {
        batchCalls++;
        return [];
      },
    };
    const refs = Array.from({ length: 250 }, (_, i) => ({ ticker: 'T' + i }));
    const res = await importReq({ refs }, { ...baseEnv, DB: db });
    const body = (await res.json()) as { refs: number };
    expect(body.refs).toBe(250);
    expect(batchCalls).toBe(3); // 100 + 100 + 50
  });

  it('falls back to per-row writes when a batch chunk fails, attributing the bad ticker', async () => {
    const db = {
      prepare: (_q: string) => ({
        bind: (ticker: unknown, ..._a: unknown[]) => ({
          run: async () => {
            if (ticker === 'BAD') throw new Error('constraint failed');
            return {};
          },
        }),
      }),
      batch: async (_stmts: unknown[]) => {
        throw new Error('batch boom');
      },
    };
    const res = await importReq(
      { refs: [{ ticker: 'GOOD1' }, { ticker: 'BAD' }, { ticker: 'GOOD2' }] },
      { ...baseEnv, DB: db },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; refs: number; errors: string[] };
    expect(body.refs).toBe(2); // GOOD1 + GOOD2 written row-by-row
    expect(body.ok).toBe(false);
    expect(body.errors.some((e) => e.startsWith('BAD ref:'))).toBe(true);
  });
});
