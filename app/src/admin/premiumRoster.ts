/**
 * src/admin/premiumRoster.ts
 *
 * Admin Premium Members roster: local Stripe columns UNION the Apple
 * ledger, overlaid with a live Stripe retrieve so trial-vs-paid and
 * Sandbox-vs-Production are visible.  Also heals a stale local
 * `trialing` row when Stripe already shows `active`.
 */

import type { Env } from '../shared/types.ts';
import { all } from '../shared/db.ts';
import { resolveSecret } from '../secrets/infisical.ts';
import { isAppleSandboxEnvironment } from '../billing/apple.ts';
import {
  applyRetrievedStripeSubscription,
} from '../billing/subscription.ts';
import {
  listStripeSubscriptions,
  retrieveStripeSubscription,
  stripeEnvironmentFromKey,
  stripeEnvironmentFromLivemode,
  stripeObjectId,
  type StripeSubscriptionObject,
} from '../billing/stripe.ts';

export type PremiumPlanLabel = 'Monthly' | 'Annual' | '—';
export type PremiumBillingLabel = 'Trial' | 'Paid' | 'Past Due' | 'Grace Period' | 'Ended';
export type PremiumSourceLabel = 'Stripe' | 'Apple';
export type PremiumEnvironmentLabel = 'Production' | 'Sandbox';
export type PremiumStripeMatchLabel =
  | 'Matches Stripe'
  | 'Stripe Shows Paid'
  | 'Stripe Shows Trial'
  | 'Could Not Reach Stripe'
  | 'Stripe Has No Record'
  | 'No Local Account'
  | 'Not A Stripe Member';

export interface PremiumRosterMember {
  userId: string | null;
  email: string;
  name: string | null;
  plan: PremiumPlanLabel;
  billing: PremiumBillingLabel;
  source: PremiumSourceLabel;
  environment: PremiumEnvironmentLabel;
  periodEnd: string | null;
  lastLoginAt: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  appleOriginalTransactionId: string | null;
  stripeMatch: PremiumStripeMatchLabel;
  healed: boolean;
}

export interface PremiumRosterSummary {
  total: number;
  trial: number;
  paid: number;
  stripe: number;
  apple: number;
  sandbox: number;
  production: number;
}

export interface PremiumRosterResponse {
  generatedAt: string;
  summary: PremiumRosterSummary;
  members: PremiumRosterMember[];
  stripeReconcile: { ok: boolean; error: string | null; fetched: number };
}

interface StripeUserRow {
  id: string;
  email: string;
  name: string | null;
  plan: string | null;
  subscription_status: string | null;
  current_period_end: string | null;
  last_login_at: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
}

interface AppleLedgerRow {
  original_transaction_id: string;
  user_id: string | null;
  plan: string;
  status: string;
  environment: string | null;
  expires_date: string | null;
  email: string | null;
  name: string | null;
  last_login_at: string | null;
}

function planLabel(plan: string | null | undefined): PremiumPlanLabel {
  if (plan === 'annual') return 'Annual';
  if (plan === 'monthly') return 'Monthly';
  return '—';
}

function stripeBilling(status: string | null | undefined): PremiumBillingLabel {
  if (status === 'trialing') return 'Trial';
  if (status === 'active') return 'Paid';
  if (status === 'past_due') return 'Past Due';
  return 'Ended';
}

function appleBilling(status: string): PremiumBillingLabel {
  if (status === 'grace_period' || status === 'billing_retry') return 'Grace Period';
  if (status === 'active') return 'Paid';
  return 'Ended';
}

function appleEnvironment(value: string | null | undefined): PremiumEnvironmentLabel {
  return isAppleSandboxEnvironment(value) ? 'Sandbox' : 'Production';
}

function summarize(members: PremiumRosterMember[]): PremiumRosterSummary {
  const summary: PremiumRosterSummary = {
    total: members.length,
    trial: 0,
    paid: 0,
    stripe: 0,
    apple: 0,
    sandbox: 0,
    production: 0,
  };
  for (const member of members) {
    if (member.billing === 'Trial') summary.trial += 1;
    if (member.billing === 'Paid') summary.paid += 1;
    if (member.source === 'Stripe') summary.stripe += 1;
    if (member.source === 'Apple') summary.apple += 1;
    if (member.environment === 'Sandbox') summary.sandbox += 1;
    if (member.environment === 'Production') summary.production += 1;
  }
  return summary;
}

async function optionalAll<T>(env: Env, sql: string, params: Array<string | number> = []): Promise<T[]> {
  try {
    return await all<T>(env.DB, sql, params);
  } catch (err) {
    const msg = (err as Error).message;
    if (/no such table|no such column/i.test(msg)) return [];
    throw err;
  }
}

