/**
 * Hourly autonomy sweep delegates to the honest review-status reconciler.
 * These tests pin the wrapper contract: apply=true, published→persisted.
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../shared/types.ts';
import { sweepResolvedStatusDesync } from '../autonomySweeps.ts';

const SCHEMA = `
CREATE TABLE filings (
  doc_id TEXT PRIMARY KEY,
  ingest_status TEXT,
  error TEXT
);
CREATE TABLE review_queue (
  doc_id TEXT PRIMARY KEY,
  reason TEXT,
  resolved INTEGER,
  resolution_kind TEXT,
  resolution_reason TEXT
);
CREATE TABLE transactions (
  id TEXT PRIMARY KEY,
  doc_id TEXT,
  deprecated_at TEXT
);
CREATE TABLE ingestion_decisions (
  id TEXT PRIMARY KEY,
  doc_id TEXT,
  action TEXT,
  created_at TEXT
);
`;

function makeEnv() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(SCHEMA);
  const prepare = (sql: string) => {
    let params: unknown[] = [];
    const api = {
      bind(...values: unknown[]) {
        params = values;
        return api;
      },
      async first<T>() {
        return (raw.prepare(sql).get(...params) ?? null) as T | null;
      },
      async all<T>() {
        return { results: raw.prepare(sql).all(...params) as T[] };
      },
      async run() {
        const info = raw.prepare(sql).run(...params);
        return { success: true, meta: { changes: Number(info.changes) } };
      },
    };
    return api;
  };
  return { raw, env: { DB: { prepare } as unknown as D1Database } as unknown as Env };
}

describe('sweepResolvedStatusDesync', () => {
  it('stamps persisted when a resolved filing produced transactions', async () => {
    const { raw, env } = makeEnv();
    raw.exec(`
      INSERT INTO filings (doc_id, ingest_status) VALUES ('H-1', 'classified');
      INSERT INTO review_queue (doc_id, reason, resolved, resolution_kind, resolution_reason)
        VALUES ('H-1', 'low_confidence', 1, 'published', 'auto_published');
      INSERT INTO transactions (id, doc_id, deprecated_at) VALUES ('tx-1', 'H-1', NULL);
    `);
    const res = await sweepResolvedStatusDesync(env);
    expect(res).toEqual({ scanned: 1, reconciled: 1 });
    const row = raw.prepare('SELECT ingest_status FROM filings WHERE doc_id = ?').get('H-1') as {
      ingest_status: string;
    };
    expect(row.ingest_status).toBe('persisted');
  });

  it('stamps a terminal error when a resolved filing was rejected', async () => {
    const { raw, env } = makeEnv();
    raw.exec(`
      INSERT INTO filings (doc_id, ingest_status) VALUES ('H-2', 'extraction_pending_local');
      INSERT INTO review_queue (doc_id, reason, resolved, resolution_kind, resolution_reason)
        VALUES ('H-2', 'rejected: empty', 1, 'rejected', 'rejected: empty');
    `);
    const res = await sweepResolvedStatusDesync(env);
    expect(res.reconciled).toBe(1);
    const row = raw.prepare('SELECT ingest_status FROM filings WHERE doc_id = ?').get('H-2') as {
      ingest_status: string;
    };
    expect(row.ingest_status).toBe('error');
  });

  it('covers needs_review, which the strandable-status sweeps deliberately skip', async () => {
    const { raw, env } = makeEnv();
    raw.exec(`
      INSERT INTO filings (doc_id, ingest_status) VALUES ('H-3', 'needs_review');
      INSERT INTO review_queue (doc_id, reason, resolved, resolution_kind, resolution_reason)
        VALUES ('H-3', 'empty', 1, 'verified_empty', 'doc_class_empty_no_transactions');
    `);
    await sweepResolvedStatusDesync(env);
    const row = raw.prepare('SELECT ingest_status FROM filings WHERE doc_id = ?').get('H-3') as {
      ingest_status: string;
    };
    expect(row.ingest_status).toBe('verified_empty');
  });

  it('is a no-op when nothing is desynced', async () => {
    const { env } = makeEnv();
    const res = await sweepResolvedStatusDesync(env);
    expect(res).toEqual({ scanned: 0, reconciled: 0 });
  });
});
