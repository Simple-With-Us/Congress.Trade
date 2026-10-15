import { all, get, run } from '../shared/db.ts';

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
  if (!(await sqliteTableExists(db, table))) return 'skipped';
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

  return { applied, skipped, failed };
}
