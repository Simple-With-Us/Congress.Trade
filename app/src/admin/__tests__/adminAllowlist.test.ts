/**
 * src/admin/__tests__/adminAllowlist.test.ts
 *
 * End-to-end coverage for the persisted admin allowlist (grant/revoke a
 * user's admin access) — POST /api/admin/admins/grant, POST
 * /api/admin/admins/revoke, GET /api/admin/admins, and how a grant/revoke
 * flows through to GET /auth/me's `admin.allowed` for the granted email.
 *
 * Uses a real SQLite-backed D1 stand-in (node:sqlite) rather than a
 * regex-sniffing mock, because the last-admin guard and the
 * ADMIN_EMAILS-is-not-editable-here guard both depend on real row counts.
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { buildAdminRouter } from '../routes.ts';
import { buildAuthRouter } from '../../auth/routes.ts';

const SCHEMA_SQL = `
CREATE TABLE admin_allowlist (
  email       TEXT PRIMARY KEY,
  granted_by  TEXT NOT NULL,
  granted_at  TEXT NOT NULL
);
CREATE TABLE admin_access_audit (
  id         TEXT PRIMARY KEY,
  action     TEXT NOT NULL,
  email      TEXT NOT NULL,
  actor      TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE users (
  id                 TEXT PRIMARY KEY,
  email              TEXT NOT NULL UNIQUE,
  name               TEXT,
  picture            TEXT,
  google_sub         TEXT,
  email_verified     INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  last_login_at      TEXT,
  stripe_customer_id TEXT
);
CREATE TABLE apple_subscriptions (
  user_id      TEXT,
  status       TEXT,
  expires_date TEXT,
  updated_at   TEXT
);
`;

function coerceParam(value: unknown): SQLInputValue {
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value as SQLInputValue;
}

function makeDb() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(SCHEMA_SQL);
  const d1 = {
    prepare(sql: string) {
      let boundParams: unknown[] = [];
      const api = {
        bind(...params: unknown[]) {
          boundParams = params;
          return api;
        },
        async all<T>() {
          return { results: raw.prepare(sql).all(...boundParams.map(coerceParam)) as unknown as T[] };
        },
        async first<T>() {
          return (raw.prepare(sql).get(...boundParams.map(coerceParam)) ?? null) as unknown as T | null;
        },
        async run() {
          const info = raw.prepare(sql).run(...boundParams.map(coerceParam));
          return { success: true, meta: { changes: Number(info.changes) } };
        },
      };
      return api;
    },
  };
  return { raw, d1 };
}

function makeKv() {
  const kv = new Map<string, string>();
  return {
    kv,
    binding: {
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

function insertUser(raw: DatabaseSync, opts: { id: string; email: string }): void {
  raw
    .prepare(
      `INSERT INTO users (id, email, name, picture, google_sub, email_verified, created_at, last_login_at)
       VALUES (?, ?, NULL, NULL, ?, 1, ?, ?)`,
    )
    .run(opts.id, opts.email, `g-${opts.id}`, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
}

describe('admin allowlist: grant/revoke', () => {
  it('rejects grant and revoke from a non-admin session (401)', async () => {
    const { d1 } = makeDb();
    const { binding: CONFIG_KV } = makeKv();
    const admin = buildAdminRouter();
    const env = { ADMIN_TOKEN: 'admin-secret', ADMIN_EMAILS: 'root@example.com', DB: d1, CONFIG_KV } as never;

    const grant = await admin.request(
      '/admins/grant',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'new@example.com' }) },
      env,
    );
    expect(grant.status).toBe(401);

    const revoke = await admin.request(
      '/admins/revoke',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'root@example.com' }) },
      env,
    );
    expect(revoke.status).toBe(401);
  });

  it('a bearer-authenticated grant creates the row, and the email becomes admin on its next GET /auth/me', async () => {
    const { raw, d1 } = makeDb();
    const { kv, binding: CONFIG_KV } = makeKv();
    const admin = buildAdminRouter();
    const auth = buildAuthRouter();
    const env = { ADMIN_TOKEN: 'admin-secret', ADMIN_EMAILS: 'root@example.com', DB: d1, CONFIG_KV } as never;

    insertUser(raw, { id: 'u-new', email: 'new@example.com' });
    kv.set('sess:tok-new', JSON.stringify({ userId: 'u-new' }));

    const before = await auth.request('/me', { headers: { cookie: 'ct_session=tok-new' } }, env);
    expect((await before.json() as { admin: { allowed: boolean } }).admin.allowed).toBe(false);

    const grant = await admin.request(
      '/admins/grant',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'new@example.com' }),
      },
      env,
    );
    expect(grant.status).toBe(200);
    expect(await grant.json()).toMatchObject({
      ok: true,
      granted: [{ email: 'new@example.com', grantedBy: 'admin-token' }],
    });

    const after = await auth.request('/me', { headers: { cookie: 'ct_session=tok-new' } }, env);
    expect((await after.json() as { admin: { allowed: boolean } }).admin.allowed).toBe(true);

    // Audit trail: who, which email, when, and action.
    const audit = raw.prepare('SELECT action, email, actor FROM admin_access_audit').all() as Array<{
      action: string;
      email: string;
      actor: string;
    }>;
    expect(audit).toEqual([{ action: 'grant', email: 'new@example.com', actor: 'admin-token' }]);

    const revoke = await admin.request(
      '/admins/revoke',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'new@example.com' }),
      },
      env,
    );
    expect(revoke.status).toBe(200);

    const afterRevoke = await auth.request('/me', { headers: { cookie: 'ct_session=tok-new' } }, env);
    expect((await afterRevoke.json() as { admin: { allowed: boolean } }).admin.allowed).toBe(false);
  });

  it('matches emails case-insensitively on grant, revoke, and lookup', async () => {
    const { raw, d1 } = makeDb();
    const { kv, binding: CONFIG_KV } = makeKv();
    const admin = buildAdminRouter();
    const auth = buildAuthRouter();
    const env = { ADMIN_TOKEN: 'admin-secret', ADMIN_EMAILS: 'root@example.com', DB: d1, CONFIG_KV } as never;

    insertUser(raw, { id: 'u-mixed', email: 'mixed@example.com' });
    kv.set('sess:tok-mixed', JSON.stringify({ userId: 'u-mixed' }));

    const grant = await admin.request(
      '/admins/grant',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'Mixed@Example.COM' }),
      },
      env,
    );
    expect(grant.status).toBe(200);

    const row = raw.prepare('SELECT email FROM admin_allowlist').get() as { email: string };
    expect(row.email).toBe('mixed@example.com');

    const me = await auth.request('/me', { headers: { cookie: 'ct_session=tok-mixed' } }, env);
    expect((await me.json() as { admin: { allowed: boolean } }).admin.allowed).toBe(true);

    const revoke = await admin.request(
      '/admins/revoke',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'MIXED@example.com' }),
      },
      env,
    );
    expect(revoke.status).toBe(200);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM admin_allowlist').get()).toEqual({ n: 0 });
  });

  it('refuses to revoke an ADMIN_EMAILS address — it stays admin', async () => {
    const { raw, d1 } = makeDb();
    const { binding: CONFIG_KV } = makeKv();
    const admin = buildAdminRouter();
    const env = { ADMIN_TOKEN: 'admin-secret', ADMIN_EMAILS: 'root@example.com', DB: d1, CONFIG_KV } as never;

    const revoke = await admin.request(
      '/admins/revoke',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'root@example.com' }),
      },
      env,
    );
    expect(revoke.status).toBe(400);
    expect(await revoke.json()).toMatchObject({
      error: expect.stringContaining('not editable here'),
    });

    const list = await admin.request('/admins', { headers: { Authorization: 'Bearer admin-secret' } }, env);
    expect(await list.json()).toMatchObject({ adminEmails: ['root@example.com'], granted: [], total: 1 });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM admin_access_audit').get()).toEqual({ n: 0 });
  });

  it('refuses to grant an email already covered by ADMIN_EMAILS', async () => {
    const { d1 } = makeDb();
    const { binding: CONFIG_KV } = makeKv();
    const admin = buildAdminRouter();
    const env = { ADMIN_TOKEN: 'admin-secret', ADMIN_EMAILS: 'root@example.com', DB: d1, CONFIG_KV } as never;

    const grant = await admin.request(
      '/admins/grant',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'ROOT@example.com' }),
      },
      env,
    );
    expect(grant.status).toBe(400);
    expect(await grant.json()).toMatchObject({ error: expect.stringContaining('already an admin via ADMIN_EMAILS') });
  });

  it('refuses to revoke the last remaining admin (no ADMIN_EMAILS configured)', async () => {
    const { raw, d1 } = makeDb();
    const { binding: CONFIG_KV } = makeKv();
    const admin = buildAdminRouter();
    // No ADMIN_EMAILS: the persisted grant below is the ONLY admin.
    const env = { ADMIN_TOKEN: 'admin-secret', DB: d1, CONFIG_KV } as never;

    await admin.request(
      '/admins/grant',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'sole@example.com' }),
      },
      env,
    );

    const revoke = await admin.request(
      '/admins/revoke',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'sole@example.com' }),
      },
      env,
    );
    expect(revoke.status).toBe(400);
    expect(await revoke.json()).toMatchObject({ error: expect.stringContaining('last remaining admin') });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM admin_allowlist').get()).toEqual({ n: 1 });
  });

  it('allows revoking one of two granted admins, then refuses the final one', async () => {
    const { d1 } = makeDb();
    const { binding: CONFIG_KV } = makeKv();
    const admin = buildAdminRouter();
    const env = { ADMIN_TOKEN: 'admin-secret', DB: d1, CONFIG_KV } as never;

    for (const email of ['first@example.com', 'second@example.com']) {
      await admin.request(
        '/admins/grant',
        {
          method: 'POST',
          headers: { Authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
          body: JSON.stringify({ email }),
        },
        env,
      );
    }

    const firstRevoke = await admin.request(
      '/admins/revoke',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'first@example.com' }),
      },
      env,
    );
    expect(firstRevoke.status).toBe(200);

    const secondRevoke = await admin.request(
      '/admins/revoke',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'second@example.com' }),
      },
      env,
    );
    expect(secondRevoke.status).toBe(400);
    expect(await secondRevoke.json()).toMatchObject({ error: expect.stringContaining('last remaining admin') });
  });

  it('rejects an invalid email and a missing email on grant', async () => {
    const { d1 } = makeDb();
    const { binding: CONFIG_KV } = makeKv();
    const admin = buildAdminRouter();
    const env = { ADMIN_TOKEN: 'admin-secret', DB: d1, CONFIG_KV } as never;

    const missing = await admin.request(
      '/admins/grant',
      { method: 'POST', headers: { Authorization: 'Bearer admin-secret', 'content-type': 'application/json' }, body: JSON.stringify({}) },
      env,
    );
    expect(missing.status).toBe(400);

    const invalid = await admin.request(
      '/admins/grant',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'not-an-email' }),
      },
      env,
    );
    expect(invalid.status).toBe(400);
  });
});
