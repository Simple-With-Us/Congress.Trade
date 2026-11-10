import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  encodeForm,
  verifyStripeSignature,
  stripeEventLivemodeMatchesKey,
  stripeObjectId,
  stripeEnvironmentFromKey,
  stripeEnvironmentFromLivemode,
  billingCapabilities,
  billingCapabilitiesAsync,
  checkoutConfigured,
  portalConfigured,
  createCustomer,
  createCheckoutSession,
  createBillingPortalSession,
} from '../stripe.ts';
import type { Env } from '../../shared/types.ts';

/** Recompute the v1 signature the way Stripe does, for the verify tests. */
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

describe('encodeForm', () => {
  it('bracket-encodes nested arrays/objects and skips null/undefined', () => {
    const s = encodeForm({
      mode: 'subscription',
      line_items: [{ price: 'price_1', quantity: 1 }],
      subscription_data: { metadata: { userId: 'u1' }, trial_period_days: 7 },
      customer: undefined,
      note: null,
    });
    const p = new URLSearchParams(s);
    expect(p.get('mode')).toBe('subscription');
    expect(p.get('line_items[0][price]')).toBe('price_1');
    expect(p.get('line_items[0][quantity]')).toBe('1');
    expect(p.get('subscription_data[metadata][userId]')).toBe('u1');
    expect(p.get('subscription_data[trial_period_days]')).toBe('7');
    expect(s).not.toContain('customer');
    expect(s).not.toContain('note');
  });
});

describe('billing capabilities', () => {
  const ready = {
    STRIPE_SECRET_KEY: 'sk',
    STRIPE_WEBHOOK_SECRET: 'whsec',
    STRIPE_PRICE_MONTHLY: 'price_m',
    STRIPE_PRICE_ANNUAL: 'price_a',
  } as Env;

  it('requires the complete operational billing configuration', () => {
    expect(billingCapabilities({} as Env)).toEqual({
      configured: false,
      checkoutConfigured: false,
      portalConfigured: false,
    });
    expect(checkoutConfigured({ STRIPE_SECRET_KEY: 'sk' } as Env)).toBe(false);
    expect(portalConfigured({ STRIPE_SECRET_KEY: 'sk' } as Env)).toBe(true);
    expect(billingCapabilities(ready)).toEqual({
      configured: true,
      checkoutConfigured: true,
      portalConfigured: true,
    });
  });

  it('respects fail-closed secret resolution instead of reading env bindings directly', async () => {
    expect(await billingCapabilitiesAsync(ready)).toEqual({
      configured: true,
      checkoutConfigured: true,
      portalConfigured: true,
    });
    expect(await billingCapabilitiesAsync({
      ...ready,
      INFISICAL_ALLOW_ENV_FALLBACK: 'false',
    } as Env)).toEqual({
      configured: false,
      checkoutConfigured: false,
      portalConfigured: false,
    });
  });
});

describe('verifyStripeSignature', () => {
  const secret = 'whsec_test';
  const body = '{"id":"evt_1","type":"customer.subscription.updated"}';

  it('accepts a fresh, correct signature', async () => {
    const ts = 1_000_000;
    const header = `t=${ts},v1=${await sign(secret, ts, body)}`;
    expect(await verifyStripeSignature(body, header, secret, 300, ts + 10)).toBe(true);
  });

  it('rejects a tampered body', async () => {
    const ts = 1_000_000;
    const header = `t=${ts},v1=${await sign(secret, ts, body)}`;
    expect(await verifyStripeSignature(body + 'x', header, secret, 300, ts + 10)).toBe(false);
  });

  it('rejects a stale timestamp outside tolerance', async () => {
    const ts = 1_000_000;
    const header = `t=${ts},v1=${await sign(secret, ts, body)}`;
    expect(await verifyStripeSignature(body, header, secret, 300, ts + 10_000)).toBe(false);
  });

  it('rejects missing header / wrong secret / malformed header', async () => {
    const ts = 1_000_000;
    const header = `t=${ts},v1=${await sign(secret, ts, body)}`;
    expect(await verifyStripeSignature(body, null, secret, 300, ts)).toBe(false);
    expect(await verifyStripeSignature(body, header, 'wrong', 300, ts)).toBe(false);
    expect(await verifyStripeSignature(body, 'garbage', secret, 300, ts)).toBe(false);
  });
});

