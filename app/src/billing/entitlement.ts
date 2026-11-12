/**
 * src/billing/entitlement.ts
 * Pure access-level derivation from a User's Stripe billing fields. No I/O, so
 * it's shared freely between the data API (gating), the auth `/me` endpoint, and
 * the billing routes — and is trivially unit-testable.
 *
 * A visitor is "premium" while their Stripe subscription is `trialing` or
 * `active` for one of this app's configured prices. We deliberately do NOT
 * extend premium to `past_due`/`unpaid`: Stripe keeps the subscription in
 * `active` during its smart-retry grace window and only flips to `past_due` once
 * retries are failing, at which point access should lapse until payment
 * succeeds (which returns it to `active`).
 */

import type { Entitlement, Env, User } from '../shared/types.ts';
import { activeAppleSubscriptionForUser } from './appleSubscriptions.ts';

/** Stripe subscription statuses that grant premium access. */
export const PREMIUM_STATUSES: ReadonlySet<string> = new Set(['trialing', 'active']);

/** The free, anonymous entitlement (no user / never subscribed). */
export const ANONYMOUS_ENTITLEMENT: Entitlement = {
  premium: false,
  status: null,
  plan: null,
  trialing: false,
  trialEnd: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
};

/** Derive the access level for a user (or null for anonymous visitors). */
export function entitlementOf(user: User | null | undefined): Entitlement {
  if (!user) return ANONYMOUS_ENTITLEMENT;
  const status = user.subscriptionStatus;
  const hasKnownPlan = user.plan === 'monthly' || user.plan === 'annual';
  return {
    premium: hasKnownPlan && status != null && PREMIUM_STATUSES.has(status),
    status: status ?? null,
    plan: user.plan ?? null,
    trialing: status === 'trialing',
    trialEnd: user.trialEnd ?? null,
    currentPeriodEnd: user.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: !!user.cancelAtPeriodEnd,
  };
}

/** Convenience boolean: may this user access premium features? */
export function isPremiumUser(user: User | null | undefined): boolean {
  return entitlementOf(user).premium;
}

/**
 * Full entitlement resolution: Stripe-derived (pure, sync `entitlementOf`
 * above — untouched) OR'd with the Apple IAP ledger (`apple_subscriptions`,
 * migration 0081). Every live Apple grant path (redeem_apple_purchase,
 * anonymous redeem, legacy POST /billing/apple/confirm, and the App Store
 * Server Notifications webhook) writes that ledger. confirm used to stamp
 * Stripe-shaped users columns instead; it no longer does, because those
 * columns are invisible to REFUND/REVOKE. Never mutates or restructures the
 * Stripe subscription-resolution code path itself — this only adds a second,
 * independent OR term.
 */
export async function resolveEntitlementAsync(env: Env, user: User | null | undefined): Promise<Entitlement> {
  const stripeEntitlement = entitlementOf(user);
  if (stripeEntitlement.premium || !user) {
    return stripeEntitlement.premium ? { ...stripeEntitlement, source: 'stripe' } : stripeEntitlement;
  }
  const apple = await activeAppleSubscriptionForUser(env, user.id);
  if (!apple) return stripeEntitlement;
  return {
    premium: true,
    status: 'active',
    plan: apple.plan,
    trialing: false,
    trialEnd: null,
    currentPeriodEnd: apple.expiresDate,
    cancelAtPeriodEnd: apple.autoRenewStatus === false,
    source: 'apple',
  };
}

/** Async convenience boolean mirroring {@link isPremiumUser}, OR'd with the Apple IAP ledger. */
export async function isPremiumUserAsync(env: Env, user: User | null | undefined): Promise<boolean> {
  return (await resolveEntitlementAsync(env, user)).premium;
}
