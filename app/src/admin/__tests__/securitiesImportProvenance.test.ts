/**
 * Import route preserves provider as-of timestamps (fundamentals.updatedAt,
 * analyst.asOfTimestamp) instead of stamping receive time into updated_at.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAdminRouter } from '../routes.ts';
import { MARKET_IMPORT_PROVENANCE_SCHEMA_STATEMENTS } from '../migrations.ts';
import { openMigratedD1, type SqliteDatabase } from '../../prices/__tests__/sqliteD1.ts';

const app = buildAdminRouter();
const AUTH_ENV = { ADMIN_TOKEN: 'admin-secret', INGEST_TOKEN: 'ingest-secret' };

let db: SqliteDatabase;
let d1: D1Database;
let close: () => void;

beforeEach(async () => {
  const opened = await openMigratedD1();
  db = opened.db;
  d1 = opened.d1;
  close = opened.close;
});
afterEach(() => close());

function importBody(body: unknown) {
  return app.request(
    '/securities/import',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: 'Bearer ingest-secret' },
      body: JSON.stringify(body),
    },
    { ...AUTH_ENV, DB: d1 } as never,
  );
}

describe('POST /securities/import — provider timestamps', () => {
  it('stores fundamentals.updatedAt and keeps received_at as receive time', async () => {
    const res = await importBody({
      fundamentals: [
        {
          ticker: 'FUND',
          date: '2026-07-10',
          peRatio: 12,
          updatedAt: '2026-06-01T12:00:00Z',
        },
      ],
    });
    expect(res.status).toBe(200);
    const row = db
      .prepare('SELECT updated_at, received_at FROM fundamentals_eod WHERE ticker = ?')
      .get('FUND') as { updated_at: string; received_at: string };
    expect(row.updated_at).toBe('2026-06-01T12:00:00Z');
    expect(row.received_at).toMatch(/^2026-/);
    expect(row.received_at).not.toBe(row.updated_at);
  });

  it('prefers analyst.asOfTimestamp over updatedAt for updated_at', async () => {
    const res = await importBody({
      analyst: [
        {
          ticker: 'AN',
          date: '2026-07-10',
          rating: 'Buy',
          updatedAt: '2026-06-01T12:00:00Z',
          asOfTimestamp: '2026-05-15T08:30:00Z',
        },
      ],
    });
    expect(res.status).toBe(200);
    const row = db
      .prepare('SELECT updated_at, received_at FROM analyst_consensus WHERE ticker = ?')
      .get('AN') as { updated_at: string; received_at: string };
    expect(row.updated_at).toBe('2026-05-15T08:30:00Z');
    expect(row.received_at).toMatch(/^2026-/);
  });

  it('backfills received_at from pre-0101 updated_at and does not overwrite a real receive time', () => {
    db.exec(
      `INSERT INTO fundamentals_eod (ticker, date, source, updated_at)
       VALUES ('OLD', '2026-01-01', 'imported', '2026-06-01T00:00:00Z')`,
    );
    db.exec(
      `INSERT INTO analyst_consensus (ticker, date, source, updated_at, received_at)
       VALUES ('KEEP', '2026-01-01', 'imported', '2020-01-01T00:00:00Z', '2026-10-01T00:00:00Z')`,
    );
    for (const sql of MARKET_IMPORT_PROVENANCE_SCHEMA_STATEMENTS) {
      if (sql.startsWith('UPDATE ')) db.exec(sql);
    }
    const oldRow = db
      .prepare('SELECT received_at FROM fundamentals_eod WHERE ticker = ?')
      .get('OLD') as { received_at: string };
    const keepRow = db
      .prepare('SELECT received_at FROM analyst_consensus WHERE ticker = ?')
      .get('KEEP') as { received_at: string };
    expect(oldRow.received_at).toBe('2026-06-01T00:00:00Z');
    expect(keepRow.received_at).toBe('2026-10-01T00:00:00Z');
  });
});
