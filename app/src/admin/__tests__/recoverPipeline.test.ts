/**
 * src/admin/__tests__/recoverPipeline.test.ts
 *
 * Owner 2026-09-20: the price cache froze at 2026-08-03 for 46 days
 * because a transient FMP 401/403 left the daily market-data lane's
 * stamp-on-run key set, preventing any same-day retry. POST
 * /admin/recover-pipeline is the operator one-click that:
 *   1) clears the stamp-on-success KV keys so the next hourly cron tick
 *      re-runs the lane;
 *   2) optionally invokes runPriceRefresh inline to recover the S&P /
 *      price cache immediately.
 *
 * These tests pin down both paths and the auth gate.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildAdminRouter } from '../routes.ts';

const app = buildAdminRouter();

const KV_STATE = new Map<string, string>();

function postJson(path: string, token: string | null, env: Record<string, unknown>, body: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const reqEnv: Record<string, unknown> = {
    CONFIG_KV: {
      get: async (key: string) => KV_STATE.get(key) ?? null,
      put: async (key: string, value: string) => { KV_STATE.set(key, value); },
      delete: async (key: string) => { KV_STATE.delete(key); },
    },
    ...env,
  };
  return app.request(path, { method: 'POST', headers, body: JSON.stringify(body) }, reqEnv as never);
}

describe('POST /admin/recover-pipeline', () => {
  beforeEach(() => {
    KV_STATE.clear();
  });

  it('requires ADMIN_TOKEN (401 without auth)', async () => {
    const res = await postJson('/recover-pipeline', null, {}, {});
    expect(res.status).toBe(401);
  });

  it('rejects bad token (401)', async () => {
    const res = await postJson('/recover-pipeline', 'nope', { ADMIN_TOKEN: 'admin-secret' }, {});
    expect(res.status).toBe(401);
  });

  it('dryRun=true does not touch KV but lists the lanes that WOULD be unstamped', async () => {
    KV_STATE.set('jobs:daily:lastok:market-data', '2026-09-20');
    KV_STATE.set('jobs:daily:lastok:snapshot', '2026-09-20');
    const res = await postJson('/recover-pipeline', 'admin-secret', { ADMIN_TOKEN: 'admin-secret' }, { dryRun: true, priceRefresh: false });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; dryRun: boolean; lanesUnstamped: string[]; priceRefresh: { skipped?: string } };
    expect(body.ok).toBe(true);
    expect(body.dryRun).toBe(true);
    expect(body.lanesUnstamped).toContain('market-data');
    expect(body.lanesUnstamped).toContain('snapshot');
    expect(KV_STATE.has('jobs:daily:lastok:market-data')).toBe(true);
    expect(KV_STATE.has('jobs:daily:lastok:snapshot')).toBe(true);
    expect(body.priceRefresh.skipped).toContain('priceRefresh === false');
  });

  it('default invocation clears every day-stamp + skips priceRefresh when explicitly disabled', async () => {
    KV_STATE.set('jobs:daily:lastok:market-data', '2026-09-20');
    KV_STATE.set('jobs:daily:lastok:snapshot', '2026-09-20');
    KV_STATE.set('jobs:daily:lastok:filer', '2026-09-20');
    KV_STATE.set('jobs:daily:lastok:retention', '2026-09-20');
    const res = await postJson(
      '/recover-pipeline',
      'admin-secret',
      { ADMIN_TOKEN: 'admin-secret' },
      { priceRefresh: false },
    );
    expect(res.status).toBe(200);
    // All four stamps cleared.
    expect(KV_STATE.has('jobs:daily:lastok:market-data')).toBe(false);
    expect(KV_STATE.has('jobs:daily:lastok:snapshot')).toBe(false);
    expect(KV_STATE.has('jobs:daily:lastok:filer')).toBe(false);
    expect(KV_STATE.has('jobs:daily:lastok:retention')).toBe(false);
    const body = (await res.json()) as { lanesUnstamped: string[] };
    expect(body.lanesUnstamped).toEqual(expect.arrayContaining(['market-data', 'snapshot', 'filer', 'retention']));
  });

  it('only unstamps the lanes explicitly requested', async () => {
    KV_STATE.set('jobs:daily:lastok:market-data', '2026-09-20');
    KV_STATE.set('jobs:daily:lastok:snapshot', '2026-09-20');
    KV_STATE.set('jobs:daily:lastok:filer', '2026-09-20');
    const res = await postJson(
      '/recover-pipeline',
      'admin-secret',
      { ADMIN_TOKEN: 'admin-secret' },
      { lanes: ['market-data'], priceRefresh: false },
    );
    expect(res.status).toBe(200);
    expect(KV_STATE.has('jobs:daily:lastok:market-data')).toBe(false);
    expect(KV_STATE.has('jobs:daily:lastok:snapshot')).toBe(true); // untouched
    expect(KV_STATE.has('jobs:daily:lastok:filer')).toBe(true); // untouched
  });

  it('returns 400 for an unknown lane name', async () => {
    const res = await postJson(
      '/recover-pipeline',
      'admin-secret',
      { ADMIN_TOKEN: 'admin-secret' },
      { lanes: ['not-a-real-lane'], priceRefresh: false },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('not-a-real-lane');
  });

  it('no-op when no lane stamps are present (handles already-recovered state cleanly)', async () => {
    // KV_STATE is empty (fresh day, no lane has stamped yet)
    const res = await postJson(
      '/recover-pipeline',
      'admin-secret',
      { ADMIN_TOKEN: 'admin-secret' },
      { priceRefresh: false },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lanesUnstamped: string[] };
    expect(body.lanesUnstamped).toEqual([]);
  });

  it('400 on malformed JSON body', async () => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      Authorization: 'Bearer admin-secret',
    };
    const reqEnv = {
      CONFIG_KV: {
        get: async (key: string) => KV_STATE.get(key) ?? null,
        put: async (key: string, value: string) => { KV_STATE.set(key, value); },
        delete: async (key: string) => { KV_STATE.delete(key); },
      },
      ADMIN_TOKEN: 'admin-secret',
    };
    const res = await app.request(
      '/recover-pipeline',
      { method: 'POST', headers, body: 'not-json{' },
      reqEnv as never,
    );
    expect(res.status).toBe(400);
  });
});
