import { describe, it, expect } from 'vitest';
import {
  planForPrice,
  parseSubscription,
  subscriptionIdFromInvoice,
  applySubscription,
  endSubscription,
  getUserByStripeCustomerId,
  linkCustomerToUser,
} from '../subscription.ts';
import type { Env } from '../../shared/types.ts';

interface Row {
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
  google_sub: string | null;
  email_verified: number;
  created_at: string;
  last_login_at: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  subscription_status: string | null;
  plan: string | null;
  current_period_end: string | null;
  cancel_at_period_end: number;
  trial_end: string | null;
}

interface SubscriptionEventState {
  customerId: string;
  created: number;
  priority: number;
  eventId: string;
  eventType: string;
}

function event(
  id: string,
  created: number,
  type: 'customer.subscription.created' | 'customer.subscription.updated' | 'customer.subscription.deleted' = 'customer.subscription.updated',
) {
  return { id, created, type } as const;
}

function compareOrder(a: SubscriptionEventState, b: SubscriptionEventState): number {
  return a.created - b.created || a.priority - b.priority || a.eventId.localeCompare(b.eventId);
}

function newRow(id: string, over: Partial<Row> = {}): Row {
  return {
    id,
    email: id + '@x.com',
    name: null,
    picture: null,
    google_sub: null,
    email_verified: 1,
    created_at: 'now',
    last_login_at: null,
    stripe_customer_id: null,
    stripe_subscription_id: null,
    subscription_status: null,
    plan: null,
    current_period_end: null,
    cancel_at_period_end: 0,
    trial_end: null,
    ...over,
  };
}

/** In-memory `users` table supporting exactly the queries the module issues. */
function fakeEnv(seed: Row[] = []) {
  const rows = new Map<string, Row>(seed.map((r) => [r.id, r]));
  const eventStates = new Map<string, SubscriptionEventState>();
  const env = {
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
          if (/FROM stripe_subscription_event_state WHERE subscription_id/i.test(sql)) {
            const state = eventStates.get(this._p[0] as string);
            return (state ? { last_event_id: state.eventId } : null) as T | null;
          }
          return null as T | null;
        },
        async run() {
          const p = this._p;
          if (/INSERT INTO stripe_subscription_event_state/i.test(sql)) {
            const [subscriptionId, customerId, created, priority, eventId, eventType] = p as [
              string, string, number, number, string, string,
            ];
            const incoming = { customerId, created, priority, eventId, eventType };
            const current = eventStates.get(subscriptionId);
            if (!current || compareOrder(incoming, current) >= 0) {
              eventStates.set(subscriptionId, incoming);
              return { success: true, meta: { changes: 1 } } as unknown;
            }
            return { success: true, meta: { changes: 0 } } as unknown;
          }
          if (/UPDATE users\s+SET stripe_customer_id = \?\s+WHERE id = \?/i.test(sql)) {
            const [customerId, userId] = p as [string, string, string];
            const r = rows.get(userId);
            const changes = r && (r.stripe_customer_id === null || r.stripe_customer_id === customerId) ? 1 : 0;
            if (r && changes) r.stripe_customer_id = customerId;
            return { success: true, meta: { changes } } as unknown;
          } else if (/UPDATE\s+users\s+SET\s+stripe_customer_id = \?,\s+stripe_subscription_id/i.test(sql)) {
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
              const applied = eventStates.get(stateSub);
              const current = r?.stripe_subscription_id ? eventStates.get(r.stripe_subscription_id) : undefined;
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
              ) {
                r.stripe_customer_id = cust;
                r.stripe_subscription_id = sub;
                r.subscription_status = status;
                r.plan = plan ?? r.plan;
                r.current_period_end = cpe;
                r.cancel_at_period_end = cape;
                r.trial_end = trial;
              }
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
                r.stripe_customer_id = cust;
                r.stripe_subscription_id = sub;
                r.subscription_status = status;
                r.plan = plan ?? r.plan;
                r.current_period_end = cpe;
                r.cancel_at_period_end = cape;
                r.trial_end = trial;
              }
            }
          } else if (/subscription_status = 'canceled'/i.test(sql)) {
            const [id, subscriptionId, stateSub, created, priority, eventId] = p as [
              string, string, string, number, number, string,
            ];
            const r = rows.get(id);
            const applied = eventStates.get(stateSub);
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
          }
          return { success: true } as unknown;
        },
        async all<T>() {
          return { results: [] as T[] };
        },
      }),
    },
  } as unknown as Env;
  return { env, rows, eventStates };
}

