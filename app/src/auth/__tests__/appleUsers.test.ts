// Real in-memory SQLite (not a hand-rolled regex fake) so the Apple sign-in
// linking rules run against the actual `users` schema (base + migration 0004
// billing columns + migration 0080 apple_sub), the same pattern
// admin/__tests__/migrations.test.ts uses for schema-accurate D1 doubles.
import { describe, it, expect, beforeEach } from 'vitest';
import { getUserByAppleSub, getUserByEmail, upsertUserFromApple, upsertUserFromGoogle } from '../users.ts';
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
  close(): void;
}
interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDatabase;
}

async function sqliteDatabase(): Promise<SqliteDatabase> {
  const moduleName = 'node:sqlite';
  const sqlite = (await import(moduleName)) as SqliteModule;
  return new sqlite.DatabaseSync(':memory:');
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

function freshDb(): Promise<SqliteDatabase> {
  return sqliteDatabase().then((db) => {
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        name TEXT,
        picture TEXT,
        google_sub TEXT UNIQUE,
        email_verified INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        last_login_at TEXT,
        stripe_customer_id TEXT,
        stripe_subscription_id TEXT,
        subscription_status TEXT,
        plan TEXT,
        current_period_end TEXT,
        cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
        trial_end TEXT,
        apple_sub TEXT
      );
      CREATE UNIQUE INDEX idx_users_apple_sub ON users (apple_sub) WHERE apple_sub IS NOT NULL;
    `);
    return db;
  });
}

describe('upsertUserFromApple', () => {
  let db: SqliteDatabase;
  let env: Env;
  beforeEach(async () => {
    db = await freshDb();
    env = { DB: d1Database(db) } as unknown as Env;
  });

  it('creates a new user on first sign-in, storing the verified email and one-time fullName', async () => {
    const user = await upsertUserFromApple(env, {
      sub: 'apple-sub-1',
      email: 'new@example.com',
      emailVerified: true,
      name: 'Ada Lovelace',
    });
    expect(user.appleSub).toBe('apple-sub-1');
    expect(user.email).toBe('new@example.com');
    expect(user.name).toBe('Ada Lovelace');
    expect(user.emailVerified).toBe(true);
  });

  it('returns the same account on a later sign-in with no email/name (Apple omits them after the first call)', async () => {
    const first = await upsertUserFromApple(env, {
      sub: 'apple-sub-2',
      email: 'returning@example.com',
      emailVerified: true,
      name: 'Grace Hopper',
    });
    const second = await upsertUserFromApple(env, { sub: 'apple-sub-2' });
    expect(second.id).toBe(first.id);
    expect(second.email).toBe('returning@example.com'); // preserved, not overwritten with null
    expect(second.name).toBe('Grace Hopper'); // preserved
  });

  it('links to an existing account when the verified email matches (e.g. a prior Google signup)', async () => {
    const googleUser = await upsertUserFromGoogle(env, {
      sub: 'google-sub-1',
      email: 'shared@example.com',
      emailVerified: true,
      name: 'Existing User',
      picture: null,
    });
    const linked = await upsertUserFromApple(env, {
      sub: 'apple-sub-3',
      email: 'shared@example.com',
      emailVerified: true,
    });
    expect(linked.id).toBe(googleUser.id);
    expect(linked.appleSub).toBe('apple-sub-3');
    expect(linked.googleSub).toBe('google-sub-1'); // linking does not clobber the existing Google identity
  });

  it('does NOT link to an existing account by an UNVERIFIED email (account-takeover guard)', async () => {
    const existing = await upsertUserFromGoogle(env, {
      sub: 'google-sub-2',
      email: 'victim@example.com',
      emailVerified: true,
      name: null,
      picture: null,
    });
    const created = await upsertUserFromApple(env, {
      sub: 'apple-sub-4',
      email: 'victim@example.com',
      emailVerified: false, // Apple did not attest ownership this time
    });
    expect(created.id).not.toBe(existing.id);
    // The unverified/untrusted email must not be stored on the new account
    // either — it may genuinely belong to the victim, not this Apple sub.
    expect(created.email).not.toBe('victim@example.com');
    expect(created.email).toContain('apple-sub-4');
  });

  it('creates an account with a synthetic placeholder email when Apple supplies no email at all', async () => {
    const user = await upsertUserFromApple(env, { sub: 'apple-sub-5' });
    expect(user.appleSub).toBe('apple-sub-5');
    expect(user.email).toContain('apple-sub-5');
  });

  it('getUserByAppleSub finds a linked user and returns null for an unknown sub', async () => {
    await upsertUserFromApple(env, { sub: 'apple-sub-6', email: 'x@example.com', emailVerified: true });
    expect((await getUserByAppleSub(env, 'apple-sub-6'))?.appleSub).toBe('apple-sub-6');
    expect(await getUserByAppleSub(env, 'nope')).toBeNull();
  });

  it('two different Apple accounts never collide on the partial-unique apple_sub index', async () => {
    await upsertUserFromApple(env, { sub: 'apple-sub-7', email: 'a@example.com', emailVerified: true });
    await upsertUserFromApple(env, { sub: 'apple-sub-8', email: 'b@example.com', emailVerified: true });
    const a = await getUserByEmail(env, 'a@example.com');
    const b = await getUserByEmail(env, 'b@example.com');
    expect(a?.appleSub).toBe('apple-sub-7');
    expect(b?.appleSub).toBe('apple-sub-8');
  });
});
