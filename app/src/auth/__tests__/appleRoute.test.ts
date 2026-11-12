// Apple's real signing key is not available to tests, so RS256-against-JWKS
// verification itself is unit-tested separately (appleIdentity.test.ts) —
// this file mocks verifyAppleIdentityToken to exercise the POST /auth/apple
// route's surrounding logic (env gate, rate limit, session issuance, user
// linking end to end against a real in-memory users table).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyAppleIdentityToken = vi.fn();
vi.mock('../appleIdentity', () => ({
  verifyAppleIdentityToken: (...args: unknown[]) => verifyAppleIdentityToken(...args),
  appleEmailIsVerified: (claims: { email_verified?: boolean | string }) =>
    claims.email_verified === true || claims.email_verified === 'true',
  AppleIdentityVerificationError: class AppleIdentityVerificationError extends Error {},
}));

import { buildAuthRouter } from '../routes.ts';
import { AppleIdentityVerificationError } from '../appleIdentity.ts';
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

async function freshUsersDb(): Promise<SqliteDatabase> {
  const sqlite = (await import('node:sqlite')) as SqliteModule;
  const db = new sqlite.DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT, picture TEXT,
      google_sub TEXT UNIQUE, apple_sub TEXT, email_verified INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, last_login_at TEXT,
      stripe_customer_id TEXT, stripe_subscription_id TEXT, subscription_status TEXT,
      plan TEXT, current_period_end TEXT, cancel_at_period_end INTEGER NOT NULL DEFAULT 0, trial_end TEXT
    );
    CREATE UNIQUE INDEX idx_users_apple_sub ON users (apple_sub) WHERE apple_sub IS NOT NULL;
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

async function fakeEnv(overrides: Record<string, unknown> = {}): Promise<Env> {
  const db = await freshUsersDb();
  const kv = new Map<string, string>();
  return {
    DB: d1Database(db),
    CONFIG_KV: {
      get: async (k: string) => (kv.has(k) ? kv.get(k)! : null),
      put: async (k: string, v: string) => {
        kv.set(k, v);
      },
      delete: async (k: string) => {
        kv.delete(k);
      },
    },
    APPLE_SIGNIN_ENABLED: 'true',
    ...overrides,
  } as unknown as Env;
}

describe('GET /auth/apple/status', () => {
  it('reports web:false when Sign in with Apple is off', async () => {
    const app = buildAuthRouter();
    const env = await fakeEnv({ APPLE_SIGNIN_ENABLED: 'false' });
    const res = await app.request('http://localhost/apple/status', { method: 'GET' }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false, web: false });
  });

  it('reports web:false when enabled but Services ID is missing', async () => {
    const app = buildAuthRouter();
    const env = await fakeEnv({ APPLE_SIGNIN_ENABLED: 'true' });
    const res = await app.request('http://localhost/apple/status', { method: 'GET' }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, web: false });
  });
});

describe('GET /auth/apple/start', () => {
  it('exists and does not 404 when Sign in with Apple is off', async () => {
    const app = buildAuthRouter();
    const env = await fakeEnv({ APPLE_SIGNIN_ENABLED: 'false' });
    const res = await app.request('http://localhost/apple/start', { method: 'GET', headers: { Accept: 'text/html' } }, env);
    expect(res.status).not.toBe(404);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('auth_error=apple_not_configured');
  });

  it('exists and does not 404 when web Services ID is missing', async () => {
    const app = buildAuthRouter();
    const env = await fakeEnv({ APPLE_SIGNIN_ENABLED: 'true' });
    const res = await app.request('http://localhost/apple/start', { method: 'GET', headers: { Accept: 'text/html' } }, env);
    expect(res.status).not.toBe(404);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('auth_error=apple_web_not_configured');
  });
});

