/**
 * src/billing/stripe.ts
 * Minimal, dependency-free Stripe REST client for Cloudflare Workers. We only
 * need a few endpoints (Customers, Checkout Sessions, Billing Portal) plus
 * webhook signature verification, so we hit the form-encoded REST API directly
 * rather than pulling in the Node-oriented `stripe` SDK.
 *
 * All calls require STRIPE_SECRET_KEY; checkout readiness additionally requires
 * webhook reconciliation and both prices. Portal readiness intentionally only
 * requires the secret key so existing customers can always manage/cancel.
 */

import type { Env } from '../shared/types.ts';
import { resolveSecret, resolveSecrets } from '../secrets/infisical.ts';
import { trackedFetch } from '../shared/thirdPartyTelemetry.ts';

const STRIPE_API = 'https://api.stripe.com/v1';
// Pin an API version so server-side behaviour/field shapes are stable.
const STRIPE_API_VERSION = '2025-03-31.basil'; // Managed Payments requires basil+
const CHECKOUT_KEYS = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PRICE_MONTHLY',
  'STRIPE_PRICE_ANNUAL',
] as const;
const PORTAL_KEYS = ['STRIPE_SECRET_KEY'] as const;

export interface BillingCapabilities {
  /** Backward-compatible alias for checkoutConfigured. */
  configured: boolean;
  checkoutConfigured: boolean;
  portalConfigured: boolean;
}

/** True when new subscriptions can be safely created and reconciled. */
export function checkoutConfigured(env: Env): boolean {
  return CHECKOUT_KEYS.every((key) => Boolean(env[key]));
}

/** True when an existing Stripe customer can open Billing Portal. */
export function portalConfigured(env: Env): boolean {
  return PORTAL_KEYS.every((key) => Boolean(env[key]));
}

export function billingCapabilities(env: Env): BillingCapabilities {
  const canCheckout = checkoutConfigured(env);
  return {
    configured: canCheckout,
    checkoutConfigured: canCheckout,
    portalConfigured: portalConfigured(env),
  };
}

export async function billingCapabilitiesAsync(env: Env): Promise<BillingCapabilities> {
  const resolved = await resolveSecrets(env, [...CHECKOUT_KEYS]);
  const canCheckout = CHECKOUT_KEYS.every((key) => Boolean(resolved[key]));
  return {
    configured: canCheckout,
    checkoutConfigured: canCheckout,
    portalConfigured: PORTAL_KEYS.every((key) => Boolean(resolved[key])),
  };
}

export async function checkoutConfiguredAsync(env: Env): Promise<boolean> {
  return (await billingCapabilitiesAsync(env)).checkoutConfigured;
}

export async function portalConfiguredAsync(env: Env): Promise<boolean> {
  return (await billingCapabilitiesAsync(env)).portalConfigured;
}

/**
 * Flatten a nested params object into Stripe's bracketed form-encoding, e.g.
 * { line_items: [{ price: 'p', quantity: 1 }] } ->
 *   line_items[0][price]=p&line_items[0][quantity]=1
 */
export function encodeForm(params: Record<string, unknown>): string {
  const out = new URLSearchParams();
  const walk = (prefix: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(`${prefix}[${i}]`, v));
    } else if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        walk(prefix ? `${prefix}[${k}]` : k, v);
      }
    } else {
      out.append(prefix, String(value));
    }
  };
  walk('', params);
  return out.toString();
}

async function stripeSecretKey(env: Env): Promise<string> {
  const secretKey = (await resolveSecret(env, 'STRIPE_SECRET_KEY')).value;
  if (!secretKey) throw new Error('STRIPE_SECRET_KEY not configured');
  return secretKey;
}

