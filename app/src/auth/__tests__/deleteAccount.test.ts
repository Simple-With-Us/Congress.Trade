import { afterEach, describe, expect, it, vi } from 'vitest';
import { cancelStripeSubscriptionIfAny, deleteUserAccount } from '../deleteAccount.ts';
import { createSession, resolveSession } from '../session.ts';
import { clientIdForUser } from '../../client/utils.ts';
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
    CREATE TABLE user_preferences (
      user_id TEXT PRIMARY KEY, saved_filters TEXT, watchlist TEXT,
      notification_settings TEXT, default_window TEXT, updated_at TEXT
    );
    CREATE TABLE client_commands (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, type TEXT, status TEXT,
      idempotency_key TEXT, payload TEXT, result TEXT, error TEXT,
      created_at TEXT, updated_at TEXT
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
    CREATE TABLE apple_subscriptions (
      original_transaction_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, product_id TEXT NOT NULL,
      plan TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', environment TEXT,
      latest_transaction_id TEXT, purchase_date TEXT, expires_date TEXT,
      auto_renew_status INTEGER, auto_renew_product_id TEXT, revoked_at TEXT, revocation_reason INTEGER,
      last_notification_type TEXT, last_notification_subtype TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
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
        return { success: true, meta: { changes: Number(result.changes) } };
      },
      async all<T>() {
        return { results: db.prepare(sql).all(...params) as T[] };
      },
    };
    return statement;
  };
  return { prepare } as unknown as Env['DB'];
}

function kvNamespace() {
  const kv = new Map<string, string>();
  return {
    kv,
    ns: {
      get: async (k: string) => (kv.has(k) ? kv.get(k)! : null),
      put: async (k: string, v: string) => {
        kv.set(k, v);
      },
      delete: async (k: string) => {
        kv.delete(k);
      },
    },
  };
}

function userRow(id = 'user_1'): User {
  return {
    id,
    email: `${id}@example.com`,
    name: 'Test User',
    picture: 'https://example.com/a.png',
    googleSub: `g-${id}`,
    appleSub: `a-${id}`,
    emailVerified: true,
    createdAt: '2026-01-01T00:00:00Z',
    lastLoginAt: '2026-08-01T00:00:00Z',
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    subscriptionStatus: null,
    plan: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    trialEnd: null,
  };
}

async function seededEnv(user: User = userRow()) {
  const db = await freshDb();
  const { ns: CONFIG_KV } = kvNamespace();
  db.exec(`
    INSERT INTO users (id, email, name, picture, google_sub, apple_sub, email_verified, created_at, last_login_at)
    VALUES ('${user.id}', '${user.email}', '${user.name}', '${user.picture}', '${user.googleSub}', '${user.appleSub}', 1, '${user.createdAt}', '${user.lastLoginAt}');
    INSERT INTO user_preferences (user_id, saved_filters, watchlist, notification_settings, default_window, updated_at)
    VALUES ('${user.id}', '{}', '["AAPL"]', '{}', '1y', '2026-08-01T00:00:00Z');
    INSERT INTO push_devices (id, user_id, platform, token, app_bundle, env, active, created_at, updated_at)
    VALUES ('dev_1', '${user.id}', 'apns', '${'a'.repeat(64)}', 'trade.congress.ios', 'production', 1, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
    INSERT INTO subscriptions (id, client_id, delivery, target_url, secret, filters, cursor, active, created_at)
    VALUES ('sub_1', 'user:${user.id}', 'webhook', 'https://example.com/hook', 'whsec_x', '{}', 0, 1, '2026-08-01T00:00:00Z');
    INSERT INTO sse_leases (id, subscription_id, client_id, expires_at, created_at)
    VALUES ('lease_1', 'sub_1', 'user:${user.id}', '2026-09-01T00:00:00Z', '2026-08-01T00:00:00Z');
    INSERT INTO apple_subscriptions (original_transaction_id, user_id, product_id, plan, status, created_at, updated_at)
    VALUES ('otxn_1', '${user.id}', 'trade.congress.premium.monthly', 'monthly', 'active', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
    INSERT INTO client_commands (id, user_id, type, status, payload, created_at, updated_at)
    VALUES ('cmd_old', '${user.id}', 'update_preferences', 'succeeded', '{}', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
    INSERT INTO client_commands (id, user_id, type, status, payload, created_at, updated_at)
    VALUES ('cmd_delete', '${user.id}', 'delete_account', 'running', '{}', '2026-08-19T00:00:00Z', '2026-08-19T00:00:00Z');
  `);
  const env = { DB: d1Database(db), CONFIG_KV } as unknown as Env;
  return { env, db };
}

