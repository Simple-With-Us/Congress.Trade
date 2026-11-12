/**
 * src/billing/subscription.ts
 * Persistence for Stripe billing state on the `users` table, plus a parser that
 * normalizes a raw Stripe Subscription object into the fields we store. Kept
 * separate from the HTTP layer (routes.ts) and the API client (stripe.ts) so the
 * mapping is unit-testable against an in-memory DB.
 */

import type { BillingPlan, Env, User } from '../shared/types.ts';
import { batch, get, run } from '../shared/db.ts';
import { getUserById } from '../auth/users.ts';
import { resolveSecrets } from '../secrets/infisical.ts';
import { stripeObjectId, type StripeSubscriptionObject } from './stripe.ts';

/** Map a Stripe Price id to our plan cadence, or null if it isn't ours. */
export function planForPrice(env: Env, priceId: string | null | undefined): BillingPlan | null {
  if (!priceId) return null;
  if (priceId === env.STRIPE_PRICE_MONTHLY) return 'monthly';
  if (priceId === env.STRIPE_PRICE_ANNUAL) return 'annual';
  return null;
}

export async function planForPriceAsync(env: Env, priceId: string | null | undefined): Promise<BillingPlan | null> {
  if (!priceId) return null;
  const prices = await resolveSecrets(env, ['STRIPE_PRICE_MONTHLY', 'STRIPE_PRICE_ANNUAL']);
  if (priceId === prices.STRIPE_PRICE_MONTHLY) return 'monthly';
  if (priceId === prices.STRIPE_PRICE_ANNUAL) return 'annual';
  return null;
}

/** The subset of a Stripe Subscription object we persist. */
export interface ParsedSubscription {
  id: string;
  customerId: string;
  status: string;
  priceId: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  trialEnd: string | null;
  /** `subscription_data.metadata.userId` set at checkout, if present. */
  metadataUserId: string | null;
}

export interface StripeSubscriptionEventOrder {
  id: string;
  created: number;
  type:
    | 'customer.subscription.created'
    | 'customer.subscription.updated'
    | 'customer.subscription.deleted'
    | 'charge.refunded'
    | 'charge.dispute.created';
}

interface RawStripeSubscription {
  id?: string;
  status?: string;
  customer?: string | { id?: string };
  current_period_end?: number | null;
  cancel_at_period_end?: boolean;
  trial_end?: number | null;
  items?: { data?: Array<{ price?: string | { id?: string }; current_period_end?: number | null }> };
  metadata?: { userId?: string };
}

function isoFromUnix(sec: number | null | undefined): string | null {
  return typeof sec === 'number' && Number.isFinite(sec) ? new Date(sec * 1000).toISOString() : null;
}

function priceIdFromItem(price: string | { id?: string } | undefined): string | null {
  if (typeof price === 'string' && price.length > 0) return price;
  if (price && typeof price === 'object' && typeof price.id === 'string' && price.id.length > 0) {
    return price.id;
  }
  return null;
}

/** Normalize a raw Stripe Subscription (from a webhook event) into our shape. */
export function parseSubscription(raw: RawStripeSubscription): ParsedSubscription | null {
  const id = raw.id;
  const customerId = typeof raw.customer === 'string' ? raw.customer : raw.customer?.id;
  if (!id || !customerId || !raw.status) return null;
  const item = raw.items?.data?.[0];
  return {
    id,
    customerId,
    status: raw.status,
    priceId: priceIdFromItem(item?.price),
    // API >=2025-03-31.basil moved current_period_end onto the subscription item.
    currentPeriodEnd: isoFromUnix(item?.current_period_end ?? raw.current_period_end),
    cancelAtPeriodEnd: !!raw.cancel_at_period_end,
    trialEnd: isoFromUnix(raw.trial_end),
    metadataUserId: raw.metadata?.userId ?? null,
  };
}

/**
 * Invoice.subscription moved under parent.subscription_details in API
 * 2025-03-31.basil.  Read both so trial-to-paid `invoice.paid` still
 * resolves the Subscription id.
 */
export function subscriptionIdFromInvoice(raw: Record<string, unknown>): string | null {
  const direct = stripeObjectId(raw.subscription);
  if (direct) return direct;
  const parent = raw.parent;
  if (!parent || typeof parent !== 'object') return null;
  const details = (parent as Record<string, unknown>).subscription_details;
  if (!details || typeof details !== 'object') return null;
  return stripeObjectId((details as Record<string, unknown>).subscription) ?? null;
}

interface AppliedEventStateRow {
  last_event_id: string;
}

interface UserIdRow {
  id: string;
}

/** Look up a user by their Stripe customer id (webhook resolution). */
export async function getUserByStripeCustomerId(env: Env, customerId: string): Promise<User | null> {
  const row = await get<UserIdRow>(env.DB, 'SELECT id FROM users WHERE stripe_customer_id = ?', [
    customerId,
  ]);
  return row ? getUserById(env, row.id) : null;
}

