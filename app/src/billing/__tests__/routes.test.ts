import { afterEach, describe, it, expect, vi } from 'vitest';
import { buildBillingRouter } from '../routes.ts';
import { ANONYMOUS_ENTITLEMENT } from '../entitlement.ts';
import type { Env } from '../../shared/types.ts';

const BILLING_READY = {
  STRIPE_SECRET_KEY: 'sk_test',
  STRIPE_WEBHOOK_SECRET: 'whsec',
  STRIPE_PRICE_MONTHLY: 'price_m',
  STRIPE_PRICE_ANNUAL: 'price_a',
} as const;

async function sign(secret: string, ts: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}.${body}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface URow {
  id: string;
  stripe_customer_id: string | null;
  subscription_status: string | null;
  plan: string | null;
  stripe_subscription_id: string | null;
  current_period_end: string | null;
  cancel_at_period_end: number;
  trial_end: string | null;
  email: string;
  name: null;
  picture: null;
  google_sub: null;
  email_verified: number;
  created_at: string;
  last_login_at: null;
}

interface FakeCounters {
  customerLinks: number;
  subscriptionApplies: number;
  subscriptionEnds: number;
  webhookEventClaims: number;
  webhookEventProcessed: number;
  webhookEventReleased: number;
}

interface SubscriptionEventState {
  created: number;
  priority: number;
  eventId: string;
}

interface FakeWebhookEvent {
  eventType: string;
  receivedAt: string;
  processedAt: string | null;
  claimToken: string | null;
  claimExpiresAt: string | null;
}

function compareOrder(a: SubscriptionEventState, b: SubscriptionEventState): number {
  return a.created - b.created || a.priority - b.priority || a.eventId.localeCompare(b.eventId);
}

/** Minimal `apple_subscriptions` row (migration 0081) for the IAP ledger seed. */
interface AppleRow {
  user_id: string | null;
  status: string;
  plan: string;
  expires_date: string | null;
  auto_renew_status: number | null;
  original_transaction_id: string;
  product_id: string;
  environment: string | null;
  latest_transaction_id: string | null;
  purchase_date: string | null;
  auto_renew_product_id: string | null;
  revoked_at: string | null;
  revocation_reason: number | null;
  last_notification_type: string | null;
  last_notification_subtype: string | null;
  created_at: string;
  updated_at: string;
}

function appleRow(over: Partial<AppleRow> = {}): AppleRow {
  return {
    user_id: 'u1', status: 'active', plan: 'monthly', expires_date: null, auto_renew_status: 1,
    original_transaction_id: 'ot_1', product_id: 'trade.congress.premium.monthly', environment: 'Production',
    latest_transaction_id: 't_1', purchase_date: null, auto_renew_product_id: null, revoked_at: null,
    revocation_reason: null, last_notification_type: null, last_notification_subtype: null,
    created_at: 'now', updated_at: 'now',
    ...over,
  };
}

