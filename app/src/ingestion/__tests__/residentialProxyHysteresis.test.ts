import { describe, expect, it, vi } from 'vitest';
import {
  applyResidentialProxyHysteresis,
  DEFAULT_RESIDENTIAL_PROXY_PROBE_FAILURE_THRESHOLD,
  probeResidentialProxyHealthWithRetry,
  refreshResidentialProxyHealth,
  RESIDENTIAL_PROXY_HEALTH_KV_KEY,
  RESIDENTIAL_PROXY_SENATE_CATCHUP_KV_KEY,
  RESIDENTIAL_PROXY_STATE_KV_KEY,
} from '../residentialProxyHealth.ts';
import type { Env } from '../../shared/types.ts';

function memEnv(): { env: Env; kv: Map<string, string> } {
  const kv = new Map<string, string>();
  const CONFIG_KV = {
    async get(key: string, type?: string) {
      const v = kv.get(key);
      if (v == null) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key: string, value: string) {
      kv.set(key, value);
    },
    async delete(key: string) {
      kv.delete(key);
    },
  };
  return { env: { CONFIG_KV, RESIDENTIAL_PROXY_URL: 'http://10.99.0.2:8888' } as unknown as Env, kv };
}

describe('applyResidentialProxyHysteresis (CT-2498)', () => {
  const now = new Date('2026-11-11T14:00:00.000Z');
  const threshold = DEFAULT_RESIDENTIAL_PROXY_PROBE_FAILURE_THRESHOLD;
  const reachable = {
    configured: true,
    proxyUrl: 'http://10.99.0.2:8888',
    reachable: true,
    status: 200,
  };
  const unreachable = {
    configured: true,
    proxyUrl: 'http://10.99.0.2:8888',
    reachable: false,
    status: null,
    error: 'Connection refused',
  };

  it('keeps health up through sub-threshold consecutive probe failures', () => {
    let state = null;
    for (let i = 1; i < threshold; i++) {
      const out = applyResidentialProxyHysteresis(state, unreachable, now, threshold);
      expect(out.published.ok).toBe(true);
      expect(out.state.consecutiveFailures).toBe(i);
      expect(out.recovery).toBe(false);
      state = out.state;
    }
  });

  it('publishes down on the Nth consecutive failure and records outage start', () => {
    let state = null;
    for (let i = 1; i < threshold; i++) {
      state = applyResidentialProxyHysteresis(state, unreachable, now, threshold).state;
    }
    const out = applyResidentialProxyHysteresis(state, unreachable, now, threshold);
    expect(out.published.ok).toBe(false);
    expect(out.published.outageStartedAt).toBe(now.toISOString());
    expect(out.state.reportedDown).toBe(true);
    expect(out.recovery).toBe(false);
  });

  it('emits a single recovery transition and closes the outage window', () => {
    const down = applyResidentialProxyHysteresis(
      { consecutiveFailures: 2, reportedDown: false, currentOutageStartedAt: null, lastOutageStartedAt: null, lastOutageEndedAt: null },
      unreachable,
      now,
      threshold,
    );
    expect(down.published.ok).toBe(false);
    const recovery = applyResidentialProxyHysteresis(down.state, reachable, new Date('2026-11-11T15:00:00.000Z'), threshold);
    expect(recovery.published.ok).toBe(true);
    expect(recovery.recovery).toBe(true);
    expect(recovery.state.lastOutageEndedAt).toBe('2026-11-11T15:00:00.000Z');
    expect(recovery.state.reportedDown).toBe(false);
    expect(recovery.state.consecutiveFailures).toBe(0);
  });
});

describe('probeResidentialProxyHealthWithRetry', () => {
  it('retries before returning unreachable', async () => {
    const mockFetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('flap'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const result = await probeResidentialProxyHealthWithRetry('http://10.99.0.2:8888', mockFetch, 1000, [0, 0]);
    expect(result.reachable).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe('refreshResidentialProxyHealth integration', () => {
  it('schedules Senate catch-up KV on recovery after a reported outage', async () => {
    const { env, kv } = memEnv();
    kv.set(
      RESIDENTIAL_PROXY_STATE_KV_KEY,
      JSON.stringify({
        consecutiveFailures: 3,
        reportedDown: true,
        currentOutageStartedAt: '2026-11-11T13:00:00.000Z',
        lastOutageStartedAt: null,
        lastOutageEndedAt: null,
      }),
    );
    kv.set(
      RESIDENTIAL_PROXY_HEALTH_KV_KEY,
      JSON.stringify({
        ok: false,
        status: null,
        checkedAt: '2026-11-11T13:42:00.000Z',
        host: '10.99.0.2:8888',
      }),
    );

    const mockFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);

    await refreshResidentialProxyHealth(env, new Date('2026-11-11T14:42:00.000Z'));

    const health = JSON.parse(kv.get(RESIDENTIAL_PROXY_HEALTH_KV_KEY)!);
    expect(health.ok).toBe(true);
    expect(kv.get(RESIDENTIAL_PROXY_SENATE_CATCHUP_KV_KEY)).toBe('2026-11-11T14:42:00.000Z');
    const state = JSON.parse(kv.get(RESIDENTIAL_PROXY_STATE_KV_KEY)!);
    expect(state.reportedDown).toBe(false);
    expect(state.lastOutageEndedAt).toBe('2026-11-11T14:42:00.000Z');

    vi.unstubAllGlobals();
  });
});
