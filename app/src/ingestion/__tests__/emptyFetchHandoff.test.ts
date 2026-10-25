import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'libsql';
import { d1Database, d1OnlyEnv } from '../../prices/__tests__/sqliteD1.ts';
import { runMigrations } from '../../admin/migrations.ts';
import type { Env, QueueMessage } from '../../shared/types.ts';
import { FETCH_NOT_PUBLISHED_WINDOW_MS } from '../fetcher.ts';
import {
  OPERATIONAL_INGEST_STATUSES,
  VALID_INGEST_STATUSES,
  emptyFetchAlertWhere,
  isCompletedEmptyRawHandoff,
  isUngroundedIngestStatus,
} from '../emptyFetchHandoff.ts';
import {
  sweepCompletedEmptyRawHandoff,
  sweepUngroundedIngestStatus,
} from '../autonomySweeps.ts';
import { evaluateEmptyFetchHandoff } from '../pipelineLoudAlerts.ts';
import { checkPipelineHealth, emptyFetchHandoffHealthCheck } from '../../shared/pipelineHealth.ts';

vi.mock('unpdf', () => ({
  getDocumentProxy: vi.fn(),
  extractText: vi.fn(),
}));

/** Literal allowed set. Compared to VALID_INGEST_STATUSES so the test names every legal status itself. */
const ALLOWED_INGEST_STATUSES = [
  'new',
  'fetched',
  'classified',
  'extraction_pending_local',
  'extracted',
  'persisted',
  'needs_review',
  'verified_empty',
  'error',
] as const;

const COMPLETED_EMPTY_ALLOWED = ['persisted', 'verified_empty', 'error', 'needs_review'] as const;

/** Same operational set the sweep refuses to re-drive. */
const OPERATIONAL_NOT_REDRIVEN = ['not_found', 'failed', 'provider_seeded'] as const;

/** Invalid statuses the ungrounded rule catches. NULL is a status, not a string. */
const BLOCKED_STATUSES = ['pending', 'published', 'bogus', '', null] as const;

function unusedBinding<T extends object>(label: string): T {
  const binding: object = new Proxy({}, {
    get(_target, prop) {
      if (prop === 'then') return undefined;
      return () => Promise.reject(new Error(`${label}.${String(prop)} is not used by this fixture`));
    },
  });
  return binding as T;
}

