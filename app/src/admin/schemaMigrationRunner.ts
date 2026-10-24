import { all, batchPrepared, get, run } from '../shared/db.ts';
import { APPLE_SUBSCRIPTIONS_NULLABLE_USER_SCHEMA_STATEMENTS } from './migrations.ts';

export const MIGRATE_IDEMPOTENT_ERROR_PATTERNS: readonly RegExp[] = [
  /duplicate column name/i,
  /\b(?:table|index|trigger|view)\s+\S+\s+already exists/i,
];

export function isIdempotentMigrationError(message: string): boolean {
  return MIGRATE_IDEMPOTENT_ERROR_PATTERNS.some((re) => re.test(message));
}

const SAFE_SQL_IDENTIFIER = /^[a-z_][a-z0-9_]*$/i;

async function sqliteTableExists(db: D1Database, table: string): Promise<boolean> {
  if (!SAFE_SQL_IDENTIFIER.test(table)) {
    throw new Error(`unsafe SQLite table identifier: ${table}`);
  }
  const row = await get<{ ok: number }>(
    db,
    `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [table],
  );
  return row != null;
}

/**
 * Add a column only when `PRAGMA table_info` shows it is missing.  Safer than
 * relying on duplicate-column errors alone when new code paths run before
 * POST /api/admin/migrate (Coolify auto-deploy does not call ship.sh).
 */
export async function ensureSqliteColumn(
  db: D1Database,
  table: string,
  column: string,
  columnDef: string,
): Promise<'added' | 'present' | 'skipped'> {
  if (!SAFE_SQL_IDENTIFIER.test(table) || !SAFE_SQL_IDENTIFIER.test(column)) {
    throw new Error(`unsafe SQLite identifier: ${table}.${column}`);
  }
  if (!(await sqliteTableExists(db, table))) {
    return 'skipped';
  }
  const rows = await all<{ name: string }>(db, `PRAGMA table_info("${table}")`);
  if (rows.some((row) => row.name === column)) return 'present';
  try {
    await run(db, `ALTER TABLE ${table} ADD COLUMN ${column} ${columnDef}`);
  } catch (err) {
    const msg = (err as Error).message || String(err);
    if (isIdempotentMigrationError(msg)) return 'present';
    throw err;
  }
  return 'added';
}

/** Guarded applies for migrations 0103–0104 on `securities_ref`. */
export async function applyGuardedSecuritiesRefColumnMigrations(db: D1Database): Promise<'applied' | 'skipped'> {
  if (!(await sqliteTableExists(db, 'securities_ref'))) return 'skipped';
  await ensureSqliteColumn(db, 'securities_ref', 'price_unavailable_reason', 'TEXT');
  await ensureSqliteColumn(db, 'securities_ref', 'enrichment_unavailable', 'INTEGER NOT NULL DEFAULT 0');
  await ensureSqliteColumn(db, 'securities_ref', 'enrichment_unavailable_reason', 'TEXT');
  await ensureSqliteColumn(db, 'securities_ref', 'enrichment_checked_at', 'TEXT');
  return 'applied';
}

/** Label for the guarded 0091 rebuild in `failed[]` and the logs. */
export const APPLE_SUBSCRIPTIONS_GUARD_LABEL = '(guarded 0091 apple_subscriptions rebuild)';

/**
 * Run statements as ONE libsql write batch (BEGIN IMMEDIATE, rolled back
 * whole on any error).  batchPrepared falls back to one autocommit statement
 * at a time when db.batch is missing; a table swap must never run that way.
 */
async function runAtomicSchemaBatch(db: D1Database, statements: readonly string[]): Promise<void> {
  if (typeof db.batch !== 'function') {
    throw new Error('guarded schema rebuild needs db.batch (one write transaction)');
  }
  await batchPrepared(db, statements.map((sql) => db.prepare(sql)));
}

/** CREATE INDEX / CREATE TRIGGER text from sqlite_master (which drops IF NOT EXISTS), made replay-safe. */
function createIfNotExists(sql: string): string {
  return sql.replace(
    /^\s*CREATE\s+(UNIQUE\s+)?(INDEX|TRIGGER)\s+(?:IF\s+NOT\s+EXISTS\s+)?/i,
    (_match, unique: string | undefined, kind: string) =>
      `CREATE ${unique ? 'UNIQUE ' : ''}${kind.toUpperCase()} IF NOT EXISTS `,
  );
}

/** Rows of apple_subscriptions_new whose key apple_subscriptions does not have. */
async function appleShadowRowsMissingFromLive(db: D1Database): Promise<number> {
  const row = await get<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM apple_subscriptions_new AS s
      WHERE NOT EXISTS (
        SELECT 1 FROM apple_subscriptions AS l WHERE l.original_transaction_id = s.original_transaction_id
      )`,
  );
  return Number(row?.n ?? 0);
}

