import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../shared/types.ts';

// Every collaborator maybeRunDailyJobs calls out to is mocked so this test is
// purely about how the daily-jobs entry point resolves + wires
// FMP_MAX_PER_MINUTE / EDGAR_MAX_PER_MINUTE, not about enrichment/price/share
// business logic (those have their own test suites).
const mocks = vi.hoisted(() => ({
  resolveSecrets: vi.fn(),
  getDailyUsed: vi.fn(),
  runEnrichment: vi.fn(),
  runPriceRefresh: vi.fn(),
  hasFmpTierFailure: vi.fn(),
  notifyAdmin: vi.fn(),
  shareWithPeer: vi.fn(),
  runFreshnessCheck: vi.fn(),
  runPhotoEnrichment: vi.fn(),
  runTickerBackfill: vi.fn(),
  runBulkSnapshot: vi.fn(),
  runCommitteeSync: vi.fn(),
  runIdentitySync: vi.fn(),
  backfillCurrentPricesFromEod: vi.fn(),
  createUsageTelemetryClient: vi.fn(),
  isD1RowBudgetExceeded: vi.fn(),
  dbRun: vi.fn(),
}));

vi.mock('../secrets/infisical', () => ({
  resolveSecrets: mocks.resolveSecrets,
}));
vi.mock('../enrichment/service', () => ({
  getDailyUsed: mocks.getDailyUsed,
  runEnrichment: mocks.runEnrichment,
  DEFAULT_DAILY_CAP: 230,
}));
vi.mock('../prices/service', () => ({
  runPriceRefresh: mocks.runPriceRefresh,
  backfillCurrentPricesFromEod: mocks.backfillCurrentPricesFromEod,
}));
vi.mock('../shared/fmpStatus', () => ({
  hasFmpTierFailure: mocks.hasFmpTierFailure,
}));
vi.mock('../alerts/notify', () => ({
  notifyAdmin: mocks.notifyAdmin,
}));
vi.mock('../share/outbound', () => ({
  shareWithPeer: mocks.shareWithPeer,
}));
vi.mock('../share/freshness', () => ({
  runFreshnessCheck: mocks.runFreshnessCheck,
}));
vi.mock('../admin/routes', () => ({
  runPhotoEnrichment: mocks.runPhotoEnrichment,
  runTickerBackfill: mocks.runTickerBackfill,
}));
vi.mock('../enrichment/committeeSync', () => ({
  runCommitteeSync: mocks.runCommitteeSync,
}));
vi.mock('../enrichment/identitySync', () => ({
  runIdentitySync: mocks.runIdentitySync,
}));
vi.mock('../export/snapshot', () => ({
  runBulkSnapshot: mocks.runBulkSnapshot,
}));
vi.mock('../../vendor/congress-trading-shared/dist/index.mjs', () => ({
  createUsageTelemetryClient: mocks.createUsageTelemetryClient,
}));
vi.mock('../shared/d1Budget', () => ({
  isD1RowBudgetExceeded: mocks.isD1RowBudgetExceeded,
}));
// Only `run` is stubbed (retention sweep DELETEs); everything else stays real
// so transitive importers of shared/db keep their actual helpers.
vi.mock('../shared/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared/db.ts')>()),
  run: mocks.dbRun,
}));

import {
  maybeRunDailyJobs,
  runHourlyEnrichmentSlice,
  HOURLY_ENRICHMENT_SLICE_MAX,
  HOURLY_ENRICHMENT_SLICE_DEADLINE_MS,
  maybeRunDailySnapshotJob,
  maybeRunDailyFilerJobs,
  maybeRunDailyRetentionJobs,
  runRetentionSweep,
  RETENTION_POLICIES,
  RETENTION_DELETE_BATCH,
  RETENTION_MAX_BATCHES_PER_TABLE,
  RETENTION_MAX_ROWS_PER_RUN,
} from '../jobs.ts';

function fakeEnv(): Env {
  const kv = new Map<string, string>();
  return {
    CONFIG_KV: {
      async get(key: string) {
        return kv.get(key) ?? null;
      },
      async put(key: string, value: string) {
        kv.set(key, value);
      },
    },
  } as unknown as Env;
}