describe('planForPrice', () => {
  it('maps configured price ids to cadences, else null', () => {
    const { env } = fakeEnv();
    expect(planForPrice(env, 'price_m')).toBe('monthly');
    expect(planForPrice(env, 'price_a')).toBe('annual');
    expect(planForPrice(env, 'price_other')).toBeNull();
    expect(planForPrice(env, null)).toBeNull();
  });
});

describe('parseSubscription', () => {
  it('normalizes a raw Stripe subscription (unix -> ISO, nested price + customer)', () => {
    const parsed = parseSubscription({
      id: 'sub_1',
      status: 'trialing',
      customer: 'cus_1',
      current_period_end: 1_700_000_000,
      cancel_at_period_end: true,
      trial_end: 1_699_000_000,
      items: { data: [{ price: { id: 'price_a' } }] },
      metadata: { userId: 'u1' },
    });
    expect(parsed).toMatchObject({
      id: 'sub_1',
      customerId: 'cus_1',
      status: 'trialing',
      priceId: 'price_a',
      cancelAtPeriodEnd: true,
      metadataUserId: 'u1',
    });
    expect(parsed!.currentPeriodEnd).toBe(new Date(1_700_000_000 * 1000).toISOString());
    expect(parsed!.trialEnd).toBe(new Date(1_699_000_000 * 1000).toISOString());
  });

  it('accepts an expanded customer object and returns null when essentials are missing', () => {
    expect(parseSubscription({ id: 's', status: 'active', customer: { id: 'cus_2' } })?.customerId).toBe('cus_2');
    expect(parseSubscription({ status: 'active', customer: 'cus' })).toBeNull();
    expect(parseSubscription({ id: 's', customer: 'cus' })).toBeNull();
  });

  it('accepts a basil price id string on the subscription item', () => {
    expect(parseSubscription({
      id: 'sub_1',
      status: 'active',
      customer: 'cus_1',
      items: { data: [{ price: 'price_m', current_period_end: 1_800_000_000 }] },
    })).toMatchObject({
      id: 'sub_1',
      status: 'active',
      priceId: 'price_m',
    });
  });
});

describe('subscriptionIdFromInvoice', () => {
  it('reads classic invoice.subscription and basil parent.subscription_details', () => {
    expect(subscriptionIdFromInvoice({ subscription: 'sub_classic' })).toBe('sub_classic');
    expect(subscriptionIdFromInvoice({
      parent: { subscription_details: { subscription: 'sub_basil' } },
    })).toBe('sub_basil');
    expect(subscriptionIdFromInvoice({
      parent: { subscription_details: { subscription: { id: 'sub_obj' } } },
    })).toBe('sub_obj');
    expect(subscriptionIdFromInvoice({})).toBeNull();
  });
});

describe('linkCustomerToUser', () => {
  it('sets an empty link but never replaces a different customer', async () => {
    const { env, rows } = fakeEnv([
      newRow('empty'),
      newRow('linked', { stripe_customer_id: 'cus_current' }),
    ]);
    expect(await linkCustomerToUser(env, 'empty', 'cus_new')).toBe(true);
    expect(await linkCustomerToUser(env, 'linked', 'cus_stale')).toBe(false);
    expect(rows.get('empty')?.stripe_customer_id).toBe('cus_new');
    expect(rows.get('linked')?.stripe_customer_id).toBe('cus_current');
  });
});

