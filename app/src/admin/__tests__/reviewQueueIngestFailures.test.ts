import { describe, it, expect } from 'vitest';
import { buildAdminRouter } from '../routes.ts';
import { makeReviewQueueTestDb, type ReviewQueueFixtureRow } from './reviewQueueTestDb.ts';

/**
 * Ingest-failure visibility for the admin review queue: filings stuck at
 * ingest_status='error' with no open review_queue row never appear in
 * GET /review-queue, so the queue reads "0" while filings are stuck.
 * CT-2453 published rows (error stamp but live transactions) must NOT be
 * listed as needing review; they are counted separately as stale stamps.
 */

const app = buildAdminRouter();
const AUTH = { Authorization: 'Bearer admin-secret' };

function tsAt(i: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0) + i * 60_000).toISOString();
}

function env(db: ReturnType<typeof makeReviewQueueTestDb>) {
  return { ADMIN_TOKEN: 'admin-secret', DB: db } as never;
}

interface IngestItem {
  kind: string;
  docId: string;
  chamber: string;
  filerId: string | null;
  filerName: string | null;
  filedDate: string | null;
  ingestStatus: string;
  error: string | null;
  errorTruncated: boolean;
  firstSeenAt: string | null;
  lastAttemptAt: string | null;
}

/** One of each disposition an ingest_status='error' filing can sit in. */
function mixedFixture(): ReviewQueueFixtureRow[] {
  const longError = `fetch failed: ${'x'.repeat(400)}`;
  return [
    {
      docId: 'S-FAIL-1', createdAt: tsAt(10), noReview: true, chamber: 'senate',
      ingestStatus: 'error', error: longError, filerId: 'S000001',
      filerName: 'Jane Senator', filedDate: '2026-01-02',
      firstSeenAt: tsAt(10), outboxUpdatedAt: tsAt(12),
    },
    {
      docId: 'H-FAIL-2', createdAt: tsAt(9), noReview: true, chamber: 'house',
      ingestStatus: 'error', error: 'classifier exploded',
      firstSeenAt: tsAt(9), deprecatedTransactions: 2,
    },
    {
      // CT-2453: data published, only the status stamp is wrong.
      docId: 'S-PUB-STALE', createdAt: tsAt(8), noReview: true, chamber: 'senate',
      ingestStatus: 'error', error: 'late fetch blip', firstSeenAt: tsAt(8),
      liveTransactions: 3,
    },
    {
      // Already visible in the pending queue — must not double-list.
      docId: 'H-QUEUED', createdAt: tsAt(7), resolved: 0, chamber: 'house',
      ingestStatus: 'error', error: 'boom', firstSeenAt: tsAt(7),
    },
    {
      // Honest human rejection — terminal, already visible in history.
      docId: 'H-REJECTED', createdAt: tsAt(6), resolved: 1, chamber: 'house',
      ingestStatus: 'error', resolutionKind: 'rejected',
      resolutionReason: 'rejected: bad extraction', firstSeenAt: tsAt(6),
    },
    {
      docId: 'H-PERSISTED', createdAt: tsAt(5), noReview: true, chamber: 'house',
      ingestStatus: 'persisted', firstSeenAt: tsAt(5), liveTransactions: 1,
    },
    {
      docId: 'H-NEEDS', createdAt: tsAt(4), noReview: true, chamber: 'house',
      ingestStatus: 'needs_review', firstSeenAt: tsAt(4),
    },
    {
      // Ordinary pending review item (queue is otherwise non-empty).
      docId: 'H-PENDING', createdAt: tsAt(3), resolved: 0, chamber: 'house',
      ingestStatus: 'needs_review', firstSeenAt: tsAt(3),
    },
  ];
}

async function fetchIngest(db: ReturnType<typeof makeReviewQueueTestDb>, query: string) {
  const res = await app.request(`/review-queue/ingest-failures${query}`, { headers: AUTH }, env(db));
  const body = (await res.json()) as {
    items: IngestItem[];
    count: number;
    nextCursor: string | null;
    totals: { ingestFailures: number; publishedStatusStale: number };
    error?: string;
  };
  return { status: res.status, body };
}

