/**
 * src/delivery/__tests__/healthMonitorEndpoints.test.ts
 *
 * GET /api/health/polling and GET /api/health/latency are scoped, public,
 * unauthenticated endpoints built for UptimeRobot HTTP monitors (owner
 * directive 2026-08-10: polling and latency-probe liveness can never be
 * silently off, but the free UptimeRobot plan caps at 10 monitors, so each
 * endpoint aggregates a whole check family behind a single monitor). See
 * src/shared/pipelineHealth.ts for the polling_house/polling_senate/
 * polling_executive/latency_probes checks these routes surface.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PipelineCheck, PipelineHealth, PipelineStatus } from '../../shared/pipelineHealth.ts';

const mockCheckPipelineHealth = vi.fn<[], Promise<PipelineHealth>>();

vi.mock('../../shared/pipelineHealth.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/pipelineHealth.ts')>();
  return {
    ...actual,
    checkPipelineHealth: (...args: unknown[]) => mockCheckPipelineHealth(...(args as [])),
  };
});

import { buildRestRouter } from '../rest.ts';
import type { Env } from '../../shared/types.ts';

function makeEnv(): Env {
  const prepare = () => ({
    bind() {
      return this;
    },
    async first<T>() {
      return null as T | null;
    },
    async all<T>() {
      return { results: [] as T[], meta: {} };
    },
    async run() {
      return { success: true, meta: { changes: 0 } };
    },
  });
  return { DB: { prepare } as unknown as D1Database } as unknown as Env;
}

function pollCheck(source: 'house' | 'senate' | 'executive', status: PipelineStatus): PipelineCheck {
  return { id: `polling_${source}`, status, detail: `${source} polling ${status}`, value: null };
}

function latencyCheck(status: PipelineStatus): PipelineCheck {
  return { id: 'latency_probes', status, detail: `latency probes ${status}`, value: null };
}

/** Every other check id checkPipelineHealth normally emits, always 'ok' — the
 *  routes must filter down to only the ids they care about and ignore these. */
function otherChecks(): PipelineCheck[] {
  return [
    { id: 'ingestion_backlog', status: 'ok', detail: 'clear', value: 0 },
    { id: 'autopilot_halt', status: 'ok', detail: 'unhalted', value: 0 },
  ];
}

function health(checks: PipelineCheck[]): PipelineHealth {
  const worst = checks.some((c) => c.status === 'stalled')
    ? 'stalled'
    : checks.some((c) => c.status === 'degraded')
      ? 'degraded'
      : checks.some((c) => c.status === 'unknown')
        ? 'unknown'
        : 'ok';
  return { status: worst, checks };
}

const app = buildRestRouter();

beforeEach(() => {
  mockCheckPipelineHealth.mockReset();
});

describe('GET /health/polling', () => {
  it('200 with ok=true when all three chambers are ok', async () => {
    mockCheckPipelineHealth.mockResolvedValue(
      health([...otherChecks(), pollCheck('house', 'ok'), pollCheck('senate', 'ok'), pollCheck('executive', 'ok')]),
    );
    const res = await app.request('http://localhost/health/polling', {}, makeEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = (await res.json()) as { ok: boolean; checks: PipelineCheck[] };
    expect(body.ok).toBe(true);
    expect(body.checks).toHaveLength(3);
    expect(body.checks.map((c) => c.id).sort()).toEqual(['polling_executive', 'polling_house', 'polling_senate']);
  });

  it('503 when any one chamber is stalled', async () => {
    mockCheckPipelineHealth.mockResolvedValue(
      health([...otherChecks(), pollCheck('house', 'ok'), pollCheck('senate', 'stalled'), pollCheck('executive', 'ok')]),
    );
    const res = await app.request('http://localhost/health/polling', {}, makeEnv());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; checks: PipelineCheck[] };
    expect(body.ok).toBe(false);
    expect(body.checks.find((c) => c.id === 'polling_senate')?.status).toBe('stalled');
  });

  it('200 when one chamber is unknown (transient collection blips must not page)', async () => {
    mockCheckPipelineHealth.mockResolvedValue(
      health([...otherChecks(), pollCheck('house', 'ok'), pollCheck('senate', 'unknown'), pollCheck('executive', 'ok')]),
    );
    const res = await app.request('http://localhost/health/polling', {}, makeEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; checks: PipelineCheck[] };
    expect(body.ok).toBe(true);
  });
});