describe('applySubscription', () => {
  it('updates the user resolved by stripe customer id', async () => {
    const { env, rows } = fakeEnv([newRow('u1', { stripe_customer_id: 'cus_1' })]);
    const id = await applySubscription(env, {
      id: 'sub_1',
      customerId: 'cus_1',
      status: 'active',
      priceId: 'price_m',
      currentPeriodEnd: '2030-01-01T00:00:00.000Z',
      cancelAtPeriodEnd: false,
      trialEnd: null,
      metadataUserId: null,
    }, event('evt_active', 200));
    expect(id).toBe('u1');
    const r = rows.get('u1')!;
    expect(r.subscription_status).toBe('active');
    expect(r.plan).toBe('monthly');
    expect(r.stripe_subscription_id).toBe('sub_1');
  });

  it('flips trialing to active on a later updated event for the same subscription', async () => {
    const { env, rows } = fakeEnv([newRow('u1', { stripe_customer_id: 'cus_1' })]);
    await applySubscription(env, {
      id: 'sub_1',
      customerId: 'cus_1',
      status: 'trialing',
      priceId: 'price_m',
      currentPeriodEnd: '2030-01-01T00:00:00.000Z',
      cancelAtPeriodEnd: false,
      trialEnd: '2030-01-15T00:00:00.000Z',
      metadataUserId: null,
    }, event('evt_trial', 100, 'customer.subscription.created'));
    expect(rows.get('u1')!.subscription_status).toBe('trialing');

    await applySubscription(env, {
      id: 'sub_1',
      customerId: 'cus_1',
      status: 'active',
      priceId: 'price_m',
      currentPeriodEnd: '2030-02-01T00:00:00.000Z',
      cancelAtPeriodEnd: false,
      trialEnd: '2030-01-15T00:00:00.000Z',
      metadataUserId: null,
    }, event('evt_paid', 200, 'customer.subscription.updated'));
    expect(rows.get('u1')!.subscription_status).toBe('active');
    expect(rows.get('u1')!.plan).toBe('monthly');
  });

  it('keeps the existing plan when an updated event omits the price id', async () => {
    const { env, rows } = fakeEnv([newRow('u1', {
      stripe_customer_id: 'cus_1',
      stripe_subscription_id: 'sub_1',
      subscription_status: 'trialing',
      plan: 'monthly',
    })]);
    await applySubscription(env, {
      id: 'sub_1',
      customerId: 'cus_1',
      status: 'active',
      priceId: null,
      currentPeriodEnd: '2030-02-01T00:00:00.000Z',
      cancelAtPeriodEnd: false,
      trialEnd: null,
      metadataUserId: null,
    }, event('evt_paid_no_price', 300, 'customer.subscription.updated'));
    expect(rows.get('u1')).toMatchObject({
      subscription_status: 'active',
      plan: 'monthly',
    });
  });

  it('falls back to metadata userId and links the customer when no row matches', async () => {
    const { env, rows } = fakeEnv([newRow('u1')]); // no customer linked yet
    const id = await applySubscription(env, {
      id: 'sub_9',
      customerId: 'cus_new',
      status: 'trialing',
      priceId: 'price_a',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      trialEnd: '2030-02-01T00:00:00.000Z',
      metadataUserId: 'u1',
    }, event('evt_trial', 200, 'customer.subscription.created'));
    expect(id).toBe('u1');
    const r = rows.get('u1')!;
    expect(r.stripe_customer_id).toBe('cus_new');
    expect(r.subscription_status).toBe('trialing');
    expect(r.plan).toBe('annual');
  });

  it('returns null when the subscription cannot be tied to any user', async () => {
    const { env, eventStates } = fakeEnv([newRow('u1', { stripe_customer_id: 'cus_1' })]);
    const id = await applySubscription(env, {
      id: 'sub_x',
      customerId: 'cus_unknown',
      status: 'active',
      priceId: 'price_m',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      trialEnd: null,
      metadataUserId: null,
    }, event('evt_unknown', 200));
    expect(id).toBeNull();
    expect(eventStates.get('sub_x')).toMatchObject({
      customerId: 'cus_unknown',
      created: 200,
      eventId: 'evt_unknown',
    });
  });
});

