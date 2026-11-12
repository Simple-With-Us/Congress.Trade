import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'libsql';
import { d1Database } from '../../prices/__tests__/sqliteD1.ts';
import { runMigrations } from '../../admin/migrations.ts';
import type { Env } from '../../shared/types.ts';
import {
  INGEST_FAILURE_REASON_PREFIX,
  backfillIngestFailureReviewQueue,
  clearIngestFailureReviewQueueIfRecovered,
  ensureIngestFailureReviewQueueRow,
  inferIngestFailureStage,
  recordGenuineIngestFailure,
  sweepIngestFailureReviewQueue,
} from '../ingestFailureReviewQueue.ts';

describe('ingestFailureReviewQueue', () => {
  let fileDb: Database.Database;
  let d1: ReturnType<typeof d1Database>;

  function makeEnv(): Env {
    return { DB: d1 } as unknown as Env;
  }

  beforeEach(async () => {
    fileDb = new Database(':memory:');
    d1 = d1Database(fileDb);
    await runMigrations(d1);
  });

  afterEach(() => {
    fileDb.close();
  });

  it('infers stages from error prefixes', () => {
    expect(inferIngestFailureStage('fetcher: HTTP 500')).toBe('fetch');
    expect(inferIngestFailureStage('classifier: missing raw')).toBe('parse');
    expect(inferIngestFailureStage('extraction: boom')).toBe('extract');
  });

  it('creates a review row for a genuine ingest failure and is idempotent', async () => {
    const env = makeEnv();
    await d1.prepare(
      `INSERT INTO filings (doc_id, chamber, ingest_status, error, first_seen_at)
       VALUES ('H-FAIL-1', 'house', 'error', 'fetcher: timeout', '2026-01-01T00:00:00Z')`,
    ).run();

    const first = await ensureIngestFailureReviewQueueRow(env, 'H-FAIL-1', 'fetcher: timeout', {
      source: 'test',
    });
    expect(first).toBe('inserted');
    const row = await d1.prepare('SELECT reason, resolved FROM review_queue WHERE doc_id = ?')
      .bind('H-FAIL-1').first<{ reason: string; resolved: number }>();
    expect(row?.reason).toBe(`${INGEST_FAILURE_REASON_PREFIX}fetch`);
    expect(row?.resolved).toBe(0);

    const second = await ensureIngestFailureReviewQueueRow(env, 'H-FAIL-1', 'fetcher: timeout again', {
      source: 'test',
    });
    expect(second).toBe('updated');
    const count = await d1.prepare('SELECT COUNT(*) AS n FROM review_queue').first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('skips published-stale filings with live transactions', async () => {
    const env = makeEnv();
    await d1.prepare(
      `INSERT INTO filings (doc_id, ingest_status, error, first_seen_at)
       VALUES ('S-STALE', 'error', 'late fetch', '2026-01-01T00:00:00Z')`,
    ).run();
    await d1.prepare(
      `INSERT INTO transactions (id, doc_id, deprecated_at) VALUES ('t1', 'S-STALE', NULL)`,
    ).run();
    await d1.prepare(
      `INSERT INTO ingestion_decisions (id, doc_id, action, source, created_at)
       VALUES ('d1', 'S-STALE', 'auto_published', 'test', '2026-01-02T00:00:00Z')`,
    ).run();

    const outcome = await ensureIngestFailureReviewQueueRow(env, 'S-STALE', 'late fetch');
    expect(outcome).toBe('skipped');
    const n = await d1.prepare('SELECT COUNT(*) AS n FROM review_queue').first<{ n: number }>();
    expect(n?.n ?? 0).toBe(0);
  });

  it('recordGenuineIngestFailure stamps error and opens the queue', async () => {
    const env = makeEnv();
    await d1.prepare(
      `INSERT INTO filings (doc_id, ingest_status, first_seen_at)
       VALUES ('H-NEW', 'fetched', '2026-01-01T00:00:00Z')`,
    ).run();
    await recordGenuineIngestFailure(env, 'H-NEW', 'classifier: busted', { source: 'classifier', stage: 'parse' });
    const filing = await d1.prepare('SELECT ingest_status, error FROM filings WHERE doc_id = ?')
      .bind('H-NEW').first<{ ingest_status: string; error: string }>();
    expect(filing?.ingest_status).toBe('error');
    const queue = await d1.prepare('SELECT reason FROM review_queue WHERE doc_id = ?')
      .bind('H-NEW').first<{ reason: string }>();
    expect(queue?.reason).toBe(`${INGEST_FAILURE_REASON_PREFIX}parse`);
  });

  it('clears ingest-failure queue rows when the filing recovers', async () => {
    const env = makeEnv();
    await d1.prepare(
      `INSERT INTO filings (doc_id, ingest_status, first_seen_at)
       VALUES ('H-RECOVER', 'fetched', '2026-01-01T00:00:00Z')`,
    ).run();
    await d1.prepare(
      `INSERT INTO review_queue (doc_id, reason, created_at, resolved, review_revision)
       VALUES ('H-RECOVER', '${INGEST_FAILURE_REASON_PREFIX}fetch', '2026-01-01T00:00:00Z', 0, 1)`,
    ).run();

    const cleared = await clearIngestFailureReviewQueueIfRecovered(env.DB, 'H-RECOVER');
    expect(cleared).toBe(true);
    const n = await d1.prepare('SELECT COUNT(*) AS n FROM review_queue').first<{ n: number }>();
    expect(n?.n ?? 0).toBe(0);
  });

  it('hourly sweep does not queue CT-2453 published-stale or rejected filings', async () => {
    const env = makeEnv();
    await d1.prepare(
      `INSERT INTO filings (doc_id, ingest_status, error, first_seen_at)
       VALUES
         ('S-PUB-STALE', 'error', 'late fetch', '2026-01-01'),
         ('H-REJECTED', 'error', 'bad', '2026-01-02'),
         ('H-GENUINE', 'error', 'fetcher: boom', '2026-01-03')`,
    ).run();
    await d1.prepare(
      `INSERT INTO transactions (id, doc_id, deprecated_at) VALUES ('t1', 'S-PUB-STALE', NULL)`,
    ).run();
    await d1.prepare(
      `INSERT INTO ingestion_decisions (id, doc_id, action, source, created_at)
       VALUES ('d1', 'S-PUB-STALE', 'auto_published', 'test', '2026-01-02T00:00:00Z')`,
    ).run();
    await d1.prepare(
      `INSERT INTO review_queue (doc_id, reason, created_at, resolved, resolution_kind, review_revision)
       VALUES ('H-REJECTED', 'rejected: bad', '2026-01-02T00:00:00Z', 1, 'rejected', 1)`,
    ).run();

    const { backfill } = await sweepIngestFailureReviewQueue(env, { limit: 50 });
    expect(backfill.ensured).toBe(1);
    expect(backfill.skipped).toBe(0);

    const rows = await d1.prepare('SELECT doc_id FROM review_queue WHERE reason LIKE ?')
      .bind('ingest_failure:%').all<{ doc_id: string }>();
    expect(rows.results?.map((r) => r.doc_id)).toEqual(['H-GENUINE']);
  });

  it('backfill dry-run counts eligible rows without writing', async () => {
    const env = makeEnv();
    await d1.prepare(
      `INSERT INTO filings (doc_id, ingest_status, error, first_seen_at)
       VALUES ('A', 'error', 'boom', '2026-01-01'), ('B', 'error', 'bam', '2026-01-02')`,
    ).run();
    const dry = await backfillIngestFailureReviewQueue(env, { dryRun: true });
    expect(dry.matched).toBe(2);
    expect(dry.ensured).toBe(0);
    let n = await d1.prepare('SELECT COUNT(*) AS n FROM review_queue').first<{ n: number }>();
    expect(n?.n ?? 0).toBe(0);

    const applied = await backfillIngestFailureReviewQueue(env, { dryRun: false, limit: 10 });
    expect(applied.ensured).toBe(2);
    n = await d1.prepare('SELECT COUNT(*) AS n FROM review_queue').first<{ n: number }>();
    expect(n?.n ?? 0).toBe(2);
  });

  it('does not let a resolved review row starve an older genuine failure', async () => {
    const env = makeEnv();
    await d1.prepare(
      `INSERT INTO filings (doc_id, ingest_status, error, first_seen_at)
       VALUES
         ('H-RESOLVED', 'error', 'old empty', '2026-02-02'),
         ('H-OLDER', 'error', 'fetcher: still stuck', '2026-01-01')`,
    ).run();
    await d1.prepare(
      `INSERT INTO review_queue (doc_id, reason, created_at, resolved, resolution_kind, resolution_reason, review_revision)
       VALUES ('H-RESOLVED', 'verified_empty: done', '2026-02-02T00:00:00Z', 1, 'verified_empty', 'no trades', 1)`,
    ).run();

    const applied = await backfillIngestFailureReviewQueue(env, { dryRun: false, limit: 1 });
    expect(applied.matched).toBe(1);
    expect(applied.docIds).toEqual(['H-OLDER']);
    expect(applied.ensured).toBe(1);

    const resolved = await d1.prepare(
      'SELECT resolved, resolution_kind FROM review_queue WHERE doc_id = ?',
    ).bind('H-RESOLVED').first<{ resolved: number; resolution_kind: string }>();
    expect(resolved?.resolved).toBe(1);
    expect(resolved?.resolution_kind).toBe('verified_empty');
  });

  it('preserveTerminalStatus keeps persisted rows and existing error text', async () => {
    const env = makeEnv();
    await d1.prepare(
      `INSERT INTO filings (doc_id, ingest_status, error, first_seen_at)
       VALUES
         ('H-DONE', 'persisted', NULL, '2026-01-01'),
         ('H-ERR', 'error', 'fetcher: original', '2026-01-02'),
         ('H-MID', 'fetched', NULL, '2026-01-03')`,
    ).run();
    await recordGenuineIngestFailure(env, 'H-DONE', 'autonomy: dlq', {
      preserveTerminalStatus: true,
      source: 'ingest_dlq',
    });
    await recordGenuineIngestFailure(env, 'H-ERR', 'autonomy: dlq', {
      preserveTerminalStatus: true,
      source: 'ingest_dlq',
    });
    await recordGenuineIngestFailure(env, 'H-MID', 'autonomy: dlq', {
      preserveTerminalStatus: true,
      source: 'ingest_dlq',
    });

    const done = await d1.prepare('SELECT ingest_status, error FROM filings WHERE doc_id = ?')
      .bind('H-DONE').first<{ ingest_status: string; error: string | null }>();
    expect(done?.ingest_status).toBe('persisted');
    expect(done?.error).toBeNull();
    const err = await d1.prepare('SELECT ingest_status, error FROM filings WHERE doc_id = ?')
      .bind('H-ERR').first<{ ingest_status: string; error: string | null }>();
    expect(err?.ingest_status).toBe('error');
    expect(err?.error).toBe('fetcher: original');
    const mid = await d1.prepare('SELECT ingest_status, error FROM filings WHERE doc_id = ?')
      .bind('H-MID').first<{ ingest_status: string; error: string | null }>();
    expect(mid?.ingest_status).toBe('error');
    expect(mid?.error).toBe('autonomy: dlq');

    const queued = await d1.prepare(
      `SELECT doc_id FROM review_queue WHERE reason LIKE 'ingest_failure:%' ORDER BY doc_id`,
    ).all<{ doc_id: string }>();
    expect(queued.results?.map((row) => row.doc_id)).toEqual(['H-ERR', 'H-MID']);
  });

  it('propagates a database error instead of acknowledging the caller', async () => {
    const env = {
      DB: {
        prepare() {
          throw new Error('db down');
        },
      },
    } as unknown as Env;
    await expect(recordGenuineIngestFailure(env, 'H-DOWN', 'fetcher: boom')).rejects.toThrow('db down');
  });
});
