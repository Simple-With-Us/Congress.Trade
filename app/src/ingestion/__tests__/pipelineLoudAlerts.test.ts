import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Env } from '../../shared/types.ts';
import {
  alertPipelineTerminalFailure,
  readPipelineStallHours,
  sweepPipelineStallAlerts,
  PIPELINE_LOUD_ALERT_KV_PREFIX,
} from '../pipelineLoudAlerts.ts';

const notifySpy = vi.fn(async () => {});
vi.mock('../reviewQueueNotify.ts', () => ({
  notifyReviewQueuePublisher: (...args: unknown[]) => notifySpy(...args),
}));

const captureException = vi.fn();
const captureMessage = vi.fn();
vi.mock('../../deno/sentry.ts', () => ({
  captureException: (...args: unknown[]) => captureException(...args),
  captureMessage: (...args: unknown[]) => captureMessage(...args),
}));

function kvEnv() {
  const store = new Map<string, string>();
  const env = {
    CONFIG_KV: {
      get: async (key: string) => {
        const raw = store.get(key);
        return raw ? JSON.parse(raw) : null;
      },
      put: async (key: string, value: string) => {
        store.set(key, value);
      },
      delete: async (key: string) => {
        store.delete(key);
      },
    },
    DB: {
      prepare: (sql: string) => ({
        params: [] as unknown[],
        bind(...params: unknown[]) {
          this.params = params;
          return this;
        },
        async first<T>() {
          if (/COUNT\(\*\) AS n[\s\S]*scanned_pdf/i.test(sql) && /filings f/i.test(sql)) {
            return { n: 2 } as T;
          }
          if (/ingestion_outbox o/i.test(sql)) {
            return { n: 1 } as T;
          }
          if (/ingestion_decisions/i.test(sql)) {
            return { last_at: '2026-10-01T00:00:00.000Z' } as T;
          }
          if (/source_attempts/i.test(sql) && /senate/i.test(sql)) {
            return { last_success: '2026-10-01T00:00:00.000Z' } as T;
          }
          return null as T;
        },
      }),
    },
  } as unknown as Env;
  return { env, store };
}

describe('pipelineLoudAlerts', () => {
  beforeEach(() => {
    notifySpy.mockClear();
    captureException.mockClear();
    captureMessage.mockClear();
  });

  it('readPipelineStallHours defaults to 6', () => {
    expect(readPipelineStallHours({} as Env)).toBe(6);
  });

  it('alerts terminal ingest failure once per doc via webhook + Sentry', async () => {
    const { env } = kvEnv();
    await alertPipelineTerminalFailure(env, {
      docId: 'H-2026-9116355',
      stage: 'ingest',
      lastError: 'consumer retry budget exhausted',
      at: '2026-10-12T12:00:00.000Z',
    });
    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(notifySpy.mock.calls[0][1]).toMatchObject({
      docId: 'H-2026-9116355',
      reason: expect.stringContaining('terminal_ingest_failed'),
    });
    expect(captureException).toHaveBeenCalledTimes(1);

    await alertPipelineTerminalFailure(env, {
      docId: 'H-2026-9116355',
      stage: 'ingest',
      lastError: 'again',
    });
    expect(notifySpy).toHaveBeenCalledTimes(1);
  });

  it('skips parked errors for terminal alerts', async () => {
    const { env } = kvEnv();
    await alertPipelineTerminalFailure(env, {
      docId: 'H-1',
      stage: 'ingest',
      lastError: 'parked: needs human',
    });
    expect(notifySpy).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });

  it('alerts on retry-budget-exhausted messages once terminalized', async () => {
    const { env } = kvEnv();
    await alertPipelineTerminalFailure(env, {
      docId: 'H-2',
      stage: 'extract',
      lastError: 'consumer retry budget exhausted; received by ingest-dlq',
    });
    expect(notifySpy).toHaveBeenCalledTimes(1);
  });

  it('sweepPipelineStallAlerts fires OCR and Senate stall webhooks when dedupe window elapsed', async () => {
    const { env, store } = kvEnv();
    const now = new Date('2026-10-12T18:00:00.000Z');
    const result = await sweepPipelineStallAlerts(env, now);
    expect(result.evaluated).toEqual(['ocr_scan_reader', 'senate_fetch_success']);
    expect(result.alerted).toContain('ocr_scan_reader');
    expect(result.alerted).toContain('senate_fetch_success');
    expect(notifySpy).toHaveBeenCalledTimes(2);

    notifySpy.mockClear();
    const again = await sweepPipelineStallAlerts(env, now);
    expect(again.alerted).toHaveLength(0);
    expect(notifySpy).not.toHaveBeenCalled();

    const kvKey = `${PIPELINE_LOUD_ALERT_KV_PREFIX}stall:ocr_scan_reader`;
    store.set(kvKey, JSON.stringify({ notifiedAt: '2020-01-01T00:00:00.000Z' }));
    const later = new Date('2026-10-13T01:00:00.000Z');
    const third = await sweepPipelineStallAlerts(env, later);
    expect(third.alerted).toContain('ocr_scan_reader');
  });
});
