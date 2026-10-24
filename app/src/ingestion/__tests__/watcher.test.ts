import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '../../shared/types.ts';
import { SenateHttpError, SenateProxyEgressError } from '../senateEdgeDeny.ts';

const mocks = vi.hoisted(() => ({
  fetchHouseIndex: vi.fn(),
  pollHouseLiveSearch: vi.fn(),
  fetchSenatePtrFilings: vi.fn(),
  pollOgeExecutive: vi.fn(),
}));

vi.mock('../houseSource', () => ({
  fetchHouseIndex: mocks.fetchHouseIndex,
  pollHouseLiveSearch: mocks.pollHouseLiveSearch,
}));

vi.mock('../senateSource', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../senateSource.ts')>()),
  fetchSenatePtrFilings: mocks.fetchSenatePtrFilings,
}));

vi.mock('../ogeSource', () => ({
  pollOgeExecutive: mocks.pollOgeExecutive,
}));

import { computeSenateLookbackDays, inHousePriorYearWindow, pollExecutive, runWatcher } from '../watcher.ts';

function housePtr(docId: string, overrides: Partial<Record<'filingDate' | 'first' | 'last' | 'stateDst', string>> = {}) {
  return {
    pipelineDocId: `H-2026-${docId}`,
    sourceUrl: `https://example.test/${docId}.pdf`,
    filingDate: overrides.filingDate ?? '7/4/2026',
    first: overrides.first ?? 'Jane',
    last: overrides.last ?? 'Smith',
    stateDst: overrides.stateDst ?? 'CA01',
    isPtr: true,
  };
}

function fakeEnv(
  overrides: Partial<{ HOUSE_LIVE_SEARCH_ENABLED: string }> = {},
  faults: { throwOnFilingsInsert?: boolean } = {},
  kvSeed: Record<string, string> = {},
): {
  env: Env;
  kv: Map<string, string>;
  kvPuts: Array<[string, string]>;
  dbRuns: Array<{ sql: string; params: unknown[] }>;
  queueSends: Array<unknown>;
} {
  const kv = new Map<string, string>(Object.entries(kvSeed));
  const kvPuts: Array<[string, string]> = [];
  const dbRuns: Array<{ sql: string; params: unknown[] }> = [];
  const queueSends: Array<unknown> = [];
  const insertedDocIds = new Set<string>();
  const filingByDoc = new Map<string, { chamber: 'house' | 'senate'; sourceUrl: string }>();
  const outbox = new Map<string, { doc_id: string; chamber: 'house' | 'senate'; source_url: string; status: string; attempts: number; available_at: string }>();

  const env = {
    ...overrides,
    CONFIG_KV: {
      async get(key: string, type?: string) {
        const value = kv.get(key) ?? null;
        return value !== null && type === 'json' ? JSON.parse(value) : value;
      },
      async put(key: string, value: string) {
        kv.set(key, value);
        kvPuts.push([key, value]);
      },
      async delete(key: string) {
        kv.delete(key);
      },
    },
    DB: {
      prepare(sql: string) {
        let params: unknown[] = [];
        return {
          bind(...bound: unknown[]) {
            params = bound;
            return this;
          },
          async first<T>() {
            return null as T | null;
          },
          async all<T>() {
            if (/FROM ingestion_outbox/i.test(sql)) {
              const docId = String(params[0] ?? '');
              const row = outbox.get(docId);
              return { results: row && row.status === 'pending' ? [row as T] : [] as T[] };
            }
            return { results: [] as T[] };
          },
          async run() {
            dbRuns.push({ sql, params });
            if (/INSERT OR IGNORE INTO filings/i.test(sql)) {
              if (faults.throwOnFilingsInsert) throw new Error('filings insert failed');
              const docId = String(params[0] ?? '');
              const isNew = !insertedDocIds.has(docId);
              insertedDocIds.add(docId);
              filingByDoc.set(docId, {
                chamber: String(params[1]) as 'house' | 'senate', sourceUrl: String(params[4]),
              });
              return { success: true, meta: { changes: isNew ? 1 : 0 } };
            }
            if (/INSERT OR IGNORE INTO ingestion_outbox/i.test(sql)) {
              const docId = String(params[3]);
              const filing = filingByDoc.get(docId);
              if (filing && !outbox.has(docId)) outbox.set(docId, {
                doc_id: docId, chamber: filing.chamber, source_url: filing.sourceUrl,
                status: 'pending', attempts: 0, available_at: String(params[0]),
              });
            }
            if (/UPDATE ingestion_outbox/i.test(sql) && /status = 'enqueued'/i.test(sql)) {
              const row = outbox.get(String(params[2]));
              if (row) { row.status = 'enqueued'; row.attempts += 1; }
            }
            return { success: true, meta: { changes: 1 } };
          },
        };
      },
    },
    INGEST_QUEUE: {
      async send(message: unknown) {
        queueSends.push(message);
      },
    },
  } as unknown as Env;

  return { env, kv, kvPuts, dbRuns, queueSends };
}

