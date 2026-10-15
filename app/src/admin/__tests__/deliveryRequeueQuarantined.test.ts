import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../shared/types.ts';
import { buildAdminRouter } from '../routes.ts';

const app = buildAdminRouter();
const AUTH = { Authorization: 'Bearer admin-secret', 'content-type': 'application/json' };

const sub = {
  id: 'sub_1',
  client_id: 'client_1',
  delivery: 'webhook',
  target_url: 'https://dead.socratictrade.com/hooks',
  active: 1,
};

/** Minimal D1 fake for quarantine recovery + admin route integration. */
function makeRecoveryEnv() {
  const deliveries = new Map<string, { subscription_id: string; tx_id: string; status: string; attempts: number; last_error: string | null }>();
  const prepare = (sql: string) => ({
    params: [] as unknown[],
    bind(...params: unknown[]) {
      this.params = params;
      return this;
    },
    async first<T>() {
      if (/SELECT COUNT\(\*\) AS c FROM deliveries/i.test(sql)) {
        const subscriptionId = this.params[0] as string;
        let c = 0;
        for (const d of deliveries.values()) {
          if (d.subscription_id === subscriptionId && d.status === 'parked') c += 1;
        }
        return { c } as T;
      }
      return null as T | null;
    },
    async all<T>() {
      if (/FROM deliveries d\s+JOIN subscriptions s/i.test(sql) && /status = 'quarantined'/i.test(sql)) {
        const rows: unknown[] = [];
        for (const d of deliveries.values()) {
          if (d.status !== 'quarantined') continue;
          rows.push({
            subscription_id: d.subscription_id,
            tx_id: d.tx_id,
            target_url: sub.target_url,
          });
        }
        return { results: rows as T[] };
      }
      if (/FROM deliveries d\s+JOIN subscriptions s/i.test(sql) && /status = 'parked'/i.test(sql)) {
        return { results: [] as T[] };
      }
      return { results: [] as T[] };
    },
    async run() {
      if (/UPDATE deliveries\s+SET status = 'parked'/i.test(sql) && /status = 'quarantined'/i.test(sql)) {
        const [, subscriptionId, txId] = this.params as [string, string, string];
        const row = deliveries.get(`${subscriptionId}:${txId}`);
        if (row && row.status === 'quarantined') {
          row.status = 'parked';
          return { success: true, meta: { changes: 1 } };
        }
        return { success: true, meta: { changes: 0 } };
      }
      return { success: true, meta: { changes: 0 } };
    },
  });
  deliveries.set('sub_1:tx_q', {
    subscription_id: 'sub_1',
    tx_id: 'tx_q',
    status: 'quarantined',
    attempts: 0,
    last_error: 'overflow',
  });
  const env = {
    ADMIN_TOKEN: 'admin-secret',
    DELIVERY_TARGET_PARKED_CAP: '5',
    DB: { prepare } as unknown as D1Database,
    DELIVERY_QUEUE: { send: vi.fn(async () => {}) },
    CONFIG_KV: { get: async () => null, put: async () => {}, delete: async () => {} },
  } as unknown as Env;
  return { env, deliveries };
}

function makeNoopEnv() {
  const prepare = () => ({
    bind() { return this; },
    async first() { throw new Error('DB must not be called'); },
    async all() { throw new Error('DB must not be called'); },
    async run() { throw new Error('DB must not be called'); },
  });
  return {
    ADMIN_TOKEN: 'admin-secret',
    DB: { prepare } as unknown as D1Database,
  } as unknown as Env;
}

describe('POST /delivery-requeue-quarantined', () => {
  it('returns 400 for invalid JSON body', async () => {
    const res = await app.request(
      '/delivery-requeue-quarantined',
      { method: 'POST', headers: AUTH, body: 'not-json{' },
      makeNoopEnv(),
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: 'invalid JSON body' });
  });

  it.each([
    { label: 'unknown field', body: { limit: 10, extra: true } },
    { label: 'limit above max', body: { limit: 5001 } },
    { label: 'non-object body', body: 'string' as unknown as Record<string, never> },
    { label: 'empty subscriptionId', body: { subscriptionId: '' } },
  ])('returns 400 for $label without touching the database', async ({ body }) => {
    const res = await app.request(
      '/delivery-requeue-quarantined',
      { method: 'POST', headers: AUTH, body: JSON.stringify(body) },
      makeNoopEnv(),
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: 'invalid request body' });
  });

  it('recovers quarantined rows on a valid body (dryRun)', async () => {
    const { env, deliveries } = makeRecoveryEnv();
    const res = await app.request(
      '/delivery-requeue-quarantined',
      { method: 'POST', headers: AUTH, body: JSON.stringify({ dryRun: true, limit: 10 }) },
      env,
    );
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { ok: boolean; recovery: { recovered: number }; flushed: { scanned: number } };
    expect(payload.ok).toBe(true);
    expect(payload.recovery.recovered).toBe(1);
    expect(payload.flushed).toMatchObject({ scanned: 0, released: 0, skipped: 0, quarantineRecovered: 0 });
    expect(deliveries.get('sub_1:tx_q')!.status).toBe('quarantined');
  });

  it('applies default limit when the body is empty', async () => {
    const { env } = makeRecoveryEnv();
    const res = await app.request(
      '/delivery-requeue-quarantined',
      { method: 'POST', headers: AUTH, body: '{}' },
      env,
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, recovery: { scanned: 1 } });
  });
});
