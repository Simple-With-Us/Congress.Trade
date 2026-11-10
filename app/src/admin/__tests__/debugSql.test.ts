import { describe, it, expect } from 'vitest';
import { buildAdminRouter } from '../routes.ts';

const app = buildAdminRouter();

function fakeDb(calls: string[]) {
  return {
    prepare(sql: string) {
      return {
        params: [] as unknown[],
        bind(...params: unknown[]) {
          this.params = params;
          return this;
        },
        async all<T>() {
          calls.push(sql);
          return { results: [{ ok: 1 }] as T[] };
        },
        async first<T>() {
          return null as T | null;
        },
        async run() {
          return { success: true, meta: { changes: 1 } };
        },
        sql,
      };
    },
  } as unknown as D1Database;
}

describe('admin debug-sql', () => {
  it('runs the query when no production environment marker is set', async () => {
    const calls: string[] = [];
    const res = await app.request(
      '/debug-sql',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'SELECT 1' }),
      },
      { ADMIN_TOKEN: 'admin-secret', DB: fakeDb(calls) } as never,
    );

    expect(res.status).toBe(200);
    expect(calls).toEqual(['SELECT 1']);
  });

  it('fails closed in production even with a valid admin token (2026-08-31 full-stack audit)', async () => {
    const calls: string[] = [];
    const res = await app.request(
      '/debug-sql',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'SELECT 1' }),
      },
      {
        ADMIN_TOKEN: 'admin-secret',
        SENTRY_ENVIRONMENT: 'production',
        DB: fakeDb(calls),
      } as never,
    );

    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('also fails closed when USAGE_MONITOR_ENVIRONMENT marks production', async () => {
    const calls: string[] = [];
    const res = await app.request(
      '/debug-sql',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'SELECT 1' }),
      },
      {
        ADMIN_TOKEN: 'admin-secret',
        USAGE_MONITOR_ENVIRONMENT: 'production',
        DB: fakeDb(calls),
      } as never,
    );

    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });
});
