import { describe, it, expect } from 'vitest';
import { buildAdminRouter } from '../routes.ts';
import { makeReviewQueueTestDb, type ReviewQueueFixtureRow } from './reviewQueueTestDb.ts';

/**
 * Pagination/filter/chunking coverage for GET /api/admin/review-queue
 * (CT-AUD-004 + the panel-verified silent-data-loss bug). Backed by a real
 * in-memory SQLite D1 stand-in (reviewQueueTestDb.ts) rather than a
 * regex-sniffed mock, because these behaviors — keyset ordering, filter
 * predicates, the D1 bound-parameter cap — are genuinely about SQL
 * semantics, not just "does routes.ts call fetch with the right string".
 */

const app = buildAdminRouter();
const AUTH = { Authorization: 'Bearer admin-secret' };

/** Deterministic, strictly increasing (per index) ISO timestamps. */
function tsAt(i: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0) + i * 1000).toISOString();
}

function env(db: ReturnType<typeof makeReviewQueueTestDb>) {
  return { ADMIN_TOKEN: 'admin-secret', DB: db } as never;
}

interface ItemShape {
  docId: string;
  chamber: string;
  reason: string;
  models: Array<{ provider: string; model: string; ok: boolean; rowCount: number }>;
}

interface ReviewQueueResponse {
  items: ItemShape[];
  count: number;
  resolved: boolean;
  nextCursor: string | null;
  totals: {
    unresolved: number;
    matching: number;
    byReason: Record<string, number>;
    byChamber: Record<string, number>;
  };
  truncated?: boolean;
  error?: string;
}

async function fetchQueue(db: ReturnType<typeof makeReviewQueueTestDb>, query: string) {
  const res = await app.request(`/review-queue${query}`, { headers: AUTH }, env(db));
  const body = (await res.json()) as ReviewQueueResponse;
  return { status: res.status, body };
}

