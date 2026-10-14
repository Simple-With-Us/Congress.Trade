/**
 * src/prices/__tests__/sqliteD1.ts
 *
 * Shared test helper: an in-memory node:sqlite database wrapped in the minimal
 * D1 surface the price/backfill code uses (prepare().bind().first()/.all()/.run()
 * + batch()), with the real migration files applied. Not a test file itself —
 * it defines no `describe`/`it`, and lives under __tests__ so it's excluded from
 * coverage. Mirrors the wrapper proven in admin/__tests__/migrations.test.ts.
 */
import { readFileSync, readdirSync } from 'node:fs';

export interface D1Result {
  success: boolean;
  meta: any;
  results?: any[];
}
export interface D1PreparedStatement {
  bind(...values: any[]): D1PreparedStatement;
  first<T = any>(): Promise<T | null>;
  run(): Promise<D1Result>;
  all<T = any>(): Promise<{ results: T[] }>;
}
export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}
interface SqliteRunResult {
  changes: number | bigint;
}
interface SqliteStatement {
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Array<Record<string, unknown>>;
  run(...params: unknown[]): SqliteRunResult;
}
export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}
interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDatabase;
}

const migrationsUrl = new URL(
  '../../../migrations/',
  (import.meta as ImportMeta & { url: string }).url,
);

async function sqliteDatabase(): Promise<SqliteDatabase> {
  // Dynamic module name keeps Worker production types free of Node-only APIs.
  const moduleName = 'node:sqlite';
  const sqlite = (await import(moduleName)) as SqliteModule;
  return new sqlite.DatabaseSync(':memory:');
}

function migrationSqlFiles(beforeExclusive?: string): string[] {
  return readdirSync(migrationsUrl as unknown as string)
    .filter((name: string) => name.endsWith('.sql'))
    .sort()
    .filter((name) => !beforeExclusive || name.localeCompare(beforeExclusive) < 0);
}

function applyMigrationFiles(db: SqliteDatabase, beforeExclusive?: string): void {
  for (const name of migrationSqlFiles(beforeExclusive)) {
    db.exec(readFileSync(new URL(name, migrationsUrl) as unknown as string, 'utf8'));
  }
}

/** Wrap a node:sqlite DB in the async D1 shape the app's db helpers expect. */
export function d1Database(db: SqliteDatabase): D1Database {
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
        return { success: true, meta: { changes: Number(result.changes) } } as unknown as D1Result;
      },
      async all<T>() {
        return { results: db.prepare(sql).all(...params) as T[] };
      },
    };
    return statement;
  };
  return {
    prepare,
    async batch(statements: D1PreparedStatement[]) {
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

/** Open a fresh in-memory DB with every migration applied. */
export async function openMigratedD1(): Promise<{
  db: SqliteDatabase;
  d1: D1Database;
  close: () => void;
}> {
  const db = await sqliteDatabase();
  applyMigrationFiles(db);
  return { db, d1: d1Database(db), close: () => db.close() };
}

/** Open a DB with migrations strictly before 0104 (pre enrichment_unavailable columns). */
export async function openMigratedD1Before0104(): Promise<{
  db: SqliteDatabase;
  d1: D1Database;
  close: () => void;
}> {
  const db = await sqliteDatabase();
  applyMigrationFiles(db, '0104_enrichment_unavailable.sql');
  return { db, d1: d1Database(db), close: () => db.close() };
}
