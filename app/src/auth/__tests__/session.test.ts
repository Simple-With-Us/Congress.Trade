import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import {
  createSession,
  resolveSession,
  destroySession,
  destroySessionsForUser,
  getCurrentUserFromRequest,
  getSessionTokensFromRequest,
  getSafeRedirectUrl,
  setSessionCookie,
  clearSessionCookie,
} from '../session.ts';
import type { Env } from '../../shared/types.ts';

function fakeEnv(user?: { id: string }) {
  const kv = new Map<string, string>();
  const prepare = (sql: string) => ({
    _p: [] as unknown[],
    bind(...p: unknown[]) {
      this._p = p;
      return this;
    },
    async first<T>() {
      if (/FROM users WHERE id/i.test(sql) && user && this._p[0] === user.id) {
        return {
          id: user.id,
          email: 'u@e.com',
          name: null,
          picture: null,
          google_sub: null,
          email_verified: 1,
          created_at: 'now',
          last_login_at: null,
        } as unknown as T;
      }
      return null as T | null;
    },
    async run() {
      return { success: true } as unknown;
    },
    async all<T>() {
      return { results: [] as T[] };
    },
  });
  const env = {
    DB: { prepare } as unknown as D1Database,
    CONFIG_KV: {
      get: async (k: string) => (kv.has(k) ? kv.get(k)! : null),
      put: async (k: string, v: string) => {
        kv.set(k, v);
      },
      delete: async (k: string) => {
        kv.delete(k);
      },
    },
  } as unknown as Env;
  return { env, kv };
}

describe('sessions', () => {
  it('create -> resolve returns the fresh user', async () => {
    const { env } = fakeEnv({ id: 'user-1' });
    const token = await createSession(env, 'user-1');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const u = await resolveSession(env, token);
    expect(u?.id).toBe('user-1');
    expect(u?.email).toBe('u@e.com');
    expect(u?.emailVerified).toBe(true);
  });

  it('resolve returns null for missing / unknown tokens', async () => {
    const { env } = fakeEnv({ id: 'user-1' });
    expect(await resolveSession(env, undefined)).toBeNull();
    expect(await resolveSession(env, 'nope')).toBeNull();
  });

  it('destroy removes the session', async () => {
    const { env } = fakeEnv({ id: 'user-1' });
    const token = await createSession(env, 'user-1');
    await destroySession(env, token);
    expect(await resolveSession(env, token)).toBeNull();
  });

  it('destroySessionsForUser revokes every indexed token for that user', async () => {
    const { env } = fakeEnv({ id: 'user-1' });
    const first = await createSession(env, 'user-1');
    const second = await createSession(env, 'user-1');
    expect(await destroySessionsForUser(env, 'user-1')).toBe(2);
    expect(await resolveSession(env, first)).toBeNull();
    expect(await resolveSession(env, second)).toBeNull();
  });

  it('resolves bearer sessions for native clients', async () => {
    const { env } = fakeEnv({ id: 'user-1' });
    const token = await createSession(env, 'user-1');
    const app = new Hono<{ Bindings: Env }>();
    app.get('/me', async (c) => c.json({ user: await getCurrentUserFromRequest(c) }));

    const res = await app.request('http://localhost/me', { headers: { authorization: `Bearer ${token}` } }, env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: { id: string } }).user.id).toBe('user-1');
  });

  it('logout revokes duplicate legacy + host-only session cookies together', async () => {
    const { env } = fakeEnv({ id: 'user-1' });
    const legacyToken = await createSession(env, 'user-1');
    const hostOnlyToken = await createSession(env, 'user-1');
    const app = new Hono<{ Bindings: Env }>();
    app.post('/logout', async (c) => {
      const tokens = getSessionTokensFromRequest(c);
      await Promise.all(tokens.map((token) => destroySession(c.env, token)));
      return c.json({ revoked: tokens.length });
    });

    // A migrating browser sends both the old Domain=apex cookie and the new
    // host-only cookie under the same name; both KV sessions must die.
    const res = await app.request('http://localhost/logout', {
      method: 'POST',
      headers: { Cookie: `ct_session=${legacyToken}; ct_session=${hostOnlyToken}` },
    }, env);
    expect(((await res.json()) as { revoked: number }).revoked).toBe(2);
    expect(await resolveSession(env, legacyToken)).toBeNull();
    expect(await resolveSession(env, hostOnlyToken)).toBeNull();
  });
});

