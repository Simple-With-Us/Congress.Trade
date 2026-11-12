import { createClient } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../shared/types.ts';
import { D1DatabaseShim } from '../shims.ts';
import { __resetLaneTimeoutAlertStateForTests, runMaintenancePipeline } from '../scheduledTick.ts';

vi.mock('../../secrets/infisical.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../secrets/infisical.ts')>();
  return {
    ...actual,
    refreshSecrets: vi.fn(() => new Promise(() => {})),
  };
});
vi.mock('../../ingestion/watcher.ts', () => ({
  runWatcher: vi.fn(async () => ({ polled: 0 })),
}));
vi.mock('../../extraction/agreement.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../extraction/agreement.ts')>();
  return {
    ...actual,
    maybeRunAgreementAutopublish: vi.fn(async () => null),
  };
});
vi.mock('../../extraction/autopilot.ts', () => ({
  maybeStartBacklogAutopilot: vi.fn(async () => null),
}));
vi.mock('../../shared/thirdPartyTelemetry.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/thirdPartyTelemetry.ts')>();
  return {
    ...actual,
    flushUsageTelemetryFallback: vi.fn(async () => ({
      listed: 0,
      delivered: 0,
      failed: 0,
      expired: 0,
      skipped: true,
    })),
  };
});
vi.mock('#sentry', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

import { refreshSecrets } from '../../secrets/infisical.ts';
import { runWatcher } from '../../ingestion/watcher.ts';
import { flushUsageTelemetryFallback } from '../../shared/thirdPartyTelemetry.ts';
import type { SecretResolverStatus } from '../../secrets/infisical.ts';
import { captureException, captureMessage } from '#sentry';

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
  return { DB: new D1DatabaseShim(client) } as Env;
}

const hangForever = () => new Promise<never>(() => {});
const okSecrets = () => ({} as SecretResolverStatus);

/** Sentry timeout-alert calls only (filters out any unrelated captures). */
function timeoutAlertCalls() {
  return vi.mocked(captureMessage).mock.calls.filter(([message]) =>
    typeof message === 'string' && message.includes('timed out'),
  );
}

describe('runMaintenancePipeline lane timeouts', () => {
  beforeEach(() => {
    __resetLaneTimeoutAlertStateForTests();
    vi.mocked(refreshSecrets).mockImplementation(hangForever);
    vi.mocked(flushUsageTelemetryFallback).mockImplementation(async () => ({
      listed: 0,
      delivered: 0,
      failed: 0,
      expired: 0,
      skipped: true,
    }));
    vi.mocked(runWatcher).mockClear();
    vi.mocked(captureMessage).mockClear();
    vi.mocked(captureException).mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('isolates a hung secrets_refresh lane and continues to watcher', async () => {
    const env = await makeEnv();
    const result = await runMaintenancePipeline(env, {
      outboxLimit: 5,
      laneTimeoutMs: { secrets_refresh: 30 },
    });
    expect(result.errors.some((e) => e.startsWith('secrets_refresh: timed out'))).toBe(true);
    expect(result.aborted).toBe(false);
    expect(runWatcher).toHaveBeenCalled();
    // CONGRESS-TRADE-1T: a lone timeout no longer pages Sentry, but the
    // console line and errors.push still happen every tick.
    expect(timeoutAlertCalls()).toHaveLength(0);
    expect(
      vi.mocked(console.error).mock.calls.some(([message]) =>
        typeof message === 'string' && message.includes('secrets_refresh') && message.includes('timed out'),
      ),
    ).toBe(true);
  }, 10_000);

  it('alerts on the 3rd consecutive timeout, then at most once per hour', async () => {
    const env = await makeEnv();
    const t0 = Date.now();
    const runTick = (nowMs: number) =>
      runMaintenancePipeline(env, {
        outboxLimit: 5,
        now: new Date(nowMs),
        laneTimeoutMs: { secrets_refresh: 20 },
      });

    const first = await runTick(t0);
    expect(first.errors.some((e) => e.startsWith('secrets_refresh: timed out'))).toBe(true);
    expect(timeoutAlertCalls()).toHaveLength(0);

    const second = await runTick(t0 + 60_000);
    expect(second.errors.some((e) => e.startsWith('secrets_refresh: timed out'))).toBe(true);
    expect(timeoutAlertCalls()).toHaveLength(0);

    const third = await runTick(t0 + 120_000);
    expect(third.errors.some((e) => e.startsWith('secrets_refresh: timed out'))).toBe(true);
    expect(timeoutAlertCalls()).toHaveLength(1);

    // Still timing out within the hour: no further alerts.
    await runTick(t0 + 180_000);
    expect(timeoutAlertCalls()).toHaveLength(1);

    // An hour after the last alert, it fires again.
    const afterHour = await runTick(t0 + 120_000 + 61 * 60_000);
    expect(afterHour.errors.some((e) => e.startsWith('secrets_refresh: timed out'))).toBe(true);
    expect(timeoutAlertCalls()).toHaveLength(2);
  }, 20_000);

  it('resets the timeout streak after an in-budget run', async () => {
    const env = await makeEnv();
    const t0 = Date.now();
    const runTick = (nowMs: number) =>
      runMaintenancePipeline(env, {
        outboxLimit: 5,
        now: new Date(nowMs),
        laneTimeoutMs: { secrets_refresh: 20 },
      });

    await runTick(t0);
    await runTick(t0 + 60_000);
    expect(timeoutAlertCalls()).toHaveLength(0);

    // In-budget success resets the streak: two more timeouts stay silent.
    vi.mocked(refreshSecrets).mockImplementation(async () => okSecrets());
    const ok = await runTick(t0 + 120_000);
    expect(ok.errors.some((e) => e.startsWith('secrets_refresh'))).toBe(false);

    vi.mocked(refreshSecrets).mockImplementation(hangForever);
    await runTick(t0 + 180_000);
    await runTick(t0 + 240_000);
    expect(timeoutAlertCalls()).toHaveLength(0);

    // Third consecutive timeout after the reset alerts again.
    await runTick(t0 + 300_000);
    expect(timeoutAlertCalls()).toHaveLength(1);
  }, 20_000);

  it('never sends usage_telemetry timeouts to Sentry', async () => {
    const env = await makeEnv();
    vi.mocked(refreshSecrets).mockImplementation(async () => okSecrets());
    vi.mocked(flushUsageTelemetryFallback).mockImplementation(hangForever);
    const t0 = Date.now();

    for (let i = 0; i < 5; i++) {
      const result = await runMaintenancePipeline(env, {
        outboxLimit: 5,
        usageTelemetryLimit: 25,
        now: new Date(t0 + i * 60_000),
        laneTimeoutMs: { usage_telemetry: 20 },
      });
      expect(result.errors.some((e) => e.startsWith('usage_telemetry: timed out'))).toBe(true);
    }

    expect(captureMessage).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
    // console.log only: console.error/warn would be forwarded by the Sentry
    // log integration.
    expect(
      vi.mocked(console.log).mock.calls.some(([message]) =>
        typeof message === 'string' && message.includes('usage_telemetry') && message.includes('timed out'),
      ),
    ).toBe(true);
    expect(
      vi.mocked(console.error).mock.calls.some(([message]) =>
        typeof message === 'string' && message.includes('usage_telemetry') && message.includes('timed out'),
      ),
    ).toBe(false);
  }, 20_000);
});
