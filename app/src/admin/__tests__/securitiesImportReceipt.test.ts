/**
 * POST /securities/import persists peer_import_receipts and returns a dropped map.
 */
import { describe, it, expect } from 'vitest';
import { buildAdminRouter } from '../routes.ts';
import { SCHEMA_DROP_REASON } from '../../share/importReceipt.ts';

const app = buildAdminRouter();

function fakeDb() {
  const sql: string[] = [];
  const binds: unknown[][] = [];
  const db = {
    prepare(query: string) {
      sql.push(query);
      return {
        bind: (...args: unknown[]) => {
          binds.push(args);
          return { run: async () => ({}) };
        },
      };
    },
    async batch(_stmts: unknown[]) {
      return [];
    },
  };
  return { db, sql, binds };
}

function importReq(body: unknown, env: Record<string, unknown>, headers: Record<string, string> = {}) {
  return app.request(
    '/securities/import',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: 'Bearer ingest-secret',
        'x-request-id': 'peer-push-req-99',
        ...headers,
      },
      body: JSON.stringify(body),
    },
    env as never,
  );
}

describe('POST /securities/import — import receipts', () => {
  const env = { ADMIN_TOKEN: 'admin-secret', INGEST_TOKEN: 'ingest-secret' };

  it('returns dropped map for schema-filtered rows and inserts a receipt', async () => {
    const { db, sql, binds } = fakeDb();
    const res = await importReq(
      {
        origin: 'app-b',
        refs: [{ ticker: 'AAPL' }, { bad: true }],
      },
      { ...env, DB: db },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      refs: number;
      dropped: { refs?: { count: number; reason: string } };
    };
    expect(body.ok).toBe(true);
    expect(body.refs).toBe(1);
    expect(body.dropped.refs).toEqual({ count: 1, reason: SCHEMA_DROP_REASON });

    const insert = sql.find((s) => s.includes('INSERT INTO peer_import_receipts'));
    expect(insert).toBeTruthy();
    const row = binds.find((b) => b[0] === 'peer-push-req-99');
    expect(row).toBeTruthy();
    expect(row?.[2]).toBe('app-b');
    expect(JSON.parse(String(row?.[6]))).toMatchObject({ refs: 1 });
    expect(JSON.parse(String(row?.[7]))).toMatchObject({
      refs: { count: 1, reason: SCHEMA_DROP_REASON },
    });
  });

  it('keeps backward-compatible fields when dropped is empty', async () => {
    const { db } = fakeDb();
    const res = await importReq({}, { ...env, DB: db });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; refs: number; dropped: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.refs).toBe(0);
    expect(body.dropped).toEqual({});
  });
});