describe('host-only session cookies (CT-AUD-007)', () => {
  it('setSessionCookie emits no Domain attribute', async () => {
    const { env } = fakeEnv({ id: 'user-1' });
    (env as any).APP_BASE_URL = 'https://congress.trade';
    const app = new Hono<{ Bindings: Env }>();
    app.get('/login', async (c) => {
      await setSessionCookie(c, 'tok');
      return c.json({ ok: true });
    });

    const res = await app.request('https://congress.trade/login', {}, env);
    const hostOnly = res.headers.getSetCookie().find((v) => v.startsWith('ct_session=tok')) ?? '';
    expect(hostOnly).toContain('HttpOnly');
    expect(hostOnly.toLowerCase()).not.toContain('domain=');
  });

  it('setSessionCookie expires the legacy Domain-scoped cookie', async () => {
    const { env } = fakeEnv({ id: 'user-1' });
    (env as any).APP_BASE_URL = 'https://congress.trade';
    const app = new Hono<{ Bindings: Env }>();
    app.get('/login', async (c) => {
      await setSessionCookie(c, 'replacement-token');
      return c.json({ ok: true });
    });

    const res = await app.request('https://www.congress.trade/login', {}, env);
    const cookies = res.headers.getSetCookie();
    const hostOnlyIndex = cookies.findIndex((v) => v.startsWith('ct_session=replacement-token') && !/domain=/i.test(v));
    const legacyIndex = cookies.findIndex((v) => /domain=congress\.trade/i.test(v) && /max-age=0/i.test(v));
    expect(hostOnlyIndex).toBeGreaterThanOrEqual(0);
    expect(legacyIndex).toBeGreaterThanOrEqual(0);
    expect(legacyIndex).toBeLessThan(hostOnlyIndex);
  });

  it('clearSessionCookie evicts host-only and legacy Domain-scoped cookies', async () => {
    const { env } = fakeEnv({ id: 'user-1' });
    (env as any).APP_BASE_URL = 'https://congress.trade';
    const app = new Hono<{ Bindings: Env }>();
    app.post('/logout', async (c) => {
      await clearSessionCookie(c);
      return c.json({ ok: true });
    });

    const res = await app.request('https://congress.trade/logout', { method: 'POST' }, env);
    const cookies = res.headers.getSetCookie();
    const hostOnly = cookies.find((v) => v.startsWith('ct_session=') && !/domain=/i.test(v));
    const legacy = cookies.find((v) => /domain=congress\.trade/i.test(v));
    expect(hostOnly).toContain('Max-Age=0');
    expect(legacy).toContain('Max-Age=0');
  });
});

describe('session cookie Secure flag behind the proxy (CT-AUD-P0-3)', () => {
  // The existing host-only tests all request an https:// URL, which
  // short-circuits isSecureRequestParts on the `u.protocol === 'https:'`
  // branch — so they pass identically against the OLD socket-URL inference and
  // cannot detect the regression. Production never looks like that: Deno.serve
  // binds plain :5000 inside the container behind Caddy, so the socket URL is
  // always http: and the truth is in X-Forwarded-Proto. These two tests pin the
  // 30-day session cookie — the highest-value credential in the app — to the
  // real production request shape.
  function appFor(env: Env) {
    const app = new Hono<{ Bindings: Env }>();
    app.get('/login', async (c) => {
      await setSessionCookie(c, 'tok');
      return c.json({ ok: true });
    });
    return app;
  }

  it('marks ct_session Secure for a proxied https request over a plaintext socket', async () => {
    const { env } = fakeEnv({ id: 'user-1' });
    (env as any).APP_BASE_URL = 'https://congress.trade';

    const res = await appFor(env).request(
      'http://127.0.0.1:5000/login',
      { headers: { Host: 'congress.trade', 'X-Forwarded-Proto': 'https' } },
      env,
    );

    const cookie = res.headers.getSetCookie().find((v) => v.startsWith('ct_session=tok')) ?? '';
    expect(cookie, 'no ct_session cookie was emitted').not.toBe('');
    expect(cookie).toMatch(/;\s*Secure/i);
  });

  it('still omits Secure for local development over plaintext localhost', async () => {
    const { env } = fakeEnv({ id: 'user-1' });
    (env as any).APP_BASE_URL = 'http://localhost:8787';

    const res = await appFor(env).request('http://localhost:8787/login', {}, env);

    const cookie = res.headers.getSetCookie().find((v) => v.startsWith('ct_session=tok')) ?? '';
    expect(cookie).not.toBe('');
    expect(cookie).not.toMatch(/;\s*Secure/i);
  });
});

describe('getSafeRedirectUrl (exact-origin allowlist)', () => {
  const base = 'https://congress.trade';

  it('allows the exact configured origin and local dev', () => {
    expect(getSafeRedirectUrl('https://congress.trade/path', base)).toBe('https://congress.trade/path');
    expect(getSafeRedirectUrl('http://localhost:8787/path', base)).toBe('http://localhost:8787/path');
    expect(getSafeRedirectUrl('http://127.0.0.1:8787/path', base)).toBe('http://127.0.0.1:8787/path');
  });

  it('rejects hostile sibling subdomains and lookalike hosts', () => {
    expect(getSafeRedirectUrl('https://evil.congress.trade/steal', base)).toBe(base);
    expect(getSafeRedirectUrl('https://admin.congress.trade/path', base)).toBe(base);
    expect(getSafeRedirectUrl('https://congress.trade.evil.com/path', base)).toBe(base);
    expect(getSafeRedirectUrl('https://malicious.com/path', base)).toBe(base);
  });

  it('rejects scheme downgrades, garbage, and empty values', () => {
    expect(getSafeRedirectUrl('http://congress.trade/path', base)).toBe(base);
    expect(getSafeRedirectUrl('not a url', base)).toBe(base);
    expect(getSafeRedirectUrl(undefined, base)).toBe(base);
  });
});
