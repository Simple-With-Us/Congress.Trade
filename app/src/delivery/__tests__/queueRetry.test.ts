import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('#sentry', () => ({
  withSentry: (_opts: unknown, handler: unknown) => handler,
  setTags: vi.fn(), captureException: vi.fn(),
  withMonitor: (_slug: string, callback: () => unknown) => callback(),
}));

import * as Sentry from '#sentry';
import worker from '../../index.ts';
import { DeliveryRetryError, dispatchWebhook } from '../webhook.ts';
import type { Env, QueueMessage } from '../../shared/types.ts';
import { freshDeliveryDay, freshDeliveryIso } from './freshDeliveryFixtures.ts';

const txRow = {
  id: 'tx_1', doc_id: 'doc_1', filer_id: 'bio_1', tx_date: freshDeliveryDay, owner: 'self',
  asset_name: 'Apple Inc.', ticker: 'AAPL', asset_type: 'stock', tx_type: 'B',
  amount_min: 1001, amount_max: 15000, is_option: 0, cap_gains_over_200: 0,
  raw_text: 'AAPL purchase', confidence: 0.99, source: 'primary',
  filed_date: freshDeliveryDay,
  first_seen_at: freshDeliveryIso,
  created_at: freshDeliveryIso, cursor_seq: 42,
};

const subRow = {
  id: 'sub_retry', client_id: 'user:user_1', delivery: 'webhook',
  target_url: 'https://hooks.example.test/trade', secret: 'sub_secret', filters: '{}',
  cursor: 0, active: 1, created_at: '2026-06-20T00:00:00.000Z',
};

interface DeliveryState {
  id: string; status: string; attempts: number; updated_at: string;
  lease_until: string | null; claim_token: string | null; last_error?: string | null;
}