describe('maybeRunDailyJobs secret resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveSecrets.mockResolvedValue({});
    mocks.isD1RowBudgetExceeded.mockResolvedValue(false);
    mocks.getDailyUsed.mockResolvedValue(0);
    mocks.runEnrichment.mockResolvedValue({
      hasFmpKey: false,
      dailyCap: null,
      fmpCalls: 0,
      errors: [],
      shareRefs: [],
      scanned: 0,
      enriched: 0,
    });
    mocks.runPriceRefresh.mockResolvedValue({
      hasFmpKey: false,
      fmpCalls: 0,
      errors: [],
      sharePrices: [],
      shareSpx: [],
    });
    mocks.hasFmpTierFailure.mockReturnValue(false);
    mocks.shareWithPeer.mockResolvedValue({ sent: false, reason: 'not configured' });
    mocks.runFreshnessCheck.mockResolvedValue([]);
    mocks.runBulkSnapshot.mockResolvedValue({ tables: {} });
    mocks.runPhotoEnrichment.mockResolvedValue({ filers: 0, matched: 0, unmatched: 0, upgraded: 0 });
    mocks.runTickerBackfill.mockResolvedValue(undefined);
    mocks.runCommitteeSync.mockResolvedValue({ filersScanned: 0, updated: 0, skipped: 0, unmatched: 0, noBioguide: 0, sourceBioguides: 0 });
    mocks.runIdentitySync.mockResolvedValue({ filersScanned: 0, bioguideResolved: 0, displayNamesSet: 0, fieldsBackfilled: 0, cleaned: 0, unresolved: 0, dryRun: false });
    mocks.backfillCurrentPricesFromEod.mockResolvedValue({ currentPriceFilled: 0, latestDateFilled: 0 });
    mocks.dbRun.mockResolvedValue({ meta: { changes: 0 } });
  });

  it('runs the retention sweep as part of the daily pass, one bounded DELETE per table', async () => {
    const env = fakeEnv();

    await maybeRunDailyJobs(env, new Date('2026-07-10T00:00:00Z'));

    const sqls = mocks.dbRun.mock.calls.map(([, sql]) => sql as string);
    for (const policy of RETENTION_POLICIES) {
      const del = sqls.filter((s) => s.includes(`DELETE FROM ${policy.table}`) && (!policy.where || s.includes(policy.where)));
      // changes:0 on the first batch → exactly one bounded DELETE per table policy.
      expect(del).toHaveLength(1);
      expect(del[0]).toContain(`${policy.column} < ?`);
      expect(del[0]).toContain('LIMIT ?');
    }
    // Cutoff + LIMIT params: ISO cutoff `days` before `now`, batch-size LIMIT.
    const [, dlqSql, dlqParams] = mocks.dbRun.mock.calls.find(([, sql]) =>
      (sql as string).includes('DELETE FROM dead_letter_events'),
    )!;
    expect(dlqSql).toContain('IN (SELECT id FROM dead_letter_events');
    expect(dlqParams).toEqual([
      new Date(Date.parse('2026-07-10T00:00:00Z') - 30 * 86_400_000).toISOString(),
      RETENTION_DELETE_BATCH,
    ]);
  });

  it('caps retention batches per table when the backlog never drains', async () => {
    // Every DELETE reports a full batch → the loop must stop at the cap
    // instead of spinning until the table is empty.
    mocks.dbRun.mockResolvedValue({ meta: { changes: RETENTION_DELETE_BATCH } });

    const deleted = await runRetentionSweep(fakeEnv(), new Date('2026-07-10T00:00:00Z'));

    const expectedCalls = Math.min(
      RETENTION_POLICIES.length * RETENTION_MAX_BATCHES_PER_TABLE,
      Math.ceil(RETENTION_MAX_ROWS_PER_RUN / RETENTION_DELETE_BATCH),
    );
    expect(mocks.dbRun).toHaveBeenCalledTimes(expectedCalls);
  });

  it('retention failure on one table does not abort the others or the daily run', async () => {
    mocks.dbRun.mockImplementation(async (_db: unknown, sql: string) => {
      if (sql.includes('ingest_log')) throw new Error('no such table: ingest_log');
      return { meta: { changes: 0 } };
    });

    const deleted = await runRetentionSweep(fakeEnv(), new Date('2026-07-10T00:00:00Z'));

    expect(deleted).toEqual({
      dead_letter_events: 0,
      ingest_log: 0,
      source_attempts: 0,
      peer_import_receipts: 0,
      deno_runtime_queue_completed: 0,
      deno_runtime_queue_failed: 0,
      ingestion_outbox_completed: 0,
      delivery_outbox_completed: 0,
    });
  });

  it('folds FMP_MAX_PER_MINUTE and EDGAR_MAX_PER_MINUTE into the market-data lane resolveSecrets call alongside the USAGE_MONITOR_* vars', async () => {
    const env = fakeEnv();

    await maybeRunDailyJobs(env, new Date('2026-07-10T00:00:00Z'));

    // The market-data lane resolves pacing + telemetry vars in ONE call (not
    // per var). Since the staggered-lane split, the retention lane separately
    // resolves its own R2-usage/Pushover keys, so assert on the FIRST call
    // rather than an exact total count.
    const [, keys] = mocks.resolveSecrets.mock.calls[0];
    expect(keys).toEqual(
      expect.arrayContaining([
        'FMP_MAX_PER_MINUTE',
        'EDGAR_MAX_PER_MINUTE',
        'USAGE_MONITOR_ENABLED',
        'USAGE_MONITOR_INGEST_URL',
        'USAGE_MONITOR_INGEST_TOKEN',
        'USAGE_MONITOR_ENVIRONMENT',
      ]),
    );
  });

  it('passes the resolved FMP_MAX_PER_MINUTE / EDGAR_MAX_PER_MINUTE through to runEnrichment/runPriceRefresh as maxPerMinute/edgarMaxPerMinute', async () => {
    const env = fakeEnv();
    mocks.resolveSecrets.mockResolvedValue({
      FMP_MAX_PER_MINUTE: '123',
      EDGAR_MAX_PER_MINUTE: '456',
    });

    await maybeRunDailyJobs(env, new Date('2026-07-10T00:00:00Z'));

    expect(mocks.runEnrichment).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ maxPerMinute: 123, edgarMaxPerMinute: 456 }),
    );
    expect(mocks.runPriceRefresh).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ maxPerMinute: 123 }),
    );
  });

  it('falls back to undefined (no pacing) when resolveSecrets yields nothing for either var, matching prior unset behavior', async () => {
    const env = fakeEnv();
    mocks.resolveSecrets.mockResolvedValue({});

    await maybeRunDailyJobs(env, new Date('2026-07-10T00:00:00Z'));

    expect(mocks.runEnrichment).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ maxPerMinute: undefined, edgarMaxPerMinute: undefined }),
    );
  });

  it('re-checks the D1 budget between expensive daily stages', async () => {
    const env = fakeEnv();
    mocks.isD1RowBudgetExceeded
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await maybeRunDailyJobs(env, new Date('2026-07-10T00:00:00Z'));

    expect(mocks.runEnrichment).toHaveBeenCalledTimes(1);
    expect(mocks.runPriceRefresh).not.toHaveBeenCalled();
    expect(mocks.runBulkSnapshot).not.toHaveBeenCalled();
    expect(mocks.isD1RowBudgetExceeded).toHaveBeenCalledTimes(2);
  });

  describe('enrichment is not capped by an FMP day budget', () => {
    it('does not pass an FMP budget max when an FMP key is configured', async () => {
      const env = fakeEnv();
      mocks.resolveSecrets.mockResolvedValue({
        FMP_API_KEY: 'test-key',
        FMP_DAILY_CALL_CAP: '1000',
      });

      await maybeRunDailyJobs(env, new Date('2026-07-10T00:00:00Z'));

      expect(mocks.runEnrichment).toHaveBeenCalledWith(
        env,
        expect.not.objectContaining({ max: expect.any(Number) }),
      );
      expect(mocks.getDailyUsed).not.toHaveBeenCalled();
    });

    it('alerts when Socratic profile or price reads fail auth', async () => {
      const env = fakeEnv();
      mocks.runEnrichment.mockResolvedValue({
        hasFmpKey: false,
        dailyCap: 0,
        fmpCalls: 0,
        errors: ['AAPL socratic: SOCRATIC_HTTP_401'],
        shareRefs: [],
        scanned: 1,
        enriched: 0,
      });

      await maybeRunDailyJobs(env, new Date('2026-07-10T00:00:00Z'));

      expect(mocks.notifyAdmin).toHaveBeenCalledWith(
        env,
        expect.objectContaining({ dedupeKey: 'socratic-peer-auth' }),
      );
    });

    it('alerts when Socratic / peer reads hit HTTP 429 rate-limit', async () => {
      const env = fakeEnv();
      mocks.runEnrichment.mockResolvedValue({
        hasFmpKey: false,
        dailyCap: 0,
        fmpCalls: 0,
        errors: [],
        shareRefs: [],
        scanned: 0,
        enriched: 0,
      });
      mocks.runPriceRefresh.mockResolvedValue({
        aborted: true,
        tickersPriced: 0,
        errors: ['spx: PEER_HTTP_429'],
        sharePrices: [],
        shareSpx: [],
      });

      await maybeRunDailyJobs(env, new Date('2026-07-10T00:00:00Z'));

      expect(mocks.notifyAdmin).toHaveBeenCalledWith(
        env,
        expect.objectContaining({ dedupeKey: 'socratic-peer-auth' }),
      );
    });
  });
});

