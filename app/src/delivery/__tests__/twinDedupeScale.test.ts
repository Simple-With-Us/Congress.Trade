/**
 * src/delivery/__tests__/twinDedupeScale.test.ts
 *
 * Issue #2062: PR 2037's correlated TWIN_DEDUPE_SQL hung first-page
 * GET /transactions. #2066 took the guard off unbounded COUNT; the
 * published PAGE still hung because NOT EXISTS sat in the same WHERE
 * as ORDER+LIMIT. Coolify auto-deploy never runs POST /api/admin/migrate,
 * so idx_tx_twin_seek / 0088 may be missing in prod even when health
 * reports schema:true missing:[].
 *
 * This file plants thousands of unique live rows plus a Fleischmann-style
 * triple WITHOUT creating idx_tx_twin_seek and asserts:
 *   - COUNT / today have no correlated transactions-d subquery
 *   - first-page {order=desc,limit=5,offset=0} + COUNT + today finish
 *     well under 2s without that index
 *   - published page still collapses the TSCO triple
 */

import { describe, expect, it } from 'vitest';
import { BASE_SCHEMA_STATEMENTS } from '../../admin/migrations.ts';
import {
  buildTransactionsCountQuery,
  buildTransactionsQuery,
  buildTransactionsTodayFilingsQuery,
  twinCandidateLimit,
} from '../rows.ts';
import { TWIN_DEDUPE_SQL, TWIN_SEEK_INDEX } from '../../shared/tradeIdentity.ts';

interface SqliteStatement {
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Array<Record<string, unknown>>;
  run(...params: unknown[]): { changes: number | bigint };
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDatabase;
}

const CORPUS = 12_000;

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function createCorpus(): Promise<SqliteDatabase> {
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
    ALTER TABLE transactions ADD COLUMN first_seen_at TEXT;
    ALTER TABLE transactions ADD COLUMN filed_date TEXT;
  `);

  db.exec('BEGIN');
  const filer = db.prepare(
    'INSERT OR IGNORE INTO filers (bioguide_id, chamber, full_name, party) VALUES (?, ?, ?, ?)',
  );
  const ins = db.prepare(`
    INSERT INTO transactions (
      id, doc_id, filer_id, tx_date, ticker, asset_name, tx_type, source,
      amount_min, amount_max, owner, is_option
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1001, 15000, 'self', 0)
  `);
  for (let i = 0; i < CORPUS; i++) {
    const filerId = `F${String(i % 400).padStart(6, '0')}`;
    if (i < 400) filer.run(filerId, 'house', `Member ${filerId}`, 'Republican');
    const ticker = `T${String(i % 800).padStart(3, '0')}`;
    const source = i % 17 === 0 ? 'competitor_backfill' : i % 11 === 0 ? 'manual' : 'primary';
    ins.run(
      `id-${i}`,
      `D-${i}`,
      filerId,
      isoDaysAgo(i % 80),
      ticker,
      ticker,
      i % 3 === 0 ? 'S' : 'B',
      source,
    );
  }
  filer.run('F000459', 'house', 'Chuck Fleischmann', 'Republican');
  ins.run('manual-tsco', 'H-2026-9116212', 'F000459', isoDaysAgo(10), 'TSCO', 'TSCO', 'S', 'manual');
  ins.run('primary-tsco', 'H-2026-20034932', 'F000459', isoDaysAgo(10), 'TSCO', 'TSCO', 'S', 'primary');
  ins.run(
    'competitor-tsco',
    'COMPETITOR-fleischmann_TSCO',
    'F000459',
    isoDaysAgo(10),
    'TSCO',
    'TSCO',
    'S',
    'competitor_backfill',
  );
  db.exec('COMMIT');
  return db;
}

describe('twin-dedupe scale (#2062)', () => {
  it('first page stays fast without idx_tx_twin_seek; published TSCO still collapses', async () => {
    const db = await createCorpus();
    const seek = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name = '${TWIN_SEEK_INDEX}'`,
      )
      .get();
    expect(seek).toBeUndefined();

    const pageQ = buildTransactionsQuery({ order: 'desc', limit: 5, offset: 0 });
    const countQ = buildTransactionsCountQuery({ order: 'desc' });
    const todayQ = buildTransactionsTodayFilingsQuery({}, isoDaysAgo(0));

    expect(countQ.sql).not.toContain(TWIN_DEDUPE_SQL);
    expect(countQ.sql).not.toContain('FROM transactions d');
    expect(todayQ.sql).not.toContain(TWIN_DEDUPE_SQL);
    expect(pageQ.sql).toContain(TWIN_DEDUPE_SQL);
    expect(pageQ.sql).toContain(`LIMIT ${twinCandidateLimit(5, 0)}`);
    expect(pageQ.sql.indexOf(`LIMIT ${twinCandidateLimit(5, 0)}`)).toBeLessThan(
      pageQ.sql.indexOf(TWIN_DEDUPE_SQL),
    );

    const t0 = performance.now();
    const page = db.prepare(pageQ.sql).all(...pageQ.params);
    const count = db.prepare(countQ.sql).get(...countQ.params);
    db.prepare(todayQ.sql).get(...todayQ.params);
    const elapsed = performance.now() - t0;

    expect(page.length).toBe(5);
    expect(Number(count?.total)).toBe(CORPUS + 3);
    expect(elapsed).toBeLessThan(2000);

    const tscoPage = buildTransactionsQuery({
      ticker: 'TSCO',
      since: 0,
      sort: 'tx_date',
      order: 'desc',
    });
    const published = db.prepare(tscoPage.sql).all(...tscoPage.params);
    expect(published.map((row) => row.id)).toEqual(['primary-tsco']);

    db.close();
  });
});
