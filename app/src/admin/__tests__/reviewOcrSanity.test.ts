import { describe, expect, it } from 'vitest';

import { buildAdminRouter } from '../routes.ts';

/**
 * CT-2441: POST /review/:docId enforces the shared OCR contract on
 * confirm/manual edits.  Unfixable garble is a 400 naming the row; confident
 * fixes save the normalized value with a cleaning_note audit fragment.
 */

const app = buildAdminRouter();
const AUTH = { Authorization: 'Bearer admin-secret', 'content-type': 'application/json' };

const BASE_EDIT = {
  ticker: null,
  assetName: 'Apple Inc.',
  txType: 'B',
  txDate: '2026-08-04',
  owner: null,
};

function fakeDb(captured: { binds: unknown[][] }) {
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          if (/INSERT OR IGNORE INTO transactions/i.test(sql)) captured.binds.push(args);
          return this;
        },
        async all<T>() {
          return { results: [] as T[] };
        },
        async first<T>() {
          if (/FROM review_queue WHERE doc_id/i.test(sql)) {
            return {
              doc_id: 'E-2026-test-09-17-2026-278t',
              reason: 'low_confidence',
              payload: null,
              created_at: '2026-10-08T09:13:00.001Z',
              resolved: 0,
              review_revision: 1,
            } as T;
          }
          if (/FROM filings WHERE doc_id/i.test(sql)) {
            return {
              filer_id: 'EXEC-DJT',
              first_seen_at: '2026-10-08T09:13:00.001Z',
              filed_date: '2026-09-17',
              filing_status: null,
            } as T;
          }
          return null as T | null;
        },
        async run() {
          return { success: true, meta: { changes: 1 } };
        },
      };
    },
  } as unknown as D1Database;
  return db;
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
    '/review/E-2026-test-09-17-2026-278t',
    { method: 'POST', headers: AUTH, body: JSON.stringify(body) },
    env(db),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('POST /review/:docId — OCR sanity', () => {
  it('rejects an unreadable asset name with the row index and reason', async () => {
    const captured = { binds: [] as unknown[][] };
    const { status, body } = await postReview(fakeDb(captured), {
      decision: 'manual',
      reviewRevision: 1,
      edits: [{ ...BASE_EDIT, assetName: 'Legal200m Com Inc.' }],
    });
    expect(status).toBe(400);
    expect(String(body.error)).toContain('edits[0].assetName');
    expect(String(body.error)).toContain('unreadable OCR');
    expect(captured.binds).toHaveLength(0);
  });

  it('rejects an impossible embedded date in the asset name', async () => {
    const captured = { binds: [] as unknown[][] };
    const { status, body } = await postReview(fakeDb(captured), {
      decision: 'manual',
      reviewRevision: 1,
      edits: [{ ...BASE_EDIT, assetName: 'Bond Due 02/30/2026' }],
    });
    expect(status).toBe(400);
    expect(String(body.error)).toContain('edits[0].assetName');
    expect(captured.binds).toHaveLength(0);
  });

  it('rejects impossible, future, and out-of-range trade dates', async () => {
    for (const txDate of ['2026-02-30', '2026-13-01', '2099-01-01', '2020-01-01']) {
      const captured = { binds: [] as unknown[][] };
      const { status, body } = await postReview(fakeDb(captured), {
        decision: 'manual',
        reviewRevision: 1,
        edits: [{ ...BASE_EDIT, txDate }],
      });
      expect(status).toBe(400);
      expect(String(body.error)).toContain('edits[0].txDate');
      expect(captured.binds).toHaveLength(0);
    }
  });

  it('saves the normalized name plus a cleaning note for confident fixes', async () => {
    const captured = { binds: [] as unknown[][] };
    const { status, body } = await postReview(fakeDb(captured), {
      decision: 'manual',
      reviewRevision: 1,
      edits: [{ ...BASE_EDIT, assetName: 'Uber Technolo1des Inc.' }],
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({ decision: 'manual', resolved: true });
    expect(captured.binds).toHaveLength(1);
    const rows = JSON.parse(String(captured.binds[0][0])) as Array<{
      assetName: string;
      cleaningNote: string | null;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].assetName).toBe('Uber Technologies Inc.');
    expect(rows[0].cleaningNote).toContain('normalized OCR artifacts');
  });

  it('accepts after-filed trades per the tested soft rule', async () => {
    const captured = { binds: [] as unknown[][] };
    const { status } = await postReview(fakeDb(captured), {
      decision: 'manual',
      reviewRevision: 1,
      edits: [{ ...BASE_EDIT, txDate: '2026-09-20' }],
    });
    expect(status).toBe(200);
    expect(captured.binds).toHaveLength(1);
  });

  it('leaves clean edits untouched with no audit note', async () => {
    const captured = { binds: [] as unknown[][] };
    const { status } = await postReview(fakeDb(captured), {
      decision: 'manual',
      reviewRevision: 1,
      edits: [{ ...BASE_EDIT }],
    });
    expect(status).toBe(200);
    const rows = JSON.parse(String(captured.binds[0][0])) as Array<{
      assetName: string;
      cleaningNote: string | null;
    }>;
    expect(rows[0].assetName).toBe('Apple Inc.');
    expect(rows[0].cleaningNote).toBeNull();
  });
});
