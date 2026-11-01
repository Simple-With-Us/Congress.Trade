import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Env } from '../../shared/types.ts';
import {
  alertPipelineTerminalFailure,
  maybeAlertTerminalDurableIngestFailure,
  readPipelineStallHours,
  sweepPipelineStallAlerts,
  PIPELINE_LOUD_ALERT_KV_PREFIX,
  TERMINAL_REDUP_WINDOW_MS,
} from '../pipelineLoudAlerts.ts';
import { SENATE_EDGE_BACKOFF_KV_KEY } from '../senateEdgeDeny.ts';
import { FMP_LATENCY_SILENCE_PENDING_KV_KEY } from '../../shared/fmpLatencyProbeHealth.ts';

const notifyReviewSpy = vi.fn(async () => {});
const notifyStallSpy = vi.fn(async () => {});
vi.mock('../reviewQueueNotify.ts', () => ({
  notifyReviewQueuePublisher: (...args: unknown[]) => notifyReviewSpy(...args),
  notifyPipelineStallPublisher: (...args: unknown[]) => notifyStallSpy(...args),
}));

const captureException = vi.fn();
const captureMessage = vi.fn();
vi.mock('../../deno/sentry.ts', () => ({
  captureException: (...args: unknown[]) => captureException(...args),
  captureMessage: (...args: unknown[]) => captureMessage(...args),
}));

vi.mock('../ogeSource.ts', () => ({
  ogeWatchEnabled: vi.fn(async () => true),
}));

vi.mock('../../enrichment/service.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../enrichment/service.ts')>();
  return {
    ...actual,
    hasConfiguredKeyedEnrichmentProvider: vi.fn(async () => false),
  };
});

vi.mock('../../secrets/infisical.ts', () => ({
  resolveSecrets: vi.fn(async () => ({})),
}));

vi.mock('../../delivery/targetCircuit.ts', () => ({
  targetKeyForUrl: vi.fn(() => 'peer-app:socratic.trade'),
  checkTargetCircuit: vi.fn(async () => ({ allowed: true, probe: false })),
}));

