import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  runSenateBackfill,
  SENATE_SEARCH_RESULT_CAP,
  type SenateBackfillOptions,
} from '../senateCrawler.ts';
import type { SenateFiling } from '../../ingestion/senateSource.ts';
import type { Env, QueueMessage } from '../../shared/types.ts';
import { resetD1WriteGovernor } from '../../shared/d1Budget.ts';

function filing(id: string, filedDate = '01/15/2024'): SenateFiling {
  return {
    reportId: id,
    first: 'Jane',
    last: 'Smith',
    fullName: 'Smith, Jane (Senator)',
    filingTypeLabel: 'Periodic Transaction Report',
    filedDate,
    reportPath: `/search/view/ptr/${id}/`,
    sourceUrl: `https://efdsearch.senate.gov/search/view/ptr/${id}/`,
    pipelineDocId: `S-${id}`,
  };
}

interface FakeEnvResult {
  env: Env;
  sent: QueueMessage[];
  seen: Set<string>;
  writes: unknown[][];
}

function fakeEnv(
  vars: Record<string, string> = {},
  options: { queueFails?: boolean } = {},
): FakeEnvResult {
  const sent: QueueMessage[] = [];
  const seen = new Set<string>();
  const writes: unknown[][] = [];
  const filingByDoc = new Map<string, { chamber: 'house' | 'senate'; sourceUrl: string }>();
  const outbox = new Map<string, {
    doc_id: string;
    chamber: 'house' | 'senate';
    source_url: string;
    status: string;
    attempts: number;
    dead_letter_cycles: number;
    available_at: string;
  }>();

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
            const row = filingByDoc.get(docId);
            if (row && !outbox.has(docId)) {
              outbox.set(docId, {
                doc_id: docId,
                chamber: row.chamber,
                source_url: row.sourceUrl,
                status: 'pending',
                attempts: 0,
                dead_letter_cycles: 0,
                available_at: String(bound[0]),
              });
            }
            return Promise.resolve({ meta: { changes: row ? 1 : 0 } } as unknown as D1Result);
          }
          if (/UPDATE ingestion_outbox/i.test(sql) && /status = 'enqueued'/i.test(sql)) {
            const row = outbox.get(String(bound[2]));
            if (row) {
              row.status = 'enqueued';
              row.attempts += 1;
            }
            return Promise.resolve({ meta: { changes: row ? 1 : 0 } } as unknown as D1Result);
          }
          if (/UPDATE ingestion_outbox/i.test(sql)) {
            const row = outbox.get(String(bound[bound.length - 1]));
            if (row) row.attempts += 1;
            return Promise.resolve({ meta: { changes: row ? 1 : 0 } } as unknown as D1Result);
          }
          if (!/INSERT OR IGNORE INTO filings/i.test(sql)) {
            return Promise.resolve({ meta: { changes: 1 } } as unknown as D1Result);
          }
          const docId = String(bound[0]);
          const isNew = !seen.has(docId);
          if (isNew) {
            seen.add(docId);
            filingByDoc.set(docId, {
              chamber: String(bound[1]) as 'house' | 'senate',
              sourceUrl: String(bound[4]),
            });
          }
          return Promise.resolve({ meta: { changes: isNew ? 1 : 0 } } as unknown as D1Result);
        },
        all<T>() {
          if (/FROM ingestion_outbox/i.test(sql)) {
            const row = outbox.get(String(bound[0]));
            return Promise.resolve({
              results: row?.status === 'pending' ? [row as T] : [] as T[],
            });
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
    CONFIG_KV: {
      get: () => Promise.resolve(null),
      put: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    },
    INGEST_QUEUE: {
      send(message: QueueMessage) {
        if (options.queueFails) return Promise.reject(new Error('queue unavailable'));
        sent.push(message);
        return Promise.resolve();
      },
    },
    ...vars,
  } as unknown as Env;

  return { env, sent, seen, writes };
}

function fetcher(
  impl: NonNullable<SenateBackfillOptions['fetchFilingsImpl']>,
): NonNullable<SenateBackfillOptions['fetchFilingsImpl']> {
  return impl;
}

beforeEach(() => resetD1WriteGovernor());
afterEach(() => resetD1WriteGovernor());

