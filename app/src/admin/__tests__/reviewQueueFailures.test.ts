import { describe, it, expect } from 'vitest';
import { buildAdminRouter } from '../routes.ts';
import { makeReviewQueueTestDb, type ReviewQueueFixtureRow } from './reviewQueueTestDb.ts';
import { SENATE_INTAKE_STATUS_KV_KEY } from '../../ingestion/senateIntakeStatus.ts';
import type { Env } from '../../shared/types.ts';

/**
 * Pipeline-failure visibility for the admin review queue: ingestion-outbox
 * dead letters and durable-queue failed rows are filing-pipeline failures
 * that neither the review queue nor the ingest-failure listing ever shows,
 * and the Senate intake relay (the Mac eFD fetcher) had no status anywhere.
 * The queue response now embeds both failure listings on request and always
 * carries the relay heartbeat.
 */

const app = buildAdminRouter();
const TOKEN = 'test-admin-token';
const AUTH = { Authorization: `Bearer ${TOKEN}` };

interface DeadLetterItem {
  kind: string;
  docId: string;
  chamber: string;
  attempts: number;
  error: string | null;
  errorTruncated: boolean;
  parked: boolean;
}

interface DlqFailedItem {
  kind: string;
  queueName: string;
  type: string;
  dedupeKey: string | null;
  attempts: number;
  deadLetterCycles: number;
}

interface ReviewQueueBody {
  ingestFailures: Array<{ docId: string }>;
  deadLetters: DeadLetterItem[];
  deadLettersAvailable: boolean;
  dlqFailed: DlqFailedItem[];
  dlqFailedAvailable: boolean;
  totals: { deadLetters: number; deadLettersParked: number; dlqFailed: number };
  senateIntake: {
    received: number; newCount: number; dryRun: boolean; stale: boolean; failed?: boolean;
  } | null;
}

function tsAt(i: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0) + i * 60_000).toISOString();
}

function fakeKv() {
  const map = new Map<string, string>();
  return {
    map,
    async get(key: string, type?: string) {
      const v = map.get(key);
      if (v == null) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key: string, value: string) {
      map.set(key, value);
    },
  };
}

/** Partial Env: the admin router reads only ADMIN_TOKEN, DB, and CONFIG_KV here. */
function env(db: ReturnType<typeof makeReviewQueueTestDb>, kv?: ReturnType<typeof fakeKv>): Env {
  // @ts-expect-error -- partial env for the routes under test.
  return { ADMIN_TOKEN: TOKEN, DB: db, ...(kv ? { CONFIG_KV: kv } : {}) };
}

function fixture(): ReviewQueueFixtureRow[] {
  return [
    {
      docId: 'DL-1', createdAt: tsAt(10), noReview: true, chamber: 'senate',
      ingestStatus: 'persisted', outboxUpdatedAt: tsAt(12), error: 'delivery exploded',
    },
    {
      docId: 'DL-2', createdAt: tsAt(9), noReview: true, chamber: 'house',
      ingestStatus: 'persisted', outboxUpdatedAt: tsAt(11),
      error: `second failure ${'x'.repeat(400)}`,
    },
    {
      // Outbox row still pending: not a dead letter.
      docId: 'OK-1', createdAt: tsAt(8), noReview: true, chamber: 'senate',
      ingestStatus: 'persisted', outboxUpdatedAt: tsAt(10),
    },
    {
      docId: 'IF-1', createdAt: tsAt(7), noReview: true, chamber: 'senate',
      ingestStatus: 'error', error: 'fetcher: senate ptr.pdf -> 503', firstSeenAt: tsAt(7),
    },
  ];
}