function fakeEnv(
  over: Record<string, unknown> = {},
  seed: URow[] = [],
  appleSeed: AppleRow[] = [],
): {
  env: Env;
  rows: Map<string, URow>;
  counters: FakeCounters;
  webhookEvents: Map<string, FakeWebhookEvent>;
  subscriptionEvents: Map<string, SubscriptionEventState>;
} {
  const rows = new Map<string, URow>(seed.map((r) => [r.id, r]));
  const webhookEvents = new Map<string, FakeWebhookEvent>();
  const subscriptionEvents = new Map<string, SubscriptionEventState>();
  const counters: FakeCounters = {
    customerLinks: 0,
    subscriptionApplies: 0,
    subscriptionEnds: 0,
    webhookEventClaims: 0,
    webhookEventProcessed: 0,
    webhookEventReleased: 0,
  };
  const env = {
    CONFIG_KV: {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
    },
    STRIPE_PRICE_MONTHLY: 'price_m',
    STRIPE_PRICE_ANNUAL: 'price_a',
    DB: {
      prepare: (sql: string) => ({
        _p: [] as unknown[],
        bind(...p: unknown[]) {
          this._p = p;
          return this;
        },
        async first<T>() {
          if (/SELECT id FROM users WHERE stripe_customer_id/i.test(sql)) {
            const r = [...rows.values()].find((x) => x.stripe_customer_id === this._p[0]);
            return (r ? { id: r.id } : null) as T | null;
          }
          if (/SELECT \* FROM users WHERE id/i.test(sql)) {
            return ((rows.get(this._p[0] as string) ?? null) as unknown) as T | null;
          }
          // activeAppleSubscriptionForUser (billing/appleSubscriptions.ts) — the
          // second OR term resolveEntitlementAsync consults for Apple-purchased
          // Premium. Mirrors that query's own status/expiry predicate.
          if (/FROM apple_subscriptions[\s\S]*WHERE user_id/i.test(sql)) {
            const [userId, nowIso] = this._p as [string, string];
            const r = appleSeed.find((x) => (
              x.user_id === userId
              && (x.status === 'active' || x.status === 'grace_period')
              && (x.expires_date === null || x.expires_date > nowIso)
            ));
            return ((r ?? null) as unknown) as T | null;
          }
          if (/FROM stripe_subscription_event_state WHERE subscription_id/i.test(sql)) {
            const state = subscriptionEvents.get(this._p[0] as string);
            return (state ? { last_event_id: state.eventId } : null) as T | null;
          }
          if (/SELECT processed_at FROM stripe_webhook_events/i.test(sql)) {
            const event = webhookEvents.get(this._p[0] as string);
            return (event ? { processed_at: event.processedAt } : null) as T | null;
          }
          return null as T | null;
        },
        async run() {
          const p = this._p;
          if (/INSERT INTO stripe_subscription_event_state/i.test(sql)) {
            const [subscriptionId, , created, priority, eventId] = p as [string, string, number, number, string];
            const incoming = { created, priority, eventId };
            const current = subscriptionEvents.get(subscriptionId);
            if (!current || compareOrder(incoming, current) >= 0) {
              subscriptionEvents.set(subscriptionId, incoming);
              return { success: true, meta: { changes: 1 } } as unknown as D1Result;
            }
            return { success: true, meta: { changes: 0 } } as unknown as D1Result;
          }
          if (/INSERT OR IGNORE INTO stripe_webhook_events/i.test(sql)) {
            const [eventId, eventType, receivedAt, claimToken, claimExpiresAt] = p as [
              string, string, string, string, string,
            ];
            if (webhookEvents.has(eventId)) {
              return { success: true, meta: { changes: 0 } } as unknown as D1Result;
            }
            webhookEvents.set(eventId, { eventType, receivedAt, processedAt: null, claimToken, claimExpiresAt });
            counters.webhookEventClaims += 1;
            return { success: true, meta: { changes: 1 } } as unknown as D1Result;
          }
          if (/SET event_type = \?, claim_token = \?/i.test(sql)) {
            const [eventType, claimToken, claimExpiresAt, eventId, now] = p as [
              string, string, string, string, string,
            ];
            const event = webhookEvents.get(eventId);
            if (
              event
              && !event.processedAt
              && (!event.claimToken || !event.claimExpiresAt || event.claimExpiresAt <= now)
            ) {
              Object.assign(event, { eventType, claimToken, claimExpiresAt });
              counters.webhookEventClaims += 1;
              return { success: true, meta: { changes: 1 } } as unknown as D1Result;
            }
            return { success: true, meta: { changes: 0 } } as unknown as D1Result;
          }
          if (/SET processed_at = \?, claim_token = NULL/i.test(sql)) {
            const [processedAt, eventId, claimToken] = p as [string, string, string];
            const event = webhookEvents.get(eventId);
            if (event && !event.processedAt && event.claimToken === claimToken) {
              event.processedAt = processedAt;
              event.claimToken = null;
              event.claimExpiresAt = null;
              counters.webhookEventProcessed += 1;
              return { success: true, meta: { changes: 1 } } as unknown as D1Result;
            }
            return { success: true, meta: { changes: 0 } } as unknown as D1Result;
          }
          if (/SET claim_token = NULL, claim_expires_at = NULL/i.test(sql)) {
            const [eventId, claimToken] = p as [string, string];
            const event = webhookEvents.get(eventId);
            const changes = event && !event.processedAt && event.claimToken === claimToken ? 1 : 0;
            if (event && changes) {
              event.claimToken = null;
              event.claimExpiresAt = null;
              counters.webhookEventReleased += 1;
            }
            return { success: true, meta: { changes } } as unknown as D1Result;
          }
          if (/SET\s+stripe_customer_id = \?,\s+stripe_subscription_id/i.test(sql)) {
            if (/EXISTS/i.test(sql)) {
              const [
                cust, sub, status, plan, cpe, cape, trial, id, expectedCustomer,
                stateSub, created, priority, eventId, sameSub, newerCreated,
                sameSecondCreated, eventType, crossStatus,
              ] = p as [
                string, string, string, string | null, string | null, number, string | null, string,
                string, string, number, number, string, string, number, number, string, string,
              ];
              const r = rows.get(id);
              const applied = subscriptionEvents.get(stateSub);
              const current = r?.stripe_subscription_id ? subscriptionEvents.get(r.stripe_subscription_id) : undefined;
              const crossSubscriptionAllowed = current && (
                current.created < newerCreated
                || (
                  current.created === sameSecondCreated
                  && eventType === 'customer.subscription.created'
                  && (crossStatus === 'active' || crossStatus === 'trialing')
                  && (r?.subscription_status === 'canceled' || r?.subscription_status === 'incomplete_expired')
                )
              );
              if (
                r
                && (r.stripe_customer_id === null || r.stripe_customer_id === expectedCustomer)
                && applied?.created === created
                && applied.priority === priority
                && applied.eventId === eventId
                && (
                  r.stripe_subscription_id === null
                  || r.stripe_subscription_id === sameSub
                  || crossSubscriptionAllowed
                )
              ) Object.assign(r, {
                stripe_customer_id: cust, stripe_subscription_id: sub, subscription_status: status,
                plan: plan ?? r.plan, current_period_end: cpe, cancel_at_period_end: cape, trial_end: trial,
              });
              if (r?.subscription_status === status) counters.subscriptionApplies += 1;
            } else {
              const [cust, sub, status, plan, cpe, cape, trial, id, expectedCustomer, sameSub] = p as [
                string, string, string, string | null, string | null, number, string | null, string, string, string,
              ];
              const r = rows.get(id);
              if (
                r
                && (r.stripe_customer_id === null || r.stripe_customer_id === expectedCustomer)
                && (r.stripe_subscription_id === null || r.stripe_subscription_id === sameSub)
              ) {
                Object.assign(r, {
                  stripe_customer_id: cust, stripe_subscription_id: sub, subscription_status: status,
                  plan: plan ?? r.plan, current_period_end: cpe, cancel_at_period_end: cape, trial_end: trial,
                });
                counters.subscriptionApplies += 1;
              }
            }
          } else if (/SET stripe_customer_id = \?[\s\S]+stripe_customer_id IS NULL/i.test(sql)) {
            const [customerId, userId] = p as [string, string, string];
            const r = rows.get(userId);
            const changes = r && (r.stripe_customer_id === null || r.stripe_customer_id === customerId) ? 1 : 0;
            if (r && changes) {
              r.stripe_customer_id = customerId;
              counters.customerLinks += 1;
            }
            return { success: true, meta: { changes } } as unknown as D1Result;
          } else if (/subscription_status = 'canceled'/i.test(sql)) {
            const [id, subscriptionId, stateSub, created, priority, eventId] = p as [
              string, string, string, number, number, string,
            ];
            const r = rows.get(id);
            const applied = subscriptionEvents.get(stateSub);
            if (
              r?.stripe_subscription_id === subscriptionId
              && applied?.created === created
              && applied.priority === priority
              && applied.eventId === eventId
            ) {
              r.subscription_status = 'canceled';
              r.cancel_at_period_end = 0;
              r.trial_end = null;
            }
            counters.subscriptionEnds += 1;
          }
          return { success: true, meta: { changes: 1 } } as unknown as D1Result;
        },
        async all<T>() {
          return { results: [] as T[] };
        },
      }),
    },
    ...over,
  } as unknown as Env;
  return { env, rows, counters, webhookEvents, subscriptionEvents };
}

