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
  it('omits deprecated_at rows so a truncated confirm does not sit next to its replacement', async () => {
    db.prepare(
      `INSERT INTO filings (doc_id, chamber, filing_type, filed_date, source_url, ingest_status, doc_kind, first_seen_at)
       VALUES ('H-2025-8221264', 'house', 'P', '2025-12-08', 'https://example.com/8221264.pdf', 'persisted', 'scanned_pdf', '2026-08-10T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO transactions (id, doc_id, filer_id, tx_date, owner, asset_name, tx_type, source, created_at, deprecated_at, deprecated_reason)
       VALUES ('tx-primary', 'H-2025-8221264', 'house-ca17-ro-khanna', '2025-11-07', 'dependent', 'Meta Platforms', 'B', 'primary', '2026-08-21T00:00:00.000Z', '2026-08-21T12:00:00.000Z', 'superseded_by_local_vision')`,
    ).run();
    db.prepare(
      `INSERT INTO transactions (id, doc_id, filer_id, tx_date, owner, asset_name, tx_type, source, created_at, deprecated_at)
       VALUES ('tx-vision', 'H-2025-8221264', 'house-ca17-ro-khanna', '2025-11-07', 'dependent', 'Meta Platforms', 'B', 'local_mac', '2026-08-21T01:00:00.000Z', NULL)`,
    ).run();

    const app = buildRestRouter();
    const res = await app.request('http://localhost/filings/H-2025-8221264', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      transactions: Array<{ id: string; source: string }>;
    };
    expect(body.transactions.map((t) => t.id)).toEqual(['tx-vision']);
    expect(body.transactions[0].source).toBe('local_mac');
  });

  it('returns 404 for an unknown docId instead of 500', async () => {
    const app = buildRestRouter();
    const res = await app.request('http://localhost/filings/H-2025-DOESNOTEXIST', {}, env);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('filing not found');
  });

  it('resolves a transaction id to that filing and hides deprecated rows', async () => {
    db.prepare(
      `INSERT INTO filings (doc_id, chamber, filing_type, filed_date, source_url, ingest_status, doc_kind, first_seen_at)
       VALUES ('H-2025-8221264', 'house', 'P', '2025-12-08', 'https://example.com/8221264.pdf', 'persisted', 'scanned_pdf', '2026-08-10T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO transactions (id, doc_id, filer_id, tx_date, owner, asset_name, tx_type, source, created_at, deprecated_at)
       VALUES ('tx-vision', 'H-2025-8221264', 'house-ca17-ro-khanna', '2025-11-07', 'dependent', 'Meta Platforms', 'B', 'local_mac', '2026-08-21T01:00:00.000Z', NULL)`,
    ).run();

    const app = buildRestRouter();
    const res = await app.request('http://localhost/filings/tx-vision', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      filing: { docId: string };
      transactions: Array<{ id: string }>;
    };
    expect(body.filing.docId).toBe('H-2025-8221264');
    expect(body.transactions.map((t) => t.id)).toEqual(['tx-vision']);
  });
});