/**
 * Guarded apply for migration 0091 (`apple_subscriptions.user_id` drops NOT
 * NULL).  Runs the rebuild only while PRAGMA table_info still shows user_id
 * NOT NULL, and as one write batch: CREATE / INSERT / DROP / RENAME /
 * indexes.  A BUSY anywhere rolls the whole swap back, so the live table is
 * never dropped without its replacement.
 *
 * A leftover apple_subscriptions_new is dropped first only when every row in
 * it is also in the live table (a stale copy), so it never replaces live
 * rows.  When it holds rows the live table lacks and the live table is
 * empty, an earlier non-atomic swap landed its DROP and missed its RENAME,
 * and the replay's 0081 CREATE TABLE IF NOT EXISTS then made the empty
 * table: the batch finishes that swap and keeps the shadow's rows.  When
 * the shadow holds rows the live table lacks and the live table is not
 * empty, it throws and changes nothing.
 */
export async function applyGuardedAppleSubscriptionsNullableUserMigration(
  db: D1Database,
): Promise<'applied' | 'recovered' | 'skipped'> {
  if (!(await sqliteTableExists(db, 'apple_subscriptions'))) {
    // The pre-guard replay could land its DROP and miss its RENAME, leaving
    // the copied rows only in the shadow.  Finish that rename now, before the
    // replay's 0081 CREATE TABLE IF NOT EXISTS makes an empty live table (the
    // shadow check below also recovers from that state).
    if (!(await sqliteTableExists(db, 'apple_subscriptions_new'))) return 'skipped';
    const renameAt = APPLE_SUBSCRIPTIONS_NULLABLE_USER_SCHEMA_STATEMENTS.findIndex((sql) =>
      /RENAME\s+TO\s+apple_subscriptions\b/i.test(sql)
    );
    await runAtomicSchemaBatch(db, APPLE_SUBSCRIPTIONS_NULLABLE_USER_SCHEMA_STATEMENTS.slice(renameAt));
    return 'recovered';
  }
  const columns = await all<{ name: string; notnull: number }>(db, 'PRAGMA table_info("apple_subscriptions")');
  const userId = columns.find((col) => col.name === 'user_id');
  if (!userId || Number(userId.notnull) !== 1) return 'skipped';
  // DROP TABLE takes the old table's indexes and triggers with it.  Recreate
  // the ones a later migration added (0093's status index on a fresh
  // database) after the rename, per SQLite's documented table-rebuild steps.
  const dependents = await all<{ sql: string }>(
    db,
    `SELECT sql FROM sqlite_master
      WHERE tbl_name = 'apple_subscriptions' AND type IN ('index', 'trigger') AND sql IS NOT NULL
      ORDER BY rowid`,
  );
  const recreateDependents = dependents.map((row) => createIfNotExists(row.sql));
  if (
    (await sqliteTableExists(db, 'apple_subscriptions_new')) &&
    (await appleShadowRowsMissingFromLive(db)) > 0
  ) {
    if (await get<{ ok: number }>(db, 'SELECT 1 AS ok FROM apple_subscriptions LIMIT 1')) {
      throw new Error(
        'apple_subscriptions_new holds rows that apple_subscriptions lacks, and apple_subscriptions is not empty; ' +
          'left both tables unchanged for a manual merge',
      );
    }
    // The 0091 list without the shadow DROP: CREATE ... IF NOT EXISTS keeps
    // the shadow, and its INSERT copies any row the empty table has gained
    // since this check (a key clash fails the batch and rolls it back).
    await runAtomicSchemaBatch(db, [...APPLE_SUBSCRIPTIONS_NULLABLE_USER_SCHEMA_STATEMENTS, ...recreateDependents]);
    return 'recovered';
  }
  await runAtomicSchemaBatch(db, [
    'DROP TABLE IF EXISTS apple_subscriptions_new',
    ...APPLE_SUBSCRIPTIONS_NULLABLE_USER_SCHEMA_STATEMENTS,
    ...recreateDependents,
  ]);
  return 'applied';
}

