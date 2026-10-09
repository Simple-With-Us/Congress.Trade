/**
 * src/billing/routes.ts
 * Stripe billing router (mounted at /billing).
 *
 *   GET  /billing/status    -> checkout/portal capabilities + entitlement
 *   POST /billing/checkout  -> { url } : start a subscription Checkout (auth required)
 *   POST /billing/portal    -> { url } : open the Stripe Billing Portal (auth required)
 *   POST /billing/webhook   -> Stripe event sink (signature-verified, no auth)
 *
 * Identity comes from the end-user session cookie or Authorization Bearer
 * (auth/session.ts). Native iOS sends Bearer; the browser keeps the cookie.
 * Entitlement is derived purely from the user's billing fields
 * (entitlement.ts). The webhook is the source of truth for subscription
 * state — checkout/portal just kick off hosted Stripe flows.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { BillingPlan, Env } from '../shared/types.ts';
import { getCurrentUser, getCurrentUserFromRequest } from '../auth/session.ts';
import { getUserById } from '../auth/users.ts';
import { PREMIUM_STATUSES, resolveEntitlementAsync } from './entitlement.ts';
import { notifyPremiumActivation } from './premiumActivationAlert.ts';
import {
  billingCapabilitiesAsync,
  checkoutConfiguredAsync,
  portalConfiguredAsync,
  createCustomer,
  createCheckoutSession,
  createBillingPortalSession,
  verifyStripeSignature,
  stripeEventLivemodeMatchesKey,
  stripeObjectId,
  retrieveStripeSubscription,
} from './stripe.ts';
import { resolveSecret, resolveSecrets } from '../secrets/infisical.ts';
import {
  linkCustomerToUser,
  parseSubscription,
  applySubscription,
  applyRetrievedStripeSubscription,
  endSubscription,
  getUserByStripeCustomerId,
  subscriptionIdFromInvoice,
} from './subscription.ts';
import {
  claimStripeWebhookEvent,
  markStripeWebhookEventProcessed,
  releaseStripeWebhookEvent,
} from './webhookEvents.ts';
import { AppleRedeemError, jwsFromInput, requireAppleIapEnabled, verifyAppleRedemption } from './appleRedeem.ts';
import { clientRedeemWouldResurrectRevoked, getAppleSubscription, upsertAppleSubscription } from './appleSubscriptions.ts';

/** Default free trial when STRIPE_TRIAL_DAYS is unset: 7 days (1 week). */
const DEFAULT_TRIAL_DAYS = 7;
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Stripe statuses that are deliberately NOT premium (see entitlement.ts) but
 * still mean a subscription object is live on the customer, so a second
 * Checkout Session would stack a duplicate subscription on top of it. The way
 * out of these is the Billing Portal (fix the payment method), never a re-buy.
 *
 * Terminal and never-started statuses are absent on purpose: `canceled` and
 * `incomplete_expired` are dead, and `incomplete` is a checkout that never
 * completed — re-subscribing after any of those is legitimate and must work.
 */
const LIVE_NON_PREMIUM_STATUSES: ReadonlySet<string> = new Set(['past_due', 'unpaid', 'paused']);

function requestIdForStripe(c: Context): { id: string } | { error: string } {
  const supplied = c.req.header('Idempotency-Key');
  if (supplied == null) return { error: 'Idempotency-Key required' };
  const id = supplied.trim();
  return REQUEST_ID_RE.test(id) ? { id } : { error: 'invalid Idempotency-Key' };
}

function stripeOperationKey(operation: string, userId: string, requestId?: string): string {
  return ['congress-trade', operation, userId, requestId].filter(Boolean).join(':');
}

/** Public-facing origin for redirects (APP_BASE_URL, else request origin). */
async function baseUrl(c: Context<{ Bindings: Env }>): Promise<string> {
  const configured = (await resolveSecret(c.env, 'APP_BASE_URL')).value?.trim();
  if (configured) return configured.replace(/\/$/, '');
  return new URL(c.req.url).origin;
}

async function trialDays(env: Env): Promise<number> {
  const n = Number((await resolveSecret(env, 'STRIPE_TRIAL_DAYS')).value);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TRIAL_DAYS;
}

