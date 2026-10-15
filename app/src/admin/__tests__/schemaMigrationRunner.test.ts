import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  applyGuardedSecuritiesRefColumnMigrations,
  ensureSqliteColumn,
  executeAdminSchemaMigrations,
  isIdempotentMigrationError,
} from '../schemaMigrationRunner.ts';
import { BASE_SCHEMA_STATEMENTS } from '../migrations.ts';
import { PRICE_UNAVAILABLE_REASON_SCHEMA_STATEMENTS } from '../migrations.ts';
import { markTickerPriceUnavailable } from '../../prices/service.ts';
import type { Env } from '../../shared/types.ts';
import {
  d1Database,
  type D1Database,
  type SqliteDatabase,
} from '../../prices/__tests__/sqliteD1.ts';

async function openPre0103SecuritiesRef(): Promise<{
  db: SqliteDatabase;
  d1: D1Database;
  close: () => void;
}> {
  const moduleName = 'node:sqlite';
  const sqlite = (await import(moduleName)) as { DatabaseSync: new (path: string) => SqliteDatabase };
  const db = new sqlite.DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE securities_ref (
      ticker TEXT PRIMARY KEY,
      price_unavailable INTEGER NOT NULL DEFAULT 0,
      price_checked_at TEXT
    );
    CREATE TABLE transactions (
      id TEXT PRIMARY KEY,
      ticker TEXT,
      source TEXT NOT NULL DEFAULT 'primary',
      created_at TEXT,
      cursor_seq INTEGER
    );
  `);
  return { db, d1: d1Database(db), close: () => db.close() };
}

describe('schemaMigrationRunner', () => {
  it('treats duplicate column errors as idempotent', () => {
    expect(isIdempotentMigrationError('duplicate column name: foo')).toBe(true);
    expect(isIdempotentMigrationError('UNIQUE constraint failed')).toBe(false);
  });

  describe('ensureSqliteColumn', () => {
    let db: SqliteDatabase;
    let d1: D1Database;
    let close: () => void;

    beforeEach(async () => {
      const opened = await openPre0103SecuritiesRef();
      db = opened.db;
      d1 = opened.d1;
      close = opened.close;
    });

    afterEach(() => close());

    it('skips when securities_ref does not exist yet', async () => {
      const emptyDb = new (await import('node:sqlite')).DatabaseSync(':memory:');
      const emptyD1 = d1Database(emptyDb);
      try {
        const result = await ensureSqliteColumn(emptyD1, 'securities_ref', 'price_unavailable_reason', 'TEXT');
        expect(result).toBe('skipped');
      } finally {
        emptyDb.close();
      }
    });

    it('adds price_unavailable_reason when missing', async () => {
      const first = await ensureSqliteColumn(d1, 'securities_ref', 'price_unavailable_reason', 'TEXT');
      expect(first).toBe('added');
      const second = await ensureSqliteColumn(d1, 'securities_ref', 'price_unavailable_reason', 'TEXT');
      expect(second).toBe('present');
      const cols = db.prepare('PRAGMA table_info(securities_ref)').all() as Array<{ name: string }>;
      expect(cols.some((c) => c.name === 'price_unavailable_reason')).toBe(true);
    });

    it('lets markTickerPriceUnavailable write after guarded apply on pre-0103 schema', async () => {
      db.exec(
        `INSERT INTO securities_ref (ticker, price_unavailable) VALUES ('ZZTEST', 0);
         INSERT INTO transactions (id, ticker, source, created_at, cursor_seq)
           VALUES ('tx-zz', 'ZZTEST', 'primary', '2026-01-01T00:00:00.000Z', 1)`,
      );
      await applyGuardedSecuritiesRefColumnMigrations(d1);
      const env = { DB: d1 } as Env;
      await markTickerPriceUnavailable(env, 'ZZTEST', 'operator_junk_symbol', { force: true });
      const row = db
        .prepare('SELECT price_unavailable_reason FROM securities_ref WHERE ticker = ?')
        .get('ZZTEST') as { price_unavailable_reason: string };
      expect(row.price_unavailable_reason).toBe('operator_junk_symbol');
    });
  });

  describe('executeAdminSchemaMigrations', () => {
    let db: SqliteDatabase;
    let d1: D1Database;
    let close: () => void;

    beforeEach(async () => {
      const opened = await openPre0103SecuritiesRef();
      db = opened.db;
      d1 = opened.d1;
      close = opened.close;
    });

    afterEach(() => close());

    it('runs guarded securities_ref columns before replaying ALTER statements', async () => {
      const result = await executeAdminSchemaMigrations(d1, [...PRICE_UNAVAILABLE_REASON_SCHEMA_STATEMENTS]);
      expect(result.failed).toHaveLength(0);
      const cols = db.prepare('PRAGMA table_info(securities_ref)').all() as Array<{ name: string }>;
      expect(cols.some((c) => c.name === 'price_unavailable_reason')).toBe(true);
      expect(result.skipped.length + result.applied.length).toBeGreaterThan(0);
    });

    it('does not fail on an empty database before CREATE TABLE statements run', async () => {
      const emptyDb = new (await import('node:sqlite')).DatabaseSync(':memory:');
      const emptyD1 = d1Database(emptyDb);
      try {
        const result = await executeAdminSchemaMigrations(emptyD1, [...BASE_SCHEMA_STATEMENTS]);
        expect(result.failed).toHaveLength(0);
      } finally {
        emptyDb.close();
      }
    });
  });
});
