/**
 * POST /api/client/v1/entitlements/apple/redeem — the anonymous half of
 * Apple In-App Purchase redemption (Guideline 5.1.1(v)). Apple's real
 * signing key is not available to tests, so (like commands.test.ts)
 * verifyAppleSignedJws is mocked and this file exercises everything AROUND
 * it: no-session-required, bundle id / product id / active-window checks,
 * ledger idempotency, the owner-mismatch conflict, and the minted device
 * entitlement token.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const verifyAppleSignedJws = vi.fn();
vi.mock('../../billing/appleJws', () => ({
  verifyAppleSignedJws: (...args: unknown[]) => verifyAppleSignedJws(...args),
  AppleJwsVerificationError: class AppleJwsVerificationError extends Error {},
}));

import { redeemAppleEntitlementAnonymously } from '../entitlements.ts';
import { verifyDeviceEntitlementToken } from '../../billing/deviceEntitlement.ts';
import type { Env } from '../../shared/types.ts';

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
    CREATE TABLE apple_subscriptions (
      original_transaction_id TEXT PRIMARY KEY, user_id TEXT, product_id TEXT NOT NULL,
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
    APPLE_DEVICE_ENTITLEMENT_SECRET: 'test-device-entitlement-secret',
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

function buildApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.post('/entitlements/apple/redeem', redeemAppleEntitlementAnonymously);
  return app;
}

const FUTURE_MS = Date.now() + 30 * 86_400_000;

function activeTransaction(overrides: Record<string, unknown> = {}) {
  return {
    transactionId: 'txn-1',
    originalTransactionId: 'otxn-anon-1',
    productId: 'trade.congress.premium.monthly',
    bundleId: 'trade.congress.ios',
    type: 'Auto-Renewable Subscription',
    environment: 'Production',
    expiresDate: FUTURE_MS,
    purchaseDate: Date.now(),
    ...overrides,
  };
}

async function post(app: ReturnType<typeof buildApp>, env: Env, body: Record<string, unknown>) {
  return app.request(
    'http://localhost/entitlements/apple/redeem',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    env,
  );
}

describe('POST /entitlements/apple/redeem — no session required', () => {
  beforeEach(() => {
    verifyAppleSignedJws.mockReset();
  });

  it('is refused when APPLE_IAP_ENABLED is not "true"', async () => {
    const env = await fakeEnv({ APPLE_IAP_ENABLED: 'false' });
    const res = await post(buildApp(), env, { signedTransaction: 'x.y.z' });
    expect(res.status).toBe(503);
    expect(verifyAppleSignedJws).not.toHaveBeenCalled();
  });

  it('requires signedTransaction', async () => {
    const env = await fakeEnv();
    const res = await post(buildApp(), env, {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/signedTransaction/);
  });

  it('rejects a transaction whose JWS chain does not verify (forged) — no ledger row is written', async () => {
    verifyAppleSignedJws.mockRejectedValue(new Error('signature verification failed'));
    const env = await fakeEnv();
    const res = await post(buildApp(), env, { signedTransaction: 'a.b.c' });
    expect(res.status).toBe(400);
    const row = env.__db.prepare('SELECT * FROM apple_subscriptions').get();
    expect(row).toBeUndefined();
  });

  it('grants a Sandbox transaction by default — ledger row + device token', async () => {
    verifyAppleSignedJws.mockResolvedValue(activeTransaction({ environment: 'Sandbox' }));
    const env = await fakeEnv();
    const res = await post(buildApp(), env, { signedTransaction: 'a.b.c' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entitlement: { premium: boolean };
      deviceEntitlementToken: string | null;
    };
    expect(body.entitlement.premium).toBe(true);
    expect(body.deviceEntitlementToken).toBeTruthy();
    const row = env.__db
      .prepare('SELECT environment FROM apple_subscriptions WHERE original_transaction_id = ?')
      .get('otxn-anon-1') as { environment: string | null };
    expect(row.environment).toBe('Sandbox');
  });

  it('rejects a Sandbox transaction when APPLE_ALLOW_SANDBOX is explicitly false — no ledger row, no token', async () => {
    verifyAppleSignedJws.mockResolvedValue(activeTransaction({ environment: 'Sandbox' }));
    const env = await fakeEnv({ APPLE_ALLOW_SANDBOX: 'false' });
    const res = await post(buildApp(), env, { signedTransaction: 'a.b.c' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/Sandbox/);
    expect(env.__db.prepare('SELECT * FROM apple_subscriptions').get()).toBeUndefined();
  });

  it('rejects a bundle id mismatch', async () => {
    verifyAppleSignedJws.mockResolvedValue(activeTransaction({ bundleId: 'com.other.app' }));
    const env = await fakeEnv();
    const res = await post(buildApp(), env, { signedTransaction: 'a.b.c' });
    expect(res.status).toBe(400);
  });

  it('rejects an expired transaction', async () => {
    verifyAppleSignedJws.mockResolvedValue(activeTransaction({ expiresDate: Date.now() - 1000 }));
    const env = await fakeEnv();
    const res = await post(buildApp(), env, { signedTransaction: 'a.b.c' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/active subscription/);
  });

  it('grants an anonymous entitlement, records a null-owner ledger row, and mints a device token', async () => {
    verifyAppleSignedJws.mockResolvedValue(activeTransaction());
    const env = await fakeEnv();
    const res = await post(buildApp(), env, { signedTransaction: 'a.b.c' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entitlement: { premium: boolean; source: string };
      deviceEntitlementToken: string | null;
      originalTransactionId: string;
    };
    expect(body.entitlement.premium).toBe(true);
    expect(body.entitlement.source).toBe('apple_anonymous');
    expect(body.originalTransactionId).toBe('otxn-anon-1');
    expect(body.deviceEntitlementToken).toBeTruthy();

    const row = env.__db
      .prepare('SELECT user_id, status FROM apple_subscriptions WHERE original_transaction_id = ?')
      .get('otxn-anon-1') as { user_id: string | null; status: string };
    expect(row.user_id).toBeNull();
    expect(row.status).toBe('active');

    const claim = await verifyDeviceEntitlementToken(env, body.deviceEntitlementToken!);
    expect(claim?.originalTransactionId).toBe('otxn-anon-1');
  });

  it('is idempotent: redeeming the same originalTransactionId again succeeds and mints a fresh token', async () => {
    verifyAppleSignedJws.mockResolvedValue(activeTransaction());
    const env = await fakeEnv();
    const app = buildApp();
    const first = await post(app, env, { signedTransaction: 'a.b.c' });
    const second = await post(app, env, { signedTransaction: 'a.b.c' });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const rows = env.__db.prepare('SELECT * FROM apple_subscriptions').all();
    expect(rows.length).toBe(1);
  });

  it('refuses (409) a transaction whose ledger row is already owned by a Congress.Trade account — no takeover', async () => {
    verifyAppleSignedJws.mockResolvedValue(activeTransaction());
    const env = await fakeEnv();
    env.__db.exec(`
      INSERT INTO apple_subscriptions (
        original_transaction_id, user_id, product_id, plan, status, created_at, updated_at
      ) VALUES (
        'otxn-anon-1', 'user_owner', 'trade.congress.premium.monthly', 'monthly', 'active',
        '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
      );
    `);
    const res = await post(buildApp(), env, { signedTransaction: 'a.b.c' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/already linked/);
    const row = env.__db
      .prepare('SELECT user_id FROM apple_subscriptions WHERE original_transaction_id = ?')
      .get('otxn-anon-1') as { user_id: string | null };
    expect(row.user_id).toBe('user_owner');
  });

  it('refuses to flip a webhook-revoked anonymous row back to active by replaying the original JWS', async () => {
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
        'otxn-anon-1', NULL, 'trade.congress.premium.monthly', 'monthly', 'revoked', 'txn-refund',
        '2026-01-15T00:00:00.000Z', '2026-01-01T00:00:00Z', '2026-01-15T00:00:00Z'
      );
    `);
    const res = await post(buildApp(), env, { signedTransaction: 'a.b.c' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/refunded or revoked/);
    const row = env.__db
      .prepare('SELECT status, revoked_at FROM apple_subscriptions WHERE original_transaction_id = ?')
      .get('otxn-anon-1') as { status: string; revoked_at: string | null };
    expect(row.status).toBe('revoked');
    expect(row.revoked_at).toBe('2026-01-15T00:00:00.000Z');
  });
});
