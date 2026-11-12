import { describe, it, expect } from 'vitest';
import {
  buildTransactionsQuery,
  buildTransactionsCountQuery,
  buildTransactionsExportQuery,
} from '../rows.ts';
import { buildRestRouter } from '../rest.ts';
import { issueDeviceEntitlementToken } from '../../billing/deviceEntitlement.ts';
import type { Env } from '../../shared/types.ts';

const TEST_DEVICE_ENTITLEMENT_SECRET = 'test-device-entitlement-secret';

describe('freemium query gating (filedSince)', () => {
  it('adds the recency clause + bound param to the feed query', () => {
    const q = buildTransactionsQuery({ filedSince: '2024-01-01', limit: 50 });
    expect(q.sql).toContain('COALESCE(f.filed_date, t.tx_date) >= ?');
    expect(q.params).toContain('2024-01-01');
    expect(q.limit).toBe(50);
  });

  it('applies the same clause to the count query (consistent X of N)', () => {
    const q = buildTransactionsCountQuery({ filedSince: '2024-01-01' });
    expect(q.sql).toContain('COALESCE(f.filed_date, t.tx_date) >= ?');
    expect(q.params).toEqual(['2024-01-01']);
  });

  it('omits the clause when filedSince is absent', () => {
    expect(buildTransactionsQuery({}).sql).not.toContain('filed_date, t.tx_date) >=');
  });
});

describe('buildTransactionsExportQuery', () => {
  it('drops the cursor backstop, orders newest-first, and has no product LIMIT', () => {
    const q = buildTransactionsExportQuery({ ticker: 'aapl' });
    expect(q.sql).not.toContain('cursor_seq > ?');
    expect(q.sql).toContain('ORDER BY COALESCE(t.first_seen_at, t.filed_date, t.tx_date, t.cursor_seq) DESC, t.cursor_seq DESC');
    // Premium export is the full match set — no silent row cap.
    expect(q.sql).not.toMatch(/\bLIMIT\b/i);
    expect(q.params).toContain('AAPL');
  });

  it('honors an explicit positive maxRows for tests/tooling only', () => {
    const q = buildTransactionsExportQuery({}, 10_000);
    expect(q.limit).toBe(10_000);
    expect(q.sql).toContain('LIMIT 10000');
  });

  it('floors a fractional maxRows instead of embedding it verbatim (would be invalid SQL)', () => {
    const q = buildTransactionsExportQuery({}, 500.7);
    expect(q.limit).toBe(500);
    expect(q.sql).toContain('LIMIT 500');
    expect(q.sql).not.toContain('500.7');
  });

  it('treats a non-finite or non-positive maxRows as unlimited (no LIMIT clause)', () => {
    expect(buildTransactionsExportQuery({}, NaN).sql).not.toMatch(/\bLIMIT\b/i);
    expect(buildTransactionsExportQuery({}, Infinity).sql).not.toMatch(/\bLIMIT\b/i);
    expect(buildTransactionsExportQuery({}, 0).sql).not.toMatch(/\bLIMIT\b/i);
    expect(buildTransactionsExportQuery({}, -1).sql).not.toMatch(/\bLIMIT\b/i);
  });
});

/**
 * Fake env for export gating.
 * - No Authorization / cookie => getCurrentUserFromRequest → null
 * - Bearer free-token / premium-token => session KV → user row with plan
 */
interface AnonSubOpts {
  originalTransactionId: string;
  status: 'active' | 'expired' | 'revoked' | 'grace_period' | 'billing_retry';
  expiresDate?: string | null;
}

function fakeEnv(opts: { plan?: 'premium' | 'free'; anonSub?: AnonSubOpts | null } = {}): Env {
  return {
    APPLE_DEVICE_ENTITLEMENT_SECRET: TEST_DEVICE_ENTITLEMENT_SECRET,
    CONFIG_KV: {
      get: async (key: string) => {
        if (key === 'sess:free-token') return JSON.stringify({ userId: 'user_free' });
        if (key === 'sess:premium-token') return JSON.stringify({ userId: 'user_premium' });
        return null;
      },
      put: async () => {},
      delete: async () => {},
    },
    DB: {
      prepare: (sql: string) => ({
        params: [] as unknown[],
        bind(...params: unknown[]) {
          this.params = params;
          return this;
        },
        async first() {
          if (/SELECT \* FROM users WHERE id = \?/i.test(sql)) {
            const id = String(this.params[0] ?? '');
            const isPremium =
              id === 'user_premium' || (opts.plan === 'premium' && id !== 'user_free');
            const isFree = id === 'user_free' || opts.plan === 'free';
            if (!isPremium && !isFree) return null;
            return {
              id,
              email: `${id}@example.com`,
              name: 'User',
              picture: null,
              google_sub: null,
              email_verified: 1,
              created_at: '2026-01-01T00:00:00.000Z',
              last_login_at: null,
              subscription_status: isPremium ? 'active' : 'canceled',
              plan: isPremium ? 'monthly' : null,
            };
          }
          // Non-premium-via-Stripe users also fall through to the Apple IAP
          // ledger check (resolveEntitlementAsync); none of these fake users
          // have an Apple subscription, so that lookup returns null unless
          // the test asked for an anonymous device-entitlement ledger row.
          if (/FROM apple_subscriptions/i.test(sql)) {
            const { anonSub } = opts;
            if (!anonSub || String(this.params[0] ?? '') !== anonSub.originalTransactionId) return null;
            return {
              original_transaction_id: anonSub.originalTransactionId,
              user_id: null,
              product_id: 'trade.congress.premium.monthly',
              plan: 'monthly',
              status: anonSub.status,
              environment: 'Production',
              latest_transaction_id: anonSub.originalTransactionId,
              purchase_date: '2026-01-01T00:00:00.000Z',
              expires_date: anonSub.expiresDate === undefined ? '2099-01-01T00:00:00.000Z' : anonSub.expiresDate,
              auto_renew_status: 1,
              auto_renew_product_id: null,
              revoked_at: null,
              revocation_reason: null,
              last_notification_type: null,
              last_notification_subtype: null,
              created_at: '2026-01-01T00:00:00.000Z',
              updated_at: '2026-01-01T00:00:00.000Z',
            };
          }
          return { total: 0 };
        },
        async all() {
          return { results: [] };
        },
        async run() {
          return {};
        },
      }),
    },
  } as unknown as Env;
}

