// Apple's real signing key is not available to tests, so the JWS chain
// verification itself (appleJws.ts) is unit-tested separately against a
// synthetic chain (billing/__tests__/appleJws.test.ts) — this file mocks
// verifyAppleSignedJws to exercise executeCommand's surrounding
// redeem_apple_purchase logic (bundle id / product id / active-window
// checks, ledger idempotency, owner-mismatch conflict, entitlement result).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyAppleSignedJws = vi.fn();
vi.mock('../../billing/appleJws', () => ({
  verifyAppleSignedJws: (...args: unknown[]) => verifyAppleSignedJws(...args),
  AppleJwsVerificationError: class AppleJwsVerificationError extends Error {},
}));

// Real notification delivery (Pushover HTTP + totals aggregate) is covered by
// billing/__tests__/premiumActivationAlert.test.ts; here we only need to
// assert executeCommand calls it exactly once on a genuinely new Apple
// activation, and not again on a restore-purchases replay.
const notifyPremiumActivation = vi.fn();
vi.mock('../../billing/premiumActivationAlert', () => ({
  notifyPremiumActivation: (...args: unknown[]) => notifyPremiumActivation(...args),
}));

import { executeCommand, commandType } from '../commands.ts';
import { AppleJwsVerificationError } from '../../billing/appleJws.ts';
import { ClientInputError } from '../utils.ts';
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
    CREATE TABLE user_preferences (
      user_id TEXT PRIMARY KEY, saved_filters TEXT, watchlist TEXT,
      notification_settings TEXT, default_window TEXT, updated_at TEXT
    );
    CREATE TABLE push_devices (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, platform TEXT, token TEXT,
      app_bundle TEXT, env TEXT, active INTEGER, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE subscriptions (
      id TEXT PRIMARY KEY, client_id TEXT, delivery TEXT, target_url TEXT,
      secret TEXT, filters TEXT, cursor INTEGER, active INTEGER, created_at TEXT
    );
    CREATE TABLE sse_leases (
      id TEXT PRIMARY KEY, subscription_id TEXT, client_id TEXT, expires_at TEXT, created_at TEXT
    );
    CREATE TABLE client_commands (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, type TEXT, status TEXT,
      payload TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE premium_activation_notices (
      activation_key TEXT PRIMARY KEY, user_id TEXT NOT NULL, notified_at TEXT NOT NULL
    );
  `);
  db.exec(
    `INSERT INTO users (id, email, google_sub, email_verified, created_at) VALUES ('user_1', 'u1@example.com', NULL, 1, '2026-01-01T00:00:00Z')`,
  );
  db.exec(
    `INSERT INTO users (id, email, google_sub, email_verified, created_at) VALUES ('user_2', 'u2@example.com', NULL, 1, '2026-01-01T00:00:00Z')`,
  );
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

async function fakeEnv(overrides: Partial<Env> = {}): Promise<Env & { __db: SqliteDatabase }> {
  const db = await freshDb();
  const kv = new Map<string, string>();
  return {
    DB: d1Database(db),
    APPLE_IAP_ENABLED: 'true',
    CONFIG_KV: {
      get: async (k: string) => (kv.has(k) ? kv.get(k)! : null),
      put: async (k: string, v: string) => {
        kv.set(k, v);
      },
      delete: async (k: string) => {
        kv.delete(k);
      },
    },
    ...overrides,
    __db: db,
  } as unknown as Env & { __db: SqliteDatabase };
}

function baseUser(id = 'user_1'): User {
  return {
    id,
    email: `${id}@example.com`,
    name: null,
    picture: null,
    googleSub: null,
    appleSub: null,
    emailVerified: true,
    createdAt: '2026-01-01T00:00:00Z',
    lastLoginAt: null,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    subscriptionStatus: null,
    plan: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    trialEnd: null,
  };
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

describe('commandType', () => {
  it('accepts redeem_apple_purchase', () => {
    expect(commandType('redeem_apple_purchase')).toBe('redeem_apple_purchase');
  });

  it('accepts link_apple_entitlement', () => {
    expect(commandType('link_apple_entitlement')).toBe('link_apple_entitlement');
  });

  it('accepts delete_account', () => {
    expect(commandType('delete_account')).toBe('delete_account');
  });
});

describe('executeCommand redeem_apple_purchase', () => {
  beforeEach(() => {
    verifyAppleSignedJws.mockReset();
    notifyPremiumActivation.mockReset();
  });

  it('is refused when APPLE_IAP_ENABLED is not "true"', async () => {
    const env = await fakeEnv({ APPLE_IAP_ENABLED: 'false' });
    await expect(
      executeCommand(env, baseUser(), 'redeem_apple_purchase', { signedTransaction: 'x.y.z' }),
    ).rejects.toThrow(/not enabled/);
    expect(verifyAppleSignedJws).not.toHaveBeenCalled();
  });

  it('requires signedTransaction', async () => {
    const env = await fakeEnv();
    await expect(executeCommand(env, baseUser(), 'redeem_apple_purchase', {})).rejects.toThrow(
      /signedTransaction/,
    );
  });

  it('surfaces a verification failure as a ClientInputError (permanent, not queue-retried)', async () => {
    verifyAppleSignedJws.mockRejectedValue(new AppleJwsVerificationError('invalid JWS signature'));
    const env = await fakeEnv();
    await expect(
      executeCommand(env, baseUser(), 'redeem_apple_purchase', { signedTransaction: 'a.b.c' }),
    ).rejects.toThrow(ClientInputError);
  });

  it('grants a Sandbox transaction by default (TestFlight / Mac / App Review) and records environment', async () => {
    verifyAppleSignedJws.mockResolvedValue(activeTransaction({ environment: 'Sandbox' }));
    const env = await fakeEnv();
    const result = (await executeCommand(env, baseUser(), 'redeem_apple_purchase', {
      signedTransaction: 'a.b.c',
    })) as { entitlement: { premium: boolean } };
    expect(result.entitlement.premium).toBe(true);
    const row = env.__db
      .prepare('SELECT environment FROM apple_subscriptions WHERE original_transaction_id = ?')
      .get('otxn-1') as { environment: string | null };
    expect(row.environment).toBe('Sandbox');
  });

  it('rejects a Sandbox transaction when APPLE_ALLOW_SANDBOX is explicitly false', async () => {
    verifyAppleSignedJws.mockResolvedValue(activeTransaction({ environment: 'Sandbox' }));
    const env = await fakeEnv({ APPLE_ALLOW_SANDBOX: 'false' });
    await expect(
      executeCommand(env, baseUser(), 'redeem_apple_purchase', { signedTransaction: 'a.b.c' }),
    ).rejects.toThrow(/Sandbox/);
  });

  it('rejects a bundle id mismatch', async () => {
    verifyAppleSignedJws.mockResolvedValue(activeTransaction({ bundleId: 'com.other.app' }));
    const env = await fakeEnv();
    await expect(
      executeCommand(env, baseUser(), 'redeem_apple_purchase', { signedTransaction: 'a.b.c' }),
    ).rejects.toThrow(/bundleId/);
  });

  it('rejects an unrecognized product id', async () => {
    verifyAppleSignedJws.mockResolvedValue(activeTransaction({ productId: 'not.a.real.product' }));
    const env = await fakeEnv();
    await expect(
      executeCommand(env, baseUser(), 'redeem_apple_purchase', { signedTransaction: 'a.b.c' }),
    ).rejects.toThrow(/product/);
  });

  it('rejects an expired transaction', async () => {
    verifyAppleSignedJws.mockResolvedValue(activeTransaction({ expiresDate: Date.now() - 1000 }));
    const env = await fakeEnv();
    await expect(
      executeCommand(env, baseUser(), 'redeem_apple_purchase', { signedTransaction: 'a.b.c' }),
    ).rejects.toThrow(/active subscription/);
  });

  it('rejects a revoked transaction', async () => {
    verifyAppleSignedJws.mockResolvedValue(activeTransaction({ revocationDate: Date.now() - 1000 }));
    const env = await fakeEnv();
    await expect(
      executeCommand(env, baseUser(), 'redeem_apple_purchase', { signedTransaction: 'a.b.c' }),
    ).rejects.toThrow(/active subscription/);
  });

  it('grants premium and persists the ledger row on a valid monthly transaction', async () => {
    verifyAppleSignedJws.mockResolvedValue(activeTransaction());
    const env = await fakeEnv();
    const result = (await executeCommand(env, baseUser(), 'redeem_apple_purchase', {
      signedTransaction: 'a.b.c',
    })) as { entitlement: { premium: boolean; plan: string; source?: string }; originalTransactionId: string };
    expect(result.entitlement.premium).toBe(true);
    expect(result.entitlement.plan).toBe('monthly');
    expect(result.entitlement.source).toBe('apple');
    expect(result.originalTransactionId).toBe('otxn-1');
  });

  it('maps the annual product id to the annual plan', async () => {
    verifyAppleSignedJws.mockResolvedValue(
      activeTransaction({ productId: 'trade.congress.premium.annual', originalTransactionId: 'otxn-annual' }),
    );
    const env = await fakeEnv();
    const result = (await executeCommand(env, baseUser(), 'redeem_apple_purchase', {
      signedTransaction: 'a.b.c',
    })) as { plan: string };
    expect(result.plan).toBe('annual');
  });

  it('honors env-configured APPLE_PRODUCT_MONTHLY/ANNUAL over the hardcoded defaults', async () => {
    verifyAppleSignedJws.mockResolvedValue(
      activeTransaction({ productId: 'com.example.custom.monthly', originalTransactionId: 'otxn-custom' }),
    );
    const env = await fakeEnv({ APPLE_PRODUCT_MONTHLY: 'com.example.custom.monthly' });
    const result = (await executeCommand(env, baseUser(), 'redeem_apple_purchase', {
      signedTransaction: 'a.b.c',
    })) as { plan: string };
    expect(result.plan).toBe('monthly');
  });

  it('redeeming the same originalTransactionId again for the same user is idempotent (restore purchases)', async () => {
    verifyAppleSignedJws.mockResolvedValue(activeTransaction());
    const env = await fakeEnv();
    const first = (await executeCommand(env, baseUser(), 'redeem_apple_purchase', {
      signedTransaction: 'a.b.c',
    })) as { originalTransactionId: string };
    const second = (await executeCommand(env, baseUser(), 'redeem_apple_purchase', {
      signedTransaction: 'a.b.c',
    })) as { originalTransactionId: string; entitlement: { premium: boolean } };
    expect(second.originalTransactionId).toBe(first.originalTransactionId);
    expect(second.entitlement.premium).toBe(true);
  });

  it('notifies once on a genuinely new Apple activation, keyed on the original transaction id', async () => {
    verifyAppleSignedJws.mockResolvedValue(activeTransaction());
    const env = await fakeEnv();
    await executeCommand(env, baseUser(), 'redeem_apple_purchase', { signedTransaction: 'a.b.c' });

    expect(notifyPremiumActivation).toHaveBeenCalledTimes(1);
    expect(notifyPremiumActivation).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        activationKey: 'apple:otxn-1',
        userId: 'user_1',
        userEmail: 'user_1@example.com',
        source: 'apple',
        plan: 'monthly',
      }),
    );
  });

  it('does not re-notify on a restore-purchases replay of the same transaction id', async () => {
    verifyAppleSignedJws.mockResolvedValue(activeTransaction());
    const env = await fakeEnv();
    await executeCommand(env, baseUser(), 'redeem_apple_purchase', { signedTransaction: 'a.b.c' });
    await executeCommand(env, baseUser(), 'redeem_apple_purchase', { signedTransaction: 'a.b.c' });

    expect(notifyPremiumActivation).toHaveBeenCalledTimes(1);
  });

  it('does not notify when a purchase is refused (owner-mismatch conflict)', async () => {
    verifyAppleSignedJws.mockResolvedValue(activeTransaction());
    const env = await fakeEnv();
    await executeCommand(env, baseUser('user_1'), 'redeem_apple_purchase', { signedTransaction: 'a.b.c' });
    notifyPremiumActivation.mockReset();
    await expect(
      executeCommand(env, baseUser('user_2'), 'redeem_apple_purchase', { signedTransaction: 'a.b.c' }),
    ).rejects.toThrow(/already linked/);
    expect(notifyPremiumActivation).not.toHaveBeenCalled();
  });

  it('refuses to reassign an originalTransactionId already owned by a different user', async () => {
    verifyAppleSignedJws.mockResolvedValue(activeTransaction());
    const env = await fakeEnv();
    await executeCommand(env, baseUser('user_1'), 'redeem_apple_purchase', { signedTransaction: 'a.b.c' });
    await expect(
      executeCommand(env, baseUser('user_2'), 'redeem_apple_purchase', { signedTransaction: 'a.b.c' }),
    ).rejects.toThrow(/already linked/);
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
    await expect(
      executeCommand(env, baseUser('user_1'), 'redeem_apple_purchase', { signedTransaction: 'a.b.c' }),
    ).rejects.toThrow(/refunded or revoked/);
    const row = env.__db
      .prepare('SELECT status, revoked_at FROM apple_subscriptions WHERE original_transaction_id = ?')
      .get('otxn-1') as { status: string; revoked_at: string | null };
    expect(row.status).toBe('revoked');
    expect(row.revoked_at).toBe('2026-01-15T00:00:00.000Z');
  });

  it('a renewal transaction with a newer expiry updates the same ledger row', async () => {
    verifyAppleSignedJws.mockResolvedValueOnce(activeTransaction({ transactionId: 'txn-1', expiresDate: FUTURE_MS }));
    const env = await fakeEnv();
    const first = (await executeCommand(env, baseUser(), 'redeem_apple_purchase', {
      signedTransaction: 'a.b.c',
    })) as { expiresAt: string };

    const laterExpiry = FUTURE_MS + 30 * 86_400_000;
    verifyAppleSignedJws.mockResolvedValueOnce(
      activeTransaction({ transactionId: 'txn-2', expiresDate: laterExpiry }),
    );
    const second = (await executeCommand(env, baseUser(), 'redeem_apple_purchase', {
      signedTransaction: 'a.b.c',
    })) as { expiresAt: string };

    expect(new Date(second.expiresAt).getTime()).toBeGreaterThan(new Date(first.expiresAt).getTime());
  });

  it('does not re-notify when a later renewal updates the same originalTransactionId', async () => {
    verifyAppleSignedJws.mockResolvedValueOnce(activeTransaction({ transactionId: 'txn-1', expiresDate: FUTURE_MS }));
    const env = await fakeEnv();
    await executeCommand(env, baseUser(), 'redeem_apple_purchase', { signedTransaction: 'a.b.c' });
    expect(notifyPremiumActivation).toHaveBeenCalledTimes(1);

    verifyAppleSignedJws.mockResolvedValueOnce(
      activeTransaction({ transactionId: 'txn-2', expiresDate: FUTURE_MS + 30 * 86_400_000 }),
    );
    await executeCommand(env, baseUser(), 'redeem_apple_purchase', { signedTransaction: 'a.b.c' });
    expect(notifyPremiumActivation).toHaveBeenCalledTimes(1);
  });
});

describe('executeCommand link_apple_entitlement (Guideline 5.1.1(v) — claiming an anonymous purchase on sign-in)', () => {
  beforeEach(() => {
    verifyAppleSignedJws.mockReset();
  });

  it('claims a null-owner ledger row (an anonymous device purchase) for the signed-in user', async () => {
    verifyAppleSignedJws.mockResolvedValue(activeTransaction());
    const env = await fakeEnv();
    const db = (env as Env & { __db: SqliteDatabase }).__db;
    db.exec(`
      INSERT INTO apple_subscriptions (
        original_transaction_id, user_id, product_id, plan, status,
        created_at, updated_at
      ) VALUES (
        'otxn-1', NULL, 'trade.congress.premium.monthly', 'monthly', 'active',
        '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
      );
    `);
    const result = (await executeCommand(env, baseUser('user_1'), 'link_apple_entitlement', {
      signedTransaction: 'a.b.c',
    })) as { entitlement: { premium: boolean }; originalTransactionId: string };
    expect(result.entitlement.premium).toBe(true);
    expect(result.originalTransactionId).toBe('otxn-1');
    const row = db
      .prepare('SELECT user_id FROM apple_subscriptions WHERE original_transaction_id = ?')
      .get('otxn-1') as { user_id: string | null } | undefined;
    expect(row?.user_id).toBe('user_1');
  });

  it('is idempotent: linking a row already owned by the SAME user is a no-op success', async () => {
    verifyAppleSignedJws.mockResolvedValue(activeTransaction());
    const env = await fakeEnv();
    await executeCommand(env, baseUser('user_1'), 'link_apple_entitlement', { signedTransaction: 'a.b.c' });
    const result = (await executeCommand(env, baseUser('user_1'), 'link_apple_entitlement', {
      signedTransaction: 'a.b.c',
    })) as { entitlement: { premium: boolean } };
    expect(result.entitlement.premium).toBe(true);
  });

  it('refuses (409) to claim a row already owned by a DIFFERENT account — never reassigns Premium', async () => {
    verifyAppleSignedJws.mockResolvedValue(activeTransaction());
    const env = await fakeEnv();
    await executeCommand(env, baseUser('user_1'), 'redeem_apple_purchase', { signedTransaction: 'a.b.c' });
    await expect(
      executeCommand(env, baseUser('user_2'), 'link_apple_entitlement', { signedTransaction: 'a.b.c' }),
    ).rejects.toThrow(/already linked/);
    const db = (env as Env & { __db: SqliteDatabase }).__db;
    const row = db
      .prepare('SELECT user_id FROM apple_subscriptions WHERE original_transaction_id = ?')
      .get('otxn-1') as { user_id: string | null } | undefined;
    expect(row?.user_id).toBe('user_1');
  });

  it('still chain-verifies the JWS — a forged/unverifiable transaction is rejected, not silently linked', async () => {
    verifyAppleSignedJws.mockRejectedValue(new AppleJwsVerificationError('invalid JWS signature'));
    const env = await fakeEnv();
    await expect(
      executeCommand(env, baseUser(), 'link_apple_entitlement', { signedTransaction: 'a.b.c' }),
    ).rejects.toThrow(ClientInputError);
  });

  it('links a Sandbox transaction by default', async () => {
    verifyAppleSignedJws.mockResolvedValue(activeTransaction({ environment: 'Sandbox' }));
    const env = await fakeEnv();
    const result = (await executeCommand(env, baseUser(), 'link_apple_entitlement', {
      signedTransaction: 'a.b.c',
    })) as { entitlement: { premium: boolean } };
    expect(result.entitlement.premium).toBe(true);
  });

  it('still rejects a Sandbox transaction when APPLE_ALLOW_SANDBOX is explicitly false', async () => {
    verifyAppleSignedJws.mockResolvedValue(activeTransaction({ environment: 'Sandbox' }));
    const env = await fakeEnv({ APPLE_ALLOW_SANDBOX: 'false' });
    await expect(
      executeCommand(env, baseUser(), 'link_apple_entitlement', { signedTransaction: 'a.b.c' }),
    ).rejects.toThrow(/Sandbox/);
  });
});

describe('executeCommand delete_account', () => {
  it('deletes the users row and owned PII', async () => {
    const env = await fakeEnv();
    const db = (env as Env & { __db: SqliteDatabase }).__db;
    db.exec(`
      INSERT INTO push_devices (id, user_id, platform, token, active, created_at, updated_at)
      VALUES ('dev_1', 'user_1', 'apns', '${'b'.repeat(64)}', 1, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
      INSERT INTO subscriptions (id, client_id, delivery, secret, filters, cursor, active, created_at)
      VALUES ('sub_1', 'user:user_1', 'sse', 'whsec_x', '{}', 0, 1, '2026-08-01T00:00:00Z');
    `);
    const result = (await executeCommand(env, baseUser(), 'delete_account', {}, { commandId: 'cmd_del' })) as {
      deleted: boolean;
      userId: string;
    };
    expect(result.deleted).toBe(true);
    expect(result.userId).toBe('user_1');
    expect(db.prepare('SELECT id FROM users WHERE id = ?').get('user_1')).toBeUndefined();
    expect(db.prepare('SELECT id FROM push_devices WHERE user_id = ?').get('user_1')).toBeUndefined();
    expect(db.prepare('SELECT id FROM subscriptions WHERE client_id = ?').get('user:user_1')).toBeUndefined();
  });
});
