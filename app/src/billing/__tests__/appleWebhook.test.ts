// Apple's real signing key is not available to tests, so JWS chain
// verification itself is unit-tested separately (appleJws.test.ts) — this
// file mocks verifyAppleSignedJws (keyed by the literal JWS string passed in)
// to exercise the webhook route's notification handling, idempotency, and
// ledger update logic end to end against a real in-memory apple_subscriptions
// table.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const payloadsByJws = new Map<string, unknown>();
const throwOnJws = new Map<string, Error>();
const verifyAppleSignedJws = vi.fn(async (jws: string) => {
  if (throwOnJws.has(jws)) throw throwOnJws.get(jws);
  if (payloadsByJws.has(jws)) return payloadsByJws.get(jws);
  throw new Error(`unexpected jws in test: ${jws}`);
});
vi.mock('../appleJws', () => ({
  verifyAppleSignedJws: (jws: string) => verifyAppleSignedJws(jws),
  AppleJwsVerificationError: class AppleJwsVerificationError extends Error {},
}));

import { buildAppleWebhookRouter } from '../appleWebhook.ts';
import { AppleJwsVerificationError } from '../appleJws.ts';
import { clientRedeemWouldResurrectRevoked, getAppleSubscription, upsertAppleSubscription } from '../appleSubscriptions.ts';
import type { Env } from '../../shared/types.ts';

interface SqliteRunResult {
  changes: number | bigint;
}
interface SqliteStatement {
  get(...params: unknown[]): Record<string, unknown> | undefined;
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
    CREATE TABLE apple_webhook_events (
      event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, received_at TEXT NOT NULL,
      processed_at TEXT, claim_token TEXT, claim_expires_at TEXT
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
        return { results: [] as T[] };
      },
    };
    return statement;
  };
  return { prepare } as unknown as Env['DB'];
}

async function fakeEnv(overrides: Record<string, unknown> = {}): Promise<{ env: Env; db: SqliteDatabase }> {
  const db = await freshDb();
  const env = { DB: d1Database(db), APPLE_IAP_ENABLED: 'true', ...overrides } as unknown as Env;
  return { env, db };
}

function txPayload(over: Record<string, unknown> = {}) {
  return {
    transactionId: 'txn-2',
    originalTransactionId: 'otxn-1',
    productId: 'trade.congress.premium.monthly',
    bundleId: 'trade.congress.ios',
    environment: 'Production',
    expiresDate: Date.now() + 30 * 86_400_000,
    purchaseDate: Date.now(),
    ...over,
  };
}

function notificationPayload(over: Record<string, unknown> = {}) {
  return {
    notificationType: 'DID_RENEW',
    notificationUUID: 'notif-1',
    data: { bundleId: 'trade.congress.ios', environment: 'Production', signedTransactionInfo: 'txn-jws' },
    ...over,
  };
}

async function seedLedgerRow(env: Env) {
  await upsertAppleSubscription(env, {
    originalTransactionId: 'otxn-1',
    userId: 'user_1',
    productId: 'trade.congress.premium.monthly',
    plan: 'monthly',
    status: 'active',
    expiresDate: new Date(Date.now() - 1000).toISOString(), // about to be renewed
  });
}

async function post(app: ReturnType<typeof buildAppleWebhookRouter>, env: Env, signedPayload: string) {
  return app.request(
    'http://localhost/apple',
    { method: 'POST', body: JSON.stringify({ signedPayload }), headers: { 'content-type': 'application/json' } },
    env,
  );
}

