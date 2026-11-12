import { describe, it, expect } from 'vitest';
import { entitlementOf, isPremiumUser, ANONYMOUS_ENTITLEMENT, resolveEntitlementAsync, isPremiumUserAsync } from '../entitlement.ts';
import type { Env, User } from '../../shared/types.ts';

function user(over: Partial<User> = {}): User {
  return {
    id: 'u1',
    email: 'a@b.com',
    name: null,
    picture: null,
    googleSub: null,
    appleSub: null,
    emailVerified: true,
    createdAt: 'now',
    lastLoginAt: null,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    subscriptionStatus: null,
    plan: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    trialEnd: null,
    ...over,
  };
}

/** Minimal fake Env.DB supporting exactly the one query activeAppleSubscriptionForUser issues. */
function fakeEnvWithAppleSubscriptions(rows: Array<Record<string, unknown>>): Env {
  const prepare = (_sql: string) => ({
    _p: [] as unknown[],
    bind(...p: unknown[]) {
      this._p = p;
      return this;
    },
    async first<T>() {
      const [userId, nowIso] = this._p as [string, string];
      const match = rows
        .filter(
          (r) =>
            r.user_id === userId &&
            (r.status === 'active' || r.status === 'grace_period') &&
            (r.expires_date == null || (r.expires_date as string) > nowIso),
        )
        .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0];
      return (match ?? null) as T | null;
    },
    async run() {
      return { success: true, meta: { changes: 0 } };
    },
    async all<T>() {
      return { results: [] as T[] };
    },
  });
  return { DB: { prepare } } as unknown as Env;
}

describe('entitlementOf', () => {
  it('anonymous visitors get the free entitlement', () => {
    expect(entitlementOf(null)).toEqual(ANONYMOUS_ENTITLEMENT);
    expect(entitlementOf(undefined)).toEqual(ANONYMOUS_ENTITLEMENT);
    expect(entitlementOf(null).premium).toBe(false);
  });

  it('grants premium while trialing (and flags trialing)', () => {
    const e = entitlementOf(user({ subscriptionStatus: 'trialing', plan: 'monthly', trialEnd: 'T' }));
    expect(e.premium).toBe(true);
    expect(e.trialing).toBe(true);
    expect(e.plan).toBe('monthly');
    expect(e.trialEnd).toBe('T');
  });

  it('grants premium while active', () => {
    expect(entitlementOf(user({ subscriptionStatus: 'active', plan: 'annual' })).premium).toBe(true);
  });

  it('denies premium for past_due / canceled / unknown statuses', () => {
    expect(entitlementOf(user({ subscriptionStatus: 'past_due' })).premium).toBe(false);
    expect(entitlementOf(user({ subscriptionStatus: 'canceled' })).premium).toBe(false);
    expect(entitlementOf(user({ subscriptionStatus: 'incomplete' })).premium).toBe(false);
    expect(entitlementOf(user()).premium).toBe(false);
  });

  it('denies premium when an active subscription has no recognized app plan', () => {
    const e = entitlementOf(user({ subscriptionStatus: 'active', plan: null }));
    expect(e.premium).toBe(false);
    expect(e.status).toBe('active');
  });

  it('passes through cancel_at_period_end + period end', () => {
    const e = entitlementOf(
      user({ subscriptionStatus: 'active', cancelAtPeriodEnd: true, currentPeriodEnd: 'P' }),
    );
    expect(e.cancelAtPeriodEnd).toBe(true);
    expect(e.currentPeriodEnd).toBe('P');
  });

  it('isPremiumUser mirrors entitlement.premium', () => {
    expect(isPremiumUser(user({ subscriptionStatus: 'active', plan: 'monthly' }))).toBe(true);
    expect(isPremiumUser(user({ subscriptionStatus: 'past_due' }))).toBe(false);
    expect(isPremiumUser(null)).toBe(false);
  });
});

describe('resolveEntitlementAsync (Stripe OR Apple)', () => {
  it('anonymous visitors stay anonymous without ever querying the Apple ledger', async () => {
    let queried = false;
    const env = fakeEnvWithAppleSubscriptions([]);
    const realPrepare = env.DB.prepare.bind(env.DB);
    (env.DB as { prepare: typeof env.DB.prepare }).prepare = ((sql: string) => {
      queried = true;
      return realPrepare(sql);
    }) as typeof env.DB.prepare;
    const e = await resolveEntitlementAsync(env, null);
    expect(e).toEqual(ANONYMOUS_ENTITLEMENT);
    expect(queried).toBe(false);
  });

  it('an active Stripe subscription short-circuits without querying the Apple ledger', async () => {
    let queried = false;
    const env = fakeEnvWithAppleSubscriptions([]);
    const realPrepare = env.DB.prepare.bind(env.DB);
    (env.DB as { prepare: typeof env.DB.prepare }).prepare = ((sql: string) => {
      queried = true;
      return realPrepare(sql);
    }) as typeof env.DB.prepare;
    const e = await resolveEntitlementAsync(env, user({ subscriptionStatus: 'active', plan: 'annual' }));
    expect(e.premium).toBe(true);
    expect(e.source).toBe('stripe');
    expect(queried).toBe(false);
  });

  it('grants premium from an active Apple subscription when Stripe is not premium', async () => {
    const env = fakeEnvWithAppleSubscriptions([
      {
        user_id: 'u1',
        status: 'active',
        plan: 'monthly',
        expires_date: '2099-01-01T00:00:00.000Z',
        auto_renew_status: 1,
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    ]);
    const e = await resolveEntitlementAsync(env, user({ subscriptionStatus: null, plan: null }));
    expect(e.premium).toBe(true);
    expect(e.plan).toBe('monthly');
    expect(e.source).toBe('apple');
    expect(e.cancelAtPeriodEnd).toBe(false);
  });

  it('an expired Apple subscription does not grant premium', async () => {
    const env = fakeEnvWithAppleSubscriptions([
      { user_id: 'u1', status: 'active', plan: 'monthly', expires_date: '2000-01-01T00:00:00.000Z', updated_at: 'x' },
    ]);
    const e = await resolveEntitlementAsync(env, user());
    expect(e.premium).toBe(false);
  });

  it('a revoked Apple subscription does not grant premium', async () => {
    const env = fakeEnvWithAppleSubscriptions([
      { user_id: 'u1', status: 'revoked', plan: 'annual', expires_date: '2099-01-01T00:00:00.000Z', updated_at: 'x' },
    ]);
    const e = await resolveEntitlementAsync(env, user());
    expect(e.premium).toBe(false);
  });

  it('surfaces cancelAtPeriodEnd true when auto-renew is off', async () => {
    const env = fakeEnvWithAppleSubscriptions([
      {
        user_id: 'u1',
        status: 'active',
        plan: 'annual',
        expires_date: '2099-01-01T00:00:00.000Z',
        auto_renew_status: 0,
        updated_at: 'x',
      },
    ]);
    const e = await resolveEntitlementAsync(env, user());
    expect(e.cancelAtPeriodEnd).toBe(true);
  });

  it('isPremiumUserAsync mirrors resolveEntitlementAsync.premium', async () => {
    const env = fakeEnvWithAppleSubscriptions([
      { user_id: 'u1', status: 'active', plan: 'monthly', expires_date: '2099-01-01T00:00:00.000Z', updated_at: 'x' },
    ]);
    expect(await isPremiumUserAsync(env, user())).toBe(true);
    expect(await isPremiumUserAsync(env, user({ id: 'someone-else' }))).toBe(false);
    expect(await isPremiumUserAsync(env, null)).toBe(false);
  });
});
