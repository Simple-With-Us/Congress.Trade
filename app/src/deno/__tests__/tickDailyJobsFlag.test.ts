import { createClient } from '@libsql/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../shared/types.ts';
import { D1DatabaseShim } from '../shims.ts';
import type { DenoCostProfile } from '../costProfile.ts';
import type { DurableQueueHandlers } from '../durableQueue.ts';

const mocks = vi.hoisted(() => ({
  maybeRunDailyJobs: vi.fn(async () => {}),
}));

vi.mock('../../jobs.ts', () => ({ maybeRunDailyJobs: mocks.maybeRunDailyJobs }));
vi.mock('../../ingestion/watcher.ts', () => ({ runWatcher: vi.fn(async () => null) }));
vi.mock('../../ingestion/tradeLatency.ts', () => ({ runDisclosureLatencyProbe: vi.fn(async () => {}) }));
vi.mock('../../delivery/outbox.ts', () => ({
  flushDeliveryOutbox: vi.fn(async () => ({ claimed: 0, enqueued: 0, failed: 0 })),
}));
vi.mock('../../delivery/targetCircuit.ts', () => ({ flushParkedDeliveries: vi.fn(async () => {}) }));
vi.mock('../../ingestion/outbox.ts', () => ({
  flushIngestionOutbox: vi.fn(async () => ({ claimed: 0, enqueued: 0, failed: 0 })),
}));
vi.mock('../../extraction/agreement.ts', () => ({ maybeRunAgreementAutopublish: vi.fn(async () => null) }));
vi.mock('../../extraction/autopilot.ts', () => ({ maybeStartBacklogAutopilot: vi.fn(async () => null) }));
vi.mock('../../secrets/infisical.ts', () => ({ refreshSecrets: vi.fn(async () => ({})) }));
vi.mock('../../shared/thirdPartyTelemetry.ts', () => ({ flushUsageTelemetryFallback: vi.fn(async () => ({})) }));
vi.mock('../../shared/d1Budget.ts', () => ({ flushD1Budget: vi.fn(async () => ({})) }));
vi.mock('../durableQueue.ts', () => ({
  drainDurableQueues: vi.fn(async () => ({
    ingest: { claimed: 0, completed: 0, retried: 0, failed: 0 },
    delivery: { claimed: 0, completed: 0, retried: 0, failed: 0 },
  })),
}));

import { runScheduledTick } from '../scheduledTick.ts';

const PROFILE: DenoCostProfile = {
  name: 'free',
  cronSchedule: '*/15 * * * *',
  drainLimit: 2,
  drainClaimSize: 1,
  outboxLimit: 10,
  disableInternalCron: false,
  idleShortCircuit: false, // skip probe SQL; only the KV lock table is needed
};

async function makeEnv(): Promise<Env> {
  const client = createClient({ url: 'file::memory:' });
  await client.execute(`
    CREATE TABLE deno_runtime_kv (
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      expires_at INTEGER,
      PRIMARY KEY (namespace, key)
    )
  `);
  return { DB: new D1DatabaseShim(client) } as unknown as Env;
}

describe('runScheduledTick includeDailyJobs flag', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips the daily_jobs lane when includeDailyJobs is false (internal-cron path)', async () => {
    const env = await makeEnv();
    const result = await runScheduledTick(
      env,
      {} as DurableQueueHandlers,
      PROFILE,
      new Date('2026-07-31T12:00:00Z'),
      { includeDailyJobs: false },
    );
    expect(result.skippedOverlap).toBe(false);
    expect(mocks.maybeRunDailyJobs).not.toHaveBeenCalled();
  }, 10000);

  it('runs the daily_jobs lane by default (external-scheduler path)', async () => {
    const env = await makeEnv();
    const result = await runScheduledTick(
      env,
      {} as DurableQueueHandlers,
      PROFILE,
      new Date('2026-07-31T12:00:00Z'),
    );
    expect(result.skippedOverlap).toBe(false);
    expect(mocks.maybeRunDailyJobs).toHaveBeenCalledTimes(1);
  }, 10000);
});