export async function loadLocalStripePremiumRows(env: Env): Promise<StripeUserRow[]> {
  return optionalAll<StripeUserRow>(
    env,
    `SELECT id, email, name, plan, subscription_status, current_period_end,
            last_login_at, stripe_customer_id, stripe_subscription_id
       FROM users
      WHERE subscription_status IN ('trialing', 'active', 'past_due')
      ORDER BY email COLLATE NOCASE`,
  );
}

export async function loadLocalApplePremiumRows(env: Env): Promise<AppleLedgerRow[]> {
  const nowIso = new Date().toISOString();
  return optionalAll<AppleLedgerRow>(
    env,
    `SELECT a.original_transaction_id, a.user_id, a.plan, a.status, a.environment,
            a.expires_date, u.email, u.name, u.last_login_at
       FROM apple_subscriptions a
       LEFT JOIN users u ON u.id = a.user_id
      WHERE a.status IN ('active', 'grace_period', 'billing_retry')
        AND (a.expires_date IS NULL OR a.expires_date > ?)
      ORDER BY COALESCE(u.email, a.original_transaction_id) COLLATE NOCASE`,
    [nowIso],
  );
}

function customerEmail(customer: StripeSubscriptionObject['customer']): string | null {
  if (!customer || typeof customer === 'string') return null;
  return customer.email ?? null;
}

function customerName(customer: StripeSubscriptionObject['customer']): string | null {
  if (!customer || typeof customer === 'string') return null;
  return customer.name ?? null;
}

function customerIdOf(sub: StripeSubscriptionObject): string | null {
  return stripeObjectId(sub.customer) ?? null;
}

function stripeMatchLabel(
  localStatus: string | null | undefined,
  liveStatus: string | null | undefined,
  reached: boolean,
): PremiumStripeMatchLabel {
  if (!reached) return 'Could Not Reach Stripe';
  if (!liveStatus) return 'Stripe Has No Record';
  if (localStatus === liveStatus) return 'Matches Stripe';
  if (liveStatus === 'active') return 'Stripe Shows Paid';
  if (liveStatus === 'trialing') return 'Stripe Shows Trial';
  return 'Stripe Shows Paid';
}

async function liveBySubscriptionId(
  env: Env,
  listed: Map<string, StripeSubscriptionObject>,
  subscriptionId: string,
): Promise<StripeSubscriptionObject | null> {
  const cached = listed.get(subscriptionId);
  if (cached) return cached;
  try {
    const live = await retrieveStripeSubscription(env, subscriptionId);
    listed.set(subscriptionId, live);
    return live;
  } catch {
    return null;
  }
}

function defaultStripeEnvironment(secretKey: string | undefined): PremiumEnvironmentLabel {
  return stripeEnvironmentFromKey(secretKey);
}