/** Persist a customer<->user link without replacing an existing customer. */
export async function linkCustomerToUser(
  env: Env,
  userId: string,
  customerId: string,
): Promise<boolean> {
  const result = await run(
    env.DB,
    `UPDATE users
        SET stripe_customer_id = ?
      WHERE id = ?
        AND (stripe_customer_id IS NULL OR stripe_customer_id = ?)`,
    [customerId, userId, customerId],
  );
  return (result.meta?.changes ?? 0) > 0;
}

function eventPriority(type: StripeSubscriptionEventOrder['type']): number {
  if (
    type === 'customer.subscription.deleted'
    || type === 'charge.refunded'
    || type === 'charge.dispute.created'
  ) return 3;
  if (type === 'customer.subscription.updated') return 2;
  return 1;
}

const RECORD_EVENT_SQL = `INSERT INTO stripe_subscription_event_state (
    subscription_id, customer_id, last_event_created, last_event_priority,
    last_event_id, last_event_type, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(subscription_id) DO UPDATE SET
    customer_id = excluded.customer_id,
    last_event_created = excluded.last_event_created,
    last_event_priority = excluded.last_event_priority,
    last_event_id = excluded.last_event_id,
    last_event_type = excluded.last_event_type,
    updated_at = excluded.updated_at
  WHERE excluded.last_event_created > stripe_subscription_event_state.last_event_created
     OR (
       excluded.last_event_created = stripe_subscription_event_state.last_event_created
       AND excluded.last_event_priority > stripe_subscription_event_state.last_event_priority
     )
     OR (
       excluded.last_event_created = stripe_subscription_event_state.last_event_created
       AND excluded.last_event_priority = stripe_subscription_event_state.last_event_priority
       -- Stripe event ids are opaque, not chronological. This final comparison
       -- only makes same-second/same-type conflicts deterministic; retrieving
       -- the current Subscription from Stripe remains the stronger follow-up.
       AND excluded.last_event_id >= stripe_subscription_event_state.last_event_id
     )`;

function eventParams(
  subscriptionId: string,
  customerId: string,
  event: StripeSubscriptionEventOrder,
  updatedAt: string,
): [string, string, number, number, string, string, string] {
  return [
    subscriptionId,
    customerId,
    event.created,
    eventPriority(event.type),
    event.id,
    event.type,
    updatedAt,
  ];
}

/**
 * Apply a parsed subscription to the owning user. Resolves the user by Stripe
 * customer id, falling back to the `userId` carried in subscription metadata
 * to tolerate out-of-order webhook delivery. The atomic update never replaces
 * a different customer already linked to that user.
 * Returns the affected user id, or null if no user could be resolved.
 */
export async function applySubscription(
  env: Env,
  sub: ParsedSubscription,
  event: StripeSubscriptionEventOrder,
): Promise<string | null> {
  let user = await getUserByStripeCustomerId(env, sub.customerId);
  if (!user && sub.metadataUserId) {
    user = await getUserById(env, sub.metadataUserId);
  }

  const priority = eventPriority(event.type);
  const updatedAt = new Date().toISOString();
  if (!user) {
    await batch(env.DB, [
      [RECORD_EVENT_SQL, eventParams(sub.id, sub.customerId, event, updatedAt)],
    ]);
    return null;
  }
  await batch(env.DB, [
    [RECORD_EVENT_SQL, eventParams(sub.id, sub.customerId, event, updatedAt)],
    [`UPDATE users
        SET stripe_customer_id = ?,
            stripe_subscription_id = ?,
            subscription_status = ?,
            plan = COALESCE(?, plan),
            current_period_end = ?,
            cancel_at_period_end = ?,
            trial_end = ?
      WHERE id = ?
        AND (stripe_customer_id IS NULL OR stripe_customer_id = ?)
        AND EXISTS (
          SELECT 1
            FROM stripe_subscription_event_state applied
           WHERE applied.subscription_id = ?
             AND applied.last_event_created = ?
             AND applied.last_event_priority = ?
             AND applied.last_event_id = ?
        )
        AND (
          stripe_subscription_id IS NULL
          OR stripe_subscription_id = ?
          OR EXISTS (
            SELECT 1
              FROM stripe_subscription_event_state current_state
             WHERE current_state.subscription_id = users.stripe_subscription_id
               AND (
                 current_state.last_event_created < ?
                 OR (
                   current_state.last_event_created = ?
                   -- Event-type priority is only meaningful within one
                   -- subscription. Across subscriptions, same-second ordering
                   -- is ambiguous: only a created active/trialing subscription
                   -- may replace a terminal current subscription. Everything
                   -- else fails closed instead of comparing opaque event ids.
                   AND ? = 'customer.subscription.created'
                   AND ? IN ('active', 'trialing')
                   AND users.subscription_status IN ('canceled', 'incomplete_expired')
                 )
               )
          )
        )`, [
      sub.customerId,
      sub.id,
      sub.status,
      await planForPriceAsync(env, sub.priceId),
      sub.currentPeriodEnd,
      sub.cancelAtPeriodEnd ? 1 : 0,
      sub.trialEnd,
      user.id,
      sub.customerId,
      sub.id,
      event.created,
      priority,
      event.id,
      sub.id,
      event.created,
      event.created,
      event.type,
      sub.status,
    ]],
  ]);
  await healSubscriptionWriteIfEventWon(env, user.id, sub, event);
  return user.id;
}