describe('GET /review-queue pagination', () => {
  it('paginates deterministically across pages, newest-first, tie-broken by doc_id', async () => {
    const rows: ReviewQueueFixtureRow[] = [];
    for (let i = 0; i < 10; i++) {
      rows.push({ docId: `D${String(i).padStart(2, '0')}`, createdAt: tsAt(i) });
    }
    // Two rows sharing the exact same created_at exercise the doc_id tiebreak.
    rows.push({ docId: 'D-TIE-A', createdAt: tsAt(10) });
    rows.push({ docId: 'D-TIE-B', createdAt: tsAt(10) });
    const db = makeReviewQueueTestDb(rows);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pageCount = 0;
    for (;;) {
      const query = `?limit=4${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const { status, body } = await fetchQueue(db, query);
      expect(status).toBe(200);
      expect(body.items.length).toBeLessThanOrEqual(4);
      for (const item of body.items) seen.push(item.docId);
      cursor = body.nextCursor;
      pageCount += 1;
      expect(pageCount).toBeLessThan(10); // guards against an infinite loop if a bug breaks termination
      if (!cursor) break;
    }

    // Newest-first: the created_at-tied pair breaks by doc_id DESC (B before A),
    // then D09..D00 descending. No gaps, no duplicates across page boundaries.
    expect(seen).toEqual([
      'D-TIE-B', 'D-TIE-A', 'D09', 'D08', 'D07', 'D06', 'D05', 'D04', 'D03', 'D02', 'D01', 'D00',
    ]);
    expect(new Set(seen).size).toBe(seen.length);
    expect(pageCount).toBe(3); // 12 rows / limit=4 => 3 full pages
  });

  it('rejects a malformed cursor with 400 instead of silently mis-paginating', async () => {
    const db = makeReviewQueueTestDb([{ docId: 'X', createdAt: tsAt(1) }]);
    const { status, body } = await fetchQueue(db, '?cursor=not-a-valid-cursor%20%25%25');
    expect(status).toBe(400);
    expect(body.error).toBeTruthy();
  });

  describe('filters', () => {
    it('defaults to the unresolved (pending) queue and supports resolved=1 for history', async () => {
      const db = makeReviewQueueTestDb([
        { docId: 'P1', createdAt: tsAt(1), resolved: 0 },
        { docId: 'P2', createdAt: tsAt(2), resolved: 0 },
        { docId: 'R1', createdAt: tsAt(3), resolved: 1 },
      ]);

      const pending = await fetchQueue(db, '?limit=50');
      expect(pending.body.resolved).toBe(false);
      expect(pending.body.items.map((i) => i.docId).sort()).toEqual(['P1', 'P2']);

      const resolved = await fetchQueue(db, '?limit=50&resolved=1');
      expect(resolved.body.resolved).toBe(true);
      expect(resolved.body.items.map((i) => i.docId)).toEqual(['R1']);
    });

    it('filters by chamber (exact match against filings.chamber)', async () => {
      const db = makeReviewQueueTestDb([
        { docId: 'H1', createdAt: tsAt(1), chamber: 'house' },
        { docId: 'S1', createdAt: tsAt(2), chamber: 'senate' },
        { docId: 'H2', createdAt: tsAt(3), chamber: 'house' },
      ]);
      const { body } = await fetchQueue(db, '?limit=50&chamber=house');
      expect(body.items.map((i) => i.docId).sort()).toEqual(['H1', 'H2']);
      expect(body.items.every((i) => i.chamber === 'house')).toBe(true);
    });

    it('filters by reason via prefix match on the comma-joined reason string', async () => {
      const db = makeReviewQueueTestDb([
        { docId: 'A', createdAt: tsAt(1), reason: 'low_confidence,unresolved_ticker' },
        { docId: 'B', createdAt: tsAt(2), reason: 'no_transactions_extracted' },
        { docId: 'C', createdAt: tsAt(3), reason: 'low_confidence' },
      ]);
      const { body } = await fetchQueue(db, '?limit=50&reason=low_confidence');
      expect(body.items.map((i) => i.docId).sort()).toEqual(['A', 'C']);
    });

    it('combines chamber + reason + resolved filters', async () => {
      const db = makeReviewQueueTestDb([
        { docId: 'M1', createdAt: tsAt(1), chamber: 'house', reason: 'low_confidence', resolved: 0 },
        { docId: 'M2', createdAt: tsAt(2), chamber: 'senate', reason: 'low_confidence', resolved: 0 },
        { docId: 'M3', createdAt: tsAt(3), chamber: 'house', reason: 'no_transactions_extracted', resolved: 0 },
        { docId: 'M4', createdAt: tsAt(4), chamber: 'house', reason: 'low_confidence', resolved: 1 },
      ]);
      const { body } = await fetchQueue(db, '?limit=50&chamber=house&reason=low_confidence');
      expect(body.items.map((i) => i.docId)).toEqual(['M1']);
    });
  });

  it('attaches per-model detail for every doc across 150 pending docs via chunked IN queries (fixes the silent drop)', async () => {
    const rows: ReviewQueueFixtureRow[] = [];
    for (let i = 0; i < 150; i++) {
      rows.push({
        docId: `CHK${String(i).padStart(4, '0')}`,
        createdAt: tsAt(i),
        models: [{ provider: 'anthropic', model: 'claude-sonnet-5', ok: true, rowCount: 2, avgConfidence: 0.87 }],
      });
    }
    const db = makeReviewQueueTestDb(rows);

    // Legacy (no limit/cursor) call: a single page holds all 150 rows, and the
    // per-model lookup must chunk that page's doc_ids across multiple IN (...)
    // queries (REVIEW_QUEUE_IN_CHUNK=90) to stay under D1's ~100 bound-param
    // cap. Pre-fix, one unchunked IN (...) over 150 ids threw at bind() and
    // was swallowed by a catch-all, silently degrading every row's `models` to
    // `[]`.
    const { status, body } = await fetchQueue(db, '');
    expect(status).toBe(200);
    expect(body.items).toHaveLength(150);
    expect(body.truncated).toBe(false); // 150 <= REVIEW_QUEUE_MAX_LIMIT (200)
    for (const item of body.items) {
      expect(item.models).toHaveLength(1);
      expect(item.models[0]).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5', ok: true, rowCount: 2 });
    }
  });

  it('reports accurate totals from cheap aggregates, independent of the current page', async () => {
    const db = makeReviewQueueTestDb([
      { docId: 'U1', createdAt: tsAt(1), resolved: 0, chamber: 'house', reason: 'low_confidence' },
      { docId: 'U2', createdAt: tsAt(2), resolved: 0, chamber: 'senate', reason: 'low_confidence' },
      { docId: 'U3', createdAt: tsAt(3), resolved: 0, chamber: 'house', reason: 'no_transactions_extracted' },
      { docId: 'R1', createdAt: tsAt(4), resolved: 1, chamber: 'house', reason: 'low_confidence' },
    ]);

    // Page size of 1 so `totals` can only be right if it comes from the
    // aggregate queries, not from items.length.
    const { body } = await fetchQueue(db, '?limit=1');
    expect(body.items).toHaveLength(1);
    expect(body.totals.unresolved).toBe(3); // global pending backlog, independent of the page
    expect(body.totals.matching).toBe(3); // resolved=0 (default), no chamber/reason filter
    expect(body.totals.byReason).toEqual({ low_confidence: 2, no_transactions_extracted: 1 });
    expect(body.totals.byChamber).toEqual({ house: 2, senate: 1 });

    const chamberFiltered = await fetchQueue(db, '?limit=1&chamber=house');
    expect(chamberFiltered.body.totals.matching).toBe(2); // U1, U3 — respects the chamber filter
    expect(chamberFiltered.body.totals.unresolved).toBe(3); // backlog gauge stays global
  });

  describe('back-compat (no limit/cursor supplied)', () => {
    it('caps at 200 rows and flags truncated:true once the queue exceeds the cap', async () => {
      const rows: ReviewQueueFixtureRow[] = [];
      for (let i = 0; i < 250; i++) rows.push({ docId: `L${String(i).padStart(4, '0')}`, createdAt: tsAt(i) });
      const db = makeReviewQueueTestDb(rows);

      const { status, body } = await fetchQueue(db, '');
      expect(status).toBe(200);
      expect(body.items).toHaveLength(200);
      expect(body.truncated).toBe(true);
      expect(body.nextCursor).not.toBeNull();
    });

    it('returns everything untruncated when the queue is smaller than the cap', async () => {
      const db = makeReviewQueueTestDb([
        { docId: 'S1', createdAt: tsAt(1) },
        { docId: 'S2', createdAt: tsAt(2) },
      ]);
      const { body } = await fetchQueue(db, '');
      expect(body.items).toHaveLength(2);
      expect(body.truncated).toBe(false);
      expect(body.nextCursor).toBeNull();
    });
  });

  it('keeps a 50-row page under a 500KB response-size budget with realistically padded payloads', async () => {
    // ~7.5KB/row payload, in line with the ~8.6KB/row average implied by the
    // pre-fix unbounded response (4.8MB / 573 rows).
    const pad = 'x'.repeat(7500);
    const rows: ReviewQueueFixtureRow[] = [];
    for (let i = 0; i < 120; i++) {
      rows.push({
        docId: `SZ${String(i).padStart(4, '0')}`,
        createdAt: tsAt(i),
        payload: JSON.stringify({
          minConfidence: 0.4,
          transactions: [{ ticker: 'AAPL', assetName: 'Apple Inc.', txType: 'B', rawText: pad }],
        }),
        models: [{ provider: 'anthropic', model: 'claude-sonnet-5', ok: true, rowCount: 1, avgConfidence: 0.75 }],
      });
    }
    const db = makeReviewQueueTestDb(rows);

    const res = await app.request('/review-queue?limit=50', { headers: AUTH }, env(db));
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as ReviewQueueResponse;
    expect(body.items).toHaveLength(50);

    const byteSize = new TextEncoder().encode(text).length;
    expect(byteSize).toBeLessThan(500 * 1024);
  });

  it('keeps OpenRouter extraction_runs model as the slug, not a copy of the provider', async () => {
    const db = makeReviewQueueTestDb([
      {
        docId: 'OR-1',
        createdAt: tsAt(1),
        models: [
          { provider: 'openrouter', model: 'google/gemini-2.5-pro', ok: true, rowCount: 2, avgConfidence: 0.88, createdAt: tsAt(2) },
          { provider: 'openrouter', model: 'anthropic/claude-sonnet-4', ok: true, rowCount: 1, avgConfidence: 0.81, createdAt: tsAt(1) },
        ],
      },
    ]);
    const { status, body } = await fetchQueue(db, '?limit=10');
    expect(status).toBe(200);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].models).toEqual([
      expect.objectContaining({ provider: 'openrouter', model: 'google/gemini-2.5-pro', ok: true, rowCount: 2 }),
      expect.objectContaining({ provider: 'openrouter', model: 'anthropic/claude-sonnet-4', ok: true, rowCount: 1 }),
    ]);
    expect(body.items[0].models.every((m) => m.model !== 'openrouter')).toBe(true);
  });
});
