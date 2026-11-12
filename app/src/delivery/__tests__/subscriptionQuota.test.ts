import { describe, expect, it } from 'vitest';
import {
  assertSubscriptionQuota,
  deleteSubscription,
  MAX_ACTIVE_SUBSCRIPTIONS_PER_USER,
  MAX_SUBSCRIPTIONS_PER_USER,
  SubscriptionQuotaError,
  updateSubscription,
} from '../subscriptions.ts';
import type { Env } from '../../shared/types.ts';

function envWithCounts(total: number, active: number): Env {
  return { DB: { prepare: () => ({
    bind() { return this; },
    async first<T>() { return { total, active } as T; },
    async all<T>() { return { results: [{ total, active } as T] }; },
  }) } as unknown as D1Database } as Env;
}

describe('durable subscription quotas', () => {
  it('rejects total and active creation limits', async () => {
    await expect(assertSubscriptionQuota(envWithCounts(MAX_SUBSCRIPTIONS_PER_USER, 0), 'user:u', { creating: true }))
      .rejects.toBeInstanceOf(SubscriptionQuotaError);
    await expect(assertSubscriptionQuota(envWithCounts(5, MAX_ACTIVE_SUBSCRIPTIONS_PER_USER), 'user:u', { creating: true }))
      .rejects.toBeInstanceOf(SubscriptionQuotaError);
  });

  it('rejects reactivation at the active limit but permits an in-budget account', async () => {
    await expect(assertSubscriptionQuota(envWithCounts(10, MAX_ACTIVE_SUBSCRIPTIONS_PER_USER), 'user:u', { activating: true }))
      .rejects.toBeInstanceOf(SubscriptionQuotaError);
    await expect(assertSubscriptionQuota(envWithCounts(1, 1), 'user:u', { creating: true })).resolves.toBeUndefined();
  });

  it('normalizes a trigger race during update into SubscriptionQuotaError', async () => {
    const env = {
      DB: { prepare: (sql: string) => ({
        bind() { return this; },
        async run() {
          if (/UPDATE subscriptions/i.test(sql)) throw new Error('D1_ERROR: subscription active quota exceeded');
          return { success: true, meta: { changes: 1 } };
        },
        async first<T>() { return null as T | null; },
      }) } as unknown as D1Database,
    } as unknown as Env;
    await expect(updateSubscription(env, 'sub_1', { active: true })).rejects.toBeInstanceOf(SubscriptionQuotaError);
  });

  it('deleteSubscription removes an existing row and no-ops when missing', async () => {
    const deleted: string[] = [];
    const env = {
      DB: {
        prepare: (sql: string) => ({
          params: [] as unknown[],
          bind(...params: unknown[]) {
            this.params = params;
            return this;
          },
          async first<T>() {
            if (/FROM subscriptions WHERE id = \?/i.test(sql) && this.params[0] === 'sub_alive') {
              return {
                id: 'sub_alive',
                client_id: 'user:u',
                delivery: 'sse',
                target_url: null,
                secret: 's',
                filters: '{}',
                cursor: 0,
                active: 1,
                created_at: '2026-01-01T00:00:00.000Z',
              } as T;
            }
            return null as T | null;
          },
          async run() {
            if (/DELETE FROM subscriptions/i.test(sql)) deleted.push(`sub:${this.params[0]}`);
            if (/DELETE FROM sse_leases/i.test(sql)) deleted.push(`lease:${this.params[0]}`);
            return { success: true, meta: { changes: 1 } };
          },
        }),
      } as unknown as D1Database,
    } as unknown as Env;

    await expect(deleteSubscription(env, 'missing')).resolves.toBe(false);
    expect(deleted).toEqual([]);
    await expect(deleteSubscription(env, 'sub_alive')).resolves.toBe(true);
    expect(deleted).toEqual(['sub:sub_alive', 'lease:sub_alive']);
  });
});