const DLQ_DDL = `CREATE TABLE deno_runtime_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  queue_name TEXT NOT NULL,
  dedupe_key TEXT,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  dead_letter_pending INTEGER NOT NULL DEFAULT 0,
  dead_letter_cycles INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  lease_until TEXT,
  lease_token TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

type TestDb = ReturnType<typeof makeReviewQueueTestDb>;

async function seedFailures(db: TestDb, withDlq: boolean): Promise<void> {
  for (const id of ['DL-1', 'DL-2']) {
    await db.prepare("UPDATE ingestion_outbox SET status = 'failed', attempts = 5 WHERE doc_id = ?").bind(id).run();
  }
  if (!withDlq) return;
  await db.prepare(DLQ_DDL).run();
  const insert = `INSERT INTO deno_runtime_queue
    (queue_name, dedupe_key, payload, status, attempts, dead_letter_cycles, available_at, last_error, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  await db.prepare(insert).bind('ingest', 'filing.new:S-1', '{"type":"filing.new"}', 'failed', 4, 1, tsAt(20), 'consumer blew up', tsAt(18), tsAt(20)).run();
  await db.prepare(insert).bind('delivery', null, '{"type":"webhook.deliver"}', 'failed', 2, 0, tsAt(19), 'HTTP 500 from receiver', tsAt(17), tsAt(19)).run();
  await db.prepare(insert).bind('ingest', 'filing.new:S-2', '{"type":"filing.new"}', 'pending', 0, 0, tsAt(19), null, tsAt(17), tsAt(19)).run();
}