describe('endSubscription', () => {
  it('marks the subscription canceled for the matching customer', async () => {
    const { env, rows } = fakeEnv([
      newRow('u1', {
        stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1',
        subscription_status: 'active', cancel_at_period_end: 1,
      }),
    ]);
    const id = await endSubscription(env, 'cus_1', 'sub_1', event('evt_deleted', 300, 'customer.subscription.deleted'));
    expect(id).toBe('u1');
    expect(rows.get('u1')!.subscription_status).toBe('canceled');
    expect(rows.get('u1')!.cancel_at_period_end).toBe(0);
  });

  it('returns null for an unknown customer', async () => {
    const { env, eventStates } = fakeEnv();
    expect(await endSubscription(env, 'cus_none', 'sub_none', event('evt_none', 300, 'customer.subscription.deleted'))).toBeNull();
    expect(eventStates.get('sub_none')).toMatchObject({
      customerId: 'cus_none',
      created: 300,
      eventType: 'customer.subscription.deleted',
    });
  });

  it('uses deletion metadata to cancel without overwriting the customer link', async () => {
    const { env, rows } = fakeEnv([newRow('u1', {
      stripe_subscription_id: 'sub_1',
      subscription_status: 'active',
    })]);
    const id = await endSubscription(
      env,
      'cus_unlinked',
      'sub_1',
      event('evt_deleted_metadata', 350, 'customer.subscription.deleted'),
      'u1',
    );
    expect(id).toBe('u1');
    expect(rows.get('u1')?.subscription_status).toBe('canceled');
    expect(rows.get('u1')?.stripe_customer_id).toBeNull();
  });
});