describe('deleteUserAccount', () => {
  it('deletes the user row and owned PII, keeping the in-flight command', async () => {
    const user = userRow();
    const { env, db } = await seededEnv(user);
    const token = await createSession(env, user.id);
    expect(await resolveSession(env, token)).toMatchObject({ id: user.id });

    const result = await deleteUserAccount(env, user, { keepCommandId: 'cmd_delete' });
    expect(result.deleted).toBe(true);
    expect(result.userId).toBe(user.id);
    expect(result.detached.subscriptions).toBe(1);
    expect(result.detached.pushDevices).toBe(1);
    expect(result.detached.preferences).toBe(true);
    expect(result.detached.appleSubscriptions).toBe(1);
    expect(result.detached.commands).toBe(1);
    expect(result.detached.sessions).toBe(1);
    expect(result.detached.stripe).toBe('skipped');

    expect(db.prepare('SELECT id FROM users WHERE id = ?').get(user.id)).toBeUndefined();
    expect(db.prepare('SELECT id FROM push_devices WHERE user_id = ?').get(user.id)).toBeUndefined();
    expect(db.prepare('SELECT user_id FROM user_preferences WHERE user_id = ?').get(user.id)).toBeUndefined();
    expect(db.prepare('SELECT original_transaction_id FROM apple_subscriptions WHERE user_id = ?').get(user.id)).toBeUndefined();
    expect(db.prepare('SELECT id FROM subscriptions WHERE client_id = ?').get(clientIdForUser(user))).toBeUndefined();
    expect(db.prepare('SELECT id FROM sse_leases WHERE subscription_id = ?').get('sub_1')).toBeUndefined();
    expect(db.prepare('SELECT id FROM client_commands WHERE id = ?').get('cmd_old')).toBeUndefined();
    expect(db.prepare('SELECT id FROM client_commands WHERE id = ?').get('cmd_delete')?.id).toBe('cmd_delete');
    expect(await resolveSession(env, token)).toBeNull();
  });

  it('is idempotent when the user row is already gone', async () => {
    const user = userRow();
    const { env, db } = await seededEnv(user);
    db.exec(`DELETE FROM users WHERE id = '${user.id}'`);
    const result = await deleteUserAccount(env, user);
    expect(result.deleted).toBe(true);
    expect(result.userId).toBe(user.id);
  });
});

describe('cancelStripeSubscriptionIfAny', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('skips when there is no Stripe subscription', async () => {
    expect(await cancelStripeSubscriptionIfAny({} as Env, null)).toBe('skipped');
  });

  it('cancels immediately without a refund when Stripe answers', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const status = await cancelStripeSubscriptionIfAny(
      { STRIPE_SECRET_KEY: 'sk_test' } as Env,
      'sub_abc',
    );
    expect(status).toBe('canceled');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.stripe.com/v1/subscriptions/sub_abc');
    expect(init.method).toBe('DELETE');
  });

  it('records a failed detach when Stripe errors, without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    expect(
      await cancelStripeSubscriptionIfAny({ STRIPE_SECRET_KEY: 'sk_test' } as Env, 'sub_abc'),
    ).toBe('failed');
  });
});
