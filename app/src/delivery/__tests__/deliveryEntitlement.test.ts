/**
 * Delivery-time entitlement enforcement (panel HIGH: trial-and-cancel bypass).
 *
 * Subscription creation is premium-gated, but durable webhook/SSE
 * subscriptions previously kept delivering after the owner's Stripe
 * subscription lapsed. These tests pin the fix: the delivery layer re-checks
 * the canonical entitlement predicate (billing/entitlement over the users
 * row) at webhook dispatch time and at SSE connection time.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../shared/types.ts';
import { dispatchWebhook } from '../webhook.ts';
import { openSseStream } from '../sse.ts';
import { subscriptionOwnerEntitled } from '../subscriptions.ts';

const txRow = {
  id: 'tx_1', doc_id: 'doc_1', filer_id: 'bio_1', tx_date: '2026-06-20', owner: 'self',
  asset_name: 'Apple Inc.', ticker: 'AAPL', asset_type: 'stock', tx_type: 'B',
  amount_min: 1001, amount_max: 15000, is_option: 0, cap_gains_over_200: 0,
  raw_text: 'AAPL purchase', confidence: 0.99, source: 'primary',
  created_at: '2026-06-20T00:00:00.000Z', cursor_seq: 42,
};

interface OwnerState {
  subscription_status: string | null;
  plan: string | null;
}

function userRow(owner: OwnerState) {
  return {
    id: 'user_1', email: 'owner@example.test', name: null, picture: null,
    google_sub: null, email_verified: 1, created_at: '2026-01-01T00:00:00.000Z',
    last_login_at: null, subscription_status: owner.subscription_status, plan: owner.plan,
  };
}

function webhookEnv(clientId: string, owner: OwnerState | null) {
  const runs: Array<{ sql: string; params: unknown[] }> = [];
  const subRow = {
    id: 'sub_1', client_id: clientId, delivery: 'webhook',
    target_url: 'https://hooks.example.test/trade', secret: 'sub_secret', filters: '{}',
    cursor: 0, active: 1, created_at: '2026-06-20T00:00:00.000Z',
  };
  const prepare = (sql: string) => ({
    params: [] as unknown[],
    bind(...params: unknown[]) { this.params = params; return this; },
    async first<T>() {
      if (/FROM transactions WHERE id = \?/i.test(sql)) return txRow as T;
      if (/FROM users WHERE id/i.test(sql)) return (owner ? userRow(owner) : null) as T;
      if (/SELECT chamber FROM filings/i.test(sql)) return { chamber: 'house' } as T;
      if (/FROM securities_ref/i.test(sql)) return { sector: 'Technology', market_cap_bucket: 'mega' } as T;
      if (/FROM subscriptions/i.test(sql)) return subRow as T;
      return null as T | null;
    },
    async all<T>() {
      if (/active = 1 AND delivery = 'webhook'/i.test(sql)) return { results: [subRow] as T[] };
      return { results: [] as T[] };
    },
    async run() {
      runs.push({ sql, params: this.params });
      return { success: true, meta: { changes: 1 } };
    },
  });
  const env = {
    DB: { prepare } as unknown as D1Database,
    DELIVERY_QUEUE: { send: vi.fn(), sendBatch: vi.fn() },
    CONFIG_KV: { get: async () => null, put: async () => {}, delete: async () => {} },
  } as unknown as Env;
  return { env, runs };
}

function targetFetch() {
  let targetCalls = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('https://cloudflare-dns.com/dns-query')) {
      const type = new URL(url).searchParams.get('type');
      return Response.json({ Status: 0, Answer: type === 'A' ? [{ type: 1, data: '93.184.216.34' }] : [] });
    }
    targetCalls += 1;
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
  return { fetchMock, targetCalls: () => targetCalls };
}

describe('subscriptionOwnerEntitled', () => {
  it('gates user-owned subscriptions on the canonical premium predicate', async () => {
    const active = webhookEnv('user:user_1', { subscription_status: 'active', plan: 'monthly' });
    expect(await subscriptionOwnerEntitled(active.env, 'user:user_1')).toBe(true);

    const lapsed = webhookEnv('user:user_1', { subscription_status: 'canceled', plan: 'monthly' });
    expect(await subscriptionOwnerEntitled(lapsed.env, 'user:user_1')).toBe(false);

    const missing = webhookEnv('user:user_1', null);
    expect(await subscriptionOwnerEntitled(missing.env, 'user:user_1')).toBe(false);
  });

  it('leaves operator-provisioned integration ids ungated', async () => {
    const { env } = webhookEnv('integration:socratic', null);
    expect(await subscriptionOwnerEntitled(env, 'integration:socratic')).toBe(true);
    expect(await subscriptionOwnerEntitled(env, null)).toBe(true);
  });
});

describe('webhook dispatch entitlement re-check', () => {
  it('skips delivery for a lapsed owner: no POST, durable skip marker, no retry', async () => {
    const { env, runs } = webhookEnv('user:user_1', { subscription_status: 'canceled', plan: 'monthly' });
    const http = targetFetch();
    vi.stubGlobal('fetch', http.fetchMock);
    try {
      const result = await dispatchWebhook(env, 'tx_1');
      // Resolves (no DeliveryRetryError): the outbox completes instead of
      // retrying a delivery that will never be entitled again.
      expect(result.outboxComplete).toBe(true);
      expect(http.targetCalls()).toBe(0);
      const skip = runs.find((r) => /'skipped'/.test(r.sql));
      expect(skip).toBeDefined();
      expect(skip?.sql).toContain('ON CONFLICT (subscription_id, tx_id) DO NOTHING');
      // No delivery attempt was claimed or recorded.
      expect(runs.some((r) => /status = 'sending'/i.test(r.sql))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('still delivers for an active premium owner', async () => {
    const { env, runs } = webhookEnv('user:user_1', { subscription_status: 'trialing', plan: 'monthly' });
    const http = targetFetch();
    vi.stubGlobal('fetch', http.fetchMock);
    try {
      await dispatchWebhook(env, 'tx_1');
      expect(http.targetCalls()).toBe(1);
      expect(runs.some((r) => /'skipped'/.test(r.sql))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('still delivers for operator-provisioned integrations without a users row', async () => {
    const { env } = webhookEnv('integration:socratic', null);
    const http = targetFetch();
    vi.stubGlobal('fetch', http.fetchMock);
    try {
      await dispatchWebhook(env, 'tx_1');
      expect(http.targetCalls()).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

function sseEnv(clientId: string, owner: OwnerState | null) {
  const writes: Array<{ sql: string; params: unknown[] }> = [];
  const subRow = {
    id: 'sub_1', client_id: clientId, delivery: 'sse', target_url: null,
    secret: 'stream-secret', filters: '{}', cursor: 0, active: 1,
    created_at: '2026-01-01T00:00:00.000Z',
  };
  const prepare = (sql: string) => ({
    params: [] as unknown[],
    bind(...params: unknown[]) { this.params = params; return this; },
    async first<T>() {
      if (/FROM users WHERE id/i.test(sql)) return (owner ? userRow(owner) : null) as T;
      if (/FROM subscriptions/i.test(sql)) return subRow as T;
      return null as T | null;
    },
    async all<T>() { return { results: [] as T[] }; },
    async run() {
      writes.push({ sql, params: this.params });
      return { success: true, meta: { changes: 1 } };
    },
  });
  const env = {
    DB: { prepare } as unknown as D1Database,
    CONFIG_KV: { get: async () => null, put: async () => {}, delete: async () => {} },
  } as unknown as Env;
  return { env, writes };
}

describe('SSE connection entitlement re-check', () => {
  it('refuses a new stream for a lapsed owner before any lease is consumed', async () => {
    const { env, writes } = sseEnv('user:user_1', { subscription_status: 'past_due', plan: 'monthly' });
    const response = await openSseStream(env, 'sub_1', 0, 'stream-secret', '203.0.113.1');
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: string; upgradeRequired: boolean };
    expect(body.error).toContain('Premium');
    expect(body.upgradeRequired).toBe(true);
    expect(writes.some((write) => /sse_leases/i.test(write.sql))).toBe(false);
  });

  it('checks the stream token before revealing owner entitlement state', async () => {
    const { env } = sseEnv('user:user_1', { subscription_status: 'past_due', plan: 'monthly' });
    const response = await openSseStream(env, 'sub_1', 0, 'wrong-token', '203.0.113.1');
    expect(response.status).toBe(401);
  });

  it('opens the stream for an active premium owner', async () => {
    const { env } = sseEnv('user:user_1', { subscription_status: 'active', plan: 'annual' });
    const response = await openSseStream(env, 'sub_1', 0, 'stream-secret', '203.0.113.1', {
      maxStreamMs: 200,
      pollIntervalMs: 10,
      reconnectGraceMs: 100,
      slowReaderTimeoutMs: 100,
    });
    // Admission is the assertion under test; drop the stream body instead of
    // consuming it so tight deadlines cannot flake under CI load.
    expect(response.status).toBe(200);
    await response.body?.cancel();
  });
});
