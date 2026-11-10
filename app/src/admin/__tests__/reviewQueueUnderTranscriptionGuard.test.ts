import { describe, it, expect } from 'vitest';
import { buildAdminRouter, ReviewEditItemSchema } from '../routes.ts';

/**
 * N-of-M / page-count under-transcription guard for POST /review/:docId.
 *
 * Audit 2026-08-31 (board 3a1622e2) flagged that confirm/manual accepted
 * whatever rows an admin submitted with no cross-check against the stored
 * extraction's own completeness signal — Kupor
 * (E-2026-scott-a-kupor-01-09-2026-278t) got manually confirmed with 1 of 3
 * real transactions because nothing compared the confirm to the extraction's
 * `transactionCount`/`transactions`/`truncated` payload fields.
 *
 * These tests exercise the guard added just before the persist batch: it
 * blocks (409) when `storedReviewTransactionCount(review.payload)` exceeds
 * the number of edits the admin is submitting, unless the caller explicitly
 * sets `acknowledgeUnderTranscription: true`.
 */

const app = buildAdminRouter();
const AUTH = { Authorization: 'Bearer admin-secret', 'content-type': 'application/json' };

const VALID_EDIT = {
  ticker: 'AAPL',
  assetName: 'Apple Inc.',
  txType: 'B',
  txDate: '2026-01-09',
  owner: null,
};

function fakeDb(reviewPayload: string | null) {
  const runSql: string[] = [];
  const firstSql: string[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind() {
          return this;
        },
        async all<T>() {
          return { results: [] as T[] };
        },
        async first<T>() {
          firstSql.push(sql);
          if (/FROM review_queue WHERE doc_id/i.test(sql)) {
            return {
              doc_id: 'H-1',
              reason: 'low_confidence',
              payload: reviewPayload,
              created_at: '2026-01-09T00:00:00.000Z',
              resolved: 0,
              review_revision: 1,
            } as T;
          }
          if (/FROM filings WHERE doc_id/i.test(sql)) {
            return {
              filer_id: 'P000001',
              first_seen_at: null,
              filed_date: '2026-01-09',
              filing_status: null,
            } as T;
          }
          return null as T | null;
        },
        async run() {
          runSql.push(sql);
          return { success: true, meta: { changes: 1 } };
        },
      };
    },
  } as unknown as D1Database;
  return { db, runSql, firstSql };
}

function env(db: D1Database) {
  return {
    ADMIN_TOKEN: 'admin-secret',
    DB: db,
    DELIVERY_QUEUE: { send: async () => {}, sendBatch: async () => {} },
  } as never;
}

async function postReview(db: D1Database, body: Record<string, unknown>) {
  const res = await app.request(
    '/review/H-1',
    { method: 'POST', headers: AUTH, body: JSON.stringify(body) },
    env(db),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('POST /review/:docId — under-transcription guard', () => {
  it('blocks confirm with fewer edits than a truncated extraction claimed, and writes nothing', async () => {
    const { db, runSql } = fakeDb(
      JSON.stringify({ truncated: true, transactionCount: 999, transactions: [{}, {}, {}] }),
    );

    const { status, body } = await postReview(db, {
      decision: 'confirm',
      reviewRevision: 1,
      edits: [VALID_EDIT],
    });

    expect(status).toBe(409);
    expect(String(body.error)).toContain('fewer transactions (1) than the stored extraction found (3)');
    expect(String(body.error)).toContain('acknowledgeUnderTranscription');
    // The guard fires before any write — no transactions inserted, no
    // review_queue row touched.
    expect(runSql).toHaveLength(0);
  });

  it('allows the same confirm through when acknowledgeUnderTranscription is explicitly true', async () => {
    const { db, runSql } = fakeDb(
      JSON.stringify({ truncated: true, transactionCount: 999, transactions: [{}, {}, {}] }),
    );

    const { status, body } = await postReview(db, {
      decision: 'confirm',
      reviewRevision: 1,
      edits: [VALID_EDIT],
      acknowledgeUnderTranscription: true,
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({ decision: 'confirm', resolved: true });
    expect(runSql.some((sql) => /INSERT OR IGNORE INTO transactions/i.test(sql))).toBe(true);
    expect(runSql.some((sql) => /UPDATE review_queue[\s\S]*SET resolved = 1/i.test(sql))).toBe(true);
  });

  it('does not block the common case: stored count equals submitted edits', async () => {
    const { db } = fakeDb(JSON.stringify({ transactions: [{}], transactionCount: 1 }));

    const { status, body } = await postReview(db, {
      decision: 'confirm',
      reviewRevision: 1,
      edits: [VALID_EDIT],
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({ decision: 'confirm', resolved: true });
  });

  it('never blocks when the review item has no stored payload to compare against', async () => {
    const { db } = fakeDb(null);

    const { status, body } = await postReview(db, {
      decision: 'manual',
      reviewRevision: 1,
      edits: [VALID_EDIT],
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({ decision: 'manual', source: 'manual', resolved: true });
  });
});


describe('POST /review/:docId type diagnostics', () => {
  it('distinguishes an invalid row field from missing edits', async () => {
    const { db, runSql } = fakeDb(null);
    const result = await postReview(db, { decision: 'confirm', reviewRevision: 1, edits: [{ ...VALID_EDIT, txType: 42 }] });
    expect(result.status).toBe(400);
    expect(String(result.body.error)).toContain('wrong field types');
    expect(result.body.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: [0, 'txType'] })]));
    expect(runSql).toHaveLength(0);
  });
  it('keeps the domain nudge for absent edits', async () => {
    const { db } = fakeDb(null);
    const result = await postReview(db, { decision: 'confirm', reviewRevision: 1 });
    expect(result.status).toBe(400);
    expect(String(result.body.error)).toContain('requires explicit transaction edits');
    expect(result.body.issues).toBeUndefined();
  });
  it('strips undeclared keys at the boundary instead of forwarding them', () => {
    const parsed = ReviewEditItemSchema.parse({ ...VALID_EDIT, flags: ['bad_tx_type'], injected: 'x' });
    expect(parsed).toEqual(VALID_EDIT);
    expect(Object.keys(parsed)).not.toContain('injected');
    expect(Object.keys(parsed)).not.toContain('flags');
  });
  it('accepts confidence: null from a console row with no stored confidence', async () => {
    const { db, runSql } = fakeDb(null);
    const result = await postReview(db, { decision: 'confirm', reviewRevision: 1, edits: [{ ...VALID_EDIT, confidence: null }] });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ decision: 'confirm', resolved: true });
    expect(runSql.some((sql) => /INSERT OR IGNORE INTO transactions/i.test(sql))).toBe(true);
  });
});