vi.mock('../../shared/pipelineHealth.ts', () => ({
  checkPipelineHealth: vi.fn(async () => ({ status: 'ok', checks: [] })),
  collectEmptyFetchHandoffCheck: vi.fn(async () => ({
    check: { id: 'empty_fetch_handoff', status: 'ok', detail: 'none', value: 0 },
    wakeDocId: null,
  })),
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
          const source = String(this.params[0] ?? '');
          if (/SELECT f\.doc_id AS doc_id/i.test(sql)) {
            return { doc_id: 'H-2026-9116355' } as T;
          }
          if (/COUNT\(\*\) AS n[\s\S]*scanned_pdf/i.test(sql) && /filings f/i.test(sql)) {
            return { n: 2 } as T;
          }
          if (/FROM ingestion_outbox o/i.test(sql)) {
            return { n: 1 } as T;
          }
          if (/ingestion_decisions/i.test(sql)) {
            return { last_at: '2026-10-01T00:00:00.000Z' } as T;
          }
          if (/source_attempts/i.test(sql)) {
            if (source === 'senate') {
              return { last_success: '2026-10-01T00:00:00.000Z' } as T;
            }
            if (source === 'house') {
              return { last_success: '2026-10-12T10:00:00.000Z' } as T;
            }
            if (source === 'executive') {
              return { last_success: '2026-10-12T10:00:00.000Z' } as T;
            }
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
    notifyReviewSpy.mockClear();
    notifyStallSpy.mockClear();
    captureException.mockClear();
    captureMessage.mockClear();
  });

  it('readPipelineStallHours defaults to 6', () => {
    expect(readPipelineStallHours({} as Env)).toBe(6);
    expect(readPipelineStallHours({} as Env, 'senate_fetch_success')).toBe(6);
  });

  it('readPipelineStallHours honors the passed env binding (Kody #2)', () => {
    const env = {
      CT_PIPELINE_STALL_HOURS_ST_PEER_PRICES: '12',
      CT_PIPELINE_STALL_HOURS: '9',
    } as unknown as Env;
    expect(readPipelineStallHours(env, 'st_peer_prices')).toBe(12);
    expect(readPipelineStallHours(env, 'senate_fetch_success')).toBe(9);
    expect(readPipelineStallHours({ CT_PIPELINE_STALL_HOURS: '999' } as unknown as Env)).toBe(168);
    expect(readPipelineStallHours({ CT_PIPELINE_STALL_HOURS: 'x' } as unknown as Env)).toBe(6);
  });

  it('does not raise a second health_st_peer_prices episode from the generic health loop (Sentry #1)', async () => {
    const { checkPipelineHealth } = await import('../../shared/pipelineHealth.ts');
    vi.mocked(checkPipelineHealth).mockResolvedValueOnce({
      status: 'stalled',
      checks: [
        { id: 'st_peer_prices', status: 'stalled', detail: '15 ticker(s) still need EOD/current prices' },
        { id: 'empty_fetch_handoff', status: 'critical', detail: '1 filing(s) stored nothing' },
        { id: 'price_freshness', status: 'stalled', detail: 'behind' },
      ],
    } as never);
    const { env } = kvEnv();
    const result = await sweepPipelineStallAlerts(env, new Date('2026-10-12T18:00:00.000Z'));
    expect(result.evaluated).not.toContain('health_st_peer_prices');
    expect(result.alerted).not.toContain('health_st_peer_prices');
    expect(result.evaluated).not.toContain('health_empty_fetch_handoff');
    expect(result.alerted).not.toContain('health_empty_fetch_handoff');
    // The generic loop still runs for other checks.
    expect(result.evaluated).toContain('health_price_freshness');
  });

  it('alerts terminal ingest failure once per doc via webhook + Sentry', async () => {
    const { env } = kvEnv();
    // The dedup window is 7 days, so the first alert has to sit inside it.
    // A hardcoded timestamp ages out of that window and makes this test fail
    // from the day the window passed, with no code change at all:  the second
    // call carries no `at`, so it lands on the real clock and is then outside
    // the window of a timestamp written in the past.
    const firstAlertAt = new Date(Date.now() - 60_000).toISOString();
    await alertPipelineTerminalFailure(env, {
      docId: 'H-2026-9116355',
      stage: 'ingest',
      lastError: 'consumer retry budget exhausted',
      at: firstAlertAt,
    });
    expect(notifyReviewSpy).toHaveBeenCalledTimes(1);
    expect(notifyReviewSpy.mock.calls[0][1]).toMatchObject({
      docId: 'H-2026-9116355',
      reason: expect.stringContaining('terminal_ingest_failed'),
    });
    expect(captureException).toHaveBeenCalledTimes(1);

    await alertPipelineTerminalFailure(env, {
      docId: 'H-2026-9116355',
      stage: 'ingest',
      lastError: 'again',
    });
    expect(notifyReviewSpy).toHaveBeenCalledTimes(1);
  });

  it('skips parked errors for terminal alerts', async () => {
    const { env } = kvEnv();
    await alertPipelineTerminalFailure(env, {
      docId: 'H-1',
      stage: 'ingest',
      lastError: 'parked: needs human',
    });
    expect(notifyReviewSpy).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });

  it('alerts on retry-budget-exhausted messages once terminalized', async () => {
    const { env } = kvEnv();
    await alertPipelineTerminalFailure(env, {
      docId: 'H-2',
      stage: 'extract',
      lastError: 'consumer retry budget exhausted; received by ingest-dlq',
    });
    expect(notifyReviewSpy).toHaveBeenCalledTimes(1);
  });

  it('maybeAlertTerminalDurableIngestFailure alerts on transient-pattern lastError', async () => {
    const { env } = kvEnv();
    await maybeAlertTerminalDurableIngestFailure(
      env,
      { type: 'filing.received', docId: 'H-2026-9116356' },
      'timeout: upstream reset after retries',
    );
    expect(notifyReviewSpy).toHaveBeenCalledTimes(1);
    expect(notifyReviewSpy.mock.calls[0][1]).toMatchObject({ docId: 'H-2026-9116356' });
  });

  it('re-alerts terminal failure after dedupe window', async () => {
    const { env, store } = kvEnv();
    const kvKey = `${PIPELINE_LOUD_ALERT_KV_PREFIX}terminal:ingest:H-3`;
    store.set(
      kvKey,
      JSON.stringify({ notifiedAt: new Date(Date.now() - TERMINAL_REDUP_WINDOW_MS - 1000).toISOString() }),
    );
    await alertPipelineTerminalFailure(env, {
      docId: 'H-3',
      stage: 'ingest',
      lastError: 'failed again',
    });
    expect(notifyReviewSpy).toHaveBeenCalledTimes(1);
  });

  it('sweepPipelineStallAlerts fires stall webhooks for OCR + Senate; dedupes within window', async () => {
    const { env, store } = kvEnv();
    const now = new Date('2026-10-12T18:00:00.000Z');
    const result = await sweepPipelineStallAlerts(env, now);
    expect(result.evaluated).toContain('ocr_scan_reader');
    expect(result.evaluated).toContain('senate_fetch_success');
    expect(result.evaluated).toContain('house_fetch_success');
    expect(result.evaluated).toContain('executive_fetch_success');
    expect(result.alerted).toContain('ocr_scan_reader');
    expect(result.alerted).toContain('senate_fetch_success');
    expect(result.alerted).toContain('executive_fetch_success');
    expect(notifyStallSpy).toHaveBeenCalled();
    const ocrCall = notifyStallSpy.mock.calls.find((c) => c[1]?.pipeline === 'ocr_scan_reader');
    expect(ocrCall?.[1]).toMatchObject({
      pipeline: 'ocr_scan_reader',
      wakeDocId: 'H-2026-9116355',
    });

    notifyStallSpy.mockClear();
    const again = await sweepPipelineStallAlerts(env, now);
    expect(again.alerted).toHaveLength(0);
    expect(notifyStallSpy).not.toHaveBeenCalled();

    const kvKey = `${PIPELINE_LOUD_ALERT_KV_PREFIX}stall:ocr_scan_reader`;
    store.set(kvKey, JSON.stringify({ notifiedAt: '2020-01-01T00:00:00.000Z', active: true }));
    const later = new Date('2026-10-13T01:00:00.000Z');
    const third = await sweepPipelineStallAlerts(env, later);
    expect(third.alerted).toContain('ocr_scan_reader');
  });

  const EDGE_DENY_HEALTH_DETAIL =
    'Senate eFD BLOCKED: Akamai edge deny on Senate ingestion 30m ago '
    + '(senate POST /search/home/ -> HTTP 403 (server=AkamaiGHost) [edge_denied]) '
    + '— refused by eFD itself, not a relay outage; the probe is paused for the '
    + 'edge-deny backoff (next attempt in 60m)';

  function seedEdgeDenyBackoff(store: Map<string, string>) {
    store.set(SENATE_EDGE_BACKOFF_KV_KEY, JSON.stringify({
      consecutive: 3,
      firstDeniedAt: '2026-10-12T12:00:00.000Z',
      lastDeniedAt: '2026-10-12T17:30:00.000Z',
      windowMs: 3_600_000,
      until: '2026-10-12T19:00:00.000Z',
      reason: 'senate POST /search/home/ -> HTTP 403 (server=AkamaiGHost) [edge_denied]',
    }));
  }

  async function mockSenateEfdHealth(status: string, detail: string) {
    const { checkPipelineHealth } = await import('../../shared/pipelineHealth.ts');
    vi.mocked(checkPipelineHealth).mockResolvedValueOnce({
      status: status === 'ok' ? 'ok' : 'critical',
      checks: [{ id: 'senate_efd', status, detail, value: 403 }],
    } as never);
  }

  function senateStallCalls() {
    return notifyStallSpy.mock.calls.filter(
      (c) => c[1]?.pipeline === 'senate_fetch_success' || c[1]?.pipeline === 'health_senate_efd',
    );
  }

  it('edge-deny active: one alert (health_senate_efd) carrying the fetch-stall fact', async () => {
    const { env, store } = kvEnv();
    seedEdgeDenyBackoff(store);
    await mockSenateEfdHealth('critical', EDGE_DENY_HEALTH_DETAIL);
    const result = await sweepPipelineStallAlerts(env, new Date('2026-10-12T18:00:00.000Z'));
    expect(result.alerted).toContain('health_senate_efd');
    expect(result.alerted).not.toContain('senate_fetch_success');
    const calls = senateStallCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0][1].pipeline).toBe('health_senate_efd');
    expect(calls[0][1].detail).toContain('edge deny');
    expect(calls[0][1].detail).toContain('No successful Senate fetch in 282.0h');
    // No separate senate_fetch_success episode is opened for the same root cause.
    expect(store.has(`${PIPELINE_LOUD_ALERT_KV_PREFIX}stall:senate_fetch_success`)).toBe(false);
  });

  it('edge-deny fold keeps an existing senate_fetch_success episode so its recovery still fires', async () => {
    const { env, store } = kvEnv();
    seedEdgeDenyBackoff(store);
    const kvKey = `${PIPELINE_LOUD_ALERT_KV_PREFIX}stall:senate_fetch_success`;
    const episode = JSON.stringify({ notifiedAt: '2026-10-12T17:00:00.000Z', active: true });
    store.set(kvKey, episode);
    await mockSenateEfdHealth('critical', EDGE_DENY_HEALTH_DETAIL);
    const result = await sweepPipelineStallAlerts(env, new Date('2026-10-12T18:00:00.000Z'));
    expect(result.evaluated).toContain('senate_fetch_success');
    expect(result.alerted).not.toContain('senate_fetch_success');
    expect(result.recovered).not.toContain('senate_fetch_success');
    expect(store.get(kvKey)).toBe(episode);
  });

  it('no edge deny + fetch stall: senate_fetch_success still alerts on its own', async () => {
    const { env } = kvEnv();
    await mockSenateEfdHealth('ok', 'Senate eFD landing + agreement POST ok through proxy: probed 1m ago');
    const result = await sweepPipelineStallAlerts(env, new Date('2026-10-12T18:00:00.000Z'));
    expect(result.alerted).toContain('senate_fetch_success');
    expect(result.alerted).not.toContain('health_senate_efd');
    const calls = senateStallCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0][1].pipeline).toBe('senate_fetch_success');
    expect(calls[0][1].detail).toContain('No successful Senate fetch in 282.0h');
  });

  it('edge deny only, fetch OK: one alert (health_senate_efd), no folded fetch fact', async () => {
    const { env, store } = kvEnv();
    seedEdgeDenyBackoff(store);
    await mockSenateEfdHealth('critical', EDGE_DENY_HEALTH_DETAIL);
    const envFreshSenate = {
      ...env,
      DB: {
        prepare: (sql: string) => ({
          bind(...params: unknown[]) {
            this.params = params;
            return this;
          },
          params: [] as unknown[],
          async first<T>() {
            if (/source_attempts/i.test(sql)) {
              return { last_success: '2026-10-12T17:00:00.000Z' } as T;
            }
            if (/ingestion_decisions/i.test(sql)) {
              return { last_at: '2026-10-12T17:00:00.000Z' } as T;
            }
            if (/scanned_pdf/i.test(sql) && /COUNT/i.test(sql)) {
              return { n: 0 } as T;
            }
            return null as T;
          },
        }),
      },
    } as unknown as Env;
    const result = await sweepPipelineStallAlerts(envFreshSenate, new Date('2026-10-12T18:00:00.000Z'));
    expect(result.evaluated).toContain('senate_fetch_success');
    expect(result.alerted).toContain('health_senate_efd');
    expect(result.alerted).not.toContain('senate_fetch_success');
    const calls = senateStallCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0][1].pipeline).toBe('health_senate_efd');
    expect(calls[0][1].detail).not.toContain('No successful Senate fetch');
  });

  it('emits recovery webhook when a stall clears', async () => {
    const { env, store } = kvEnv();
    const kvKey = `${PIPELINE_LOUD_ALERT_KV_PREFIX}stall:senate_fetch_success`;
    store.set(
      kvKey,
      JSON.stringify({ notifiedAt: '2026-10-12T00:00:00.000Z', active: true }),
    );
    const envFreshSenate = {
      ...env,
      DB: {
        prepare: (sql: string) => ({
          bind(...params: unknown[]) {
            this.params = params;
            return this;
          },
          params: [] as unknown[],
          async first<T>() {
            const source = String(this.params[0] ?? '');
            if (/source_attempts/i.test(sql)) {
              if (source === 'senate' || source === 'house' || source === 'executive') {
                return { last_success: '2026-10-12T17:00:00.000Z' } as T;
              }
            }
            if (/ingestion_decisions/i.test(sql)) {
              return { last_at: '2026-10-12T17:00:00.000Z' } as T;
            }
            if (/scanned_pdf/i.test(sql) && /COUNT/i.test(sql)) {
              return { n: 0 } as T;
            }
            return null as T;
          },
        }),
      },
    } as unknown as Env;

    const now = new Date('2026-10-12T18:00:00.000Z');
    const result = await sweepPipelineStallAlerts(envFreshSenate, now);
    expect(result.recovered).toContain('senate_fetch_success');
    expect(notifyStallSpy).toHaveBeenCalledWith(
      envFreshSenate,
      expect.objectContaining({ pipeline: 'senate_fetch_success', recovered: true }),
      expect.anything(),
    );
    expect(store.has(kvKey)).toBe(false);
  });

  it('fmp_latency: unexplained critical first hourly sweep records pending without alert', async () => {
    const { env, store } = kvEnv();
    const { checkPipelineHealth } = await import('../../shared/pipelineHealth.ts');
    vi.mocked(checkPipelineHealth).mockResolvedValue({
      status: 'critical',
      checks: [{
        id: 'fmp_latency',
        status: 'critical',
        detail: 'FMP latency probe silent for 240 min',
        value: null,
      }],
    });
    const now = new Date('2026-11-01T18:00:00.000Z');
    const first = await sweepPipelineStallAlerts(env, now);
    expect(first.evaluated).toContain('health_fmp_latency');
    expect(first.alerted).not.toContain('health_fmp_latency');
    expect(store.has(FMP_LATENCY_SILENCE_PENDING_KV_KEY)).toBe(true);
    expect(notifyStallSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ pipeline: 'health_fmp_latency' }),
      expect.anything(),
    );
  });

  it('fmp_latency: second consecutive critical sweep alerts', async () => {
    const { env, store } = kvEnv();
    store.set(
      FMP_LATENCY_SILENCE_PENDING_KV_KEY,
      JSON.stringify({ firstSeenAt: '2026-11-01T17:00:00.000Z' }),
    );
    const { checkPipelineHealth } = await import('../../shared/pipelineHealth.ts');
    vi.mocked(checkPipelineHealth).mockResolvedValue({
      status: 'critical',
      checks: [{
        id: 'fmp_latency',
        status: 'critical',
        detail: 'FMP latency probe silent for 300 min',
        value: null,
      }],
    });
    notifyStallSpy.mockClear();
    const second = await sweepPipelineStallAlerts(env, new Date('2026-11-01T18:00:00.000Z'));
    expect(second.alerted).toContain('health_fmp_latency');
    // Pending stays while critical so the next sweep stays on the alerting path.
    expect(store.has(FMP_LATENCY_SILENCE_PENDING_KV_KEY)).toBe(true);
  });

  it('fmp_latency: a stale pending mark restarts the confirm window instead of alerting', async () => {
    const { env, store } = kvEnv();
    store.set(
      FMP_LATENCY_SILENCE_PENDING_KV_KEY,
      JSON.stringify({ firstSeenAt: '2026-10-31T09:00:00.000Z' }),
    );
    const { checkPipelineHealth } = await import('../../shared/pipelineHealth.ts');
    vi.mocked(checkPipelineHealth).mockResolvedValue({
      status: 'critical',
      checks: [{
        id: 'fmp_latency',
        status: 'critical',
        detail: 'FMP latency probe silent for 240 min',
        value: null,
      }],
    });
    notifyStallSpy.mockClear();
    const result = await sweepPipelineStallAlerts(env, new Date('2026-11-01T18:00:00.000Z'));
    expect(result.alerted).not.toContain('health_fmp_latency');
    expect(JSON.parse(store.get(FMP_LATENCY_SILENCE_PENDING_KV_KEY) as string).firstSeenAt)
      .toBe('2026-11-01T18:00:00.000Z');
  });

  it('fmp_latency: degraded self-healing clears pending without paging', async () => {
    const { env, store } = kvEnv();
    store.set(
      FMP_LATENCY_SILENCE_PENDING_KV_KEY,
      JSON.stringify({ firstSeenAt: '2026-11-01T17:00:00.000Z' }),
    );
    const { checkPipelineHealth } = await import('../../shared/pipelineHealth.ts');
    vi.mocked(checkPipelineHealth).mockResolvedValue({
      status: 'degraded',
      checks: [{
        id: 'fmp_latency',
        status: 'degraded',
        detail: 'day-banned self-healing',
        value: { suppressLivenessNotification: true },
      }],
    });
    notifyStallSpy.mockClear();
    const result = await sweepPipelineStallAlerts(env, new Date('2026-11-01T18:00:00.000Z'));
    expect(result.alerted).not.toContain('health_fmp_latency');
    expect(store.has(FMP_LATENCY_SILENCE_PENDING_KV_KEY)).toBe(false);
  });
});
