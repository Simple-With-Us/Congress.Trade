/**
 * src/delivery/__tests__/healthCache.test.ts
 *
 * GET /api/health is the uptime-monitor target; its readiness probe runs ~50
 * schema-introspection queries. The result must be cached in-isolate for ~60 s
 * so monitor polling doesn't re-introspect the schema on every hit.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildRestRouter } from '../rest.ts';
import type { Env } from '../../shared/types.ts';

function makeEnv() {
  let probes = 0;
  const prepare = () => ({
    bind() {
      return this;
    },
    async first<T>() {
      probes += 1;
      return { ok: 1 } as T;
    },
    async all<T>() {
      probes += 1;
      return { results: [{ ok: 1 }] as T[], meta: {} };
    },
    async run() {
      return { success: true, meta: { changes: 0 } };
    },
  });
  const env = { DB: { prepare } as unknown as D1Database } as unknown as Env;
  return { env, probes: () => probes };
}

describe('GET /health readiness caching', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reuses the readiness result for 60s, then re-probes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T00:00:00Z'));
    const { env, probes } = makeEnv();
    const app = buildRestRouter();

    const first = await app.request('http://localhost/health', {}, env);
    expect(first.status).toBe(200);
    const afterFirst = probes();
    expect(afterFirst).toBeGreaterThan(10); // the full schema probe ran once

    const second = await app.request('http://localhost/health', {}, env);
    expect(second.status).toBe(200);
    expect(probes()).toBe(afterFirst); // cache hit: no re-introspection

    vi.setSystemTime(new Date('2026-07-28T00:01:01Z'));
    const third = await app.request('http://localhost/health', {}, env);
    expect(third.status).toBe(200);
    expect(probes()).toBe(afterFirst * 2); // TTL expired: one fresh probe pass
  });

  it('publishes Infisical source status without secret values', async () => {
    const { env } = makeEnv();
    const app = buildRestRouter();
    const res = await app.request('http://localhost/health', {}, env);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      checks?: {
        secrets?: {
          enabled?: boolean;
          sources?: Array<{ name?: string; count?: number }>;
        };
      };
    };
    expect(body.checks?.secrets).toEqual(expect.objectContaining({ enabled: expect.any(Boolean) }));
    const blob = JSON.stringify(body.checks?.secrets ?? {});
    expect(blob).not.toMatch(/secretValue|AGENT_SYNC_TOKEN|sk-|xoxb-/i);
    expect(Array.isArray(body.checks?.secrets?.sources)).toBe(true);
  });

  it('publishes Datadog enablement booleans without keys', async () => {
    const { env } = makeEnv();
    const app = buildRestRouter();
    const res = await app.request('http://localhost/health', {}, {
      ...env,
      DD_API_KEY: 'secret-api-key-must-not-leak',
      DD_SITE: 'us5.datadoghq.com',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      checks?: { datadog?: { logs?: boolean; apm?: boolean; rum?: boolean } };
    };
    expect(body.checks?.datadog).toEqual({ logs: true, apm: true, rum: false });
    expect(JSON.stringify(body)).not.toContain('secret-api-key-must-not-leak');
  });
});
