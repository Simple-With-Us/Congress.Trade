/**
 * #2180 contract: order=desc without an explicit sort must not rank a 2024
 * backfill row with a high ingest cursor ahead of a later-seen 2026 row.
 */
import { describe, expect, it } from 'vitest';
import { BASE_SCHEMA_STATEMENTS } from '../../admin/migrations.ts';
import { buildTransactionsQuery } from '../rows.ts';

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

describe('newest-first snapshot order (#2180)', () => {
  it('a 2024 backfill with a higher cursor_seq cannot occupy page 1 over a later-seen 2026 row', async () => {
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
      ALTER TABLE transactions ADD COLUMN first_seen_at TEXT;
      ALTER TABLE transactions ADD COLUMN filed_date TEXT;
      ALTER TABLE transactions ADD COLUMN deprecated_at TEXT;
      ALTER TABLE filers ADD COLUMN display_name TEXT;
      ALTER TABLE filers ADD COLUMN photo_url TEXT;
      ALTER TABLE filers ADD COLUMN resolved_bioguide_id TEXT;
      CREATE TABLE IF NOT EXISTS securities_ref (
        ticker TEXT PRIMARY KEY, company_name TEXT, sector TEXT, market_cap REAL,
        market_cap_bucket TEXT, country TEXT, exchange_short TEXT, asset_class TEXT, enriched_at TEXT
      );
    `);
    db.exec(`
      INSERT INTO filers (bioguide_id, chamber, full_name, party) VALUES
        ('K000389', 'house', 'Ro Khanna', 'Democrat'),
        ('C001066', 'house', 'Ed Case', 'Democrat');
      INSERT INTO transactions (
        id, doc_id, filer_id, tx_date, ticker, asset_name, tx_type, source,
        amount_min, amount_max, owner, is_option, first_seen_at, filed_date
      ) VALUES
        ('khanna-2024', 'H-2024-8220192', 'K000389', '2024-03-15', 'AAPL', 'Apple', 'B',
         'local_mac', 1001, 15000, 'self', 0, '2024-03-20T00:00:00.000Z', '2024-04-01'),
        ('case-2026', 'H-2026-20034900', 'C001066', '2026-08-13', 'AAPL', 'Apple', 'B',
         'primary', 1001, 15000, 'self', 0, '2026-08-14T00:00:00.000Z', '2026-08-14');
      UPDATE transactions SET cursor_seq = 900000 WHERE id = 'khanna-2024';
      UPDATE transactions SET cursor_seq = 12 WHERE id = 'case-2026';
    `);

    const q = buildTransactionsQuery({ order: 'desc', limit: 8 });
    const page = db.prepare(q.sql).all(...q.params);
    expect(page.map((row) => row.id)).toEqual(['case-2026', 'khanna-2024']);
    db.close();
  });
});
