import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createClient, type Client, type InStatement, type TransactionMode } from '@libsql/client';
import {
  APPLE_SUBSCRIPTIONS_GUARD_LABEL,
  applyGuardedAppleSubscriptionsNullableUserMigration,
  applyGuardedFilingsColumnMigrations,
  applyGuardedRetractionColumnMigrations,
  applyGuardedSecuritiesRefColumnMigrations,
  ensureSqliteColumn,
  executeAdminSchemaMigrations,
  isIdempotentMigrationError,
} from '../schemaMigrationRunner.ts';
import {
  APPLE_IAP_SCHEMA_STATEMENTS,
  APPLE_SUBSCRIPTIONS_NULLABLE_USER_SCHEMA_STATEMENTS,
  BASE_SCHEMA_STATEMENTS,
  FILINGS_FILING_STATUS_SCHEMA_STATEMENTS,
  TRADE_RETRACTIONS_SCHEMA_STATEMENTS,
  PREMIUM_ACTIVATION_ALERT_SCHEMA_STATEMENTS,
  PRICE_UNAVAILABLE_REASON_SCHEMA_STATEMENTS,
} from '../migrations.ts';
import { D1DatabaseShim } from '../../deno/shims.ts';
import { markTickerPriceUnavailable } from '../../prices/service.ts';
import { SQLITE_BUSY_TIMEOUT_MS, SQLITE_LOCK_BUSY_RETRY_DELAYS_MS } from '../../shared/db.ts';
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

    it('skips add when the target table does not exist yet', async () => {
      const sqlite = (await import('node:sqlite')) as { DatabaseSync: new (path: string) => SqliteDatabase };
      const emptyDb = new sqlite.DatabaseSync(':memory:');
      const emptyD1 = d1Database(emptyDb);
      const status = await ensureSqliteColumn(emptyD1, 'securities_ref', 'price_unavailable_reason', 'TEXT');
      expect(status).toBe('skipped');
      emptyDb.close();
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

    it('guards 0107 filings.filing_status with PRAGMA table_info so repeated runs never fail', async () => {
      db.exec('CREATE TABLE filings (doc_id TEXT PRIMARY KEY)');
      const statusCol = () =>
        (db.prepare('PRAGMA table_info(filings)').all() as Array<{ name: string }>)
          .filter((c) => c.name === 'filing_status').length;
      // Pre-loop guard adds the column; the replay's plain ALTER then skips.
      const first = await executeAdminSchemaMigrations(d1, [...FILINGS_FILING_STATUS_SCHEMA_STATEMENTS]);
      expect(first.failed).toHaveLength(0);
      expect(first.skipped).toEqual([...FILINGS_FILING_STATUS_SCHEMA_STATEMENTS]);
      expect(statusCol()).toBe(1);
      const second = await executeAdminSchemaMigrations(d1, [...FILINGS_FILING_STATUS_SCHEMA_STATEMENTS]);
      expect(second.failed).toHaveLength(0);
      expect(statusCol()).toBe(1);
      expect(await applyGuardedFilingsColumnMigrations(d1)).toBe('applied');
      expect(statusCol()).toBe(1);
    });

    it('guards 0108 delivery_outbox.event_kind with PRAGMA table_info so repeated runs never fail', async () => {
      db.exec(`CREATE TABLE delivery_outbox (tx_id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0, available_at TEXT, last_error TEXT, created_at TEXT, updated_at TEXT)`);
      db.exec('CREATE TABLE tx_cursor_seq (seq INTEGER PRIMARY KEY AUTOINCREMENT, tx_id TEXT)');
      db.exec('ALTER TABLE transactions ADD COLUMN doc_id TEXT');
      db.exec('ALTER TABLE transactions ADD COLUMN filer_id TEXT');
      db.exec('ALTER TABLE transactions ADD COLUMN deprecated_at TEXT');
      db.exec('ALTER TABLE transactions ADD COLUMN deprecated_reason TEXT');
      const kindCols = () =>
        (db.prepare('PRAGMA table_info(delivery_outbox)').all() as Array<{ name: string }>)
          .filter((c) => c.name === 'event_kind').length;
      for (let run = 0; run < 2; run += 1) {
        const result = await executeAdminSchemaMigrations(d1, [...TRADE_RETRACTIONS_SCHEMA_STATEMENTS]);
        expect(result.failed).toEqual([]);
        expect(kindCols()).toBe(1);
      }
      expect(await applyGuardedRetractionColumnMigrations(d1)).toBe('applied');
      expect(kindCols()).toBe(1);
    });

    it('skips guarded securities_ref preflight on an empty database then applies CREATE/ALTER', async () => {
      const sqlite = (await import('node:sqlite')) as { DatabaseSync: new (path: string) => SqliteDatabase };
      const emptyDb = new sqlite.DatabaseSync(':memory:');
      const emptyD1 = d1Database(emptyDb);
      const bootstrap = [
        `CREATE TABLE IF NOT EXISTS securities_ref (
           ticker TEXT PRIMARY KEY,
           price_unavailable INTEGER NOT NULL DEFAULT 0,
           price_checked_at TEXT
         )`,
        ...PRICE_UNAVAILABLE_REASON_SCHEMA_STATEMENTS,
      ];
      const result = await executeAdminSchemaMigrations(emptyD1, bootstrap);
      expect(result.failed).toHaveLength(0);
      const cols = emptyDb.prepare('PRAGMA table_info(securities_ref)').all() as Array<{ name: string }>;
      expect(cols.some((c) => c.name === 'price_unavailable_reason')).toBe(true);
      emptyDb.close();
    });

    it('does not fail on an empty database when bootstrapping base schema', async () => {
      const sqlite = (await import('node:sqlite')) as { DatabaseSync: new (path: string) => SqliteDatabase };
      const emptyDb = new sqlite.DatabaseSync(':memory:');
      const emptyD1 = d1Database(emptyDb);
      const result = await executeAdminSchemaMigrations(emptyD1, [...BASE_SCHEMA_STATEMENTS]);
      expect(result.failed).toHaveLength(0);
      emptyDb.close();
    });
  });

  // ---- guarded 0091 apple_subscriptions rebuild (CT-2442) -----------------
  // These run production's D1 shim over a real in-memory libsql client, so a
  // batch is a real BEGIN IMMEDIATE ... COMMIT with rollback on error.
  describe('applyGuardedAppleSubscriptionsNullableUserMigration', () => {
    const BUSY = 'SQLITE_BUSY: database is locked';
    const SHADOW_DDL = APPLE_SUBSCRIPTIONS_NULLABLE_USER_SCHEMA_STATEMENTS[0];
    const APPLE_STATUS_INDEX = PREMIUM_ACTIVATION_ALERT_SCHEMA_STATEMENTS.filter((sql) =>
      sql.includes('ON apple_subscriptions')
    );

    interface Lib {
      client: Client;
      d1: D1Database;
      batches: () => number;
    }

    let opened: Client[] = [];
    afterEach(() => {
      for (const client of opened) client.close();
      opened = [];
      vi.restoreAllMocks();
    });

    /**
     * `busyOn`: every statement whose SQL matches fails with SQLITE_BUSY, in
     * a batch too.  libsql reads the SQL inside its open transaction, so the
     * failure lands mid-batch and the batch really rolls back.  `onBusy` runs
     * just before each of those failures.
     */
    function openLib(busyOn?: RegExp, onBusy?: () => void): Lib {
      const client = createClient({ url: 'file::memory:' });
      opened.push(client);
      const faulty = (stmt: InStatement): InStatement => {
        const sql = typeof stmt === 'string' ? stmt : stmt.sql;
        if (!busyOn?.test(sql)) return stmt;
        return {
          get sql(): string {
            onBusy?.();
            throw new Error(BUSY);
          },
          args: [],
        };
      };
      let batches = 0;
      const wrapped = {
        execute: (stmt: InStatement) => client.execute(faulty(stmt)),
        batch: (stmts: InStatement[], mode?: TransactionMode) => {
          batches += 1;
          return client.batch(stmts.map(faulty), mode);
        },
      };
      const d1 = new D1DatabaseShim(wrapped as unknown as Client) as unknown as D1Database;
      return { client, d1, batches: () => batches };
    }

    async function exec(client: Client, statements: readonly string[]): Promise<void> {
      for (const sql of statements) await client.execute(sql);
    }

    function insertRow(table: string, id: string, userId: string | null, status: string): string {
      const user = userId == null ? 'NULL' : `'${userId}'`;
      return `INSERT INTO ${table} (original_transaction_id, user_id, product_id, plan, status, created_at, updated_at)
              VALUES ('${id}', ${user}, 'trade.congress.premium.monthly', 'monthly', '${status}',
                      '2026-10-01T00:00:00.000Z', '2026-10-20T00:00:00.000Z')`;
    }

    /** Pre-0091 table (user_id NOT NULL) plus the 0093 index on it. */
    async function seedLegacy(client: Client): Promise<void> {
      await exec(client, [...APPLE_IAP_SCHEMA_STATEMENTS, ...APPLE_STATUS_INDEX]);
      await exec(client, [
        insertRow('apple_subscriptions', 'otx-1', 'user-1', 'revoked'),
        insertRow('apple_subscriptions', 'otx-2', 'user-2', 'active'),
      ]);
    }

    async function rows(client: Client): Promise<string[]> {
      const res = await client.execute(
        'SELECT original_transaction_id, user_id, status FROM apple_subscriptions ORDER BY original_transaction_id',
      );
      return res.rows.map((row) => `${row.original_transaction_id}:${row.user_id ?? 'null'}:${row.status}`);
    }

    async function userIdNotNull(client: Client): Promise<number> {
      const res = await client.execute('PRAGMA table_info("apple_subscriptions")');
      return Number(res.rows.find((row) => row.name === 'user_id')?.notnull);
    }

    async function names(client: Client, type: 'table' | 'index'): Promise<string[]> {
      const res = await client.execute({
        sql: `SELECT name FROM sqlite_master
               WHERE type = ? AND name LIKE '%apple_subscriptions%' AND sql IS NOT NULL
               ORDER BY name`,
        args: [type],
      });
      return res.rows.map((row) => String(row.name));
    }

    const LIVE_ROWS = ['otx-1:user-1:revoked', 'otx-2:user-2:active'];
    const ALL_INDEXES = [
      'idx_apple_subscriptions_status_expires',
      'idx_apple_subscriptions_user',
      'idx_apple_subscriptions_user_active',
    ];

    it('rebuilds a pre-0091 table in one batch and keeps rows and later indexes', async () => {
      const lib = openLib();
      await seedLegacy(lib.client);

      expect(await applyGuardedAppleSubscriptionsNullableUserMigration(lib.d1)).toBe('applied');
      expect(lib.batches()).toBe(1);
      expect(await userIdNotNull(lib.client)).toBe(0);
      expect(await rows(lib.client)).toEqual(LIVE_ROWS);
      expect(await names(lib.client, 'table')).toEqual(['apple_subscriptions']);
      expect(await names(lib.client, 'index')).toEqual(ALL_INDEXES);

      // An anonymous device purchase now fits, and a second run does nothing.
      await lib.client.execute(insertRow('apple_subscriptions', 'otx-3', null, 'active'));
      expect(await applyGuardedAppleSubscriptionsNullableUserMigration(lib.d1)).toBe('skipped');
      expect(lib.batches()).toBe(1);
      expect(await rows(lib.client)).toEqual([...LIVE_ROWS, 'otx-3:null:active']);
    });

    it('keeps the table when CREATE hits SQLITE_BUSY, although the DROP after it would succeed', async () => {
      const lib = openLib(/CREATE TABLE IF NOT EXISTS apple_subscriptions_new/i);
      await seedLegacy(lib.client);

      // Boot and POST /api/admin/migrate both call this runner.
      const result = await executeAdminSchemaMigrations(lib.d1, []);
      expect(result.failed).toEqual([
        { sql: APPLE_SUBSCRIPTIONS_GUARD_LABEL, error: expect.stringContaining('SQLITE_BUSY') },
      ]);
      // This BUSY returns at once, so the post-loop attempt still runs: two
      // guarded attempts, each retried by withSqliteLockRetry.
      expect(lib.batches()).toBe(2 * (SQLITE_LOCK_BUSY_RETRY_DELAYS_MS.length + 1));
      expect(await rows(lib.client)).toEqual(LIVE_ROWS);
      expect(await userIdNotNull(lib.client)).toBe(1);
      expect(await names(lib.client, 'table')).toEqual(['apple_subscriptions']);
      expect(await names(lib.client, 'index')).toEqual(ALL_INDEXES);
    });

    it('does not run the post-loop attempt after a BUSY that waited out the busy timeout', async () => {
      // Fake clock: each BUSY costs the full driver busy timeout, as a real
      // cross-process lock conflict does.
      let clock = Date.now();
      vi.spyOn(Date, 'now').mockImplementation(() => clock);
      const lib = openLib(/CREATE TABLE IF NOT EXISTS apple_subscriptions_new/i, () => {
        clock += SQLITE_BUSY_TIMEOUT_MS;
      });
      await seedLegacy(lib.client);

      const result = await executeAdminSchemaMigrations(lib.d1, []);
      // The pre-loop failure is the one reported, after one batch: neither
      // withSqliteLockRetry nor the post-loop pass stacks a second wait.
      expect(result.failed).toEqual([
        { sql: APPLE_SUBSCRIPTIONS_GUARD_LABEL, error: expect.stringContaining('SQLITE_BUSY') },
      ]);
      expect(lib.batches()).toBe(1);
      expect(await rows(lib.client)).toEqual(LIVE_ROWS);
      expect(await userIdNotNull(lib.client)).toBe(1);
      expect(await names(lib.client, 'table')).toEqual(['apple_subscriptions']);
    });

    it('rolls the whole swap back when SQLITE_BUSY lands mid-batch', async () => {
      // The live table is already dropped inside the batch when RENAME fails.
      const lib = openLib(/RENAME TO apple_subscriptions/i);
      await seedLegacy(lib.client);

      await expect(applyGuardedAppleSubscriptionsNullableUserMigration(lib.d1)).rejects.toThrow(/SQLITE_BUSY/);
      expect(await rows(lib.client)).toEqual(LIVE_ROWS);
      expect(await userIdNotNull(lib.client)).toBe(1);
      expect(await names(lib.client, 'table')).toEqual(['apple_subscriptions']);
      expect(await names(lib.client, 'index')).toEqual(ALL_INDEXES);
    });

    it('skips without writing when user_id is already nullable', async () => {
      const lib = openLib();
      await exec(lib.client, [
        SHADOW_DDL.replace('apple_subscriptions_new', 'apple_subscriptions'),
        insertRow('apple_subscriptions', 'otx-1', null, 'active'),
      ]);

      expect(await applyGuardedAppleSubscriptionsNullableUserMigration(lib.d1)).toBe('skipped');
      expect(lib.batches()).toBe(0);
      expect(await rows(lib.client)).toEqual(['otx-1:null:active']);
    });

    it('never lets a leftover apple_subscriptions_new replace live rows', async () => {
      // A pre-guard replay hit BUSY on its DROP after CREATE + INSERT, leaving
      // a filled shadow.  The live rows changed after that copy.
      const stale = [
        SHADOW_DDL,
        insertRow('apple_subscriptions_new', 'otx-1', 'user-1', 'active'),
        insertRow('apple_subscriptions_new', 'otx-2', 'user-2', 'expired'),
      ];

      const legacy = openLib();
      await seedLegacy(legacy.client);
      await exec(legacy.client, stale);
      expect(await applyGuardedAppleSubscriptionsNullableUserMigration(legacy.d1)).toBe('applied');
      expect(await rows(legacy.client)).toEqual(LIVE_ROWS);
      expect(await userIdNotNull(legacy.client)).toBe(0);
      expect(await names(legacy.client, 'table')).toEqual(['apple_subscriptions']);

      // Next to an already-migrated table the guard does not touch either one.
      const migrated = openLib();
      await exec(migrated.client, [
        SHADOW_DDL.replace('apple_subscriptions_new', 'apple_subscriptions'),
        insertRow('apple_subscriptions', 'otx-1', 'user-1', 'revoked'),
        ...stale,
      ]);
      expect(await applyGuardedAppleSubscriptionsNullableUserMigration(migrated.d1)).toBe('skipped');
      expect(migrated.batches()).toBe(0);
      expect(await rows(migrated.client)).toEqual(['otx-1:user-1:revoked']);
    });

    it('keeps the shadow when it is the only copy of the rows and the replay made an empty table', async () => {
      // The reviewed interleaving: an old-code replay (a hold cloned from the
      // previous image) runs CREATE _new + INSERT + DROP after this run's
      // pre-loop guard and misses its RENAME; this run's own 0081 CREATE
      // TABLE IF NOT EXISTS then makes an empty user_id NOT NULL table.
      const lib = openLib();
      await exec(lib.client, [
        SHADOW_DDL.replace('apple_subscriptions_new', 'apple_subscriptions'),
        insertRow('apple_subscriptions', 'otx-1', 'user-1', 'revoked'),
        insertRow('apple_subscriptions', 'otx-2', 'user-2', 'active'),
        insertRow('apple_subscriptions', 'otx-3', null, 'active'),
      ]);
      const oldReplayCopyAndDrop = APPLE_SUBSCRIPTIONS_NULLABLE_USER_SCHEMA_STATEMENTS.slice(0, 3);
      expect(oldReplayCopyAndDrop[2]).toBe('DROP TABLE apple_subscriptions');

      const result = await executeAdminSchemaMigrations(lib.d1, [
        ...oldReplayCopyAndDrop,
        ...APPLE_IAP_SCHEMA_STATEMENTS,
        ...APPLE_STATUS_INDEX,
      ]);
      expect(result.failed).toEqual([]);
      expect(await rows(lib.client)).toEqual([...LIVE_ROWS, 'otx-3:null:active']);
      expect(await userIdNotNull(lib.client)).toBe(0);
      expect(await names(lib.client, 'table')).toEqual(['apple_subscriptions']);
      expect(await names(lib.client, 'index')).toEqual(ALL_INDEXES);
    });

    it('changes nothing when the shadow holds rows that a non-empty live table lacks', async () => {
      const lib = openLib();
      await seedLegacy(lib.client);
      await exec(lib.client, [SHADOW_DDL, insertRow('apple_subscriptions_new', 'otx-9', null, 'active')]);

      const result = await executeAdminSchemaMigrations(lib.d1, []);
      expect(result.failed).toEqual([
        { sql: APPLE_SUBSCRIPTIONS_GUARD_LABEL, error: expect.stringContaining('apple_subscriptions_new holds rows') },
      ]);
      expect(lib.batches()).toBe(0);
      expect(await rows(lib.client)).toEqual(LIVE_ROWS);
      expect(await userIdNotNull(lib.client)).toBe(1);
      expect(await names(lib.client, 'table')).toEqual(['apple_subscriptions', 'apple_subscriptions_new']);
      const shadow = await lib.client.execute('SELECT original_transaction_id FROM apple_subscriptions_new');
      expect(shadow.rows.map((row) => String(row.original_transaction_id))).toEqual(['otx-9']);
    });

    it('finishes an interrupted rename when only the shadow holds the rows', async () => {
      // The pre-guard replay's DROP landed and its RENAME did not.
      const lib = openLib();
      await exec(lib.client, [
        SHADOW_DDL,
        insertRow('apple_subscriptions_new', 'otx-1', 'user-1', 'revoked'),
        insertRow('apple_subscriptions_new', 'otx-2', 'user-2', 'active'),
      ]);

      // The pre-loop pass renames it before the replay's 0081 CREATE TABLE
      // IF NOT EXISTS can make an empty table.
      const result = await executeAdminSchemaMigrations(lib.d1, [...APPLE_IAP_SCHEMA_STATEMENTS, ...APPLE_STATUS_INDEX]);
      expect(result.failed).toEqual([]);
      expect(await rows(lib.client)).toEqual(LIVE_ROWS);
      expect(await userIdNotNull(lib.client)).toBe(0);
      expect(await names(lib.client, 'table')).toEqual(['apple_subscriptions']);
      expect(await names(lib.client, 'index')).toEqual(ALL_INDEXES);
    });

    it('restores the 0093 index when a standalone call finishes an interrupted rename', async () => {
      // No replay runs after this call to re-add the index that the
      // interrupted swap's DROP took with the old table.
      const lib = openLib();
      await exec(lib.client, [
        SHADOW_DDL,
        insertRow('apple_subscriptions_new', 'otx-1', 'user-1', 'revoked'),
        insertRow('apple_subscriptions_new', 'otx-2', 'user-2', 'active'),
      ]);

      expect(await applyGuardedAppleSubscriptionsNullableUserMigration(lib.d1)).toBe('recovered');
      expect(lib.batches()).toBe(1);
      expect(await rows(lib.client)).toEqual(LIVE_ROWS);
      expect(await names(lib.client, 'table')).toEqual(['apple_subscriptions']);
      expect(await names(lib.client, 'index')).toEqual(ALL_INDEXES);
    });

    it('refuses to rename an empty shadow over a missing live table', async () => {
      // The pre-guard replay's INSERT copy failed and its DROP landed, so no
      // copy of the rows is left.
      const lib = openLib();
      await exec(lib.client, [SHADOW_DDL]);

      await expect(applyGuardedAppleSubscriptionsNullableUserMigration(lib.d1)).rejects.toThrow(
        /apple_subscriptions is missing and apple_subscriptions_new is empty/,
      );
      expect(lib.batches()).toBe(0);
      expect(await names(lib.client, 'table')).toEqual(['apple_subscriptions_new']);
    });

    it('reports a lost ledger in failed[] although the replay then makes an empty table', async () => {
      const lib = openLib();
      await exec(lib.client, [SHADOW_DDL]);

      const result = await executeAdminSchemaMigrations(lib.d1, [...APPLE_IAP_SCHEMA_STATEMENTS, ...APPLE_STATUS_INDEX]);
      // The pre-loop failure is final: a post-loop attempt would find the
      // replay's empty 0081 table and rebuild it as 'applied'.
      expect(result.failed).toEqual([
        { sql: APPLE_SUBSCRIPTIONS_GUARD_LABEL, error: expect.stringContaining('apple_subscriptions_new is empty') },
      ]);
      expect(lib.batches()).toBe(0);
      expect(await rows(lib.client)).toEqual([]);
      expect(await names(lib.client, 'table')).toEqual(['apple_subscriptions', 'apple_subscriptions_new']);
    });

    it('rebuilds after the replay on a clean database and keeps the 0093 index', async () => {
      const lib = openLib();
      const result = await executeAdminSchemaMigrations(lib.d1, [...APPLE_IAP_SCHEMA_STATEMENTS, ...APPLE_STATUS_INDEX]);
      expect(result.failed).toEqual([]);
      expect(await userIdNotNull(lib.client)).toBe(0);
      expect(await names(lib.client, 'index')).toEqual(ALL_INDEXES);
    });

    it('refuses to rebuild one statement at a time when db.batch is missing', async () => {
      const lib = openLib();
      await seedLegacy(lib.client);
      const noBatch = { prepare: (sql: string) => lib.d1.prepare(sql) } as unknown as D1Database;

      await expect(applyGuardedAppleSubscriptionsNullableUserMigration(noBatch)).rejects.toThrow(/db\.batch/);
      expect(await rows(lib.client)).toEqual(LIVE_ROWS);
      expect(await userIdNotNull(lib.client)).toBe(1);
    });
  });
});
