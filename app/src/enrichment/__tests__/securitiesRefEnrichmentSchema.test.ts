import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { d1Database, openMigratedD1, type SqliteDatabase } from '../../prices/__tests__/sqliteD1.ts';
import {
  enrichmentUnavailableExcludedSqlForDb,
  hasEnrichment0104Columns,
  resetEnrichment0104ColumnsCache,
} from '../securitiesRefEnrichmentSchema.ts';
import { markTickerEnrichmentUnavailable } from '../service.ts';
import type { Env } from '../../shared/types.ts';

const migrationsUrl = new URL('../../../migrations/', import.meta.url);

interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDatabase;
}

async function openPre0104D1(): Promise<{
  db: SqliteDatabase;
  d1: D1Database;
  close: () => void;
}> {
  const sqlite = (await import('node:sqlite')) as SqliteModule;
  const db = new sqlite.DatabaseSync(':memory:');
  const files = readdirSync(migrationsUrl as unknown as string)
    .filter((name: string) => name.endsWith('.sql') && name < '0104_enrichment_unavailable.sql')
    .sort();
  for (const name of files) {
    db.exec(readFileSync(new URL(name, migrationsUrl) as unknown as string, 'utf8'));
  }
  return { db, d1: d1Database(db), close: () => db.close() };
}

describe('securitiesRefEnrichmentSchema', () => {
  afterEach(() => {
    resetEnrichment0104ColumnsCache();
  });

  it('detects 0104 columns on a fully migrated DB', async () => {
    const opened = await openMigratedD1();
    expect(await hasEnrichment0104Columns(opened.d1)).toBe(true);
    expect(await enrichmentUnavailableExcludedSqlForDb(opened.d1)).toContain('enrichment_unavailable');
    opened.close();
  });

  it('falls back when 0104 columns are absent', async () => {
    const opened = await openPre0104D1();
    expect(await hasEnrichment0104Columns(opened.d1)).toBe(false);
    expect(await enrichmentUnavailableExcludedSqlForDb(opened.d1)).toBe('1=1');
    opened.close();
  });

  it('markTickerEnrichmentUnavailable writes legacy columns pre-0104', async () => {
    const opened = await openPre0104D1();
    opened.db.prepare(
      `INSERT INTO transactions (id, ticker, tx_date, source, created_at)
       VALUES ('tx-LEG', 'LEG', '2026-01-01', 'primary', '2026-01-01T00:00:00Z')`,
    ).run();
    const env = { DB: opened.d1 } as Env;
    await markTickerEnrichmentUnavailable(env, 'LEG', 'legacy_reason', { force: true });
    const row = opened.db
      .prepare('SELECT enriched_at, enrichment_error FROM securities_ref WHERE ticker = ?')
      .get('LEG') as { enriched_at: string; enrichment_error: string };
    expect(row.enrichment_error).toBe('legacy_reason');
    expect(row.enriched_at).toBeTruthy();
    opened.close();
  });
});
