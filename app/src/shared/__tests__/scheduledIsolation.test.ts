import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  watcher: vi.fn(async () => { throw new Error('poll config unavailable'); }),
  deliveryOutbox: vi.fn(async () => ({ claimed: 0, enqueued: 0, failed: 0 })),
  ingestionOutbox: vi.fn(async () => ({ claimed: 0, enqueued: 0, failed: 0 })),
  telemetryFallback: vi.fn(async () => ({ listed: 0, delivered: 0, failed: 0 })),
}));

vi.mock('#sentry', () => ({
  withSentry: (_opts: unknown, handler: unknown) => handler,
  withMonitor: (_slug: string, callback: () => unknown) => Promise.resolve().then(callback),
  captureException: vi.fn(), setTags: vi.fn(),
  consoleLoggingIntegration: vi.fn(() => ({})),
}));
vi.mock('../../ingestion/watcher', () => ({ runWatcher: mocks.watcher }));
vi.mock('../../delivery/outbox', () => ({
  completeDeliveryOutbox: vi.fn(async () => 'completed'),
  flushDeliveryOutbox: mocks.deliveryOutbox,
  reconnectDeadLetteredOutbox: vi.fn(),
}));
vi.mock('../../ingestion/outbox', () => ({
  completeIngestionOutbox: vi.fn(async () => 'completed'),
  flushIngestionOutbox: mocks.ingestionOutbox,
  reconnectDeadLetteredIngestionOutbox: vi.fn(),
}));
vi.mock('../../jobs', () => ({ maybeRunDailyJobs: vi.fn(async () => {}) }));
vi.mock('../../secrets/infisical', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../secrets/infisical')>()),
  refreshSecrets: vi.fn(async () => {}),
}));
vi.mock('../../ingestion/tradeLatency', () => ({ runDisclosureLatencyProbe: vi.fn(async () => {}) }));
vi.mock('../../extraction/agreement', () => ({
  maybeRunAgreementAutopublish: vi.fn(async () => {}),
  handleAgreementCheck: vi.fn(async () => {}),
}));
vi.mock('../thirdPartyTelemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../thirdPartyTelemetry.ts')>()),
  flushUsageTelemetryFallback: mocks.telemetryFallback,
}));

import worker from '../../index.ts';
import type { Env } from '../types.ts';

describe('scheduled maintenance isolation', () => {
  it('registers outbox maintenance even when watcher configuration fails', async () => {
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil(value: Promise<unknown>) { pending.push(value); },
      passThroughOnException() {},
    } as unknown as ExecutionContext;
    await worker.scheduled({} as ScheduledController, {} as Env, ctx);
    await Promise.all(pending);
    expect(mocks.watcher).toHaveBeenCalledOnce();
    expect(mocks.deliveryOutbox).toHaveBeenCalledOnce();
    expect(mocks.ingestionOutbox).toHaveBeenCalledOnce();
    expect(mocks.telemetryFallback).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ limit: 25, signal: expect.any(AbortSignal) }),
    );
    // Lane orchestration now lives in runMaintenancePipeline (shared with the
    // Deno tick); scheduled() registers that one pipeline with waitUntil and
    // the pipeline isolates per-lane failures internally.
    expect(pending.length).toBe(1);
  });
});
