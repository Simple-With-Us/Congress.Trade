import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../../shared/types.ts';

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

vi.mock('../senateSource', () => ({
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
      async get(key: string) {
        return kv.get(key) ?? null;
      },
      async put(key: string, value: string) {
        kv.set(key, value);
        kvPuts.push([key, value]);
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
    const { env, kv } = fakeEnv({}, {}, {
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
    const { env, kv } = fakeEnv({}, {}, {
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
    const second = fakeEnv({}, {}, { 'house_live_search:consecutive_failures': '5' });
    mocks.pollHouseLiveSearch.mockResolvedValueOnce([]);
    await runWatcher(second.env, new Date('2026-07-16T16:00:00.000Z'));
    expect(second.kv.get('house_live_search:consecutive_failures')).toBe('0');
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
