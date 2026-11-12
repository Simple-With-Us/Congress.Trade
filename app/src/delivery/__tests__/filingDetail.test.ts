/**
 * GET /filings/:docId against a real, fully-migrated in-memory SQLite DB.
 * Filing detail must match the public feed: retracted rows stay out.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMigratedD1, type D1Database, type SqliteDatabase } from '../../prices/__tests__/sqliteD1.ts';
import { buildRestRouter } from '../rest.ts';
import type { Env } from '../../shared/types.ts';

let db: SqliteDatabase;
let d1: D1Database;
let env: Env;

beforeEach(async () => {
  ({ db, d1 } = await openMigratedD1());
  env = { DB: d1 } as unknown as Env;
});

afterEach(() => {
  db.close();
});

describe('GET /filings/:docId', () => {
  it('omits retracted rows after unpublish so a republish cannot double-count', async () => {
    db.prepare(
      `INSERT INTO filings (doc_id, chamber, filer_id, ingest_status, first_seen_at)
       VALUES (?, 'house', 'house-ca17-ro-khanna', 'persisted', '2026-01-01T00:00:00Z')`,
    ).run('H-2025-8221264');
    db.prepare(
      `INSERT INTO transactions (id, doc_id, filer_id, ticker, tx_date, source, created_at, deprecated_at)
       VALUES (?, ?, ?, ?, '2025-10-01', 'local_mac', '2026-01-02T00:00:00Z', ?)`,
    ).run('tx-live', 'H-2025-8221264', 'house-ca17-ro-khanna', 'NVDA', null);
    db.prepare(
      `INSERT INTO transactions (id, doc_id, filer_id, ticker, tx_date, source, created_at, deprecated_at)
       VALUES (?, ?, ?, ?, '2025-10-01', 'local_mac', '2026-01-02T00:00:00Z', ?)`,
    ).run('tx-retracted', 'H-2025-8221264', 'house-ca17-ro-khanna', 'NVDA', '2026-08-22T00:00:00Z');

    const app = buildRestRouter();
    const res = await app.request('http://localhost/filings/H-2025-8221264', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { transactions: Array<{ id: string }> };
    expect(body.transactions.map((tx) => tx.id)).toEqual(['tx-live']);
  });
});
