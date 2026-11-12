/**
 * src/delivery/__tests__/tradesFeedCounting.test.ts
 *
 * End-to-end regression coverage for the owner-reported Trades-tab count bugs
 * (LANE: trades-count correctness):
 *   1. The displayed "N total" must never drift upward on its own — it must
 *      always be the server's fresh, authoritative COUNT(*) for the current
 *      query, not a client-side accumulation.
 *   2. Applying a filter (chamber/party/side/ticker/politician) must narrow
 *      the reported total, not just the visible page.
 *
 * These exercise the REAL `GET /transactions` route (via buildRestRouter)
 * against a real in-memory SQLite D1, so the SQL built in rows.ts and the
 * param parsing in rest.ts are both proven together — the client-side fix in
 * dashboardHtml.ts (trusting this same `data.total` on every poll instead of
 * incrementing locally) depends entirely on this endpoint behaving as
 * asserted here.
 */

import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { BASE_SCHEMA_STATEMENTS } from '../../admin/migrations.ts';
import { buildRestRouter } from '../rest.ts';
import type { Env } from '../../shared/types.ts';

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
      // Ignore initial setup error if any
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS securities_ref (ticker TEXT PRIMARY KEY, company_name TEXT, sector TEXT, market_cap REAL, market_cap_bucket TEXT, country TEXT, exchange_short TEXT, asset_class TEXT, enriched_at TEXT);
    ALTER TABLE filers ADD COLUMN photo_url TEXT;
    ALTER TABLE filers ADD COLUMN resolved_bioguide_id TEXT;
    ALTER TABLE filers ADD COLUMN display_name TEXT;
    ALTER TABLE filings ADD COLUMN filing_status TEXT;
    ALTER TABLE transactions ADD COLUMN deprecated_at TEXT;
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

function app() {
  const a = new Hono<{ Bindings: Env }>();
  a.route('/api', buildRestRouter());
  return a;
}

