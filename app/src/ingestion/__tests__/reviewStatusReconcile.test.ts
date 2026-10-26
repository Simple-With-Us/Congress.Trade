import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../shared/types.ts';
import {
  MANUAL_TEST_PROBE_DOC_ID,
  deleteManualTestProbe,
  reconcileResolvedReviewStatus,
  runFilingsHygiene,
  terminalStatusForResolvedReview,
} from '../reviewStatusReconcile.ts';

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
CREATE TABLE ingestion_outbox (
  doc_id TEXT PRIMARY KEY
);
CREATE TABLE extraction_runs (
  id TEXT PRIMARY KEY,
  doc_id TEXT
);
CREATE TABLE disclosure_latency_candidates (
  doc_id TEXT PRIMARY KEY
);
CREATE TABLE deno_runtime_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payload TEXT NOT NULL
);
`;

function makeDb() {
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
  const d1 = { prepare } as unknown as D1Database;
  const env = { DB: d1 } as unknown as Env;
  return { raw, env, d1 };
}

function seedFiling(
  raw: DatabaseSync,
  docId: string,
  opts: {
    ingestStatus: string;
    resolved?: number;
    resolutionKind?: string | null;
    resolutionReason?: string | null;
    reviewReason?: string | null;
    liveTx?: boolean;
    decisionAction?: string | null;
  },
) {
  raw.prepare('INSERT INTO filings (doc_id, ingest_status, error) VALUES (?, ?, NULL)').run(
    docId,
    opts.ingestStatus,
  );
  raw.prepare(
    `INSERT INTO review_queue (doc_id, reason, resolved, resolution_kind, resolution_reason)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    docId,
    opts.reviewReason ?? 'low_confidence',
    opts.resolved ?? 1,
    opts.resolutionKind ?? null,
    opts.resolutionReason ?? null,
  );
  if (opts.liveTx) {
    raw.prepare('INSERT INTO transactions (id, doc_id, deprecated_at) VALUES (?, ?, NULL)').run(
      `tx-${docId}`,
      docId,
    );
  }
  if (opts.decisionAction) {
    raw.prepare(
      'INSERT INTO ingestion_decisions (id, doc_id, action, created_at) VALUES (?, ?, ?, ?)',
    ).run(`dec-${docId}`, docId, opts.decisionAction, '2026-08-04T00:00:00.000Z');
  }
}

describe('terminalStatusForResolvedReview', () => {
  it('maps honest resolution_kind values to terminal ingest_status', () => {
    expect(terminalStatusForResolvedReview({
      resolutionKind: 'published',
      resolutionReason: 'auto_published',
      reviewReason: 'low_confidence',
      decisionAction: null,
      hasLiveTx: true,
    })).toEqual({ status: 'persisted', basis: 'resolution_kind=published' });

    expect(terminalStatusForResolvedReview({
      resolutionKind: 'rejected',
      resolutionReason: 'rejected: bad extraction',
      reviewReason: 'rejected: bad extraction',
      decisionAction: null,
      hasLiveTx: false,
    })).toEqual({ status: 'error', basis: 'resolution_kind=rejected' });

    expect(terminalStatusForResolvedReview({
      resolutionKind: 'verified_empty',
      resolutionReason: 'doc_class_empty_no_transactions',
      reviewReason: 'empty',
      decisionAction: null,
      hasLiveTx: false,
    })).toEqual({ status: 'verified_empty', basis: 'resolution_kind=verified_empty' });

    expect(terminalStatusForResolvedReview({
      resolutionKind: 'orphan_deleted',
      resolutionReason: 'orphan_filing_deleted',
      reviewReason: 'orphan_filing_deleted',
      decisionAction: null,
      hasLiveTx: false,
    })).toEqual({ status: 'error', basis: 'resolution_kind=orphan_deleted' });
  });

  it('falls back to ingestion_decisions then live-tx presence', () => {
    expect(terminalStatusForResolvedReview({
      resolutionKind: null,
      resolutionReason: null,
      reviewReason: 'low_confidence',
      decisionAction: 'confirmed',
      hasLiveTx: true,
    }).status).toBe('persisted');

    expect(terminalStatusForResolvedReview({
      resolutionKind: null,
      resolutionReason: null,
      reviewReason: 'low_confidence',
      decisionAction: 'auto_resolved_empty',
      hasLiveTx: false,
    }).status).toBe('verified_empty');

    expect(terminalStatusForResolvedReview({
      resolutionKind: null,
      resolutionReason: null,
      reviewReason: 'rejected: form chrome',
      decisionAction: null,
      hasLiveTx: false,
    }).status).toBe('error');

    expect(terminalStatusForResolvedReview({
      resolutionKind: null,
      resolutionReason: null,
      reviewReason: 'low_confidence',
      decisionAction: null,
      hasLiveTx: true,
    }).status).toBe('persisted');
  });
});