describe('staggered daily lanes', () => {
  // Same env shape as fakeEnv(), but with an injectable KV map so tests can
  // pre-seed per-lane date stamps.
  function laneEnv(kv: Map<string, string> = new Map()): Env {
    return {
      CONFIG_KV: {
        async get(key: string) {
          return kv.get(key) ?? null;
        },
        async put(key: string, value: string) {
          kv.set(key, value);
        },
      },
    } as unknown as Env;
  }
  const DAY = new Date('2026-07-10T00:00:00Z');

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveSecrets.mockResolvedValue({});
    mocks.isD1RowBudgetExceeded.mockResolvedValue(false);
    mocks.getDailyUsed.mockResolvedValue(0);
    mocks.runEnrichment.mockResolvedValue({
      hasFmpKey: false, dailyCap: null, fmpCalls: 0, errors: [], shareRefs: [], scanned: 0, enriched: 0,
    });
    mocks.runPriceRefresh.mockResolvedValue({
      hasFmpKey: false, fmpCalls: 0, errors: [], sharePrices: [], shareSpx: [],
    });
    mocks.hasFmpTierFailure.mockReturnValue(false);
    mocks.shareWithPeer.mockResolvedValue({ sent: false, reason: 'not configured' });
    mocks.runFreshnessCheck.mockResolvedValue([]);
    mocks.runBulkSnapshot.mockResolvedValue({ tables: {} });
    mocks.runPhotoEnrichment.mockResolvedValue({ filers: 0, matched: 0, unmatched: 0, upgraded: 0 });
    mocks.runTickerBackfill.mockResolvedValue(undefined);
    mocks.runCommitteeSync.mockResolvedValue({ filersScanned: 0, updated: 0, skipped: 0, unmatched: 0, noBioguide: 0, sourceBioguides: 0 });
    mocks.runIdentitySync.mockResolvedValue({ filersScanned: 0, bioguideResolved: 0, displayNamesSet: 0, fieldsBackfilled: 0, cleaned: 0, unresolved: 0, dryRun: false });
    mocks.backfillCurrentPricesFromEod.mockResolvedValue({ currentPriceFilled: 0, latestDateFilled: 0 });
    mocks.dbRun.mockResolvedValue({ meta: { changes: 0 } });
  });

  it('snapshot lane still runs when only the market-data lane is stamped', async () => {
    const kv = new Map([['jobs:daily:lastdate:market-data', '2026-07-10']]);
    const status = await maybeRunDailySnapshotJob(laneEnv(kv), DAY);
    expect(status).toBe('ran');
    expect(mocks.runBulkSnapshot).toHaveBeenCalledTimes(1);
  });

  it('each lane no-ops on its own stamp the same UTC day', async () => {
    const env = laneEnv();
    expect(await maybeRunDailyFilerJobs(env, DAY)).toBe('ran');
    expect(await maybeRunDailyFilerJobs(env, DAY)).toBe('stamped');
    expect(mocks.runIdentitySync).toHaveBeenCalledTimes(1);
    expect(mocks.runPhotoEnrichment).toHaveBeenCalledTimes(1);
    expect(mocks.runCommitteeSync).toHaveBeenCalledTimes(1);
    expect(mocks.runTickerBackfill).toHaveBeenCalledTimes(1);
  });

  it('filer lane runs identity, photos, committees, then ticker backfill', async () => {
    await maybeRunDailyFilerJobs(laneEnv(), DAY);
    expect(mocks.runIdentitySync).toHaveBeenCalledTimes(1);
    expect(mocks.runPhotoEnrichment).toHaveBeenCalledTimes(1);
    expect(mocks.runCommitteeSync).toHaveBeenCalledTimes(1);
    expect(mocks.runTickerBackfill).toHaveBeenCalledTimes(1);
    const idOrder = mocks.runIdentitySync.mock.invocationCallOrder[0];
    const photoOrder = mocks.runPhotoEnrichment.mock.invocationCallOrder[0];
    const commOrder = mocks.runCommitteeSync.mock.invocationCallOrder[0];
    expect(idOrder).toBeLessThan(photoOrder);
    expect(photoOrder).toBeLessThan(commOrder);
  });

  it('retention lane runs both retention sweeps', async () => {
    await maybeRunDailyRetentionJobs(laneEnv(), DAY);
    const sqls = mocks.dbRun.mock.calls.map(([, sql]) => sql as string);
    for (const policy of RETENTION_POLICIES) {
      expect(sqls.some((s) => s.includes(`DELETE FROM ${policy.table}`))).toBe(true);
    }
  });

  it('a lane RETRIES when the D1 budget trips, instead of parking the work for 24h (stamp-on-success)', async () => {
    // Bug fix 2026-09-20: the old "stamp before run" design silently parked
    // failed daily work for the rest of the UTC day. Observed in prod when
    // the S&P 500 price series froze at 2026-08-03 for 46 days — the one FMP
    // refresh attempt 401/403'd but the day stamp stuck, so the lane
    // wouldn't retry until the next UTC day. The new stamp-on-success
    // semantic lets the next hourly cron tick re-attempt as soon as the
    // underlying condition (D1 budget, FMP key, transient error) clears.
    mocks.isD1RowBudgetExceeded.mockResolvedValue(true);
    const env = laneEnv();
    expect(await maybeRunDailySnapshotJob(env, DAY)).toBe('budget');
    expect(mocks.runBulkSnapshot).not.toHaveBeenCalled();
    // Next tick: budget still exceeded → retries (cheap re-check, no DB
    // work) and reports 'budget' again. Crucially, the day stamp is NOT
    // set, so a fresh budget (or /admin/recover-pipeline) can still run
    // the lane same-day.
    expect(await maybeRunDailySnapshotJob(env, DAY)).toBe('budget');
    expect(mocks.isD1RowBudgetExceeded).toHaveBeenCalledTimes(2);
  });

  it('a lane stamps the day ONLY after a successful run, not after a budget trip', async () => {
    const kv = new Map<string, string>();
    const env = laneEnv(kv);
    // Budget tripped: stamp must NOT be set so next tick retries.
    mocks.isD1RowBudgetExceeded.mockResolvedValue(true);
    await maybeRunDailySnapshotJob(env, DAY);
    expect(kv.get('jobs:daily:lastok:snapshot')).toBeUndefined();
    // Budget clears: lane runs successfully and stamps the day.
    mocks.isD1RowBudgetExceeded.mockResolvedValue(false);
    expect(await maybeRunDailySnapshotJob(env, DAY)).toBe('ran');
    expect(kv.get('jobs:daily:lastok:snapshot')).toBe(DAY.toISOString().slice(0, 10));
    // Same day, no work: cheap no-op via the stamp.
    expect(await maybeRunDailySnapshotJob(env, DAY)).toBe('stamped');
    expect(mocks.runBulkSnapshot).toHaveBeenCalledTimes(1);
  });

  it('combined wrapper runs all four lanes exactly once on a fresh day', async () => {
    await maybeRunDailyJobs(laneEnv(), DAY);
    expect(mocks.runEnrichment).toHaveBeenCalledTimes(1);
    expect(mocks.backfillCurrentPricesFromEod).toHaveBeenCalledTimes(1);
    expect(mocks.runPriceRefresh).toHaveBeenCalledTimes(1);
    expect(mocks.runBulkSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.runIdentitySync).toHaveBeenCalledTimes(1);
    expect(mocks.runPhotoEnrichment).toHaveBeenCalledTimes(1);
    expect(mocks.runCommitteeSync).toHaveBeenCalledTimes(1);
    expect(mocks.runTickerBackfill).toHaveBeenCalledTimes(1);
    const sqls = mocks.dbRun.mock.calls.map(([, sql]) => sql as string);
    for (const policy of RETENTION_POLICIES) {
      expect(sqls.some((s) => s.includes(`DELETE FROM ${policy.table}`))).toBe(true);
    }
  });
});