describe('empty fetch handoff', () => {
  const now = new Date('2026-10-25T12:00:00.000Z');
  const olderThanWindow = new Date(now.getTime() - FETCH_NOT_PUBLISHED_WINDOW_MS - 86_400_000).toISOString();
  const insideWindow = new Date(now.getTime() - FETCH_NOT_PUBLISHED_WINDOW_MS + 3_600_000).toISOString();

  let fileDb: Database.Database;
  let d1: ReturnType<typeof d1Database>;
  let sent: Array<{ message: QueueMessage }>;

  function queueResponse() {
    return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
  }

  function env(): Env {
    const ingestQueue = {
      metrics: async () => ({ backlogCount: 0, backlogBytes: 0 }),
      send: async (message: QueueMessage) => {
        sent.push({ message });
        return queueResponse();
      },
      sendBatch: async () => queueResponse(),
    } satisfies Queue<QueueMessage>;
    const deliveryQueue = {
      metrics: async () => ({ backlogCount: 0, backlogBytes: 0 }),
      send: async () => queueResponse(),
      sendBatch: async () => queueResponse(),
    } satisfies Queue<QueueMessage>;
    const fixture = {
      ...d1OnlyEnv(d1),
      INGEST_QUEUE: ingestQueue,
      DELIVERY_QUEUE: deliveryQueue,
      RAW_FILES: unusedBinding<R2Bucket>('RAW_FILES'),
      CONFIG_KV: unusedBinding<KVNamespace>('CONFIG_KV'),
    } satisfies Env;
    return fixture;
  }

  async function insertFiling(row: {
    doc_id: string;
    ingest_status: string | null;
    first_seen_at: string | null;
    raw_object_key?: string | null;
    source_url?: string | null;
    chamber?: string;
    extractor?: string | null;
  }) {
    await d1.prepare(
      `INSERT INTO filings (doc_id, chamber, ingest_status, doc_kind, first_seen_at, raw_object_key, source_url, extractor)
       VALUES (?, ?, ?, 'text_pdf', ?, ?, ?, ?)`,
    ).bind(
      row.doc_id,
      row.chamber ?? 'executive',
      row.ingest_status,
      row.first_seen_at,
      row.raw_object_key ?? null,
      row.source_url ?? 'https://example.test/filing.pdf',
      row.extractor ?? null,
    ).run();
  }

  async function insertOutbox(docId: string, status: string, cycles = 0) {
    const at = olderThanWindow;
    await d1.prepare(
      `INSERT INTO ingestion_outbox
         (doc_id, chamber, source_url, status, attempts, dead_letter_cycles, available_at, created_at, updated_at)
       VALUES (?, 'executive', 'https://example.test/filing.pdf', ?, 1, ?, ?, ?, ?)`,
    ).bind(docId, status, cycles, at, at, at).run();
  }

  async function insertLiveTx(docId: string) {
    await d1.prepare(
      `INSERT INTO transactions (id, doc_id, source, created_at) VALUES (?, ?, 'primary', ?)`,
    ).bind(`tx-${docId}`, docId, olderThanWindow).run();
  }

  beforeEach(async () => {
    fileDb = new Database(':memory:');
    d1 = d1Database(fileDb);
    sent = [];
    await runMigrations(d1);
  });

  afterEach(() => {
    try { fileDb.close(); } catch { /* already closed */ }
  });

  function facts(ingestStatus: string | null, overrides: Partial<{
    docId: string;
    rawObjectKey: string | null;
    liveTransactionCount: number;
  }> = {}) {
    return {
      docId: overrides.docId ?? 'E-2026-example',
      ingestStatus,
      rawObjectKey: overrides.rawObjectKey === undefined ? '' : overrides.rawObjectKey,
      liveTransactionCount: overrides.liveTransactionCount ?? 0,
    };
  }

  it('matrix: blocks invalid statuses and allows every IngestStatus, live transactions, and raw objects', () => {
    expect([...ALLOWED_INGEST_STATUSES]).toEqual([...VALID_INGEST_STATUSES]);
    expect([...OPERATIONAL_NOT_REDRIVEN]).toEqual([...OPERATIONAL_INGEST_STATUSES]);
    for (const status of ALLOWED_INGEST_STATUSES) {
      expect(isUngroundedIngestStatus(facts(status)), status).toBe(false);
      expect(isUngroundedIngestStatus(facts(status, { liveTransactionCount: 2 })), `live ${status}`).toBe(false);
      expect(isUngroundedIngestStatus(facts(status, { rawObjectKey: `raw/${status}` })), `raw ${status}`).toBe(false);
      const completedEmpty = (COMPLETED_EMPTY_ALLOWED as readonly string[]).includes(status);
      expect(isCompletedEmptyRawHandoff({
        ...facts(status),
        outboxStatus: 'completed',
      }), `completed ${status}`).toBe(!completedEmpty);
      expect(isCompletedEmptyRawHandoff({
        ...facts(status, { liveTransactionCount: 2 }),
        outboxStatus: 'completed',
      }), `completed live ${status}`).toBe(false);
      expect(isCompletedEmptyRawHandoff({
        ...facts(status, { rawObjectKey: `raw/${status}` }),
        outboxStatus: 'completed',
      }), `completed raw ${status}`).toBe(false);
    }
    for (const status of OPERATIONAL_NOT_REDRIVEN) {
      expect(isUngroundedIngestStatus(facts(status)), status).toBe(false);
      expect(isCompletedEmptyRawHandoff({
        ...facts(status),
        outboxStatus: 'completed',
      }), `completed ${status}`).toBe(false);
    }
    for (const status of BLOCKED_STATUSES) {
      expect(isUngroundedIngestStatus(facts(status, {
        rawObjectKey: null,
        liveTransactionCount: 0,
      })), JSON.stringify(status)).toBe(true);
      expect(isCompletedEmptyRawHandoff({
        ...facts(status, { rawObjectKey: null, liveTransactionCount: 0 }),
        outboxStatus: 'completed',
      }), `completed ${JSON.stringify(status)}`).toBe(true);
    }
    expect(isUngroundedIngestStatus(facts('pending', { liveTransactionCount: 1 }))).toBe(false);
    expect(isUngroundedIngestStatus(facts('classified', { liveTransactionCount: 4 }))).toBe(false);
    expect(isUngroundedIngestStatus(facts('pending', { rawObjectKey: 'raw/E-2026-example' }))).toBe(false);
    expect(isUngroundedIngestStatus(facts('fetched', { rawObjectKey: 'raw/E-2026-example' }))).toBe(false);
    expect(isUngroundedIngestStatus(facts('pending', { rawObjectKey: '   ' }))).toBe(true);
    expect(isUngroundedIngestStatus(facts('pending', { docId: 'provider-missing-oge-1' }))).toBe(false);
    expect(isCompletedEmptyRawHandoff({
      ...facts('new'),
      outboxStatus: 'completed',
    })).toBe(true);
    expect(isUngroundedIngestStatus(facts('new'))).toBe(false);
    expect(isCompletedEmptyRawHandoff({
      ...facts('error'),
      outboxStatus: 'completed',
    })).toBe(false);
    expect(isCompletedEmptyRawHandoff({
      ...facts('pending', { rawObjectKey: 'raw/kept' }),
      outboxStatus: 'completed',
    })).toBe(false);
  });

  it('redrives only the blocked matrix rows and leaves allowed rows alone', async () => {
    for (const status of VALID_INGEST_STATUSES) {
      await insertFiling({
        doc_id: `valid-${status}`,
        ingest_status: status,
        first_seen_at: olderThanWindow,
        raw_object_key: '',
      });
    }
    for (const status of BLOCKED_STATUSES) {
      const docId = status === null ? 'blocked-null' : `blocked-${status || 'blank'}`;
      await insertFiling({
        doc_id: docId,
        ingest_status: status,
        first_seen_at: olderThanWindow,
        raw_object_key: null,
      });
    }
    for (const status of OPERATIONAL_NOT_REDRIVEN) {
      await insertFiling({
        doc_id: `operational-${status}`,
        ingest_status: status,
        first_seen_at: olderThanWindow,
        raw_object_key: null,
        extractor: status === 'provider_seeded' ? 'fmp-senate-latest' : 'watcher',
      });
    }
    await insertFiling({
      doc_id: 'pending-has-raw',
      ingest_status: 'pending',
      first_seen_at: olderThanWindow,
      raw_object_key: 'raw/pending-has-raw',
    });
    await insertFiling({
      doc_id: 'pending-live-tx',
      ingest_status: 'pending',
      first_seen_at: olderThanWindow,
    });
    await insertLiveTx('pending-live-tx');
    await insertFiling({
      doc_id: 'classified-live-tx',
      ingest_status: 'classified',
      first_seen_at: olderThanWindow,
    });
    await insertLiveTx('classified-live-tx');
    await insertFiling({
      doc_id: 'pending-young',
      ingest_status: 'pending',
      first_seen_at: insideWindow,
    });
    await insertFiling({
      doc_id: 'provider-missing-oge-old',
      ingest_status: 'pending',
      first_seen_at: olderThanWindow,
    });
    await insertFiling({
      doc_id: 'pending-whitespace-raw',
      ingest_status: 'pending',
      first_seen_at: olderThanWindow,
      raw_object_key: '   ',
    });
    await d1.prepare(
      `INSERT INTO review_queue (doc_id, reason, resolved, created_at) VALUES ('pending-resolved', 'done', 1, ?)`,
    ).bind(olderThanWindow).run();
    await insertFiling({
      doc_id: 'pending-resolved',
      ingest_status: 'pending',
      first_seen_at: olderThanWindow,
    });

    const result = await sweepUngroundedIngestStatus(env(), now);
    const rearmed = new Set(result.docIds);

    for (const status of VALID_INGEST_STATUSES) {
      expect(rearmed.has(`valid-${status}`), status).toBe(false);
      const row = await d1.prepare(`SELECT ingest_status FROM filings WHERE doc_id = ?`)
        .bind(`valid-${status}`).first<{ ingest_status: string }>();
      expect(row?.ingest_status, status).toBe(status);
    }
    for (const status of OPERATIONAL_NOT_REDRIVEN) {
      const docId = `operational-${status}`;
      expect(rearmed.has(docId), status).toBe(false);
      const row = await d1.prepare(
        `SELECT ingest_status, extractor FROM filings WHERE doc_id = ?`,
      ).bind(docId).first<{ ingest_status: string; extractor: string | null }>();
      expect(row?.ingest_status, status).toBe(status);
      expect(row?.extractor, status).toBe(status === 'provider_seeded' ? 'fmp-senate-latest' : 'watcher');
    }
    for (const status of BLOCKED_STATUSES) {
      const docId = status === null ? 'blocked-null' : `blocked-${status || 'blank'}`;
      expect(rearmed.has(docId), JSON.stringify(status)).toBe(true);
      const row = await d1.prepare(`SELECT ingest_status, raw_object_key, doc_kind FROM filings WHERE doc_id = ?`)
        .bind(docId).first<{ ingest_status: string; raw_object_key: string | null; doc_kind: string }>();
      expect(row?.ingest_status).toBe('new');
      expect(row?.raw_object_key).toBeNull();
      expect(row?.doc_kind).toBe('unknown');
    }
    expect(rearmed.has('pending-whitespace-raw')).toBe(true);
    for (const kept of ['pending-has-raw', 'pending-live-tx', 'classified-live-tx', 'pending-young', 'provider-missing-oge-old', 'pending-resolved']) {
      expect(rearmed.has(kept), kept).toBe(false);
    }
    const rawKept = await d1.prepare(`SELECT ingest_status, raw_object_key FROM filings WHERE doc_id = ?`)
      .bind('pending-has-raw').first<{ ingest_status: string; raw_object_key: string }>();
    expect(rawKept?.ingest_status).toBe('pending');
    expect(rawKept?.raw_object_key).toBe('raw/pending-has-raw');
    expect(sent.map((entry) => (entry.message as { docId: string }).docId).sort()).toEqual(
      [...rearmed].sort(),
    );
    expect(result.rearmed).toBe(rearmed.size);
    expect(result.dryRun).toBe(false);
  });

  it('dryRun reports a pending filing and writes nothing', async () => {
    await insertFiling({
      doc_id: 'pending-dry',
      ingest_status: 'pending',
      first_seen_at: olderThanWindow,
    });
    const result = await sweepUngroundedIngestStatus(env(), now, { dryRun: true });
    expect(result).toMatchObject({ dryRun: true, matched: 1, rearmed: 0, parked: 0, docIds: ['pending-dry'] });
    const row = await d1.prepare(`SELECT ingest_status FROM filings WHERE doc_id = ?`)
      .bind('pending-dry').first<{ ingest_status: string }>();
    expect(row?.ingest_status).toBe('pending');
    expect(sent).toEqual([]);
  });

  it('treats a completed outbox with an empty raw key as not done, and leaves terminal or stored rows', async () => {
    await insertFiling({ doc_id: 'completed-pending', ingest_status: 'pending', first_seen_at: olderThanWindow, raw_object_key: '' });
    await insertOutbox('completed-pending', 'completed', 0);
    await insertFiling({ doc_id: 'completed-new', ingest_status: 'new', first_seen_at: olderThanWindow, raw_object_key: null });
    await insertOutbox('completed-new', 'completed', 1);
    await insertFiling({ doc_id: 'completed-error', ingest_status: 'error', first_seen_at: olderThanWindow, raw_object_key: null });
    await insertOutbox('completed-error', 'completed', 0);
    await insertFiling({ doc_id: 'completed-stored', ingest_status: 'pending', first_seen_at: olderThanWindow, raw_object_key: 'raw/completed-stored' });
    await insertOutbox('completed-stored', 'completed', 0);
    await insertFiling({ doc_id: 'completed-capped', ingest_status: 'pending', first_seen_at: olderThanWindow, raw_object_key: '' });
    await insertOutbox('completed-capped', 'completed', 5);
    await d1.prepare(
      `INSERT INTO review_queue (doc_id, reason, payload, resolved, created_at) VALUES ('completed-capped', 'unpublished:stale', '{}', 0, ?)`,
    ).bind(olderThanWindow).run();
    await insertFiling({ doc_id: 'completed-null', ingest_status: null, first_seen_at: olderThanWindow, raw_object_key: null });
    await insertOutbox('completed-null', 'completed', 0);
    await insertFiling({
      doc_id: 'completed-provider-seeded',
      ingest_status: 'provider_seeded',
      first_seen_at: olderThanWindow,
      raw_object_key: null,
      extractor: 'fmp-senate-latest',
    });
    await insertOutbox('completed-provider-seeded', 'completed', 0);

    const result = await sweepCompletedEmptyRawHandoff(env(), now);
    expect(result.docIds.sort()).toEqual(['completed-capped', 'completed-new', 'completed-null', 'completed-pending']);
    expect(result.rearmed).toBe(3);
    expect(result.parked).toBe(1);

    const pending = await d1.prepare(`SELECT ingest_status FROM filings WHERE doc_id = ?`)
      .bind('completed-pending').first<{ ingest_status: string }>();
    expect(pending?.ingest_status).toBe('new');
    const stillNew = await d1.prepare(`SELECT ingest_status FROM filings WHERE doc_id = ?`)
      .bind('completed-new').first<{ ingest_status: string }>();
    expect(stillNew?.ingest_status).toBe('new');
    const errored = await d1.prepare(`SELECT ingest_status FROM filings WHERE doc_id = ?`)
      .bind('completed-error').first<{ ingest_status: string }>();
    expect(errored?.ingest_status).toBe('error');
    const stored = await d1.prepare(`SELECT raw_object_key, ingest_status FROM filings WHERE doc_id = ?`)
      .bind('completed-stored').first<{ raw_object_key: string; ingest_status: string }>();
    expect(stored?.raw_object_key).toBe('raw/completed-stored');
    expect(stored?.ingest_status).toBe('pending');

    const parked = await d1.prepare(`SELECT ingest_status FROM filings WHERE doc_id = ?`)
      .bind('completed-capped').first<{ ingest_status: string }>();
    expect(parked?.ingest_status).toBe('needs_review');
    const review = await d1.prepare(`SELECT reason, resolved FROM review_queue WHERE doc_id = ?`)
      .bind('completed-capped').first<{ reason: string; resolved: number }>();
    expect(review?.reason).toBe('empty_fetch_handoff');
    expect(review?.resolved).toBe(0);
    const seeded = await d1.prepare(`SELECT ingest_status, extractor FROM filings WHERE doc_id = ?`)
      .bind('completed-provider-seeded').first<{ ingest_status: string; extractor: string }>();
    expect(seeded?.ingest_status).toBe('provider_seeded');
    expect(seeded?.extractor).toBe('fmp-senate-latest');
    const nulled = await d1.prepare(`SELECT ingest_status FROM filings WHERE doc_id = ?`)
      .bind('completed-null').first<{ ingest_status: string }>();
    expect(nulled?.ingest_status).toBe('new');
    const parkedOutbox = await d1.prepare(`SELECT status, last_error FROM ingestion_outbox WHERE doc_id = ?`)
      .bind('completed-capped').first<{ status: string; last_error: string }>();
    expect(parkedOutbox?.status).toBe('failed');
    expect(parkedOutbox?.last_error).toBe('parked:empty_fetch_handoff');

    const sentIds = sent.map((entry) => (entry.message as { docId: string }).docId).sort();
    expect(sentIds).toEqual(['completed-new', 'completed-null', 'completed-pending']);
  });

  it('parks an ungrounded filing once the five-cycle budget is spent and keeps the reason current', async () => {
    await insertFiling({ doc_id: 'ungrounded-capped', ingest_status: 'pending', first_seen_at: olderThanWindow, raw_object_key: '' });
    await insertOutbox('ungrounded-capped', 'failed', 5);
    await d1.prepare(
      `INSERT INTO review_queue (doc_id, reason, payload, resolved, created_at) VALUES ('ungrounded-capped', 'unpublished:stale', '{}', 0, ?)`,
    ).bind(olderThanWindow).run();
    await insertFiling({ doc_id: 'ungrounded-cycle', ingest_status: 'pending', first_seen_at: olderThanWindow, raw_object_key: null });
    await insertOutbox('ungrounded-cycle', 'pending', 4);

    const result = await sweepUngroundedIngestStatus(env(), now);
    expect(result.docIds.sort()).toEqual(['ungrounded-capped', 'ungrounded-cycle']);
    expect(result.rearmed).toBe(1);
    expect(result.parked).toBe(1);

    const parked = await d1.prepare(`SELECT ingest_status FROM filings WHERE doc_id = ?`)
      .bind('ungrounded-capped').first<{ ingest_status: string }>();
    expect(parked?.ingest_status).toBe('needs_review');
    const review = await d1.prepare(`SELECT reason, resolved FROM review_queue WHERE doc_id = ?`)
      .bind('ungrounded-capped').first<{ reason: string; resolved: number }>();
    expect(review?.reason).toBe('empty_fetch_handoff');
    expect(review?.resolved).toBe(0);
    const cycles = await d1.prepare(`SELECT dead_letter_cycles, status FROM ingestion_outbox WHERE doc_id = ?`)
      .bind('ungrounded-cycle').first<{ dead_letter_cycles: number; status: string }>();
    expect(cycles?.dead_letter_cycles).toBe(5);
    expect(cycles?.status).toBe('enqueued');
  });

  it('loud alert sees an invalid status and a completed empty handoff, and ignores allowed rows', async () => {
    await insertFiling({ doc_id: 'alert-pending', ingest_status: 'pending', first_seen_at: olderThanWindow, raw_object_key: '' });
    await insertFiling({ doc_id: 'alert-fetched', ingest_status: 'fetched', first_seen_at: olderThanWindow, raw_object_key: 'raw/alert-fetched' });
    await insertFiling({ doc_id: 'alert-new-waiting', ingest_status: 'new', first_seen_at: olderThanWindow, raw_object_key: null });
    await insertOutbox('alert-new-waiting', 'pending', 0);
    await insertFiling({ doc_id: 'alert-error', ingest_status: 'error', first_seen_at: olderThanWindow, raw_object_key: null });
    await insertOutbox('alert-error', 'completed', 0);
    await insertFiling({ doc_id: 'alert-live', ingest_status: 'pending', first_seen_at: olderThanWindow, raw_object_key: null });
    await insertLiveTx('alert-live');
    await insertFiling({ doc_id: 'alert-completed-new', ingest_status: 'new', first_seen_at: '2026-08-01T00:00:00.000Z', raw_object_key: '' });
    await insertOutbox('alert-completed-new', 'completed', 0);
    await insertFiling({ doc_id: 'alert-null', ingest_status: null, first_seen_at: olderThanWindow, raw_object_key: null });
    await insertFiling({ doc_id: 'alert-seeded', ingest_status: 'provider_seeded', first_seen_at: olderThanWindow, raw_object_key: null });
    await insertFiling({ doc_id: 'alert-not-found', ingest_status: 'not_found', first_seen_at: olderThanWindow, raw_object_key: null });
    await insertFiling({ doc_id: 'alert-failed', ingest_status: 'failed', first_seen_at: olderThanWindow, raw_object_key: null });
    await insertFiling({ doc_id: 'alert-young', ingest_status: 'pending', first_seen_at: insideWindow, raw_object_key: null });
    await insertFiling({ doc_id: 'alert-unseeded', ingest_status: 'pending', first_seen_at: null, raw_object_key: null });

    const stalled = await evaluateEmptyFetchHandoff(env(), now);
    expect(stalled.stalled).toBe(true);
    expect(stalled.wakeDocId).toBe('alert-completed-new');
    expect(stalled.detail).toContain('3 filing');

    await d1.prepare(`DELETE FROM filings`).run();
    await d1.prepare(`DELETE FROM ingestion_outbox`).run();
    await d1.prepare(`DELETE FROM transactions`).run();
    await insertFiling({ doc_id: 'only-valid', ingest_status: 'classified', first_seen_at: olderThanWindow, raw_object_key: '' });
    const clear = await evaluateEmptyFetchHandoff(env(), now);
    expect(clear.stalled).toBe(false);
  });

  it('rejects an alias that is not on the allow-list', () => {
    expect(() => emptyFetchAlertWhere('f; DROP TABLE filings', 'o')).toThrow(/filing alias/);
    expect(() => emptyFetchAlertWhere('f', 'o; SELECT')).toThrow(/outbox alias/);
    const sql = emptyFetchAlertWhere('filing', 'outbox');
    expect(sql).toContain('filing.ingest_status IS NULL');
    expect(sql).toContain('filing.first_seen_at IS NOT NULL');
    expect(sql).toContain('outbox.status = \'completed\'');
    expect(sql).not.toContain('DROP');
  });

  it('health check uses the same rule: pending is critical, a stored raw object is ok', async () => {
    expect(emptyFetchHandoffHealthCheck(null)).toMatchObject({
      id: 'empty_fetch_handoff',
      status: 'ok',
      value: null,
      detail: expect.stringContaining('uncollected'),
    });
    expect(emptyFetchHandoffHealthCheck(0)).toMatchObject({ id: 'empty_fetch_handoff', status: 'ok', value: 0 });
    expect(emptyFetchHandoffHealthCheck(2).status).toBe('critical');

    await insertFiling({
      doc_id: 'health-pending',
      ingest_status: 'pending',
      first_seen_at: olderThanWindow,
      raw_object_key: '',
    });
    await insertFiling({
      doc_id: 'health-seeded',
      ingest_status: 'provider_seeded',
      first_seen_at: olderThanWindow,
      raw_object_key: null,
    });
    await insertFiling({
      doc_id: 'health-young',
      ingest_status: 'pending',
      first_seen_at: insideWindow,
      raw_object_key: null,
    });
    await insertFiling({
      doc_id: 'health-unseeded',
      ingest_status: 'pending',
      first_seen_at: null,
      raw_object_key: null,
    });
    const flagged = await checkPipelineHealth(env(), now);
    expect(flagged.checks.find((check) => check.id === 'empty_fetch_handoff')).toMatchObject({
      status: 'critical',
      value: 1,
    });

    await d1.prepare(`DELETE FROM filings`).run();
    await insertFiling({
      doc_id: 'health-stored',
      ingest_status: 'fetched',
      first_seen_at: olderThanWindow,
      raw_object_key: 'raw/health-stored',
    });
    const clear = await checkPipelineHealth(env(), now);
    expect(clear.checks.find((check) => check.id === 'empty_fetch_handoff')).toMatchObject({
      status: 'ok',
      value: 0,
    });
  });
});
