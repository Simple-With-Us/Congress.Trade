import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { readCursorHighWater } from '../rows.ts';
import { BASE_SCHEMA_STATEMENTS } from '../../admin/migrations.ts';
import { buildAdminRouter } from '../../admin/routes.ts';
import { buildRestRouter } from '../rest.ts';
import type { Env } from '../../shared/types.ts';

interface SqliteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number | bigint };
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDatabase;
}

async function createInMemoryD1(): Promise<D1Database> {
  const sqlite = (await import('node:sqlite')) as unknown as SqliteModule;
  const db = new sqlite.DatabaseSync(':memory:');
  for (const sql of BASE_SCHEMA_STATEMENTS) {
    try {
      db.exec(sql);
    } catch {
      // Ignore initial setup error if any
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS securities_ref (ticker TEXT PRIMARY KEY, company_name TEXT, sector TEXT, market_cap REAL, market_cap_bucket TEXT, country TEXT, exchange_short TEXT, asset_class TEXT, enriched_at TEXT);
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE);
    ALTER TABLE filers ADD COLUMN photo_url TEXT;
    ALTER TABLE filers ADD COLUMN resolved_bioguide_id TEXT;
    ALTER TABLE filers ADD COLUMN display_name TEXT;
    ALTER TABLE filings ADD COLUMN filing_status TEXT;
    ALTER TABLE transactions ADD COLUMN deprecated_at TEXT;
  `);

  return {
    prepare(sql: string) {
      let params: unknown[] = [];
      return {
        bind(...values: unknown[]) {
          params = values;
          return this;
        },
        async first<T>() {
          return (db.prepare(sql).get(...params) ?? null) as T | null;
        },
        async run() {
          const res = db.prepare(sql).run(...params);
          return { success: true, meta: { changes: Number(res.changes) } } as unknown as D1Result;
        },
        async all<T>() {
          return { results: db.prepare(sql).all(...params) as T[] };
        },
      };
    },
    exec(sql: string) {
      db.exec(sql);
      return Promise.resolve({ count: 1, duration: 0 });
    },
    // POST /migrate on a fresh DB runs the guarded 0091 apple_subscriptions
    // rebuild, which refuses to run without one write transaction.
    async batch(statements: Array<{ run(): Promise<D1Result> }>) {
      db.exec('BEGIN');
      try {
        const results: D1Result[] = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
}

describe('P0-1 cursor poisoning remediation and self-healing', () => {
  it('readCursorHighWater returns MAX(cursor_seq)', async () => {
    const db = await createInMemoryD1();
    await db.exec(`
      INSERT INTO transactions (id, doc_id, filer_id, tx_date) VALUES ('tx1', 'doc1', 'F1', '2026-01-01');
      INSERT INTO transactions (id, doc_id, filer_id, tx_date) VALUES ('tx2', 'doc2', 'F1', '2026-01-02');
      INSERT INTO transactions (id, doc_id, filer_id, tx_date) VALUES ('tx3', 'doc3', 'F1', '2026-01-03');
    `);

    const hwm = await readCursorHighWater({ DB: db } as unknown as Env);
    // Trigger assigns 1, 2, 3 so MAX is 3
    expect(hwm).toBe(3);
  });

  it('clamps a poisoned since parameter back to the real high-water mark on zero-delta GET /transactions', async () => {
    const db = await createInMemoryD1();
    await db.exec(`
      INSERT INTO transactions (id, doc_id, filer_id, tx_date) VALUES ('tx1', 'doc1', 'F1', '2026-01-01');
      INSERT INTO transactions (id, doc_id, filer_id, tx_date) VALUES ('tx2', 'doc2', 'F1', '2026-01-02');
    `);

    const app = new Hono<{ Bindings: Env }>();
    app.route('/api', buildRestRouter());

    // User supplies a poisoned since value (e.g. 1.78e12)
    const res = await app.request('/api/transactions?since=1784939101315', {}, { DB: db } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cursor: number; transactions: any[] };
    expect(body.transactions).toHaveLength(0);
    // Should self-heal and return the real high-water mark (2) instead of echoing back 1.78e12
    expect(body.cursor).toBe(2);
  });

  it('0068_cursor_seq_integrity migration repairs poisoned cursors >= 1e12 and enforces trigger', async () => {
    const db = await createInMemoryD1();
    // Simulate legacy state with poisoned rows (> 1e12) and a poisoned subscription cursor
    await db.exec(`
      INSERT INTO subscriptions (id, cursor) VALUES ('sub1', 1784939101315);
      INSERT INTO transactions (id, doc_id, created_at) VALUES ('tx_normal', 'doc_norm', '2026-01-01T00:00:00Z');
      INSERT INTO transactions (id, doc_id, created_at) VALUES ('tx_poison1', 'doc_p1', '2026-01-02T00:00:00Z');
      INSERT INTO transactions (id, doc_id, created_at) VALUES ('tx_poison2', 'doc_p2', '2026-01-03T00:00:00Z');
      UPDATE transactions SET cursor_seq = 1784939101315 WHERE id IN ('tx_poison1', 'tx_poison2');
    `);

    const adminApp = new Hono<{ Bindings: Env }>();
    adminApp.route('/api/admin', buildAdminRouter());

    const res = await adminApp.request(
      '/api/admin/migrate',
      { method: 'POST', headers: { Authorization: 'Bearer admin-secret' } },
      { ADMIN_TOKEN: 'admin-secret', DB: db } as never,
    );

    expect(res.status).toBe(200);

    // Verify subscriptions cursor was repaired down to normal high-water mark (1)
    const sub = await (db.prepare('SELECT cursor FROM subscriptions WHERE id = ?').bind('sub1') as any).first<{ cursor: number }>();
    expect(sub?.cursor).toBe(1);

    // Verify transactions cursor_seq was repaired
    const poison1 = await (db.prepare('SELECT cursor_seq FROM transactions WHERE id = ?').bind('tx_poison1') as any).first<{ cursor_seq: number }>();
    const poison2 = await (db.prepare('SELECT cursor_seq FROM transactions WHERE id = ?').bind('tx_poison2') as any).first<{ cursor_seq: number }>();

    expect(poison1?.cursor_seq).toBeGreaterThan(1);
    expect(poison1?.cursor_seq).toBeLessThan(1000000000000);
    expect(poison2?.cursor_seq).toBeGreaterThan(poison1!.cursor_seq);
    expect(poison2?.cursor_seq).toBeLessThan(1000000000000);
  });
});