/**
 * The guarded UPDATE above shares a libsql write-batch with the event-state
 * UPSERT.  If the batch snapshot cannot see that UPSERT, EXISTS misses and a
 * trial-to-paid `customer.subscription.updated` leaves `subscription_status`
 * stuck at `trialing` even though Stripe charged.  After the batch commits,
 * re-read: when this event won ordering, write the user row directly.
 */
async function healSubscriptionWriteIfEventWon(
  env: Env,
  userId: string,
  sub: ParsedSubscription,
  event: StripeSubscriptionEventOrder,
): Promise<void> {
  const applied = await get<AppliedEventStateRow>(
    env.DB,
    'SELECT last_event_id FROM stripe_subscription_event_state WHERE subscription_id = ?',
    [sub.id],
  );
  if (applied?.last_event_id !== event.id) return;
  const current = await getUserById(env, userId);
  if (!current) return;
  const plan = await planForPriceAsync(env, sub.priceId);
  const alreadyApplied =
    current.stripeCustomerId === sub.customerId
    && current.stripeSubscriptionId === sub.id
    && current.subscriptionStatus === sub.status
    && (plan == null || current.plan === plan)
    && current.currentPeriodEnd === sub.currentPeriodEnd
    && current.cancelAtPeriodEnd === sub.cancelAtPeriodEnd
    && current.trialEnd === sub.trialEnd;
  if (alreadyApplied) return;
  await run(
    env.DB,
    `UPDATE users
        SET stripe_customer_id = ?,
            stripe_subscription_id = ?,
            subscription_status = ?,
            plan = COALESCE(?, plan),
            current_period_end = ?,
            cancel_at_period_end = ?,
            trial_end = ?
      WHERE id = ?
        AND (stripe_customer_id IS NULL OR stripe_customer_id = ?)
        AND (stripe_subscription_id IS NULL OR stripe_subscription_id = ?)`,
    [
      sub.customerId,
      sub.id,
      sub.status,
      plan,
      sub.currentPeriodEnd,
      sub.cancelAtPeriodEnd ? 1 : 0,
      sub.trialEnd,
      userId,
      sub.customerId,
      sub.id,
    ],
  );
}

/** Apply a live Stripe Subscription retrieve (Admin reconcile or invoice.paid). */
export async function applyRetrievedStripeSubscription(
  env: Env,
  raw: StripeSubscriptionObject,
  event: StripeSubscriptionEventOrder,
): Promise<string | null> {
  const parsed = parseSubscription(raw);
  if (!parsed) return null;
  return applySubscription(env, parsed, event);
}

/**
 * Mark a subscription as ended (customer.subscription.deleted). Clears the
 * subscription fields but keeps the customer id so a re-subscribe reuses it.
 */
export async function endSubscription(
  env: Env,
  customerId: string,
  subscriptionId: string,
  event: StripeSubscriptionEventOrder,
  metadataUserId: string | null = null,
): Promise<string | null> {
  let user = await getUserByStripeCustomerId(env, customerId);
  if (!user && metadataUserId) user = await getUserById(env, metadataUserId);
  const priority = eventPriority(event.type);
  const recordStatement: [string, ReturnType<typeof eventParams>] = [
    RECORD_EVENT_SQL,
    eventParams(subscriptionId, customerId, event, new Date().toISOString()),
  ];
  if (!user) {
    await batch(env.DB, [recordStatement]);
    return null;
  }
  await batch(env.DB, [
    recordStatement,
    [`UPDATE users
        SET subscription_status = 'canceled',
            cancel_at_period_end = 0,
            trial_end = NULL
      WHERE id = ?
        AND stripe_subscription_id = ?
        AND EXISTS (
          SELECT 1
            FROM stripe_subscription_event_state applied
           WHERE applied.subscription_id = ?
             AND applied.last_event_created = ?
             AND applied.last_event_priority = ?
             AND applied.last_event_id = ?
        )`, [user.id, subscriptionId, subscriptionId, event.created, priority, event.id]],
  ]);
  return user.id;
}
