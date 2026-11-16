import { describe, it, expect } from 'vitest';
import {
  clientRedeemWouldResurrectRevoked,
  getAppleSubscription,
  upsertAppleSubscription,
  type AppleSubscriptionRecord,
} from '../appleSubscriptions.ts';
import type { Env } from '../../shared/types.ts';

function revokedRow(overrides: Partial<AppleSubscriptionRecord> = {}): AppleSubscriptionRecord {
  return {
    originalTransactionId: 'otxn-1',
    userId: null,
    productId: 'trade.congress.premium.monthly',
    plan: 'monthly',
    status: 'revoked',
    environment: 'Production',
    latestTransactionId: 'txn-refund',
    purchaseDate: '2026-01-01T00:00:00.000Z',
    expiresDate: '2026-02-01T00:00:00.000Z',
    autoRenewStatus: false,
    autoRenewProductId: null,
    revokedAt: '2026-01-15T00:00:00.000Z',
    revocationReason: 1,
    lastNotificationType: 'REFUND',
    lastNotificationSubtype: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-15T00:00:00.000Z',
    ...overrides,
  };
}

describe('clientRedeemWouldResurrectRevoked', () => {
  it('lets a first-time redeem through (no ledger row yet)', () => {
    expect(
      clientRedeemWouldResurrectRevoked(null, { transactionId: 'txn-1', purchaseDateMs: Date.now() }),
    ).toBe(false);
  });

  it('lets an active ledger row through (restore purchases)', () => {
    expect(
      clientRedeemWouldResurrectRevoked(
        { ...revokedRow(), status: 'active', revokedAt: null },
        { transactionId: 'txn-1', purchaseDateMs: Date.parse('2026-01-01T00:00:00.000Z') },
      ),
    ).toBe(false);
  });

  it('blocks replaying the original JWS after REFUND (same or older purchase)', () => {
    expect(
      clientRedeemWouldResurrectRevoked(revokedRow(), {
        transactionId: 'txn-1',
        purchaseDateMs: Date.parse('2026-01-01T00:00:00.000Z'),
      }),
    ).toBe(true);
  });

  it('blocks even when the refund webhook rotated latestTransactionId', () => {
    expect(
      clientRedeemWouldResurrectRevoked(revokedRow({ latestTransactionId: 'txn-refund' }), {
        transactionId: 'txn-1',
        purchaseDateMs: Date.parse('2026-01-01T00:00:00.000Z'),
      }),
    ).toBe(true);
  });

  it('allows a later purchase on the same originalTransactionId after revoke', () => {
    expect(
      clientRedeemWouldResurrectRevoked(revokedRow(), {
        transactionId: 'txn-resubscribe',
        purchaseDateMs: Date.parse('2026-01-16T00:00:00.000Z'),
      }),
    ).toBe(false);
  });
});

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

async function fakeEnv(): Promise<{ env: Env; db: SqliteDatabase }> {
  const db = await freshDb();
  return { env: { DB: d1Database(db) } as unknown as Env, db };
}

function baseInput(over: { userId: string | null; originalTransactionId?: string }) {
  return {
    originalTransactionId: over.originalTransactionId ?? 'otxn-1',
    userId: over.userId,
    productId: 'trade.congress.premium.monthly',
    plan: 'monthly' as const,
    status: 'active' as const,
    expiresDate: '2026-09-20T00:00:00.000Z',
  };
}