describe('runWatcher', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default the OGE source to "nothing due" so tests that don't exercise the
    // executive path leave it skipped instead of tripping the mock.
    mocks.pollOgeExecutive.mockResolvedValue(null);
  });

  it('does not stamp last-poll state after source failures', async () => {
    const { env, kvPuts, dbRuns } = fakeEnv();
    mocks.fetchHouseIndex.mockRejectedValueOnce(new Error('house down'));
    mocks.fetchSenatePtrFilings.mockRejectedValueOnce(new Error('senate down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await runWatcher(env, new Date('2026-06-30T15:00:00.000Z'));
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }

    expect(kvPuts.map(([key]) => key)).not.toContain('last_poll:house');
    expect(kvPuts.map(([key]) => key)).not.toContain('last_poll:senate');
    expect(dbRuns.filter((run) => /INSERT INTO ingest_log/i.test(run.sql))).toHaveLength(0);
    const attempts = dbRuns.filter((run) => /INSERT INTO source_attempts/i.test(run.sql));
    expect(attempts).toHaveLength(2);
    expect(attempts.map((run) => run.params[2])).toEqual(['failure', 'failure']);
  });

  it('rethrows AbortError instead of recording a source failure when the tick signal aborts', async () => {
    const { env, dbRuns } = fakeEnv();
    const controller = new AbortController();
    controller.abort(new Error('deadline'));
    await expect(
      runWatcher(env, new Date('2026-07-04T15:00:00.000Z'), { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError', message: 'deadline' });
    expect(dbRuns.filter((run) => /INSERT INTO source_attempts/i.test(run.sql))).toHaveLength(0);
    expect(mocks.fetchHouseIndex).not.toHaveBeenCalled();
  });

  it('gives House, Senate, and OGE each a fresh I/O signal', async () => {
    const { env } = fakeEnv();
    const signals: AbortSignal[] = [];
    mocks.fetchHouseIndex.mockImplementation(async (_year: number, opts: { signal?: AbortSignal }) => {
      expect(opts.signal?.aborted).toBe(false);
      signals.push(opts.signal!);
      return [];
    });
    mocks.pollHouseLiveSearch.mockResolvedValue([]);
    mocks.fetchSenatePtrFilings.mockImplementation(async (opts: { signal?: AbortSignal }) => {
      expect(opts.signal?.aborted).toBe(false);
      signals.push(opts.signal!);
      return [];
    });
    mocks.pollOgeExecutive.mockImplementation(async (
      _env: unknown,
      _now: unknown,
      _fetchImpl: unknown,
      opts: { signal?: AbortSignal },
    ) => {
      expect(opts.signal?.aborted).toBe(false);
      signals.push(opts.signal!);
      return [];
    });

    const result = await runWatcher(env, new Date('2026-07-04T15:00:00.000Z'));

    expect(result).toMatchObject({ house: 'success', senate: 'success', executive: 'success' });
    expect(signals).toHaveLength(3);
    expect(new Set(signals).size).toBe(3);
    expect(mocks.pollHouseLiveSearch).toHaveBeenCalledWith(
      2026,
      expect.any(Function),
      expect.objectContaining({ signal: signals[0] }),
    );
  });

  it('threads the tick signal into active source I/O and aborts without recording a failure', async () => {
    const { env, dbRuns } = fakeEnv();
    const controller = new AbortController();
    mocks.fetchHouseIndex.mockImplementationOnce(
      (_year: number | string, opts: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
        expect(opts.signal).toBeDefined();
        opts.signal?.addEventListener('abort', () => reject(opts.signal?.reason), { once: true });
        setTimeout(() => controller.abort(new Error('deadline')), 0);
      }),
    );

    await expect(
      runWatcher(env, new Date('2026-07-04T15:00:00.000Z'), { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError', message: 'deadline' });
    expect(dbRuns.filter((run) => /INSERT INTO source_attempts/i.test(run.sql))).toHaveLength(0);
  });

  it('polls the live House search by default and de-dupes overlap against the bulk index', async () => {
    const { env, dbRuns, queueSends } = fakeEnv();
    mocks.fetchHouseIndex.mockResolvedValueOnce([housePtr('20026001'), housePtr('20026002')]);
    mocks.pollHouseLiveSearch.mockResolvedValueOnce([
      housePtr('20026002', { filingDate: '' }),
      housePtr('20026003', { filingDate: '' }),
    ]);
    mocks.fetchSenatePtrFilings.mockResolvedValueOnce([]);

    await runWatcher(env, new Date('2026-07-04T15:00:00.000Z'));

    expect(mocks.pollHouseLiveSearch).toHaveBeenCalledWith(
      2026,
      expect.any(Function),
      expect.objectContaining({ env, signal: expect.any(AbortSignal) }),
    );
    expect(queueSends).toHaveLength(3);
    expect(queueSends).toEqual([
      expect.objectContaining({ docId: 'H-2026-20026001', chamber: 'house' }),
      expect.objectContaining({ docId: 'H-2026-20026002', chamber: 'house' }),
      expect.objectContaining({ docId: 'H-2026-20026003', chamber: 'house' }),
    ]);

    const filingInserts = dbRuns.filter((run) => /INSERT OR IGNORE INTO filings/i.test(run.sql));
    expect(filingInserts).toHaveLength(3);
  });

  it('runs live House search alongside the bulk index on scheduled House polls by default', async () => {
    const now = new Date('2026-07-04T15:00:00.000Z');
    const { env, queueSends } = fakeEnv();
    mocks.fetchHouseIndex.mockResolvedValueOnce([housePtr('20026001')]);
    mocks.pollHouseLiveSearch.mockResolvedValueOnce([housePtr('20026002')]);
    mocks.fetchSenatePtrFilings.mockResolvedValueOnce([]);

    await runWatcher(env, now);

    expect(mocks.fetchHouseIndex).toHaveBeenCalledTimes(1);
    expect(mocks.pollHouseLiveSearch).toHaveBeenCalledTimes(1);
    expect(queueSends).toEqual([
      expect.objectContaining({ docId: 'H-2026-20026001', chamber: 'house' }),
      expect.objectContaining({ docId: 'H-2026-20026002', chamber: 'house' }),
    ]);
  });

  it('skips the live House search when explicitly disabled', async () => {
    const { env, queueSends } = fakeEnv({ HOUSE_LIVE_SEARCH_ENABLED: 'false' });
    mocks.fetchHouseIndex.mockResolvedValueOnce([housePtr('20026001')]);
    mocks.fetchSenatePtrFilings.mockResolvedValueOnce([]);

    await runWatcher(env, new Date('2026-07-04T15:00:00.000Z'));

    expect(mocks.pollHouseLiveSearch).not.toHaveBeenCalled();
    expect(queueSends).toEqual([expect.objectContaining({ docId: 'H-2026-20026001', chamber: 'house' })]);
  });

  it('fails soft when the live House search errors and still persists the bulk index', async () => {
    const { env, kvPuts, queueSends } = fakeEnv();
    mocks.fetchHouseIndex.mockResolvedValueOnce([housePtr('20026001')]);
    mocks.pollHouseLiveSearch.mockRejectedValueOnce(new Error('live blocked'));
    mocks.fetchSenatePtrFilings.mockResolvedValueOnce([]);

    await runWatcher(env, new Date('2026-07-04T15:00:00.000Z'));

    expect(mocks.pollHouseLiveSearch).toHaveBeenCalledWith(
      2026,
      expect.any(Function),
      expect.objectContaining({ env, signal: expect.any(AbortSignal) }),
    );
    expect(queueSends).toEqual([expect.objectContaining({ docId: 'H-2026-20026001', chamber: 'house' })]);
    expect(kvPuts.map(([key]) => key)).toContain('last_poll:house');
  });

  it('does not discard already-fetched bulk index filings when the per-source timeout fires during live search', async () => {
    const { env, kvPuts, queueSends, dbRuns } = fakeEnv();
    mocks.fetchHouseIndex.mockResolvedValueOnce([housePtr('20035652')]);
    mocks.pollHouseLiveSearch.mockImplementationOnce(async () => {
      const timeoutErr = new Error('The operation was aborted due to timeout');
      timeoutErr.name = 'TimeoutError';
      throw timeoutErr;
    });
    mocks.fetchSenatePtrFilings.mockResolvedValueOnce([]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const result = await runWatcher(env, new Date('2026-10-15T13:01:00.000Z'));
      expect(result.house).toBe('success');
    } finally {
      warn.mockRestore();
    }

    expect(queueSends).toEqual([
      expect.objectContaining({ docId: 'H-2026-20035652', chamber: 'house' }),
    ]);
    expect(kvPuts.map(([key]) => key)).toContain('last_poll:house');
    const houseAttempts = dbRuns.filter(
      (run) => /INSERT INTO source_attempts/i.test(run.sql) && run.params[0] === 'house',
    );
    expect(houseAttempts).toHaveLength(1);
    expect(houseAttempts[0].params[2]).toBe('success');
  });

  it('isolates a live-search counter KV failure from the authoritative bulk persist', async () => {
    const base = fakeEnv();
    const COUNTER_KEY = 'house_live_search:consecutive_failures';
    const innerKv = base.env.CONFIG_KV as {
      get(k: string): Promise<string | null>;
      put(k: string, v: string): Promise<void>;
    };
    // KV that throws ONLY on the observability counter key; every other key
    // (last_poll, etc.) behaves normally. On the pre-fix code the success-path
    // counter reset throwing fell into the poll's failure catch, which did more
    // unguarded KV work that escaped and skipped persistAndEnqueue entirely.
    (base.env as { CONFIG_KV: unknown }).CONFIG_KV = {
      async get(key: string) {
        if (key === COUNTER_KEY) throw new Error('kv counter read down');
        return innerKv.get(key);
      },
      async put(key: string, value: string) {
        if (key === COUNTER_KEY) throw new Error('kv counter write down');
        return innerKv.put(key, value);
      },
    };
    mocks.fetchHouseIndex.mockResolvedValueOnce([housePtr('20026001')]);
    mocks.pollHouseLiveSearch.mockResolvedValueOnce([]); // live search itself succeeds
    mocks.fetchSenatePtrFilings.mockResolvedValueOnce([]);

    await runWatcher(base.env, new Date('2026-07-04T15:00:00.000Z'));

    // The counter KV blip must NOT abort the bulk path: the filing is still
    // enqueued and the House poll is still checkpointed as a success.
    expect(base.queueSends).toEqual([
      expect.objectContaining({ docId: 'H-2026-20026001', chamber: 'house' }),
    ]);
    expect(base.kvPuts.map(([key]) => key)).toContain('last_poll:house');
  });

  // --- Executive (OGE 278-T) path -----------------------------------------
  const ogeFiling = {
    docId: 'OGE-2026-0001',
    chamber: 'executive' as const,
    sourceUrl: 'https://extapps2.oge.gov/278/0001.pdf',
    filedDate: '2026-06-01',
    filerId: 'EXEC-DJT',
    filerName: 'Donald J. Trump',
    party: 'R',
    photoUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/16/x.jpg/500px-x.jpg',
  };

  function quietExecutiveEnv() {
    // House/Senate poll cleanly (no filings) so the executive path is isolated.
    mocks.fetchHouseIndex.mockResolvedValue([]);
    mocks.pollHouseLiveSearch.mockResolvedValue([]);
    mocks.fetchSenatePtrFilings.mockResolvedValue([]);
  }

  it('checkpoints last_poll:oge only after executive filings persist', async () => {
    const { env, kvPuts, dbRuns } = fakeEnv();
    quietExecutiveEnv();
    mocks.pollOgeExecutive.mockResolvedValueOnce([ogeFiling]);

    const result = await runWatcher(env, new Date('2026-07-12T15:00:00.000Z'));

    expect(result.executive).toBe('success');
    expect(kvPuts.map(([key]) => key)).toContain('last_poll:oge');

  });

  it('upserts executive filer party + portrait so existing rows refresh on every poll', async () => {
    const { env, dbRuns } = fakeEnv();
    quietExecutiveEnv();
    mocks.pollOgeExecutive.mockResolvedValueOnce([ogeFiling]);

    await runWatcher(env, new Date('2026-07-12T15:00:00.000Z'));

    const filerWrites = dbRuns.filter((run) => /INTO filers/i.test(run.sql));
    expect(filerWrites).toHaveLength(1);
    // ON CONFLICT upsert (NOT INSERT OR IGNORE): pre-existing EXEC-* rows
    // created before party/photo were curated must pick the fields up too.
    expect(filerWrites[0].sql).toMatch(/ON CONFLICT\(bioguide_id\) DO UPDATE SET/i);
    expect(filerWrites[0].sql).toMatch(/photo_url = COALESCE\(excluded\.photo_url, photo_url\)/i);
    expect(filerWrites[0].params).toEqual([
      'EXEC-DJT',
      'executive',
      'Donald J. Trump',
      'R',
      null,
      null,
      'https://upload.wikimedia.org/wikipedia/commons/thumb/1/16/x.jpg/500px-x.jpg',
    ]);
  });

  it('does not checkpoint last_poll:oge when executive persistence fails', async () => {
    const { env, kvPuts } = fakeEnv({}, { throwOnFilingsInsert: true });
    quietExecutiveEnv();
    mocks.pollOgeExecutive.mockResolvedValueOnce([ogeFiling]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    let result;
    try {
      result = await runWatcher(env, new Date('2026-07-12T15:00:00.000Z'));
    } finally {
      warn.mockRestore();
    }

    expect(result?.executive).toBe('failure');
    expect(kvPuts.map(([key]) => key)).not.toContain('last_poll:oge');
  });

  it('supports a bounded OGE dry run without writes, queue handoffs, or checkpointing', async () => {
    const { env, kvPuts, dbRuns, queueSends } = fakeEnv();
    mocks.pollOgeExecutive.mockResolvedValueOnce([
      ogeFiling,
      { ...ogeFiling, docId: 'OGE-2026-0002', sourceUrl: 'https://extapps2.oge.gov/278/0002.pdf' },
    ]);

    const candidates = await pollExecutive(env, new Date('2026-07-12T15:00:00.000Z'), {
      force: true,
      maxFilings: 1,
      dryRun: true,
    });

    expect(candidates).toBe(1);
    expect(dbRuns).toHaveLength(0);
    expect(queueSends).toHaveLength(0);
    expect(kvPuts.map(([key]) => key)).not.toContain('last_poll:oge');
  });

  it('does not retry a failed OGE attempt every minute', async () => {
    const now = new Date('2026-08-05T16:00:00.000Z'); // Wed 12:00 EDT — weekday floor 15 min
    const { env } = fakeEnv({}, {}, {
      'last_attempt:oge': new Date(now.getTime() - 2 * 60_000).toISOString(),
    });
    quietExecutiveEnv();
    mocks.pollOgeExecutive.mockClear();

    const result = await runWatcher(env, now);

    expect(result.executive).toBe('skipped');
    expect(result.executiveCadence?.poll).toBe(true);
    expect(result.executiveCadence?.intervalSec).toBe(900);
    expect(mocks.pollOgeExecutive).not.toHaveBeenCalled();
  });

  it('caps genuinely new OGE persistence and queue handoffs', async () => {
    const { env, kvPuts, queueSends } = fakeEnv();
    mocks.pollOgeExecutive.mockResolvedValueOnce([
      ogeFiling,
      { ...ogeFiling, docId: 'OGE-2026-0002', sourceUrl: 'https://extapps2.oge.gov/278/0002.pdf' },
    ]);

    const inserted = await pollExecutive(env, new Date('2026-07-12T15:00:00.000Z'), {
      force: true,
      maxFilings: 1,
    });

    expect(inserted).toBe(1);
    expect(queueSends).toHaveLength(1);
    expect(kvPuts.map(([key]) => key)).toContain('last_poll:oge');
  });

  // --- Senate lookback: daily deep sweep + outage catch-up -----------------
  const SENATE_NOW = new Date('2026-07-16T15:00:00.000Z'); // Thu 11:00 ET

  function quietHouse() {
    mocks.fetchHouseIndex.mockResolvedValue([]);
    mocks.pollHouseLiveSearch.mockResolvedValue([]);
  }

  function senateSince(): Date {
    expect(mocks.fetchSenatePtrFilings).toHaveBeenCalledTimes(1);
    return mocks.fetchSenatePtrFilings.mock.calls[0][0].since;
  }

  it('widens the senate window to the max lookback on the first poll of a UTC day (deep sweep) and stamps only after success', async () => {
    const { env, kvPuts } = fakeEnv({}, {}, {
      'last_poll:senate': new Date(SENATE_NOW.getTime() - 6 * 3600_000).toISOString(),
    });
    quietHouse();
    mocks.fetchSenatePtrFilings.mockResolvedValueOnce([]);

    const result = await runWatcher(env, SENATE_NOW);

    expect(result.senate).toBe('success');
    expect(senateSince()).toEqual(new Date(SENATE_NOW.getTime() - 30 * 86_400_000));
    expect(kvPuts).toContainEqual(['senate_deep_sweep:lastdate', '2026-07-16']);
  });

  it('uses the base 7-day senate window when polling is healthy and the deep sweep already ran today', async () => {
    const { env } = fakeEnv({}, {}, {
      'senate_deep_sweep:lastdate': '2026-07-16',
      'last_poll:senate': new Date(SENATE_NOW.getTime() - 6 * 3600_000).toISOString(),
    });
    quietHouse();
    mocks.fetchSenatePtrFilings.mockResolvedValueOnce([]);

    await runWatcher(env, SENATE_NOW);

    expect(senateSince()).toEqual(new Date(SENATE_NOW.getTime() - 7 * 86_400_000));
  });

  it('catches up over an outage: a 12-day-stale last success widens the window to cover the gap + 1 day', async () => {
    const { env } = fakeEnv({}, {}, {
      'senate_deep_sweep:lastdate': '2026-07-16',
      'last_poll:senate': new Date(SENATE_NOW.getTime() - 12 * 86_400_000).toISOString(),
    });
    quietHouse();
    mocks.fetchSenatePtrFilings.mockResolvedValueOnce([]);

    await runWatcher(env, SENATE_NOW);

    expect(senateSince()).toEqual(new Date(SENATE_NOW.getTime() - 13 * 86_400_000));
  });

  it('does not consume the day\'s deep sweep when the senate poll fails', async () => {
    const { env, kvPuts } = fakeEnv({}, {}, {
      'last_poll:senate': new Date(SENATE_NOW.getTime() - 6 * 3600_000).toISOString(),
    });
    quietHouse();
    mocks.fetchSenatePtrFilings.mockRejectedValueOnce(new Error('efd 403'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    let result;
    try {
      result = await runWatcher(env, SENATE_NOW);
    } finally {
      warn.mockRestore();
    }

    expect(result?.senate).toBe('failure');
    expect(kvPuts.map(([key]) => key)).not.toContain('senate_deep_sweep:lastdate');
  });

  // --- House year-boundary prior-year sweep --------------------------------
  const JANUARY_NOW = new Date('2026-01-05T15:00:00.000Z'); // Mon Jan 5, 10:00 ET

  it('also sweeps the prior-year House index during the January overlap window', async () => {
    const { env, kvPuts, queueSends } = fakeEnv();
    mocks.fetchHouseIndex.mockImplementation(async (year: number) =>
      year === 2026
        ? [housePtr('30000001')]
        : [{ ...housePtr('29990001'), pipelineDocId: 'H-2025-29990001' }],
    );
    mocks.pollHouseLiveSearch.mockResolvedValue([]);
    mocks.fetchSenatePtrFilings.mockResolvedValue([]);

    await runWatcher(env, JANUARY_NOW);

    expect(mocks.fetchHouseIndex.mock.calls.map((c) => c[0])).toEqual([2026, 2025]);
    expect(queueSends).toEqual(expect.arrayContaining([
      expect.objectContaining({ docId: 'H-2026-30000001' }),
      expect.objectContaining({ docId: 'H-2025-29990001' }),
    ]));
    expect(kvPuts).toContainEqual(['house_prior_year:last_fetch_at', JANUARY_NOW.toISOString()]);
  });

  it('rate-limits the prior-year sweep to one fetch per hour', async () => {
    const { env } = fakeEnv({}, {}, {
      'house_prior_year:last_fetch_at': new Date(JANUARY_NOW.getTime() - 10 * 60_000).toISOString(),
    });
    mocks.fetchHouseIndex.mockResolvedValue([]);
    mocks.pollHouseLiveSearch.mockResolvedValue([]);
    mocks.fetchSenatePtrFilings.mockResolvedValue([]);

    await runWatcher(env, JANUARY_NOW);

    expect(mocks.fetchHouseIndex.mock.calls.map((c) => c[0])).toEqual([2026]);
  });

  it('fails soft when the prior-year sweep errors: current-year filings still land', async () => {
    const { env, kvPuts, queueSends } = fakeEnv();
    mocks.fetchHouseIndex.mockImplementation(async (year: number) => {
      if (year === 2025) throw new Error('prior-year ZIP 500');
      return [housePtr('30000001')];
    });
    mocks.pollHouseLiveSearch.mockResolvedValue([]);
    mocks.fetchSenatePtrFilings.mockResolvedValue([]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await runWatcher(env, JANUARY_NOW);
    } finally {
      warn.mockRestore();
    }

    expect(queueSends).toEqual(expect.arrayContaining([
      expect.objectContaining({ docId: 'H-2026-30000001' }),
    ]));
    expect(kvPuts.map(([key]) => key)).toContain('last_poll:house');
  });

  // --- House live-search failure visibility --------------------------------
  it('escalates to console.error after 12 consecutive live-search failures', async () => {
    const { env, kv } = fakeEnv({ HOUSE_LIVE_SEARCH_ENABLED: 'true' }, {}, {
      'house_live_search:consecutive_failures': '11',
    });
    mocks.fetchHouseIndex.mockResolvedValue([]);
    mocks.pollHouseLiveSearch.mockRejectedValue(new Error('anti-bot 403'));
    mocks.fetchSenatePtrFilings.mockResolvedValue([]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await runWatcher(env, new Date('2026-07-16T15:00:00.000Z'));
      expect(kv.get('house_live_search:consecutive_failures')).toBe('12');
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('failed 12 consecutive polls'),
        'anti-bot 403',
      );
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('warns (not errors) on a sub-threshold live-search failure and resets the counter on success', async () => {
    const { env, kv } = fakeEnv({ HOUSE_LIVE_SEARCH_ENABLED: 'true' }, {}, {
      'house_live_search:consecutive_failures': '4',
    });
    mocks.fetchHouseIndex.mockResolvedValue([]);
    mocks.pollHouseLiveSearch.mockRejectedValueOnce(new Error('flaky'));
    mocks.fetchSenatePtrFilings.mockResolvedValue([]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await runWatcher(env, new Date('2026-07-16T15:00:00.000Z'));
      expect(kv.get('house_live_search:consecutive_failures')).toBe('5');
      expect(error).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }

    // A later successful overlay resets the streak.
    const second = fakeEnv({ HOUSE_LIVE_SEARCH_ENABLED: 'true' }, {}, { 'house_live_search:consecutive_failures': '5' });
    mocks.pollHouseLiveSearch.mockResolvedValueOnce([]);
    await runWatcher(second.env, new Date('2026-07-16T16:00:00.000Z'));
    expect(second.kv.get('house_live_search:consecutive_failures')).toBe('0');
  });
});

// CT-2442: eFD's Akamai edge refuses the agreement POST for automated clients.
// The watcher must back off politely, keep that across restarts, and say what
// is blocked.  fetchSenatePtrFilings is mocked; fetch itself throws, so nothing
// here can reach the network.
describe('runWatcher senate eFD edge deny (CT-2442)', () => {
  // Monday 10:00 AM.  With no senate success on record, senate is due on every tick.
  const T0 = new Date('2026-10-26T15:00:00.000Z');
  const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
  const BACKOFF_KEY = 'senate_edge_deny:backoff';
  const edgeDeny = () =>
    new SenateHttpError('POST /search/home/', 403, 'AkamaiGHost', { body: '<TITLE>Access Denied</TITLE>' });

  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.pollOgeExecutive.mockResolvedValue(null);
    mocks.fetchHouseIndex.mockResolvedValue([]);
    mocks.pollHouseLiveSearch.mockResolvedValue([]);
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('network disabled in tests');
    }));
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const edgeLines = (spy: ReturnType<typeof vi.spyOn>) =>
    spy.mock.calls.filter(([msg]) => /senate eFD edge denied/.test(String(msg)));

  it('backs off 60 minutes after an edge deny, doubles up to 6 hours, and resets on success', async () => {
    const { env, kv, dbRuns } = fakeEnv();
    mocks.fetchSenatePtrFilings.mockRejectedValue(edgeDeny());

    const first = await runWatcher(env, T0);
    expect(first.senate).toBe('failure');
    expect(first.senateEdgeBackoffUntil).toBe(at(60).toISOString());
    expect(JSON.parse(kv.get(BACKOFF_KEY)!)).toMatchObject({ consecutive: 1, windowMs: 3_600_000 });
    const receipt = dbRuns.filter((r) => /INSERT INTO source_attempts/i.test(r.sql) && r.params[0] === 'senate');
    expect(receipt.map((r) => [r.params[2], r.params[4]])).toEqual([
      ['failure', 'senate POST /search/home/ -> HTTP 403 (server=AkamaiGHost) [edge_denied]'],
    ]);

    // Past the 600 s failure skip, inside the window: no request.
    const inside = await runWatcher(env, at(30));
    expect(inside.senate).toBe('skipped');
    expect(inside.senateCadence?.poll).toBe(true);
    expect(inside.senateEdgeBackoffUntil).toBe(at(60).toISOString());
    expect(mocks.fetchSenatePtrFilings).toHaveBeenCalledTimes(1);

    const second = await runWatcher(env, at(61));
    expect(mocks.fetchSenatePtrFilings).toHaveBeenCalledTimes(2);
    expect(second.senateEdgeBackoffUntil).toBe(at(61 + 120).toISOString());
    await runWatcher(env, at(61 + 119));
    expect(mocks.fetchSenatePtrFilings).toHaveBeenCalledTimes(2);

    expect((await runWatcher(env, at(181))).senateEdgeBackoffUntil).toBe(at(181 + 240).toISOString());
    expect((await runWatcher(env, at(421))).senateEdgeBackoffUntil).toBe(at(421 + 360).toISOString());
    // Capped at 6 hours.
    expect((await runWatcher(env, at(781))).senateEdgeBackoffUntil).toBe(at(781 + 360).toISOString());
    expect(mocks.fetchSenatePtrFilings).toHaveBeenCalledTimes(5);
    expect(JSON.parse(kv.get(BACKOFF_KEY)!)).toMatchObject({ consecutive: 5, firstDeniedAt: T0.toISOString() });

    // eFD accepts again: success clears the backoff.
    mocks.fetchSenatePtrFilings.mockResolvedValue([]);
    const ok = await runWatcher(env, at(1141));
    expect(ok.senate).toBe('success');
    expect(ok.senateEdgeBackoffUntil).toBeUndefined();
    expect(kv.has(BACKOFF_KEY)).toBe(false);

    // The next deny starts over at 60 minutes.
    mocks.fetchSenatePtrFilings.mockRejectedValue(edgeDeny());
    const again = await runWatcher(env, at(1141 + 120));
    expect(again.senateEdgeBackoffUntil).toBe(at(1141 + 120 + 60).toISOString());
    expect(JSON.parse(kv.get(BACKOFF_KEY)!)).toMatchObject({ consecutive: 1 });
  });

  it('keeps the backoff across a restart (the state lives in CONFIG_KV)', async () => {
    const first = fakeEnv();
    mocks.fetchSenatePtrFilings.mockRejectedValue(edgeDeny());
    await runWatcher(first.env, T0);

    const restarted = fakeEnv({}, {}, Object.fromEntries(first.kv));
    const result = await runWatcher(restarted.env, at(45));

    expect(result.senate).toBe('skipped');
    expect(result.senateEdgeBackoffUntil).toBe(at(60).toISOString());
    expect(mocks.fetchSenatePtrFilings).toHaveBeenCalledTimes(1);
  });

  it('says what is blocked, at error once per episode, and never claims a Senate bulk path', async () => {
    const { env } = fakeEnv();
    mocks.fetchSenatePtrFilings.mockRejectedValue(edgeDeny());
    await runWatcher(env, T0);
    await runWatcher(env, at(61));

    expect(edgeLines(error)).toHaveLength(1);
    expect(edgeLines(warn)).toHaveLength(1);
    // One argument: the line itself, built from the classified fields.
    expect(edgeLines(error)[0]).toHaveLength(1);
    const line = String(edgeLines(error)[0][0]);
    expect(line).toContain('Senate PTR discovery and document fetch are blocked while eFD refuses the agreement');
    expect(line).toContain(`next senate attempt after ${at(60).toISOString()} (60m backoff)`);
    expect(line).toContain('[source=senate class=edge_denied step="POST /search/home/" status=403 server=AkamaiGHost]');
    expect(String(edgeLines(warn)[0][0])).toContain('(2 in a row since');
    expect(edgeLines(warn)[0]).toHaveLength(1);

    // A transient senate failure no longer claims a bulk path either.
    const other = fakeEnv();
    mocks.fetchSenatePtrFilings.mockRejectedValue(new Error('senate POST report/data/ -> HTTP 429 (server=gunicorn)'));
    await runWatcher(other.env, T0);
    expect(warn).toHaveBeenCalledWith(
      'watcher: senate source degraded (transient, no alternate Senate discovery path):',
      'senate POST report/data/ -> HTTP 429 (server=gunicorn)',
    );

    const lines = [...warn.mock.calls, ...error.mock.calls].map(([msg]) => String(msg));
    expect(lines.some((msg) => /senate/.test(msg) && /bulk path/.test(msg))).toBe(false);
  });

  it('logs, stores and backs off on the classified fields only, never the raw error text (Kody, #2846)', async () => {
    const { env, kv, dbRuns } = fakeEnv();
    // An edge deny whose message carries upstream text and a credential.
    const raw = new SenateHttpError('POST /search/home/', 403, 'AkamaiGHost\r\n<x>', {
      body: '<TITLE>Access Denied</TITLE>',
      detail: 'via http://mango:hunter22@10.99.0.2:8888 <b>upstream page</b>',
    });
    expect(raw.message).toContain('hunter22');
    mocks.fetchSenatePtrFilings.mockRejectedValue(raw);

    await runWatcher(env, T0);
    await runWatcher(env, at(61));

    const lines = [...edgeLines(error), ...edgeLines(warn)];
    expect(lines).toHaveLength(2);
    for (const args of lines) {
      expect(args).toHaveLength(1);
      expect(String(args[0])).not.toMatch(/hunter22|mango|upstream page|<x>|\r/);
      expect(String(args[0])).toContain('server=AkamaiGHostx');
    }
    const receipts = dbRuns
      .filter((r) => /INSERT INTO source_attempts/i.test(r.sql) && r.params[0] === 'senate')
      .map((r) => r.params[4]);
    expect(receipts).toEqual([
      'senate POST /search/home/ -> HTTP 403 (server=AkamaiGHostx) [edge_denied]',
      'senate POST /search/home/ -> HTTP 403 (server=AkamaiGHostx) [edge_denied]',
    ]);
    expect(JSON.parse(kv.get(BACKOFF_KEY)!).reason).toBe('senate POST /search/home/ -> HTTP 403 (server=AkamaiGHostx) [edge_denied]');
  });

  it('scrubs proxy credentials from other senate failure text before logging or storing it', async () => {
    const PROXY = 'http://mango-user:s3cr3t-pw@10.99.0.2:8888';
    const { env, dbRuns } = fakeEnv({ RESIDENTIAL_PROXY_URL: PROXY } as unknown as Parameters<typeof fakeEnv>[0]);
    mocks.fetchSenatePtrFilings.mockRejectedValue(
      new Error(`senate GET /search/ -> HTTP 429 via ${PROXY}/ (auth s3cr3t-pw rejected)`),
    );

    await runWatcher(env, T0);

    const logged = [...warn.mock.calls, ...error.mock.calls].filter(([msg]) => /senate source/.test(String(msg)));
    expect(logged).toHaveLength(1);
    expect(logged[0][1]).toBe('senate GET /search/ -> HTTP 429 via [redacted]/ (auth [redacted] rejected)');
    const receipt = dbRuns.find((r) => /INSERT INTO source_attempts/i.test(r.sql) && r.params[0] === 'senate');
    expect(receipt?.params[4]).toBe('senate GET /search/ -> HTTP 429 via [redacted]/ (auth [redacted] rejected)');
    expect(JSON.stringify([...warn.mock.calls, ...error.mock.calls])).not.toContain('s3cr3t-pw');
  });

  it('keeps the 600 s failure skip, not the long backoff, for an origin 403', async () => {
    const { env, kv } = fakeEnv();
    mocks.fetchSenatePtrFilings.mockRejectedValue(new SenateHttpError('POST report/data/', 403, 'gunicorn'));

    const first = await runWatcher(env, T0);
    expect(first.senate).toBe('failure');
    expect(first.senateEdgeBackoffUntil).toBeUndefined();
    expect(kv.has(BACKOFF_KEY)).toBe(false);

    await runWatcher(env, at(5));
    expect(mocks.fetchSenatePtrFilings).toHaveBeenCalledTimes(1);
    await runWatcher(env, at(11));
    expect(mocks.fetchSenatePtrFilings).toHaveBeenCalledTimes(2);
  });

  it('logs a residential-proxy outage at error, not as a transient 403, and does not back off', async () => {
    const { env, kv } = fakeEnv();
    const outage = new SenateProxyEgressError(
      'senate proxy gave no HTTP answer within 3000ms',
      'senate GET /search/ -> HTTP 403 (server=AkamaiGHost)',
    );
    mocks.fetchSenatePtrFilings.mockRejectedValue(outage);

    const result = await runWatcher(env, T0);

    expect(result.senate).toBe('failure');
    expect(result.senateEdgeBackoffUntil).toBeUndefined();
    expect(kv.has(BACKOFF_KEY)).toBe(false);
    expect(error).toHaveBeenCalledWith('watcher: senate source failed:', outage.message);
    expect(warn.mock.calls.some(([msg]) => /senate source degraded/.test(String(msg)))).toBe(false);
  });

  it('skips the proxied eFD probe while the edge-deny backoff is active, then dials it at most every 30 minutes', async () => {
    const PROXY = 'http://10.99.0.2:8888';
    const { env, kv } = fakeEnv({ RESIDENTIAL_PROXY_URL: PROXY } as unknown as Parameters<typeof fakeEnv>[0]);
    const efdCalls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      // The residential proxy's own liveness hop.
      if (url === 'http://example.com/') return new Response('ok', { status: 200 });
      if (url.startsWith('https://efdsearch.senate.gov/')) {
        efdCalls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
        if (url.endsWith('/search/home/')) return new Response('', { status: 302 });
        return new Response('<input type="hidden" name="csrfmiddlewaretoken" value="t">', {
          status: 200,
          headers: { 'set-cookie': 'csrftoken=c; Path=/' },
        });
      }
      throw new TypeError('network disabled in tests');
    }));
    mocks.fetchSenatePtrFilings.mockRejectedValue(edgeDeny());

    // The poll is edge-denied, so the probe that runs after it in the same
    // tick, and on every tick inside the window, sends eFD nothing.
    await runWatcher(env, T0);
    expect(kv.has(BACKOFF_KEY)).toBe(true);
    await runWatcher(env, at(30));
    expect(efdCalls).toEqual([]);

    // eFD accepts the poll after the window: the backoff clears and the probe dials.
    mocks.fetchSenatePtrFilings.mockResolvedValue([]);
    await runWatcher(env, at(61));
    expect(kv.has(BACKOFF_KEY)).toBe(false);
    expect(efdCalls).toEqual(['GET /search/', 'POST /search/home/']);
    expect(JSON.parse(kv.get('senate-efd:health')!)).toMatchObject({ state: 'ok', egress: 'proxy' });

    // Then at most every 30 minutes.
    await runWatcher(env, at(62));
    await runWatcher(env, at(90));
    expect(efdCalls).toHaveLength(2);
    await runWatcher(env, at(91));
    expect(efdCalls).toHaveLength(4);
  });
});

describe('computeSenateLookbackDays', () => {
  const NOW = new Date('2026-07-16T15:00:00.000Z');
  const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

  it('stays on the base window while polling is healthy', () => {
    expect(computeSenateLookbackDays(NOW, daysAgo(0.1), 7, 30, false)).toBe(7);
    expect(computeSenateLookbackDays(NOW, daysAgo(5), 7, 30, false)).toBe(7);
  });

  it('covers an outage gap with one day of margin', () => {
    expect(computeSenateLookbackDays(NOW, daysAgo(12), 7, 30, false)).toBe(13);
  });

  it('caps outage catch-up at the max window', () => {
    expect(computeSenateLookbackDays(NOW, daysAgo(90), 7, 30, false)).toBe(30);
  });

  it('uses the max window for the daily deep sweep and when there is no success on record', () => {
    expect(computeSenateLookbackDays(NOW, daysAgo(0.1), 7, 30, true)).toBe(30);
    expect(computeSenateLookbackDays(NOW, null, 7, 30, false)).toBe(30);
  });

  it('never shrinks below the base window even if max is misconfigured lower', () => {
    expect(computeSenateLookbackDays(NOW, daysAgo(0.1), 7, 3, true)).toBe(7);
  });
});

describe('inHousePriorYearWindow', () => {
  it('is true within the first N days of January (ET)', () => {
    expect(inHousePriorYearWindow(new Date('2026-01-05T15:00:00.000Z'), 14)).toBe(true);
    expect(inHousePriorYearWindow(new Date('2026-01-14T15:00:00.000Z'), 14)).toBe(true);
  });

  it('is false after the window, in other months, and when disabled', () => {
    expect(inHousePriorYearWindow(new Date('2026-01-15T15:00:00.000Z'), 14)).toBe(false);
    expect(inHousePriorYearWindow(new Date('2026-02-01T15:00:00.000Z'), 14)).toBe(false);
    expect(inHousePriorYearWindow(new Date('2026-01-05T15:00:00.000Z'), 0)).toBe(false);
  });

  it('evaluates the boundary in ET, not UTC', () => {
    // Jan 1 00:30 UTC is still Dec 31 19:30 ET -> outside the window.
    expect(inHousePriorYearWindow(new Date('2026-01-01T00:30:00.000Z'), 14)).toBe(false);
    // Jan 1 15:00 UTC is Jan 1 10:00 ET -> inside.
    expect(inHousePriorYearWindow(new Date('2026-01-01T15:00:00.000Z'), 14)).toBe(true);
  });
});

describe('bulk-window discovery alert', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.pollOgeExecutive.mockResolvedValue(null);
  });

  function disc(docId: string, filedDate: string | null, via: 'live' | 'bulk') {
    return {
      docId: `H-2026-${docId}`,
      chamber: 'house' as const,
      sourceUrl: `https://example.test/${docId}.pdf`,
      filedDate,
      filerName: 'Jane Smith',
      discoveredVia: via,
    };
  }

  it('flags a bulk-discovered filing older than the threshold', async () => {
    const { findStaleBulkDiscoveries } = await import('../watcher.ts');
    const alerts = findStaleBulkDiscoveries(
      [disc('20035648', '2026-10-14', 'bulk')],
      '2026-10-15T13:12:00.000Z',
      '0',
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      docId: 'H-2026-20035648',
      filerName: 'Jane Smith',
      filedDate: '2026-10-14',
      discoveredAt: '2026-10-15T13:12:00.000Z',
      liveSearchFails: '0',
    });
    // Day-only filed_date counts from the END of that day in ET (EDT: 2026-10-15T04:00Z).
    expect(alerts[0].hoursLate).toBe(9.2);
  });

  it('does not flag a same-day bulk discovery at the morning refresh (M/D/YYYY filed date)', async () => {
    const { findStaleBulkDiscoveries } = await import('../watcher.ts');
    // The House XML reports FilingDate as M/D/YYYY with no time of day.  Read as
    // midnight UTC this filing would look ~13h late at the ~13:00Z refresh.
    const alerts = findStaleBulkDiscoveries(
      [disc('20035660', '10/15/2026', 'bulk')],
      '2026-10-15T13:12:00.000Z',
      '0',
    );
    expect(alerts).toHaveLength(0);
  });

  it('treats M/D/YYYY and YYYY-MM-DD filed dates the same', async () => {
    const { findStaleBulkDiscoveries } = await import('../watcher.ts');
    const now = '2026-10-15T13:12:00.000Z';
    const us = findStaleBulkDiscoveries([disc('20035661', '10/14/2026', 'bulk')], now, '0');
    const iso = findStaleBulkDiscoveries([disc('20035661', '2026-10-14', 'bulk')], now, '0');
    expect(us).toHaveLength(1);
    expect(us[0].hoursLate).toBe(9.2);
    expect(iso[0].hoursLate).toBe(us[0].hoursLate);
  });

  it('measures day-only filed dates against the ET day boundary in both EST and EDT', async () => {
    const { findStaleBulkDiscoveries } = await import('../watcher.ts');
    // EST (UTC-5): end of 2026-12-01 ET is 2026-12-02T05:00Z.
    expect(
      findStaleBulkDiscoveries([disc('20035662', '2026-12-01', 'bulk')], '2026-12-02T08:00:00.000Z', '0'),
    ).toHaveLength(0); // 3h after the day ended: under the threshold
    const est = findStaleBulkDiscoveries([disc('20035662', '2026-12-01', 'bulk')], '2026-12-02T10:00:00.000Z', '0');
    expect(est).toHaveLength(1);
    expect(est[0].hoursLate).toBe(5);
    // EDT (UTC-4): end of 2026-10-14 ET is 2026-10-15T04:00Z.
    expect(
      findStaleBulkDiscoveries([disc('20035663', '2026-10-14', 'bulk')], '2026-10-15T07:00:00.000Z', '0'),
    ).toHaveLength(0);
    const edt = findStaleBulkDiscoveries([disc('20035663', '2026-10-14', 'bulk')], '2026-10-15T09:00:00.000Z', '0');
    expect(edt).toHaveLength(1);
    expect(edt[0].hoursLate).toBe(5);
  });

  it('stays silent for empty or malformed filed dates and an unparseable discovery time', async () => {
    const { findStaleBulkDiscoveries } = await import('../watcher.ts');
    const now = '2026-10-15T13:12:00.000Z';
    expect(findStaleBulkDiscoveries([disc('20035664', '', 'bulk')], now, '0')).toHaveLength(0);
    expect(findStaleBulkDiscoveries([disc('20035665', 'not-a-date', 'bulk')], now, '0')).toHaveLength(0);
    expect(findStaleBulkDiscoveries([disc('20035666', '13/45/2026', 'bulk')], now, '0')).toHaveLength(0);
    expect(findStaleBulkDiscoveries([disc('20035667', '2026-10-01', 'bulk')], '', '0')).toHaveLength(0);
    expect(findStaleBulkDiscoveries([disc('20035668', '2026-10-01', 'bulk')], 'garbage', '0')).toHaveLength(0);
  });

  it('stays silent for a bulk-discovered filing under the threshold', async () => {
    const { findStaleBulkDiscoveries } = await import('../watcher.ts');
    // Filed 2h before discovery — normal Clerk publication lag
    const alerts = findStaleBulkDiscoveries(
      [disc('20035649', '2026-10-15T11:12:00.000Z', 'bulk')],
      '2026-10-15T13:12:00.000Z',
      '0',
    );
    expect(alerts).toHaveLength(0);
  });

  it('stays silent for live-search discoveries even when old', async () => {
    const { findStaleBulkDiscoveries } = await import('../watcher.ts');
    const alerts = findStaleBulkDiscoveries(
      [disc('20035650', '2026-10-10', 'live')],
      '2026-10-15T13:12:00.000Z',
      '0',
    );
    expect(alerts).toHaveLength(0);
  });

  it('stays silent when filed_date is missing', async () => {
    const { findStaleBulkDiscoveries } = await import('../watcher.ts');
    const alerts = findStaleBulkDiscoveries(
      [disc('20035651', null, 'bulk')],
      '2026-10-15T13:12:00.000Z',
      '0',
    );
    expect(alerts).toHaveLength(0);
  });

  it('persists discovered_via=bulk for bulk index filings', async () => {
    const { env, dbRuns } = fakeEnv();
    mocks.fetchHouseIndex.mockResolvedValue([{
      pipelineDocId: 'H-2026-20035648',
      sourceUrl: 'https://example.test/20035648.pdf',
      filingDate: '2026-10-14',
      first: 'Jane', last: 'Smith', stateDst: 'CA01', isPtr: true,
    }]);
    mocks.pollHouseLiveSearch.mockResolvedValue([]);
    mocks.fetchSenatePtrFilings.mockResolvedValue([]);
    await runWatcher(env, new Date('2026-10-15T13:12:00.000Z'));
    const inserts = dbRuns.filter((r) => /INSERT OR IGNORE INTO filings/i.test(r.sql));
    expect(inserts).toHaveLength(1);
    expect(inserts[0].sql).toContain('discovered_via');
    expect(inserts[0].params[inserts[0].params.length - 1]).toBe('bulk');
  });

  it('attributes a filing seen by BOTH bulk and live search to live and keeps its bulk filed_date', async () => {
    const { env, dbRuns } = fakeEnv();
    const row = {
      pipelineDocId: 'H-2026-20035670',
      sourceUrl: 'https://example.test/20035670.pdf',
      filingDate: '2026-10-14',
      first: 'Jane', last: 'Smith', stateDst: 'CA01', isPtr: true,
    };
    mocks.fetchHouseIndex.mockResolvedValue([row]);
    // The live-search HTML carries no FilingDate.
    mocks.pollHouseLiveSearch.mockResolvedValue([{ ...row, filingDate: '' }]);
    mocks.fetchSenatePtrFilings.mockResolvedValue([]);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runWatcher(env, new Date('2026-10-15T13:12:00.000Z'));
      const inserts = dbRuns.filter((r) => /INSERT OR IGNORE INTO filings/i.test(r.sql));
      expect(inserts).toHaveLength(1);
      expect(inserts[0].params[3]).toBe('2026-10-14'); // filed_date from the bulk record
      expect(inserts[0].params[inserts[0].params.length - 1]).toBe('live');
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes('first discovered via BULK'))).toBe(false);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('logs the stale bulk alert end to end for a bulk-only filing the live search missed', async () => {
    const { env } = fakeEnv();
    mocks.fetchHouseIndex.mockResolvedValue([{
      pipelineDocId: 'H-2026-20035671',
      sourceUrl: 'https://example.test/20035671.pdf',
      filingDate: '10/14/2026',
      first: 'Jane', last: 'Smith', stateDst: 'CA01', isPtr: true,
    }]);
    mocks.pollHouseLiveSearch.mockResolvedValue([]);
    mocks.fetchSenatePtrFilings.mockResolvedValue([]);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runWatcher(env, new Date('2026-10-15T13:12:00.000Z'));
      const msgs = errSpy.mock.calls.map((c) => String(c[0]));
      expect(msgs.some((m) => m.includes('H-2026-20035671') && m.includes('9.2h late'))).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('persists discovered_via=live for live-search-only filings', async () => {
    const { env, dbRuns } = fakeEnv();
    mocks.fetchHouseIndex.mockResolvedValue([]);
    mocks.pollHouseLiveSearch.mockResolvedValue([{
      pipelineDocId: 'H-2026-20035650',
      sourceUrl: 'https://example.test/20035650.pdf',
      filingDate: '2026-10-10',
      first: 'Jane', last: 'Smith', stateDst: 'CA01', isPtr: true,
    }]);
    mocks.fetchSenatePtrFilings.mockResolvedValue([]);
    await runWatcher(env, new Date('2026-10-15T13:12:00.000Z'));
    const inserts = dbRuns.filter((r) => /INSERT OR IGNORE INTO filings/i.test(r.sql));
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params[inserts[0].params.length - 1]).toBe('live');
  });
});
