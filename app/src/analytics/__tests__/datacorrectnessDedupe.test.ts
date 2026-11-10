/**
 * src/analytics/__tests__/datacorrectnessDedupe.test.ts
 *
 * Real SQLite pins for Monet DATACORRECTNESS-01 / 02 / 10:
 *   - Fleischmann TSCO triple (manual + primary + competitor) counts once
 *   - same-doc manual+primary counts once
 *   - fabricated competitor $1,001–$15,000 is excluded from $ KPIs
 *   - headline net flow without excludeOptions matches stock-only
 */

import { describe, expect, it } from 'vitest';
import { BASE_SCHEMA_STATEMENTS } from '../../admin/migrations.ts';
import { buildSummaryQuery, buildTickerSummaryQuery } from '../builders.ts';
import { buildTransactionsCountQuery, buildTransactionsQuery } from '../../delivery/rows.ts';
import { all, first } from '../../shared/db.ts';

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
      // idempotent schema fragments
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS securities_ref (
      ticker TEXT PRIMARY KEY, company_name TEXT, sector TEXT, market_cap REAL,
      market_cap_bucket TEXT, country TEXT, exchange_short TEXT, asset_class TEXT, enriched_at TEXT
    );
    ALTER TABLE filers ADD COLUMN photo_url TEXT;
    ALTER TABLE filers ADD COLUMN resolved_bioguide_id TEXT;
    ALTER TABLE filers ADD COLUMN display_name TEXT;
    ALTER TABLE filings ADD COLUMN filing_status TEXT;
    ALTER TABLE transactions ADD COLUMN deprecated_at TEXT;
    ALTER TABLE transactions ADD COLUMN asset_type_name TEXT;
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
  } as unknown as D1Database;
}

function insertTx(
  db: D1Database,
  row: {
    id: string;
    docId: string;
    filerId: string;
    txDate: string;
    ticker: string;
    assetName?: string;
    txType: string;
    source: string;
    amountMin?: number | null;
    amountMax?: number | null;
    owner?: string | null;
    isOption?: number;
  },
): Promise<{ count: number; duration: number }> {
  const amountMin = row.amountMin === undefined ? 1001 : row.amountMin;
  const amountMax = row.amountMax === undefined ? 15000 : row.amountMax;
  const owner = row.owner === undefined ? 'self' : row.owner;
  const assetName = row.assetName ?? row.ticker;
  const isOption = row.isOption ?? 0;
  const ownerSql = owner == null ? 'NULL' : `'${owner}'`;
  const minSql = amountMin == null ? 'NULL' : String(amountMin);
  const maxSql = amountMax == null ? 'NULL' : String(amountMax);
  return db.exec(`
    INSERT INTO transactions (
      id, doc_id, filer_id, tx_date, ticker, asset_name, tx_type, source,
      amount_min, amount_max, owner, is_option
    ) VALUES (
      '${row.id}', '${row.docId}', '${row.filerId}', '${row.txDate}', '${row.ticker}',
      '${assetName}', '${row.txType}', '${row.source}', ${minSql}, ${maxSql},
      ${ownerSql}, ${isOption}
    );
  `);
}

