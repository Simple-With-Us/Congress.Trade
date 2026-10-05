/**
 * Import route preserves provider as-of timestamps (fundamentals.updatedAt,
 * analyst.asOfTimestamp) instead of stamping receive time into updated_at.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAdminRouter } from '../routes.ts';
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
});
