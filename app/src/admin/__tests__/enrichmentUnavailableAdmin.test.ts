import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAdminRouter } from '../routes.ts';
import { openMigratedD1, type SqliteDatabase } from '../../prices/__tests__/sqliteD1.ts';

const app = buildAdminRouter();
const AUTH_ENV = { ADMIN_TOKEN: 'admin-secret' };

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

describe('POST /securities/:ticker/enrichment-unavailable', () => {
  it('marks a ticker as not enrichable with admin auth', async () => {
    const res = await app.request(
      '/securities/junk/enrichment-unavailable',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: 'Bearer admin-secret',
        },
        body: JSON.stringify({ reason: 'operator_junk_symbol' }),
      },
      { ...AUTH_ENV, DB: d1 } as never,
    );
    expect(res.status).toBe(200);
    const row = db
      .prepare(
        'SELECT enrichment_unavailable, enrichment_unavailable_reason, enrichment_checked_at FROM securities_ref WHERE ticker = ?',
      )
      .get('JUNK');
    expect(row?.enrichment_unavailable).toBe(1);
    expect(row?.enrichment_unavailable_reason).toBe('operator_junk_symbol');
    expect(row?.enrichment_checked_at).toBeTruthy();
  });

  it('rejects unauthenticated calls', async () => {
    const res = await app.request(
      '/securities/junk/enrichment-unavailable',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'nope' }),
      },
      { DB: d1 } as never,
    );
    expect(res.status).toBe(401);
  });

  it('rejects unknown JSON keys (strict schema)', async () => {
    const res = await app.request(
      '/securities/junk/enrichment-unavailable',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: 'Bearer admin-secret',
        },
        body: JSON.stringify({ reason: 'ok', extra: true }),
      },
      { ...AUTH_ENV, DB: d1 } as never,
    );
    expect(res.status).toBe(400);
  });
});
