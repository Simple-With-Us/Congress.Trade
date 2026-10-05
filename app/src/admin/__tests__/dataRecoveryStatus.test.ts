import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildAdminRouter } from '../routes.ts';
import type { Env } from '../../shared/types.ts';

const app = buildAdminRouter();

const DataRecoveryStatusSchema = z.object({
  queues: z.object({
    ingestionOutboxFailed: z.array(
      z.object({
        doc_id: z.string(),
        chamber: z.string(),
        available_at: z.string(),
        updated_at: z.string(),
        last_error: z.string().nullable(),
      }),
    ),
    ingestionOutboxFailedIdentity: z.object({
      count: z.number().int().nonnegative(),
      fingerprint: z.string().length(64),
      doc_ids: z.array(z.string()),
      fingerprintCoversAll: z.boolean(),
    }),
  }),
});

const SCHEMA = `
CREATE TABLE filings (
  doc_id TEXT PRIMARY KEY,
  chamber TEXT,
  ingest_status TEXT
);
CREATE TABLE transactions (
  id TEXT PRIMARY KEY,
  doc_id TEXT,
  source TEXT,
  tx_date TEXT,
  created_at TEXT
);
CREATE TABLE ingestion_outbox (
  doc_id TEXT PRIMARY KEY,
  chamber TEXT NOT NULL,
  source_url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  dead_letter_cycles INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE delivery_outbox (
  tx_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  available_at TEXT NOT NULL
);
CREATE TABLE filers (
  id TEXT PRIMARY KEY,
  party TEXT,
  state TEXT,
  photo_url TEXT
);
CREATE TABLE price_eod_stats (id INTEGER PRIMARY KEY, row_count INTEGER);
CREATE TABLE securities_ref (id TEXT PRIMARY KEY, latest_price_date TEXT);
`;

function makeEnv(): Env {
  const raw = new DatabaseSync(':memory:');
  raw.exec(SCHEMA);
  raw.prepare(
    `INSERT INTO ingestion_outbox
      (doc_id, chamber, status, available_at, last_error, created_at, updated_at)
     VALUES (?, ?, 'failed', ?, ?, ?, ?)`,
  ).run(
    'S-6bf3b6f7-aaaa',
    'senate',
    '2026-10-04T16:14:00.000Z',
    'fetch timeout',
    '2026-09-28T10:00:00.000Z',
    '2026-10-04T19:00:00.000Z',
  );
  raw.prepare(
    `INSERT INTO ingestion_outbox
      (doc_id, chamber, status, available_at, last_error, created_at, updated_at)
     VALUES (?, ?, 'failed', ?, ?, ?, ?)`,
  ).run(
    'S-9e2ff733-bbbb',
    'senate',
    '2026-10-04T16:20:00.000Z',
    'fetch timeout',
    '2026-09-28T11:00:00.000Z',
    '2026-10-04T19:05:00.000Z',
  );
  raw.prepare('INSERT INTO price_eod_stats (id, row_count) VALUES (1, 0)').run();

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

  return {
    ADMIN_OPEN_IN_DEV: 'true',
    DB: { prepare },
  } as unknown as Env;
}

describe('GET /data-recovery/status', () => {
  it('exposes failed ingestion_outbox row identity (read-only)', async () => {
    const res = await app.request('http://localhost/data-recovery/status', {}, makeEnv());
    expect(res.status).toBe(200);
    const body = DataRecoveryStatusSchema.parse(await res.json());
    expect(body.queues.ingestionOutboxFailed).toHaveLength(2);
    expect(body.queues.ingestionOutboxFailed[0]).toMatchObject({
      doc_id: 'S-6bf3b6f7-aaaa',
      chamber: 'senate',
      available_at: '2026-10-04T16:14:00.000Z',
      last_error: 'fetch timeout',
    });
    expect(body.queues.ingestionOutboxFailedIdentity.count).toBe(2);
    expect(body.queues.ingestionOutboxFailedIdentity.doc_ids).toEqual([
      'S-6bf3b6f7-aaaa',
      'S-9e2ff733-bbbb',
    ]);
    expect(body.queues.ingestionOutboxFailedIdentity.fingerprintCoversAll).toBe(true);
  });
});
