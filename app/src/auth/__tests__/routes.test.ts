import { describe, it, expect } from 'vitest';
import { buildAuthRouter } from '../routes.ts';
import { ANONYMOUS_ENTITLEMENT } from '../../billing/entitlement.ts';
import type { Env } from '../../shared/types.ts';

const BILLING_READY = {
  STRIPE_SECRET_KEY: 'sk_test',
  STRIPE_WEBHOOK_SECRET: 'whsec',
  STRIPE_PRICE_MONTHLY: 'price_m',
  STRIPE_PRICE_ANNUAL: 'price_a',
} as const;

function fakeEnv(over: Record<string, unknown> = {}): Env {
  const kv = new Map<string, string>();
  return {
    CONFIG_KV: {
      get: async (k: string) => (kv.has(k) ? kv.get(k)! : null),
      put: async (k: string, v: string) => {
        kv.set(k, v);
      },
      delete: async (k: string) => {
        kv.delete(k);
      },
    },
    DB: {
      prepare: () => ({
        bind() {
          return this;
        },
        async first() {
          return null;
        },
        async run() {
          return {};
        },
        async all() {
          return { results: [] };
        },
      }),
    },
    ...over,
  } as unknown as Env;
}

describe('auth router', () => {
  it('GET /me returns a null user + anonymous entitlement when not signed in', async () => {
    const app = buildAuthRouter();
    const res = await app.request('http://localhost/me', {}, fakeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      user: null,
      entitlement: ANONYMOUS_ENTITLEMENT,
      admin: { allowed: false },
      auth: { appleWeb: false, xWeb: false },
      billing: { configured: false, checkoutConfigured: false, portalConfigured: false, hasCustomer: false },
    });
  });

  it('GET /me exposes checkout and portal capabilities independently', async () => {
    const app = buildAuthRouter();
    const incomplete = await app.request(
      'http://localhost/me',
      {},
      fakeEnv({ STRIPE_SECRET_KEY: 'sk_test' }),
    );
    expect((await incomplete.json()) as { billing: Record<string, boolean> }).toMatchObject({
      billing: { configured: false, checkoutConfigured: false, portalConfigured: true, hasCustomer: false },
    });
    const ready = await app.request('http://localhost/me', {}, fakeEnv(BILLING_READY));
    expect(ready.status).toBe(200);
    expect((await ready.json()) as { billing: Record<string, boolean> }).toMatchObject({
      billing: { configured: true, checkoutConfigured: true, portalConfigured: true, hasCustomer: false },
    });
  });

  it('GET /me marks allowlisted signed-in users as admin', async () => {
    const app = buildAuthRouter();
    const kv = new Map<string, string>([['sess:tok', JSON.stringify({ userId: 'u1' })]]);
    const env = fakeEnv({
      ADMIN_EMAILS: 'admin@example.com',
      CONFIG_KV: {
        get: async (k: string) => (kv.has(k) ? kv.get(k)! : null),
        put: async (k: string, v: string) => {
          kv.set(k, v);
        },
        delete: async (k: string) => {
          kv.delete(k);
        },
      },
      DB: {
        // Scoped by SQL text — an unscoped "always return the user row"
        // stand-in would also (wrongly) satisfy the unrelated
        // apple_subscriptions entitlement lookup GET /me now issues.
        prepare: (sql: string) => ({
          bind() {
            return this;
          },
          async first() {
            if (!/FROM users/i.test(sql)) return null;
            return {
              id: 'u1',
              email: 'admin@example.com',
              name: 'Admin User',
              picture: null,
              google_sub: 'g-1',
              email_verified: 1,
              created_at: '2026-06-28T00:00:00.000Z',
              last_login_at: '2026-06-28T00:00:00.000Z',
              stripe_customer_id: 'cus_1',
            };
          },
          async run() {
            return {};
          },
          async all() {
            return { results: [] };
          },
        }),
      },
    });
    const res = await app.request('http://localhost/me', { headers: { cookie: 'ct_session=tok' } }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      user: { email: 'admin@example.com' },
      admin: { allowed: true },
      billing: { hasCustomer: true },
      entitlement: { premium: false },
    });

    const bearer = await app.request(
      'http://localhost/me',
      { headers: { authorization: 'Bearer tok' } },
      env,
    );
    expect(bearer.status).toBe(200);
    expect(await bearer.json()).toMatchObject({
      user: { email: 'admin@example.com' },
      admin: { allowed: true },
    });
  });

  it('GET /google/start is 503 when Google is not configured', async () => {
    const app = buildAuthRouter();
    const res = await app.request('http://localhost/google/start', {}, fakeEnv());
    expect(res.status).toBe(503);
  });

  it('GET /google/start redirects to Google when configured', async () => {
    const app = buildAuthRouter();
    const res = await app.request(
      'http://localhost/google/start',
      {},
      fakeEnv({ GOOGLE_OAUTH_CLIENT_ID: 'cid' }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location') ?? '').toContain('accounts.google.com');
  });

  it('GET /x/start is 503 when X is not configured', async () => {
    const app = buildAuthRouter();
    const res = await app.request('http://localhost/x/start', {}, fakeEnv());
    expect(res.status).toBe(503);
  });

  it('GET /x/start redirects to X authorization URL when configured', async () => {
    const app = buildAuthRouter();
    const res = await app.request(
      'http://localhost/x/start',
      {},
      fakeEnv({ X_OAUTH_CLIENT_ID: 'x_cid' }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location') ?? '').toContain('twitter.com/i/oauth2/authorize');
  });

  it('POST /magic/request rejects an invalid email', async () => {
    const app = buildAuthRouter();
    const res = await app.request(
      'http://localhost/magic/request',
      {
        method: 'POST',
        body: JSON.stringify({ email: 'nope' }),
        headers: { 'content-type': 'application/json' },
      },
      fakeEnv(),
    );
    expect(res.status).toBe(400);
  });

  it('POST /logout succeeds even without a session', async () => {
    const app = buildAuthRouter();
    const res = await app.request('http://localhost/logout', { method: 'POST' }, fakeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('POST /logout revokes bearer sessions used by native clients', async () => {
    const deleted: string[] = [];
    const env = fakeEnv({
      CONFIG_KV: {
        get: async () => null,
        put: async () => {},
        delete: async (key: string) => { deleted.push(key); },
      },
    });
    const res = await buildAuthRouter().request('http://localhost/logout', {
      method: 'POST',
      headers: { authorization: 'Bearer native-session-token' },
    }, env);
    expect(res.status).toBe(200);
    expect(deleted).toEqual(['sess:native-session-token']);
  });

  it('POST /logout revokes distinct cookie and bearer sessions together', async () => {
    const deleted: string[] = [];
    const env = fakeEnv({
      CONFIG_KV: {
        get: async () => null,
        put: async () => {},
        delete: async (key: string) => { deleted.push(key); },
      },
    });
    const res = await buildAuthRouter().request('http://localhost/logout', {
      method: 'POST',
      headers: {
        cookie: 'ct_session=cookie-session-token',
        authorization: 'Bearer native-session-token',
      },
    }, env);
    expect(res.status).toBe(200);
    expect(deleted.sort()).toEqual([
      'sess:cookie-session-token',
      'sess:native-session-token',
    ]);
  });

  it('POST /account/delete requires a signed-in session', async () => {
    const app = buildAuthRouter();
    const res = await app.request('http://localhost/account/delete', { method: 'POST' }, fakeEnv());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'sign in required' });
  });

  it('POST /account/delete removes the users row and revokes the session', async () => {
    const users = new Map<string, Record<string, unknown>>([
      ['u1', {
        id: 'u1',
        email: 'gone@example.com',
        name: 'Gone',
        picture: null,
        google_sub: 'g-1',
        apple_sub: 'a-1',
        email_verified: 1,
        created_at: '2026-06-28T00:00:00.000Z',
        last_login_at: '2026-06-28T00:00:00.000Z',
      }],
    ]);
    const kv = new Map<string, string>([['sess:tok', JSON.stringify({ userId: 'u1' })]]);
    const env = fakeEnv({
      CONFIG_KV: {
        get: async (k: string) => (kv.has(k) ? kv.get(k)! : null),
        put: async (k: string, v: string) => {
          kv.set(k, v);
        },
        delete: async (k: string) => {
          kv.delete(k);
        },
      },
      DB: {
        prepare: (sql: string) => {
          const stmt = {
            params: [] as unknown[],
            bind(...params: unknown[]) {
              this.params = params;
              return this;
            },
            async first() {
              if (/FROM users WHERE id/i.test(sql)) {
                return users.get(String(this.params[0])) ?? null;
              }
              return null;
            },
            async run() {
              if (/DELETE FROM users WHERE id/i.test(sql)) {
                users.delete(String(this.params[0]));
                return { success: true, meta: { changes: 1 } };
              }
              return { success: true, meta: { changes: 0 } };
            },
            async all() {
              return { results: [] };
            },
          };
          return stmt;
        },
      },
    });
    const res = await buildAuthRouter().request('http://localhost/account/delete', {
      method: 'POST',
      headers: { authorization: 'Bearer tok' },
    }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, deleted: true, userId: 'u1' });
    expect(users.has('u1')).toBe(false);
    expect(kv.has('sess:tok')).toBe(false);
  });

  it('POST /logout de-duplicates the same cookie and bearer token', async () => {
    const deleted: string[] = [];
    const env = fakeEnv({
      CONFIG_KV: {
        get: async () => null,
        put: async () => {},
        delete: async (key: string) => { deleted.push(key); },
      },
    });
    await buildAuthRouter().request('http://localhost/logout', {
      method: 'POST',
      headers: {
        cookie: 'ct_session=same-token',
        authorization: 'Bearer same-token',
      },
    }, env);
    expect(deleted).toEqual(['sess:same-token']);
  });
});
