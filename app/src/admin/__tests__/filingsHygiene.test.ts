import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import { buildAdminRouter } from '../routes.ts';
import { MANUAL_TEST_PROBE_DOC_ID } from '../../ingestion/reviewStatusReconcile.ts';

const app = buildAdminRouter();
const AUTH = { Authorization: 'Bearer admin-secret', 'content-type': 'application/json' };

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
CREATE TABLE ingestion_outbox (doc_id TEXT PRIMARY KEY);
CREATE TABLE extraction_runs (id TEXT PRIMARY KEY, doc_id TEXT);
CREATE TABLE disclosure_latency_candidates (doc_id TEXT PRIMARY KEY);
CREATE TABLE deno_runtime_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payload TEXT NOT NULL
);
`;

function makeEnv() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(SCHEMA);
  raw.prepare('INSERT INTO filings (doc_id, ingest_status) VALUES (?, ?)').run(
    MANUAL_TEST_PROBE_DOC_ID,
    'error',
  );
  raw.prepare('INSERT INTO filings (doc_id, ingest_status) VALUES (?, ?)').run(
    'H-desync',
    'classified',
  );
  raw.prepare(
    `INSERT INTO review_queue (doc_id, reason, resolved, resolution_kind, resolution_reason)
     VALUES (?, ?, 1, ?, ?)`,
  ).run('H-desync', 'rejected: admin', 'rejected', 'rejected: admin');

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

  const env = {
    ADMIN_TOKEN: 'admin-secret',
    DB: { prepare } as unknown as D1Database,
  } as never;
  return { env, raw };
}

describe('POST /filings-hygiene', () => {
  it('defaults to dry-run and does not mutate', async () => {
    const { env, raw } = makeEnv();
    const res = await app.request('/filings-hygiene', { method: 'POST', headers: AUTH, body: '{}' }, env);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      dryRun: boolean;
      applied: boolean;
      probe: { found: boolean; deleted: boolean };
      desync: { scanned: number; updated: number };
    };
    expect(body).toMatchObject({
      ok: true,
      dryRun: true,
      applied: false,
      probe: { found: true, deleted: false },
      desync: { scanned: 1, updated: 0 },
    });
    expect(
      (raw.prepare('SELECT COUNT(*) AS n FROM filings WHERE doc_id = ?').get(MANUAL_TEST_PROBE_DOC_ID) as { n: number }).n,
    ).toBe(1);
    expect(
      (raw.prepare('SELECT ingest_status FROM filings WHERE doc_id = ?').get('H-desync') as { ingest_status: string }).ingest_status,
    ).toBe('classified');
  });

  it('dryRun wins over apply', async () => {
    const { env, raw } = makeEnv();
    const res = await app.request(
      '/filings-hygiene',
      { method: 'POST', headers: AUTH, body: JSON.stringify({ apply: true, dryRun: true }) },
      env,
    );
    const body = await res.json() as { applied: boolean; dryRun: boolean };
    expect(body).toMatchObject({ applied: false, dryRun: true });
    expect(
      (raw.prepare('SELECT COUNT(*) AS n FROM filings WHERE doc_id = ?').get(MANUAL_TEST_PROBE_DOC_ID) as { n: number }).n,
    ).toBe(1);
  });

  it('apply:true deletes the probe and reconciles the desynced row', async () => {
    const { env, raw } = makeEnv();
    const res = await app.request(
      '/filings-hygiene',
      { method: 'POST', headers: AUTH, body: JSON.stringify({ apply: true }) },
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as {
      applied: boolean;
      dryRun: boolean;
      probe: { deleted: boolean };
      desync: { updated: number };
    };
    expect(body).toMatchObject({
      applied: true,
      dryRun: false,
      probe: { deleted: true },
      desync: { updated: 1 },
    });
    expect(
      (raw.prepare('SELECT COUNT(*) AS n FROM filings WHERE doc_id = ?').get(MANUAL_TEST_PROBE_DOC_ID) as { n: number }).n,
    ).toBe(0);
    expect(
      (raw.prepare('SELECT ingest_status FROM filings WHERE doc_id = ?').get('H-desync') as { ingest_status: string }).ingest_status,
    ).toBe('error');
  });
});
