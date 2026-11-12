import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { SQLITE_BUSY_TIMEOUT_MS, SQLITE_BUSY_TIMEOUT_PRAGMA } from '../../shared/db.ts';
import {
  SQLITE_CONNECTION_PRAGMA_SCRIPT,
  SQLITE_FILE_CONCURRENCY,
  applySqliteConnectionPragmas,
  isFileSqliteUrl,
  libsqlClientOptions,
} from '../sqliteClient.ts';

describe('file sqlite client (CONGRESS-TRADE-1M)', () => {
  it('uses one connection and a busy timeout on file URLs', () => {
    const options = libsqlClientOptions('file:/data/congress-trade/db.sqlite', 'token');
    expect(options.concurrency).toBe(SQLITE_FILE_CONCURRENCY);
    expect(options.concurrency).toBe(1);
    expect(options.timeout).toBe(SQLITE_BUSY_TIMEOUT_MS);
    expect(options.timeout).toBe(10_000);
    expect(isFileSqliteUrl('file:///data/congress-trade/db.sqlite')).toBe(true);
  });

  it('leaves remote libsql URLs on the driver defaults', () => {
    const options = libsqlClientOptions('libsql://dummy-url.turso.io', '');
    expect(options.concurrency).toBeUndefined();
    expect(options.timeout).toBeUndefined();
    expect(isFileSqliteUrl('https://example.turso.io')).toBe(false);
  });

  it('sends every boot pragma in one script so they share a connection', async () => {
    const executeMultiple = vi.fn(async () => {});
    await applySqliteConnectionPragmas({ executeMultiple });
    expect(executeMultiple).toHaveBeenCalledTimes(1);
    const script = executeMultiple.mock.calls[0][0] as string;
    expect(script).toBe(SQLITE_CONNECTION_PRAGMA_SCRIPT);
    expect(script).toContain('PRAGMA journal_mode = WAL;');
    expect(script).toContain('PRAGMA foreign_keys = ON;');
    expect(script).toContain(SQLITE_BUSY_TIMEOUT_PRAGMA);
    expect(script).toContain('PRAGMA synchronous = NORMAL;');
    expect(script.split('PRAGMA').length - 1).toBe(6);
  });

  it('swallows pragma failures so a dummy URL can still boot', async () => {
    const executeMultiple = vi.fn(async () => {
      throw new Error('no such database');
    });
    await expect(applySqliteConnectionPragmas({ executeMultiple })).resolves.toBeUndefined();
  });
});

describe('litestream 0.5.13 checkpoint config', () => {
  const yml = readFileSync(new URL('../../../litestream.yml', import.meta.url), 'utf8');
  const fetchScript = readFileSync(new URL('../../../scripts/fetch-litestream.sh', import.meta.url), 'utf8');

  it('keeps the 0.5.13 pin (0.5.14 socket-churn stays out)', () => {
    expect(fetchScript).toContain('LITESTREAM_VERSION="0.5.13"');
  });

  it('disables blocking TRUNCATE and keeps PASSIVE checkpoints', () => {
    // On 0.5.13, truncate-page-n: 0 disables the emergency TRUNCATE.
    // Later releases changed 0 to "keep the default" — do not bump the pin
    // without revisiting this value.
    expect(yml).toMatch(/truncate-page-n:\s*0\b/);
    expect(yml).toMatch(/busy-timeout:\s*5s/);
    expect(yml).toMatch(/checkpoint-interval:\s*30s/);
    expect(yml).toMatch(/min-checkpoint-page-count:\s*1000/);
  });
});