describe('createCheckoutSession', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs subscription params with trial + customer and returns the URL', async () => {
    let captured: { url: string; body: string; headers: Headers } | null = null;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      captured = { url: String(url), body: String(init.body), headers: new Headers(init.headers) };
      return new Response(JSON.stringify({ id: 'cs_1', url: 'https://stripe/checkout' }), { status: 200 });
    });
    const env = { STRIPE_SECRET_KEY: 'sk_test' } as Env;
    const res = await createCheckoutSession(env, {
      priceId: 'price_m',
      successUrl: 'https://app/?checkout=success',
      cancelUrl: 'https://app/?checkout=cancel',
      clientReferenceId: 'u1',
      customerId: 'cus_1',
      trialDays: 7,
      idempotencyKey: 'checkout-key-1',
    });
    expect(res.url).toBe('https://stripe/checkout');
    expect(captured!.url).toContain('/checkout/sessions');
    expect(captured!.headers.get('Idempotency-Key')).toBe('checkout-key-1');
    expect(captured!.headers.get('Stripe-Version')).toBe('2025-03-31.basil');
    const p = new URLSearchParams(captured!.body);
    expect(p.get('mode')).toBe('subscription');
    expect(p.get('line_items[0][price]')).toBe('price_m');
    expect(p.get('customer')).toBe('cus_1');
    expect(p.get('client_reference_id')).toBe('u1');
    expect(p.get('subscription_data[trial_period_days]')).toBe('7');
    expect(p.get('subscription_data[metadata][userId]')).toBe('u1');
  });

  it('throws when the secret key is missing', async () => {
    await expect(
      createCheckoutSession({} as Env, {
        priceId: 'p',
        successUrl: 's',
        cancelUrl: 'c',
        clientReferenceId: 'u1',
        idempotencyKey: 'checkout-key-2',
      }),
    ).rejects.toThrow(/STRIPE_SECRET_KEY/);
  });

  it('preserves the managed-payments env fallback from PR #262', async () => {
    let body = '';
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      body = String(init.body);
      return Response.json({ id: 'cs_1', url: 'https://stripe/checkout' });
    });
    await createCheckoutSession({ STRIPE_SECRET_KEY: 'sk', STRIPE_MANAGED_PAYMENTS: 'true' } as Env, {
      priceId: 'price_m', successUrl: 's', cancelUrl: 'c', clientReferenceId: 'u1',
      idempotencyKey: 'checkout-key-3',
    });
    expect(new URLSearchParams(body).get('managed_payments[enabled]')).toBe('true');
  });

  it('resolves STRIPE_MANAGED_PAYMENTS from Infisical secrets, overriding the env/wrangler.toml fallback', async () => {
    let captured: { url: string; body: string } | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith('/api/v1/auth/universal-auth/login')) {
          return Response.json({ accessToken: 'infisical-token' });
        }
        if (u.includes('/api/v3/secrets/raw')) {
          return Response.json({ secrets: [{ secretKey: 'STRIPE_MANAGED_PAYMENTS', secretValue: 'true' }] });
        }
        captured = { url: u, body: String(init?.body) };
        return new Response(JSON.stringify({ id: 'cs_1', url: 'https://stripe/checkout' }), { status: 200 });
      }),
    );
    const env = {
      STRIPE_SECRET_KEY: 'sk_test',
      // wrangler.toml-backed fallback ("false"); must be overridden by the
      // Infisical-provided "true" above, proving createCheckoutSession() is
      // now resolveSecret-backed rather than reading env.STRIPE_MANAGED_PAYMENTS
      // directly.
      STRIPE_MANAGED_PAYMENTS: 'false',
      INFISICAL_BASE_URL: 'https://infisical.test',
      INFISICAL_ENV: 'prod',
      INFISICAL_APP_PROJECT_ID: 'billing-managed-payments',
      INFISICAL_APP_CLIENT_ID: 'app-client',
      INFISICAL_APP_CLIENT_SECRET: 'app-secret',
    } as unknown as Env;
    await createCheckoutSession(env, {
      priceId: 'price_m',
      successUrl: 'https://app/?checkout=success',
      cancelUrl: 'https://app/?checkout=cancel',
      clientReferenceId: 'u1',
      idempotencyKey: 'checkout-key-4',
    });
    const p = new URLSearchParams(captured!.body);
    expect(p.get('managed_payments[enabled]')).toBe('true');
  });
});

