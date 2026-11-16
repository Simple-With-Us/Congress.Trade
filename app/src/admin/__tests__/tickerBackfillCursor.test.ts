/**
 * Board row 16b46688 (retro-backfill): runTickerBackfill re-read the lowest 5000
 * ticker-less ids every run, and most ticker-less rows (bonds, funds, private
 * assets) never resolve, so the resolvable tail was never reached.  Cursor mode
 * pages by id.  Runs against the real migrated in-memory schema.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMigratedD1, type D1Database, type SqliteDatabase } from '../../prices/__tests__/sqliteD1.ts';
import { runTickerBackfill } from '../routes.ts';
import { clearResolverCache } from '../../extraction/normalizer.ts';
import type { Env } from '../../shared/types.ts';

let db: SqliteDatabase;
let d1: D1Database;
let env: Env;

beforeEach(async () => {
  clearResolverCache();
  ({ db, d1 } = await openMigratedD1());
  env = { DB: d1 } as unknown as Env;
  for (const [ticker, name] of [
    ['UBER', 'Uber Technologies, Inc.'],
    ['KO', 'Coca-Cola Company (The)'],
    ['MSFT', 'Microsoft Corporation'],
  ]) {
    db.prepare('INSERT INTO securities_ref (ticker, company_name, market_cap) VALUES (?, ?, 1000000)').run(ticker, name);
  }
});

afterEach(() => db.close());

function tx(id: string, assetName: string, ticker: string | null = null) {
  db.prepare(
    `INSERT INTO transactions (id, doc_id, filer_id, tx_date, asset_name, ticker, tx_type, source, row_key)
     VALUES (?, ?, 'house-ca17-ro-khanna', '2026-07-01', ?, ?, 'S', 'primary', ?)`,
  ).run(id, `H-${id}`, assetName, ticker, `v1:primary:0:old-${id}`);
}

const tickerOf = (id: string) =>
  (db.prepare('SELECT ticker, row_key FROM transactions WHERE id = ?').get(id) as { ticker: string | null; row_key: string });

describe('runTickerBackfill by issuer name', () => {
  it('resolves the Khanna-style ticker-less names and rewrites row_key with the new ticker', async () => {
    tx('a1', 'Uber Technologies Inc. CMN');
    tx('a2', 'Coca Cola Company (the) CMN');
    tx('a3', 'Some Private Holdings LLC');

    const result = await runTickerBackfill(env, 10);

    expect(result).toEqual({ scanned: 3, resolved: 2 });
    expect(tickerOf('a1').ticker).toBe('UBER');
    expect(tickerOf('a2').ticker).toBe('KO');
    expect(tickerOf('a3').ticker).toBeNull();
    expect(tickerOf('a1').row_key).not.toBe('v1:primary:0:old-a1');
  });

  it('never re-points a row that already carries its own ticker, and never resolves a bond', async () => {
    tx('b1', 'Microsoft Corporation CMN', 'ZZZZ');
    tx('b2', 'Microsoft Corp. 3.5% Notes due 2035');

    await runTickerBackfill(env, 10);

    expect(tickerOf('b1').ticker).toBe('ZZZZ');
    expect(tickerOf('b2').ticker).toBeNull();
  });

  it('cursor mode pages by id so unresolvable rows cannot starve the tail', async () => {
    // Three rows that never resolve sort first; the resolvable ones come after.
    tx('c1', 'Private Fund LP');
    tx('c2', 'Treasury Bill 2027');
    tx('c3', 'Some Private Holdings LLC');
    tx('c4', 'Uber Technologies Inc. CMN');
    tx('c5', 'Coca Cola Company (the) CMN');
    tx('c6', 'Microsoft Corporation CMN');

    // Without a cursor the lowest ids are re-read every time and nothing resolves.
    const legacy = await runTickerBackfill(env, 3);
    expect(legacy).toEqual({ scanned: 3, resolved: 0 });

    // Cursor mode walks the table.
    const page1 = await runTickerBackfill(env, 3, { afterId: '' });
    expect(page1).toEqual({ scanned: 3, resolved: 0, lastId: 'c3' });
    const page2 = await runTickerBackfill(env, 3, { afterId: page1.lastId! });
    expect(page2).toEqual({ scanned: 3, resolved: 3, lastId: 'c6' });
    expect([tickerOf('c4').ticker, tickerOf('c5').ticker, tickerOf('c6').ticker]).toEqual(['UBER', 'KO', 'MSFT']);
    // Past the end: nothing left, cursor null so the daily job wraps.
    const page3 = await runTickerBackfill(env, 3, { afterId: page2.lastId! });
    expect(page3).toEqual({ scanned: 0, resolved: 0, lastId: null });
  });

  it('is idempotent: a second full pass changes nothing', async () => {
    tx('d1', 'Uber Technologies Inc. CMN');
    await runTickerBackfill(env, 10);
    const second = await runTickerBackfill(env, 10);
    expect(second).toEqual({ scanned: 0, resolved: 0 });
  });
});