function publicDnsAndTarget(status = 200) {
  let targetCalls = 0;
  const deliveryAttempts: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://cloudflare-dns.com/dns-query')) {
      const type = new URL(url).searchParams.get('type');
      return Response.json({ Status: 0, Answer: type === 'A' ? [{ type: 1, data: '93.184.216.34' }] : [] });
    }
    targetCalls += 1;
    deliveryAttempts.push(new Headers(init?.headers).get('X-Delivery-Attempt') ?? '');
    if (status !== 200) {
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('nope')); },
        cancel() {},
      }), { status });
    }
    return new Response(
      JSON.stringify({
        receiptVersion: 1,
        delivered: true,
        consumed: true,
        ok: true,
        applied: 1,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  return {
    fetchMock,
    targetCalls: () => targetCalls,
    deliveryAttempts: () => deliveryAttempts,
  };
}

function fakeEnv(
  initial: DeliveryState | null = null,
  subscription = subRow,
  opts: { completionFails?: boolean; outboxExists?: boolean } = {},
) {
  let delivery = initial ? { ...initial } : null;
  const outboxExists = opts.outboxExists ?? true;
  const runs: Array<{ sql: string; params: unknown[] }> = [];
  const prepare = (sql: string) => ({
    params: [] as unknown[],
    bind(...params: unknown[]) { this.params = params; return this; },
    async first<T>() {
      if (/FROM transactions WHERE id = \?/i.test(sql)) return txRow as T;
      // Delivery-time entitlement re-check: the subscription owner is premium.
      if (/FROM users WHERE id/i.test(sql)) {
        return {
          id: 'user_1', email: 'owner@example.test', name: null, picture: null,
          google_sub: null, email_verified: 1, created_at: '2026-01-01T00:00:00.000Z',
          last_login_at: null, subscription_status: 'active', plan: 'monthly',
        } as T;
      }
      if (/SELECT chamber FROM filings/i.test(sql)) return { chamber: 'house' } as T;
      if (/FROM securities_ref/i.test(sql)) return { sector: 'Technology', market_cap_bucket: 'mega' } as T;
      if (/FROM subscriptions/i.test(sql) && /WHERE id = \?/i.test(sql)) {
        if (/active = 1/i.test(sql) && subscription.active !== 1) return null as T | null;
        if (/delivery = 'webhook'/i.test(sql) && subscription.delivery !== 'webhook') return null as T | null;
        return subscription as T;
      }
      if (/FROM deliveries WHERE subscription_id/i.test(sql)) return delivery as T | null;
      return null as T | null;
    },
    async all<T>() {
      if (/active = 1 AND delivery = 'webhook'/i.test(sql)) {
        return { results: subscription.active === 1 && subscription.delivery === 'webhook' ? [subscription] as T[] : [] as T[] };
      }
      if (/FROM delivery_outbox/i.test(sql)) {
        return {
          results: outboxExists
            ? [{ tx_id: 'tx_1', status: 'enqueued', attempts: 1, dead_letter_cycles: 0, available_at: '' }] as T[]
            : [] as T[],
        };
      }
      return { results: [] as T[] };
    },
    async run() {
      runs.push({ sql, params: this.params });
      if (/UPDATE delivery_outbox/i.test(sql) && /status = 'completed'/i.test(sql)) {
        if (opts.completionFails) throw new Error('completion write unavailable');
        return { success: true, meta: { changes: outboxExists ? 1 : 0 } };
      }
      if (/INSERT INTO deliveries/i.test(sql)) {
        delivery = {
          id: String(this.params[0]), status: 'sending', attempts: 1,
          updated_at: String(this.params[3]), claim_token: String(this.params[4]),
          lease_until: String(this.params[5]), last_error: null,
        };
        return { success: true, meta: { changes: 1 } };
      }
      if (/SET status = 'sending'/i.test(sql)) {
        const matches = delivery && delivery.id === this.params[3] && delivery.status === this.params[4]
          && delivery.attempts === this.params[5] && delivery.updated_at === this.params[6];
        if (!matches) return { success: true, meta: { changes: 0 } };
        const current = delivery as DeliveryState;
        delivery = {
          ...current, status: 'sending', attempts: current.attempts + 1,
          claim_token: String(this.params[0]), lease_until: String(this.params[1]),
          updated_at: String(this.params[2]), last_error: null,
        };
        return { success: true, meta: { changes: 1 } };
      }
      if (/SET claim_token = \?, lease_until = \?/i.test(sql)) {
        const matches = delivery?.id === this.params[3] && delivery?.status === 'sending'
          && delivery.attempts >= Number(this.params[4]) && delivery.claim_token === this.params[6];
        if (!matches) return { success: true, meta: { changes: 0 } };
        const current = delivery as DeliveryState;
        delivery = {
          ...current, claim_token: String(this.params[0]), lease_until: String(this.params[1]),
          updated_at: String(this.params[2]), last_error: null,
        };
        return { success: true, meta: { changes: 1 } };
      }
      if (/SET status = 'failed'/i.test(sql)) {
        const matches = delivery?.id === this.params[2] && delivery?.status === 'sending'
          && delivery.attempts >= Number(this.params[3]) && delivery.claim_token === this.params[5];
        if (!matches) return { success: true, meta: { changes: 0 } };
        const current = delivery as DeliveryState;
        delivery = {
          ...current, status: 'failed', last_error: String(this.params[0]),
          updated_at: String(this.params[1]), claim_token: null, lease_until: null,
        };
        return { success: true, meta: { changes: 1 } };
      }
      if (/SET status = \?, attempts = \?/i.test(sql)) {
        const matches = delivery?.id === this.params[4] && delivery?.claim_token === this.params[5];
        if (!matches) return { success: true, meta: { changes: 0 } };
        const current = delivery as DeliveryState;
        delivery = {
          ...current, status: String(this.params[0]), attempts: Number(this.params[1]),
          last_error: this.params[2] == null ? null : String(this.params[2]),
          updated_at: String(this.params[3]), claim_token: null, lease_until: null,
        };
        return { success: true, meta: { changes: 1 } };
      }
      return { success: true, meta: { changes: 1 } };
    },
  });
  const env = {
    DB: { prepare } as unknown as D1Database,
    DELIVERY_QUEUE: { send: vi.fn(), sendBatch: vi.fn() },
    CONFIG_KV: { get: async () => null, put: async () => {}, delete: async () => {} },
  } as unknown as Env;
  return { env, runs, delivery: () => delivery };
}

async function queueOnce(env: Env, attempts = 1) {
  const ack = vi.fn(); const retry = vi.fn();
  const body = { type: 'delivery.dispatch', txId: 'tx_1' } as QueueMessage;
  const batch = { queue: 'congress-feed-delivery', messages: [{ body, attempts, ack, retry }] } as unknown as MessageBatch<QueueMessage>;
  await worker.queue(batch, env, {} as ExecutionContext);
  return { ack, retry };
}

describe('native delivery retry and leases', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses native delayed retry and durable HTTP attempt count', async () => {
    const { env, delivery } = fakeEnv();
    const http = publicDnsAndTarget(503); vi.stubGlobal('fetch', http.fetchMock);
    vi.mocked(Sentry.captureException).mockClear();
    const { ack, retry } = await queueOnce(env);
    expect(http.targetCalls()).toBe(1);
    expect(delivery()).toMatchObject({ status: 'failed', attempts: 1, last_error: 'HTTP 503' });
    expect(retry).toHaveBeenCalledWith({ delaySeconds: expect.any(Number) });
    expect(ack).not.toHaveBeenCalled();
    expect(env.DELIVERY_QUEUE.send).not.toHaveBeenCalled();
    // Expected DeliveryRetryError must not create a Sentry Issue (CONGRESS-TRADE-J).
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('does not consume an HTTP attempt while a crash lease is busy, then reclaims it stale', async () => {
    const state: DeliveryState = {
      id: 'dlv_1', status: 'sending', attempts: 2, updated_at: new Date().toISOString(),
      lease_until: new Date(Date.now() + 60_000).toISOString(), claim_token: 'crashed',
    };
    const { env, delivery } = fakeEnv(state);
    const http = publicDnsAndTarget(200); vi.stubGlobal('fetch', http.fetchMock);
    const first = await queueOnce(env);
    expect(first.retry).toHaveBeenCalledWith({ delaySeconds: expect.any(Number) });
    expect(delivery()?.attempts).toBe(2);
    expect(http.targetCalls()).toBe(0);

    (delivery() as DeliveryState).lease_until = new Date(Date.now() - 1_000).toISOString();
    const second = await queueOnce(env, 2);
    expect(second.ack).toHaveBeenCalledOnce();
    expect(delivery()).toMatchObject({ status: 'delivered', attempts: 3 });
    expect(http.targetCalls()).toBe(1);
  });

  it('retries when App B returns HTTP 200 but consumed=false', async () => {
    const { env, delivery } = fakeEnv();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://cloudflare-dns.com/dns-query')) {
        const type = new URL(url).searchParams.get('type');
        return Response.json({ Status: 0, Answer: type === 'A' ? [{ type: 1, data: '93.184.216.34' }] : [] });
      }
      return new Response(
        JSON.stringify({
          receiptVersion: 1,
          delivered: true,
          consumed: false,
          ok: false,
          applied: 0,
          reason: 'invalid-event',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const { ack, retry } = await queueOnce(env);
    expect(delivery()).toMatchObject({ status: 'failed', attempts: 1, last_error: /consumption failed/ });
    expect(retry).toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
  });

  it('does not ACK successful delivery until durable outbox completion succeeds', async () => {
    const { env, runs } = fakeEnv(null, subRow, { completionFails: true });
    const http = publicDnsAndTarget(200); vi.stubGlobal('fetch', http.fetchMock);
    const { ack, retry } = await queueOnce(env);
    expect(http.targetCalls()).toBe(1);
    expect(runs.some((entry) => /UPDATE delivery_outbox/i.test(entry.sql))).toBe(true);
    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledOnce();
  });

  it('detects a missing legacy origin row before ACKing completed work', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { env, runs } = fakeEnv(null, subRow, { outboxExists: false });
    const http = publicDnsAndTarget(200); vi.stubGlobal('fetch', http.fetchMock);
    const { ack, retry } = await queueOnce(env);
    expect(runs.some((entry) => /UPDATE delivery_outbox/i.test(entry.sql))).toBe(true);
    expect(warn).toHaveBeenCalledWith('ingest.dead_letter', {
      queue: 'delivery',
      reason: 'outbox_missing',
    });
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('CAS claim permits only one concurrent POST', async () => {
    const state: DeliveryState = {
      id: 'dlv_1', status: 'failed', attempts: 1,
      updated_at: '2026-01-01T00:00:00.000Z', lease_until: null, claim_token: null,
    };
    const { env } = fakeEnv(state);
    const http = publicDnsAndTarget(200); vi.stubGlobal('fetch', http.fetchMock);
    const results = await Promise.allSettled([dispatchWebhook(env, 'tx_1'), dispatchWebhook(env, 'tx_1')]);
    expect(http.targetCalls()).toBe(1);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')[0]).toMatchObject({
      reason: expect.any(DeliveryRetryError),
    });
  });

  it('records the fifth HTTP failure and ACKs without another retry layer', async () => {
    const state: DeliveryState = {
      id: 'dlv_1', status: 'failed', attempts: 4,
      updated_at: '2026-01-01T00:00:00.000Z', lease_until: null, claim_token: null,
    };
    const { env, delivery } = fakeEnv(state);
    const http = publicDnsAndTarget(503); vi.stubGlobal('fetch', http.fetchMock);
    const { ack, retry } = await queueOnce(env);
    expect(delivery()).toMatchObject({ status: 'failed', attempts: 5 });
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });

  it('replays an expired final attempt with the same attempt number and no sixth POST', async () => {
    const state: DeliveryState = {
      id: 'dlv_1', status: 'sending', attempts: 5,
      updated_at: '2026-01-01T00:00:00.000Z',
      lease_until: '2026-01-01T00:01:00.000Z', claim_token: 'crashed-final',
    };
    const { env, delivery } = fakeEnv(state);
    const http = publicDnsAndTarget(200); vi.stubGlobal('fetch', http.fetchMock);
    const { ack, retry } = await queueOnce(env);
    expect(http.targetCalls()).toBe(1);
    expect(delivery()).toMatchObject({
      status: 'delivered', attempts: 5, claim_token: null, lease_until: null,
    });
    expect(http.deliveryAttempts()).toEqual(['5']);
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });

  it('ACKs a legacy targeted message after opt-out without fetching', async () => {
    const inactive = { ...subRow, active: 0 };
    const { env } = fakeEnv(null, inactive);
    const http = publicDnsAndTarget(200); vi.stubGlobal('fetch', http.fetchMock);
    await dispatchWebhook(env, {
      type: 'delivery.dispatch', txId: 'tx_1', subscriptionId: inactive.id,
    });
    expect(http.targetCalls()).toBe(0);
  });

  it('rejects a persisted public IP-literal target before outbound fetch', async () => {
    const ipTarget = { ...subRow, target_url: 'https://93.184.216.34/hook' };
    const { env, delivery } = fakeEnv(null, ipTarget);
    const http = publicDnsAndTarget(200); vi.stubGlobal('fetch', http.fetchMock);
    await expect(dispatchWebhook(env, 'tx_1')).rejects.toBeInstanceOf(DeliveryRetryError);
    expect(http.targetCalls()).toBe(0);
    expect(delivery()?.last_error).toContain('must use a hostname');
  });

  it('skips an already delivered row', async () => {
    const state: DeliveryState = {
      id: 'dlv_1', status: 'delivered', attempts: 1,
      updated_at: '2026-01-01T00:00:00.000Z', lease_until: null, claim_token: null,
    };
    const { env } = fakeEnv(state);
    const http = publicDnsAndTarget(200); vi.stubGlobal('fetch', http.fetchMock);
    const { ack, retry } = await queueOnce(env);
    expect(http.targetCalls()).toBe(0);
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });
});