describe('Stripe write idempotency', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends explicit keys for customer and portal creation', async () => {
    const calls: Array<{ path: string; key: string | null }> = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ path: new URL(url).pathname, key: new Headers(init?.headers).get('Idempotency-Key') });
      return url.endsWith('/customers')
        ? Response.json({ id: 'cus_1' })
        : Response.json({ id: 'bps_1', url: 'https://stripe/portal' });
    });
    const env = { STRIPE_SECRET_KEY: 'sk' } as Env;
    await createCustomer(env, { email: 'u@example.com', idempotencyKey: 'customer-key' });
    await createBillingPortalSession(env, {
      customerId: 'cus_1', returnUrl: 'https://app/', idempotencyKey: 'portal-key',
    });
    expect(calls).toEqual([
      { path: '/v1/customers', key: 'customer-key' },
      { path: '/v1/billing_portal/sessions', key: 'portal-key' },
    ]);
  });

  it('sends the Billing Portal configuration so the hosted page lists Premium', async () => {
    let body = '';
    vi.stubGlobal('fetch', async (_input: string | URL | Request, init?: RequestInit) => {
      body = String(init?.body ?? '');
      return Response.json({ id: 'bps_1', url: 'https://stripe/portal' });
    });
    await createBillingPortalSession({ STRIPE_SECRET_KEY: 'sk' } as Env, {
      customerId: 'cus_1',
      returnUrl: 'https://app/',
      idempotencyKey: 'portal-key',
      configuration: 'bpc_live_premium',
    });
    expect(body).toContain('configuration=bpc_live_premium');
    expect(body).toContain('customer=cus_1');
  });
});

describe('stripeEventLivemodeMatchesKey', () => {
  it('requires livemode to match a live or test key prefix', () => {
    expect(stripeEventLivemodeMatchesKey(true, 'sk_live_abc')).toBe(true);
    expect(stripeEventLivemodeMatchesKey(false, 'sk_test_abc')).toBe(true);
    expect(stripeEventLivemodeMatchesKey(false, 'sk_live_abc')).toBe(false);
    expect(stripeEventLivemodeMatchesKey(true, 'sk_test_abc')).toBe(false);
  });

  it('rejects a missing livemode when the key prefix is checkable', () => {
    expect(stripeEventLivemodeMatchesKey(undefined, 'sk_live_abc')).toBe(false);
    expect(stripeEventLivemodeMatchesKey('true', 'sk_test_abc')).toBe(false);
  });

  it('skips the check when the key has no live/test prefix', () => {
    expect(stripeEventLivemodeMatchesKey(undefined, 'sk_abc')).toBe(true);
    expect(stripeEventLivemodeMatchesKey(true, undefined)).toBe(true);
  });
});

describe('stripeObjectId / environment labels', () => {
  it('reads a string id or an expanded object id', () => {
    expect(stripeObjectId('sub_1')).toBe('sub_1');
    expect(stripeObjectId({ id: 'cus_1' })).toBe('cus_1');
    expect(stripeObjectId({})).toBeUndefined();
    expect(stripeObjectId(null)).toBeUndefined();
  });

  it('maps Stripe key prefix and livemode onto Sandbox vs Production', () => {
    expect(stripeEnvironmentFromKey('sk_test_abc')).toBe('Sandbox');
    expect(stripeEnvironmentFromKey('sk_live_abc')).toBe('Production');
    expect(stripeEnvironmentFromLivemode(false)).toBe('Sandbox');
    expect(stripeEnvironmentFromLivemode(true)).toBe('Production');
    expect(stripeEnvironmentFromLivemode(undefined)).toBeNull();
  });
});
