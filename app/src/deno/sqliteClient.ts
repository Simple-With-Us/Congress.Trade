/**
 * Local file-SQLite client settings (CONGRESS-TRADE-1M / 1J).
 *
 * `@libsql/client` 0.18 pools file databases at concurrency 20 and, unless
 * `timeout` is set, every new connection has busy_timeout 0. Boot pragmas
 * run through `execute()`, which borrows one connection and returns it, so
 * the other connections fail SQLITE_BUSY immediately and their read
 * snapshots pin the WAL. Litestream 0.5.13 cannot PASSIVE-checkpoint past
 * that snapshot; past ~500MB it issues a blocking TRUNCATE and every write
 * stays busy (house/senate polling then skips its tick).
 *
 * A file client therefore uses one connection. All boot pragmas go through
 * one `executeMultiple` so they stick to that connection. `timeout` is still
 * set: it is applied inside every connection the driver opens, including a
 * connection created after reconnect. Remote libsql URLs keep the driver's
 * defaults — they are not the on-disk WAL Litestream replicates.
 */

import { SQLITE_BUSY_TIMEOUT_MS, SQLITE_BUSY_TIMEOUT_PRAGMA } from '../shared/db.ts';

/** One writer, and no second app connection holding a read snapshot. */
export const SQLITE_FILE_CONCURRENCY = 1;

export const SQLITE_CONNECTION_PRAGMAS = [
  'PRAGMA journal_mode = WAL;',
  'PRAGMA foreign_keys = ON;',
  SQLITE_BUSY_TIMEOUT_PRAGMA,
  'PRAGMA synchronous = NORMAL;',
  'PRAGMA cache_size = -64000;',
  'PRAGMA mmap_size = 268435456;',
] as const;

/** One script, one connection. Separate executes would land on different pool slots. */
export const SQLITE_CONNECTION_PRAGMA_SCRIPT = SQLITE_CONNECTION_PRAGMAS.join('\n');

export function isFileSqliteUrl(url: string): boolean {
  return url.trim().toLowerCase().startsWith('file:');
}

export interface LibsqlClientOptions {
  url: string;
  authToken: string;
  concurrency?: number;
  timeout?: number;
}

export function libsqlClientOptions(url: string, authToken: string): LibsqlClientOptions {
  const options: LibsqlClientOptions = { url, authToken };
  if (!isFileSqliteUrl(url)) return options;
  // `timeout` is the driver's per-connection busy timeout in milliseconds.
  options.concurrency = SQLITE_FILE_CONCURRENCY;
  options.timeout = SQLITE_BUSY_TIMEOUT_MS;
  return options;
}

/** Apply boot pragmas. Failures are ignored so a dummy/remote URL can still boot. */
export async function applySqliteConnectionPragmas(
  client: { executeMultiple(sql: string): Promise<void> },
): Promise<void> {
  try {
    await client.executeMultiple(SQLITE_CONNECTION_PRAGMA_SCRIPT);
  } catch {
    /* dummy URL at boot, or a driver that rejects pragmas */
  }
}