describe('runSenateBackfill', () => {
  it('queries inclusive explicit bounds in month windows and excludes parseable out-of-range rows', async () => {
    const { env, seen, sent } = fakeEnv();
    const calls: Array<{ since: string; now: string; pages: number; size: number }> = [];
    const fetchFilingsImpl = fetcher(async (opts) => {
      calls.push({
        since: opts.since!.toISOString(),
        now: opts.now!.toISOString(),
        pages: opts.maxPages!,
        size: opts.pageSize!,
      });
      return opts.since!.getUTCMonth() === 0
        ? [filing('jan', '01/20/2024'), filing('too-early', '01/01/2024')]
        : [filing('feb', '02/10/2024')];
    });

    const result = await runSenateBackfill(env, {
      fromDate: '2024-01-15',
      toDate: '2024-02-10',
      dryRun: true,
      fetchFilingsImpl,
    });

    expect(calls).toEqual([
      {
        since: '2024-01-15T00:00:00.000Z',
        now: '2024-01-31T23:59:59.000Z',
        pages: 25,
        size: 100,
      },
      {
        since: '2024-02-01T00:00:00.000Z',
        now: '2024-02-10T23:59:59.000Z',
        pages: 25,
        size: 100,
      },
    ]);
    expect(result.discovered).toBe(2);
    expect(result.outOfRange).toBe(1);
    expect(result.dryRunSkipped).toBe(2);
    expect(result.byMonth['2024-01'].discovered).toBe(1);
    expect(result.byMonth['2024-02'].discovered).toBe(1);
    expect(seen.size).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('recursively bisects a 2,500-row range and deduplicates leaf results by pipelineDocId', async () => {
    const { env } = fakeEnv();
    let calls = 0;
    const fetchFilingsImpl = fetcher(async () => {
      calls += 1;
      if (calls === 1) {
        return Array.from({ length: SENATE_SEARCH_RESULT_CAP }, (_, i) => filing(`capped-${i}`));
      }
      return calls === 2 ? [filing('shared')] : [filing('shared'), filing('right')];
    });

    const result = await runSenateBackfill(env, {
      fromDate: '2024-01-01',
      toDate: '2024-01-31',
      dryRun: true,
      fetchFilingsImpl,
    });

    expect(calls).toBe(3);
    expect(result.rangesQueried).toBe(3);
    expect(result.rangesSplit).toBe(1);
    expect(result.sourceRows).toBe(SENATE_SEARCH_RESULT_CAP + 3);
    expect(result.discovered).toBe(2);
    expect(result.duplicates).toBe(1);
    expect(result.saturatedRanges).toBe(0);
  });

  it('respects maxFilings without marking over-cap rows seen, allowing a later run to continue', async () => {
    const { env, seen, sent } = fakeEnv();
    const fetchFilingsImpl = fetcher(async () => [filing('one'), filing('two')]);

    const first = await runSenateBackfill(env, {
      fromDate: '2024-01-01',
      toDate: '2024-01-31',
      maxFilings: 1,
      fetchFilingsImpl,
    });
    expect(first.inserted).toBe(1);
    expect(first.enqueued).toBe(1);
    expect(first.skippedForLimit).toBe(1);
    expect(Array.from(seen)).toEqual(['S-one']);

    const second = await runSenateBackfill(env, {
      fromDate: '2024-01-01',
      toDate: '2024-01-31',
      maxFilings: 1,
      fetchFilingsImpl,
    });
    expect(second.alreadyPresent).toBe(1);
    expect(second.inserted).toBe(1);
    expect(second.enqueued).toBe(1);
    expect(Array.from(seen)).toEqual(['S-one', 'S-two']);
    expect(sent.map((message) => message.type === 'filing.new' ? message.docId : '')).toEqual([
      'S-one',
      'S-two',
    ]);
  });

  it('threads env.SENATE_RELAY_URL explicitly into every source query (2026-08-09 regression)', async () => {
    // Relying on fetchSenatePtrFilings's own process.env fallback proved
    // unreliable in production: Imperva blocks the box's IP, and calls that
    // depended solely on the ambient process.env read intermittently took the
    // direct (non-relay) path and hit the block even with the container env
    // var correctly set. The fix is to thread env.SENATE_RELAY_URL explicitly
    // on every call so it never depends on ambient global state.
    const { env } = fakeEnv({ SENATE_RELAY_URL: 'http://10.0.2.1:8900' });
    const seenRelayUrls: (string | undefined)[] = [];
    await runSenateBackfill(env, {
      fromDate: '2024-01-01',
      toDate: '2024-01-31',
      fetchFilingsImpl: fetcher(async (opts) => {
        seenRelayUrls.push(opts.relayUrl);
        return [];
      }),
    });
    expect(seenRelayUrls).not.toHaveLength(0);
    expect(seenRelayUrls.every((u) => u === 'http://10.0.2.1:8900')).toBe(true);
  });

  it('stops source discovery once the new-filing budget is satisfied', async () => {
    const { env } = fakeEnv();
    const calls: string[] = [];
    const result = await runSenateBackfill(env, {
      fromDate: '2024-01-01',
      toDate: '2024-12-31',
      maxFilings: 1,
      fetchFilingsImpl: fetcher(async (opts) => {
        calls.push(opts.since!.toISOString());
        return [filing('month-' + opts.since!.getUTCMonth())];
      }),
    });

    expect(calls).toEqual(['2024-01-01T00:00:00.000Z']);
    expect(result.inserted).toBe(1);
    expect(result.nextFromDate).toBe('2024-01-01');
  });

  it('enforces an absolute source-query budget with a continuation cursor', async () => {
    const { env } = fakeEnv();
    const result = await runSenateBackfill(env, {
      fromDate: '2024-01-01',
      toDate: '2024-03-31',
      maxSourceQueries: 1,
      dryRun: true,
      fetchFilingsImpl: fetcher(async () => []),
    });

    expect(result.rangesQueried).toBe(1);
    expect(result.sourceLimitReached).toBe(true);
    expect(result.nextFromDate).toBe('2024-02-01');
  });

  it('is idempotent and enqueues only the genuinely-new INSERT OR IGNORE winner', async () => {
    const { env, sent } = fakeEnv();
    const options: SenateBackfillOptions = {
      fromDate: '2024-01-01',
      toDate: '2024-01-31',
      fetchFilingsImpl: fetcher(async () => [filing('same')]),
    };

    const first = await runSenateBackfill(env, options);
    const second = await runSenateBackfill(env, options);

    expect(first.inserted).toBe(1);
    expect(first.enqueued).toBe(1);
    expect(second.inserted).toBe(0);
    expect(second.alreadyPresent).toBe(1);
    expect(second.enqueued).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it('retains a durable outbox handoff when the immediate queue send fails', async () => {
    const { env, sent } = fakeEnv({}, { queueFails: true });
    const result = await runSenateBackfill(env, {
      fromDate: '2024-01-01',
      toDate: '2024-01-31',
      fetchFilingsImpl: fetcher(async () => [filing('pending')]),
    });

    expect(result.inserted).toBe(1);
    expect(result.enqueued).toBe(0);
    expect(result.outboxPending).toBe(1);
    expect(sent).toHaveLength(0);
  });

  it('stops on D1 write-governor deferral and leaves the deferred row rediscoverable', async () => {
    const { env, seen, sent } = fakeEnv({ D1_WRITE_OPS_PER_INVOCATION_CAP: '1' });
    const result = await runSenateBackfill(env, {
      fromDate: '2024-01-01',
      toDate: '2024-01-31',
      fetchFilingsImpl: fetcher(async () => [filing('one'), filing('two')]),
    });

    expect(result.inserted).toBe(1);
    expect(result.unprocessed).toBe(1);
    expect(result.errors).toEqual([
      'D1 write governor deferred at S-two; rerun the idempotent backfill to continue',
    ]);
    expect(Array.from(seen)).toEqual(['S-one']);
    expect(sent).toHaveLength(1);
  });

  it('fails soft per month so one source error does not discard later months', async () => {
    const { env } = fakeEnv();
    const fetchFilingsImpl = fetcher(async (opts) => {
      if (opts.since!.getUTCMonth() === 0) throw new Error('Senate HTTP 503');
      return [filing('feb', '02/05/2024')];
    });

    const result = await runSenateBackfill(env, {
      fromDate: '2024-01-01',
      toDate: '2024-02-29',
      dryRun: true,
      fetchFilingsImpl,
    });

    expect(result.discovered).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Senate HTTP 503');
  });

  it('rejects reversed, invalid, or operationally unbounded options', async () => {
    const { env } = fakeEnv();
    const fetchFilingsImpl = fetcher(async () => []);

    await expect(runSenateBackfill(env, {
      fromDate: '2024-02-01',
      toDate: '2024-01-01',
      fetchFilingsImpl,
    })).rejects.toThrow('fromDate must be before or equal to toDate');
    await expect(runSenateBackfill(env, {
      fromDate: '2024-02-30',
      toDate: '2024-03-01',
      fetchFilingsImpl,
    })).rejects.toThrow('fromDate is not a valid calendar date');
    await expect(runSenateBackfill(env, {
      fromDate: '2024-01-01',
      toDate: '2024-01-31',
      maxFilings: 5_001,
      fetchFilingsImpl,
    })).rejects.toThrow('maxFilings must be an integer between 0 and 5000');
    await expect(runSenateBackfill(env, {
      fromDate: '2024-01-01',
      toDate: '2024-01-31',
      maxSourceQueries: 501,
      fetchFilingsImpl,
    })).rejects.toThrow('maxSourceQueries must be an integer between 1 and 500');
  });
});