async function stripePost<T>(
  env: Env,
  path: string,
  params: Record<string, unknown>,
  idempotencyKey: string,
): Promise<T> {
  const secretKey = await stripeSecretKey(env);
  const res = await trackedFetch(`${STRIPE_API}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${secretKey}`,
      'content-type': 'application/x-www-form-urlencoded',
      'Stripe-Version': STRIPE_API_VERSION,
      'Idempotency-Key': idempotencyKey,
    },
    body: encodeForm(params),
  }, { service: 'billing', operation: 'stripe-api-post' });
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  if (!res.ok) {
    throw new Error(`stripe ${path} failed: ${body?.error?.message || `HTTP ${res.status}`}`);
  }
  return body as T;
}

async function stripeGet<T>(env: Env, path: string): Promise<T> {
  const secretKey = await stripeSecretKey(env);
  const res = await trackedFetch(`${STRIPE_API}${path}`, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${secretKey}`,
      'Stripe-Version': STRIPE_API_VERSION,
    },
  }, { service: 'billing', operation: 'stripe-api-get' });
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  if (!res.ok) {
    throw new Error(`stripe ${path} failed: ${body?.error?.message || `HTTP ${res.status}`}`);
  }
  return body as T;
}

/** Stripe expandable-id fields may be either an id string or `{ id }`. */
export function stripeObjectId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (!value || typeof value !== 'object') return undefined;
  const id = (value as Record<string, unknown>).id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

export interface StripeSubscriptionObject {
  id?: string;
  status?: string;
  customer?: string | { id?: string; email?: string | null; name?: string | null };
  livemode?: boolean;
  current_period_end?: number | null;
  cancel_at_period_end?: boolean;
  trial_end?: number | null;
  items?: { data?: Array<{ price?: string | { id?: string }; current_period_end?: number | null }> };
  metadata?: { userId?: string };
}

export interface StripeCustomerObject {
  id?: string;
  email?: string | null;
  name?: string | null;
}

/** Retrieve one Subscription.  Used by the webhook heal and Admin Premium roster. */
export function retrieveStripeSubscription(
  env: Env,
  subscriptionId: string,
): Promise<StripeSubscriptionObject> {
  return stripeGet<StripeSubscriptionObject>(
    env,
    `/subscriptions/${encodeURIComponent(subscriptionId)}`,
  );
}

export interface StripeSubscriptionList {
  data?: StripeSubscriptionObject[];
  has_more?: boolean;
}

/**
 * List Stripe subscriptions for live Admin reconcile.  Caps at 100 — this
 * product has a handful of Premium members, not a paging problem.
 */
export function listStripeSubscriptions(
  env: Env,
  args: { status?: string; limit?: number } = {},
): Promise<StripeSubscriptionList> {
  const params = new URLSearchParams();
  params.set('status', args.status ?? 'all');
  params.set('limit', String(args.limit ?? 100));
  params.append('expand[]', 'data.customer');
  return stripeGet<StripeSubscriptionList>(env, `/subscriptions?${params.toString()}`);
}

/** Map a Stripe secret-key prefix to the Admin environment label. */
export function stripeEnvironmentFromKey(secretKey: string | undefined | null): 'Production' | 'Sandbox' {
  return (secretKey ?? '').trim().startsWith('sk_test') ? 'Sandbox' : 'Production';
}

/** Map Stripe `livemode` onto the same Sandbox / Production labels Apple uses. */
export function stripeEnvironmentFromLivemode(livemode: unknown): 'Production' | 'Sandbox' | null {
  if (livemode === true) return 'Production';
  if (livemode === false) return 'Sandbox';
  return null;
}

export interface StripeCustomer {
  id: string;
}

/** Create a Stripe customer for a signed-in user. */
export function createCustomer(
  env: Env,
  args: { email: string; metadata?: Record<string, string>; idempotencyKey: string },
): Promise<StripeCustomer> {
  return stripePost<StripeCustomer>(env, '/customers', {
    email: args.email,
    metadata: args.metadata,
  }, args.idempotencyKey);
}

export interface CheckoutSession {
  id: string;
  url: string;
}

/** Create a subscription Checkout Session and return its hosted URL. */
export async function createCheckoutSession(
  env: Env,
  args: {
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    clientReferenceId: string;
    customerId?: string | null;
    customerEmail?: string | null;
    trialDays?: number;
    idempotencyKey: string;
  },
): Promise<CheckoutSession> {
  // Keep PR #262's secret-manager override semantics: an Infisical value wins,
  // while wrangler/env remains the local and migration fallback.
  const managedPayments = (await resolveSecret(env, 'STRIPE_MANAGED_PAYMENTS')).value;
  const params: Record<string, unknown> = {
    mode: 'subscription',
    line_items: [{ price: args.priceId, quantity: 1 }],
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
    client_reference_id: args.clientReferenceId,
    allow_promotion_codes: true,
    // Stripe Managed Payments (merchant-of-record). Gated by env so it only
    // turns on once the account is approved + prices carry an eligible tax code.
    ...(managedPayments === 'true' ? { managed_payments: { enabled: true } } : {}),
    // Carry the user id on the subscription too, so subscription.* webhooks can
    // resolve the user even before the customer<->user link is persisted.
    subscription_data: {
      metadata: { userId: args.clientReferenceId },
      ...(args.trialDays && args.trialDays > 0 ? { trial_period_days: args.trialDays } : {}),
    },
  };
  // A Checkout Session takes EITHER an existing customer OR an email to create one.
  if (args.customerId) params.customer = args.customerId;
  else if (args.customerEmail) params.customer_email = args.customerEmail;
  return stripePost<CheckoutSession>(env, '/checkout/sessions', params, args.idempotencyKey);
}

export interface PortalSession {
  id: string;
  url: string;
}

/** Create a Billing Portal session so a customer can manage their subscription. */
export function createBillingPortalSession(
  env: Env,
  args: {
    customerId: string;
    returnUrl: string;
    idempotencyKey: string;
    configuration?: string;
  },
): Promise<PortalSession> {
  return stripePost<PortalSession>(env, '/billing_portal/sessions', {
    customer: args.customerId,
    return_url: args.returnUrl,
    // Without an explicit configuration Stripe's implicit default can hide
    // the Premium product and render an empty subscription list.
    ...(args.configuration ? { configuration: args.configuration } : {}),
  }, args.idempotencyKey);
}

// ---------------------------------------------------------------------------
// Webhook signature verification (Stripe's `Stripe-Signature` scheme)
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string compare (avoids leaking match length via timing). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
}

/**
 * Verify a Stripe webhook signature. `header` is the `Stripe-Signature` value
 * (`t=<ts>,v1=<sig>,v1=<sig2>,…`); we recompute HMAC-SHA256 over `${t}.${body}`
 * and compare against any provided `v1` signature, rejecting stale timestamps.
 * Returns true only on a valid, fresh signature.
 */
export async function verifyStripeSignature(
  payload: string,
  header: string | null | undefined,
  secret: string,
  toleranceSec = 300,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!header || !secret) return false;
  let timestamp = '';
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=');
    if (k === 't') timestamp = v;
    else if (k === 'v1' && v) signatures.push(v);
  }
  if (!timestamp || signatures.length === 0) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > toleranceSec) return false;
  const expected = await hmacSha256Hex(secret, `${timestamp}.${payload}`);
  return signatures.some((sig) => timingSafeEqual(sig, expected));
}

/**
 * When the secret key has a live/test prefix, the event's `livemode` must match.
 * A missing boolean is a fail — that is the "webhook ignores livemode" hole.
 */
export function stripeEventLivemodeMatchesKey(
  livemode: unknown,
  secretKey: string | undefined,
): boolean {
  const key = (secretKey ?? '').trim();
  const liveKey = key.startsWith('sk_live');
  const testKey = key.startsWith('sk_test');
  if (!liveKey && !testKey) return true;
  if (typeof livemode !== 'boolean') return false;
  return liveKey ? livemode === true : livemode === false;
}