describe('GET /health/latency', () => {
  it('200 with ok=true when latency_probes is ok', async () => {
    mockCheckPipelineHealth.mockResolvedValue(health([...otherChecks(), latencyCheck('ok')]));
    const res = await app.request('http://localhost/health/latency', {}, makeEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = (await res.json()) as { ok: boolean; check: PipelineCheck | null };
    expect(body.ok).toBe(true);
    expect(body.check?.id).toBe('latency_probes');
  });

  it('503 when latency_probes is degraded (a single quiet provider must page)', async () => {
    mockCheckPipelineHealth.mockResolvedValue(health([...otherChecks(), latencyCheck('degraded')]));
    const res = await app.request('http://localhost/health/latency', {}, makeEnv());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; check: PipelineCheck | null };
    expect(body.ok).toBe(false);
    expect(body.check?.status).toBe('degraded');
  });

  it('503 when latency_probes is stalled', async () => {
    mockCheckPipelineHealth.mockResolvedValue(health([...otherChecks(), latencyCheck('stalled')]));
    const res = await app.request('http://localhost/health/latency', {}, makeEnv());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; check: PipelineCheck | null };
    expect(body.ok).toBe(false);
    expect(body.check?.status).toBe('stalled');
  });
});

describe('GET /health/senate-relay', () => {
  function relayEnv(url?: string) {
    const store = new Map<string, string>();
    return {
      ...makeEnv(),
      SENATE_RELAY_URL: url,
      CONFIG_KV: {
        get: async (k: string, mode?: string) => {
          const v = store.get(k) ?? null;
          if (v === null) return null;
          return mode === 'json' ? JSON.parse(v) : v;
        },
        put: async (k: string, v: string) => { store.set(k, v); },
      },
    } as unknown as Env;
  }

  it('200 with mode=direct when SENATE_RELAY_URL is unset', async () => {
    const res = await app.request('http://localhost/health/senate-relay', {}, relayEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await res.json() as { ok: boolean; configured: boolean; mode: string };
    expect(body.ok).toBe(true);
    expect(body.configured).toBe(false);
    expect(body.mode).toBe('direct');
  });

  it('503 when the named-tunnel origin returns Cloudflare 502', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('error code: 502', { status: 502 })));
    const res = await app.request(
      'http://localhost/health/senate-relay',
      {},
      relayEnv('https://scout.jays.services'),
    );
    expect(res.status).toBe(503);
    const body = await res.json() as { ok: boolean; host: string; status: number };
    expect(body.ok).toBe(false);
    expect(body.host).toBe('scout.jays.services');
    expect(body.status).toBe(502);
    vi.unstubAllGlobals();
  });

  it('200 when the relay /health answers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, service: 'senate-relay' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
    const res = await app.request(
      'http://localhost/health/senate-relay',
      {},
      relayEnv('https://scout.jays.services'),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; mode: string };
    expect(body.ok).toBe(true);
    expect(body.mode).toBe('relay');
    vi.unstubAllGlobals();
  });
});

describe('GET /health/residential-proxy', () => {
  function proxyEnv(url?: string) {
    const store = new Map<string, string>();
    return {
      ...makeEnv(),
      RESIDENTIAL_PROXY_URL: url,
      CONFIG_KV: {
        get: async (k: string, mode?: string) => {
          const v = store.get(k) ?? null;
          if (v === null) return null;
          return mode === 'json' ? JSON.parse(v) : v;
        },
        put: async (k: string, v: string) => { store.set(k, v); },
      },
    } as unknown as Env;
  }

  it('200 with configured=false when RESIDENTIAL_PROXY_URL is unset', async () => {
    const res = await app.request('http://localhost/health/residential-proxy', {}, proxyEnv());
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; configured: boolean };
    expect(body.ok).toBe(true);
    expect(body.configured).toBe(false);
  });

  it('503 when CONNECT egress fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('Connection refused');
    }));
    const res = await app.request(
      'http://localhost/health/residential-proxy',
      {},
      proxyEnv('http://10.99.0.2:8888'),
    );
    expect(res.status).toBe(503);
    const body = await res.json() as { ok: boolean; host: string };
    expect(body.ok).toBe(false);
    expect(body.host).toBe('10.99.0.2:8888');
    vi.unstubAllGlobals();
  });
});
