/**
 * Stale browser ADMIN_TOKEN must not block an allowlisted Google session.
 *
 * The Review Queue UI stores ADMIN_TOKEN in localStorage and always sends it as
 * Authorization: Bearer …. When that value is wrong/rotated, isAuthorized
 * rejects the bearer — but a valid ct_session cookie for an ADMIN_EMAILS user
 * must still authorize. Regression for the middleware that only resolved
 * sessionEmail when no Authorization header was present.
 *
 * Native iOS sends the same opaque session as Authorization: Bearer <session>
 * (no cookie). Admin middleware + GET /auth/me must resolve that via
 * getCurrentUserFromRequest, not cookie-only getCurrentUser.
 */
import { describe, expect, it } from 'vitest';
import { buildAdminRouter } from '../routes.ts';

const app = buildAdminRouter();

function sessionEnv(email: string) {
  const kv = new Map<string, string>([['sess:admin-sess', JSON.stringify({ userId: 'u-admin' })]]);
  return {
    ADMIN_TOKEN: 'live-admin-secret',
    ADMIN_EMAILS: email,
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
      prepare: (sql: string) => ({
        bind() {
          return this;
        },
        async first() {
          if (!/FROM users/i.test(sql)) return null;
          return {
            id: 'u-admin',
            email,
            name: 'Admin User',
            picture: null,
            google_sub: 'g-admin',
            email_verified: 1,
            created_at: '2026-08-10T00:00:00.000Z',
            last_login_at: '2026-08-10T00:00:00.000Z',
            stripe_customer_id: null,
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
  } as never;
}

describe('admin auth: stale bearer falls through to session', () => {
  it('rejects a wrong bearer alone', async () => {
    const res = await app.request(
      '/config-sources',
      { headers: { Authorization: 'Bearer stale-wrong-token' } },
      sessionEnv('admin@example.com'),
    );
    expect(res.status).toBe(401);
  });

  it('accepts an allowlisted session cookie without any bearer', async () => {
    const res = await app.request(
      '/config-sources',
      { headers: { Cookie: 'ct_session=admin-sess' } },
      sessionEnv('admin@example.com'),
    );
    expect(res.status).toBe(200);
  });

  it('accepts allowlisted session even when Authorization is a stale ADMIN_TOKEN', async () => {
    const res = await app.request(
      '/config-sources',
      {
        headers: {
          Authorization: 'Bearer stale-wrong-token',
          Cookie: 'ct_session=admin-sess',
        },
      },
      sessionEnv('admin@example.com'),
    );
    expect(res.status).toBe(200);
  });

  it('still rejects stale bearer + non-allowlisted session', async () => {
    // Session user email is not-on-list@…; allowlist only has admin@…
    const env = sessionEnv('not-on-list@example.com') as Record<string, unknown>;
    env.ADMIN_EMAILS = 'admin@example.com';
    const res = await app.request(
      '/config-sources',
      {
        headers: {
          Authorization: 'Bearer stale-wrong-token',
          Cookie: 'ct_session=admin-sess',
        },
      },
      env as never,
    );
    expect(res.status).toBe(401);
  });

  it('correct ADMIN_TOKEN still wins without a session', async () => {
    const res = await app.request(
      '/config-sources',
      { headers: { Authorization: 'Bearer live-admin-secret' } },
      sessionEnv('admin@example.com'),
    );
    expect(res.status).toBe(200);
  });

  it('accepts an allowlisted native session as Authorization Bearer', async () => {
    const res = await app.request(
      '/config-sources',
      { headers: { Authorization: 'Bearer admin-sess' } },
      sessionEnv('admin@example.com'),
    );
    expect(res.status).toBe(200);
  });

  it('rejects a non-allowlisted native session bearer', async () => {
    const env = sessionEnv('not-on-list@example.com') as Record<string, unknown>;
    env.ADMIN_EMAILS = 'admin@example.com';
    const res = await app.request(
      '/config-sources',
      { headers: { Authorization: 'Bearer admin-sess' } },
      env as never,
    );
    expect(res.status).toBe(401);
  });
});
