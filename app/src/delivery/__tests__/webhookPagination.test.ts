import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../shared/types.ts';
import {
  DeliveryRetryError,
  WEBHOOK_FANOUT_CONCURRENCY,
  WEBHOOK_SUBSCRIPTION_PAGE_SIZE,
  dispatchWebhook,
  visitActiveWebhookSubscriptionPage,
} from '../webhook.ts';
import type { SubscriptionRow } from '../rows.ts';

function subscription(id: number): SubscriptionRow {
  return {
    id: `sub_${String(id).padStart(4, '0')}`, client_id: 'client', delivery: 'webhook',
    target_url: 'https://example.com/hook', secret: 'secret', filters: '{}', cursor: 0,
    active: 1, created_at: '2026-01-01T00:00:00.000Z',
  };
}

function pageEnv(rows: SubscriptionRow[], failContinuation = false) {
  const sends: unknown[] = [];
  const pageCursors: string[] = [];
  let shouldFail = failContinuation;
  const env = {
    DB: {
      prepare: (sql: string) => ({
        params: [] as unknown[],
        bind(...params: unknown[]) { this.params = params; return this; },
        async all<T>() {
          const after = String(this.params[0]);
          pageCursors.push(after);
          const limit = Number(this.params[1]);
          return { results: rows.filter((row) => row.id > after).slice(0, limit) as T[] };
        },
        async first<T>() {
          if (/FROM transactions WHERE id/i.test(sql)) return ({
            id: 'tx_1', doc_id: 'doc_1', filer_id: 'bio_1', tx_date: '2026-01-01', owner: 'self',
            asset_name: 'Apple', ticker: 'AAPL', asset_type: 'stock', tx_type: 'B', amount_min: 1001,
            amount_max: 15000, is_option: 0, cap_gains_over_200: 0, raw_text: '', confidence: 1,
            source: 'primary', created_at: '2026-01-01T00:00:00.000Z', cursor_seq: 1,
          } as T);
          if (/SELECT chamber FROM filings/i.test(sql)) return { chamber: 'house' } as T;
          if (/FROM securities_ref/i.test(sql)) return null as T | null;
          return null as T | null;
        },
      }),
    } as unknown as D1Database,
    DELIVERY_QUEUE: {
      send: vi.fn(async (message: unknown) => {
        if (shouldFail) throw new Error('queue unavailable');
        sends.push(message);
      }), sendBatch: vi.fn(),
    },
  } as unknown as Env;
  return { env, sends, pageCursors, allowContinuation: () => { shouldFail = false; } };
}

describe('bounded webhook fanout pagination', () => {
  it('visits one page with bounded concurrency and reports a continuation cursor', async () => {
    const rows = Array.from({ length: WEBHOOK_SUBSCRIPTION_PAGE_SIZE + 5 }, (_, i) => subscription(i));
    const { env } = pageEnv(rows);
    let active = 0;
    let maxActive = 0;
    const visited: string[] = [];
    const result = await visitActiveWebhookSubscriptionPage(env, '', async (sub) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      visited.push(sub.id);
      active -= 1;
    });
    expect(result).toMatchObject({
      hasMore: true, visited: WEBHOOK_SUBSCRIPTION_PAGE_SIZE,
      lastScannedId: rows[WEBHOOK_SUBSCRIPTION_PAGE_SIZE - 1].id,
    });
    expect(visited).toHaveLength(WEBHOOK_SUBSCRIPTION_PAGE_SIZE);
    expect(maxActive).toBeLessThanOrEqual(WEBHOOK_FANOUT_CONCURRENCY);
  });

  it('enqueues exactly one continuation after a successful full page', async () => {
    const rows = Array.from({ length: WEBHOOK_SUBSCRIPTION_PAGE_SIZE + 1 }, (_, i) => ({
      ...subscription(i), target_url: null,
    }));
    const { env, sends } = pageEnv(rows);
    await expect(dispatchWebhook(env, 'tx_1')).resolves.toEqual({ outboxComplete: false });
    expect(sends).toEqual([{
      type: 'delivery.dispatch', txId: 'tx_1',
      afterSubscriptionId: rows[WEBHOOK_SUBSCRIPTION_PAGE_SIZE - 1].id,
    }]);
    await expect(dispatchWebhook(env, {
      type: 'delivery.dispatch', txId: 'tx_1',
      afterSubscriptionId: rows[WEBHOOK_SUBSCRIPTION_PAGE_SIZE - 1].id,
    })).resolves.toEqual({ outboxComplete: true });
  });

  it('finishes the bounded page after one target fails and retains the tail cursor', async () => {
    const rows = Array.from({ length: WEBHOOK_SUBSCRIPTION_PAGE_SIZE + 1 }, (_, i) => subscription(i));
    const { env } = pageEnv(rows);
    const visited: string[] = [];
    const result = await visitActiveWebhookSubscriptionPage(env, '', async (sub) => {
      visited.push(sub.id);
      if (sub.id === rows[0].id) throw new Error('receiver failed');
    });
    expect(visited).toHaveLength(WEBHOOK_SUBSCRIPTION_PAGE_SIZE);
    expect(result.failures).toHaveLength(1);
    expect(result.hasMore).toBe(true);
    expect(result.lastScannedId).toBe(rows[WEBHOOK_SUBSCRIPTION_PAGE_SIZE - 1].id);
  });

  it('retries the same page when continuation enqueue fails so the tail is not lost', async () => {
    const rows = Array.from({ length: WEBHOOK_SUBSCRIPTION_PAGE_SIZE + 1 }, (_, i) => ({
      ...subscription(i), target_url: null,
    }));
    const { env, sends, pageCursors, allowContinuation } = pageEnv(rows, true);
    await expect(dispatchWebhook(env, 'tx_1')).rejects.toBeInstanceOf(DeliveryRetryError);
    allowContinuation();
    await dispatchWebhook(env, 'tx_1');
    expect(pageCursors).toEqual(['', '']);
    expect(sends).toHaveLength(1);
  });
});