export async function buildPremiumRoster(env: Env): Promise<PremiumRosterResponse> {
  const generatedAt = new Date().toISOString();
  const stripeKey = (await resolveSecret(env, 'STRIPE_SECRET_KEY')).value;
  const fallbackEnv = defaultStripeEnvironment(stripeKey);

  const [stripeRows, appleRows] = await Promise.all([
    loadLocalStripePremiumRows(env),
    loadLocalApplePremiumRows(env),
  ]);

  let stripeReconcile: PremiumRosterResponse['stripeReconcile'] = {
    ok: false,
    error: null,
    fetched: 0,
  };
  const listed = new Map<string, StripeSubscriptionObject>();
  if (stripeKey) {
    try {
      const page = await listStripeSubscriptions(env, { status: 'all', limit: 100 });
      for (const sub of page.data ?? []) {
        if (sub.id) listed.set(sub.id, sub);
      }
      stripeReconcile = { ok: true, error: null, fetched: listed.size };
    } catch (err) {
      stripeReconcile = { ok: false, error: 'Could not reach Stripe.', fetched: 0 };
      console.warn('premium roster stripe list failed:', (err as Error).message);
    }
  } else {
    stripeReconcile = { ok: false, error: 'Stripe is not configured.', fetched: 0 };
  }

  const members: PremiumRosterMember[] = [];
  const seenStripeIds = new Set<string>();

  for (const row of stripeRows) {
    const subId = row.stripe_subscription_id;
    if (subId) seenStripeIds.add(subId);
    let live: StripeSubscriptionObject | null = null;
    let reached = stripeReconcile.ok;
    if (subId && stripeKey) {
      live = listed.get(subId) ?? null;
      if (!live && stripeReconcile.ok) {
        live = await liveBySubscriptionId(env, listed, subId);
        reached = live != null || stripeReconcile.ok;
      } else if (!stripeReconcile.ok && subId) {
        live = await liveBySubscriptionId(env, listed, subId);
        reached = live != null;
      }
    }
    let healed = false;
    let billingStatus = row.subscription_status;
    let plan = row.plan;
    let periodEnd = row.current_period_end;
    if (
      live
      && subId
      && billingStatus === 'trialing'
      && live.status === 'active'
    ) {
      const userId = await applyRetrievedStripeSubscription(env, live, {
        id: `roster_heal_${subId}`,
        created: Math.floor(Date.now() / 1000),
        type: 'customer.subscription.updated',
      });
      if (userId) {
        healed = true;
        billingStatus = 'active';
        periodEnd = live.items?.data?.[0]?.current_period_end
          ? new Date((live.items.data[0].current_period_end as number) * 1000).toISOString()
          : periodEnd;
      }
    }
    const liveStatus = live?.status ?? null;
    const environment = stripeEnvironmentFromLivemode(live?.livemode) ?? fallbackEnv;
    members.push({
      userId: row.id,
      email: row.email,
      name: row.name,
      plan: planLabel(plan),
      billing: stripeBilling(billingStatus),
      source: 'Stripe',
      environment,
      periodEnd,
      lastLoginAt: row.last_login_at,
      stripeCustomerId: row.stripe_customer_id,
      stripeSubscriptionId: subId,
      appleOriginalTransactionId: null,
      stripeMatch: stripeMatchLabel(
        billingStatus,
        liveStatus,
        Boolean(liveStatus) || stripeReconcile.ok || reached,
      ),
      healed,
    });
  }

  for (const row of appleRows) {
    members.push({
      userId: row.user_id,
      email: row.email?.trim() || 'Not Linked To An Account',
      name: row.name,
      plan: planLabel(row.plan),
      billing: appleBilling(row.status),
      source: 'Apple',
      environment: appleEnvironment(row.environment),
      periodEnd: row.expires_date,
      lastLoginAt: row.last_login_at,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      appleOriginalTransactionId: row.original_transaction_id,
      stripeMatch: 'Not A Stripe Member',
      healed: false,
    });
  }

  if (stripeReconcile.ok) {
    for (const [id, live] of listed) {
      if (seenStripeIds.has(id)) continue;
      const status = live.status ?? '';
      if (status !== 'trialing' && status !== 'active' && status !== 'past_due') continue;
      const customerId = customerIdOf(live);
      members.push({
        userId: live.metadata?.userId ?? null,
        email: customerEmail(live.customer) || 'Stripe Customer (No Local Account)',
        name: customerName(live.customer),
        plan: planLabel(null),
        billing: stripeBilling(status),
        source: 'Stripe',
        environment: stripeEnvironmentFromLivemode(live.livemode) ?? fallbackEnv,
        periodEnd: live.items?.data?.[0]?.current_period_end
          ? new Date((live.items.data[0].current_period_end as number) * 1000).toISOString()
          : null,
        lastLoginAt: null,
        stripeCustomerId: customerId,
        stripeSubscriptionId: id,
        appleOriginalTransactionId: null,
        stripeMatch: 'No Local Account',
        healed: false,
      });
    }
  }

  members.sort((a, b) => a.email.localeCompare(b.email, undefined, { sensitivity: 'base' }));
  return {
    generatedAt,
    summary: summarize(members),
    members,
    stripeReconcile,
  };
}

/** Local-only counts for the Admin diagnostics cards (no Stripe HTTP). */
export async function localPremiumCounts(env: Env): Promise<{
  premiumUsers: number;
  trialUsers: number;
  paidUsers: number;
  stripeUsers: number;
  appleUsers: number;
}> {
  const [stripeRows, appleRows] = await Promise.all([
    loadLocalStripePremiumRows(env),
    loadLocalApplePremiumRows(env),
  ]);
  const ids = new Set<string>();
  let trial = 0;
  let paid = 0;
  for (const row of stripeRows) {
    ids.add(row.id);
    if (row.subscription_status === 'trialing') trial += 1;
    else if (row.subscription_status === 'active') paid += 1;
  }
  for (const row of appleRows) {
    if (row.user_id) ids.add(row.user_id);
    else ids.add(`apple:${row.original_transaction_id}`);
    if (row.status === 'active') paid += 1;
  }
  return {
    premiumUsers: ids.size,
    trialUsers: trial,
    paidUsers: paid,
    stripeUsers: stripeRows.length,
    appleUsers: appleRows.length,
  };
}
