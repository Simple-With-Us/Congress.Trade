import { describe, it, expect } from 'vitest';
import { buildAdminRouter } from '../routes.ts';
import type { Env } from '../../shared/types.ts';

describe('POST /api/admin/migrate error handling', () => {
  it('runs migrations successfully and returns ok=true (HTTP 200)', async () => {
    const executedSql: string[] = [];
    const env = {
      ADMIN_TOKEN: 'admin-secret',
      DB: {
        prepare(sql: string) {
          executedSql.push(sql);
          return {
            async run() {
              return { success: true };
            },
            async first() {
              return { count: 1 };
            },
            async all() {
              return { results: [] };
            },
          };
        },
      },
    } as unknown as Env;

    const router = buildAdminRouter();
    const res = await router.request('/migrate', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ skipSchemaVerify: true }),
    }, env);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; applied: string[]; skipped: string[]; failed: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.failed).toHaveLength(0);
    expect(executedSql.length).toBeGreaterThan(0);
  });

  it('fails with HTTP 500 when an unhandled SQL error occurs', async () => {
    const env = {
      ADMIN_TOKEN: 'admin-secret',
      DB: {
        prepare(sql: string) {
          return {
            async run() {
              if (sql.includes('transactions')) {
                throw new Error('UNIQUE constraint failed: transactions.doc_id');
              }
              return { success: true };
            },
            async first() {
              return { count: 1 };
            },
            async all() {
              return { results: [] };
            },
          };
        },
      },
    } as unknown as Env;

    const router = buildAdminRouter();
    const res = await router.request('/migrate', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ skipSchemaVerify: true }),
    }, env);

    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean; failed: Array<{ sql: string; error: string }> };
    expect(body.ok).toBe(false);
    expect(body.failed.length).toBeGreaterThan(0);
    expect(body.failed[0].error).toContain('UNIQUE constraint failed');
  });

  it('treats duplicate column name errors as skipped (HTTP 200)', async () => {
    const env = {
      ADMIN_TOKEN: 'admin-secret',
      DB: {
        prepare(sql: string) {
          return {
            async run() {
              throw new Error('duplicate column name: test_col');
            },
            async first() {
              return { count: 1 };
            },
            async all() {
              if (/PRAGMA\s+table_info/i.test(sql)) {
                return { results: [] };
              }
              return { results: [] };
            },
          };
        },
      },
    } as unknown as Env;

    const router = buildAdminRouter();
    const res = await router.request('/migrate', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ skipSchemaVerify: true }),
    }, env);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; skipped: string[]; failed: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.skipped.length).toBeGreaterThan(0);
    expect(body.failed).toHaveLength(0);
  });
  // ---- schema-readiness postcondition -------------------------------------
  // The three tests above all pass skipSchemaVerify:true, so none of them
  // exercise the postcondition the fail-closed change exists for. These do.

  it('fails closed (HTTP 500) when the schema readiness probe reports missing objects', async () => {
    const env = {
      ADMIN_TOKEN: 'admin-secret',
      DB: {
        prepare(sql: string) {
          return {
            bind() {
              return this;
            },
            async run() {
              return { success: true };
            },
            async first() {
              // `SELECT 1 AS ok` succeeds so the DB is reachable, but every
              // schema probe comes back empty -> readiness.ok === false.
              return /SELECT 1 AS ok/i.test(sql) ? { ok: 1 } : null;
            },
            async all() {
              return { results: [] };
            },
          };
        },
      },
    } as unknown as Env;

    const res = await buildAdminRouter().request(
      '/migrate',
      { method: 'POST', headers: { Authorization: 'Bearer admin-secret' } },
      env,
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean; readiness: { ok: boolean; missing: string[] } };
    expect(body.ok).toBe(false);
    expect(body.readiness.ok).toBe(false);
    expect(body.readiness.missing.length).toBeGreaterThan(0);
  });

  it('fails closed (HTTP 500) when the readiness probe cannot reach the database', async () => {
    // Regression guard: `ok` used to be
    //   failed.length === 0 && (readiness.ok || !readiness.db)
    // so an UNREACHABLE database — the single worst outcome, and exactly what
    // the postcondition exists to catch — reported HTTP 200 and ship.sh called
    // the deploy good.
    const env = {
      ADMIN_TOKEN: 'admin-secret',
      DB: {
        prepare(sql: string) {
          return {
            bind() {
              return this;
            },
            async run() {
              return { success: true };
            },
            async first() {
              if (/SELECT 1 AS ok/i.test(sql)) {
                throw new Error('D1_ERROR: database is unreachable');
              }
              throw new Error('D1_ERROR: database is unreachable');
            },
            async all() {
              if (/PRAGMA\s+table_info/i.test(sql)) {
                return { results: [] };
              }
              throw new Error('D1_ERROR: database is unreachable');
            },
          };
        },
      },
    } as unknown as Env;

    const res = await buildAdminRouter().request(
      '/migrate',
      { method: 'POST', headers: { Authorization: 'Bearer admin-secret' } },
      env,
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean; readiness: { db: boolean } };
    expect(body.ok).toBe(false);
    expect(body.readiness.db).toBe(false);
  });
});