describe('GET /transactions total (owner report #1: must not drift; #2: filters must narrow it)', () => {
  it('applying a party filter narrows both the returned rows AND the reported total', async () => {
    const db = await createInMemoryD1();
    await db.exec(`
      INSERT INTO filers (bioguide_id, chamber, full_name, party) VALUES ('D001', 'house', 'Dem Member', 'Democrat');
      INSERT INTO filers (bioguide_id, chamber, full_name, party) VALUES ('R001', 'senate', 'Rep Member', 'Republican');
      INSERT INTO transactions (id, doc_id, filer_id, tx_date, tx_type, source) VALUES ('tx1', 'doc1', 'D001', '2026-01-01', 'B', 'primary');
      INSERT INTO transactions (id, doc_id, filer_id, tx_date, tx_type, source) VALUES ('tx2', 'doc2', 'D001', '2026-01-02', 'S', 'primary');
      INSERT INTO transactions (id, doc_id, filer_id, tx_date, tx_type, source) VALUES ('tx3', 'doc3', 'R001', '2026-01-03', 'B', 'primary');
    `);
    const a = app();

    const unfiltered = await a.request('/api/transactions?since=0', {}, { DB: db } as never);
    const unfilteredBody = (await unfiltered.json()) as { total: number; transactions: unknown[] };
    expect(unfilteredBody.total).toBe(3);
    expect(unfilteredBody.transactions).toHaveLength(3);

    const filtered = await a.request('/api/transactions?since=0&party=D', {}, { DB: db } as never);
    const filteredBody = (await filtered.json()) as { total: number; transactions: Array<{ id: string }> };
    expect(filteredBody.total).toBe(2);
    expect(filteredBody.transactions).toHaveLength(2);
    expect(filteredBody.transactions.map((t) => t.id).sort()).toEqual(['tx1', 'tx2']);

    // Multi-select CSV form (D,R) is a no-op filter here (both parties exist),
    // but proves the CSV parsing path (asPartyBuckets) reaches the query.
    const both = await a.request('/api/transactions?since=0&party=D,R', {}, { DB: db } as never);
    const bothBody = (await both.json()) as { total: number };
    expect(bothBody.total).toBe(3);
  });

  it('a chamber filter narrows the total the same way (regression guard alongside party)', async () => {
    const db = await createInMemoryD1();
    await db.exec(`
      INSERT INTO filers (bioguide_id, chamber, full_name, party) VALUES ('D001', 'house', 'Dem Member', 'Democrat');
      INSERT INTO filers (bioguide_id, chamber, full_name, party) VALUES ('R001', 'senate', 'Rep Member', 'Republican');
      INSERT INTO transactions (id, doc_id, filer_id, tx_date, tx_type, source) VALUES ('tx1', 'doc1', 'D001', '2026-01-01', 'B', 'primary');
      INSERT INTO transactions (id, doc_id, filer_id, tx_date, tx_type, source) VALUES ('tx2', 'doc2', 'R001', '2026-01-02', 'S', 'primary');
    `);
    const a = app();
    const houseOnly = await a.request('/api/transactions?since=0&chamber=house', {}, { DB: db } as never);
    const body = (await houseOnly.json()) as { total: number };
    expect(body.total).toBe(1);
  });

  it('a simulated poll (since=<cursor>) reports a fresh absolute total for the SAME filter — never a delta to add on top of the last one', async () => {
    const db = await createInMemoryD1();
    await db.exec(`
      INSERT INTO filers (bioguide_id, chamber, full_name, party) VALUES ('D001', 'house', 'Dem Member', 'Democrat');
      INSERT INTO transactions (id, doc_id, filer_id, tx_date, tx_type, source) VALUES ('tx1', 'doc1', 'D001', '2026-01-01', 'B', 'primary');
    `);
    const a = app();

    const first = await a.request('/api/transactions?since=0&party=D', {}, { DB: db } as never);
    const firstBody = (await first.json()) as { total: number; cursor: number };
    expect(firstBody.total).toBe(1);

    // New matching row arrives (simulates a live filing landing between polls).
    await db.exec(
      "INSERT INTO transactions (id, doc_id, filer_id, tx_date, tx_type, source) VALUES ('tx2', 'doc2', 'D001', '2026-01-02', 'B', 'primary');",
    );

    const poll = await a.request(`/api/transactions?since=${firstBody.cursor}&party=D`, {}, { DB: db } as never);
    const pollBody = (await poll.json()) as { total: number; transactions: unknown[] };
    // The correct client behavior (fixed in dashboardHtml.ts fetchUpdates) is
    // `totalRows = pollBody.total`, i.e. exactly 2 — NOT `1 (previous total) +
    // 1 (this poll's transactions.length)`, which also happens to be 2 here
    // but would silently diverge from the truth on the very next poll if the
    // server ever de-duplicates, gates, or budget-limits a delta. Asserting
    // the absolute value (not a delta) is the point of this test.
    expect(pollBody.total).toBe(2);
    expect(pollBody.transactions).toHaveLength(1);

    // A second, zero-delta poll must not report a stale/zeroed total: the
    // server omits `total` entirely on a no-op poll (rest.ts isIncrementalNoOp)
    // so the client is expected to keep holding the last known-good value —
    // it must never be told "0".
    const zeroDelta = await a.request(`/api/transactions?since=${pollBody.cursor}&party=D`, {}, { DB: db } as never);
    const zeroDeltaBody = (await zeroDelta.json()) as { total?: number; transactions: unknown[] };
    expect(zeroDeltaBody.transactions).toHaveLength(0);
    expect(zeroDeltaBody.total).toBeUndefined();
  });

  it('excludes the same synthetic/placeholder rows from the total as from the returned rows (feed and count stay consistent with each other)', async () => {
    const db = await createInMemoryD1();
    await db.exec(`
      INSERT INTO filers (bioguide_id, chamber, full_name, party) VALUES ('D001', 'house', 'Dem Member', 'Democrat');
      INSERT INTO transactions (id, doc_id, filer_id, tx_date, tx_type, source) VALUES ('tx1', 'doc1', 'D001', '2026-01-01', 'B', 'primary');
      -- Synthetic provider-discovered placeholder (no official filing yet).
      INSERT INTO transactions (id, doc_id, filer_id, tx_date, tx_type, source) VALUES ('tx2', 'provider-missing-fmp-house-abc', 'D001', '2026-01-02', 'B', 'primary');
      -- Competitor-only executive inject with no real OGE filing.
      INSERT INTO transactions (id, doc_id, filer_id, tx_date, tx_type, source) VALUES ('tx3', 'COMPETITOR-xyz', 'EXEC-1', '2026-01-03', 'B', 'competitor_backfill');
    `);
    const a = app();
    const res = await a.request('/api/transactions?since=0', {}, { DB: db } as never);
    const body = (await res.json()) as { total: number; transactions: Array<{ id: string }> };
    expect(body.total).toBe(1);
    expect(body.transactions.map((t) => t.id)).toEqual(['tx1']);
  });
});
