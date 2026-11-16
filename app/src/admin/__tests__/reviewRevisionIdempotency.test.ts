/**
 * CT-2510 — identical admin republish must not bump review_revision; real edits and
 * pipeline duplicates record audit entries.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { buildAdminRouter } from '../routes.ts';
import { proposedMatchesLivePipeline } from '../publishContentHash.ts';
import { openMigratedD1 } from '../../prices/__tests__/sqliteD1.ts';
import type { Transaction } from '../../shared/types.ts';

const app = buildAdminRouter();
const AUTH = { Authorization: 'Bearer admin-secret', 'content-type': 'application/json' };
const DOC = 'H-2026-20035788';
const DEPRECATED_AT = '2026-10-25T20:00:00.000Z';

const EDITS = [
  {
    assetName: 'PLEXUS CORP',
    ticker: null,
    txType: 'S',
    txDate: '2026-07-29',
    owner: null,
    amountMin: 15001,
    amountMax: 50000,
    rawText: '#518 PLEXUS CORP sale 7/29/2026 No $15,001 - $50,000',
  },
  {
    assetName: 'BADGER METER INC',
    ticker: null,
    txType: 'S',
    txDate: '2026-07-29',
    owner: null,
    amountMin: 50001,
    amountMax: 100000,
    rawText: '#661 BADGER METER INC sale 7/29/2026 No $50,001 - $100,000',
  },
] as const;

let closeDb: (() => void) | null = null;
afterEach(() => {
  closeDb?.();
  closeDb = null;
});

async function seededPendingRepublish(revision = 3) {
  const { db, d1, close } = await openMigratedD1();
  closeDb = close;
  db.prepare(
    `INSERT INTO filings (doc_id, chamber, filer_id, filing_type, filed_date, ingest_status, first_seen_at)
     VALUES (?, 'house', 'H-CISNEROS', 'P', '2026-09-08', 'needs_review', '2026-09-22T12:14:00.001Z')`,
  ).run(DOC);
  db.prepare(
    `INSERT INTO review_queue (doc_id, reason, payload, created_at, resolved, review_revision)
     VALUES (?, 'unpublished: correction', NULL, '2026-10-25T20:00:00.000Z', 0, ?)`,
  ).run(DOC, revision);
  const insert = db.prepare(
    `INSERT INTO transactions (id, doc_id, filer_id, tx_date, owner, asset_name, ticker, tx_type,
       amount_min, amount_max, is_option, cap_gains_over_200, raw_text, confidence, source, row_key,
       created_at, deprecated_at, deprecated_reason)
     VALUES (?, ?, 'H-CISNEROS', ?, NULL, ?, NULL, ?, ?, ?, 0, 0, '', 1, 'manual', ?, ?, ?, 'unpublished: correction')`,
  );
  insert.run('tx-plexus', DOC, '2026-07-29', 'Plexus Corp.', 'S', 15001, 50000, 'v1:manual:0:plex', '2026-09-25T02:37:34.062Z', DEPRECATED_AT);
  insert.run('tx-badger', DOC, '2026-07-29', 'Badger Meter Inc.', 'S', 50001, 100000, 'v1:manual:1:badger', '2026-09-25T02:37:34.062Z', DEPRECATED_AT);
  return {
    db,
    d1,
    revision: () => Number(db.prepare('SELECT review_revision AS r FROM review_queue WHERE doc_id = ?').get(DOC)!.r),
  };
}

function env(d1: unknown) {
  return {
    ADMIN_TOKEN: 'admin-secret',
    DB: d1,
    DELIVERY_QUEUE: { send: async () => {}, sendBatch: async () => {} },
  } as never;
}

function auditRows(db: Awaited<ReturnType<typeof openMigratedD1>>['db'], docId: string) {
  return db.prepare(
    'SELECT revision, trigger, content_hash FROM review_revision_audit WHERE doc_id = ? ORDER BY created_at ASC',
  ).all(docId) as Array<{ revision: number; trigger: string; content_hash: string | null }>;
}

describe('review_revision idempotency (CT-2510)', () => {
  it('deprecated-only identical republication records a single audit row', async () => {
    const { db, d1, revision } = await seededPendingRepublish(5);
    const res = await app.request(`/review/${DOC}`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ decision: 'manual', reviewRevision: 5, edits: EDITS }),
    }, env(d1));
    expect(res.status).toBe(200);
    expect(revision()).toBe(5);
    const audits = auditRows(db, DOC);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.trigger).toBe('admin_manual_identical_noop');
  });

  it('repeated identical admin_manual publish is a no-op and does not bump review_revision', async () => {
    const { db, d1, revision } = await seededPendingRepublish(3);
    const first = await app.request(`/review/${DOC}`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ decision: 'manual', reviewRevision: 3, edits: EDITS }),
    }, env(d1));
    expect(first.status).toBe(200);
    const firstBody = await first.json() as Record<string, unknown>;
    expect(firstBody.noop).toBe(true);
    expect(firstBody.identical).toBe(true);
    expect(revision()).toBe(3);
    const second = await app.request(`/review/${DOC}`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ decision: 'manual', reviewRevision: 3, edits: EDITS }),
    }, env(d1));
    expect(second.status).toBe(409);
    const audits = auditRows(db, DOC);
    expect(audits.some((row) => row.trigger === 'admin_manual_identical_noop')).toBe(true);
    expect(audits.find((row) => row.trigger === 'admin_manual_identical_noop')?.revision).toBe(3);
  });

  it('a real material edit bumps review_revision and records admin_manual in the audit log', async () => {
    const { db, d1, revision } = await seededPendingRepublish(4);
    const changed = [EDITS[0], { ...EDITS[1], txDate: '2026-07-30' }];
    const res = await app.request(`/review/${DOC}`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ decision: 'manual', reviewRevision: 4, edits: changed }),
    }, env(d1));
    expect(res.status).toBe(200);
    expect(revision()).toBe(5);
    const audits = auditRows(db, DOC);
    const publishAudit = audits.find((row) => row.trigger === 'admin_manual');
    expect(publishAudit).toBeDefined();
    expect(publishAudit?.revision).toBe(5);
    expect(publishAudit?.content_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('pipeline replay with identical normalized rows is a content-hash no-op (outbox replay)', async () => {
    const { db, d1, close } = await openMigratedD1();
    closeDb = close;
    db.prepare(
      `INSERT INTO filings (doc_id, chamber, filer_id, filing_type, filed_date, ingest_status, first_seen_at)
       VALUES (?, 'house', 'H-CISNEROS', 'P', '2026-02-01', 'persisted', '2026-02-01T12:00:00.000Z')`,
    ).run(DOC);
    const insert = db.prepare(
      `INSERT INTO transactions (id, doc_id, filer_id, tx_date, owner, asset_name, ticker, tx_type,
         amount_min, amount_max, is_option, cap_gains_over_200, raw_text, confidence, source, row_key, created_at)
       VALUES (?, ?, 'H-CISNEROS', ?, NULL, ?, NULL, ?, ?, ?, 0, 0, '', 1, 'manual', ?, '2026-02-01T12:00:00.000Z')`,
    );
    insert.run('tx-plexus', DOC, '2026-07-29', 'Plexus Corp.', 'S', 15001, 50000, 'v1:manual:0:plex');
    insert.run('tx-badger', DOC, '2026-07-29', 'Badger Meter Inc.', 'S', 50001, 100000, 'v1:manual:1:badger');
    const txs: Transaction[] = [
      {
        id: 'tx-plexus',
        docId: DOC,
        filerId: 'H-CISNEROS',
        txDate: '2026-07-29',
        owner: null,
        assetName: 'Plexus Corp.',
        ticker: null,
        assetType: null,
        txType: 'S',
        amountMin: 15001,
        amountMax: 50000,
        isOption: false,
        capGainsOver200: false,
        rawText: '',
        assetTypeName: null,
        filingStatus: null,
        subholding: null,
        location: null,
        description: null,
        supplementalText: null,
        rowKey: 'v1:manual:0:plex',
        confidence: 1,
        source: 'manual',
        createdAt: '2026-02-01T12:00:00.000Z',
        firstSeenAt: null,
        filedDate: null,
        estValue: null,
        disclosureLagDays: null,
        stockActStatus: null,
        cleaningNote: null,
      },
      {
        id: 'tx-badger',
        docId: DOC,
        filerId: 'H-CISNEROS',
        txDate: '2026-07-29',
        owner: null,
        assetName: 'Badger Meter Inc.',
        ticker: null,
        assetType: null,
        txType: 'S',
        amountMin: 50001,
        amountMax: 100000,
        isOption: false,
        capGainsOver200: false,
        rawText: '',
        assetTypeName: null,
        filingStatus: null,
        subholding: null,
        location: null,
        description: null,
        supplementalText: null,
        rowKey: 'v1:manual:1:badger',
        confidence: 1,
        source: 'manual',
        createdAt: '2026-02-01T12:00:00.000Z',
        firstSeenAt: null,
        filedDate: null,
        estValue: null,
        disclosureLagDays: null,
        stockActStatus: null,
        cleaningNote: null,
      },
    ];
    const match = await proposedMatchesLivePipeline(d1 as never, DOC, txs);
    expect(match.identical).toBe(true);
    db.prepare(
      `INSERT INTO review_revision_audit (id, doc_id, revision, trigger, content_hash, detail, created_at)
       VALUES ('audit-1', ?, 1, 'pipeline_publish_identical_noop', ?, NULL, '2026-02-01T12:01:00.000Z')`,
    ).run(DOC, match.contentHash);
    const audit = db.prepare('SELECT trigger FROM review_revision_audit WHERE doc_id = ?').get(DOC) as { trigger: string };
    expect(audit.trigger).toBe('pipeline_publish_identical_noop');
  });
});
