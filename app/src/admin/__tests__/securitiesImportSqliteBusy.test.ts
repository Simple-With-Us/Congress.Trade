/**
 * Peer share (POST /securities/import) must survive SQLITE_BUSY during cron overlap.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { buildAdminRouter } from '../routes.ts';

const app = buildAdminRouter();

afterEach(() => vi.unstubAllGlobals());

function post(body: Record<string, unknown>, env: Record<string, unknown>) {
  return app.request(
    '/securities/import',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: 'Bearer ingest-secret',
      },
      body: JSON.stringify(body),
    },
    env as never,
  );
}

describe('POST /securities/import — SQLITE_BUSY', () => {
  it('returns 503 when the database stays locked after retries', async () => {
    const busy = new Error('SQLITE_BUSY: database is locked');
    const db = {
      batch: vi.fn(async () => {
        throw busy;
      }),
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          run: vi.fn(async () => {
            throw busy;
          }),
        })),
      })),
    };
    const res = await post(
      { spx: [{ date: '2026-10-01', close: 100 }] },
      { ADMIN_TOKEN: 'admin-secret', INGEST_TOKEN: 'ingest-secret', DB: db },
    );
    expect(res.status).toBe(503);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/database busy/i);
  });

  it('returns 503 when a price batch stays locked instead of a partial 200', async () => {
    const busy = new Error('SQLITE_BUSY: database is locked');
    const db = {
      batch: vi.fn(async () => {
        throw busy;
      }),
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          run: vi.fn(async () => {
            throw busy;
          }),
        })),
      })),
    };
    const res = await post(
      { prices: [{ ticker: 'AAPL', closes: [{ date: '2026-10-01', close: 100 }] }] },
      { ADMIN_TOKEN: 'admin-secret', INGEST_TOKEN: 'ingest-secret', DB: db },
    );
    expect(res.status).toBe(503);
    const json = (await res.json()) as { error: string; ok?: boolean };
    expect(json.error).toMatch(/database busy/i);
    expect(json.ok).toBeUndefined();
  });

  it('keeps a non-lock price failure on the 200 summary', async () => {
    const db = {
      batch: vi.fn(async () => {
        throw new Error('CHECK constraint failed');
      }),
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          run: vi.fn(async () => {
            throw new Error('CHECK constraint failed');
          }),
        })),
      })),
    };
    const res = await post(
      { prices: [{ ticker: 'AAPL', closes: [{ date: '2026-10-01', close: 100 }] }] },
      { ADMIN_TOKEN: 'admin-secret', INGEST_TOKEN: 'ingest-secret', DB: db },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; errors: string[] };
    expect(json.ok).toBe(false);
    expect(json.errors.join('\n')).toMatch(/CHECK constraint failed/);
  });
});
