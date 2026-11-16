import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'libsql';
import { d1Database } from '../../prices/__tests__/sqliteD1.ts';
import { runMigrations } from '../../admin/migrations.ts';
import type { Env } from '../../shared/types.ts';
import { TERMINAL_REVIEW_REASON_EXCLUDE_SQL } from '../../extraction/reviewQueueHealth.ts';
import {
  PIPELINE_FAILURE_REASON,
  ensureTerminalFailureReviewRow,
  autoResolveFailureGuardSql,
  genuineFailureReasonGuardSql,
  sweepTerminalFailureReviewQueue,
  terminalFailureReason,
  unsettledNormalizeReason,
} from '../terminalFailureReview.ts';

const AT = '2026-11-12T00:00:00.000Z';

describe('terminalFailureReview', () => {
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

  it('maps each terminal source to a stable reason code', () => {
    expect(terminalFailureReason('download', 'fetcher: HTTP 404')).toBe(PIPELINE_FAILURE_REASON.download);
    expect(terminalFailureReason('dead_letter', 'fetcher: source https://example.test/a.pdf -> HTTP 500'))
      .toBe(PIPELINE_FAILURE_REASON.download);
    expect(terminalFailureReason('extract', 'orchestrator: housePdf failed')).toBe(PIPELINE_FAILURE_REASON.extract);
    expect(terminalFailureReason('dlq', 'filing.extracted tesseract produced no text'))
      .toBe(PIPELINE_FAILURE_REASON.ocr);
    expect(terminalFailureReason('dlq', 'ingest/filing.new network down')).toBe(PIPELINE_FAILURE_REASON.download);
    expect(terminalFailureReason('normalize', 'needs_review with no queue row'))
      .toBe(PIPELINE_FAILURE_REASON.normalize);
    expect(terminalFailureReason('publish', 'normalize: publish did not commit'))
      .toBe(PIPELINE_FAILURE_REASON.publish);
    expect(unsettledNormalizeReason({ needsReview: false })).toBe(PIPELINE_FAILURE_REASON.publish);
    expect(unsettledNormalizeReason({
      needsReview: true,
      reviewReason: 'ocr_unusable,extract_empty_failure',
    })).toBe(PIPELINE_FAILURE_REASON.ocr);
    expect(genuineFailureReasonGuardSql('reason')).toContain("NOT LIKE 'pipeline_failure:%'");
    expect(genuineFailureReasonGuardSql('reason')).not.toContain('extract_empty_failure');
    expect(autoResolveFailureGuardSql('reason')).toContain("NOT LIKE '%extract_empty_failure%'");
    expect(autoResolveFailureGuardSql('reason')).toContain("NOT LIKE '%no_transactions_extracted%'");
    expect(TERMINAL_REVIEW_REASON_EXCLUDE_SQL).toContain("NOT LIKE 'ingest_failure:%'");
    expect(TERMINAL_REVIEW_REASON_EXCLUDE_SQL).toContain("NOT LIKE '%empty_fetch_handoff%'");
    expect(TERMINAL_REVIEW_REASON_EXCLUDE_SQL).not.toContain('extract_empty_failure');
  });

  it('enqueues terminal failures that have no review row and is idempotent', async () => {
    const env = makeEnv();
    await d1.prepare(
      `INSERT INTO filings (doc_id, chamber, ingest_status, first_seen_at)
       VALUES
         ('H-DL-1', 'house', 'new', ?),
         ('S-OCR-1', 'senate', 'classified', ?),
         ('H-NR-1', 'house', 'needs_review', ?)`,
    ).bind(AT, AT, AT).run();
    await d1.prepare(
      `INSERT INTO ingestion_outbox
         (doc_id, chamber, source_url, status, attempts, dead_letter_cycles, available_at, last_error, created_at, updated_at)
       VALUES ('H-DL-1', 'house', 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/H-DL-1.pdf',
               'failed', 6, 5, ?, 'fetcher: source https://example.test/H-DL-1.pdf -> HTTP 500', ?, ?)`,
    ).bind(AT, AT, AT).run();
    await d1.prepare(
      `INSERT INTO deno_runtime_queue
         (queue_name, dedupe_key, payload, status, attempts, available_at, last_error, created_at, updated_at)
       VALUES ('ingest', 'ingest:filing.extracted:S-OCR-1', ?, 'failed', 8, ?, ?, ?, ?)`,
    ).bind(
      JSON.stringify({ type: 'filing.extracted', docId: 'S-OCR-1' }),
      AT,
      'orchestrator: vision failed: tesseract ocr empty',
      AT,
      AT,
    ).run();

    const first = await sweepTerminalFailureReviewQueue(env, { limit: 50 });
    expect(first.enqueued).toBe(3);
    expect(first.byReason[PIPELINE_FAILURE_REASON.download]).toBe(1);
    expect(first.byReason[PIPELINE_FAILURE_REASON.ocr]).toBe(1);
    expect(first.byReason[PIPELINE_FAILURE_REASON.normalize]).toBe(1);

    const rows = await d1.prepare(
      `SELECT doc_id, reason, resolved FROM review_queue ORDER BY doc_id`,
    ).all<{ doc_id: string; reason: string; resolved: number }>();
    expect(rows.results).toEqual([
      { doc_id: 'H-DL-1', reason: PIPELINE_FAILURE_REASON.download, resolved: 0 },
      { doc_id: 'H-NR-1', reason: PIPELINE_FAILURE_REASON.normalize, resolved: 0 },
      { doc_id: 'S-OCR-1', reason: PIPELINE_FAILURE_REASON.ocr, resolved: 0 },
    ]);

    const stamped = await d1.prepare(
      `SELECT doc_id, ingest_status FROM filings WHERE doc_id IN ('H-DL-1', 'S-OCR-1', 'H-NR-1') ORDER BY doc_id`,
    ).all<{ doc_id: string; ingest_status: string }>();
    expect(stamped.results?.every((row) => row.ingest_status === 'error')).toBe(true);

    const second = await sweepTerminalFailureReviewQueue(env, { limit: 50 });
    expect(second.matched).toBe(0);
    expect(second.enqueued).toBe(0);
    const count = await d1.prepare('SELECT COUNT(*) AS n FROM review_queue').first<{ n: number }>();
    expect(count?.n).toBe(3);
    const stillOpen = await d1.prepare(
      `SELECT COUNT(*) AS n FROM review_queue WHERE resolved = 0`,
    ).first<{ n: number }>();
    expect(stillOpen?.n).toBe(3);
  });

  it('does not reopen a resolved row or queue a filing that already has live trades', async () => {
    const env = makeEnv();
    await d1.prepare(
      `INSERT INTO filings (doc_id, chamber, ingest_status, first_seen_at)
       VALUES
         ('S-CLOSED', 'senate', 'error', ?),
         ('H-LIVE', 'house', 'new', ?),
         ('H-EMPTY', 'house', 'verified_empty', ?),
         ('provider-missing-fmp-1', 'house', 'new', ?)`,
    ).bind(AT, AT, AT, AT).run();
    await d1.prepare(
      `INSERT INTO review_queue
         (doc_id, reason, created_at, resolved, resolution_kind, resolution_reason, review_revision)
       VALUES ('S-CLOSED', 'extract_empty_failure,no_transactions_extracted', ?, 1, 'verified_empty', 'human empty', 2)`,
    ).bind(AT).run();
    await d1.prepare(
      `INSERT INTO ingestion_outbox
         (doc_id, chamber, source_url, status, attempts, dead_letter_cycles, available_at, last_error, created_at, updated_at)
       VALUES
         ('S-CLOSED', 'senate', 'https://efdsearch.senate.gov/search/view/ptr/x/', 'failed', 6, 5, ?, 'fetcher: HTTP 403', ?, ?),
         ('H-LIVE', 'house', 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/H-LIVE.pdf', 'failed', 6, 5, ?, 'fetcher: HTTP 500', ?, ?),
         ('H-EMPTY', 'house', 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/H-EMPTY.pdf', 'failed', 6, 5, ?, 'fetcher: HTTP 500', ?, ?),
         ('provider-missing-fmp-1', 'house', 'https://example.test/missing', 'failed', 6, 5, ?, 'fetcher: HTTP 500', ?, ?)`,
    ).bind(AT, AT, AT, AT, AT, AT, AT, AT, AT, AT, AT, AT).run();
    await d1.prepare(
      `INSERT INTO transactions (id, doc_id, deprecated_at) VALUES ('t-live', 'H-LIVE', NULL)`,
    ).run();

    const sweep = await sweepTerminalFailureReviewQueue(env, { limit: 20 });
    expect(sweep.enqueued).toBe(0);
    expect(sweep.matched).toBe(0);

    const closed = await d1.prepare(
      `SELECT resolved, reason FROM review_queue WHERE doc_id = 'S-CLOSED'`,
    ).first<{ resolved: number; reason: string }>();
    expect(closed?.resolved).toBe(1);
    expect(closed?.reason).toBe('extract_empty_failure,no_transactions_extracted');
    const live = await d1.prepare(
      `SELECT ingest_status FROM filings WHERE doc_id = 'H-LIVE'`,
    ).first<{ ingest_status: string }>();
    expect(live?.ingest_status).toBe('new');

    const direct = await ensureTerminalFailureReviewRow(
      env,
      'S-CLOSED',
      PIPELINE_FAILURE_REASON.extract,
      'must not reopen',
      { source: 'extract' },
    );
    expect(direct).toBe('visible');
    const still = await d1.prepare(
      `SELECT resolved FROM review_queue WHERE doc_id = 'S-CLOSED'`,
    ).first<{ resolved: number }>();
    expect(still?.resolved).toBe(1);
  });

  it('opens one unresolved row for a publish that did not commit', async () => {
    const env = makeEnv();
    await d1.prepare(
      `INSERT INTO filings (doc_id, chamber, ingest_status, first_seen_at)
       VALUES ('H-PUB-1', 'house', 'classified', ?)`,
    ).bind(AT).run();

    const first = await ensureTerminalFailureReviewRow(
      env,
      'H-PUB-1',
      unsettledNormalizeReason({ needsReview: false }),
      'normalize: publish did not commit',
      { source: 'publish' },
    );
    const second = await ensureTerminalFailureReviewRow(
      env,
      'H-PUB-1',
      PIPELINE_FAILURE_REASON.publish,
      'normalize: publish did not commit',
      { source: 'publish' },
    );
    expect(first).toBe('inserted');
    expect(second).toBe('visible');
    const row = await d1.prepare(
      `SELECT reason, resolved FROM review_queue WHERE doc_id = 'H-PUB-1'`,
    ).first<{ reason: string; resolved: number }>();
    expect(row?.reason).toBe(PIPELINE_FAILURE_REASON.publish);
    expect(row?.resolved).toBe(0);
    const filing = await d1.prepare(
      `SELECT ingest_status FROM filings WHERE doc_id = 'H-PUB-1'`,
    ).first<{ ingest_status: string }>();
    expect(filing?.ingest_status).toBe('error');
  });

  it('leaves a transient outbox failure for replay until its cycle cap', async () => {
    const env = makeEnv();
    const mid = '2026-11-12T01:00:00.000Z';
    const later = '2026-11-12T02:00:00.000Z';
    await d1.prepare(
      `INSERT INTO filings (doc_id, chamber, ingest_status, first_seen_at)
       VALUES
         ('H-RETRY-1', 'house', 'new', ?),
         ('H-RETRY-2', 'house', 'new', ?),
         ('H-RETRY-4', 'house', 'new', ?),
         ('H-RETRY-3', 'house', 'new', ?),
         ('H-POISON-1', 'house', 'new', ?)`,
    ).bind(AT, AT, AT, AT, AT).run();
    await d1.prepare(
      `INSERT INTO ingestion_outbox
         (doc_id, chamber, source_url, status, attempts, dead_letter_cycles, available_at, last_error, created_at, updated_at)
       VALUES
         ('H-RETRY-1', 'house', 'https://example.test/H-RETRY-1.pdf', 'failed', 6, 0, ?, 'fetcher: HTTP 429 too many requests', ?, ?),
         ('H-RETRY-2', 'house', 'https://example.test/H-RETRY-2.pdf', 'failed', 6, 4, ?, 'SQLITE_BUSY: database is locked', ?, ?),
         ('H-RETRY-4', 'house', 'https://example.test/H-RETRY-4.pdf', 'failed', 6, 1, ?, 'fetcher: timeout', ?, ?),
         ('H-RETRY-3', 'house', 'https://example.test/H-RETRY-3.pdf', 'failed', 6, 5, ?, 'fetcher: HTTP 429 too many requests', ?, ?),
         ('H-POISON-1', 'house', 'https://example.test/H-POISON-1.pdf', 'failed', 6, 0, ?, 'invalid payload', ?, ?)`,
    ).bind(
      AT, AT, AT,
      AT, AT, AT,
      AT, AT, AT,
      mid, mid, mid,
      later, later, later,
    ).run();

    const sweep = await sweepTerminalFailureReviewQueue(env, { limit: 2 });
    expect(sweep.enqueued).toBe(2);
    expect(sweep.byReason[PIPELINE_FAILURE_REASON.download]).toBe(1);
    expect(sweep.byReason[PIPELINE_FAILURE_REASON.deadLetter]).toBe(1);

    const queued = await d1.prepare(
      `SELECT doc_id, reason FROM review_queue ORDER BY doc_id`,
    ).all<{ doc_id: string; reason: string }>();
    expect(queued.results).toEqual([
      { doc_id: 'H-POISON-1', reason: PIPELINE_FAILURE_REASON.deadLetter },
      { doc_id: 'H-RETRY-3', reason: PIPELINE_FAILURE_REASON.download },
    ]);
    const waiting = await d1.prepare(
      `SELECT ingest_status FROM filings WHERE doc_id IN ('H-RETRY-1', 'H-RETRY-2', 'H-RETRY-4') ORDER BY doc_id`,
    ).all<{ ingest_status: string }>();
    expect(waiting.results?.every((row) => row.ingest_status === 'new')).toBe(true);
  });
});
