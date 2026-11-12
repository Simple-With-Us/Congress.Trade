import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../shared/types.ts';
import { getPremiumTotals, notifyPremiumActivation } from '../premiumActivationAlert.ts';
import type { PushoverMessage, PushoverResult } from '../../shared/pushover.ts';

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
  close(): void;
}
interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDatabase;
}

let openDatabase: SqliteDatabase | null = null;

async function sqliteDatabase(): Promise<SqliteDatabase> {
  const moduleName = 'node:sqlite';
  const sqlite = (await import(moduleName)) as SqliteModule;
  const db = new sqlite.DatabaseSync(':memory:');
  openDatabase = db;
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, subscription_status TEXT, plan TEXT
    );
    CREATE TABLE apple_subscriptions (
      original_transaction_id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      status TEXT NOT NULL, expires_date TEXT
    );
    CREATE TABLE premium_activation_notices (
      activation_key TEXT PRIMARY KEY, user_id TEXT NOT NULL, notified_at TEXT NOT NULL
    );
  `);
  return db;
}

function d1Database(db: SqliteDatabase): Env['DB'] {
  const prepare = (sql: string) => {
    let params: unknown[] = [];
    return {
      bind(...values: unknown[]) {
        params = values;
        return this;
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
  };
  return { prepare } as unknown as Env['DB'];
}

async function fakeEnv(): Promise<Env & { __db: SqliteDatabase }> {
  const db = await sqliteDatabase();
  return { DB: d1Database(db), __db: db } as unknown as Env & { __db: SqliteDatabase };
}

afterEach(() => {
  openDatabase?.close();
  openDatabase = null;
  vi.restoreAllMocks();
});

describe('getPremiumTotals', () => {
  it('counts Stripe active/trialing users and Apple active/grace_period rows, distinct by user', async () => {
    const env = await fakeEnv();
    const db = env.__db;
    db.exec(`
      INSERT INTO users (id, subscription_status, plan) VALUES
        ('u1', 'active', 'monthly'),
        ('u2', 'trialing', 'annual'),
        ('u3', 'canceled', 'monthly'),
        ('u4', NULL, NULL);
      INSERT INTO apple_subscriptions (original_transaction_id, user_id, status, expires_date) VALUES
        ('otxn-1', 'u5', 'active', '2999-01-01T00:00:00.000Z'),
        ('otxn-2', 'u6', 'expired', '2000-01-01T00:00:00.000Z'),
        ('otxn-3', 'u7', 'grace_period', '2999-01-01T00:00:00.000Z');
    `);
    const totals = await getPremiumTotals(env, '2026-01-01T00:00:00.000Z');
    expect(totals).toEqual({ total: 4, trialing: 1 });
  });

  it('does not double-count a user who is Premium via both Stripe and Apple', async () => {
    const env = await fakeEnv();
    const db = env.__db;
    db.exec(`
      INSERT INTO users (id, subscription_status, plan) VALUES ('u1', 'active', 'monthly');
      INSERT INTO apple_subscriptions (original_transaction_id, user_id, status, expires_date)
        VALUES ('otxn-1', 'u1', 'active', NULL);
    `);
    const totals = await getPremiumTotals(env, '2026-01-01T00:00:00.000Z');
    expect(totals.total).toBe(1);
  });

  it('excludes an Apple row past its expiry even when status is still active', async () => {
    const env = await fakeEnv();
    const db = env.__db;
    db.exec(`
      INSERT INTO apple_subscriptions (original_transaction_id, user_id, status, expires_date)
        VALUES ('otxn-1', 'u1', 'active', '2000-01-01T00:00:00.000Z');
    `);
    const totals = await getPremiumTotals(env, '2026-01-01T00:00:00.000Z');
    expect(totals.total).toBe(0);
  });
});

describe('notifyPremiumActivation', () => {
  function fakePush(result: PushoverResult = { sent: true }) {
    const calls: PushoverMessage[] = [];
    const push = vi.fn(async (_env: Env, msg: PushoverMessage) => {
      calls.push(msg);
      return result;
    });
    return { push, calls };
  }

  it('sends once for a new activationKey and includes plan/source/trial + totals in the message', async () => {
    const env = await fakeEnv();
    env.__db.exec(`INSERT INTO users (id, subscription_status, plan) VALUES ('u1', 'trialing', 'annual');`);
    const { push, calls } = fakePush();

    await notifyPremiumActivation(env, {
      activationKey: 'sub_123',
      userId: 'u1',
      userEmail: 'person@example.com',
      source: 'stripe',
      plan: 'annual',
      trialing: true,
    }, { push });

    expect(push).toHaveBeenCalledTimes(1);
    const [msg] = calls;
    expect(msg.title).toMatch(/Premium/i);
    expect(msg.message).toContain('person@example.com');
    expect(msg.message).toContain('Stripe');
    expect(msg.message).toContain('annual');
    expect(msg.message).toContain('trial');
    expect(msg.message).toContain('Premium accounts: 1 total, 1 on trial');
  });

  it('does not notify twice for the same activationKey (redelivered webhook)', async () => {
    const env = await fakeEnv();
    env.__db.exec(`INSERT INTO users (id, subscription_status, plan) VALUES ('u1', 'active', 'monthly');`);
    const { push } = fakePush();
    const input = {
      activationKey: 'sub_dupe',
      userId: 'u1',
      userEmail: 'dup@example.com',
      source: 'stripe' as const,
      plan: 'monthly' as const,
      trialing: false,
    };

    await notifyPremiumActivation(env, input, { push });
    await notifyPremiumActivation(env, input, { push });
    await notifyPremiumActivation(env, input, { push });

    expect(push).toHaveBeenCalledTimes(1);
  });

  it('a different activationKey for the same user notifies again (independent subscription)', async () => {
    const env = await fakeEnv();
    env.__db.exec(`INSERT INTO users (id, subscription_status, plan) VALUES ('u1', 'active', 'monthly');`);
    const { push } = fakePush();

    await notifyPremiumActivation(env, {
      activationKey: 'sub_first', userId: 'u1', userEmail: 'e@x.com',
      source: 'stripe', plan: 'monthly', trialing: false,
    }, { push });
    await notifyPremiumActivation(env, {
      activationKey: 'sub_second', userId: 'u1', userEmail: 'e@x.com',
      source: 'stripe', plan: 'monthly', trialing: false,
    }, { push });

    expect(push).toHaveBeenCalledTimes(2);
  });

  it('never throws when Pushover delivery fails', async () => {
    const env = await fakeEnv();
    const push = vi.fn(async () => { throw new Error('pushover unreachable'); });

    await expect(
      notifyPremiumActivation(env, {
        activationKey: 'sub_fail', userId: 'u1', userEmail: 'e@x.com',
        source: 'stripe', plan: 'monthly', trialing: false,
      }, { push: push as unknown as typeof import('../../shared/pushover.ts').sendPushover }),
    ).resolves.toBeUndefined();
  });

  it('never throws when Pushover reports it did not send (missing config)', async () => {
    const env = await fakeEnv();
    const { push } = fakePush({ sent: false, reason: 'not configured' });

    await expect(
      notifyPremiumActivation(env, {
        activationKey: 'sub_unconfigured', userId: 'u1', userEmail: 'e@x.com',
        source: 'stripe', plan: 'monthly', trialing: false,
      }, { push }),
    ).resolves.toBeUndefined();
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('never throws when the DB itself errors (e.g. table missing)', async () => {
    const brokenEnv = { DB: { prepare: () => { throw new Error('no such table'); } } } as unknown as Env;
    await expect(
      notifyPremiumActivation(brokenEnv, {
        activationKey: 'sub_broken', userId: 'u1', userEmail: 'e@x.com',
        source: 'stripe', plan: 'monthly', trialing: false,
      }),
    ).resolves.toBeUndefined();
  });

  it('RELEASES the claim when delivery fails, so a later attempt can still notify', async () => {
    // Claiming before delivering makes the notifier idempotent, but it also means a
    // failed delivery would consume the key forever: every retry short-circuits at
    // !isNew and the alert is lost rather than merely failing soft. Releasing on
    // failure is what keeps "fail-soft" honest.
    const env = await fakeEnv();
    env.__db.exec(`INSERT INTO users (id, subscription_status, plan) VALUES ('u1', 'active', 'monthly');`);
    const input = {
      activationKey: 'sub_retry', userId: 'u1', userEmail: 'e@x.com',
      source: 'stripe' as const, plan: 'monthly', trialing: false,
    };

    const failing = fakePush({ sent: false, reason: 'pushover HTTP 500' });
    await notifyPremiumActivation(env, input, { push: failing.push });
    expect(failing.push).toHaveBeenCalledTimes(1);

    const claimsAfterFailure = env.__db
      .prepare(`SELECT COUNT(*) AS n FROM premium_activation_notices WHERE activation_key = 'sub_retry'`)
      .get() as { n: number };
    expect(claimsAfterFailure.n).toBe(0);

    const succeeding = fakePush({ sent: true });
    await notifyPremiumActivation(env, input, { push: succeeding.push });
    expect(succeeding.push).toHaveBeenCalledTimes(1);
  });

  it('KEEPS the claim after a successful delivery, so a redelivery still does not re-notify', async () => {
    const env = await fakeEnv();
    env.__db.exec(`INSERT INTO users (id, subscription_status, plan) VALUES ('u1', 'active', 'monthly');`);
    const input = {
      activationKey: 'sub_keep', userId: 'u1', userEmail: 'e@x.com',
      source: 'stripe' as const, plan: 'monthly', trialing: false,
    };

    const first = fakePush({ sent: true });
    await notifyPremiumActivation(env, input, { push: first.push });
    expect(first.push).toHaveBeenCalledTimes(1);

    const claims = env.__db
      .prepare(`SELECT COUNT(*) AS n FROM premium_activation_notices WHERE activation_key = 'sub_keep'`)
      .get() as { n: number };
    expect(claims.n).toBe(1);

    const second = fakePush({ sent: true });
    await notifyPremiumActivation(env, input, { push: second.push });
    expect(second.push).not.toHaveBeenCalled();
  });
});
