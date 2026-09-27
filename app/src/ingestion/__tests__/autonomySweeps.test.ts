import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'libsql';
import { d1Database } from '../../prices/__tests__/sqliteD1.ts';
import { runMigrations } from '../../admin/migrations.ts';
import type { Env } from '../../shared/types.ts';

const fetchHouseIndex = vi.fn();
vi.mock('../houseSource.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../houseSource.ts')>();
  return {
    ...actual,
    fetchHouseIndex: (...args: unknown[]) => fetchHouseIndex(...args),
  };
});

// Mirrors extraction/__tests__/textPdf.test.ts's precedent: mock unpdf rather
// than hand-encoding a real PDF fixture, since only the text->date regex
// logic (extractPrintedDateFromText, tested directly below) is this module's
// own responsibility.
const unpdfMocks = vi.hoisted(() => ({
  getDocumentProxy: vi.fn(),
  extractText: vi.fn(),
}));
vi.mock('unpdf', () => ({
  getDocumentProxy: unpdfMocks.getDocumentProxy,
  extractText: unpdfMocks.extractText,
}));

import {
  sweepExtractionPendingLocalCeiling,
  sweepStrandedFilings,
  sweepProviderOnlyReviewStubs,
  sweepAlreadyPublishedReviewRows,
  listAlreadyPublishedReviewCandidates,
  sweepFiledDateBackfill,
  sweepOgeUndatedFilingDates,
  extractPrintedDateFromText,
  runAutonomySweeps,
  sweepLivenessAlarms,
  sweepLocalVisionHostedFallback,
} from '../autonomySweeps.ts';