describe('upsertAppleSubscription owner assignment', () => {
  it('claims a null-owner row for the first authenticated user', async () => {
    const { env } = await fakeEnv();
    await upsertAppleSubscription(env, baseInput({ userId: null }));
    const claimed = await upsertAppleSubscription(env, baseInput({ userId: 'user-a' }));
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    expect(claimed.record.userId).toBe('user-a');
  });

  it('refuses a different non-null owner (409 path) without rewriting user_id', async () => {
    const { env } = await fakeEnv();
    await upsertAppleSubscription(env, baseInput({ userId: 'user-a' }));
    const steal = await upsertAppleSubscription(env, baseInput({ userId: 'user-b' }));
    expect(steal.ok).toBe(false);
    if (steal.ok) return;
    expect(steal.reason).toBe('owner_mismatch');
    expect((await getAppleSubscription(env, 'otxn-1'))?.userId).toBe('user-a');
  });

  it('a stale null-owner read cannot un-assign a claim that landed before the write', async () => {
    // iOS observeAppleTransactions redeems signed-out (user_id NULL) and leaves
    // the StoreKit transaction unfinished so sign-in can link it. That in-flight
    // anonymous upsert can re-read after link_apple_entitlement already wrote
    // user-a. The JS guard saw NULL; COALESCE must still keep the claim.
    const { env, db } = await fakeEnv();
    await upsertAppleSubscription(env, baseInput({ userId: 'user-a' }));

    const real = d1Database(db);
    const staleEnv = {
      DB: {
        prepare(sql: string) {
          const stmt = real.prepare(sql);
          if (!/SELECT \* FROM apple_subscriptions WHERE original_transaction_id = \?/.test(sql)) {
            return stmt;
          }
          return {
            bind(...values: unknown[]) {
              stmt.bind(...values);
              return this;
            },
            async first<T>() {
              const row = await stmt.first<Record<string, unknown>>();
              if (!row) return null as T;
              return { ...row, user_id: null } as T;
            },
            run: stmt.run.bind(stmt),
            all: stmt.all.bind(stmt),
          };
        },
      },
    } as unknown as Env;

    const raced = await upsertAppleSubscription(staleEnv, baseInput({ userId: null }));
    expect(raced.ok).toBe(true);
    expect((await getAppleSubscription(env, 'otxn-1'))?.userId).toBe('user-a');
  });

  it('concurrent claim + anonymous redeem leaves the claimed owner, not NULL', async () => {
    const { env } = await fakeEnv();
    await Promise.all([
      upsertAppleSubscription(env, baseInput({ userId: 'user-a' })),
      upsertAppleSubscription(env, baseInput({ userId: null })),
    ]);
    expect((await getAppleSubscription(env, 'otxn-1'))?.userId).toBe('user-a');
  });
});


describe('clientRedeemWouldResurrectRevoked — lapsed ledger rows', () => {
  it('blocks replaying the original JWS after the row expired (same transaction)', () => {
    expect(
      clientRedeemWouldResurrectRevoked(
        revokedRow({ status: 'expired', revokedAt: null, revocationReason: null }),
        { transactionId: 'txn-refund', purchaseDateMs: Date.parse('2026-01-01T00:00:00.000Z') },
      ),
    ).toBe(true);
  });

  it('lets a genuine resubscribe through an expired row (new txn purchased after expiry)', () => {
    expect(
      clientRedeemWouldResurrectRevoked(
        revokedRow({ status: 'expired', revokedAt: null }),
        { transactionId: 'txn-resub', purchaseDateMs: Date.parse('2026-02-02T00:00:00.000Z') },
      ),
    ).toBe(false);
  });

  it('blocks a "resubscribe" dated before the recorded expiry', () => {
    expect(
      clientRedeemWouldResurrectRevoked(
        revokedRow({ status: 'expired', revokedAt: null }),
        { transactionId: 'txn-resub', purchaseDateMs: Date.parse('2026-01-20T00:00:00.000Z') },
      ),
    ).toBe(true);
  });

  it('blocks a stale replay against a billing_retry row', () => {
    expect(
      clientRedeemWouldResurrectRevoked(
        revokedRow({ status: 'billing_retry', revokedAt: null, revocationReason: null }),
        { transactionId: 'txn-refund', purchaseDateMs: Date.parse('2026-01-01T00:00:00.000Z') },
      ),
    ).toBe(true);
  });

  it('revoked rows anchor on revokedAt even when expiresDate is later', () => {
    expect(
      clientRedeemWouldResurrectRevoked(
        revokedRow({ expiresDate: '2026-03-01T00:00:00.000Z' }),
        { transactionId: 'txn-resub', purchaseDateMs: Date.parse('2026-02-15T00:00:00.000Z') },
      ),
    ).toBe(false);
  });
});

