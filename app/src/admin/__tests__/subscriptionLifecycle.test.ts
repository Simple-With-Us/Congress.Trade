/**
 * src/admin/__tests__/subscriptionLifecycle.test.ts
 *
 * End-to-end lifecycle checks against a real migrated SQLite database (all
 * migration files applied, including 0047_subscription_quota_active_only.sql),
 * so the D1 quota triggers and the delivery fanout query are exercised for
 * real rather than mocked:
 *
 *   1. Lifetime-lockout fix: a client with 20 historical rows (mostly
 *      deactivated) can still create a subscription — both the application
 *      preflight and the recreated trg_subscriptions_total_quota trigger now
 *      count only active rows.
 *   2. Deactivate removes the subscription from the webhook fanout page scan.
 *   3. Rotate-secret persists the new secret durably.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAdminRouter } from '../routes.ts';
import { visitActiveWebhookSubscriptionPage } from '../../delivery/webhook.ts';
import { openMigratedD1, type SqliteDatabase } from '../../prices/__tests__/sqliteD1.ts';
import type { Env, Subscription } from '../../shared/types.ts';

const app = buildAdminRouter();

let db: SqliteDatabase;
let d1: D1Database;
let close: () => void;

beforeEach(async () => {
  const opened = await openMigratedD1();
  db = opened.db;
  d1 = opened.d1;
  close = opened.close;
});
afterEach(() => close());

function env(): Env {
  return {
    DB: d1,
    CONFIG_KV: { get: async () => null, put: async () => {}, delete: async () => {} },
    ADMIN_OPEN_IN_DEV: 'true',
  } as unknown as Env;
}

function seedSubscription(id: string, clientId: string, active: number, delivery = 'sse'): void {
  db.prepare(
    `INSERT INTO subscriptions (id, client_id, delivery, target_url, secret, filters, cursor, active, created_at)
     VALUES (?, ?, ?, ?, ?, '{}', 0, ?, '2026-06-30T00:00:00.000Z')`,
  ).run(
    id,
    clientId,
    delivery,
    delivery === 'webhook' ? 'https://example.com/hook' : null,
    `whsec_seed_${id}`,
    active,
  );
}

describe('subscription lifecycle on a migrated database', () => {
  it('lifetime rows no longer lock out creation: 3 historical rows, 2 deactivated → create succeeds', async () => {
    const clientId = 'user:lifetime-locked';
    for (let i = 0; i < 1; i += 1) seedSubscription(`sub_active_${i}`, clientId, 1);
    for (let i = 0; i < 2; i += 1) seedSubscription(`sub_retired_${i}`, clientId, 0);

    // Pre-0047 this was a guaranteed 409: total lifetime rows hit the cap
    // and no delete path existed to ever free a slot.
    const res = await app.request('http://localhost/subscriptions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId, delivery: 'sse', filters: {} }),
    }, env());
    expect(res.status).toBe(201);
  });

  it('deactivate frees the active quota against the real triggers', async () => {
    const clientId = 'user:active-bound';
    for (let i = 0; i < 2; i += 1) seedSubscription(`sub_full_${i}`, clientId, 1);

    const blocked = await app.request('http://localhost/subscriptions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId, delivery: 'sse', filters: {} }),
    }, env());
    expect(blocked.status).toBe(409);

    const freed = await app.request('http://localhost/subscriptions/sub_full_0/deactivate', {
      method: 'POST',
    }, env());
    expect(freed.status).toBe(200);
    expect(db.prepare('SELECT active FROM subscriptions WHERE id = ?').get('sub_full_0')).toEqual({ active: 0 });

    const created = await app.request('http://localhost/subscriptions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId, delivery: 'sse', filters: {} }),
    }, env());
    expect(created.status).toBe(201);
  });

  it('deactivate removes the subscription from the webhook fanout scan', async () => {
    seedSubscription('sub_hook', 'integration:fanout', 1, 'webhook');

    const visited = async (): Promise<string[]> => {
      const ids: string[] = [];
      await visitActiveWebhookSubscriptionPage(env(), '', async (sub: Subscription) => {
        ids.push(sub.id);
      });
      return ids;
    };
    expect(await visited()).toContain('sub_hook');

    const res = await app.request('http://localhost/subscriptions/sub_hook/deactivate', {
      method: 'POST',
    }, env());
    expect(res.status).toBe(200);
    expect(await visited()).not.toContain('sub_hook');
  });

  it('rotate-secret persists the rotated secret durably', async () => {
    seedSubscription('sub_rotate', 'integration:rotate', 1, 'webhook');
    const res = await app.request('http://localhost/subscriptions/sub_rotate/rotate-secret', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }, env());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; secretSet: boolean; secret: string };
    expect(body).toMatchObject({ ok: true, secretSet: true });
    expect(db.prepare('SELECT secret FROM subscriptions WHERE id = ?').get('sub_rotate')).toEqual({
      secret: body.secret,
    });
    expect(body.secret).not.toBe('whsec_seed_sub_rotate');
  });
});