describe('DATACORRECTNESS-01/02/10 trade identity', () => {
  it('counts the Fleischmann TSCO triple once and prefers primary', async () => {
    const db = await createInMemoryD1();
    await db.exec(`
      INSERT INTO filers (bioguide_id, chamber, full_name, party)
      VALUES ('F000459', 'house', 'Chuck Fleischmann', 'Republican');
    `);
    await insertTx(db, {
      id: 'manual-tsco',
      docId: 'H-2026-9116212',
      filerId: 'F000459',
      txDate: '2026-06-09',
      ticker: 'TSCO',
      txType: 'S',
      source: 'manual',
      amountMin: 1000,
      amountMax: 15000,
    });
    await insertTx(db, {
      id: 'primary-tsco',
      docId: 'H-2026-20034932',
      filerId: 'F000459',
      txDate: '2026-06-09',
      ticker: 'TSCO',
      txType: 'S',
      source: 'primary',
      amountMin: 1001,
      amountMax: 15000,
    });
    await insertTx(db, {
      id: 'competitor-tsco',
      docId: 'COMPETITOR-fleischmann_TSCO_2026-06-09_sell',
      filerId: 'F000459',
      txDate: '2026-06-09',
      ticker: 'TSCO',
      txType: 'S',
      source: 'competitor_backfill',
      amountMin: 1001,
      amountMax: 15000,
      owner: null,
    });

    const tickerQ = buildTickerSummaryQuery('TSCO', { window: 'all' });
    const ticker = (await first<Record<string, number>>(db, tickerQ.sql, tickerQ.params)) ?? {};
    expect(Number(ticker.total_trades)).toBe(1);
    expect(Number(ticker.est_volume)).toBe(8000.5);
    expect(Number(ticker.est_net_flow)).toBe(-8000.5);

    // Unbounded COUNT is the live-row total (issue #2062); published page
    // and analytics still collapse the triple to the primary row.
    const countQ = buildTransactionsCountQuery({ ticker: 'TSCO' });
    const feed = (await first<{ total: number }>(db, countQ.sql, countQ.params)) ?? { total: 0 };
    expect(Number(feed.total)).toBe(3);
    const pageQ = buildTransactionsQuery({ ticker: 'TSCO', since: 0, sort: 'tx_date', order: 'desc' });
    const page = await all<{ id: string }>(db, pageQ.sql, pageQ.params);
    expect(page.map((row) => row.id)).toEqual(['primary-tsco']);
  });

  it('counts a doc that carries both manual and primary rows once', async () => {
    const db = await createInMemoryD1();
    await db.exec(`
      INSERT INTO filers (bioguide_id, chamber, full_name, party)
      VALUES ('T000476', 'house', 'William Timmons', 'Republican');
    `);
    await insertTx(db, {
      id: 'same-doc-manual',
      docId: 'H-2026-20035042',
      filerId: 'T000476',
      txDate: '2026-06-15',
      ticker: 'SPCX',
      txType: 'B',
      source: 'manual',
      amountMin: 50001,
      amountMax: 100000,
    });
    await insertTx(db, {
      id: 'same-doc-primary',
      docId: 'H-2026-20035042',
      filerId: 'T000476',
      txDate: '2026-06-15',
      ticker: 'SPCX',
      txType: 'B',
      source: 'primary',
      amountMin: 50001,
      amountMax: 100000,
    });

    const summaryQ = buildSummaryQuery({ window: 'all' });
    const summary = (await first<Record<string, number>>(db, summaryQ.sql, summaryQ.params)) ?? {};
    expect(Number(summary.total_trades)).toBe(1);
  });

  it('keeps two real same-day trades with different brackets', async () => {
    const db = await createInMemoryD1();
    await db.exec(`
      INSERT INTO filers (bioguide_id, chamber, full_name, party)
      VALUES ('P000197', 'house', 'Nancy Pelosi', 'Democrat');
    `);
    await insertTx(db, {
      id: 'lot-a',
      docId: 'H-2026-lots',
      filerId: 'P000197',
      txDate: '2026-05-01',
      ticker: 'AAPL',
      txType: 'B',
      source: 'primary',
      amountMin: 1001,
      amountMax: 15000,
    });
    await insertTx(db, {
      id: 'lot-b',
      docId: 'H-2026-lots',
      filerId: 'P000197',
      txDate: '2026-05-01',
      ticker: 'AAPL',
      txType: 'B',
      source: 'primary',
      amountMin: 15001,
      amountMax: 50000,
    });

    const tickerQ = buildTickerSummaryQuery('AAPL', { window: 'all' });
    const ticker = (await first<Record<string, number>>(db, tickerQ.sql, tickerQ.params)) ?? {};
    expect(Number(ticker.total_trades)).toBe(2);
  });

  it('excludes fabricated competitor dollars and defaults $ KPIs to stock-only', async () => {
    const db = await createInMemoryD1();
    await db.exec(`
      INSERT INTO filers (bioguide_id, chamber, full_name, party)
      VALUES ('P000197', 'house', 'Nancy Pelosi', 'Democrat');
    `);
    await insertTx(db, {
      id: 'stock-buy',
      docId: 'H-2026-stock',
      filerId: 'P000197',
      txDate: '2026-05-29',
      ticker: 'INTC',
      txType: 'B',
      source: 'primary',
      amountMin: 1001,
      amountMax: 15000,
      isOption: 0,
    });
    await insertTx(db, {
      id: 'option-buy',
      docId: 'H-2026-opt',
      filerId: 'P000197',
      txDate: '2026-05-29',
      ticker: 'INTC',
      txType: 'B',
      source: 'primary',
      amountMin: 1000001,
      amountMax: 5000000,
      isOption: 1,
    });
    await insertTx(db, {
      id: 'competitor-intc',
      docId: 'COMPETITOR-pelosi_INTC_2026-05-29_buy',
      filerId: 'P000197',
      txDate: '2026-05-29',
      ticker: 'INTC',
      txType: 'B',
      source: 'competitor_backfill',
      amountMin: 1001,
      amountMax: 15000,
      owner: null,
    });

    const mixed = buildSummaryQuery({ window: 'all' });
    const stock = buildSummaryQuery({ window: 'all', excludeOptions: true });
    const mixedRow = (await first<Record<string, number>>(db, mixed.sql, mixed.params)) ?? {};
    const stockRow = (await first<Record<string, number>>(db, stock.sql, stock.params)) ?? {};

    expect(Number(mixedRow.total_trades)).toBe(2);
    expect(Number(mixedRow.option_count)).toBe(1);
    expect(Number(mixedRow.est_net_flow)).toBe(8000.5);
    expect(Number(mixedRow.est_volume)).toBe(8000.5);
    expect(Number(stockRow.est_net_flow)).toBe(Number(mixedRow.est_net_flow));
    expect(Number(stockRow.est_volume)).toBe(Number(mixedRow.est_volume));
    expect(Number(stockRow.total_trades)).toBe(1);
  });
});
