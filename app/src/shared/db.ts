/**
 * src/shared/db.ts
 * Typed D1 helper wrappers used by stubs and implemented modules.
 * Thin, dependency-free conveniences around the D1 prepared-statement API.
 */

import type { Env } from './types.ts';
import { recordD1Meta } from './d1Budget.ts';

export type SqlParam = string | number | boolean | null | ArrayBuffer;

function bindParams(stmt: D1PreparedStatement, params: SqlParam[]): D1PreparedStatement {
  return params.length ? stmt.bind(...(params as unknown[])) : stmt;
}

/** Fetch a single row (or null) mapped to T. */
export async function get<T = Record<string, unknown>>(
  db: D1Database,
  sql: string,
  params: SqlParam[] = [],
): Promise<T | null> {
  const stmt = bindParams(db.prepare(sql), params);
  const row = await stmt.first<T>();
  return row ?? null;
}

/** Fetch the first row through .all(), preserving D1 row metadata for aggregate queries. */
export async function first<T = Record<string, unknown>>(
  db: D1Database,
  sql: string,
  params: SqlParam[] = [],
): Promise<T | null> {
  const stmt = bindParams(db.prepare(sql), params);
  const res = await stmt.all<T>();
  recordD1Meta(res?.meta);
  return res?.results?.[0] ?? null;
}

/** Fetch all rows mapped to T[]. */
export async function all<T = Record<string, unknown>>(
  db: D1Database,
  sql: string,
  params: SqlParam[] = [],
): Promise<T[]> {
  const stmt = bindParams(db.prepare(sql), params);
  const res = await stmt.all<T>();
  recordD1Meta(res?.meta);
  return res?.results ?? [];
}

/**
 * True for a SQLite lock the caller must not treat as "unavailable, continue".
 * A missing table during migrate is not one of these.
 */
export function isSqliteLockBusy(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('SQLITE_BUSY')
    || message.includes('database is locked')
    || message.includes('SQL statements in progress')
  );
}

/** Waits before each retry. Three retries, then the last error is rethrown. */
export const SQLITE_LOCK_BUSY_RETRY_DELAYS_MS = [50, 150, 400] as const;

/**
 * Re-run `op` when SQLite is busy or a statement is already in progress.
 * Any other error throws on the first failure, so a missing table is not retried.
 */
export async function withSqliteLockRetry<T>(op: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await op();
    } catch (err) {
      const delayMs = SQLITE_LOCK_BUSY_RETRY_DELAYS_MS[attempt];
      if (!isSqliteLockBusy(err) || delayMs === undefined) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/** Execute a write (INSERT/UPDATE/DELETE) and return the D1 meta result. */
export async function run(
  db: D1Database,
  sql: string,
  params: SqlParam[] = [],
): Promise<D1Result> {
  const stmt = bindParams(db.prepare(sql), params);
  const res = await stmt.run();
  recordD1Meta(res?.meta);
  return res;
}

/**
 * Run multiple prepared statements atomically via D1 batch.
 * Each entry is [sql, params]. Returns the array of results.
 */
export async function batch(
  db: D1Database,
  statements: Array<[string, SqlParam[]]>,
): Promise<D1Result[]> {
  const prepared = statements.map(([sql, params]) => bindParams(db.prepare(sql), params));
  if (typeof db.batch === 'function') {
    const results = await db.batch(prepared);
    for (const r of results ?? []) recordD1Meta(r?.meta);
    return results;
  }

  // Fallback for mock environments (e.g., vitest without db.batch implemented)
  const results: D1Result[] = [];
  for (const stmt of prepared) {
    const r = await stmt.run();
    recordD1Meta(r?.meta);
    results.push(r);
  }
  return results;
}

/**
 * Run already-prepared statements atomically while preserving D1 row metering.
 * Use this at application call sites that need dynamic bind construction.
 */
export async function batchPrepared(
  db: D1Database,
  statements: D1PreparedStatement[],
): Promise<D1Result[]> {
  if (typeof db.batch === 'function') {
    const results = await db.batch(statements);
    for (const r of results ?? []) recordD1Meta(r?.meta);
    return results;
  }
  const results: D1Result[] = [];
  for (const stmt of statements) {
    const r = await stmt.run();
    recordD1Meta(r?.meta);
    results.push(r);
  }
  return results;
}

/** Convenience accessor so callers can pass `env` instead of `env.DB`. */
export function dbOf(env: Env): D1Database {
  return env.DB;
}

/** Parse a JSON text column safely, returning a fallback on null/invalid. */
export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** SQLite stores booleans as 0/1; coerce to a real boolean. */
export function toBool(value: unknown): boolean {
  return value === 1 || value === '1' || value === true;
}

/** Coerce a boolean to SQLite integer form. */
export function fromBool(value: boolean): number {
  return value ? 1 : 0;
}

/**
 * Split an array into chunks no larger than `size`. Used to keep `IN (...)`
 * queries under D1's bound-parameter limit (~100 per statement) when the
 * candidate id list can grow arbitrarily large — e.g. a paginated admin
 * endpoint joining per-row detail for a page of doc_ids. A single unchunked
 * `IN (...)` over more than ~100 ids makes `.bind()` throw, which is easy to
 * accidentally swallow in a broader try/catch and lose the whole result set
 * silently rather than just the overflow rows — chunk first. Default of 90
 * leaves headroom for any other bound params sharing the same statement.
 */
export function chunkArray<T>(items: readonly T[], size = 90): T[][] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`chunkArray: size must be a positive integer, got ${size}`);
  }
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size) as T[]);
  }
  return chunks;
}

/**
 * Execute PRAGMA busy_timeout = 10000; on a database connection to enforce
 * write-lock discipline and prevent instant SQLITE_BUSY errors under concurrency.
 */
export async function ensureBusyTimeout(db: D1Database): Promise<void> {
  try {
    await db.prepare('PRAGMA busy_timeout = 10000;').run();
  } catch {
    /* ignore if unsupported in mock environment */
  }
}