async function priceForPlan(env: Env, plan: BillingPlan): Promise<string | undefined> {
  const prices = await resolveSecrets(env, ['STRIPE_PRICE_MONTHLY', 'STRIPE_PRICE_ANNUAL']);
  return plan === 'annual'
    ? prices.STRIPE_PRICE_ANNUAL
    : prices.STRIPE_PRICE_MONTHLY;
}

export function buildBillingRouter(): Hono<{ Bindings: Env }> {
  const r = new Hono<{ Bindings: Env }>();

  // --- GET /billing/status ------------------------------------------------
  r.get('/status', async (c) => {
    const user = await getCurrentUserFromRequest(c);
    return c.json({
      ...(await billingCapabilitiesAsync(c.env)),
      hasCustomer: Boolean(user?.stripeCustomerId),
      entitlement: await resolveEntitlementAsync(c.env, user),
    });
  });

  // --- POST /billing/checkout ---------------------------------------------
  r.post('/checkout', async (c) => {
    const user = await getCurrentUserFromRequest(c);
    if (!user) return c.json({ error: 'sign in to subscribe', needLogin: true }, 401);
    if (!(await checkoutConfiguredAsync(c.env))) return c.json({ error: 'checkout not configured' }, 503);

    let body: { plan?: unknown };
    try {
      body = (await c.req.json()) as { plan?: unknown };
    } catch {
      return c.json({ error: 'invalid JSON' }, 400);
    }
    const plan: BillingPlan = body.plan === 'annual' ? 'annual' : 'monthly';
    const priceId = await priceForPlan(c.env, plan);
    if (!priceId) return c.json({ error: `no Stripe price configured for ${plan} plan` }, 503);
    const requestId = requestIdForStripe(c);
    if ('error' in requestId) return c.json({ error: requestId.error }, 400);

    // Duplicate-subscription guard — deliberately the last thing before any
    // Stripe write, so nothing can reach Checkout around it. Stripe will
    // happily open a SECOND subscription on a customer that already has one,
    // so a Premium user who reaches the pricing modal (via /pricing,
    // ?pricing=1, the footer link or the PDF redirect) would be charged twice
    // once the trials end. The cross-store case is the same defect: an Apple
    // IAP subscriber buying here would be billed by Apple and Stripe at once.
    // resolveEntitlementAsync closes both holes in one check — it ORs the
    // apple_subscriptions ledger onto the Stripe `users` columns.
    const entitlement = await resolveEntitlementAsync(c.env, user);
    if (entitlement.premium) {
      return c.json(
        {
          error: 'already_subscribed',
          message: entitlement.source === 'apple'
            ? 'You already have Premium through the App Store.'
            : 'You already have an active Premium subscription.',
          source: entitlement.source ?? 'stripe',
          status: entitlement.status,
        },
        409,
      );
    }
    // Entitlement has lapsed but a subscription object is still live on the
    // customer, so a new Checkout would stack a duplicate on top of it. The
    // way out of these statuses is the Billing Portal, never a re-buy.
    if (user.subscriptionStatus != null && LIVE_NON_PREMIUM_STATUSES.has(user.subscriptionStatus)) {
      return c.json(
        {
          error: 'already_subscribed',
          message: 'Your Premium subscription needs a payment update, not a new one.',
          source: 'stripe',
          status: user.subscriptionStatus,
        },
        409,
      );
    }

    try {
      // Create the Stripe customer up-front (if needed) so the customer<->user
      // link is persisted before any subscription webhook arrives.
      let customerId = user.stripeCustomerId;
      if (!customerId) {
        const customer = await createCustomer(c.env, {
          email: user.email,
          metadata: { userId: user.id },
          idempotencyKey: stripeOperationKey('customer', user.id),
        });
        customerId = customer.id;
        const linked = await linkCustomerToUser(c.env, user.id, customerId);
        if (!linked) {
          // Another request or webhook linked a customer after our user read.
          // Keep the existing owner link authoritative for this checkout.
          const current = await getUserById(c.env, user.id);
          if (!current?.stripeCustomerId) throw new Error('could not persist Stripe customer link');
          customerId = current.stripeCustomerId;
        }
      }
      const base = await baseUrl(c);
      const session = await createCheckoutSession(c.env, {
        priceId,
        customerId,
        clientReferenceId: user.id,
        successUrl: `${base}/?checkout=success`,
        cancelUrl: `${base}/?checkout=cancel`,
        trialDays: await trialDays(c.env),
        idempotencyKey: stripeOperationKey(`checkout:${plan}`, user.id, requestId.id),
      });
      return c.json({ url: session.url });
    } catch (err) {
      console.error('checkout failed:', (err as Error).message);
      return c.json({ error: 'could not start checkout' }, 502);
    }
  });

  // --- POST /billing/apple/confirm ----------------------------------------
  // DEPRECATED. Old iOS clients still hit this instead of redeem_apple_purchase.
  // It used to write Premium onto users.subscription_status / plan /
  // stripe_subscription_id. entitlementOf reads those columns first and never
  // consults apple_subscriptions, so a REFUND/REVOKE webhook (which only
  // updates the ledger) could not take access away — and replaying the original
  // StoreKit JWS (no revocationDate) minted a permanent users-table grant that
  // #2088/#2092 cannot see. Same path also skipped the Sandbox gate.
  // Grant through the ledger only, with the same verify + revoke-resurrect
  // checks as redeem_apple_purchase / anonymous redeem.
  r.post('/apple/confirm', async (c) => {
    const user = await getCurrentUserFromRequest(c);
    if (!user) return c.json({ error: 'sign in to subscribe', needLogin: true }, 401);
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON' }, 400);
    }
    try {
      await requireAppleIapEnabled(c.env);
      const verified = await verifyAppleRedemption(c.env, jwsFromInput(body));
      const { transaction, plan, originalTransactionId } = verified;
      const existing = await getAppleSubscription(c.env, originalTransactionId);
      if (
        clientRedeemWouldResurrectRevoked(existing, {
          transactionId: transaction.transactionId,
          purchaseDateMs: transaction.purchaseDate != null ? Number(transaction.purchaseDate) : null,
        })
      ) {
        return c.json({ error: 'this Apple subscription was refunded or revoked' }, 400);
      }
      const upserted = await upsertAppleSubscription(c.env, {
        originalTransactionId,
        userId: user.id,
        productId: transaction.productId ?? '',
        plan,
        status: 'active',
        environment: transaction.environment ?? null,
        latestTransactionId: transaction.transactionId ?? null,
        purchaseDate: transaction.purchaseDate != null ? new Date(Number(transaction.purchaseDate)).toISOString() : null,
        expiresDate: transaction.expiresDate != null ? new Date(Number(transaction.expiresDate)).toISOString() : null,
      });
      if (!upserted.ok) {
        return c.json({ error: 'this Apple subscription is already linked to a different account' }, 409);
      }
      // The deprecated path grants Premium just like redeem_apple_purchase, so it
      // must raise the same alert. Old iOS clients still use this route, and
      // without this a real new Apple subscriber arrives silently. Same
      // activationKey shape, so a client that later replays through the modern
      // path is deduped by the ledger claim rather than notifying twice.
      if (upserted.isNew) {
        await notifyPremiumActivation(c.env, {
          activationKey: `apple:${upserted.record.originalTransactionId}`,
          userId: user.id,
          userEmail: user.email,
          source: 'apple',
          plan: upserted.record.plan,
          trialing: false,
        });
      }
      const refreshed = await getUserById(c.env, user.id);
      return c.json({
        ok: true,
        entitlement: await resolveEntitlementAsync(c.env, refreshed),
        plan: upserted.record.plan,
        expiresAt: upserted.record.expiresDate,
        originalTransactionId: upserted.record.originalTransactionId,
      });
    } catch (err) {
      if (err instanceof AppleRedeemError) {
        const status = err.status === 503 ? 503 : 400;
        return c.json({ error: err.message }, status);
      }
      throw err;
    }
  });

  // --- POST /billing/portal -----------------------------------------------
  // Cookie OR Bearer.  iOS Manage Subscription for website/Stripe Premium
  // POSTs here with the native session token; cookie-only getCurrentUser
  // 401'd those callers and the Account sheet told them to sign out.
  r.post('/portal', async (c) => {
    const user = await getCurrentUserFromRequest(c);
    if (!user) return c.json({ error: 'sign in first', needLogin: true }, 401);
    if (!(await portalConfiguredAsync(c.env))) return c.json({ error: 'billing portal not configured' }, 503);
    if (!user.stripeCustomerId) return c.json({ error: 'no billing account yet' }, 400);
    const requestId = requestIdForStripe(c);
    if ('error' in requestId) return c.json({ error: requestId.error }, 400);
    try {
      const portalConfig = (await resolveSecret(c.env, 'STRIPE_PORTAL_CONFIGURATION')).value?.trim();
      const session = await createBillingPortalSession(c.env, {
        customerId: user.stripeCustomerId,
        returnUrl: `${await baseUrl(c)}/?billing=portal`,
        idempotencyKey: stripeOperationKey('portal', user.id, requestId.id),
        configuration: portalConfig || undefined,
      });
      return c.json({ url: session.url });
    } catch (err) {
      console.error('portal failed:', (err as Error).message);
      return c.json({ error: 'could not open billing portal' }, 502);
    }
  });

  // --- POST /billing/webhook ----------------------------------------------
  // Stripe event sink. Verifies the signature against STRIPE_WEBHOOK_SECRET,
  // then reconciles subscription state. Must read the RAW body for the HMAC.
  r.post('/webhook', async (c) => {
    const secret = (await resolveSecret(c.env, 'STRIPE_WEBHOOK_SECRET')).value;
    if (!secret) return c.json({ error: 'webhook not configured' }, 503);
    const payload = await c.req.text();
    const sig = c.req.header('stripe-signature');
    const valid = await verifyStripeSignature(payload, sig, secret);
    if (!valid) return c.json({ error: 'invalid signature' }, 400);

    let event: { id?: string; type?: string; created?: number; livemode?: unknown; data?: { object?: unknown } };
    try {
      event = JSON.parse(payload) as { id?: string; type?: string; created?: number; livemode?: unknown; data?: { object?: unknown } };
    } catch {
      return c.json({ error: 'invalid JSON' }, 400);
    }
    const stripeKey = (await resolveSecret(c.env, 'STRIPE_SECRET_KEY')).value;
    if (!stripeEventLivemodeMatchesKey(event.livemode, stripeKey)) {
      return c.json({ error: 'livemode does not match Stripe key' }, 400);
    }
    if (
      !event.id
      || !event.type
      || typeof event.created !== 'number'
      || !Number.isInteger(event.created)
      || event.created < 0
    ) {
      return c.json({ error: 'invalid Stripe event' }, 400);
    }

    let claimToken: string | null = null;
    try {
      const claim = await claimStripeWebhookEvent(c.env, event.id, event.type);
      if (claim.status === 'duplicate') return c.json({ received: true, duplicate: true });
      if (claim.status === 'busy') {
        return c.json({ error: 'webhook event is already being processed' }, 503, { 'Retry-After': '5' });
      }
      claimToken = claim.claimToken;

      const obj = event.data?.object as Record<string, unknown> | undefined;
      switch (event.type) {
        case 'checkout.session.completed': {
          // Link the customer to the user; subscription.* events carry the detail.
          const userId = obj?.client_reference_id;
          const customerId = stripeObjectId(obj?.customer);
          if (typeof userId !== 'string' || userId.length === 0 || !customerId) {
            throw new Error('malformed checkout.session.completed payload');
          }
          await linkCustomerToUser(c.env, userId, customerId);
          break;
        }
        case 'invoice.paid':
        case 'invoice.payment_succeeded': {
          // Trial converting to paid arrives as invoice.paid with
          // billing_reason=subscription_cycle.  The matching
          // customer.subscription.updated can miss the user row (batch
          // EXISTS) or never be subscribed.  Retrieve the live Subscription
          // and apply it so status cannot stay trialing after Stripe charged.
          const invoice = (obj ?? {}) as Record<string, unknown>;
          const subscriptionId = subscriptionIdFromInvoice(invoice);
          if (!subscriptionId) break;
          const live = await retrieveStripeSubscription(c.env, subscriptionId);
          await applyRetrievedStripeSubscription(c.env, live, {
            id: event.id,
            created: event.created,
            type: 'customer.subscription.updated',
          });
          break;
        }
        case 'customer.subscription.created':
        case 'customer.subscription.updated': {
          let sub = parseSubscription(obj ?? {});
          if (!sub || !sub.priceId) {
            const subscriptionId = sub?.id ?? stripeObjectId((obj ?? {}).id);
            if (subscriptionId) {
              try {
                const live = await retrieveStripeSubscription(c.env, subscriptionId);
                const parsedLive = parseSubscription(live);
                if (parsedLive) sub = parsedLive;
              } catch (err) {
                console.warn('stripe subscription retrieve failed:', (err as Error).message);
              }
            }
          }
          if (!sub) throw new Error(`malformed ${event.type} payload`);
          const affectedUserId = await applySubscription(c.env, sub, {
            id: event.id,
            created: event.created,
            type: event.type,
          });
          // Notify only on the event type Stripe fires exactly once per
          // subscription's lifetime.  Renewals, a trial converting to paid,
          // and any other change to this SAME subscription id arrive as
          // customer.subscription.updated and are deliberately not checked
          // here — this is what keeps "genuine new activation" from
          // double-firing.  Re-confirm the persisted row (rather than
          // trusting applySubscription's return, which can be non-null even
          // when its guarded UPDATE lost an out-of-order-webhook race) before
          // notifying: the ledger claim below is the actual idempotency
          // guard, but this keeps the notified state truthful.
          // `created` is NOT sufficient on its own. Stripe opens a card-confirmation
          // subscription as `incomplete`, which is not a PREMIUM_STATUS, so the created
          // event correctly declines to notify — and the payment confirmation then
          // arrives as `customer.subscription.updated`. Excluding `updated` entirely
          // meant every such customer became Premium with no alert ever produced.
          // Admitting it is safe because the idempotency guard is the ledger claim on
          // `activationKey: sub.id`, not this event-type filter: renewals, trial
          // conversions and any later change to the SAME subscription id all present
          // the same key and are refused by the claim.
          if (
            (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated')
            && affectedUserId
          ) {
            const activatedUser = await getUserById(c.env, affectedUserId);
            // Require a RECOGNISED plan rather than defaulting null to 'monthly'. When a
            // subscription's price is not configured, applySubscription persists
            // plan = null and the entitlement resolver does not grant Premium — so
            // defaulting would announce a "monthly Premium" activation for a user who
            // is not Premium, and whom the totals query in the alert excludes.
            const plan = activatedUser?.plan;
            if (
              activatedUser?.stripeSubscriptionId === sub.id
              && activatedUser.subscriptionStatus != null
              && PREMIUM_STATUSES.has(activatedUser.subscriptionStatus)
              && (plan === 'monthly' || plan === 'annual')
            ) {
              await notifyPremiumActivation(c.env, {
                activationKey: sub.id,
                userId: activatedUser.id,
                userEmail: activatedUser.email,
                source: 'stripe',
                plan,
                trialing: activatedUser.subscriptionStatus === 'trialing',
              });
            }
          }
          break;
        }
        case 'charge.refunded':
        case 'charge.dispute.created': {
          const customerId = stripeObjectId(obj?.customer);
          if (!customerId) break;
          const user = await getUserByStripeCustomerId(c.env, customerId);
          const subscriptionId = user?.stripeSubscriptionId ?? null;
          if (!user || !subscriptionId) break;
          await endSubscription(c.env, customerId, subscriptionId, {
            id: event.id,
            created: event.created,
            type: event.type,
          }, user.id);
          break;
        }
        case 'customer.subscription.deleted': {
          const subscriptionId = stripeObjectId(obj?.id);
          const customerId = stripeObjectId(obj?.customer);
          const metadata = obj?.metadata;
          const metadataUserId = metadata && typeof metadata === 'object'
            && typeof (metadata as Record<string, unknown>).userId === 'string'
            ? (metadata as Record<string, unknown>).userId as string
            : null;
          if (!customerId || !subscriptionId) {
            throw new Error('malformed customer.subscription.deleted payload');
          }
          await endSubscription(c.env, customerId, subscriptionId, {
            id: event.id,
            created: event.created,
            type: event.type,
          }, metadataUserId);
          break;
        }
        default:
          break; // ignore unrelated events
      }
      if (!(await markStripeWebhookEventProcessed(c.env, event.id, claimToken))) {
        throw new Error('webhook claim was lost before completion');
      }
    } catch (err) {
      if (claimToken) {
        try {
          await releaseStripeWebhookEvent(c.env, event.id, claimToken);
        } catch (releaseErr) {
          console.error('webhook idempotency release failed:', (releaseErr as Error).message);
        }
      }
      console.error('webhook handling error:', (err as Error).message);
      return c.json({ error: 'webhook handling failed' }, 500);
    }
    return c.json({ received: true });
  });

  return r;
}