/** One guarded 0091 attempt; returns the error message instead of throwing. */
async function tryGuardedAppleSubscriptionsRebuild(db: D1Database): Promise<string | null> {
  try {
    await applyGuardedAppleSubscriptionsNullableUserMigration(db);
    return null;
  } catch (err) {
    const msg = (err as Error).message || String(err);
    console.error(`[schema-migrate] ${msg} on statement: ${APPLE_SUBSCRIPTIONS_GUARD_LABEL}`);
    return msg;
  }
}

export interface SchemaMigrationRunResult {
  applied: string[];
  skipped: string[];
  failed: Array<{ sql: string; error: string }>;
}

export async function executeAdminSchemaMigrations(
  db: D1Database,
  statements: readonly string[],
  options: { runGuardedSecuritiesRef?: boolean } = {},
): Promise<SchemaMigrationRunResult> {
  const runGuarded = options.runGuardedSecuritiesRef !== false;

  const applied: string[] = [];
  const skipped: string[] = [];
  const failed: Array<{ sql: string; error: string }> = [];

  await run(db, 'PRAGMA busy_timeout = 10000').catch(() => {});

  // Pre-loop: heal prod drift when the table already exists (deploy-before-migrate).
  if (runGuarded) {
    await applyGuardedSecuritiesRefColumnMigrations(db);
  }
  // Pre-loop so a legacy table is rebuilt before the replay indexes it.  A
  // failure here is retried post-loop, which decides what failed[] reports.
  await tryGuardedAppleSubscriptionsRebuild(db);

  for (const sql of statements) {
    let attempts = 0;
    let lastErr: Error | null = null;
    while (attempts < 3) {
      attempts++;
      try {
        await run(db, sql);
        applied.push(sql);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err as Error;
        const msg = lastErr.message || String(lastErr);
        if (isIdempotentMigrationError(msg)) {
          skipped.push(sql);
          lastErr = null;
          break;
        }
        if (/\bSQLITE_BUSY\b/i.test(msg) && attempts < 3) {
          await new Promise((r) => setTimeout(r, attempts * 75));
          continue;
        }
        break;
      }
    }
    if (lastErr) {
      const msg = lastErr.message || String(lastErr);
      console.error(`[schema-migrate] ${msg} on statement: ${sql}`);
      failed.push({ sql, error: msg });
    }
  }

  // Post-loop: after CREATE TABLE runs on a clean DB, add any columns the replay missed.
  if (runGuarded) {
    await applyGuardedSecuritiesRefColumnMigrations(db);
  }
  // Post-loop: a clean DB gets apple_subscriptions from the 0081 CREATE in the loop.
  const appleRebuildError = await tryGuardedAppleSubscriptionsRebuild(db);
  if (appleRebuildError) {
    failed.push({ sql: APPLE_SUBSCRIPTIONS_GUARD_LABEL, error: appleRebuildError });
  }

  return { applied, skipped, failed };
}
