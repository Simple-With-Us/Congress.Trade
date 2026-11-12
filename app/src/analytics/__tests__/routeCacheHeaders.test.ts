/**
 * src/analytics/__tests__/routeCacheHeaders.test.ts
 *
 * CT-2418: every route on this router is public and user-independent — it is
 * mounted bare at /api/analytics with no auth middleware — and every one of them
 * already wraps its work in the server-side `cached()` KV helper. None of them
 * told Cloudflare, so none could ever be served from the edge and a repeat view
 * always re-hit the origin.
 *
 * This pins the response header so a future refactor cannot quietly drop it back
 * to `DYNAMIC`.
 */

import { describe, expect, it } from 'vitest';
import { buildAnalyticsRouter } from '../routes.ts';
import type { Env } from '../../shared/types.ts';

function makeEnv(): Env {
  const kv = new Map<string, string>();
  const prepare = (sql: string) => ({
    bind() {
      return this;
    },
    async first<T>() {
      return null;
    },
    async all<T>(): Promise<{ results: T[] }> {
      // Enough shape for the routers' query builders to produce an empty result
      // set without throwing; the point of this file is the headers, not the SQL.
      if (/sqlite_master/i.test(sql)) return { results: [] as T[] };
      return { results: [] as T[] };
    },
    async run() {
      return { success: true, meta: { changes: 0 } };
    },
  });

  return {
    DB: { prepare } as unknown as D1Database,
    CONFIG_KV: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => {
        kv.set(k, v);
      },
      delete: async (k: string) => {
        kv.delete(k);
      },
    },
    INGEST_QUEUE: { send: async () => {}, sendBatch: async () => {} },
    DELIVERY_QUEUE: { send: async () => {}, sendBatch: async () => {} },
  } as unknown as Env;
}

const SHARED_CACHE = 'public, s-maxage=300, stale-while-revalidate=600';

describe('CT-2418 analytics response caching', () => {
  it('marks the public read routes shared-cacheable', async () => {
    const app = buildAnalyticsRouter();
    const env = makeEnv();
    // A representative spread across the router: summary, leaderboards,
    // breakdowns, and a path-param ticker route.
    const paths = [
      '/summary?period=30d',
      '/ticker-leaderboard?period=30d',
      '/party-split?period=30d',
      '/sector-breakdown?period=30d',
      '/ticker/AAPL',
    ];
    for (const path of paths) {
      const res = await app.request(`http://localhost${path}`, {}, env);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('cache-control') ?? '', path).toBe(SHARED_CACHE);
    }
  });

  it('does not stamp a cache directive onto a non-200 response', async () => {
    const app = buildAnalyticsRouter();
    const env = makeEnv();
    // An unknown path must not pick up the header from the middleware, so an
    // error response is never stored under a successful response's key.
    const res = await app.request('http://localhost/not-a-real-route', {}, env);
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control') ?? '').not.toContain('s-maxage');
  });
});