describe('upsertAppleSubscription redeemGuard (atomic resurrect guard)', () => {
  const revokedInput = () => ({
    ...baseInput({ userId: 'user-a' }),
    status: 'revoked' as const,
    latestTransactionId: 'txn-refund',
    purchaseDate: '2026-01-01T00:00:00.000Z',
    expiresDate: '2026-02-01T00:00:00.000Z',
    revokedAt: '2026-01-15T00:00:00.000Z',
  });

  it('refuses to resurrect a revoked row, atomically', async () => {
    const { env } = await fakeEnv();
    await upsertAppleSubscription(env, revokedInput());
    const replay = await upsertAppleSubscription(env, {
      ...baseInput({ userId: 'user-a' }),
      latestTransactionId: 'txn-refund',
      purchaseDate: '2026-01-01T00:00:00.000Z',
      redeemGuard: true,
    });
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.reason).toBe('guarded_status');
    expect((await getAppleSubscription(env, 'otxn-1'))?.status).toBe('revoked');
  });

  it('allows a genuine resubscribe through the atomic guard', async () => {
    const { env } = await fakeEnv();
    await upsertAppleSubscription(env, revokedInput());
    const resub = await upsertAppleSubscription(env, {
      ...baseInput({ userId: 'user-a' }),
      latestTransactionId: 'txn-resub',
      purchaseDate: '2026-02-20T00:00:00.000Z',
      expiresDate: '2026-03-20T00:00:00.000Z',
      redeemGuard: true,
    });
    expect(resub.ok).toBe(true);
    expect((await getAppleSubscription(env, 'otxn-1'))?.status).toBe('active');
  });

  it('expired rows stay expired when the original JWS is replayed atomically', async () => {
    const { env } = await fakeEnv();
    await upsertAppleSubscription(env, {
      ...baseInput({ userId: 'user-a' }),
      status: 'expired',
      latestTransactionId: 'txn-lapse',
      purchaseDate: '2026-01-01T00:00:00.000Z',
      expiresDate: '2026-02-01T00:00:00.000Z',
    });
    const replay = await upsertAppleSubscription(env, {
      ...baseInput({ userId: 'user-a' }),
      latestTransactionId: 'txn-lapse',
      purchaseDate: '2026-01-01T00:00:00.000Z',
      redeemGuard: true,
    });
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.reason).toBe('guarded_status');
    expect((await getAppleSubscription(env, 'otxn-1'))?.status).toBe('expired');
  });

  it('webhook-style upserts (no redeemGuard) still update guarded rows', async () => {
    const { env } = await fakeEnv();
    await upsertAppleSubscription(env, revokedInput());
    const renewed = await upsertAppleSubscription(env, {
      ...baseInput({ userId: 'user-a' }),
      latestTransactionId: 'txn-renew',
      purchaseDate: '2026-02-20T00:00:00.000Z',
      expiresDate: '2026-03-20T00:00:00.000Z',
      revokedAt: null,
    });
    expect(renewed.ok).toBe(true);
    expect((await getAppleSubscription(env, 'otxn-1'))?.status).toBe('active');
  });
});


describe('legacy lapse with no expiry anchor', () => {
  for (const status of ['expired', 'billing_retry'] as const) {
    it(`${status}: allows a new purchase after the last observed lapse but rejects older or same-id replays`, () => {
      const row = revokedRow({ status, revokedAt: null, expiresDate: null, updatedAt: '2026-02-01T00:00:00.000Z' });
      expect(clientRedeemWouldResurrectRevoked(row, { transactionId: 'txn-new', purchaseDateMs: Date.parse('2026-02-02T00:00:00.000Z') })).toBe(false);
      expect(clientRedeemWouldResurrectRevoked(row, { transactionId: 'txn-historic', purchaseDateMs: Date.parse('2026-01-20T00:00:00.000Z') })).toBe(true);
      expect(clientRedeemWouldResurrectRevoked(row, { transactionId: row.latestTransactionId, purchaseDateMs: Date.parse('2026-02-02T00:00:00.000Z') })).toBe(true);
    });

    it(`${status}: atomic SQL matches the precheck for missing anchors`, async () => {
      const { env, db } = await fakeEnv();
      await upsertAppleSubscription(env, { ...baseInput({ userId: 'user-a' }), status, latestTransactionId: 'txn-lapse', expiresDate: null, revokedAt: null });
      db.prepare('UPDATE apple_subscriptions SET updated_at = ? WHERE original_transaction_id = ?').run('2026-02-01T00:00:00.000Z', 'otxn-1');
      for (const date of ['2026-01-20T00:00:00.000Z', '2026-02-01T00:00:00.000Z']) {
        const replay = await upsertAppleSubscription(env, { ...baseInput({ userId: 'user-a' }), latestTransactionId: 'txn-historic', purchaseDate: date, redeemGuard: true });
        expect(replay.ok).toBe(false);
        expect((await getAppleSubscription(env, 'otxn-1'))?.status).toBe(status);
      }
      const recovery = await upsertAppleSubscription(env, { ...baseInput({ userId: 'user-a' }), latestTransactionId: 'txn-new', purchaseDate: '2026-02-02T00:00:00.000Z', redeemGuard: true });
      expect(recovery.ok).toBe(true);
      expect((await getAppleSubscription(env, 'otxn-1'))?.status).toBe('active');
    });
  }
});