describe('reconcileResolvedReviewStatus', () => {
  it('dry-run previews without writing', async () => {
    const { raw, env } = makeDb();
    seedFiling(raw, 'H-rejected', {
      ingestStatus: 'classified',
      resolutionKind: 'rejected',
      resolutionReason: 'rejected: bad',
    });
    const preview = await reconcileResolvedReviewStatus(env, { apply: false });
    expect(preview.scanned).toBe(1);
    expect(preview.updated).toBe(0);
    expect(preview.sample[0]).toMatchObject({
      docId: 'H-rejected',
      currentStatus: 'classified',
      targetStatus: 'error',
    });
    const row = raw.prepare('SELECT ingest_status FROM filings WHERE doc_id = ?').get('H-rejected') as {
      ingest_status: string;
    };
    expect(row.ingest_status).toBe('classified');
  });

  it('stamps persisted / error / verified_empty from resolution_kind', async () => {
    const { raw, env } = makeDb();
    seedFiling(raw, 'H-pub', {
      ingestStatus: 'needs_review',
      resolutionKind: 'published',
      liveTx: true,
    });
    seedFiling(raw, 'H-rej', {
      ingestStatus: 'extraction_pending_local',
      resolutionKind: 'rejected',
      resolutionReason: 'rejected: ocr',
    });
    seedFiling(raw, 'H-empty', {
      ingestStatus: 'classified',
      resolutionKind: 'verified_empty',
      resolutionReason: 'doc_class_empty_no_transactions',
    });
    seedFiling(raw, 'H-already', {
      ingestStatus: 'persisted',
      resolutionKind: 'published',
      liveTx: true,
    });
    seedFiling(raw, 'provider-missing-xyz', {
      ingestStatus: 'needs_review',
      resolutionKind: 'published',
      liveTx: true,
    });

    const applied = await reconcileResolvedReviewStatus(env, { apply: true });
    expect(applied.scanned).toBe(3);
    expect(applied.updated).toBe(3);

    const statuses = raw.prepare('SELECT doc_id, ingest_status FROM filings ORDER BY doc_id').all() as Array<{
      doc_id: string;
      ingest_status: string;
    }>;
    expect(statuses).toEqual([
      { doc_id: 'H-already', ingest_status: 'persisted' },
      { doc_id: 'H-empty', ingest_status: 'verified_empty' },
      { doc_id: 'H-pub', ingest_status: 'persisted' },
      { doc_id: 'H-rej', ingest_status: 'error' },
      { doc_id: 'provider-missing-xyz', ingest_status: 'needs_review' },
    ]);
  });

  it('rewrites the invalid published leftover to persisted', async () => {
    const { raw, env } = makeDb();
    seedFiling(raw, 'H-leftover', {
      ingestStatus: 'published',
      resolutionKind: 'published',
      liveTx: true,
    });
    const applied = await reconcileResolvedReviewStatus(env, { apply: true });
    expect(applied.updated).toBe(1);
    const row = raw.prepare('SELECT ingest_status FROM filings WHERE doc_id = ?').get('H-leftover') as {
      ingest_status: string;
    };
    expect(row.ingest_status).toBe('persisted');
  });

  it('reconciles a published filing that never had a review_queue row', async () => {
    const { raw, env } = makeDb();
    raw.prepare(
      `INSERT INTO filings (doc_id, ingest_status, error) VALUES (?, 'error', ?)`,
    ).run('S-published', 'fetcher: source https://efdsearch.senate.gov/x -> HTTP 403');
    raw.prepare(
      `INSERT INTO transactions (id, doc_id, deprecated_at) VALUES ('tx-pub', 'S-published', NULL)`,
    ).run();
    raw.prepare(
      `INSERT INTO ingestion_decisions (id, doc_id, action, created_at)
       VALUES ('d-pub', 'S-published', 'auto_published', '2026-08-01T00:00:00.000Z')`,
    ).run();

    const preview = await reconcileResolvedReviewStatus(env, { apply: false });
    expect(preview.scanned).toBe(1);
    expect(preview.updated).toBe(0);
    expect(preview.sample[0]).toMatchObject({
      docId: 'S-published',
      currentStatus: 'error',
      targetStatus: 'persisted',
      via: 'published_truth',
      basis: 'ingestion_decisions.action=auto_published',
    });
    const before = raw.prepare(
      'SELECT ingest_status, error FROM filings WHERE doc_id = ?',
    ).get('S-published') as { ingest_status: string; error: string | null };
    expect(before.ingest_status).toBe('error');
    expect(before.error).toContain('fetcher:');

    const applied = await reconcileResolvedReviewStatus(env, { apply: true });
    expect(applied.updated).toBe(1);
    const after = raw.prepare(
      'SELECT ingest_status, error FROM filings WHERE doc_id = ?',
    ).get('S-published') as { ingest_status: string; error: string | null };
    expect(after).toEqual({ ingest_status: 'persisted', error: null });

    const again = await reconcileResolvedReviewStatus(env, { apply: true });
    expect(again.scanned).toBe(0);
    expect(again.updated).toBe(0);
  });

  it('leaves errored filings alone when they are not published', async () => {
    const { raw, env } = makeDb();
    raw.exec(`
      INSERT INTO filings (doc_id, ingest_status, error) VALUES
        ('S-no-tx', 'error', 'fetcher: HTTP 403'),
        ('S-no-decision', 'error', 'fetcher: HTTP 403'),
        ('S-deprecated', 'error', 'fetcher: HTTP 403'),
        ('S-rejected-later', 'error', 'fetcher: HTTP 403'),
        ('provider-missing-live', 'error', 'fetcher: HTTP 403');
      INSERT INTO ingestion_decisions (id, doc_id, action, created_at) VALUES
        ('d-no-tx', 'S-no-tx', 'auto_published', '2026-08-01T00:00:00.000Z'),
        ('d-dep', 'S-deprecated', 'auto_published', '2026-08-01T00:00:00.000Z'),
        ('d-rej-old', 'S-rejected-later', 'auto_published', '2026-08-01T00:00:00.000Z'),
        ('d-rej-new', 'S-rejected-later', 'rejected', '2026-08-02T00:00:00.000Z'),
        ('d-prov', 'provider-missing-live', 'auto_published', '2026-08-01T00:00:00.000Z');
      INSERT INTO transactions (id, doc_id, deprecated_at) VALUES
        ('tx-nodec', 'S-no-decision', NULL),
        ('tx-dep', 'S-deprecated', '2026-08-03T00:00:00.000Z'),
        ('tx-rej', 'S-rejected-later', NULL),
        ('tx-prov', 'provider-missing-live', NULL);
    `);

    const applied = await reconcileResolvedReviewStatus(env, { apply: true });
    expect(applied.updated).toBe(0);
    expect(applied.scanned).toBe(0);
    const rows = raw.prepare(
      'SELECT doc_id, ingest_status FROM filings ORDER BY doc_id',
    ).all() as Array<{ doc_id: string; ingest_status: string }>;
    expect(rows).toEqual([
      { doc_id: 'S-deprecated', ingest_status: 'error' },
      { doc_id: 'S-no-decision', ingest_status: 'error' },
      { doc_id: 'S-no-tx', ingest_status: 'error' },
      { doc_id: 'S-rejected-later', ingest_status: 'error' },
      { doc_id: 'provider-missing-live', ingest_status: 'error' },
    ]);
  });

  it('reconciles an errored published filing that also has a review row', async () => {
    const { raw, env } = makeDb();
    raw.exec(`
      INSERT INTO filings (doc_id, ingest_status, error) VALUES
        ('S-with-queue', 'error', 'fetcher: HTTP 403');
      INSERT INTO review_queue (doc_id, reason, resolved, resolution_kind, resolution_reason)
        VALUES ('S-with-queue', 'low_confidence', 0, NULL, NULL);
      INSERT INTO transactions (id, doc_id, deprecated_at) VALUES
        ('tx-q', 'S-with-queue', NULL);
      INSERT INTO ingestion_decisions (id, doc_id, action, created_at) VALUES
        ('d-q', 'S-with-queue', 'confirmed', '2026-08-01T00:00:00.000Z');
    `);
    const applied = await reconcileResolvedReviewStatus(env, { apply: true });
    expect(applied.updated).toBe(1);
    const row = raw.prepare(
      'SELECT ingest_status FROM filings WHERE doc_id = ?',
    ).get('S-with-queue') as { ingest_status: string };
    expect(row.ingest_status).toBe('persisted');
    const queue = raw.prepare(
      'SELECT resolved FROM review_queue WHERE doc_id = ?',
    ).get('S-with-queue') as { resolved: number };
    expect(queue.resolved).toBe(0);
  });

  it('is a no-op on a second apply', async () => {
    const { raw, env } = makeDb();
    seedFiling(raw, 'H-1', {
      ingestStatus: 'classified',
      resolutionKind: 'rejected',
      resolutionReason: 'rejected: x',
    });
    expect((await reconcileResolvedReviewStatus(env, { apply: true })).updated).toBe(1);
    expect((await reconcileResolvedReviewStatus(env, { apply: true })).updated).toBe(0);
  });
});