describe('autonomySweeps', () => {
  let fileDb: Database.Database;
  let d1: ReturnType<typeof d1Database>;
  let sentMessages: Array<{ message: unknown; options?: unknown }>;

  function makeEnv(): Env {
    return {
      DB: d1,
      RAW_FILES: { get: async () => null } as unknown,
      INGEST_QUEUE: { send: async (message: unknown, options?: unknown) => { sentMessages.push({ message, options }); } } as unknown,
    } as unknown as Env;
  }

  async function insertFiling(row: {
    doc_id: string;
    chamber?: string;
    ingest_status: string;
    doc_kind?: string;
    first_seen_at: string;
    local_wait_expires_at?: string | null;
    filed_date?: string | null;
    raw_object_key?: string | null;
  }) {
    await d1.prepare(
      `INSERT INTO filings (doc_id, chamber, ingest_status, doc_kind, first_seen_at, local_wait_expires_at, filed_date, raw_object_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      row.doc_id,
      row.chamber ?? 'house',
      row.ingest_status,
      row.doc_kind ?? 'unknown',
      row.first_seen_at,
      row.local_wait_expires_at ?? null,
      row.filed_date ?? null,
      row.raw_object_key ?? null,
    ).run();
  }

  async function markResolved(docId: string) {
    await d1.prepare(
      `INSERT INTO review_queue (doc_id, reason, resolved, created_at) VALUES (?, ?, 1, ?)`
    ).bind(docId, 'test-resolved', new Date().toISOString()).run();
  }

  beforeEach(async () => {
    fileDb = new Database(':memory:');
    d1 = d1Database(fileDb);
    sentMessages = [];
    fetchHouseIndex.mockReset();
    unpdfMocks.getDocumentProxy.mockReset();
    unpdfMocks.extractText.mockReset();
    await runMigrations(d1);
  });

  afterEach(() => {
    try { fileDb.close(); } catch {}
  });

  describe('sweepExtractionPendingLocalCeiling', () => {
    it('flips a filing past the 24h ceiling to classified and enqueues filing.extracted', async () => {
      const env = makeEnv();
      const now = new Date('2026-08-09T12:00:00Z');
      const wayPastExpiry = new Date(now.getTime() - 25 * 3600_000).toISOString(); // expired 25h ago
      await insertFiling({
        doc_id: 'doc-ceiling-1',
        ingest_status: 'extraction_pending_local',
        doc_kind: 'scanned_pdf',
        first_seen_at: wayPastExpiry,
        local_wait_expires_at: wayPastExpiry,
      });

      const result = await sweepExtractionPendingLocalCeiling(env, now);
      expect(result.flipped).toBe(1);

      const row = await d1.prepare(`SELECT ingest_status FROM filings WHERE doc_id = ?`)
        .bind('doc-ceiling-1').first<{ ingest_status: string }>();
      expect(row?.ingest_status).toBe('classified');
      expect(sentMessages).toEqual([{ message: { type: 'filing.extracted', docId: 'doc-ceiling-1' }, options: undefined }]);
    });

    it('does not touch a filing within the ceiling window', async () => {
      const env = makeEnv();
      const now = new Date('2026-08-09T12:00:00Z');
      const recentExpiry = new Date(now.getTime() - 60 * 60_000).toISOString(); // expired 1h ago
      await insertFiling({
        doc_id: 'doc-ceiling-2',
        ingest_status: 'extraction_pending_local',
        doc_kind: 'scanned_pdf',
        first_seen_at: recentExpiry,
        local_wait_expires_at: recentExpiry,
      });

      const result = await sweepExtractionPendingLocalCeiling(env, now);
      expect(result.flipped).toBe(0);
      const row = await d1.prepare(`SELECT ingest_status FROM filings WHERE doc_id = ?`)
        .bind('doc-ceiling-2').first<{ ingest_status: string }>();
      expect(row?.ingest_status).toBe('extraction_pending_local');
      expect(sentMessages).toEqual([]);
    });

    it('never revives an already review-resolved filing', async () => {
      const env = makeEnv();
      const now = new Date('2026-08-09T12:00:00Z');
      const wayPastExpiry = new Date(now.getTime() - 48 * 3600_000).toISOString();
      await insertFiling({
        doc_id: 'doc-ceiling-resolved',
        ingest_status: 'extraction_pending_local',
        doc_kind: 'scanned_pdf',
        first_seen_at: wayPastExpiry,
        local_wait_expires_at: wayPastExpiry,
      });
      await markResolved('doc-ceiling-resolved');

      const result = await sweepExtractionPendingLocalCeiling(env, now);
      expect(result.flipped).toBe(0);
      expect(sentMessages).toEqual([]);
    });
  });

  describe('sweepStrandedFilings', () => {
    it('terminalizes a filing stuck non-terminal past the 10-day ceiling', async () => {
      const env = makeEnv();
      const now = new Date('2026-08-09T12:00:00Z');
      const ancient = new Date(now.getTime() - 11 * 86_400_000).toISOString();
      await insertFiling({ doc_id: 'doc-stranded-1', ingest_status: 'new', first_seen_at: ancient });

      const result = await sweepStrandedFilings(env, now);
      expect(result.terminalized).toBe(1);
      const row = await d1.prepare(`SELECT ingest_status, error FROM filings WHERE doc_id = ?`)
        .bind('doc-stranded-1').first<{ ingest_status: string; error: string }>();
      expect(row?.ingest_status).toBe('error');
      expect(row?.error).toMatch(/autonomy-sweep/);
    });

    it('leaves a recently-stuck filing alone', async () => {
      const env = makeEnv();
      const now = new Date('2026-08-09T12:00:00Z');
      const recent = new Date(now.getTime() - 2 * 86_400_000).toISOString();
      await insertFiling({ doc_id: 'doc-stranded-recent', ingest_status: 'fetched', first_seen_at: recent });

      const result = await sweepStrandedFilings(env, now);
      expect(result.terminalized).toBe(0);
    });

    it('excludes provider-missing placeholder rows', async () => {
      const env = makeEnv();
      const now = new Date('2026-08-09T12:00:00Z');
      const ancient = new Date(now.getTime() - 30 * 86_400_000).toISOString();
      await insertFiling({ doc_id: 'provider-missing-uw-senate-abc', ingest_status: 'new', first_seen_at: ancient });

      const result = await sweepStrandedFilings(env, now);
      expect(result.terminalized).toBe(0);
      const row = await d1.prepare(`SELECT ingest_status FROM filings WHERE doc_id = ?`)
        .bind('provider-missing-uw-senate-abc').first<{ ingest_status: string }>();
      expect(row?.ingest_status).toBe('new');
    });

    it('never revives an already review-resolved filing', async () => {
      const env = makeEnv();
      const now = new Date('2026-08-09T12:00:00Z');
      const ancient = new Date(now.getTime() - 30 * 86_400_000).toISOString();
      await insertFiling({ doc_id: 'doc-stranded-resolved', ingest_status: 'classified', first_seen_at: ancient });
      await markResolved('doc-stranded-resolved');

      const result = await sweepStrandedFilings(env, now);
      expect(result.terminalized).toBe(0);
    });
  });

  describe('sweepProviderOnlyReviewStubs', () => {
    async function insertReviewStub(docId: string, reason = 'provider_discovered_missing_official') {
      await d1.prepare(
        `INSERT INTO review_queue (doc_id, reason, payload, created_at, resolved, review_revision)
         VALUES (?, ?, '{}', ?, 0, 1)`,
      ).bind(docId, reason, new Date().toISOString()).run();
    }

    it('closes an open provider-only placeholder as verified_empty', async () => {
      const env = makeEnv();
      await insertFiling({ doc_id: 'provider-missing-fmp-house-20035492', ingest_status: 'needs_review', first_seen_at: new Date().toISOString() });
      await insertReviewStub('provider-missing-fmp-house-20035492');

      const result = await sweepProviderOnlyReviewStubs(env);
      expect(result.cleared).toBe(1);
      const row = await d1.prepare(
        `SELECT resolved, resolution_kind, resolution_reason FROM review_queue WHERE doc_id = ?`,
      ).bind('provider-missing-fmp-house-20035492').first<{ resolved: number; resolution_kind: string; resolution_reason: string }>();
      expect(row?.resolved).toBe(1);
      expect(row?.resolution_kind).toBe('verified_empty');
      expect(row?.resolution_reason).toBe('provider_only_lead_cleared');
    });

    it('moves the stub filing out of needs_review with its review close', async () => {
      const env = makeEnv();
      const docId = 'provider-missing-fmp-house-20035493';
      await insertFiling({ doc_id: docId, ingest_status: 'needs_review', first_seen_at: new Date().toISOString() });
      await insertReviewStub(docId);

      const result = await sweepProviderOnlyReviewStubs(env);
      expect(result.cleared).toBe(1);
      expect(result.filingsUpdated).toBe(1);
      const filing = await d1.prepare(`SELECT ingest_status FROM filings WHERE doc_id = ?`)
        .bind(docId).first<{ ingest_status: string }>();
      expect(filing?.ingest_status).toBe('verified_empty');
      const review = await d1.prepare(`SELECT review_revision FROM review_queue WHERE doc_id = ?`)
        .bind(docId).first<{ review_revision: number }>();
      expect(review?.review_revision).toBe(2);

      const again = await sweepProviderOnlyReviewStubs(env);
      expect(again).toEqual({ cleared: 0, filingsUpdated: 0 });
    });

    it('heals a stub filing whose review was already cleared without it', async () => {
      const env = makeEnv();
      const docId = 'provider-missing-fmp-house-migrated';
      await insertFiling({ doc_id: docId, ingest_status: 'needs_review', first_seen_at: new Date().toISOString() });
      await d1.prepare(
        `INSERT INTO review_queue (doc_id, reason, payload, created_at, resolved, resolution_kind, resolution_reason, review_revision)
         VALUES (?, 'provider_discovered_missing_official', '{}', ?, 1, 'verified_empty', 'provider_only_lead_cleared', 1)`,
      ).bind(docId, new Date().toISOString()).run();

      const result = await sweepProviderOnlyReviewStubs(env);
      expect(result).toEqual({ cleared: 0, filingsUpdated: 1 });
      const filing = await d1.prepare(`SELECT ingest_status FROM filings WHERE doc_id = ?`)
        .bind(docId).first<{ ingest_status: string }>();
      expect(filing?.ingest_status).toBe('verified_empty');
    });

    it('leaves a provider-reason row with stored raw bytes alone', async () => {
      const env = makeEnv();
      await insertFiling({ doc_id: 'provider-missing-fmp-house-real', ingest_status: 'needs_review', first_seen_at: new Date().toISOString(), raw_object_key: 'raw/real.pdf' });
      await insertReviewStub('provider-missing-fmp-house-real');

      const result = await sweepProviderOnlyReviewStubs(env);
      expect(result.cleared).toBe(0);
      const row = await d1.prepare(`SELECT resolved FROM review_queue WHERE doc_id = ?`).bind('provider-missing-fmp-house-real').first<{ resolved: number }>();
      expect(row?.resolved).toBe(0);
      const filing = await d1.prepare(`SELECT ingest_status FROM filings WHERE doc_id = ?`).bind('provider-missing-fmp-house-real').first<{ ingest_status: string }>();
      expect(filing?.ingest_status).toBe('needs_review');
    });

    it('leaves a provider-reason row with a live transaction alone', async () => {
      const env = makeEnv();
      await insertFiling({ doc_id: 'provider-missing-fmp-house-live', ingest_status: 'needs_review', first_seen_at: new Date().toISOString() });
      await insertReviewStub('provider-missing-fmp-house-live');
      await d1.prepare(`INSERT INTO transactions (id, doc_id, source, created_at) VALUES (?, ?, 'primary', ?)`)
        .bind('tx-live-1', 'provider-missing-fmp-house-live', new Date().toISOString()).run();

      const result = await sweepProviderOnlyReviewStubs(env);
      expect(result.cleared).toBe(0);
    });

    it('leaves other review reasons untouched', async () => {
      const env = makeEnv();
      await insertFiling({ doc_id: 'doc-lowconf', ingest_status: 'needs_review', first_seen_at: new Date().toISOString() });
      await insertReviewStub('doc-lowconf', 'low_confidence');

      const result = await sweepProviderOnlyReviewStubs(env);
      expect(result.cleared).toBe(0);
      const row = await d1.prepare(`SELECT resolved FROM review_queue WHERE doc_id = ?`).bind('doc-lowconf').first<{ resolved: number }>();
      expect(row?.resolved).toBe(0);
    });
  });

  describe('sweepAlreadyPublishedReviewRows', () => {
    const ORPHAN_REASON = 'form_chrome_only,ocr_unusable,extract_empty_failure,no_transactions_extracted';

    async function insertOpenReview(docId: string, reason = ORPHAN_REASON) {
      await d1.prepare(
        `INSERT INTO review_queue (doc_id, reason, payload, created_at, resolved, review_revision)
         VALUES (?, ?, '{}', ?, 0, 4)`,
      ).bind(docId, reason, new Date().toISOString()).run();
    }

    async function insertLiveTx(docId: string, source = 'primary') {
      await d1.prepare(
        `INSERT INTO transactions (id, doc_id, source, created_at) VALUES (?, ?, ?, ?)`,
      ).bind(`tx-${docId}`, docId, source, new Date().toISOString()).run();
    }

    async function insertPublishDecision(docId: string, action = 'auto_published') {
      await d1.prepare(
        `INSERT INTO ingestion_decisions (id, doc_id, action, source, actor, reason, payload, transaction_ids, created_at)
         VALUES (?, ?, ?, 'pipeline', NULL, 'passed_normalization', '{}', '[]', ?)`,
      ).bind(`decision:${action}:${docId}`, docId, action, new Date().toISOString()).run();
    }

    it('closes an orphaned published review row and stamps its filing', async () => {
      const env = makeEnv();
      const docId = 'H-2026-9116292';
      await insertFiling({ doc_id: docId, ingest_status: 'extraction_pending_local', doc_kind: 'scanned_pdf', first_seen_at: new Date().toISOString() });
      await insertOpenReview(docId);
      await insertLiveTx(docId);
      await insertPublishDecision(docId);

      const result = await sweepAlreadyPublishedReviewRows(env);
      expect(result.cleared).toBe(1);
      expect(result.filingsUpdated).toBe(1);
      const row = await d1.prepare(
        `SELECT resolved, resolution_kind, resolution_reason, review_revision FROM review_queue WHERE doc_id = ?`,
      ).bind(docId).first<{ resolved: number; resolution_kind: string; resolution_reason: string; review_revision: number }>();
      expect(row?.resolved).toBe(1);
      expect(row?.resolution_kind).toBe('published');
      expect(row?.resolution_reason).toBe('reconciled_published');
      expect(row?.review_revision).toBe(5);
      const filing = await d1.prepare(`SELECT ingest_status FROM filings WHERE doc_id = ?`)
        .bind(docId).first<{ ingest_status: string }>();
      expect(filing?.ingest_status).toBe('persisted');

      const again = await sweepAlreadyPublishedReviewRows(env);
      expect(again).toEqual({ cleared: 0, filingsUpdated: 0 });
    });

    it('leaves a row with no live transaction alone', async () => {
      const env = makeEnv();
      const docId = 'H-2025-no-live-tx';
      await insertFiling({ doc_id: docId, ingest_status: 'needs_review', doc_kind: 'scanned_pdf', first_seen_at: new Date().toISOString() });
      await insertOpenReview(docId);
      await insertPublishDecision(docId);

      const result = await sweepAlreadyPublishedReviewRows(env);
      expect(result.cleared).toBe(0);
      const row = await d1.prepare(`SELECT resolved FROM review_queue WHERE doc_id = ?`).bind(docId).first<{ resolved: number }>();
      expect(row?.resolved).toBe(0);
    });

    it('leaves a row with live tx but no publish decision alone', async () => {
      const env = makeEnv();
      const docId = 'H-2025-no-decision';
      await insertFiling({ doc_id: docId, ingest_status: 'needs_review', doc_kind: 'scanned_pdf', first_seen_at: new Date().toISOString() });
      await insertOpenReview(docId);
      await insertLiveTx(docId);

      const result = await sweepAlreadyPublishedReviewRows(env);
      expect(result.cleared).toBe(0);
      const row = await d1.prepare(`SELECT resolved FROM review_queue WHERE doc_id = ?`).bind(docId).first<{ resolved: number }>();
      expect(row?.resolved).toBe(0);
    });

    it('leaves an explicit unpublished reopen alone even with live tx', async () => {
      const env = makeEnv();
      const docId = 'H-2025-reopened';
      await insertFiling({ doc_id: docId, ingest_status: 'needs_review', doc_kind: 'scanned_pdf', first_seen_at: new Date().toISOString() });
      await insertOpenReview(docId, 'unpublished: reopen: OCR harden');
      await insertLiveTx(docId);
      await insertPublishDecision(docId);

      const result = await sweepAlreadyPublishedReviewRows(env);
      expect(result.cleared).toBe(0);
    });


    it('keeps non-cascade audit reasons when includeAgreementCascade is mixed', async () => {
      const env = makeEnv();
      const cascadeId = 'H-2025-mixed-cascade';
      const regularId = 'H-2025-mixed-regular';
      await insertFiling({ doc_id: cascadeId, ingest_status: 'error', doc_kind: 'scanned_pdf', first_seen_at: new Date().toISOString() });
      await insertFiling({ doc_id: regularId, ingest_status: 'extraction_pending_local', doc_kind: 'scanned_pdf', first_seen_at: new Date().toISOString() });
      await insertOpenReview(cascadeId, 'agreement_cascade_unresolved');
      await insertOpenReview(regularId);
      await insertLiveTx(cascadeId, 'local_mac');
      await insertLiveTx(regularId);
      await insertPublishDecision(cascadeId);
      await insertPublishDecision(regularId);

      const result = await sweepAlreadyPublishedReviewRows(env, { includeAgreementCascade: true });
      expect(result.cleared).toBe(2);
      expect(result.filingsUpdated).toBe(2);

      const cascade = await d1.prepare(
        `SELECT resolved, resolution_reason FROM review_queue WHERE doc_id = ?`,
      ).bind(cascadeId).first<{ resolved: number; resolution_reason: string }>();
      const regular = await d1.prepare(
        `SELECT resolved, resolution_reason FROM review_queue WHERE doc_id = ?`,
      ).bind(regularId).first<{ resolved: number; resolution_reason: string }>();
      expect(cascade?.resolved).toBe(1);
      expect(cascade?.resolution_reason).toBe('reconciled_published_after_local_mac');
      expect(regular?.resolved).toBe(1);
      expect(regular?.resolution_reason).toBe('reconciled_published');

      const cascadeFiling = await d1.prepare(`SELECT ingest_status FROM filings WHERE doc_id = ?`)
        .bind(cascadeId).first<{ ingest_status: string }>();
      const regularFiling = await d1.prepare(`SELECT ingest_status FROM filings WHERE doc_id = ?`)
        .bind(regularId).first<{ ingest_status: string }>();
      expect(cascadeFiling?.ingest_status).toBe('persisted');
      expect(regularFiling?.ingest_status).toBe('persisted');
    });

    it('closes agreement-cascade when includeAgreementCascade is set', async () => {
      const env = makeEnv();
      const docId = 'H-2025-8220844-close';
      await insertFiling({ doc_id: docId, ingest_status: 'error', doc_kind: 'scanned_pdf', first_seen_at: new Date().toISOString() });
      await insertOpenReview(docId, 'agreement_cascade_unresolved');
      await insertLiveTx(docId, 'local_mac');
      await insertPublishDecision(docId);

      const preview = await listAlreadyPublishedReviewCandidates(env, { includeAgreementCascade: true });
      expect(preview.some((c) => c.docId === docId)).toBe(true);

      const result = await sweepAlreadyPublishedReviewRows(env, { includeAgreementCascade: true });
      expect(result.cleared).toBe(1);
      expect(result.filingsUpdated).toBe(1);
      const row = await d1.prepare(
        `SELECT resolved, resolution_reason FROM review_queue WHERE doc_id = ?`,
      ).bind(docId).first<{ resolved: number; resolution_reason: string }>();
      expect(row?.resolved).toBe(1);
      expect(row?.resolution_reason).toBe('reconciled_published_after_local_mac');
      const filing = await d1.prepare(`SELECT ingest_status, error FROM filings WHERE doc_id = ?`)
        .bind(docId).first<{ ingest_status: string; error: string | null }>();
      expect(filing?.ingest_status).toBe('persisted');
      expect(filing?.error).toBeNull();
    });

    it('leaves an agreement-cascade dispute alone even with live tx', async () => {
      const env = makeEnv();
      const docId = 'H-2025-8220844';
      await insertFiling({ doc_id: docId, ingest_status: 'error', doc_kind: 'scanned_pdf', first_seen_at: new Date().toISOString() });
      await insertOpenReview(docId, 'agreement_cascade_unresolved');
      await insertLiveTx(docId);
      await insertPublishDecision(docId);

      const result = await sweepAlreadyPublishedReviewRows(env);
      expect(result.cleared).toBe(0);
    });
  });

  describe('sweepFiledDateBackfill', () => {
    it('backfills filed_date for a stale House filing from the bulk index', async () => {
      const env = makeEnv();
      const now = new Date('2026-08-09T12:00:00Z');
      const stale = new Date(now.getTime() - 100 * 3600_000).toISOString(); // >72h
      await insertFiling({ doc_id: 'H-2026-20012345', chamber: 'house', ingest_status: 'classified', first_seen_at: stale, filed_date: null });
      fetchHouseIndex.mockResolvedValueOnce([
        { docId: '20012345', filingType: 'P', year: '2026', first: 'Jane', last: 'Smith', stateDst: 'CA01', filingDate: '7/1/2026', isPtr: true, pipelineDocId: 'H-2026-20012345', sourceUrl: 'https://x' },
      ]);

      const result = await sweepFiledDateBackfill(env, now);
      expect(result.updated).toBe(1);
      expect(result.yearsFetched).toEqual(['2026']);
      expect(fetchHouseIndex).toHaveBeenCalledTimes(1);
      expect(fetchHouseIndex.mock.calls[0][0]).toBe('2026');

      const row = await d1.prepare(`SELECT filed_date FROM filings WHERE doc_id = ?`)
        .bind('H-2026-20012345').first<{ filed_date: string }>();
      expect(row?.filed_date).toBe('7/1/2026');
    });

    it('never overwrites an already-set filed_date', async () => {
      const env = makeEnv();
      const now = new Date('2026-08-09T12:00:00Z');
      const stale = new Date(now.getTime() - 100 * 3600_000).toISOString();
      // filed_date is NOT NULL, so this row is not even selected as "stuck".
      await insertFiling({ doc_id: 'H-2026-20099999', chamber: 'house', ingest_status: 'classified', first_seen_at: stale, filed_date: '2026-06-01' });

      const result = await sweepFiledDateBackfill(env, now);
      expect(result.updated).toBe(0);
      expect(fetchHouseIndex).not.toHaveBeenCalled();
    });

    it('is a no-op within the 72h freshness window', async () => {
      const env = makeEnv();
      const now = new Date('2026-08-09T12:00:00Z');
      const fresh = new Date(now.getTime() - 10 * 3600_000).toISOString();
      await insertFiling({ doc_id: 'H-2026-20055555', chamber: 'house', ingest_status: 'classified', first_seen_at: fresh, filed_date: null });

      const result = await sweepFiledDateBackfill(env, now);
      expect(result.updated).toBe(0);
      expect(fetchHouseIndex).not.toHaveBeenCalled();
    });

    it('does not fetch the ZIP for not_found frontier-probe phantoms', async () => {
      const env = makeEnv();
      const now = new Date('2026-08-17T21:00:00Z');
      const stale = new Date(now.getTime() - 100 * 3600_000).toISOString();
      // Prod 2026-07-30 scout burst: sequential IDs that HEAD-404'd and
      // are absent from every year's Clerk FD ZIP (#1577).
      await insertFiling({
        doc_id: 'H-2026-20035076',
        chamber: 'house',
        ingest_status: 'not_found',
        first_seen_at: stale,
        filed_date: null,
      });

      const result = await sweepFiledDateBackfill(env, now);
      expect(result.updated).toBe(0);
      expect(result.yearsFetched).toEqual([]);
      expect(fetchHouseIndex).not.toHaveBeenCalled();
    });

    it('leaves filed_date NULL when the Clerk index has no matching DocID', async () => {
      const env = makeEnv();
      const now = new Date('2026-08-17T21:00:00Z');
      const stale = new Date(now.getTime() - 100 * 3600_000).toISOString();
      await insertFiling({
        doc_id: 'H-2026-20035076',
        chamber: 'house',
        ingest_status: 'persisted',
        first_seen_at: stale,
        filed_date: null,
      });
      fetchHouseIndex.mockResolvedValueOnce([
        {
          docId: '9116249',
          filingType: 'P',
          year: '2026',
          first: 'Tom',
          last: 'Cole',
          stateDst: 'OK04',
          filingDate: '7/21/2026',
          isPtr: true,
          pipelineDocId: 'H-2026-9116249',
          sourceUrl: 'https://x',
        },
      ]);

      const result = await sweepFiledDateBackfill(env, now);
      expect(result.updated).toBe(0);
      expect(result.yearsFetched).toEqual(['2026']);
      const row = await d1.prepare(`SELECT filed_date FROM filings WHERE doc_id = ?`)
        .bind('H-2026-20035076').first<{ filed_date: string | null }>();
      expect(row?.filed_date ?? null).toBeNull();
    });
  });

  describe('extractPrintedDateFromText (pure)', () => {
    const now = new Date('2026-08-09T12:00:00Z');

    it('prefers a date next to a report/signature-date label', () => {
      const text = 'Some preamble text.\nDate of Report: 3/14/2026\nSignature Date: 3/15/2026\nfooter';
      // Last labeled match wins (signature date is typically the operative one).
      expect(extractPrintedDateFromText(text, now)).toBe('2026-03-15');
    });

    it('falls back to the last plausible bare date when no label is present', () => {
      const text = 'Filed by the officer on 1/2/2026 pursuant to the Act, page stamped 4/5/2026';
      expect(extractPrintedDateFromText(text, now)).toBe('2026-04-05');
    });

    it('returns null when no plausible date exists', () => {
      expect(extractPrintedDateFromText('no dates anywhere in this text', now)).toBeNull();
    });

    it('rejects implausible dates (too old / in the future)', () => {
      expect(extractPrintedDateFromText('signed 1/1/1999', now)).toBeNull();
      expect(extractPrintedDateFromText('signed 1/1/2099', now)).toBeNull();
    });
  });

  describe('sweepOgeUndatedFilingDates', () => {
    it('backfills filed_date from the extracted PDF text for an E-undated- doc', async () => {
      const now = new Date('2026-08-09T12:00:00Z');
      await insertFiling({
        doc_id: 'E-undated-jane-q-official',
        chamber: 'executive',
        ingest_status: 'classified',
        doc_kind: 'text_pdf',
        first_seen_at: now.toISOString(),
        raw_object_key: 'raw/E-undated-jane-q-official',
      });
      const pdfBytes = new Uint8Array([1, 2, 3]);
      const env: Env = {
        DB: d1,
        RAW_FILES: {
          get: async (key: string) =>
            key === 'raw/E-undated-jane-q-official'
              ? { arrayBuffer: async () => pdfBytes.buffer }
              : null,
        } as unknown,
        INGEST_QUEUE: { send: async () => {} } as unknown,
      } as unknown as Env;
      const destroy = vi.fn();
      unpdfMocks.getDocumentProxy.mockResolvedValue({ numPages: 1, destroy });
      unpdfMocks.extractText.mockResolvedValue({ text: 'Report Date: 5/1/2026\nSignature Date: 5/2/2026' });

      const result = await sweepOgeUndatedFilingDates(env);
      expect(result.attempted).toBe(1);
      expect(result.updated).toBe(1);
      expect(destroy).toHaveBeenCalledTimes(1);

      const row = await d1.prepare(`SELECT filed_date FROM filings WHERE doc_id = ?`)
        .bind('E-undated-jane-q-official').first<{ filed_date: string }>();
      expect(row?.filed_date).toBe('2026-05-02');
    });

    it('is a safe no-op when the R2 object is missing (never throws)', async () => {
      const now = new Date('2026-08-09T12:00:00Z');
      await insertFiling({
        doc_id: 'E-undated-missing-object',
        chamber: 'executive',
        ingest_status: 'classified',
        doc_kind: 'text_pdf',
        first_seen_at: now.toISOString(),
        raw_object_key: 'raw/E-undated-missing-object',
      });
      const env: Env = {
        DB: d1,
        RAW_FILES: { get: async () => null } as unknown,
        INGEST_QUEUE: { send: async () => {} } as unknown,
      } as unknown as Env;

      const result = await sweepOgeUndatedFilingDates(env);
      expect(result.attempted).toBe(1);
      expect(result.updated).toBe(0);
    });

    it('leaves filed_date untouched when no plausible date is found in the text', async () => {
      const now = new Date('2026-08-09T12:00:00Z');
      await insertFiling({
        doc_id: 'E-undated-no-date',
        chamber: 'executive',
        ingest_status: 'classified',
        doc_kind: 'text_pdf',
        first_seen_at: now.toISOString(),
        raw_object_key: 'raw/E-undated-no-date',
      });
      const env: Env = {
        DB: d1,
        RAW_FILES: { get: async () => ({ arrayBuffer: async () => new Uint8Array([1]).buffer }) } as unknown,
        INGEST_QUEUE: { send: async () => {} } as unknown,
      } as unknown as Env;
      unpdfMocks.getDocumentProxy.mockResolvedValue({ numPages: 1 });
      unpdfMocks.extractText.mockResolvedValue({ text: 'no usable date anywhere' });

      const result = await sweepOgeUndatedFilingDates(env);
      expect(result.attempted).toBe(1);
      expect(result.updated).toBe(0);
    });

    it('ignores filings outside the E-undated- prefix', async () => {
      const now = new Date('2026-08-09T12:00:00Z');
      await insertFiling({
        doc_id: 'E-2026-jane-q-official',
        chamber: 'executive',
        ingest_status: 'classified',
        doc_kind: 'text_pdf',
        first_seen_at: now.toISOString(),
        raw_object_key: 'raw/E-2026-jane-q-official',
      });
      const env = makeEnv();
      const result = await sweepOgeUndatedFilingDates(env);
      expect(result.attempted).toBe(0);
    });
  });

  describe('sweepLocalVisionHostedFallback', () => {
    it('enqueues hosted filing.extracted once for a parked local_mac_1 doc', async () => {
      const env = makeEnv();
      await insertFiling({
        doc_id: 'H-2025-20026666',
        ingest_status: 'needs_review',
        doc_kind: 'scanned_pdf',
        first_seen_at: '2026-08-10T00:00:00Z',
        raw_object_key: 'raw/H-2025-20026666.pdf',
      });
      await d1.prepare(
        `UPDATE filings SET error = ? WHERE doc_id = ?`,
      ).bind(
        'local_vision_exhausted: attempts=3 last=transcription_failed worker=local_mac_1',
        'H-2025-20026666',
      ).run();
      await d1.prepare(
        `INSERT INTO review_queue (doc_id, reason, resolved, created_at) VALUES (?, ?, 0, ?)`,
      ).bind(
        'H-2025-20026666',
        'local_vision_exhausted,scanned_pdf_vision_spend',
        '2026-08-10T00:00:00Z',
      ).run();

      const first = await sweepLocalVisionHostedFallback(env);
      expect(first.enqueued).toBe(1);
      expect(sentMessages).toEqual([{
        message: { type: 'filing.extracted', docId: 'H-2025-20026666' },
        options: undefined,
      }]);
      const stamped = await d1.prepare(
        `SELECT error FROM filings WHERE doc_id = ?`,
      ).bind('H-2025-20026666').first<{ error: string }>();
      expect(stamped?.error).toContain('hosted_fallback_enqueued');

      sentMessages.length = 0;
      const second = await sweepLocalVisionHostedFallback(env);
      expect(second.enqueued).toBe(0);
      expect(sentMessages).toEqual([]);
    });
  });

  describe('runAutonomySweeps orchestration', () => {
    it('isolates a failing sweep so the others still run', async () => {
      const env = makeEnv();
      const now = new Date('2026-08-09T12:00:00Z');
      const wayPastExpiry = new Date(now.getTime() - 25 * 3600_000).toISOString();
      await insertFiling({
        doc_id: 'doc-orchestration-1',
        ingest_status: 'extraction_pending_local',
        doc_kind: 'scanned_pdf',
        first_seen_at: wayPastExpiry,
        local_wait_expires_at: wayPastExpiry,
      });
      // Force the filed-date backfill lane to blow up.
      fetchHouseIndex.mockRejectedValueOnce(new Error('network down'));
      await insertFiling({
        doc_id: 'H-2026-20077777',
        chamber: 'house',
        ingest_status: 'classified',
        first_seen_at: new Date(now.getTime() - 100 * 3600_000).toISOString(),
        filed_date: null,
      });

      const result = await runAutonomySweeps(env, now);
      // The ceiling sweep still ran and did its job...
      expect(result.ceiling?.flipped).toBe(1);
      // ...even though the filed-date fetch itself failed inside its own
      // sweep (caught internally, not surfaced as a top-level error) — the
      // orchestrator's error isolation is for a sweep throwing outright.
      expect(result.errors).toEqual([]);
    });
  });
});

describe('sweepLivenessAlarms (owner 2026-08-10: silence must be loud)', () => {
  function kvEnv() {
    const store = new Map<string, string>();
    const env = {
      CONFIG_KV: {
        get: async (k: string, mode?: string) => {
          const v = store.get(k) ?? null;
          if (v === null) return null;
          return mode === 'json' ? JSON.parse(v) : v;
        },
        put: async (k: string, v: string) => { store.set(k, v); },
        delete: async (k: string) => { store.delete(k); },
      },
    } as unknown as Env;
    return { env, store };
  }
  const badHealth = (status: 'stalled' | 'degraded' | 'ok', detail = 'x') => ({
    status,
    checks: [
      { id: 'polling_senate', status, detail, value: null },
      { id: 'data_freshness', status: 'ok', detail: 'irrelevant non-liveness check', value: 0 },
    ],
  });

  it('notifies once on ok->bad transition and records the episode', async () => {
    const { env, store } = kvEnv();
    const pushes: Array<{ title: string; priority?: number }> = [];
    const r = await sweepLivenessAlarms(env, new Date('2026-08-10T06:00:00Z'), {
      checkHealth: async () => badHealth('stalled') as never,
      push: (async (_e: unknown, m: { title: string; priority?: number }) => { pushes.push(m); return { sent: true }; }) as never,
    });
    expect(r.notified).toEqual(['polling_senate']);
    expect(pushes).toHaveLength(1);
    expect(pushes[0].title).toContain('DOWN');
    expect(pushes[0].priority).toBe(1);
    expect(store.has('liveness-alarm:polling_senate')).toBe(true);
  });

  it('pages autopilot_halt and extraction_backlog through the same liveness path', async () => {
    const { env } = kvEnv();
    const pushes: Array<{ title: string; priority?: number }> = [];
    const r = await sweepLivenessAlarms(env, new Date('2026-08-17T23:00:00Z'), {
      checkHealth: async () => ({
        status: 'stalled',
        checks: [
          { id: 'autopilot_halt', status: 'stalled', detail: 'Autopilot runs halted: error_class:billing', value: 1 },
          { id: 'extraction_backlog', status: 'stalled', detail: '219 unresolved human-review item(s)', value: 219 },
        ],
      }) as never,
      push: (async (_e: unknown, m: { title: string; priority?: number }) => {
        pushes.push(m);
        return { sent: true };
      }) as never,
    });
    expect(r.notified.sort()).toEqual(['autopilot_halt', 'extraction_backlog']);
    expect(pushes).toHaveLength(2);
  });

  it('does NOT re-notify inside the 6h window while still bad', async () => {
    const { env } = kvEnv();
    const pushes: unknown[] = [];
    const deps = {
      checkHealth: async () => badHealth('stalled') as never,
      push: (async (_e: unknown, m: unknown) => { pushes.push(m); return { sent: true }; }) as never,
    };
    await sweepLivenessAlarms(env, new Date('2026-08-10T06:00:00Z'), deps);
    const r2 = await sweepLivenessAlarms(env, new Date('2026-08-10T07:00:00Z'), deps);
    expect(pushes).toHaveLength(1);
    expect(r2.notified).toEqual([]);
  });

  it('re-notifies after 6h still-bad', async () => {
    const { env } = kvEnv();
    const pushes: unknown[] = [];
    const deps = {
      checkHealth: async () => badHealth('stalled') as never,
      push: (async (_e: unknown, m: unknown) => { pushes.push(m); return { sent: true }; }) as never,
    };
    await sweepLivenessAlarms(env, new Date('2026-08-10T06:00:00Z'), deps);
    await sweepLivenessAlarms(env, new Date('2026-08-10T12:30:00Z'), deps);
    expect(pushes).toHaveLength(2);
  });

  it('notifies again when the bad status CHANGES (degraded -> stalled)', async () => {
    const { env } = kvEnv();
    const pushes: Array<{ priority?: number }> = [];
    await sweepLivenessAlarms(env, new Date('2026-08-10T06:00:00Z'), {
      checkHealth: async () => badHealth('degraded') as never,
      push: (async (_e: unknown, m: { priority?: number }) => { pushes.push(m); return { sent: true }; }) as never,
    });
    await sweepLivenessAlarms(env, new Date('2026-08-10T06:30:00Z'), {
      checkHealth: async () => badHealth('stalled') as never,
      push: (async (_e: unknown, m: { priority?: number }) => { pushes.push(m); return { sent: true }; }) as never,
    });
    expect(pushes).toHaveLength(2);
    expect(pushes[1].priority).toBe(1);
  });

  it('sends a recovery note and clears the episode on bad->ok', async () => {
    const { env, store } = kvEnv();
    const pushes: Array<{ title: string }> = [];
    const push = (async (_e: unknown, m: { title: string }) => { pushes.push(m); return { sent: true }; }) as never;
    await sweepLivenessAlarms(env, new Date('2026-08-10T06:00:00Z'), {
      checkHealth: async () => badHealth('stalled') as never, push,
    });
    const r = await sweepLivenessAlarms(env, new Date('2026-08-10T07:00:00Z'), {
      checkHealth: async () => badHealth('ok') as never, push,
    });
    expect(r.recovered).toEqual(['polling_senate']);
    expect(pushes).toHaveLength(2);
    expect(pushes[1].title).toContain('recovered');
    expect(store.has('liveness-alarm:polling_senate')).toBe(false);
  });

  it('an UNDELIVERED alarm (sent:false) records no episode, so it retries next sweep', async () => {
    // sendPushover never throws — unconfigured creds return {sent:false}.
    // Counting that as notified would make the alarm channel silently dead:
    // the exact failure class this sweep exists to kill.
    const { env, store } = kvEnv();
    const pushes: unknown[] = [];
    const r = await sweepLivenessAlarms(env, new Date('2026-08-10T06:00:00Z'), {
      checkHealth: async () => badHealth('stalled') as never,
      push: (async (_e: unknown, m: unknown) => { pushes.push(m); return { sent: false, reason: 'PUSHOVER_APP_TOKEN not configured' }; }) as never,
    });
    expect(r.notified).toEqual([]);
    expect(store.has('liveness-alarm:polling_senate')).toBe(false);
    // Next sweep retries the delivery (no episode was recorded).
    await sweepLivenessAlarms(env, new Date('2026-08-10T07:00:00Z'), {
      checkHealth: async () => badHealth('stalled') as never,
      push: (async (_e: unknown, m: unknown) => { pushes.push(m); return { sent: true }; }) as never,
    });
    expect(pushes).toHaveLength(2);
    expect(store.has('liveness-alarm:polling_senate')).toBe(true);
  });

  it("'unknown' (collection blip) mid-episode neither clears the episode nor sends a lying recovery", async () => {
    const { env, store } = kvEnv();
    const pushes: Array<{ title: string }> = [];
    const push = (async (_e: unknown, m: { title: string }) => { pushes.push(m); return { sent: true }; }) as never;
    await sweepLivenessAlarms(env, new Date('2026-08-10T06:00:00Z'), {
      checkHealth: async () => badHealth('stalled') as never, push,
    });
    const r = await sweepLivenessAlarms(env, new Date('2026-08-10T07:00:00Z'), {
      checkHealth: async () => badHealth('unknown' as never) as never, push,
    });
    expect(r.recovered).toEqual([]);
    expect(pushes).toHaveLength(1);
    expect(store.has('liveness-alarm:polling_senate')).toBe(true);
  });

  it('ignores non-liveness checks entirely (no alarm for data_freshness etc.)', async () => {
    const { env } = kvEnv();
    const pushes: unknown[] = [];
    const r = await sweepLivenessAlarms(env, new Date('2026-08-10T06:00:00Z'), {
      checkHealth: async () => ({
        status: 'degraded',
        checks: [{ id: 'data_freshness', status: 'degraded', detail: 'old data', value: 99 }],
      }) as never,
      push: (async (_e: unknown, m: unknown) => { pushes.push(m); return { sent: true }; }) as never,
    });
    expect(r.evaluated).toBe(0);
    expect(pushes).toHaveLength(0);
  });
});