describe('runHourlyEnrichmentSlice', () => {
  function sliceEnv(kv: Map<string, string> = new Map()): Env {
    return {
      CONFIG_KV: {
        async get(key: string) {
          return kv.get(key) ?? null;
        },
        async put(key: string, value: string) {
          kv.set(key, value);
        },
      },
    } as unknown as Env;
  }
  const DAY = new Date('2026-08-01T12:47:00Z');

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveSecrets.mockResolvedValue({});
    mocks.isD1RowBudgetExceeded.mockResolvedValue(false);
    mocks.getDailyUsed.mockResolvedValue(0);
    mocks.runEnrichment.mockResolvedValue({
      hasFmpKey: true, dailyCap: 5000, fmpCalls: 10, errors: [], shareRefs: [], scanned: 50, enriched: 40,
      budgetRemaining: 4000,
    });
    mocks.shareWithPeer.mockResolvedValue({ sent: false, reason: 'not configured' });
  });

  it('has no daily stamp: runs again the same day (daily FMP cap self-limits)', async () => {
    const env = sliceEnv();
    await runHourlyEnrichmentSlice(env, DAY);
    await runHourlyEnrichmentSlice(env, DAY);
    expect(mocks.runEnrichment).toHaveBeenCalledTimes(2);
  });

  it('caps each slice at HOURLY_ENRICHMENT_SLICE_MAX and time-boxes it', async () => {
    mocks.resolveSecrets.mockResolvedValue({ FMP_API_KEY: 'k', FMP_DAILY_CALL_CAP: '100000' });
    await runHourlyEnrichmentSlice(sliceEnv(), DAY);
    expect(mocks.runEnrichment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ max: HOURLY_ENRICHMENT_SLICE_MAX, deadlineMs: HOURLY_ENRICHMENT_SLICE_DEADLINE_MS }),
    );
  });

  it('uses the slice cap even when an FMP key and a spent day counter are present', async () => {
    mocks.resolveSecrets.mockResolvedValue({ FMP_API_KEY: 'k', FMP_DAILY_CALL_CAP: '1000' });
    mocks.getDailyUsed.mockResolvedValue(950);
    await runHourlyEnrichmentSlice(sliceEnv(), DAY);
    expect(mocks.getDailyUsed).not.toHaveBeenCalled();
    expect(mocks.runEnrichment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ max: HOURLY_ENRICHMENT_SLICE_MAX }),
    );
  });

  it('shares freshly enriched refs to the peer (delta only)', async () => {
    mocks.runEnrichment.mockResolvedValue({
      hasFmpKey: true, dailyCap: 5000, fmpCalls: 3, errors: [],
      shareRefs: [{ ticker: 'AAPL' } as never], scanned: 5, enriched: 1, budgetRemaining: 4990,
    });
    const r = await runHourlyEnrichmentSlice(sliceEnv(), DAY);
    expect(mocks.shareWithPeer).toHaveBeenCalledWith(expect.anything(), { refs: [{ ticker: 'AAPL' }] });
    expect(r.enriched).toBe(1);
    expect(r.remainingBacklog).toBe(false);
  });
});