describe('POST /api/webhooks/apple', () => {
  beforeEach(() => {
    payloadsByJws.clear();
    throwOnJws.clear();
    verifyAppleSignedJws.mockClear();
  });

  it('is refused (503) when APPLE_IAP_ENABLED is not "true"', async () => {
    const { env } = await fakeEnv({ APPLE_IAP_ENABLED: 'false' });
    const res = await post(buildAppleWebhookRouter(), env, 'outer-jws');
    expect(res.status).toBe(503);
    expect(verifyAppleSignedJws).not.toHaveBeenCalled();
  });

  it('requires signedPayload', async () => {
    const { env } = await fakeEnv();
    const res = await buildAppleWebhookRouter().request(
      'http://localhost/apple',
      { method: 'POST', body: JSON.stringify({}), headers: { 'content-type': 'application/json' } },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 on an invalid outer JWS', async () => {
    throwOnJws.set('bad-jws', new AppleJwsVerificationError('invalid JWS signature'));
    const { env } = await fakeEnv();
    const res = await post(buildAppleWebhookRouter(), env, 'bad-jws');
    expect(res.status).toBe(400);
  });

  it('requires notificationUUID', async () => {
    payloadsByJws.set('outer-jws', notificationPayload({ notificationUUID: undefined }));
    const { env } = await fakeEnv();
    const res = await post(buildAppleWebhookRouter(), env, 'outer-jws');
    expect(res.status).toBe(400);
  });

  it('is idempotent on notificationUUID: a duplicate redelivery does not re-apply', async () => {
    payloadsByJws.set('outer-jws', notificationPayload());
    payloadsByJws.set('txn-jws', txPayload());
    const { env } = await fakeEnv();
    await seedLedgerRow(env);

    const app = buildAppleWebhookRouter();
    const first = await post(app, env, 'outer-jws');
    expect(first.status).toBe(200);
    expect((await first.json()) as { duplicate?: boolean }).not.toHaveProperty('duplicate', true);

    const second = await post(app, env, 'outer-jws');
    expect(second.status).toBe(200);
    expect((await second.json()) as { duplicate?: boolean }).toMatchObject({ duplicate: true });

    // Applied exactly once: only ONE call decoded the nested transaction JWS.
    expect(verifyAppleSignedJws.mock.calls.filter((c) => c[0] === 'txn-jws')).toHaveLength(1);
  });

  it('DID_RENEW updates an existing ledger row to active with the new expiry', async () => {
    const newExpiry = Date.now() + 60 * 86_400_000;
    payloadsByJws.set('outer-jws', notificationPayload());
    payloadsByJws.set('txn-jws', txPayload({ expiresDate: newExpiry }));
    const { env } = await fakeEnv();
    await seedLedgerRow(env);

    const res = await post(buildAppleWebhookRouter(), env, 'outer-jws');
    expect(res.status).toBe(200);

    const row = await getAppleSubscription(env, 'otxn-1');
    expect(row?.status).toBe('active');
    expect(row?.expiresDate).toBe(new Date(newExpiry).toISOString());
    expect(row?.lastNotificationType).toBe('DID_RENEW');
  });

  it('EXPIRED marks the ledger row expired', async () => {
    payloadsByJws.set('outer-jws', notificationPayload({ notificationType: 'EXPIRED', notificationUUID: 'notif-2' }));
    payloadsByJws.set('txn-jws', txPayload());
    const { env } = await fakeEnv();
    await seedLedgerRow(env);

    await post(buildAppleWebhookRouter(), env, 'outer-jws');
    const row = await getAppleSubscription(env, 'otxn-1');
    expect(row?.status).toBe('expired');
  });

  it('REFUND marks the ledger row revoked like REVOKE', async () => {
    payloadsByJws.set('outer-jws', notificationPayload({ notificationType: 'REFUND', notificationUUID: 'notif-refund' }));
    payloadsByJws.set('txn-jws', txPayload({ revocationReason: 1 }));
    const { env } = await fakeEnv();
    await seedLedgerRow(env);

    await post(buildAppleWebhookRouter(), env, 'outer-jws');
    const row = await getAppleSubscription(env, 'otxn-1');
    expect(row?.status).toBe('revoked');
    expect(row?.revokedAt).not.toBeNull();
    expect(row?.lastNotificationType).toBe('REFUND');
  });

  it('applies a Sandbox DID_RENEW by default (TestFlight / Mac / App Review)', async () => {
    payloadsByJws.set(
      'outer-jws',
      notificationPayload({
        notificationType: 'DID_RENEW',
        notificationUUID: 'notif-sandbox',
        data: { bundleId: 'trade.congress.ios', environment: 'Sandbox', signedTransactionInfo: 'txn-jws' },
      }),
    );
    payloadsByJws.set('txn-jws', txPayload({ environment: 'Sandbox', expiresDate: Date.now() + 30 * 86_400_000 }));
    const { env } = await fakeEnv();
    await seedLedgerRow(env);

    const res = await post(buildAppleWebhookRouter(), env, 'outer-jws');
    expect(res.status).toBe(200);
    const row = await getAppleSubscription(env, 'otxn-1');
    expect(row?.lastNotificationType).toBe('DID_RENEW');
    expect(row?.status).toBe('active');
  });

  it('does not apply a Sandbox DID_RENEW when APPLE_ALLOW_SANDBOX is explicitly false', async () => {
    payloadsByJws.set(
      'outer-jws',
      notificationPayload({
        notificationType: 'DID_RENEW',
        notificationUUID: 'notif-sandbox-off',
        data: { bundleId: 'trade.congress.ios', environment: 'Sandbox', signedTransactionInfo: 'txn-jws' },
      }),
    );
    payloadsByJws.set('txn-jws', txPayload({ environment: 'Sandbox', expiresDate: Date.now() + 30 * 86_400_000 }));
    const { env } = await fakeEnv({ APPLE_ALLOW_SANDBOX: 'false' });
    await seedLedgerRow(env);

    const res = await post(buildAppleWebhookRouter(), env, 'outer-jws');
    expect(res.status).toBe(200);
    const row = await getAppleSubscription(env, 'otxn-1');
    expect(row?.lastNotificationType).toBeNull();
    expect(row?.status).toBe('active');
  });

  it('applies a Sandbox REFUND so leaked Premium is revoked', async () => {
    payloadsByJws.set(
      'outer-jws',
      notificationPayload({
        notificationType: 'REFUND',
        notificationUUID: 'notif-sandbox-refund',
        data: { bundleId: 'trade.congress.ios', environment: 'Sandbox', signedTransactionInfo: 'txn-jws' },
      }),
    );
    payloadsByJws.set('txn-jws', txPayload({ environment: 'Sandbox', revocationReason: 0 }));
    const { env } = await fakeEnv();
    await seedLedgerRow(env);

    await post(buildAppleWebhookRouter(), env, 'outer-jws');
    const row = await getAppleSubscription(env, 'otxn-1');
    expect(row?.status).toBe('revoked');
  });

  it('REVOKE marks the ledger row revoked with revokedAt set', async () => {
    payloadsByJws.set('outer-jws', notificationPayload({ notificationType: 'REVOKE', notificationUUID: 'notif-3' }));
    payloadsByJws.set('txn-jws', txPayload({ revocationReason: 1 }));
    const { env } = await fakeEnv();
    await seedLedgerRow(env);

    await post(buildAppleWebhookRouter(), env, 'outer-jws');
    const row = await getAppleSubscription(env, 'otxn-1');
    expect(row?.status).toBe('revoked');
    expect(row?.revokedAt).not.toBeNull();
    expect(row?.revocationReason).toBe(1);
  });

  it('DID_CHANGE_RENEWAL_STATUS updates auto-renew fields without changing entitlement status', async () => {
    payloadsByJws.set(
      'outer-jws',
      notificationPayload({
        notificationType: 'DID_CHANGE_RENEWAL_STATUS',
        notificationUUID: 'notif-4',
        subtype: 'AUTO_RENEW_DISABLED',
        data: {
          bundleId: 'trade.congress.ios',
          environment: 'Production',
          signedTransactionInfo: 'txn-jws',
          signedRenewalInfo: 'renewal-jws',
        },
      }),
    );
    payloadsByJws.set('txn-jws', txPayload({ expiresDate: Date.now() + 10 * 86_400_000 }));
    payloadsByJws.set('renewal-jws', { originalTransactionId: 'otxn-1', autoRenewStatus: 0, autoRenewProductId: null });
    const { env } = await fakeEnv();
    await seedLedgerRow(env);

    await post(buildAppleWebhookRouter(), env, 'outer-jws');
    const row = await getAppleSubscription(env, 'otxn-1');
    expect(row?.status).toBe('active'); // unchanged from the seeded row's status
    expect(row?.autoRenewStatus).toBe(false);
  });

  it('a notification for an unknown originalTransactionId (no redeem yet) is acknowledged but does not create a row', async () => {
    payloadsByJws.set('outer-jws', notificationPayload({ notificationUUID: 'notif-5' }));
    payloadsByJws.set('txn-jws', txPayload({ originalTransactionId: 'otxn-never-redeemed' }));
    const { env } = await fakeEnv();

    const res = await post(buildAppleWebhookRouter(), env, 'outer-jws');
    expect(res.status).toBe(200);
    expect(await getAppleSubscription(env, 'otxn-never-redeemed')).toBeNull();
  });

  it('REFUND before first redeem writes a revoked tombstone so a later original-JWS replay cannot mint Premium', async () => {
    payloadsByJws.set(
      'outer-jws',
      notificationPayload({ notificationType: 'REFUND', notificationUUID: 'notif-refund-first' }),
    );
    payloadsByJws.set(
      'txn-jws',
      txPayload({ originalTransactionId: 'otxn-never-redeemed', revocationReason: 1 }),
    );
    const { env } = await fakeEnv();

    const res = await post(buildAppleWebhookRouter(), env, 'outer-jws');
    expect(res.status).toBe(200);
    const row = await getAppleSubscription(env, 'otxn-never-redeemed');
    expect(row?.status).toBe('revoked');
    expect(row?.userId).toBeNull();
    expect(row?.revokedAt).not.toBeNull();
    expect(
      clientRedeemWouldResurrectRevoked(row, {
        transactionId: 'txn-original-cached',
        purchaseDateMs: Date.now() - 60_000,
      }),
    ).toBe(true);
  });

  it('REVOKE before first redeem writes a revoked tombstone', async () => {
    payloadsByJws.set(
      'outer-jws',
      notificationPayload({ notificationType: 'REVOKE', notificationUUID: 'notif-revoke-first' }),
    );
    payloadsByJws.set('txn-jws', txPayload({ originalTransactionId: 'otxn-never-redeemed', revocationReason: 0 }));
    const { env } = await fakeEnv();

    const res = await post(buildAppleWebhookRouter(), env, 'outer-jws');
    expect(res.status).toBe(200);
    const row = await getAppleSubscription(env, 'otxn-never-redeemed');
    expect(row?.status).toBe('revoked');
    expect(row?.userId).toBeNull();
    expect(row?.revokedAt).not.toBeNull();
  });

  it('DID_FAIL_TO_RENEW with a future gracePeriodExpiresDate keeps Premium (grace_period)', async () => {
    const graceEnds = Date.now() + 3 * 86_400_000;
    payloadsByJws.set(
      'outer-jws',
      notificationPayload({
        notificationType: 'DID_FAIL_TO_RENEW',
        subtype: 'GRACE_PERIOD',
        notificationUUID: 'notif-grace-1',
        data: {
          bundleId: 'trade.congress.ios',
          environment: 'Production',
          signedTransactionInfo: 'txn-jws',
          signedRenewalInfo: 'renewal-jws',
        },
      }),
    );
    payloadsByJws.set('txn-jws', txPayload({ expiresDate: Date.now() - 1000 }));
    payloadsByJws.set('renewal-jws', {
      originalTransactionId: 'otxn-1',
      autoRenewStatus: 1,
      gracePeriodExpiresDate: graceEnds,
      isInBillingRetryPeriod: true,
    });
    const { env } = await fakeEnv();
    await seedLedgerRow(env);

    const res = await post(buildAppleWebhookRouter(), env, 'outer-jws');
    expect(res.status).toBe(200);
    const row = await getAppleSubscription(env, 'otxn-1');
    expect(row?.status).toBe('grace_period');
    expect(row?.expiresDate).toBe(new Date(graceEnds).toISOString());
    expect(row?.lastNotificationType).toBe('DID_FAIL_TO_RENEW');
  });

  it('DID_FAIL_TO_RENEW without grace (paid retry only) marks billing_retry', async () => {
    payloadsByJws.set(
      'outer-jws',
      notificationPayload({
        notificationType: 'DID_FAIL_TO_RENEW',
        notificationUUID: 'notif-retry-1',
        data: {
          bundleId: 'trade.congress.ios',
          environment: 'Production',
          signedTransactionInfo: 'txn-jws',
          signedRenewalInfo: 'renewal-jws',
        },
      }),
    );
    payloadsByJws.set('txn-jws', txPayload());
    payloadsByJws.set('renewal-jws', {
      originalTransactionId: 'otxn-1',
      autoRenewStatus: 1,
      isInBillingRetryPeriod: true,
    });
    const { env } = await fakeEnv();
    await seedLedgerRow(env);

    await post(buildAppleWebhookRouter(), env, 'outer-jws');
    const row = await getAppleSubscription(env, 'otxn-1');
    expect(row?.status).toBe('billing_retry');
  });

  it('GRACE_PERIOD_EXPIRED drops Premium (expired, or billing_retry if Apple is still retrying)', async () => {
    payloadsByJws.set(
      'outer-jws',
      notificationPayload({
        notificationType: 'GRACE_PERIOD_EXPIRED',
        notificationUUID: 'notif-grace-end',
        data: {
          bundleId: 'trade.congress.ios',
          environment: 'Production',
          signedTransactionInfo: 'txn-jws',
          signedRenewalInfo: 'renewal-jws',
        },
      }),
    );
    payloadsByJws.set('txn-jws', txPayload({ expiresDate: Date.now() - 1000 }));
    payloadsByJws.set('renewal-jws', {
      originalTransactionId: 'otxn-1',
      autoRenewStatus: 1,
      isInBillingRetryPeriod: true,
    });
    const { env } = await fakeEnv();
    await seedLedgerRow(env);

    await post(buildAppleWebhookRouter(), env, 'outer-jws');
    const row = await getAppleSubscription(env, 'otxn-1');
    expect(row?.status).toBe('billing_retry');
  });

  it('a bundleId mismatch is ignored (acknowledged, ledger untouched)', async () => {
    payloadsByJws.set('outer-jws', notificationPayload({ notificationUUID: 'notif-6' }));
    payloadsByJws.set('txn-jws', txPayload({ bundleId: 'com.other.app' }));
    const { env } = await fakeEnv();
    await seedLedgerRow(env);

    const res = await post(buildAppleWebhookRouter(), env, 'outer-jws');
    expect(res.status).toBe(200);
    const row = await getAppleSubscription(env, 'otxn-1');
    expect(row?.lastNotificationType).toBeNull(); // untouched by the mismatched event
  });

  it('DID_RENEW after REFUND does not resurrect Premium when the transaction predates revokedAt', async () => {
    const renewalPurchaseMs = Date.now() - 60_000;
    const { env } = await fakeEnv();
    await upsertAppleSubscription(env, {
      originalTransactionId: 'otxn-1',
      userId: 'user_1',
      productId: 'trade.congress.premium.monthly',
      plan: 'monthly',
      status: 'active',
      latestTransactionId: 'txn-renew',
      purchaseDate: new Date(renewalPurchaseMs).toISOString(),
      expiresDate: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });

    payloadsByJws.set(
      'refund-jws',
      notificationPayload({ notificationType: 'REFUND', notificationUUID: 'notif-refund-then-renew' }),
    );
    payloadsByJws.set('txn-jws', txPayload({ transactionId: 'txn-refund', revocationReason: 1 }));
    await post(buildAppleWebhookRouter(), env, 'refund-jws');
    expect((await getAppleSubscription(env, 'otxn-1'))?.status).toBe('revoked');

    payloadsByJws.set(
      'renew-jws',
      notificationPayload({ notificationType: 'DID_RENEW', notificationUUID: 'notif-stale-renew' }),
    );
    payloadsByJws.set(
      'txn-jws',
      txPayload({
        transactionId: 'txn-renew',
        purchaseDate: renewalPurchaseMs,
        expiresDate: Date.now() + 30 * 86_400_000,
      }),
    );
    const res = await post(buildAppleWebhookRouter(), env, 'renew-jws');
    expect(res.status).toBe(200);
    const row = await getAppleSubscription(env, 'otxn-1');
    expect(row?.status).toBe('revoked');
    expect(row?.revokedAt).not.toBeNull();
    expect(row?.lastNotificationType).toBe('REFUND');
  });

  it('DID_RENEW after REFUND still restores when Apple sends a later purchase (resubscribe)', async () => {
    const { env } = await fakeEnv();
    await seedLedgerRow(env);
    payloadsByJws.set(
      'refund-jws',
      notificationPayload({ notificationType: 'REFUND', notificationUUID: 'notif-refund-resub' }),
    );
    payloadsByJws.set('txn-jws', txPayload({ transactionId: 'txn-old', revocationReason: 1 }));
    await post(buildAppleWebhookRouter(), env, 'refund-jws');
    const revoked = await getAppleSubscription(env, 'otxn-1');
    expect(revoked?.status).toBe('revoked');
    const revokedMs = revoked?.revokedAt ? Date.parse(revoked.revokedAt) : 0;

    payloadsByJws.set(
      'resub-jws',
      notificationPayload({ notificationType: 'DID_RENEW', notificationUUID: 'notif-real-resub' }),
    );
    payloadsByJws.set(
      'txn-jws',
      txPayload({
        transactionId: 'txn-resub',
        purchaseDate: revokedMs + 60_000,
        expiresDate: Date.now() + 30 * 86_400_000,
      }),
    );
    const res = await post(buildAppleWebhookRouter(), env, 'resub-jws');
    expect(res.status).toBe(200);
    const row = await getAppleSubscription(env, 'otxn-1');
    expect(row?.status).toBe('active');
    expect(row?.revokedAt).toBeNull();
    expect(row?.latestTransactionId).toBe('txn-resub');
  });

  it('DID_FAIL_TO_RENEW grace_period does not resurrect a revoked row', async () => {
    const { env } = await fakeEnv();
    await seedLedgerRow(env);
    payloadsByJws.set(
      'refund-jws',
      notificationPayload({ notificationType: 'REFUND', notificationUUID: 'notif-refund-grace' }),
    );
    payloadsByJws.set('txn-jws', txPayload({ transactionId: 'txn-old', revocationReason: 1 }));
    await post(buildAppleWebhookRouter(), env, 'refund-jws');

    payloadsByJws.set(
      'grace-jws',
      notificationPayload({
        notificationType: 'DID_FAIL_TO_RENEW',
        subtype: 'GRACE_PERIOD',
        notificationUUID: 'notif-stale-grace',
        data: {
          bundleId: 'trade.congress.ios',
          environment: 'Production',
          signedTransactionInfo: 'txn-jws',
          signedRenewalInfo: 'renewal-jws',
        },
      }),
    );
    payloadsByJws.set(
      'txn-jws',
      txPayload({
        transactionId: 'txn-old',
        purchaseDate: Date.now() - 60_000,
        expiresDate: Date.now() - 1000,
      }),
    );
    payloadsByJws.set('renewal-jws', {
      originalTransactionId: 'otxn-1',
      autoRenewStatus: 1,
      gracePeriodExpiresDate: Date.now() + 3 * 86_400_000,
      isInBillingRetryPeriod: true,
    });
    await post(buildAppleWebhookRouter(), env, 'grace-jws');
    const row = await getAppleSubscription(env, 'otxn-1');
    expect(row?.status).toBe('revoked');
    expect(row?.lastNotificationType).toBe('REFUND');
  });

  it('EXPIRED after REFUND does not drop status off revoked (original JWS would otherwise redeem)', async () => {
    const { env } = await fakeEnv();
    await seedLedgerRow(env);
    payloadsByJws.set(
      'refund-jws',
      notificationPayload({ notificationType: 'REFUND', notificationUUID: 'notif-refund-then-expired' }),
    );
    payloadsByJws.set('txn-jws', txPayload({ transactionId: 'txn-old', revocationReason: 1 }));
    await post(buildAppleWebhookRouter(), env, 'refund-jws');

    payloadsByJws.set(
      'expired-jws',
      notificationPayload({ notificationType: 'EXPIRED', notificationUUID: 'notif-stale-expired' }),
    );
    payloadsByJws.set(
      'txn-jws',
      txPayload({
        transactionId: 'txn-old',
        purchaseDate: Date.now() - 60_000,
        expiresDate: Date.now() - 1000,
      }),
    );
    const res = await post(buildAppleWebhookRouter(), env, 'expired-jws');
    expect(res.status).toBe(200);
    const row = await getAppleSubscription(env, 'otxn-1');
    expect(row?.status).toBe('revoked');
    expect(row?.revokedAt).not.toBeNull();
    expect(row?.lastNotificationType).toBe('REFUND');
    expect(
      clientRedeemWouldResurrectRevoked(row, {
        transactionId: 'txn-old',
        purchaseDateMs: Date.now() - 60_000,
      }),
    ).toBe(true);
  });

  it('DID_FAIL_TO_RENEW billing_retry after REFUND does not drop status off revoked', async () => {
    const { env } = await fakeEnv();
    await seedLedgerRow(env);
    payloadsByJws.set(
      'refund-jws',
      notificationPayload({ notificationType: 'REFUND', notificationUUID: 'notif-refund-then-retry' }),
    );
    payloadsByJws.set('txn-jws', txPayload({ transactionId: 'txn-old', revocationReason: 1 }));
    await post(buildAppleWebhookRouter(), env, 'refund-jws');

    payloadsByJws.set(
      'retry-jws',
      notificationPayload({
        notificationType: 'DID_FAIL_TO_RENEW',
        notificationUUID: 'notif-stale-retry',
        data: {
          bundleId: 'trade.congress.ios',
          environment: 'Production',
          signedTransactionInfo: 'txn-jws',
          signedRenewalInfo: 'renewal-jws',
        },
      }),
    );
    payloadsByJws.set(
      'txn-jws',
      txPayload({
        transactionId: 'txn-old',
        purchaseDate: Date.now() - 60_000,
        expiresDate: Date.now() - 1000,
      }),
    );
    payloadsByJws.set('renewal-jws', {
      originalTransactionId: 'otxn-1',
      autoRenewStatus: 1,
      isInBillingRetryPeriod: true,
    });
    await post(buildAppleWebhookRouter(), env, 'retry-jws');
    const row = await getAppleSubscription(env, 'otxn-1');
    expect(row?.status).toBe('revoked');
    expect(row?.revokedAt).not.toBeNull();
    expect(row?.lastNotificationType).toBe('REFUND');
  });

  it('GRACE_PERIOD_EXPIRED after REFUND does not drop status off revoked', async () => {
    const { env } = await fakeEnv();
    await seedLedgerRow(env);
    payloadsByJws.set(
      'refund-jws',
      notificationPayload({ notificationType: 'REFUND', notificationUUID: 'notif-refund-then-grace-end' }),
    );
    payloadsByJws.set('txn-jws', txPayload({ transactionId: 'txn-old', revocationReason: 1 }));
    await post(buildAppleWebhookRouter(), env, 'refund-jws');

    payloadsByJws.set(
      'grace-end-jws',
      notificationPayload({
        notificationType: 'GRACE_PERIOD_EXPIRED',
        notificationUUID: 'notif-stale-grace-end',
        data: {
          bundleId: 'trade.congress.ios',
          environment: 'Production',
          signedTransactionInfo: 'txn-jws',
          signedRenewalInfo: 'renewal-jws',
        },
      }),
    );
    payloadsByJws.set(
      'txn-jws',
      txPayload({
        transactionId: 'txn-old',
        purchaseDate: Date.now() - 60_000,
        expiresDate: Date.now() - 1000,
      }),
    );
    payloadsByJws.set('renewal-jws', {
      originalTransactionId: 'otxn-1',
      autoRenewStatus: 1,
      isInBillingRetryPeriod: true,
    });
    await post(buildAppleWebhookRouter(), env, 'grace-end-jws');
    const row = await getAppleSubscription(env, 'otxn-1');
    expect(row?.status).toBe('revoked');
    expect(row?.revokedAt).not.toBeNull();
    expect(row?.lastNotificationType).toBe('REFUND');
  });

  it('DID_CHANGE_RENEWAL_STATUS after REFUND keeps revokedAt so a later resubscribe can restore', async () => {
    const { env } = await fakeEnv();
    await seedLedgerRow(env);
    payloadsByJws.set(
      'refund-jws',
      notificationPayload({ notificationType: 'REFUND', notificationUUID: 'notif-refund-then-renewal-status' }),
    );
    payloadsByJws.set('txn-jws', txPayload({ transactionId: 'txn-old', revocationReason: 1 }));
    await post(buildAppleWebhookRouter(), env, 'refund-jws');
    const revoked = await getAppleSubscription(env, 'otxn-1');
    expect(revoked?.status).toBe('revoked');
    const revokedAt = revoked?.revokedAt ?? '';
    expect(revokedAt.length).toBeGreaterThan(0);

    payloadsByJws.set(
      'renewal-status-jws',
      notificationPayload({
        notificationType: 'DID_CHANGE_RENEWAL_STATUS',
        subtype: 'AUTO_RENEW_DISABLED',
        notificationUUID: 'notif-stale-renewal-status',
        data: {
          bundleId: 'trade.congress.ios',
          environment: 'Production',
          signedTransactionInfo: 'txn-jws',
          signedRenewalInfo: 'renewal-jws',
        },
      }),
    );
    payloadsByJws.set(
      'txn-jws',
      txPayload({
        transactionId: 'txn-old',
        purchaseDate: Date.now() - 60_000,
        expiresDate: Date.now() + 10 * 86_400_000,
      }),
    );
    payloadsByJws.set('renewal-jws', {
      originalTransactionId: 'otxn-1',
      autoRenewStatus: 0,
      autoRenewProductId: null,
    });
    await post(buildAppleWebhookRouter(), env, 'renewal-status-jws');
    const row = await getAppleSubscription(env, 'otxn-1');
    expect(row?.status).toBe('revoked');
    expect(row?.revokedAt).toBe(revokedAt);
    expect(row?.lastNotificationType).toBe('REFUND');
    expect(
      clientRedeemWouldResurrectRevoked(row, {
        transactionId: 'txn-resub',
        purchaseDateMs: Date.parse(revokedAt) + 60_000,
      }),
    ).toBe(false);
  });

  it('DID_CHANGE_RENEWAL_STATUS after REFUND with a later purchase still keeps revokedAt and the old transaction id', async () => {
    const { env } = await fakeEnv();
    await seedLedgerRow(env);
    payloadsByJws.set(
      'refund-jws',
      notificationPayload({ notificationType: 'REFUND', notificationUUID: 'notif-refund-then-resub-renewal-status' }),
    );
    payloadsByJws.set('txn-jws', txPayload({ transactionId: 'txn-old', revocationReason: 1 }));
    await post(buildAppleWebhookRouter(), env, 'refund-jws');
    const revoked = await getAppleSubscription(env, 'otxn-1');
    expect(revoked?.status).toBe('revoked');
    const revokedAt = revoked?.revokedAt ?? '';
    expect(revokedAt.length).toBeGreaterThan(0);

    payloadsByJws.set(
      'renewal-status-jws',
      notificationPayload({
        notificationType: 'DID_CHANGE_RENEWAL_STATUS',
        subtype: 'AUTO_RENEW_ENABLED',
        notificationUUID: 'notif-resub-renewal-status',
        data: {
          bundleId: 'trade.congress.ios',
          environment: 'Production',
          signedTransactionInfo: 'txn-jws',
          signedRenewalInfo: 'renewal-jws',
        },
      }),
    );
    payloadsByJws.set(
      'txn-jws',
      txPayload({
        transactionId: 'txn-resub',
        purchaseDate: Date.parse(revokedAt) + 60_000,
        expiresDate: Date.now() + 30 * 86_400_000,
      }),
    );
    payloadsByJws.set('renewal-jws', {
      originalTransactionId: 'otxn-1',
      autoRenewStatus: 1,
      autoRenewProductId: 'trade.congress.premium.monthly',
    });
    await post(buildAppleWebhookRouter(), env, 'renewal-status-jws');
    const row = await getAppleSubscription(env, 'otxn-1');
    expect(row?.status).toBe('revoked');
    expect(row?.revokedAt).toBe(revokedAt);
    expect(row?.latestTransactionId).toBe('txn-old');
    expect(row?.autoRenewStatus).toBe(true);
    expect(
      clientRedeemWouldResurrectRevoked(row, {
        transactionId: 'txn-resub',
        purchaseDateMs: Date.parse(revokedAt) + 60_000,
      }),
    ).toBe(false);
  });
});