async function postWebhook(
  app: ReturnType<typeof buildBillingRouter>,
  env: Env,
  event: Record<string, unknown>,
): Promise<Response> {
  const body = JSON.stringify(event);
  const ts = Math.floor(Date.now() / 1000);
  const header = `t=${ts},v1=${await sign('whsec', ts, body)}`;
  return app.request(
    'http://localhost/webhook',
    { method: 'POST', body, headers: { 'stripe-signature': header, 'content-type': 'application/json' } },
    env,
  );
}

describe('billing router', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('GET /status reports unconfigured + anonymous entitlement when signed out', async () => {
    const app = buildBillingRouter();
    const res = await app.request('http://localhost/status', {}, fakeEnv().env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      configured: false,
      checkoutConfigured: false,
      portalConfigured: false,
      hasCustomer: false,
      entitlement: ANONYMOUS_ENTITLEMENT,
    });
  });

  it('GET /status exposes portal-only readiness and an existing customer', async () => {
    const seed: URow = {
      id: 'u1', stripe_customer_id: 'cus_1', subscription_status: 'canceled', plan: 'monthly',
      stripe_subscription_id: 'sub_1', current_period_end: null, cancel_at_period_end: 0, trial_end: null,
      email: 'u1@x.com', name: null, picture: null, google_sub: null, email_verified: 1,
      created_at: 'now', last_login_at: null,
    };
    const sessionKv = {
      get: async () => JSON.stringify({ userId: 'u1' }),
      put: async () => {},
      delete: async () => {},
    };
    const { env } = fakeEnv({ STRIPE_SECRET_KEY: 'sk_test', CONFIG_KV: sessionKv }, [seed]);
    const res = await buildBillingRouter().request(
      'http://localhost/status',
      { headers: { cookie: 'ct_session=session-token' } },
      env,
    );
    expect(await res.json()).toMatchObject({
      configured: false,
      checkoutConfigured: false,
      portalConfigured: true,
      hasCustomer: true,
      entitlement: { status: 'canceled' },
    });
  });

  it('POST /checkout requires sign-in (401 needLogin)', async () => {
    const app = buildBillingRouter();
    const res = await app.request(
      'http://localhost/checkout',
      { method: 'POST', body: JSON.stringify({ plan: 'monthly' }), headers: { 'content-type': 'application/json' } },
      fakeEnv({ STRIPE_SECRET_KEY: 'sk' }).env,
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { needLogin?: boolean }).needLogin).toBe(true);
  });

  it('POST /portal requires sign-in', async () => {
    const app = buildBillingRouter();
    const res = await app.request('http://localhost/portal', { method: 'POST' }, fakeEnv({ STRIPE_SECRET_KEY: 'sk' }).env);
    expect(res.status).toBe(401);
  });

  it('POST /portal accepts a native Bearer session (iOS Manage Subscription)', async () => {
    const seed: URow = {
      id: 'u1', stripe_customer_id: 'cus_1', subscription_status: 'active', plan: 'monthly',
      stripe_subscription_id: 'sub_1', current_period_end: null, cancel_at_period_end: 0, trial_end: null,
      email: 'u1@x.com', name: null, picture: null, google_sub: null, email_verified: 1,
      created_at: 'now', last_login_at: null,
    };
    vi.stubGlobal('fetch', async () => Response.json({ id: 'bps_1', url: 'https://stripe.test/portal' }));
    const sessionKv = {
      get: async (name: string) => name === 'sess:session-token' ? JSON.stringify({ userId: 'u1' }) : null,
      put: async () => {},
      delete: async () => {},
    };
    const { env } = fakeEnv({ STRIPE_SECRET_KEY: 'sk_test', CONFIG_KV: sessionKv }, [seed]);
    const res = await buildBillingRouter().request('http://localhost/portal', {
      method: 'POST',
      headers: { authorization: 'Bearer session-token', 'Idempotency-Key': 'portal-bearer-1' },
    }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: 'https://stripe.test/portal' });
  });

  it('POST /checkout stays disabled when only Billing Portal is configured', async () => {
    const seed: URow = {
      id: 'u1', stripe_customer_id: 'cus_1', subscription_status: 'canceled', plan: 'monthly',
      stripe_subscription_id: 'sub_1', current_period_end: null, cancel_at_period_end: 0, trial_end: null,
      email: 'u1@x.com', name: null, picture: null, google_sub: null, email_verified: 1,
      created_at: 'now', last_login_at: null,
    };
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const sessionKv = {
      get: async () => JSON.stringify({ userId: 'u1' }),
      put: async () => {},
      delete: async () => {},
    };
    const { env } = fakeEnv({ STRIPE_SECRET_KEY: 'sk_test', CONFIG_KV: sessionKv }, [seed]);
    const res = await buildBillingRouter().request('http://localhost/checkout', {
      method: 'POST',
      headers: {
        cookie: 'ct_session=session-token',
        'content-type': 'application/json',
        'Idempotency-Key': 'checkout-disabled-1',
      },
      body: JSON.stringify({ plan: 'monthly' }),
    }, env);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'checkout not configured' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // --- duplicate-subscription guard (POST /checkout) -----------------------
  // Stripe opens a SECOND subscription on a customer that already has one, so
  // every path that reaches the pricing modal while Premium (/pricing,
  // ?pricing=1, the footer link, the PDF redirect) was a double-billing hole —
  // and an Apple IAP subscriber buying here would be charged by both stores.
  describe('POST /checkout duplicate-subscription guard', () => {
    function checkoutUser(over: Partial<URow> = {}): URow {
      return {
        id: 'u1', stripe_customer_id: 'cus_1', subscription_status: null, plan: null,
        stripe_subscription_id: null, current_period_end: null, cancel_at_period_end: 0, trial_end: null,
        email: 'u1@x.com', name: null, picture: null, google_sub: null, email_verified: 1,
        created_at: 'now', last_login_at: null,
        ...over,
      };
    }
    const sessionKv = {
      get: async (key: string) => key === 'sess:session-token' ? JSON.stringify({ userId: 'u1' }) : null,
      put: async () => {},
      delete: async () => {},
    };
    async function postCheckout(seed: URow, appleSeed: AppleRow[] = []): Promise<Response> {
      const { env } = fakeEnv({ ...BILLING_READY, CONFIG_KV: sessionKv }, [seed], appleSeed);
      return buildBillingRouter().request('http://localhost/checkout', {
        method: 'POST',
        body: JSON.stringify({ plan: 'monthly' }),
        headers: {
          cookie: 'ct_session=session-token',
          'content-type': 'application/json',
          'Idempotency-Key': 'checkout-guard-1',
        },
      }, env);
    }

    for (const status of ['active', 'trialing'] as const) {
      it(`refuses a second Stripe checkout while ${status} (409, no Stripe call)`, async () => {
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);
        const res = await postCheckout(checkoutUser({ subscription_status: status, plan: 'monthly' }));
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({ error: 'already_subscribed', source: 'stripe', status });
        expect(fetchSpy).not.toHaveBeenCalled();
      });
    }

    it('refuses a Stripe checkout for an Apple IAP subscriber (409, source apple)', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      // Stripe columns empty — Premium comes only from the apple_subscriptions
      // ledger, which is exactly the cross-store double-billing case.
      const res = await postCheckout(checkoutUser(), [appleRow()]);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: 'already_subscribed', source: 'apple' });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('refuses a second checkout while past_due, where the subscription is live but lapsed', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      const res = await postCheckout(checkoutUser({
        subscription_status: 'past_due', plan: 'monthly', stripe_subscription_id: 'sub_1',
      }));
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: 'already_subscribed', status: 'past_due' });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    // The guard must not strand a lapsed user: these statuses are terminal or
    // never-started, so re-subscribing is legitimate and has to keep working.
    for (const status of ['canceled', 'incomplete_expired', 'incomplete'] as const) {
      it(`still allows a fresh checkout after ${status}`, async () => {
        vi.stubGlobal('fetch', async () => Response.json({ id: 'cs_1', url: 'https://stripe.test/checkout' }));
        const res = await postCheckout(checkoutUser({ subscription_status: status, plan: 'monthly' }));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ url: 'https://stripe.test/checkout' });
      });
    }

    it('still allows a checkout when an Apple subscription has expired', async () => {
      vi.stubGlobal('fetch', async () => Response.json({ id: 'cs_1', url: 'https://stripe.test/checkout' }));
      const res = await postCheckout(checkoutUser(), [appleRow({ status: 'expired' })]);
      expect(res.status).toBe(200);
    });
  });

  it('scopes deterministic Stripe idempotency keys to the user and checkout request', async () => {
    const seed: URow = {
      id: 'u1', stripe_customer_id: null, subscription_status: null, plan: null,
      stripe_subscription_id: null, current_period_end: null, cancel_at_period_end: 0, trial_end: null,
      email: 'u1@x.com', name: null, picture: null, google_sub: null, email_verified: 1,
      created_at: 'now', last_login_at: null,
    };
    const calls: Array<{ path: string; key: string | null }> = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ path: new URL(url).pathname, key: new Headers(init?.headers).get('Idempotency-Key') });
      if (url.endsWith('/customers')) return Response.json({ id: 'cus_1' });
      return Response.json({ id: 'cs_1', url: 'https://stripe.test/checkout' });
    });
    const sessionKv = {
      get: async (key: string) => key === 'sess:session-token' ? JSON.stringify({ userId: 'u1' }) : null,
      put: async () => {},
      delete: async () => {},
    };
    const { env } = fakeEnv({ ...BILLING_READY, CONFIG_KV: sessionKv }, [seed]);
    const app = buildBillingRouter();
    const request = {
      method: 'POST',
      body: JSON.stringify({ plan: 'monthly' }),
      headers: {
        cookie: 'ct_session=session-token',
        'content-type': 'application/json',
        'Idempotency-Key': 'checkout-request-1',
      },
    };

    const first = await app.request('http://localhost/checkout', request, env);
    const second = await app.request('http://localhost/checkout', request, env);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(calls).toEqual([
      { path: '/v1/customers', key: 'congress-trade:customer:u1' },
      { path: '/v1/checkout/sessions', key: 'congress-trade:checkout:monthly:u1:checkout-request-1' },
      { path: '/v1/checkout/sessions', key: 'congress-trade:checkout:monthly:u1:checkout-request-1' },
    ]);
  });

  it('uses the authoritative customer when checkout loses a customer-link race', async () => {
    const seed: URow = {
      id: 'u1', stripe_customer_id: null, subscription_status: null, plan: null,
      stripe_subscription_id: null, current_period_end: null, cancel_at_period_end: 0, trial_end: null,
      email: 'u1@x.com', name: null, picture: null, google_sub: null, email_verified: 1,
      created_at: 'now', last_login_at: null,
    };
    const sessionKv = {
      get: async () => JSON.stringify({ userId: 'u1' }),
      put: async () => {},
      delete: async () => {},
    };
    const { env, rows } = fakeEnv({ ...BILLING_READY, CONFIG_KV: sessionKv }, [seed]);
    let checkoutBody = '';
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/customers')) {
        const row = rows.get('u1');
        if (row) row.stripe_customer_id = 'cus_authoritative';
        return Response.json({ id: 'cus_created' });
      }
      checkoutBody = String(init?.body);
      return Response.json({ id: 'cs_1', url: 'https://stripe.test/checkout' });
    });
    const res = await buildBillingRouter().request('http://localhost/checkout', {
      method: 'POST',
      headers: {
        cookie: 'ct_session=session-token',
        'content-type': 'application/json',
        'Idempotency-Key': 'checkout-race-1',
      },
      body: JSON.stringify({ plan: 'monthly' }),
    }, env);
    expect(res.status).toBe(200);
    expect(rows.get('u1')?.stripe_customer_id).toBe('cus_authoritative');
    expect(new URLSearchParams(checkoutBody).get('customer')).toBe('cus_authoritative');
  });

  it('scopes portal idempotency to the user and request', async () => {
    const seed: URow = {
      id: 'u1', stripe_customer_id: 'cus_1', subscription_status: 'active', plan: 'monthly',
      stripe_subscription_id: 'sub_1', current_period_end: null, cancel_at_period_end: 0, trial_end: null,
      email: 'u1@x.com', name: null, picture: null, google_sub: null, email_verified: 1,
      created_at: 'now', last_login_at: null,
    };
    let key: string | null = null;
    vi.stubGlobal('fetch', async (_input: string | URL | Request, init?: RequestInit) => {
      key = new Headers(init?.headers).get('Idempotency-Key');
      return Response.json({ id: 'bps_1', url: 'https://stripe.test/portal' });
    });
    const sessionKv = {
      get: async (name: string) => name === 'sess:session-token' ? JSON.stringify({ userId: 'u1' }) : null,
      put: async () => {},
      delete: async () => {},
    };
    const { env } = fakeEnv({ STRIPE_SECRET_KEY: 'sk_test', CONFIG_KV: sessionKv }, [seed]);
    const app = buildBillingRouter();
    const res = await app.request('http://localhost/portal', {
      method: 'POST',
      headers: { cookie: 'ct_session=session-token', 'Idempotency-Key': 'portal-request-1' },
    }, env);
    expect(res.status).toBe(200);
    expect(key).toBe('congress-trade:portal:u1:portal-request-1');
  });

  it('forwards STRIPE_PORTAL_CONFIGURATION so the hosted portal lists Premium', async () => {
    const seed: URow = {
      id: 'u1', stripe_customer_id: 'cus_1', subscription_status: 'active', plan: 'monthly',
      stripe_subscription_id: 'sub_1', current_period_end: null, cancel_at_period_end: 0, trial_end: null,
      email: 'u1@x.com', name: null, picture: null, google_sub: null, email_verified: 1,
      created_at: 'now', last_login_at: null,
    };
    let body = '';
    vi.stubGlobal('fetch', async (_input: string | URL | Request, init?: RequestInit) => {
      body = String(init?.body ?? '');
      return Response.json({ id: 'bps_1', url: 'https://stripe.test/portal' });
    });
    const sessionKv = {
      get: async (name: string) => name === 'sess:session-token' ? JSON.stringify({ userId: 'u1' }) : null,
      put: async () => {},
      delete: async () => {},
    };
    const { env } = fakeEnv({
      STRIPE_SECRET_KEY: 'sk_test',
      STRIPE_PORTAL_CONFIGURATION: 'bpc_live_premium',
      CONFIG_KV: sessionKv,
    }, [seed]);
    const res = await buildBillingRouter().request('http://localhost/portal', {
      method: 'POST',
      headers: { cookie: 'ct_session=session-token', 'Idempotency-Key': 'portal-cfg-1' },
    }, env);
    expect(res.status).toBe(200);
    expect(new URLSearchParams(body).get('configuration')).toBe('bpc_live_premium');
  });

  it('rejects malformed client idempotency keys before calling Stripe', async () => {
    const seed: URow = {
      id: 'u1', stripe_customer_id: 'cus_1', subscription_status: null, plan: null,
      stripe_subscription_id: null, current_period_end: null, cancel_at_period_end: 0, trial_end: null,
      email: 'u1@x.com', name: null, picture: null, google_sub: null, email_verified: 1,
      created_at: 'now', last_login_at: null,
    };
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const sessionKv = {
      get: async () => JSON.stringify({ userId: 'u1' }),
      put: async () => {},
      delete: async () => {},
    };
    const { env } = fakeEnv({ STRIPE_SECRET_KEY: 'sk_test', CONFIG_KV: sessionKv }, [seed]);
    const res = await buildBillingRouter().request('http://localhost/portal', {
      method: 'POST',
      headers: { cookie: 'ct_session=session-token', 'Idempotency-Key': 'not valid spaces' },
    }, env);
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    { path: '/checkout', body: JSON.stringify({ plan: 'monthly' }) },
    { path: '/portal', body: undefined },
  ])('rejects a missing client idempotency key on $path before calling Stripe', async ({ path, body }) => {
    const seed: URow = {
      id: 'u1', stripe_customer_id: 'cus_1', subscription_status: 'active', plan: 'monthly',
      stripe_subscription_id: 'sub_1', current_period_end: null, cancel_at_period_end: 0, trial_end: null,
      email: 'u1@x.com', name: null, picture: null, google_sub: null, email_verified: 1,
      created_at: 'now', last_login_at: null,
    };
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const sessionKv = {
      get: async () => JSON.stringify({ userId: 'u1' }),
      put: async () => {},
      delete: async () => {},
    };
    const { env } = fakeEnv({ ...BILLING_READY, CONFIG_KV: sessionKv }, [seed]);
    const res = await buildBillingRouter().request(`http://localhost${path}`, {
      method: 'POST',
      body,
      headers: {
        cookie: 'ct_session=session-token',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
    }, env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Idempotency-Key required' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POST /webhook is 503 when the signing secret is not configured', async () => {
    const app = buildBillingRouter();
    const res = await app.request('http://localhost/webhook', { method: 'POST', body: '{}' }, fakeEnv().env);
    expect(res.status).toBe(503);
  });

  it('POST /webhook rejects an invalid signature with 400', async () => {
    const app = buildBillingRouter();
    const res = await app.request(
      'http://localhost/webhook',
      { method: 'POST', body: '{"type":"x"}', headers: { 'stripe-signature': 't=1,v1=bad' } },
      fakeEnv({ STRIPE_WEBHOOK_SECRET: 'whsec' }).env,
    );
    expect(res.status).toBe(400);
  });

  it('POST /webhook returns retryable busy when another live claim owns the event', async () => {
    const { env, webhookEvents } = fakeEnv({ STRIPE_WEBHOOK_SECRET: 'whsec' });
    webhookEvents.set('evt_busy', {
      eventType: 'customer.subscription.updated',
      receivedAt: '2026-01-01T00:00:00.000Z',
      processedAt: null,
      claimToken: 'other-worker',
      claimExpiresAt: '2999-01-01T00:00:00.000Z',
    });
    const res = await postWebhook(buildBillingRouter(), env, {
      id: 'evt_busy',
      created: 100,
      type: 'customer.subscription.updated',
      data: { object: {} },
    });
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('5');
    expect(await res.json()).toEqual({ error: 'webhook event is already being processed' });
  });

  it.each([
    { type: 'checkout.session.completed', object: { client_reference_id: 'u1' } },
    { type: 'customer.subscription.created', object: { id: 'sub_1', customer: 'cus_1' } },
    { type: 'customer.subscription.updated', object: { id: 'sub_1', status: 'active', customer: {} } },
    { type: 'customer.subscription.deleted', object: { id: 'sub_1' } },
  ])('POST /webhook releases malformed supported $type events instead of acknowledging them', async ({ type, object }) => {
    const { env, counters, webhookEvents } = fakeEnv({ STRIPE_WEBHOOK_SECRET: 'whsec' });
    const eventId = `evt_malformed_${type.replaceAll('.', '_')}`;
    const res = await postWebhook(buildBillingRouter(), env, {
      id: eventId,
      created: 100,
      type,
      data: { object },
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'webhook handling failed' });
    expect(counters.webhookEventProcessed).toBe(0);
    expect(counters.webhookEventReleased).toBe(1);
    expect(webhookEvents.get(eventId)).toMatchObject({
      processedAt: null,
      claimToken: null,
      claimExpiresAt: null,
    });
  });

  it('POST /webhook applies a subscription update on a valid signature', async () => {
    const seed: URow = {
      id: 'u1', stripe_customer_id: 'cus_1', subscription_status: null, plan: null,
      stripe_subscription_id: null, current_period_end: null, cancel_at_period_end: 0, trial_end: null,
      email: 'u1@x.com', name: null, picture: null, google_sub: null, email_verified: 1,
      created_at: 'now', last_login_at: null,
    };
    const { env, rows } = fakeEnv({ STRIPE_WEBHOOK_SECRET: 'whsec' }, [seed]);
    const event = {
      id: 'evt_sub_update_1',
      created: 100,
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_1', status: 'active', customer: { id: 'cus_1' },
          items: { data: [{ price: { id: 'price_m' } }] },
          current_period_end: 1_900_000_000, cancel_at_period_end: false, trial_end: null,
        },
      },
    };
    const app = buildBillingRouter();
    const res = await postWebhook(app, env, event);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(rows.get('u1')?.subscription_status).toBe('active');
    expect(rows.get('u1')!.plan).toBe('monthly');
  });

  it('POST /webhook invoice.paid (subscription_cycle) applies live Stripe active over trialing', async () => {
    const seed: URow = {
      id: 'u1', stripe_customer_id: 'cus_1', subscription_status: 'trialing', plan: 'monthly',
      stripe_subscription_id: 'sub_1', current_period_end: '2030-01-15T00:00:00.000Z',
      cancel_at_period_end: 0, trial_end: '2030-01-15T00:00:00.000Z',
      email: 'u1@x.com', name: null, picture: null, google_sub: null, email_verified: 1,
      created_at: 'now', last_login_at: null,
    };
    const { env, rows } = fakeEnv({
      STRIPE_WEBHOOK_SECRET: 'whsec',
      STRIPE_SECRET_KEY: 'sk_test_123',
    }, [seed]);
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/v1/subscriptions/sub_1')) {
        return new Response(JSON.stringify({
          id: 'sub_1',
          status: 'active',
          customer: 'cus_1',
          livemode: false,
          items: { data: [{ price: { id: 'price_m' } }] },
          trial_end: null,
        }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${String(url)}`);
    }));
    const res = await postWebhook(buildBillingRouter(), env, {
      id: 'evt_invoice_paid_1',
      created: 2_000,
      type: 'invoice.paid',
      livemode: false,
      data: {
        object: {
          id: 'in_1',
          billing_reason: 'subscription_cycle',
          parent: { subscription_details: { subscription: 'sub_1' } },
          customer: 'cus_1',
        },
      },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(rows.get('u1')?.subscription_status).toBe('active');
    expect(rows.get('u1')!.plan).toBe('monthly');
  });

  it('POST /webhook rejects a livemode that does not match the Stripe key prefix', async () => {
    const { env } = fakeEnv({ STRIPE_WEBHOOK_SECRET: 'whsec', STRIPE_SECRET_KEY: 'sk_live_prod' });
    const res = await postWebhook(buildBillingRouter(), env, {
      id: 'evt_livemode_mismatch',
      created: 100,
      type: 'customer.subscription.updated',
      livemode: false,
      data: { object: { id: 'sub_1', status: 'active', customer: 'cus_1' } },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'livemode does not match Stripe key' });
  });

  it('POST /webhook ignores duplicate checkout.session.completed events', async () => {
    const seed: URow = {
      id: 'u1', stripe_customer_id: null, subscription_status: null, plan: null,
      stripe_subscription_id: null, current_period_end: null, cancel_at_period_end: 0, trial_end: null,
      email: 'u1@x.com', name: null, picture: null, google_sub: null, email_verified: 1,
      created_at: 'now', last_login_at: null,
    };
    const { env, rows, counters } = fakeEnv({ STRIPE_WEBHOOK_SECRET: 'whsec' }, [seed]);
    const event = {
      id: 'evt_checkout_1',
      created: 100,
      type: 'checkout.session.completed',
      data: { object: { client_reference_id: 'u1', customer: { id: 'cus_1' } } },
    };
    const app = buildBillingRouter();

    const first = await postWebhook(app, env, event);
    const second = await postWebhook(app, env, event);

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ received: true });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ received: true, duplicate: true });
    expect(rows.get('u1')!.stripe_customer_id).toBe('cus_1');
    expect(counters.customerLinks).toBe(1);
    expect(counters.webhookEventClaims).toBe(1);
  });

  it('POST /webhook ignores duplicate subscription update events', async () => {
    const seed: URow = {
      id: 'u1', stripe_customer_id: 'cus_1', subscription_status: null, plan: null,
      stripe_subscription_id: null, current_period_end: null, cancel_at_period_end: 0, trial_end: null,
      email: 'u1@x.com', name: null, picture: null, google_sub: null, email_verified: 1,
      created_at: 'now', last_login_at: null,
    };
    const { env, rows, counters } = fakeEnv({ STRIPE_WEBHOOK_SECRET: 'whsec' }, [seed]);
    const event = {
      id: 'evt_sub_update_duplicate',
      created: 100,
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_1', status: 'active', customer: 'cus_1',
          items: { data: [{ price: { id: 'price_m' } }] },
        },
      },
    };
    const app = buildBillingRouter();

    const first = await postWebhook(app, env, event);
    const second = await postWebhook(app, env, event);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ received: true, duplicate: true });
    expect(rows.get('u1')!.subscription_status).toBe('active');
    expect(counters.subscriptionApplies).toBe(1);
    expect(counters.webhookEventProcessed).toBe(1);
  });

  it('POST /webhook ignores an older subscription event delivered later', async () => {
    const seed: URow = {
      id: 'u1', stripe_customer_id: 'cus_1', subscription_status: null, plan: null,
      stripe_subscription_id: null, current_period_end: null, cancel_at_period_end: 0, trial_end: null,
      email: 'u1@x.com', name: null, picture: null, google_sub: null, email_verified: 1,
      created_at: 'now', last_login_at: null,
    };
    const { env, rows, counters } = fakeEnv({ STRIPE_WEBHOOK_SECRET: 'whsec' }, [seed]);
    const object = (status: string) => ({
      id: 'sub_1', status, customer: 'cus_1', items: { data: [{ price: { id: 'price_m' } }] },
    });
    const app = buildBillingRouter();
    await postWebhook(app, env, {
      id: 'evt_newer', created: 200, type: 'customer.subscription.updated', data: { object: object('active') },
    });
    await postWebhook(app, env, {
      id: 'evt_older', created: 100, type: 'customer.subscription.updated', data: { object: object('past_due') },
    });
    expect(rows.get('u1')?.subscription_status).toBe('active');
    expect(counters.subscriptionApplies).toBe(1);
  });

  it('POST /webhook ignores duplicate subscription deleted events', async () => {
    const seed: URow = {
      id: 'u1', stripe_customer_id: 'cus_1', subscription_status: 'active', plan: 'monthly',
      stripe_subscription_id: 'sub_1', current_period_end: null, cancel_at_period_end: 1, trial_end: 'later',
      email: 'u1@x.com', name: null, picture: null, google_sub: null, email_verified: 1,
      created_at: 'now', last_login_at: null,
    };
    const { env, rows, counters } = fakeEnv({ STRIPE_WEBHOOK_SECRET: 'whsec' }, [seed]);
    const event = {
      id: 'evt_sub_deleted_1',
      created: 100,
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_1', customer: { id: 'cus_1' } } },
    };
    const app = buildBillingRouter();

    const first = await postWebhook(app, env, event);
    const second = await postWebhook(app, env, event);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ received: true, duplicate: true });
    expect(rows.get('u1')!.subscription_status).toBe('canceled');
    expect(counters.subscriptionEnds).toBe(1);
  });

  it('POST /webhook returns 500 when verified subscription persistence fails', async () => {
    const seed: URow = {
      id: 'u1', stripe_customer_id: 'cus_1', subscription_status: null, plan: null,
      stripe_subscription_id: null, current_period_end: null, cancel_at_period_end: 0, trial_end: null,
      email: 'u1@x.com', name: null, picture: null, google_sub: null, email_verified: 1,
      created_at: 'now', last_login_at: null,
    };
    const base = fakeEnv({ STRIPE_WEBHOOK_SECRET: 'whsec' }, [seed]);
    const env = {
      ...base.env,
      DB: {
        prepare: (sql: string) => ({
          _p: [] as unknown[],
          bind(...p: unknown[]) {
            this._p = p;
            return this;
          },
          async first<T>() {
            if (/SELECT id FROM users WHERE stripe_customer_id/i.test(sql)) return { id: 'u1' } as T;
            if (/SELECT \* FROM users WHERE id/i.test(sql)) return seed as unknown as T;
            return null as T | null;
          },
          async run() {
            if (/INSERT OR IGNORE INTO stripe_webhook_events/i.test(sql)) {
              return { success: true, meta: { changes: 1 } } as unknown as D1Result;
            }
            if (/SET claim_token = NULL, claim_expires_at = NULL/i.test(sql)) {
              return { success: true, meta: { changes: 1 } } as unknown as D1Result;
            }
            throw new Error('d1 unavailable');
          },
          async all<T>() {
            return { results: [] as T[] };
          },
        }),
      } as unknown as D1Database,
    } as Env;
    const event = {
      id: 'evt_sub_update_fails',
      created: 100,
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_1', status: 'active', customer: 'cus_1',
          items: { data: [{ price: { id: 'price_m' } }] },
        },
      },
    };
    const app = buildBillingRouter();
    const res = await postWebhook(app, env, event);
    expect(res.status).toBe(500);
  });
});