describe('POST /auth/apple', () => {
  beforeEach(() => {
    verifyAppleIdentityToken.mockReset();
  });

  it('is refused (503) when APPLE_SIGNIN_ENABLED is not "true"', async () => {
    const app = buildAuthRouter();
    const env = await fakeEnv({ APPLE_SIGNIN_ENABLED: 'false' });
    const res = await app.request(
      'http://localhost/apple',
      { method: 'POST', body: JSON.stringify({ identityToken: 'x' }), headers: { 'content-type': 'application/json' } },
      env,
    );
    expect(res.status).toBe(503);
    expect(verifyAppleIdentityToken).not.toHaveBeenCalled();
  });

  it('requires identityToken', async () => {
    const app = buildAuthRouter();
    const env = await fakeEnv();
    const res = await app.request(
      'http://localhost/apple',
      { method: 'POST', body: JSON.stringify({}), headers: { 'content-type': 'application/json' } },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('returns 401 on a failed identity token verification', async () => {
    verifyAppleIdentityToken.mockRejectedValue(new AppleIdentityVerificationError('invalid identity token signature'));
    const app = buildAuthRouter();
    const env = await fakeEnv();
    const res = await app.request(
      'http://localhost/apple',
      { method: 'POST', body: JSON.stringify({ identityToken: 'a.b.c' }), headers: { 'content-type': 'application/json' } },
      env,
    );
    expect(res.status).toBe(401);
  });

  it('creates a new account, issues a session token, and stores the one-time fullName', async () => {
    verifyAppleIdentityToken.mockResolvedValue({
      sub: 'apple-sub-1',
      email: 'new@example.com',
      email_verified: 'true',
    });
    const app = buildAuthRouter();
    const env = await fakeEnv();
    const res = await app.request(
      'http://localhost/apple',
      {
        method: 'POST',
        body: JSON.stringify({ identityToken: 'a.b.c', fullName: 'Ada Lovelace' }),
        headers: { 'content-type': 'application/json' },
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; token: string; user: { email: string; name: string | null } };
    expect(body.ok).toBe(true);
    expect(typeof body.token).toBe('string');
    expect(body.token.length).toBeGreaterThan(10);
    expect(body.user.email).toBe('new@example.com');
    expect(body.user.name).toBe('Ada Lovelace');
    // Session cookie is also set for web-embedded use.
    expect(res.headers.get('set-cookie') ?? '').toContain('ct_session=');
  });

  it('returns the SAME account and session works again on a later sign-in with no email/name', async () => {
    verifyAppleIdentityToken.mockResolvedValue({ sub: 'apple-sub-2', email: 'return@example.com', email_verified: 'true' });
    const app = buildAuthRouter();
    const env = await fakeEnv();
    const first = await app.request(
      'http://localhost/apple',
      { method: 'POST', body: JSON.stringify({ identityToken: 'a.b.c' }), headers: { 'content-type': 'application/json' } },
      env,
    );
    const firstBody = (await first.json()) as { user: { id: string } };

    verifyAppleIdentityToken.mockResolvedValue({ sub: 'apple-sub-2' }); // Apple omits email/name on later calls
    const second = await app.request(
      'http://localhost/apple',
      { method: 'POST', body: JSON.stringify({ identityToken: 'd.e.f' }), headers: { 'content-type': 'application/json' } },
      env,
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { user: { id: string; email: string } };
    expect(secondBody.user.id).toBe(firstBody.user.id);
    expect(secondBody.user.email).toBe('return@example.com');
  });

  it('passes the client nonce through to verification', async () => {
    verifyAppleIdentityToken.mockResolvedValue({ sub: 'apple-sub-3', email: 'n@example.com', email_verified: 'true' });
    const app = buildAuthRouter();
    const env = await fakeEnv();
    await app.request(
      'http://localhost/apple',
      {
        method: 'POST',
        body: JSON.stringify({ identityToken: 'a.b.c', nonce: 'the-nonce' }),
        headers: { 'content-type': 'application/json' },
      },
      env,
    );
    expect(verifyAppleIdentityToken).toHaveBeenCalledWith('a.b.c', expect.objectContaining({ nonce: 'the-nonce' }));
  });
});
