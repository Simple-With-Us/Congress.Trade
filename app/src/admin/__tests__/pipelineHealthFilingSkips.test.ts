/**
 * src/admin/__tests__/pipelineHealthFilingSkips.test.ts
 *
 * GET /api/admin/pipeline-health/filing-skips is the operator-private
 * diagnostic for the unreadable 278-T doc ids that public /health responses
 * no longer carry (kody review on claude/salvage-278t-signal). Proves:
 *
 *   1. Deny-by-default: with no ADMIN_TOKEN / Access / session config the
 *      route fails CLOSED (401) and discloses nothing.
 *   2. A bearer ADMIN_TOKEN caller gets the raw ids, the distinct-doc count,
 *      and the filing_skips check — collected against a REAL SQLite database
 *      migrated with the actual app/migrations/*.sql files.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildAdminRouter } from '../routes.ts';
import type { Env } from '../../shared/types.ts';

interface SqliteRunResult {
  changes: number | bigint;
}
interface SqliteStatement {
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Array<Record<string, unknown>>;
  run(...params: unknown[]): SqliteRunResult;
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}
interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDatabase;
}

const migrationsUrl = new URL('../../../migrations/', (import.meta as ImportMeta & { url: string }).url);

async function freshMigratedDb(): Promise<SqliteDatabase> {
  const moduleName = 'node:sqlite';
  const sqlite = (await import(moduleName)) as SqliteModule;
  const db = new sqlite.DatabaseSync(':memory:');
  const files = readdirSync(migrationsUrl as unknown as string).filter((name) => name.endsWith('.sql')).sort();
  for (const name of files) {
    db.exec(readFileSync(new URL(name, migrationsUrl) as unknown as string, 'utf8'));
  }
  return db;
}

function d1Database(db: SqliteDatabase): Env['DB'] {
  const prepare = (sql: string) => {
    let params: unknown[] = [];
    const statement = {
      bind(...values: unknown[]) {
        params = values;
        return statement;
      },
      async first<T>() {
        return (db.prepare(sql).get(...params) ?? null) as T | null;
      },
      async run() {
        const result = db.prepare(sql).run(...params);
        return { success: true, meta: { changes: Number(result.changes) } } as unknown;
      },
      async all<T>() {
        return { results: db.prepare(sql).all(...params) as T[] };
      },
    };
    return statement;
  };
  return { prepare } as unknown as Env['DB'];
}

const app = buildAdminRouter();

describe('GET /pipeline-health/filing-skips', () => {
  it('fails closed with 401 and discloses nothing when no admin auth is configured', async () => {
    const db = await freshMigratedDb();
    try {
      db.prepare(
        `INSERT INTO ingestion_decisions (id, doc_id, action, source, actor, reason, payload, created_at)
         VALUES ('dec-1', 'E-secret-doc', 'oge_text_unreadable', 'test', 'test', NULL, '{}', ?)`,
      ).run(new Date().toISOString());
      const env = { DB: d1Database(db) } as unknown as Env;
      const res = await app.request('http://localhost/pipeline-health/filing-skips', {}, env);
      expect(res.status).toBe(401);
      const body = await res.text();
      expect(body).not.toContain('E-secret-doc');
    } finally {
      db.close();
    }
  });

  it('returns the raw ids, distinct-doc count, and filing_skips check to a bearer ADMIN_TOKEN caller', async () => {
    const db = await freshMigratedDb();
    try {
      const now = new Date();
      db.prepare(
        `INSERT INTO ingestion_decisions (id, doc_id, action, source, actor, reason, payload, created_at)
         VALUES ('dec-1', 'E-named-doc', 'oge_text_unreadable', 'test', 'test', NULL, '{}', ?)`,
      ).run(now.toISOString());
      // Duplicate decision for the same doc must not inflate the count.
      db.prepare(
        `INSERT INTO ingestion_decisions (id, doc_id, action, source, actor, reason, payload, created_at)
         VALUES ('dec-2', 'E-named-doc', 'oge_text_unreadable', 'test', 'test', NULL, '{}', ?)`,
      ).run(now.toISOString());
      const env = { DB: d1Database(db), ADMIN_TOKEN: 'adm-tok' } as unknown as Env;
      const res = await app.request(
        'http://localhost/pipeline-health/filing-skips',
        { headers: { Authorization: 'Bearer adm-tok' } },
        env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        unreadableExecutiveDocIds: string[];
        unreadableExecutiveDocCount: number;
        filingSkips: { id: string; status: string; detail: string } | null;
      };
      expect(body.unreadableExecutiveDocIds).toEqual(['E-named-doc']);
      expect(body.unreadableExecutiveDocCount).toBe(1);
      expect(body.filingSkips?.id).toBe('filing_skips');
      expect(body.filingSkips?.status).toBe('critical');
      expect(body.filingSkips?.detail).toContain('Unreadable docs: E-named-doc');
    } finally {
      db.close();
    }
  });
});
