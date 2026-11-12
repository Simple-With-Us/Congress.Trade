import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import {
  runHouseHistoricalBackfill,
  type HouseBackfillOptions,
} from '../houseCrawler.ts';
import type { HouseFiling } from '../../ingestion/houseSource.ts';
import type { Env, QueueMessage } from '../../shared/types.ts';
import { resetD1WriteGovernor } from '../../shared/d1Budget.ts';

// ---------------------------------------------------------------------------
// Test doubles — no network, no real D1/queue.
// ---------------------------------------------------------------------------

/** Build a HouseFiling fixture (mirrors parseHouseIndexXml output shape). */
function filing(year: number, docId: string, filingType: string): HouseFiling {
  const isPtr = filingType.toUpperCase() === 'P';
  return {
    docId,
    filingType,
    year: String(year),
    first: 'Test',
    last: 'Politician',
    stateDst: 'CA01',
    filingDate: `1/2/${year}`,
    isPtr,
    pipelineDocId: `H-${year}-${docId}`,
    sourceUrl: `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${year}/${docId}.pdf`,
  };
}

/**
 * Minimal D1 stub. Every INSERT OR IGNORE reports meta.changes=1 (genuinely
 * new) UNLESS the doc_id has been seen before in this run — mirroring real
 * INSERT OR IGNORE de-duplication so we can assert idempotency.
 */
function fakeEnv(vars: Record<string, string> = {}): { env: Env; sent: QueueMessage[]; seen: Set<string>; writes: unknown[][] } {
  const sent: QueueMessage[] = [];
  const seen = new Set<string>();
  const writes: unknown[][] = [];
  const filingByDoc = new Map<string, { chamber: 'house' | 'senate'; sourceUrl: string }>();
  const outbox = new Map<string, { doc_id: string; chamber: 'house' | 'senate'; source_url: string; status: string; attempts: number; available_at: string }>();

  const db = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          bound = args;
          return stmt;
        },
        run() {
          writes.push(bound);
          if (/INSERT OR IGNORE INTO ingestion_outbox/i.test(sql)) {
            const docId = String(bound[3]);
            const filing = filingByDoc.get(docId);
            if (filing && !outbox.has(docId)) outbox.set(docId, {
              doc_id: docId, chamber: filing.chamber, source_url: filing.sourceUrl,
              status: 'pending', attempts: 0, available_at: String(bound[0]),
            });
            return Promise.resolve({ meta: { changes: filing ? 1 : 0 } } as unknown as D1Result);
          }
          if (/UPDATE ingestion_outbox/i.test(sql) && /status = 'enqueued'/i.test(sql)) {
            const row = outbox.get(String(bound[2]));
            if (row) { row.status = 'enqueued'; row.attempts += 1; }
            return Promise.resolve({ meta: { changes: row ? 1 : 0 } } as unknown as D1Result);
          }
          if (!/INSERT OR IGNORE INTO filings/i.test(sql)) {
            return Promise.resolve({ meta: { changes: 1 } } as unknown as D1Result);
          }
          // First bound param is doc_id in the crawler's filings INSERT.
          const docId = String(bound[0]);
          const isNew = !seen.has(docId);
          if (isNew) {
            seen.add(docId);
            filingByDoc.set(docId, {
              chamber: String(bound[1]) as 'house' | 'senate', sourceUrl: String(bound[4]),
            });
          }
          return Promise.resolve({ meta: { changes: isNew ? 1 : 0 } } as unknown as D1Result);
        },
        all<T>() {
          if (/FROM ingestion_outbox/i.test(sql)) {
            const row = outbox.get(String(bound[0]));
            return Promise.resolve({ results: row && row.status === 'pending' ? [row as T] : [] as T[] });
          }
          return Promise.resolve({ results: [] as T[] });
        },
        // resolveIngestFilerId's merge/existing-filer lookups (get() -> .first()).
        // No filer_identity_merges/filers rows exist in this fixture DB, so
        // these always miss — same as insertFilingIfNew minting a fresh slug.
        first<T>() {
          return Promise.resolve(null as T | null);
        },
      };
      return stmt as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;

  const env = {
    DB: db,
    INGEST_QUEUE: {
      send(msg: QueueMessage) {
        sent.push(msg);
        return Promise.resolve();
      },
    },
    ...vars,
  } as unknown as Env;

  return { env, sent, seen, writes };
}