describe('GET /review-queue pipeline failures', () => {
  it('embeds dead letters and durable-queue failures with totals', async () => {
    const db = makeReviewQueueTestDb(fixture());
    await seedFailures(db, true);
    const res = await app.request('/review-queue?include=ingest_failures,dead_letters,dlq_failed', { headers: AUTH }, env(db));
    expect(res.status).toBe(200);
    const body = await res.json() as ReviewQueueBody;

    expect(body.ingestFailures.map((i) => i.docId)).toContain('IF-1');

    expect(body.deadLetters).toHaveLength(2);
    expect(body.deadLetters[0]).toMatchObject({ kind: 'dead_letter', docId: 'DL-1', chamber: 'senate', attempts: 5, error: 'delivery exploded', errorTruncated: false });
    const dl2 = body.deadLetters.find((i) => i.docId === 'DL-2');
    if (!dl2) throw new Error('DL-2 dead letter missing from the response');
    expect(dl2.errorTruncated).toBe(true);
    expect(dl2.error?.length ?? 0).toBeLessThanOrEqual(300);

    expect(body.dlqFailed).toHaveLength(2);
    expect(body.dlqFailed[0]).toMatchObject({ kind: 'dlq_failed', queueName: 'ingest', type: 'filing.new', dedupeKey: 'filing.new:S-1', attempts: 4, deadLetterCycles: 1 });
    expect(body.dlqFailed[1]).toMatchObject({ type: 'webhook.deliver', dedupeKey: null });
    expect(body.dlqFailedAvailable).toBe(true);
    expect(body.deadLettersAvailable).toBe(true);

    expect(body.totals.deadLetters).toBe(2);
    expect(body.totals.dlqFailed).toBe(2);
  });

  it('splits parked dead letters out of the active total and flags them in the listing', async () => {
    const rows = [...fixture(), {
      docId: 'DL-3', createdAt: tsAt(6), noReview: true, chamber: 'senate',
      ingestStatus: 'persisted', outboxUpdatedAt: tsAt(13), error: 'parked:empty_fetch_handoff',
    }];
    const db = makeReviewQueueTestDb(rows);
    await seedFailures(db, true);
    await db.prepare("UPDATE ingestion_outbox SET status = 'failed', attempts = 1 WHERE doc_id = ?").bind('DL-3').run();
    const res = await app.request('/review-queue?include=dead_letters', { headers: AUTH }, env(db));
    expect(res.status).toBe(200);
    const body = await res.json() as ReviewQueueBody;
    expect(body.deadLetters).toHaveLength(3);
    expect(body.deadLetters.find((i) => i.docId === 'DL-3')?.parked).toBe(true);
    expect(body.deadLetters.find((i) => i.docId === 'DL-1')?.parked).toBe(false);
    expect(body.totals.deadLetters).toBe(2);
    expect(body.totals.deadLettersParked).toBe(1);
  });

  it('lists durable-queue failures even when one payload is malformed JSON', async () => {
    const db = makeReviewQueueTestDb(fixture());
    await seedFailures(db, true);
    await db.prepare(`INSERT INTO deno_runtime_queue
      (queue_name, dedupe_key, payload, status, attempts, dead_letter_cycles, available_at, last_error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind('ingest', 'filing.new:S-3', 'not json at all', 'failed', 1, 0, tsAt(21), 'corrupt payload', tsAt(18), tsAt(21)).run();
    const res = await app.request('/review-queue?include=dlq_failed', { headers: AUTH }, env(db));
    expect(res.status).toBe(200);
    const body = await res.json() as ReviewQueueBody;
    expect(body.dlqFailedAvailable).toBe(true);
    expect(body.dlqFailed).toHaveLength(3);
    expect(body.dlqFailed[0]).toMatchObject({ dedupeKey: 'filing.new:S-3', type: '' });
    expect(body.totals.dlqFailed).toBe(3);
  });

  it('omits the listings without include but keeps the totals and a null relay status', async () => {
    const db = makeReviewQueueTestDb(fixture());
    await seedFailures(db, true);
    const res = await app.request('/review-queue', { headers: AUTH }, env(db));
    expect(res.status).toBe(200);
    const body = await res.json() as ReviewQueueBody;
    expect(body.deadLetters).toBeUndefined();
    expect(body.dlqFailed).toBeUndefined();
    expect(body.totals.deadLetters).toBe(2);
    expect(body.totals.dlqFailed).toBe(2);
    expect(body.senateIntake).toBeNull();
  });

  it('reports the durable queue as unavailable when its table does not exist yet', async () => {
    const db = makeReviewQueueTestDb(fixture());
    await seedFailures(db, false);
    const res = await app.request('/review-queue?include=dlq_failed', { headers: AUTH }, env(db));
    expect(res.status).toBe(200);
    const body = await res.json() as ReviewQueueBody;
    expect(body.dlqFailed).toEqual([]);
    expect(body.dlqFailedAvailable).toBe(false);
    expect(body.totals.dlqFailed).toBe(0);
  });

  it('carries the Senate intake relay heartbeat, fresh and stale', async () => {
    const db = makeReviewQueueTestDb(fixture());
    const kv = fakeKv();
    kv.map.set(SENATE_INTAKE_STATUS_KV_KEY, JSON.stringify({
      receivedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      received: 12, converted: 11, rejected: 1, newCount: 3, dryRun: false,
    }));
    const fresh = await (await app.request('/review-queue', { headers: AUTH }, env(db, kv))).json() as ReviewQueueBody;
    expect(fresh.senateIntake).toMatchObject({ received: 12, newCount: 3, stale: false });

    kv.map.set(SENATE_INTAKE_STATUS_KV_KEY, JSON.stringify({
      receivedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
      received: 4, converted: 4, rejected: 0, newCount: 0, dryRun: true,
    }));
    const stale = await (await app.request('/review-queue', { headers: AUTH }, env(db, kv))).json() as ReviewQueueBody;
    expect(stale.senateIntake).toMatchObject({ received: 4, dryRun: true, stale: true });

    kv.map.set(SENATE_INTAKE_STATUS_KV_KEY, JSON.stringify({
      receivedAt: new Date(Date.now() - 60_000).toISOString(),
      received: 4, converted: 4, rejected: 0, newCount: 0, dryRun: false, failed: true,
    }));
    const failed = await (await app.request('/review-queue', { headers: AUTH }, env(db, kv))).json() as ReviewQueueBody;
    expect(failed.senateIntake).toMatchObject({ failed: true, stale: false });
  });
});