describe('GET /transactions is public (ungated)', () => {
  it('returns a transactions array with no gating flags for anonymous visitors', async () => {
    const app = buildRestRouter();
    const res = await app.request('http://localhost/transactions', {}, fakeEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { transactions: unknown[]; gated?: boolean; premium?: boolean };
    expect(Array.isArray(body.transactions)).toBe(true);
    // No freemium gate on the feed itself — premium is enforced on export.
    expect(body.gated).toBeUndefined();
    expect(body.premium).toBeUndefined();
  });
});

describe('GET /export/transactions.csv', () => {
  it('returns 402 (not 401 — Guideline 5.1.1(v): no account required to buy) for anonymous visitors with no device token', async () => {
    const app = buildRestRouter();
    const res = await app.request('http://localhost/export/transactions.csv', {}, fakeEnv());
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error?: string; upgradeRequired?: boolean; feature?: string };
    expect(body.upgradeRequired).toBe(true);
    expect(body.feature).toBe('export');
  });

  it('returns 402 for signed-in free users', async () => {
    const app = buildRestRouter();
    const res = await app.request(
      'http://localhost/export/transactions.csv',
      { headers: { authorization: 'Bearer free-token' } },
      fakeEnv(),
    );
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error?: string; upgradeRequired?: boolean; feature?: string };
    expect(body.upgradeRequired).toBe(true);
    expect(body.feature).toBe('export');
    expect(body.error).toMatch(/Premium/i);
  });

  it('returns 200 text/csv for Premium users with complete-export headers', async () => {
    const app = buildRestRouter();
    const res = await app.request(
      'http://localhost/export/transactions.csv',
      { headers: { authorization: 'Bearer premium-token' } },
      fakeEnv(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    // No completeness claim: headers precede the stream, so a mid-stream
    // abort must not carry a promise the body did not keep.
    expect(res.headers.get('X-Export-Complete')).toBeNull();
    expect(res.headers.get('X-Export-Row-Count')).toBe('0');
    const csv = await res.text();
    expect(csv).toContain('filed_at');
    expect(csv).toContain('ticker');
  });
});

describe('GET /export/transactions.csv — anonymous device entitlement (Guideline 5.1.1(v))', () => {
  const anonSub: AnonSubOpts = { originalTransactionId: 'otxn-anon-export', status: 'active' };

  it('exports for a signed-out device carrying a valid device entitlement token', async () => {
    const env = fakeEnv({ anonSub });
    const token = await issueDeviceEntitlementToken(env, anonSub.originalTransactionId, '2099-01-01T00:00:00.000Z');
    const app = buildRestRouter();
    const res = await app.request(
      'http://localhost/export/transactions.csv',
      { headers: { 'X-Apple-Device-Entitlement': token! } },
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
  });

  it('refuses export once the ledger row backing the token is revoked', async () => {
    const revoked: AnonSubOpts = { ...anonSub, originalTransactionId: 'otxn-anon-export-revoked', status: 'revoked' };
    const env = fakeEnv({ anonSub: revoked });
    const token = await issueDeviceEntitlementToken(env, revoked.originalTransactionId, '2099-01-01T00:00:00.000Z');
    const app = buildRestRouter();
    const res = await app.request(
      'http://localhost/export/transactions.csv',
      { headers: { 'X-Apple-Device-Entitlement': token! } },
      env,
    );
    expect(res.status).toBe(402);
  });

  it('a present-but-free session takes priority over a valid device token (never OR the two)', async () => {
    const env = fakeEnv({ anonSub });
    const token = await issueDeviceEntitlementToken(env, anonSub.originalTransactionId, '2099-01-01T00:00:00.000Z');
    const app = buildRestRouter();
    const res = await app.request(
      'http://localhost/export/transactions.csv',
      { headers: { authorization: 'Bearer free-token', 'X-Apple-Device-Entitlement': token! } },
      env,
    );
    expect(res.status).toBe(402);
  });
});