describe('subscription event ordering', () => {
  it('does not let an older update roll a subscription backward', async () => {
    const { env, rows } = fakeEnv([newRow('u1', { stripe_customer_id: 'cus_1' })]);
    const base = {
      id: 'sub_1', customerId: 'cus_1', priceId: 'price_m', currentPeriodEnd: null,
      cancelAtPeriodEnd: false, trialEnd: null, metadataUserId: null,
    };
    await applySubscription(env, { ...base, status: 'active' }, event('evt_newer', 500));
    await applySubscription(env, { ...base, status: 'past_due' }, event('evt_older', 400));
    expect(rows.get('u1')?.subscription_status).toBe('active');
  });

  it('gives deletion precedence over same-second updates', async () => {
    const { env, rows } = fakeEnv([newRow('u1', {
      stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', subscription_status: 'active',
    })]);
    await endSubscription(env, 'cus_1', 'sub_1', event('evt_deleted', 600, 'customer.subscription.deleted'));
    await applySubscription(env, {
      id: 'sub_1', customerId: 'cus_1', status: 'active', priceId: 'price_m',
      currentPeriodEnd: null, cancelAtPeriodEnd: false, trialEnd: null, metadataUserId: null,
    }, event('evt_updated', 600));
    expect(rows.get('u1')?.subscription_status).toBe('canceled');
  });

  it('allows a same-second created active subscription to replace a terminal old subscription', async () => {
    const { env, rows } = fakeEnv([newRow('u1', {
      stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_old', subscription_status: 'active',
    })]);
    await endSubscription(
      env,
      'cus_1',
      'sub_old',
      event('evt_old_deleted', 650, 'customer.subscription.deleted'),
    );
    await applySubscription(env, {
      id: 'sub_new', customerId: 'cus_1', status: 'active', priceId: 'price_m',
      currentPeriodEnd: null, cancelAtPeriodEnd: false, trialEnd: null, metadataUserId: null,
    }, event('evt_new_created', 650, 'customer.subscription.created'));
    expect(rows.get('u1')).toMatchObject({
      stripe_subscription_id: 'sub_new',
      subscription_status: 'active',
    });
  });

  it('fails closed for a same-second cross-subscription create when the old subscription is nonterminal', async () => {
    const { env, rows } = fakeEnv([newRow('u1', { stripe_customer_id: 'cus_1' })]);
    const subscription = (id: string) => ({
      id, customerId: 'cus_1', status: 'active', priceId: 'price_m',
      currentPeriodEnd: null, cancelAtPeriodEnd: false, trialEnd: null, metadataUserId: null,
    });
    await applySubscription(env, subscription('sub_old'), event('evt_old_updated', 675));
    await applySubscription(
      env,
      subscription('sub_new'),
      event('evt_new_created', 675, 'customer.subscription.created'),
    );
    expect(rows.get('u1')).toMatchObject({
      stripe_subscription_id: 'sub_old',
      subscription_status: 'active',
    });
  });

  it('does not let an older event from another subscription replace the current one', async () => {
    const { env, rows } = fakeEnv([newRow('u1', { stripe_customer_id: 'cus_1' })]);
    const makeSub = (id: string, status: string) => ({
      id, customerId: 'cus_1', status, priceId: 'price_m', currentPeriodEnd: null,
      cancelAtPeriodEnd: false, trialEnd: null, metadataUserId: null,
    });
    await applySubscription(env, makeSub('sub_new', 'active'), event('evt_new', 800, 'customer.subscription.created'));
    await applySubscription(env, makeSub('sub_old', 'past_due'), event('evt_old', 700));
    expect(rows.get('u1')?.stripe_subscription_id).toBe('sub_new');
    expect(rows.get('u1')?.subscription_status).toBe('active');
  });

  it('records an ownerless deletion and blocks a stale metadata create from re-enabling it', async () => {
    const { env, rows } = fakeEnv([newRow('u1')]);
    expect(await endSubscription(
      env,
      'cus_unknown',
      'sub_1',
      event('evt_deleted_new', 900, 'customer.subscription.deleted'),
    )).toBeNull();

    await applySubscription(env, {
      id: 'sub_1',
      customerId: 'cus_unknown',
      status: 'active',
      priceId: 'price_m',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      trialEnd: null,
      metadataUserId: 'u1',
    }, event('evt_created_stale', 800, 'customer.subscription.created'));

    expect(rows.get('u1')).toMatchObject({
      stripe_customer_id: null,
      stripe_subscription_id: null,
      subscription_status: null,
    });
  });

  it('does not let stale metadata replace a current customer and subscription', async () => {
    const { env, rows } = fakeEnv([newRow('u1', { stripe_customer_id: 'cus_current' })]);
    const subscription = (id: string, customerId: string, metadataUserId: string | null) => ({
      id,
      customerId,
      status: 'active',
      priceId: 'price_m',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      trialEnd: null,
      metadataUserId,
    });
    await applySubscription(
      env,
      subscription('sub_current', 'cus_current', null),
      event('evt_current', 1_000, 'customer.subscription.created'),
    );
    await applySubscription(
      env,
      subscription('sub_stale', 'cus_stale', 'u1'),
      event('evt_stale', 900, 'customer.subscription.created'),
    );
    expect(rows.get('u1')).toMatchObject({
      stripe_customer_id: 'cus_current',
      stripe_subscription_id: 'sub_current',
      subscription_status: 'active',
    });
  });
});

describe('getUserByStripeCustomerId', () => {
  it('returns the mapped user or null', async () => {
    const { env } = fakeEnv([newRow('u1', { stripe_customer_id: 'cus_1' })]);
    expect((await getUserByStripeCustomerId(env, 'cus_1'))?.id).toBe('u1');
    expect(await getUserByStripeCustomerId(env, 'nope')).toBeNull();
  });
});