describe('deleteManualTestProbe', () => {
  it('refuses when transaction rows exist', async () => {
    const { raw, d1 } = makeDb();
    raw.prepare('INSERT INTO filings (doc_id, ingest_status) VALUES (?, ?)').run(
      MANUAL_TEST_PROBE_DOC_ID,
      'error',
    );
    raw.prepare('INSERT INTO transactions (id, doc_id, deprecated_at) VALUES (?, ?, NULL)').run(
      'tx-probe',
      MANUAL_TEST_PROBE_DOC_ID,
    );
    const result = await deleteManualTestProbe(d1, { apply: true });
    expect(result.deleted).toBe(false);
    expect(result.refusedReason).toMatch(/transaction rows exist/);
    const still = raw.prepare('SELECT COUNT(*) AS n FROM filings WHERE doc_id = ?').get(
      MANUAL_TEST_PROBE_DOC_ID,
    ) as { n: number };
    expect(still.n).toBe(1);
  });

  it('dry-run leaves the sentinel row in place', async () => {
    const { raw, d1 } = makeDb();
    raw.prepare('INSERT INTO filings (doc_id, ingest_status) VALUES (?, ?)').run(
      MANUAL_TEST_PROBE_DOC_ID,
      'error',
    );
    const preview = await deleteManualTestProbe(d1, { apply: false });
    expect(preview.found).toBe(true);
    expect(preview.deleted).toBe(false);
    expect(preview.related.filings).toBe(1);
  });

  it('deletes only the exact sentinel and its bookkeeping rows', async () => {
    const { raw, d1 } = makeDb();
    raw.prepare('INSERT INTO filings (doc_id, ingest_status) VALUES (?, ?)').run(
      MANUAL_TEST_PROBE_DOC_ID,
      'error',
    );
    raw.prepare('INSERT INTO filings (doc_id, ingest_status) VALUES (?, ?)').run(
      'S-2024-real-filing',
      'persisted',
    );
    raw.prepare('INSERT INTO review_queue (doc_id, reason, resolved) VALUES (?, ?, 1)').run(
      MANUAL_TEST_PROBE_DOC_ID,
      'probe',
    );
    raw.prepare('INSERT INTO ingestion_outbox (doc_id) VALUES (?)').run(MANUAL_TEST_PROBE_DOC_ID);
    raw.prepare(
      'INSERT INTO deno_runtime_queue (payload) VALUES (?)',
    ).run(JSON.stringify({ type: 'filing.new', docId: MANUAL_TEST_PROBE_DOC_ID }));
    raw.prepare(
      'INSERT INTO deno_runtime_queue (payload) VALUES (?)',
    ).run(JSON.stringify({ type: 'filing.new', docId: 'S-2024-real-filing' }));

    const result = await deleteManualTestProbe(d1, { apply: true });
    expect(result.deleted).toBe(true);
    expect(result.found).toBe(false);

    const leftover = raw.prepare('SELECT doc_id FROM filings ORDER BY doc_id').all() as Array<{
      doc_id: string;
    }>;
    expect(leftover).toEqual([{ doc_id: 'S-2024-real-filing' }]);
    expect(
      (raw.prepare('SELECT COUNT(*) AS n FROM review_queue').get() as { n: number }).n,
    ).toBe(0);
    expect(
      (raw.prepare('SELECT COUNT(*) AS n FROM deno_runtime_queue').get() as { n: number }).n,
    ).toBe(1);
  });
});

describe('runFilingsHygiene', () => {
  it('combines probe delete and desync reconcile behind apply', async () => {
    const { raw, env } = makeDb();
    raw.prepare('INSERT INTO filings (doc_id, ingest_status) VALUES (?, ?)').run(
      MANUAL_TEST_PROBE_DOC_ID,
      'error',
    );
    seedFiling(raw, 'E-2021-jennifer-granholm-12-16-2021-278t', {
      ingestStatus: 'classified',
      resolutionKind: 'rejected',
      resolutionReason: 'rejected: admin',
    });

    const dry = await runFilingsHygiene(env, { apply: false });
    expect(dry.applied).toBe(false);
    expect(dry.probe.found).toBe(true);
    expect(dry.probe.deleted).toBe(false);
    expect(dry.desync.updated).toBe(0);

    const applied = await runFilingsHygiene(env, { apply: true });
    expect(applied.probe.deleted).toBe(true);
    expect(applied.desync.updated).toBe(1);
    const granholm = raw.prepare('SELECT ingest_status FROM filings WHERE doc_id = ?').get(
      'E-2021-jennifer-granholm-12-16-2021-278t',
    ) as { ingest_status: string };
    expect(granholm.ingest_status).toBe('error');
  });
});
