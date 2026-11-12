/**
 * POST /billing/apple/confirm — leftover iOS path. Must grant through the
 * apple_subscriptions ledger (same verify + revoke-resurrect checks as
 * redeem_apple_purchase) and must NOT stamp users.subscription_status, or a
 * refunded original StoreKit JWS mints Premium that REFUND/REVOKE cannot clear.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const verifyAppleSignedJws = vi.fn();
vi.mock('../../billing/appleJws', () => ({
  verifyAppleSignedJws: (...args: unknown[]) => verifyAppleSignedJws(...args),
  AppleJwsVerificationError: class AppleJwsVerificationError extends Error {},
}));

const getCurrentUser = vi.fn();
vi.mock('../../auth/session', () => ({
  getCurrentUser: (...args: unknown[]) => getCurrentUser(...args),
  getCurrentUserFromRequest: (...args: unknown[]) => getCurrentUser(...args),
}));

import { buildBillingRouter } from '../routes.ts';
import type { Env, User } from '../../shared/types.ts';

interface SqliteRunResult {
  changes: number | bigint;
}
interface SqliteStatement {
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Array<Record<string, unknown>>;
  run(...params: unknown[]): SqliteRunResult;
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}
interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDatabase;
}

async function freshDb(): Promise<SqliteDatabase> {
  const sqlite = (await import('node:sqlite')) as SqliteModule;
  const db = new sqlite.DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT, picture TEXT,
      google_sub TEXT, apple_sub TEXT, email_verified INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, last_login_at TEXT,
      stripe_customer_id TEXT, stripe_subscription_id TEXT, subscription_status TEXT,
      plan TEXT, current_period_end TEXT, cancel_at_period_end INTEGER NOT NULL DEFAULT 0, trial_end TEXT
    );
    CREATE TABLE apple_subscriptions (
      original_transaction_id TEXT PRIMARY KEY, user_id TEXT, product_id TEXT NOT NULL,
      plan TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', environment TEXT,
      latest_transaction_id TEXT, purchase_date TEXT, expires_date TEXT,
      auto_renew_status INTEGER, auto_renew_product_id TEXT, revoked_at TEXT, revocation_reason INTEGER,
      last_notification_type TEXT, last_notification_subtype TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  db.exec(`
    INSERT INTO users (id, email, email_verified, created_at)
    VALUES ('user_1', 'user_1@example.com', 1, '2026-01-01T00:00:00.000Z')
  `);
  return db;
}

function d1Database(db: SqliteDatabase): Env['DB'] {
  const prepare = (sql: string) => {
    let params: unknown[] = [];
    const statement = {
      bind(...values: unknown[]) {
        params = values;
        return statement;
      },
      async first<T>() {
        return (db.prepare(sql).get(...params) ?? null) as T | null;
      },
      async run() {
        const result = db.prepare(sql).run(...params);
        return { success: true, meta: { changes: Number(result.changes) } } as unknown;
      },
      async all<T>() {
        return { results: db.prepare(sql).all(...params) as T[] };
      },
    };
    return statement;
  };
  return { prepare } as unknown as Env['DB'];
}

function sessionUser(over: Partial<User> = {}): User {
  return {
    id: 'user_1',
    email: 'user_1@example.com',
    name: null,
    picture: null,
    googleSub: null,
    appleSub: null,
    emailVerified: true,
    createdAt: '2026-01-01T00:00:00.000Z',
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

async function fakeEnv(overrides: Partial<Env> = {}): Promise<Env & { __db: SqliteDatabase }> {
  const db = await freshDb();
  return {
    DB: d1Database(db),
    APPLE_IAP_ENABLED: 'true',
    ...overrides,
    __db: db,
  } as unknown as Env & { __db: SqliteDatabase };
}

const FUTURE_MS = Date.now() + 30 * 86_400_000;

function activeTransaction(overrides: Record<string, unknown> = {}) {
  return {
    transactionId: 'txn-1',
    originalTransactionId: 'otxn-1',
    productId: 'trade.congress.premium.monthly',
    bundleId: 'trade.congress.ios',
    type: 'Auto-Renewable Subscription',
    environment: 'Production',
    expiresDate: FUTURE_MS,
    purchaseDate: Date.now(),
    ...overrides,
  };
}

async function postConfirm(env: Env, body: Record<string, unknown>): Promise<Response> {
  const app = buildBillingRouter();
  return app.request(
    'http://localhost/apple/confirm',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    env,
  );
}

describe('POST /billing/apple/confirm', () => {
  beforeEach(() => {
    verifyAppleSignedJws.mockReset();
    getCurrentUser.mockReset();
    getCurrentUser.mockResolvedValue(sessionUser());
  });

  it('is refused when APPLE_IAP_ENABLED is not "true"', async () => {
    const env = await fakeEnv({ APPLE_IAP_ENABLED: 'false' });
    const res = await postConfirm(env, { signedTransaction: 'a.b.c' });
    expect(res.status).toBe(503);
    expect(verifyAppleSignedJws).not.toHaveBeenCalled();
  });

  it('requires a signed-in user', async () => {
    getCurrentUser.mockResolvedValue(null);
    const env = await fakeEnv();
    const res = await postConfirm(env, { signedTransaction: 'a.b.c' });
    expect(res.status).toBe(401);
  });

  it('grants a Sandbox transaction by default via the Apple ledger — no users-table stamp', async () => {
    verifyAppleSignedJws.mockResolvedValue(activeTransaction({ environment: 'Sandbox' }));
    const env = await fakeEnv();
    const res = await postConfirm(env, { signedTransaction: 'a.b.c' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; entitlement: { premium: boolean } };
    expect(body.ok).toBe(true);
    expect(body.entitlement.premium).toBe(true);
    const user = env.__db.prepare('SELECT subscription_status, plan, stripe_subscription_id FROM users WHERE id = ?').get('user_1');
    expect(user).toMatchObject({ subscription_status: null, plan: null, stripe_subscription_id: null });
    const row = env.__db
      .prepare('SELECT environment FROM apple_subscriptions WHERE original_transaction_id = ?')
      .get('otxn-1') as { environment: string | null };
    expect(row.environment).toBe('Sandbox');
  });

  it('rejects a Sandbox transaction when APPLE_ALLOW_SANDBOX is explicitly false — no users-table grant', async () => {
    verifyAppleSignedJws.mockResolvedValue(activeTransaction({ environment: 'Sandbox' }));
    const env = await fakeEnv({ APPLE_ALLOW_SANDBOX: 'false' });
    const res = await postConfirm(env, { signedTransaction: 'a.b.c' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/Sandbox/);
    const user = env.__db.prepare('SELECT subscription_status, plan, stripe_subscription_id FROM users WHERE id = ?').get('user_1');
    expect(user).toMatchObject({ subscription_status: null, plan: null, stripe_subscription_id: null });
    expect(env.__db.prepare('SELECT * FROM apple_subscriptions').get()).toBeUndefined();
  });

  it('grants via the Apple ledger and does not stamp users.subscription_status', async () => {
    verifyAppleSignedJws.mockResolvedValue(activeTransaction());
    const env = await fakeEnv();
    const res = await postConfirm(env, { signedTransaction: 'a.b.c' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      entitlement: { premium: boolean; source?: string; plan: string | null };
      originalTransactionId: string;
    };
    expect(body.ok).toBe(true);
    expect(body.entitlement.premium).toBe(true);
    expect(body.entitlement.source).toBe('apple');
    expect(body.originalTransactionId).toBe('otxn-1');

    const user = env.__db.prepare('SELECT subscription_status, plan, stripe_subscription_id FROM users WHERE id = ?').get('user_1');
    expect(user).toMatchObject({ subscription_status: null, plan: null, stripe_subscription_id: null });

    const row = env.__db
      .prepare('SELECT user_id, status FROM apple_subscriptions WHERE original_transaction_id = ?')
      .get('otxn-1') as { user_id: string | null; status: string };
    expect(row.user_id).toBe('user_1');
    expect(row.status).toBe('active');
  });

  it('refuses to flip a webhook-revoked row back to active by replaying the original JWS', async () => {
    verifyAppleSignedJws.mockResolvedValue(
      activeTransaction({
        transactionId: 'txn-1',
        purchaseDate: Date.parse('2026-01-01T00:00:00.000Z'),
      }),
    );
    const env = await fakeEnv();
    env.__db.exec(`
      INSERT INTO apple_subscriptions (
        original_transaction_id, user_id, product_id, plan, status, latest_transaction_id,
        revoked_at, created_at, updated_at
      ) VALUES (
        'otxn-1', 'user_1', 'trade.congress.premium.monthly', 'monthly', 'revoked', 'txn-refund',
        '2026-01-15T00:00:00.000Z', '2026-01-01T00:00:00Z', '2026-01-15T00:00:00Z'
      );
    `);
    const res = await postConfirm(env, { signedTransaction: 'a.b.c' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/refunded or revoked/);

    const row = env.__db
      .prepare('SELECT status, revoked_at FROM apple_subscriptions WHERE original_transaction_id = ?')
      .get('otxn-1') as { status: string; revoked_at: string | null };
    expect(row.status).toBe('revoked');
    expect(row.revoked_at).toBe('2026-01-15T00:00:00.000Z');

    const user = env.__db.prepare('SELECT subscription_status, plan FROM users WHERE id = ?').get('user_1');
    expect(user).toMatchObject({ subscription_status: null, plan: null });
  });

  it('refuses (409) a transaction already owned by a different account', async () => {
    verifyAppleSignedJws.mockResolvedValue(activeTransaction());
    const env = await fakeEnv();
    env.__db.exec(`
      INSERT INTO apple_subscriptions (
        original_transaction_id, user_id, product_id, plan, status, created_at, updated_at
      ) VALUES (
        'otxn-1', 'user_other', 'trade.congress.premium.monthly', 'monthly', 'active',
        '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
      );
    `);
    const res = await postConfirm(env, { signedTransaction: 'a.b.c' });
    expect(res.status).toBe(409);
    const owner = env.__db
      .prepare('SELECT user_id FROM apple_subscriptions WHERE original_transaction_id = ?')
      .get('otxn-1') as { user_id: string };
    expect(owner.user_id).toBe('user_other');
  });
});
