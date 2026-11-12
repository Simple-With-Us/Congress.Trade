import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'libsql';
import { d1Database } from '../../prices/__tests__/sqliteD1.ts';
import { runMigrations } from '../../admin/migrations.ts';
import { isLocalWorkerHeartbeatFresh, classifyFiling } from '../classifier.ts';
import { handleLocalWaitCheck } from '../../queueHandlers.ts';
import { createAdminApp } from '../../admin/routes.ts';
import type { Env, Filing } from '../../shared/types.ts';

describe('Local Vision Worker & Bounded Wait State (M1 / R1)', () => {
  let fileDb: Database.Database;
  let d1: ReturnType<typeof d1Database>;
  let sentMessages: Array<{ message: unknown; options?: unknown }> = [];

  const mockR2 = {
    get: async (key: string) => {
      if (key === 'scanned.pdf') {
        const bytes = new TextEncoder().encode('%PDF-1.7\n/Subtype /Image /Width 2000 /Height 2600');
        return {
          httpMetadata: { contentType: 'application/pdf' },
          arrayBuffer: async () => bytes.buffer,
        };
      }
      if (key === 'text.pdf') {
        const bytes = new TextEncoder().encode('%PDF-1.7\n/Font <</F1 1 0 R>> BT (x) Tj ET');
        return {
          httpMetadata: { contentType: 'application/pdf' },
          arrayBuffer: async () => bytes.buffer,
        };
      }
      return null;
    },
  };

  const mockIngestQueue = {
    send: async (message: unknown, options?: unknown) => {
      sentMessages.push({ message, options });
    },
  };

  function makeEnv(): Env {
    return {
      DB: d1,
      RAW_FILES: mockR2 as unknown,
      INGEST_QUEUE: mockIngestQueue as unknown,
      ADMIN_OPEN_IN_DEV: 'true',
      ADMIN_TOKEN: 'test-admin-token',
    } as unknown as Env;
  }

  beforeEach(async () => {
    fileDb = new Database(':memory:');
    d1 = d1Database(fileDb);
    sentMessages = [];
    await runMigrations(d1);
  });

  afterEach(() => {
    try {
      fileDb.close();
    } catch {}
  });

  describe('isLocalWorkerHeartbeatFresh', () => {
    it('returns false when no heartbeat exists', async () => {
      const fresh = await isLocalWorkerHeartbeatFresh(d1);
      expect(fresh).toBe(false);
    });

    it('returns true when a heartbeat exists within 5 minutes', async () => {
      const nowIso = new Date().toISOString();
      await d1.prepare(
        `INSERT INTO local_worker_heartbeat (worker_id, last_heartbeat_at, status_json) VALUES (?, ?, ?)`
      ).bind('local_mac_1', nowIso, JSON.stringify({ ok: true })).run();

      const fresh = await isLocalWorkerHeartbeatFresh(d1);
      expect(fresh).toBe(true);
    });

    it('returns false when heartbeat is older than 5 minutes', async () => {
      const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      await d1.prepare(
        `INSERT INTO local_worker_heartbeat (worker_id, last_heartbeat_at, status_json) VALUES (?, ?, ?)`
      ).bind('local_mac_1', oldTime, JSON.stringify({ ok: true })).run();

      const fresh = await isLocalWorkerHeartbeatFresh(d1);
      expect(fresh).toBe(false);
    });
  });

  describe('classifyFiling bounded wait state', () => {
    it('sets status to extraction_pending_local and enqueues delayed check when worker is fresh', async () => {
      const env = makeEnv();
      const nowIso = new Date().toISOString();
      await d1.prepare(
        `INSERT INTO local_worker_heartbeat (worker_id, last_heartbeat_at, status_json) VALUES (?, ?, ?)`
      ).bind('local_mac_1', nowIso, '{}').run();

      await d1.prepare(
        `INSERT INTO filings (doc_id, chamber, source_url, raw_object_key, ingest_status, doc_kind, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind('doc-scan-1', 'house', 'https://example.com/scan.pdf', 'scanned.pdf', 'fetched', 'unknown', nowIso).run();

      const docKind = await classifyFiling(env, 'doc-scan-1');
      expect(docKind).toBe('scanned_pdf');

      const filingRow = await d1.prepare(
        `SELECT ingest_status, local_wait_expires_at FROM filings WHERE doc_id = ?`
      ).bind('doc-scan-1').first<{ ingest_status: string; local_wait_expires_at: string }>();

      expect(filingRow?.ingest_status).toBe('extraction_pending_local');
      expect(filingRow?.local_wait_expires_at).toBeDefined();

      expect(sentMessages.length).toBe(1);
      expect(sentMessages[0].message).toEqual({ type: 'filing.local_wait_check', docId: 'doc-scan-1' });
      // 2026-09-04 owner rule: 2-minute cap on the local Mac vision wait (was 15).
      expect(sentMessages[0].options).toEqual({ delaySeconds: 2 * 60 });
    });

    it('sets status to classified and enqueues filing.extracted immediately when worker is offline/stale', async () => {
      const env = makeEnv();
      const nowIso = new Date().toISOString();

      await d1.prepare(
        `INSERT INTO filings (doc_id, chamber, source_url, raw_object_key, ingest_status, doc_kind, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind('doc-scan-stale', 'house', 'https://example.com/scan.pdf', 'scanned.pdf', 'fetched', 'unknown', nowIso).run();

      const docKind = await classifyFiling(env, 'doc-scan-stale');
      expect(docKind).toBe('scanned_pdf');

      const filingRow = await d1.prepare(
        `SELECT ingest_status, local_wait_expires_at FROM filings WHERE doc_id = ?`
      ).bind('doc-scan-stale').first<{ ingest_status: string; local_wait_expires_at: string | null }>();

      expect(filingRow?.ingest_status).toBe('classified');
      expect(filingRow?.local_wait_expires_at).toBeNull();

      expect(sentMessages.length).toBe(1);
      expect(sentMessages[0].message).toEqual({ type: 'filing.extracted', docId: 'doc-scan-stale' });
    });

    it('no-ops (does not overwrite ingest_status) when the doc is already review-resolved', async () => {
      // Regression guard for the autonomy diagnosis 2026-08-09 finding #2:
      // classifyFiling used to unconditionally overwrite ingest_status on
      // every re-delivery of filing.fetched, clobbering a terminal status
      // the review process already stamped (e.g. admin reject).
      const env = makeEnv();
      const nowIso = new Date().toISOString();
      await d1.prepare(
        `INSERT INTO filings (doc_id, chamber, source_url, raw_object_key, ingest_status, doc_kind, first_seen_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind('doc-already-rejected', 'house', 'https://example.com/scan.pdf', 'text.pdf', 'error', 'unknown', nowIso, 'rejected: bad extraction').run();
      await d1.prepare(
        `INSERT INTO review_queue (doc_id, reason, resolved, created_at) VALUES (?, ?, ?, ?)`
      ).bind('doc-already-rejected', 'rejected: bad extraction', 1, nowIso).run();

      await classifyFiling(env, 'doc-already-rejected');

      const row = await d1.prepare(
        `SELECT ingest_status, error FROM filings WHERE doc_id = ?`
      ).bind('doc-already-rejected').first<{ ingest_status: string; error: string }>();
      expect(row?.ingest_status).toBe('error');
      expect(row?.error).toBe('rejected: bad extraction');
      expect(sentMessages.length).toBe(0);
    });
  });

  describe('handleLocalWaitCheck queue handler', () => {
    it('transitions expired extraction_pending_local filing to classified and enqueues filing.extracted', async () => {
      const env = makeEnv();
      const pastExpires = new Date(Date.now() - 60 * 1000).toISOString();
      await d1.prepare(
        `INSERT INTO filings (doc_id, chamber, source_url, ingest_status, doc_kind, local_wait_expires_at, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind('doc-wait-expired', 'house', 'https://example.com/a.pdf', 'extraction_pending_local', 'scanned_pdf', pastExpires, new Date().toISOString()).run();

      await handleLocalWaitCheck(env, 'doc-wait-expired');

      const row = await d1.prepare(
        `SELECT ingest_status FROM filings WHERE doc_id = ?`
      ).bind('doc-wait-expired').first<{ ingest_status: string }>();

      expect(row?.ingest_status).toBe('classified');
      expect(sentMessages.length).toBe(1);
      expect(sentMessages[0].message).toEqual({ type: 'filing.extracted', docId: 'doc-wait-expired' });
    });

    it('does not transition non-expired extraction_pending_local filing, but reschedules a follow-up check (lost-wakeup fix)', async () => {
      // Regression guard for the autonomy diagnosis 2026-08-09 finding #2:
      // an early-firing check used to silently no-op with nothing ever
      // scheduled again, stranding the filing until the hourly ceiling sweep
      // eventually rescued it (up to ~24h later).
      const env = makeEnv();
      // 2026-09-04 owner rule: 2-minute cap on the local Mac vision wait.
      // Set a future expiry 90s out so the test exercises the same lost-wakeup
      // re-enqueue path without exceeding the new cap.
      const futureExpires = new Date(Date.now() + 90 * 1000).toISOString();
      await d1.prepare(
        `INSERT INTO filings (doc_id, chamber, source_url, ingest_status, doc_kind, local_wait_expires_at, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind('doc-wait-active', 'house', 'https://example.com/a.pdf', 'extraction_pending_local', 'scanned_pdf', futureExpires, new Date().toISOString()).run();

      await handleLocalWaitCheck(env, 'doc-wait-active');

      const row = await d1.prepare(
        `SELECT ingest_status FROM filings WHERE doc_id = ?`
      ).bind('doc-wait-active').first<{ ingest_status: string }>();

      expect(row?.ingest_status).toBe('extraction_pending_local');
      expect(sentMessages.length).toBe(1);
      expect(sentMessages[0].message).toEqual({ type: 'filing.local_wait_check', docId: 'doc-wait-active' });
      const options = sentMessages[0].options as { delaySeconds: number };
      // Remaining wait is ~90s; allow slack for test execution time.
      expect(options.delaySeconds).toBeGreaterThan(30);
      expect(options.delaySeconds).toBeLessThanOrEqual(90);
    });
  });

  describe('Admin Endpoints for Local Vision Worker', () => {
    it('POST /api/admin/local-worker/heartbeat updates worker heartbeat', async () => {
      const app = createAdminApp();
      const env = makeEnv();

      const res = await app.request('/local-worker/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-admin-token' },
        body: JSON.stringify({ workerId: 'mac_studio_1', statusJson: { cpu: '10%' } }),
      }, env as never);

      expect(res.status).toBe(200);
      const json = await res.json() as { ok: boolean; workerId: string };
      expect(json.ok).toBe(true);
      expect(json.workerId).toBe('mac_studio_1');

      const fresh = await isLocalWorkerHeartbeatFresh(d1);
      expect(fresh).toBe(true);
    });

    it('GET /api/admin/scanned-filings/pending returns pending scanned filings with stored copy only', async () => {
      const app = createAdminApp();
      const env = makeEnv();
      const nowIso = new Date().toISOString();

      await d1.prepare(
        `INSERT INTO filings (doc_id, chamber, source_url, raw_object_key, ingest_status, doc_kind, local_wait_expires_at, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind('scanned-pending-1', 'house', 'https://example.com/1.pdf', 'raw/scanned-pending-1.pdf', 'extraction_pending_local', 'scanned_pdf', new Date(Date.now() + 600000).toISOString(), nowIso).run();

      // No raw_object_key → must NOT appear (workers must not re-hit source).
      await d1.prepare(
        `INSERT INTO filings (doc_id, chamber, source_url, ingest_status, doc_kind, local_wait_expires_at, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind('scanned-no-raw-1', 'house', 'https://clerk.example/ghost.pdf', 'extraction_pending_local', 'scanned_pdf', new Date(Date.now() + 600000).toISOString(), nowIso).run();

      const res = await app.request('/scanned-filings/pending', {
        method: 'GET',
        headers: { Authorization: 'Bearer test-admin-token' },
      }, env as never);

      expect(res.status).toBe(200);
      const json = await res.json() as {
        ok: boolean;
        count: number;
        filings: Array<{ doc_id: string; stored_document_url?: string; raw_object_key?: string }>;
      };
      expect(json.ok).toBe(true);
      expect(json.count).toBe(1);
      expect(json.filings[0].doc_id).toBe('scanned-pending-1');
      expect(json.filings[0].raw_object_key).toBe('raw/scanned-pending-1.pdf');
      expect(json.filings[0].stored_document_url).toBe('/api/admin/filings/scanned-pending-1/raw');
      expect(json.filings.map((f) => f.doc_id)).not.toContain('scanned-no-raw-1');
    });

    it('GET /api/admin/scanned-filings/pending includes expired waits and extract_empty review scans', async () => {
      const app = createAdminApp();
      const env = makeEnv();
      const nowIso = new Date().toISOString();
      const past = new Date(Date.now() - 600_000).toISOString();

      await d1.prepare(
        `INSERT INTO filings (doc_id, chamber, source_url, raw_object_key, ingest_status, doc_kind, local_wait_expires_at, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind('scanned-expired-1', 'house', 'https://example.com/expired.pdf', 'raw/expired.pdf', 'extraction_pending_local', 'scanned_pdf', past, nowIso).run();

      await d1.prepare(
        `INSERT INTO filings (doc_id, chamber, source_url, raw_object_key, ingest_status, doc_kind, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind('exec-empty-1', 'executive', 'https://example.com/oge.pdf', 'raw/oge.pdf', 'needs_review', 'scanned_pdf', nowIso).run();
      await d1.prepare(
        `INSERT INTO review_queue (doc_id, reason, resolved, created_at) VALUES (?, ?, ?, ?)`
      ).bind('exec-empty-1', 'extract_empty_failure,no_transactions_extracted', 0, nowIso).run();

      const res = await app.request('/scanned-filings/pending', {
        method: 'GET',
        headers: { Authorization: 'Bearer test-admin-token' },
      }, env as never);

      expect(res.status).toBe(200);
      const json = await res.json() as { ok: boolean; count: number; filings: Array<{ doc_id: string }> };
      expect(json.ok).toBe(true);
      const ids = json.filings.map((f) => f.doc_id).sort();
      expect(ids).toContain('scanned-expired-1');
      expect(ids).toContain('exec-empty-1');
    });

    it('GET /api/admin/filings/:docId/raw serves stored bytes and never source-redirects', async () => {
      const app = createAdminApp();
      const env = makeEnv();
      const nowIso = new Date().toISOString();
      const pdfBytes = new TextEncoder().encode('%PDF-1.7 stored-copy-only');

      await d1.prepare(
        `INSERT INTO filings (doc_id, chamber, source_url, raw_object_key, ingest_status, doc_kind, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind('doc-raw-1', 'house', 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2024/999.pdf', 'raw/doc-raw-1.pdf', 'fetched', 'scanned_pdf', nowIso).run();

      const envWithR2 = {
        ...env,
        RAW_FILES: {
          get: async (key: string) => {
            if (key !== 'raw/doc-raw-1.pdf') return null;
            return {
              httpMetadata: { contentType: 'application/pdf' },
              body: new ReadableStream({
                start(controller) {
                  controller.enqueue(pdfBytes);
                  controller.close();
                },
              }),
              arrayBuffer: async () => pdfBytes.buffer,
            };
          },
        },
      };

      const res = await app.request('/filings/doc-raw-1/raw', {
        method: 'GET',
        headers: { Authorization: 'Bearer test-admin-token' },
      }, envWithR2 as never);

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/pdf');
      expect(res.headers.get('x-congress-trade-source')).toBe('stored-raw');
      expect(res.headers.get('location')).toBeNull();
      const body = new Uint8Array(await res.arrayBuffer());
      expect(new TextDecoder().decode(body).startsWith('%PDF')).toBe(true);

      // Missing stored object → 404 JSON, not a 302 to Clerk.
      const missing = await app.request('/filings/doc-missing/raw', {
        method: 'GET',
        headers: { Authorization: 'Bearer test-admin-token' },
      }, env as never);
      expect(missing.status).toBe(404);
      expect(missing.headers.get('location')).toBeNull();
      const missJson = await missing.json() as { error: string };
      expect(missJson.error).toMatch(/stored copy/i);
    });

    it('POST /api/admin/ingest-local-vision normalizes and persists transactions with source=local_mac', async () => {
      const app = createAdminApp();
      const env = makeEnv();
      const nowIso = new Date().toISOString();

      await d1.prepare(
        `INSERT INTO filings (doc_id, chamber, filing_type, filed_date, source_url, ingest_status, doc_kind, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind('doc-local-vision-1', 'house', 'P', '2026-08-01', 'https://example.com/scan.pdf', 'extraction_pending_local', 'scanned_pdf', nowIso).run();

      const transactions = [
        {
          ticker: 'NVDA',
          assetName: 'NVIDIA Corporation',
          txType: 'B',
          txDate: '2026-07-25',
          amountMin: 1001,
          amountMax: 15000,
          confidence: 0.95,
          rawText: 'NVIDIA Corporation [NVDA] P 07/25/2026 $1,001 - $15,000',
        },
      ];

      const res = await app.request('/ingest-local-vision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-admin-token' },
        body: JSON.stringify({
          docId: 'doc-local-vision-1',
          transactions,
          workerId: 'mac_vision_worker_1',
          extractor: 'mac_vision_v1',
        }),
      }, env as never);

      expect(res.status).toBe(200);

      const json = await res.json() as {
        ok: boolean;
        docId: string;
        published: boolean;
        needsReview: boolean;
        txCount: number;
      };
      expect(json.ok).toBe(true);
      expect(json.docId).toBe('doc-local-vision-1');
      expect(json.published).toBe(false);
      expect(json.needsReview).toBe(true);
      expect(json.txCount).toBe(1);

      const txRow = await d1.prepare(
        `SELECT doc_id, ticker, source FROM transactions WHERE doc_id = ?`
      ).bind('doc-local-vision-1').first<{ doc_id: string; ticker: string; source: string }>();

      expect(txRow).toBeNull();

      const filingRow = await d1.prepare(
        `SELECT ingest_status FROM filings WHERE doc_id = ?`
      ).bind('doc-local-vision-1').first<{ ingest_status: string }>();

      expect(filingRow?.ingest_status).toBe('needs_review');

      const review = await d1.prepare(
        `SELECT reason, payload FROM review_queue WHERE doc_id = ?`
      ).bind('doc-local-vision-1').first<{ reason: string; payload: string }>();
      expect(review?.reason).toContain('needs_hand_check:mac_vision');
      const staged = JSON.parse(review?.payload ?? '{}') as { transactionCount?: number };
      expect(staged.transactionCount).toBe(1);
    });

    it('GET /api/admin/scanned-filings/pending excludes local_vision_exhausted parks', async () => {
      const app = createAdminApp();
      const env = makeEnv();
      const nowIso = new Date().toISOString();

      await d1.prepare(
        `INSERT INTO filings (doc_id, chamber, source_url, raw_object_key, ingest_status, doc_kind, error, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        'scanned-exhausted-1',
        'house',
        'https://example.com/exhausted.pdf',
        'raw/exhausted.pdf',
        'needs_review',
        'scanned_pdf',
        'local_vision_exhausted: attempts=3 last=zero_transactions worker=local_mac_1',
        nowIso,
      ).run();
      await d1.prepare(
        `INSERT INTO review_queue (doc_id, reason, resolved, created_at) VALUES (?, ?, ?, ?)`
      ).bind('scanned-exhausted-1', 'local_vision_exhausted,scanned_pdf_vision_spend', 0, nowIso).run();

      // Control: still-pending extract_empty should remain visible.
      await d1.prepare(
        `INSERT INTO filings (doc_id, chamber, source_url, raw_object_key, ingest_status, doc_kind, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind('scanned-empty-1', 'house', 'https://example.com/empty.pdf', 'raw/empty.pdf', 'needs_review', 'scanned_pdf', nowIso).run();
      await d1.prepare(
        `INSERT INTO review_queue (doc_id, reason, resolved, created_at) VALUES (?, ?, ?, ?)`
      ).bind('scanned-empty-1', 'extract_empty_failure,no_transactions_extracted', 0, nowIso).run();

      const res = await app.request('/scanned-filings/pending', {
        method: 'GET',
        headers: { Authorization: 'Bearer test-admin-token' },
      }, env as never);

      expect(res.status).toBe(200);
      const json = await res.json() as { ok: boolean; filings: Array<{ doc_id: string }> };
      expect(json.ok).toBe(true);
      const ids = json.filings.map((f) => f.doc_id);
      expect(ids).toContain('scanned-empty-1');
      expect(ids).not.toContain('scanned-exhausted-1');
    });

    it('GET /api/admin/scanned-filings/pending?worker=local reclaims cascade/row-limit/low-confidence scans; default stays conservative', async () => {
      // 2026-08-20 autonomy fix: every unresolved scanned review item with
      // stored raw bytes is advertised to the local (free Grok-CLI) worker so
      // the whole queue drains without OpenRouter spend. The Coolify CPU OCR
      // worker (no param) must NOT see those docs — it is what generated the
      // garbage/cascade flags in the first place.
      const app = createAdminApp();
      const env = makeEnv();
      const nowIso = new Date().toISOString();

      const seed = async (docId: string, reason: string) => {
        await d1.prepare(
          `INSERT INTO filings (doc_id, chamber, source_url, raw_object_key, ingest_status, doc_kind, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(docId, 'house', `https://example.com/${docId}.pdf`, `raw/${docId}.pdf`, 'needs_review', 'scanned_pdf', nowIso).run();
        await d1.prepare(
          `INSERT INTO review_queue (doc_id, reason, resolved, created_at) VALUES (?, ?, ?, ?)`
        ).bind(docId, reason, 0, nowIso).run();
      };
      await seed('scan-cascade-1', 'agreement_cascade_unresolved');
      await seed('scan-rowlimit-1', 'extraction_row_limit_exceeded_likely_garbage:0.93');
      await seed('scan-mismatch-1', 'ticker_asset_mismatch,invalid_amount,low_confidence');
      await seed('scan-empty-1', 'extract_empty_failure,no_transactions_extracted');
      // Parked docs stay excluded even for local workers.
      await seed('scan-parked-1', 'local_vision_exhausted,scanned_pdf_vision_spend');

      const conservative = await app.request('/scanned-filings/pending', {
        method: 'GET',
        headers: { Authorization: 'Bearer test-admin-token' },
      }, env as never);
      expect(conservative.status).toBe(200);
      const consJson = await conservative.json() as { filings: Array<{ doc_id: string }> };
      const consIds = consJson.filings.map((f) => f.doc_id);
      expect(consIds).toContain('scan-empty-1');
      expect(consIds).not.toContain('scan-cascade-1');
      expect(consIds).not.toContain('scan-rowlimit-1');
      expect(consIds).not.toContain('scan-mismatch-1');
      expect(consIds).not.toContain('scan-parked-1');

      const local = await app.request('/scanned-filings/pending?worker=local_mac', {
        method: 'GET',
        headers: { Authorization: 'Bearer test-admin-token' },
      }, env as never);
      expect(local.status).toBe(200);
      const localJson = await local.json() as { filings: Array<{ doc_id: string }> };
      const localIds = localJson.filings.map((f) => f.doc_id);
      expect(localIds).toContain('scan-empty-1');
      expect(localIds).toContain('scan-cascade-1');
      expect(localIds).toContain('scan-rowlimit-1');
      expect(localIds).toContain('scan-mismatch-1');
      expect(localIds).not.toContain('scan-parked-1');
    });

    it('GET /scanned-filings/pending?worker=local skips docs already submitted to review', async () => {
      const app = createAdminApp();
      const env = makeEnv();
      const nowIso = new Date().toISOString();
      await d1.prepare(
        `INSERT INTO filings (doc_id, chamber, source_url, raw_object_key, ingest_status, doc_kind, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind('scan-submitted-1', 'house', 'https://example.com/s.pdf', 'raw/s.pdf', 'needs_review', 'scanned_pdf', nowIso).run();
      await d1.prepare(
        `INSERT INTO review_queue (doc_id, reason, resolved, created_at) VALUES (?, ?, ?, ?)`,
      ).bind('scan-submitted-1', 'no_amount,low_confidence,local_vision_submitted', 0, nowIso).run();
      await d1.prepare(
        `INSERT INTO filings (doc_id, chamber, source_url, raw_object_key, ingest_status, doc_kind, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind('scan-empty-2', 'house', 'https://example.com/e.pdf', 'raw/e.pdf', 'needs_review', 'scanned_pdf', nowIso).run();
      await d1.prepare(
        `INSERT INTO review_queue (doc_id, reason, resolved, created_at) VALUES (?, ?, ?, ?)`,
      ).bind('scan-empty-2', 'extract_empty_failure,no_transactions_extracted', 0, nowIso).run();

      const local = await app.request('/scanned-filings/pending?worker=local_mac', {
        method: 'GET',
        headers: { Authorization: 'Bearer test-admin-token' },
      }, env as never);
      expect(local.status).toBe(200);
      const localJson = await local.json() as { filings: Array<{ doc_id: string }> };
      const localIds = localJson.filings.map((f) => f.doc_id);
      expect(localIds).toContain('scan-empty-2');
      expect(localIds).not.toContain('scan-submitted-1');
    });

    it('GET /scanned-filings/pending?worker=local skips classified docs stamped local_vision_submitted', async () => {
      const app = createAdminApp();
      const env = makeEnv();
      const nowIso = new Date().toISOString();
      await d1.prepare(
        `INSERT INTO filings (doc_id, chamber, source_url, raw_object_key, ingest_status, doc_kind, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind('scan-empty-cover-1', 'house', 'https://example.com/c.pdf', 'raw/c.pdf', 'classified', 'scanned_pdf', nowIso).run();
      await d1.prepare(
        `INSERT INTO review_queue (doc_id, reason, resolved, created_at) VALUES (?, ?, ?, ?)`,
      ).bind('scan-empty-cover-1', 'local_vision_submitted,nothing_to_report', 0, nowIso).run();
      await d1.prepare(
        `INSERT INTO filings (doc_id, chamber, source_url, raw_object_key, ingest_status, doc_kind, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind('scan-still-open-1', 'house', 'https://example.com/o.pdf', 'raw/o.pdf', 'classified', 'scanned_pdf', nowIso).run();

      const local = await app.request('/scanned-filings/pending?worker=local_mac', {
        method: 'GET',
        headers: { Authorization: 'Bearer test-admin-token' },
      }, env as never);
      expect(local.status).toBe(200);
      const localJson = await local.json() as { filings: Array<{ doc_id: string }> };
      const localIds = localJson.filings.map((f) => f.doc_id);
      expect(localIds).toContain('scan-still-open-1');
      expect(localIds).not.toContain('scan-empty-cover-1');
    });

    it('POST /ingest-local-vision noRows stamps local_vision_submitted and leaves pending', async () => {
      const app = createAdminApp();
      const env = makeEnv();
      const nowIso = new Date().toISOString();
      await d1.prepare(
        `INSERT INTO filings (doc_id, chamber, filing_type, filed_date, source_url, raw_object_key, ingest_status, doc_kind, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        'scan-norows-1',
        'house',
        'P',
        '2025-08-27',
        'https://example.com/n.pdf',
        'raw/n.pdf',
        'extraction_pending_local',
        'scanned_pdf',
        nowIso,
      ).run();

      const res = await app.request('/ingest-local-vision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-admin-token' },
        body: JSON.stringify({
          docId: 'scan-norows-1',
          transactions: [],
          noRows: true,
          workerId: 'local_mac_1',
          extractor: 'local_grok_cli_v1',
          source: 'local_mac',
        }),
      }, env as never);
      expect(res.status).toBe(200);
      const json = await res.json() as { ok: boolean; noRows?: boolean; published: boolean };
      expect(json.ok).toBe(true);
      expect(json.noRows).toBe(true);
      expect(json.published).toBe(false);

      const review = await d1.prepare(
        `SELECT reason, resolved FROM review_queue WHERE doc_id = ?`,
      ).bind('scan-norows-1').first<{ reason: string; resolved: number }>();
      expect(review?.resolved).toBe(0);
      expect(review?.reason).toMatch(/local_vision_submitted/);
      expect(review?.reason).toMatch(/nothing_to_report/);

      const pending = await app.request('/scanned-filings/pending?worker=local_mac', {
        method: 'GET',
        headers: { Authorization: 'Bearer test-admin-token' },
      }, env as never);
      const pendingJson = await pending.json() as { filings: Array<{ doc_id: string }> };
      expect(pendingJson.filings.map((f) => f.doc_id)).not.toContain('scan-norows-1');
    });

    it('POST /ingest-local-vision refuses a shorter OCR over a stored cascade payload', async () => {
      // #2107 advertises cascade scans to ?worker=local. The Mac worker stamps
      // confidence 0.97, so a 12-row OCR would publish (or overwrite) a 40-row
      // stored extract and lock the filing — drain skips scanned_pdf.
      const app = createAdminApp();
      const env = makeEnv();
      const nowIso = new Date().toISOString();
      const stored = Array.from({ length: 40 }, (_, i) => ({
        txDate: '2024-01-01',
        owner: 'self',
        assetName: `City of El Paso TX GO ${i}`,
        ticker: null,
        assetType: 'GS',
        txType: 'B',
        amountMin: 1001,
        amountMax: 15000,
      }));
      await d1.prepare(
        `INSERT INTO filings (doc_id, chamber, filing_type, filed_date, source_url, raw_object_key, ingest_status, doc_kind, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        'scan-cascade-shrink-1',
        'house',
        'P',
        '2024-06-01',
        'https://example.com/cascade.pdf',
        'raw/cascade.pdf',
        'needs_review',
        'scanned_pdf',
        nowIso,
      ).run();
      await d1.prepare(
        `INSERT INTO review_queue (doc_id, reason, payload, resolved, created_at) VALUES (?, ?, ?, ?, ?)`,
      ).bind(
        'scan-cascade-shrink-1',
        'agreement_cascade_unresolved',
        JSON.stringify({ transactionCount: 40, transactions: stored }),
        0,
        nowIso,
      ).run();

      const incoming = [{
        ticker: 'NVDA',
        assetName: 'NVIDIA Corporation',
        txType: 'B',
        txDate: '2024-05-01',
        amountMin: 1001,
        amountMax: 15000,
        confidence: 0.97,
        rawText: 'NVIDIA Corporation [NVDA] P 05/01/2024 $1,001 - $15,000',
      }];
      const res = await app.request('/ingest-local-vision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-admin-token' },
        body: JSON.stringify({
          docId: 'scan-cascade-shrink-1',
          transactions: incoming,
          workerId: 'local_mac_1',
          extractor: 'local_grok_cli',
          source: 'local_mac',
        }),
      }, env as never);
      expect(res.status).toBe(200);
      const json = await res.json() as {
        published: boolean;
        needsReview: boolean;
        skipped?: string;
      };
      expect(json.published).toBe(false);
      expect(json.needsReview).toBe(true);
      expect(json.skipped).toBe('smaller_than_stored_review');

      const live = await d1.prepare(
        `SELECT COUNT(*) AS n FROM transactions WHERE doc_id = ?`,
      ).bind('scan-cascade-shrink-1').first<{ n: number }>();
      expect(live?.n ?? 0).toBe(0);

      const review = await d1.prepare(
        `SELECT reason, payload, resolved FROM review_queue WHERE doc_id = ?`,
      ).bind('scan-cascade-shrink-1').first<{ reason: string; payload: string; resolved: number }>();
      expect(review?.resolved).toBe(0);
      expect(review?.reason).toMatch(/agreement_cascade_unresolved/);
      expect(review?.reason).toMatch(/local_vision_submitted/);
      expect(JSON.parse(review?.payload ?? '{}').transactionCount).toBe(40);
    });

    it('POST /ingest-local-vision refuses a date-padded OCR that would persist fewer lots than stored', async () => {
      // #2151 drops undated siblings on publish.  A 40-row Gemini submit with
      // 12 dates would look as large as the stored cascade payload, publish
      // 12, and lock the filing.
      const app = createAdminApp();
      const env = makeEnv();
      const nowIso = new Date().toISOString();
      const stored = Array.from({ length: 40 }, (_, i) => ({
        txDate: '2024-01-01',
        owner: 'self',
        assetName: `City of El Paso TX GO ${i}`,
        ticker: null,
        assetType: 'GS',
        txType: 'B',
        amountMin: 1001,
        amountMax: 15000,
      }));
      await d1.prepare(
        `INSERT INTO filings (doc_id, chamber, filing_type, filed_date, source_url, raw_object_key, ingest_status, doc_kind, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        'scan-cascade-date-pad-1',
        'house',
        'P',
        '2024-06-01',
        'https://example.com/cascade.pdf',
        'raw/cascade.pdf',
        'needs_review',
        'scanned_pdf',
        nowIso,
      ).run();
      await d1.prepare(
        `INSERT INTO review_queue (doc_id, reason, payload, resolved, created_at) VALUES (?, ?, ?, ?, ?)`,
      ).bind(
        'scan-cascade-date-pad-1',
        'agreement_cascade_unresolved',
        JSON.stringify({ transactionCount: 40, transactions: stored }),
        0,
        nowIso,
      ).run();

      const incoming = Array.from({ length: 40 }, (_, i) => i < 12
        ? {
          ticker: null,
          assetName: `Dated lot ${i}`,
          txType: 'B',
          txDate: '2024-05-01',
          amountMin: 1001,
          amountMax: 15000,
          confidence: 0.97,
          rawText: `Dated lot ${i} P 05/01/2024 $1,001 - $15,000`,
        }
        : {
          ticker: null,
          assetName: `Undated chrome ${i}`,
          txType: 'B',
          txDate: null,
          amountMin: null,
          amountMax: null,
          confidence: 0.97,
          rawText: `Undated chrome ${i}`,
        });
      const res = await app.request('/ingest-local-vision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-admin-token' },
        body: JSON.stringify({
          docId: 'scan-cascade-date-pad-1',
          transactions: incoming,
          workerId: 'local_mac_1',
          extractor: 'local_grok_cli',
          source: 'local_mac',
        }),
      }, env as never);
      expect(res.status).toBe(200);
      const json = await res.json() as {
        published: boolean;
        needsReview: boolean;
        skipped?: string;
      };
      expect(json.published).toBe(false);
      expect(json.needsReview).toBe(true);
      expect(json.skipped).toBe('smaller_than_stored_review');

      const live = await d1.prepare(
        `SELECT COUNT(*) AS n FROM transactions WHERE doc_id = ?`,
      ).bind('scan-cascade-date-pad-1').first<{ n: number }>();
      expect(live?.n ?? 0).toBe(0);

      const review = await d1.prepare(
        `SELECT reason, payload, resolved FROM review_queue WHERE doc_id = ?`,
      ).bind('scan-cascade-date-pad-1').first<{ reason: string; payload: string; resolved: number }>();
      expect(review?.resolved).toBe(0);
      expect(review?.reason).toMatch(/agreement_cascade_unresolved/);
      expect(review?.reason).toMatch(/local_vision_submitted/);
      expect(JSON.parse(review?.payload ?? '{}').transactionCount).toBe(40);
    });

    it('POST /ingest-local-vision retires leftover primary on a resolved truncated confirm', async () => {
      const app = createAdminApp();
      const env = makeEnv();
      const nowIso = new Date().toISOString();
      await d1.prepare(
        `INSERT INTO filings (doc_id, chamber, filing_type, filed_date, source_url, ingest_status, doc_kind, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        'doc-confirm-then-chunk',
        'house',
        'P',
        '2026-08-01',
        'https://example.com/chunk.pdf',
        'persisted',
        'scanned_pdf',
        nowIso,
      ).run();
      await d1.prepare(
        `INSERT INTO review_queue (doc_id, reason, resolved, review_revision, resolution_kind, resolution_reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        'doc-confirm-then-chunk',
        'admin_confirmed',
        1,
        1,
        'published',
        'admin_confirmed',
        nowIso,
      ).run();
      await d1.prepare(
        `INSERT INTO transactions (id, doc_id, filer_id, tx_date, owner, asset_name, ticker, tx_type, amount_min, amount_max, source, row_key, created_at, confidence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        'tx-truncated-primary',
        'doc-confirm-then-chunk',
        'F1',
        '2026-07-20',
        'self',
        'NVIDIA Corporation',
        'NVDA',
        'B',
        1001,
        15000,
        'primary',
        'v1:primary:0:nvda',
        nowIso,
        1,
      ).run();

      const res = await app.request('/ingest-local-vision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-admin-token' },
        body: JSON.stringify({
          docId: 'doc-confirm-then-chunk',
          workerId: 'local_mac_1',
          extractor: 'mac_vision_v1',
          source: 'local_mac',
          transactions: [
            {
              ticker: 'NVDA',
              assetName: 'NVIDIA Corporation',
              txType: 'B',
              txDate: '2026-07-20',
              amountMin: 1001,
              amountMax: 15000,
              confidence: 0.97,
              rawText: 'NVIDIA Corporation [NVDA] P 07/20/2026 $1,001 - $15,000',
            },
            {
              ticker: 'AAPL',
              assetName: 'Apple Inc.',
              txType: 'B',
              txDate: '2026-07-21',
              amountMin: 1001,
              amountMax: 15000,
              confidence: 0.97,
              rawText: 'Apple Inc. [AAPL] P 07/21/2026 $1,001 - $15,000',
            },
          ],
        }),
      }, env as never);
      expect(res.status).toBe(200);
      const json = await res.json() as { published: boolean; txCount: number };
      expect(json.published).toBe(true);
      expect(json.txCount).toBe(2);

      const leftover = await d1.prepare(
        `SELECT COUNT(*) AS n FROM transactions WHERE doc_id = ? AND source = 'primary' AND deprecated_at IS NULL`,
      ).bind('doc-confirm-then-chunk').first<{ n: number }>();
      const vision = await d1.prepare(
        `SELECT COUNT(*) AS n FROM transactions WHERE doc_id = ? AND source = 'local_mac' AND deprecated_at IS NULL`,
      ).bind('doc-confirm-then-chunk').first<{ n: number }>();
      expect(leftover?.n ?? 0).toBe(0);
      expect(vision?.n ?? 0).toBe(2);

      const review = await d1.prepare(
        `SELECT resolved, review_revision FROM review_queue WHERE doc_id = ?`,
      ).bind('doc-confirm-then-chunk').first<{ resolved: number; review_revision: number }>();
      expect(review?.resolved).toBe(1);
      expect(review?.review_revision).toBe(2);
    });

    it('POST /review/:docId/retire-superseded-sources deprecates leftover primary beside live local_mac', async () => {
      const app = createAdminApp();
      const env = makeEnv();
      const nowIso = new Date().toISOString();
      await d1.prepare(
        `INSERT INTO filings (doc_id, chamber, filing_type, filed_date, source_url, ingest_status, doc_kind, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind('doc-overlap-repair', 'house', 'P', '2026-08-01', 'https://example.com/o.pdf', 'persisted', 'scanned_pdf', nowIso).run();
      await d1.prepare(
        `INSERT INTO review_queue (doc_id, reason, resolved, review_revision, resolution_kind, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind('doc-overlap-repair', 'auto_published', 1, 3, 'published', nowIso).run();
      await d1.prepare(
        `INSERT INTO transactions (id, doc_id, source, tx_date, owner, asset_name, tx_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind('tx-p', 'doc-overlap-repair', 'primary', '2026-07-20', 'self', 'NVIDIA', 'B', nowIso).run();
      await d1.prepare(
        `INSERT INTO transactions (id, doc_id, source, tx_date, owner, asset_name, tx_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind('tx-v', 'doc-overlap-repair', 'local_mac', '2026-07-20', 'self', 'NVIDIA', 'B', nowIso).run();

      const overlap = await app.request('/diagnostics/source-overlap', {
        headers: { Authorization: 'Bearer test-admin-token' },
      }, env as never);
      expect(overlap.status).toBe(200);
      const overlapJson = await overlap.json() as { docs: Array<{ docId: string; primary: number; localMac: number }> };
      expect(overlapJson.docs.some((d) => d.docId === 'doc-overlap-repair' && d.primary === 1 && d.localMac === 1)).toBe(true);

      const res = await app.request('/review/doc-overlap-repair/retire-superseded-sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-admin-token' },
        body: JSON.stringify({ reviewRevision: 3 }),
      }, env as never);
      expect(res.status).toBe(200);
      const json = await res.json() as { retired: boolean; deprecatedTransactions: number };
      expect(json.retired).toBe(true);
      expect(json.deprecatedTransactions).toBe(1);

      const leftover = await d1.prepare(
        `SELECT COUNT(*) AS n FROM transactions WHERE doc_id = ? AND source = 'primary' AND deprecated_at IS NULL`,
      ).bind('doc-overlap-repair').first<{ n: number }>();
      const kept = await d1.prepare(
        `SELECT COUNT(*) AS n FROM transactions WHERE doc_id = ? AND source = 'local_mac' AND deprecated_at IS NULL`,
      ).bind('doc-overlap-repair').first<{ n: number }>();
      expect(leftover?.n ?? 0).toBe(0);
      expect(kept?.n ?? 0).toBe(1);
    });

    it('POST /api/admin/local-vision-park stamps needs_review + unresolved local_vision_exhausted', async () => {
      const app = createAdminApp();
      const env = makeEnv();
      const nowIso = new Date().toISOString();

      await d1.prepare(
        `INSERT INTO filings (doc_id, chamber, source_url, ingest_status, doc_kind, local_wait_expires_at, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        'doc-park-1',
        'house',
        'https://example.com/park.pdf',
        'extraction_pending_local',
        'scanned_pdf',
        new Date(Date.now() + 600_000).toISOString(),
        nowIso,
      ).run();
      // Prior empty extract that was spinning the worker.
      await d1.prepare(
        `INSERT INTO review_queue (doc_id, reason, resolved, created_at) VALUES (?, ?, ?, ?)`
      ).bind('doc-park-1', 'extract_empty_failure,no_transactions_extracted', 0, nowIso).run();

      const res = await app.request('/local-vision-park', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-admin-token' },
        body: JSON.stringify({
          docId: 'doc-park-1',
          workerId: 'local_mac_1',
          attempts: 3,
          lastError: 'zero_transactions',
          extractor: 'local_grok_cli_v1',
        }),
      }, env as never);

      expect(res.status).toBe(200);
      const json = await res.json() as {
        ok: boolean;
        docId: string;
        reason: string;
        ingestStatus: string;
        hostedFallbackEnqueued?: boolean;
      };
      expect(json.ok).toBe(true);
      expect(json.docId).toBe('doc-park-1');
      expect(json.reason).toBe('local_vision_exhausted,scanned_pdf_vision_spend');
      expect(json.ingestStatus).toBe('needs_review');
      expect(json.hostedFallbackEnqueued).toBe(true);
      expect(sentMessages.some((m) => {
        const msg = m.message as { type?: string; docId?: string };
        return msg.type === 'filing.extracted' && msg.docId === 'doc-park-1';
      })).toBe(true);

      const filing = await d1.prepare(
        `SELECT ingest_status, error, local_wait_expires_at FROM filings WHERE doc_id = ?`
      ).bind('doc-park-1').first<{
        ingest_status: string;
        error: string | null;
        local_wait_expires_at: string | null;
      }>();
      expect(filing?.ingest_status).toBe('needs_review');
      expect(filing?.error).toMatch(/^local_vision_exhausted:/);
      expect(filing?.local_wait_expires_at).toBeNull();

      const review = await d1.prepare(
        `SELECT reason, resolved, resolution_kind, resolution_reason FROM review_queue WHERE doc_id = ?`
      ).bind('doc-park-1').first<{
        reason: string;
        resolved: number;
        resolution_kind: string | null;
        resolution_reason: string | null;
      }>();
      expect(review?.reason).toContain('local_vision_exhausted');
      expect(review?.reason).toContain('scanned_pdf_vision_spend');
      // Unresolved — does not trip review_resolution_integrity (resolved-without-reason).
      expect(review?.resolved).toBe(0);
      expect(review?.resolution_kind == null || review?.resolution_kind === '').toBe(true);

      // Pending queue must drop the parked doc.
      const pendingRes = await app.request('/scanned-filings/pending', {
        method: 'GET',
        headers: { Authorization: 'Bearer test-admin-token' },
      }, env as never);
      const pending = await pendingRes.json() as { filings: Array<{ doc_id: string }> };
      expect(pending.filings.map((f) => f.doc_id)).not.toContain('doc-park-1');
    });

    it('POST /api/admin/ingest-local-vision accepts source=server_cpu from Coolify CPU worker', async () => {
      const app = createAdminApp();
      const env = makeEnv();
      const nowIso = new Date().toISOString();

      await d1.prepare(
        `INSERT INTO filings (doc_id, chamber, filing_type, filed_date, source_url, ingest_status, doc_kind, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind('doc-server-cpu-1', 'house', 'P', '2026-08-01', 'https://example.com/scan.pdf', 'extraction_pending_local', 'scanned_pdf', nowIso).run();

      const res = await app.request('/ingest-local-vision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-admin-token' },
        body: JSON.stringify({
          docId: 'doc-server-cpu-1',
          // Same shape as the local_mac fixture — only source/extractor differ.
          transactions: [
            {
              ticker: 'NVDA',
              assetName: 'NVIDIA Corporation',
              txType: 'B',
              txDate: '2026-07-25',
              amountMin: 1001,
              amountMax: 15000,
              confidence: 0.95,
              rawText: 'NVIDIA Corporation [NVDA] P 07/25/2026 $1,001 - $15,000',
            },
          ],
          workerId: 'server_cpu_1',
          extractor: 'server_cpu_v1',
          source: 'server_cpu',
        }),
      }, env as never);

      expect(res.status).toBe(200);
      const json = await res.json() as {
        ok: boolean;
        published: boolean;
        needsReview: boolean;
        txCount: number;
      };
      expect(json.ok).toBe(true);
      expect(json.published).toBe(false);
      expect(json.needsReview).toBe(true);
      expect(json.txCount).toBe(1);

      const txRow = await d1.prepare(
        `SELECT ticker, source FROM transactions WHERE doc_id = ?`
      ).bind('doc-server-cpu-1').first<{ ticker: string; source: string }>();
      expect(txRow).toBeNull();

      const review = await d1.prepare(
        `SELECT reason FROM review_queue WHERE doc_id = ?`,
      ).bind('doc-server-cpu-1').first<{ reason: string }>();
      expect(review?.reason).toContain('needs_hand_check:scanned_vision');
    });
  });
});
