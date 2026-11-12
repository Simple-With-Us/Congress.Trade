import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAdminRouter } from '../routes.ts';
import { buildPremiumRoster, localPremiumCounts } from '../premiumRoster.ts';
import { openMigratedD1, type SqliteDatabase } from '../../prices/__tests__/sqliteD1.ts';
import type { Env } from '../../shared/types.ts';

const app = buildAdminRouter();

let db: SqliteDatabase;
let d1: D1Database;
let close: () => void;

beforeEach(async () => {
  const opened = await openMigratedD1();
  db = opened.db;
  d1 = opened.d1;
  close = opened.close;
});
afterEach(() => {
  vi.unstubAllGlobals();
  close();
});

function env(): Env {
  return {
    DB: d1,
    ADMIN_TOKEN: 'admin-secret',
    SENTRY_ENVIRONMENT: 'development',
    USAGE_MONITOR_ENVIRONMENT: 'local',
  } as unknown as Env;
}

function seedUser(over: {
  id: string;
  email: string;
  plan?: string | null;
  status?: string | null;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
}): void {
  db.prepare(
    `INSERT INTO users (
       id, email, email_verified, created_at,
       stripe_customer_id, stripe_subscription_id, subscription_status, plan
     ) VALUES (?, ?, 1, '2026-01-01T00:00:00.000Z', ?, ?, ?, ?)`,
  ).run(
    over.id,
    over.email,
    over.stripeCustomerId ?? null,
    over.stripeSubscriptionId ?? null,
    over.status ?? null,
    over.plan ?? null,
  );
}

function seedApple(over: {
  originalTransactionId: string;
  userId: string | null;
  plan?: string;
  status?: string;
  environment?: string | null;
}): void {
  db.prepare(
    `INSERT INTO apple_subscriptions (
       original_transaction_id, user_id, product_id, plan, status, environment,
       created_at, updated_at
     ) VALUES (?, ?, 'trade.congress.premium.monthly', ?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run(
    over.originalTransactionId,
    over.userId,
    over.plan ?? 'monthly',
    over.status ?? 'active',
    over.environment ?? 'Production',
  );
}

describe('Admin Premium roster', () => {
  it('lists Stripe trial vs paid and Apple Sandbox vs Production', async () => {
    seedUser({
      id: 'e0f66850-1b16-4e53-af8f-fed26eff1fd8',
      email: 'jay@example.com',
      plan: 'monthly',
      status: 'trialing',
      stripeCustomerId: 'cus_V6lpQxUfj9pdyT',
      stripeSubscriptionId: 'sub_1U6YIk',
    });
    seedUser({
      id: 'paid-stripe',
      email: 'paid@example.com',
      plan: 'annual',
      status: 'active',
      stripeCustomerId: 'cus_paid',
      stripeSubscriptionId: 'sub_paid',
    });
    seedUser({
      id: 'apple-user',
      email: 'apple@example.com',
    });
    seedApple({
      originalTransactionId: '1000000001',
      userId: 'apple-user',
      environment: 'Sandbox',
    });
    seedApple({
      originalTransactionId: '1000000002',
      userId: null,
      environment: 'Production',
    });

    const counts = await localPremiumCounts(env());
    expect(counts).toMatchObject({
      trialUsers: 1,
      paidUsers: 3,
      stripeUsers: 2,
      appleUsers: 2,
    });

    const roster = await buildPremiumRoster(env());
    expect(roster.summary).toMatchObject({
      trial: 1,
      paid: 3,
      stripe: 2,
      apple: 2,
      sandbox: 1,
      production: 3,
    });
    expect(roster.members).toEqual(expect.arrayContaining([
      expect.objectContaining({
        email: 'jay@example.com',
        plan: 'Monthly',
        billing: 'Trial',
        source: 'Stripe',
        stripeMatch: 'Could Not Reach Stripe',
      }),
      expect.objectContaining({
        email: 'paid@example.com',
        plan: 'Annual',
        billing: 'Paid',
        source: 'Stripe',
      }),
      expect.objectContaining({
        email: 'apple@example.com',
        billing: 'Paid',
        source: 'Apple',
        environment: 'Sandbox',
        stripeMatch: 'Not A Stripe Member',
      }),
      expect.objectContaining({
        email: 'Not Linked To An Account',
        source: 'Apple',
        environment: 'Production',
      }),
    ]));
    expect(JSON.stringify(roster)).not.toMatch(/subscription_status|livemode|webhook|IAP/i);
  });

  it('heals a stale local trial when Stripe already shows paid', async () => {
    seedUser({
      id: 'e0f66850-1b16-4e53-af8f-fed26eff1fd8',
      email: 'jay@example.com',
      plan: 'monthly',
      status: 'trialing',
      stripeCustomerId: 'cus_V6lpQxUfj9pdyT',
      stripeSubscriptionId: 'sub_1U6YIk',
    });
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const url = String(input);
      const live = {
        id: 'sub_1U6YIk',
        status: 'active',
        customer: { id: 'cus_V6lpQxUfj9pdyT', email: 'jay@example.com' },
        livemode: false,
        trial_end: null,
        items: { data: [{ price: { id: 'price_m' }, current_period_end: 1_893_456_000 }] },
      };
      if (url.includes('/v1/subscriptions/sub_1U6YIk')) {
        return new Response(JSON.stringify(live), { status: 200 });
      }
      if (url.includes('/v1/subscriptions')) {
        return new Response(JSON.stringify({ data: [live], has_more: false }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const roster = await buildPremiumRoster({
      ...env(),
      STRIPE_SECRET_KEY: 'sk_test_123',
      STRIPE_PRICE_MONTHLY: 'price_m',
    } as unknown as Env);

    expect(roster.members).toEqual([
      expect.objectContaining({
        email: 'jay@example.com',
        plan: 'Monthly',
        billing: 'Paid',
        source: 'Stripe',
        environment: 'Sandbox',
        stripeMatch: 'Matches Stripe',
        healed: true,
      }),
    ]);
    expect(
      db.prepare('SELECT subscription_status, plan FROM users WHERE id = ?')
        .get('e0f66850-1b16-4e53-af8f-fed26eff1fd8'),
    ).toMatchObject({
      subscription_status: 'active',
      plan: 'monthly',
    });
  });

  it('serves GET /premium-roster behind admin auth', async () => {
    seedUser({
      id: 'u1',
      email: 'owner@example.com',
      plan: 'monthly',
      status: 'active',
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_1',
    });
    const denied = await app.request('/premium-roster', {}, env());
    expect(denied.status).toBe(401);

    const res = await app.request(
      '/premium-roster',
      { headers: { Authorization: 'Bearer admin-secret' } },
      env(),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { members: Array<{ email: string; billing: string; source: string }> };
    expect(body.members).toEqual([
      expect.objectContaining({
        email: 'owner@example.com',
        billing: 'Paid',
        source: 'Stripe',
      }),
    ]);
  });
});