/** Build an injectable index impl from a year->filings map. */
function indexImpl(byYear: Record<number, HouseFiling[]>): HouseBackfillOptions['fetchIndexImpl'] {
  return (year) => Promise.resolve(byYear[Number(year)] ?? []);
}

// ---------------------------------------------------------------------------

beforeEach(() => resetD1WriteGovernor());
afterEach(() => resetD1WriteGovernor());

describe('runHouseHistoricalBackfill', () => {
  it('iterates the inclusive year range and only enqueues PTRs (FilingType P)', async () => {
    const { env, sent, writes } = fakeEnv();
    const data: Record<number, HouseFiling[]> = {
      2014: [filing(2014, '100', 'P'), filing(2014, '101', 'O') /* annual, not PTR */],
      2015: [filing(2015, '200', 'P'), filing(2015, '201', 'A') /* amendment */],
    };

    const res = await runHouseHistoricalBackfill(env, {
      fromYear: 2014,
      toYear: 2015,
      fetchIndexImpl: indexImpl(data),
    });

    expect(res.fromYear).toBe(2014);
    expect(res.toYear).toBe(2015);
    // 4 filings seen, but only the 2 PTRs are discovered/persisted + enqueued.
    expect(res.discovered).toBe(2);
    expect(res.enqueued).toBe(2);
    expect(res.skipped).toBe(0);
    expect(res.byYear).toEqual({ '2014': 1, '2015': 1 });
    const filingWrites = writes.filter((w) => String(w[0]).startsWith('H-'));
    expect(filingWrites.map((w) => w[3])).toEqual(['2014-01-02', '2015-01-02']);
    expect(filingWrites.map((w) => w[2])).toEqual([
      'house-ca01-test-politician',
      'house-ca01-test-politician',
    ]);

    // Exactly the two PTR doc ids, with the watcher-identical message shape.
    expect(sent).toEqual([
      {
        type: 'filing.new',
        docId: 'H-2014-100',
        chamber: 'house',
        sourceUrl: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2014/100.pdf',
      },
      {
        type: 'filing.new',
        docId: 'H-2015-200',
        chamber: 'house',
        sourceUrl: 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2015/200.pdf',
      },
    ]);
  });

  it('respects maxFilings as a global cap on persisted/enqueued messages', async () => {
    const { env, sent, seen } = fakeEnv();
    const data: Record<number, HouseFiling[]> = {
      2014: [filing(2014, '1', 'P'), filing(2014, '2', 'P'), filing(2014, '3', 'P')],
      2015: [filing(2015, '4', 'P'), filing(2015, '5', 'P')],
    };

    const res = await runHouseHistoricalBackfill(env, {
      fromYear: 2014,
      toYear: 2015,
      maxFilings: 2,
      fetchIndexImpl: indexImpl(data),
    });

    // All 5 PTRs are discovered, but only 2 are persisted/enqueued (the cap).
    expect(res.discovered).toBe(5);
    expect(res.enqueued).toBe(2);
    expect(res.skipped).toBe(3);
    expect(Array.from(seen)).toEqual(['H-2014-1', 'H-2014-2']);
    expect(sent).toHaveLength(2);
    expect(sent.map((m) => (m.type === 'filing.new' ? m.docId : ''))).toEqual([
      'H-2014-1',
      'H-2014-2',
    ]);
  });

  it('does not mark over-cap new filings as seen before a later run can enqueue them', async () => {
    const { env, sent, seen } = fakeEnv();
    const data: Record<number, HouseFiling[]> = {
      2014: [filing(2014, '1', 'P'), filing(2014, '2', 'P')],
    };
    const fetchIndexImpl = indexImpl(data);

    const first = await runHouseHistoricalBackfill(env, {
      fromYear: 2014,
      toYear: 2014,
      maxFilings: 1,
      fetchIndexImpl,
    });

    expect(first.enqueued).toBe(1);
    expect(first.skipped).toBe(1);
    expect(Array.from(seen)).toEqual(['H-2014-1']);

    const second = await runHouseHistoricalBackfill(env, {
      fromYear: 2014,
      toYear: 2014,
      maxFilings: 2,
      fetchIndexImpl,
    });

    expect(second.enqueued).toBe(1);
    expect(second.skipped).toBe(1);
    expect(sent.map((m) => (m.type === 'filing.new' ? m.docId : ''))).toEqual([
      'H-2014-1',
      'H-2014-2',
    ]);
    expect(Array.from(seen)).toEqual(['H-2014-1', 'H-2014-2']);
  });

  it('stops on D1 write-governor deferral without marking deferred filings as duplicates', async () => {
    const { env, sent, seen } = fakeEnv({ D1_WRITE_OPS_PER_INVOCATION_CAP: '1' });
    const data: Record<number, HouseFiling[]> = {
      2014: [filing(2014, '1', 'P'), filing(2014, '2', 'P')],
    };
    const fetchIndexImpl = indexImpl(data);

    const first = await runHouseHistoricalBackfill(env, {
      fromYear: 2014,
      toYear: 2014,
      fetchIndexImpl,
    });

    expect(first.enqueued).toBe(1);
    expect(first.skipped).toBe(0);
    expect(first.errors).toEqual([
      '2014: D1 write governor deferred at H-2014-2; rerun backfill to continue',
    ]);
    expect(Array.from(seen)).toEqual(['H-2014-1']);
    expect(sent.map((m) => (m.type === 'filing.new' ? m.docId : ''))).toEqual(['H-2014-1']);
  });

  it('does not write or enqueue in dryRun', async () => {
    const { env, sent, seen } = fakeEnv();
    const data: Record<number, HouseFiling[]> = { 2014: [filing(2014, '1', 'P')] };

    const res = await runHouseHistoricalBackfill(env, {
      fromYear: 2014,
      toYear: 2014,
      dryRun: true,
      fetchIndexImpl: indexImpl(data),
    });

    expect(res.discovered).toBe(1);
    expect(res.enqueued).toBe(0);
    expect(res.skipped).toBe(1);
    expect(sent).toHaveLength(0);
    expect(seen.size).toBe(0);
  });

  it('is idempotent: a second run never double-enqueues already-seen PTRs', async () => {
    const { env, sent } = fakeEnv(); // shared `seen` across both runs
    const data: Record<number, HouseFiling[]> = { 2014: [filing(2014, '1', 'P')] };
    const opts: HouseBackfillOptions = {
      fromYear: 2014,
      toYear: 2014,
      fetchIndexImpl: indexImpl(data),
    };

    const first = await runHouseHistoricalBackfill(env, opts);
    expect(first.enqueued).toBe(1);

    const second = await runHouseHistoricalBackfill(env, opts);
    // INSERT OR IGNORE -> meta.changes=0 the second time -> nothing enqueued.
    expect(second.enqueued).toBe(0);
    expect(second.skipped).toBe(1);
    expect(sent).toHaveLength(1); // total across both runs
  });

  it('fails soft per-year: one bad year is recorded but does not abort the run', async () => {
    const { env, sent } = fakeEnv();
    const fetchIndexImpl: HouseBackfillOptions['fetchIndexImpl'] = (year) => {
      if (Number(year) === 2015) return Promise.reject(new Error('HTTP 404'));
      return Promise.resolve([filing(Number(year), '1', 'P')]);
    };

    const res = await runHouseHistoricalBackfill(env, {
      fromYear: 2014,
      toYear: 2016,
      fetchIndexImpl,
    });

    // 2014 + 2016 succeed; 2015 is recorded in errors.
    expect(res.enqueued).toBe(2);
    expect(res.errors).toEqual(['2015: HTTP 404']);
    expect(sent).toHaveLength(2);
  });

  it('defaults toYear to the current UTC year and fromYear to 2014', async () => {
    const { env } = fakeEnv();
    const res = await runHouseHistoricalBackfill(env, {
      // no fromYear/toYear -> defaults; empty index so nothing is enqueued.
      fetchIndexImpl: () => Promise.resolve([]),
    });
    expect(res.fromYear).toBe(2014);
    expect(res.toYear).toBe(new Date().getUTCFullYear());
  });
});