describe('GET /review-queue/ingest-failures', () => {
  it('lists only stuck error filings (no open queue row, no live rows)', async () => {
    const db = makeReviewQueueTestDb(mixedFixture());
    const { status, body } = await fetchIngest(db, '?limit=50');
    expect(status).toBe(200);
    expect(body.items.map((i) => i.docId).sort()).toEqual(['H-FAIL-2', 'S-FAIL-1']);
    expect(body.items.every((i) => i.kind === 'ingest_failure')).toBe(true);
    expect(body.items.every((i) => i.ingestStatus === 'error')).toBe(true);
    expect(body.totals.ingestFailures).toBe(2);
    expect(body.totals.publishedStatusStale).toBe(1);

    const senate = body.items.find((i) => i.docId === 'S-FAIL-1');
    expect(senate).toMatchObject({
      chamber: 'senate',
      filerId: 'S000001',
      filerName: 'Jane Senator',
      filedDate: '2026-01-02',
      errorTruncated: true,
      lastAttemptAt: tsAt(12),
    });
    expect(senate?.error?.length).toBe(300);
    expect(senate?.error?.startsWith('fetch failed:')).toBe(true);
  });

  it('paginates newest-first with a keyset cursor and rejects bad cursors', async () => {
    const rows: ReviewQueueFixtureRow[] = [1, 2, 3].map((n) => ({
      docId: `S-PAGE-${n}`, createdAt: tsAt(n), noReview: true, chamber: 'senate',
      ingestStatus: 'error', error: 'x', firstSeenAt: tsAt(n),
    }));
    const db = makeReviewQueueTestDb(rows);
    const first = await fetchIngest(db, '?limit=2');
    expect(first.body.items.map((i) => i.docId)).toEqual(['S-PAGE-3', 'S-PAGE-2']);
    expect(first.body.nextCursor).toBeTruthy();
    const second = await fetchIngest(db, `?limit=2&cursor=${encodeURIComponent(first.body.nextCursor ?? '')}`);
    expect(second.body.items.map((i) => i.docId)).toEqual(['S-PAGE-1']);
    expect(second.body.nextCursor).toBeNull();

    const bad = await fetchIngest(db, '?cursor=nope%20%25%25');
    expect(bad.status).toBe(400);
  });

  it('filters by chamber and caps an oversized limit instead of erroring', async () => {
    const db = makeReviewQueueTestDb(mixedFixture());
    const { body } = await fetchIngest(db, '?limit=9999&chamber=senate');
    expect(body.items.map((i) => i.docId)).toEqual(['S-FAIL-1']);
    expect(body.totals.ingestFailures).toBe(1);
  });

  it('requires admin auth', async () => {
    const db = makeReviewQueueTestDb(mixedFixture());
    const res = await app.request('/review-queue/ingest-failures', {}, env(db));
    expect(res.status).not.toBe(200);
  });
});

describe('GET /review-queue totals + include', () => {
  it('adds ingest counts to totals without changing existing fields', async () => {
    const db = makeReviewQueueTestDb(mixedFixture());
    const res = await app.request('/review-queue?limit=50', { headers: AUTH }, env(db));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ docId: string }>;
      totals: { unresolved: number; matching: number; ingestFailures: number; publishedStatusStale: number };
      ingestFailures?: IngestItem[];
    };
    // Pending queue still holds only the two unresolved rows.
    expect(body.items.map((i) => i.docId).sort()).toEqual(['H-PENDING', 'H-QUEUED']);
    expect(body.totals.unresolved).toBe(2);
    expect(body.totals.matching).toBe(2);
    expect(body.totals.ingestFailures).toBe(2);
    expect(body.totals.publishedStatusStale).toBe(1);
    // Opt-in only: no embedded list unless asked for.
    expect(body.ingestFailures).toBeUndefined();
  });

  it('embeds the failure list with ?include=ingest_failures', async () => {
    const db = makeReviewQueueTestDb(mixedFixture());
    const res = await app.request(
      '/review-queue?limit=50&include=ingest_failures',
      { headers: AUTH },
      env(db),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ docId: string }>;
      ingestFailures: IngestItem[];
      ingestFailuresNextCursor: string | null;
    };
    expect(body.items.map((i) => i.docId).sort()).toEqual(['H-PENDING', 'H-QUEUED']);
    expect(body.ingestFailures.map((i) => i.docId).sort()).toEqual(['H-FAIL-2', 'S-FAIL-1']);
    expect(body.ingestFailuresNextCursor).toBeNull();
  });

  it('keeps totals at zero on an empty database', async () => {
    const db = makeReviewQueueTestDb([]);
    const res = await app.request('/review-queue?limit=50', { headers: AUTH }, env(db));
    const body = (await res.json()) as {
      totals: { ingestFailures: number; publishedStatusStale: number };
    };
    expect(body.totals).toMatchObject({ ingestFailures: 0, publishedStatusStale: 0 });
    const ingest = await fetchIngest(db, '?limit=50');
    expect(ingest.body.items).toEqual([]);
    expect(ingest.body.totals).toMatchObject({ ingestFailures: 0, publishedStatusStale: 0 });
  });
});
