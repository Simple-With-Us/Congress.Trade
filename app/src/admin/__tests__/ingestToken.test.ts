/**
 * src/admin/__tests__/ingestToken.test.ts
 *
 * The scoped INGEST_TOKEN must unlock ONLY POST /securities/import — never any
 * other admin route — and must not weaken the existing ADMIN_TOKEN gate.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { buildAdminRouter } from '../routes.ts';

const app = buildAdminRouter();

afterEach(() => vi.unstubAllGlobals());

function post(path: string, token: string | null, env: Record<string, unknown>, body = '{}', extraHeaders: Record<string, string> = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...extraHeaders };
  if (token) headers.Authorization = `Bearer ${token}`;
  return app.request(path, { method: 'POST', headers, body }, env as never);
}

describe('scoped INGEST_TOKEN', () => {
  const env = { ADMIN_TOKEN: 'admin-secret', INGEST_TOKEN: 'ingest-secret' };

  it('unlocks /securities/import with the ingest token (empty body is a no-op)', async () => {
    const res = await post('/securities/import', 'ingest-secret', env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; refs: number };
    expect(body.ok).toBe(true);
    expect(body.refs).toBe(0);
  });

  it('does NOT unlock other admin routes with the ingest token', async () => {
    const res = await post('/reprocess', 'ingest-secret', env);
    expect(res.status).toBe(401);
  });

  it('still rejects a bad token on the import endpoint', async () => {
    const res = await post('/securities/import', 'nope', env);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { reason?: string };
    expect(body.reason).toBe('ingest_bearer_mismatch_or_admin_required');
  });

  it('admin token continues to work on the import endpoint', async () => {
    const res = await post('/securities/import', 'admin-secret', env);
    expect(res.status).toBe(200);
  });

  it('ignores the ingest path when INGEST_TOKEN is unset', async () => {
    const res = await post('/securities/import', 'ingest-secret', { ADMIN_TOKEN: 'admin-secret' });
    expect(res.status).toBe(401);
  });

  it('fails closed when no admin auth mechanism is configured', async () => {
    const res = await post('/securities/import', null, {});
    expect(res.status).toBe(401);
  });

  it('opens only when the local dev override is explicit', async () => {
    const res = await post('/securities/import', null, { ADMIN_OPEN_IN_DEV: 'true' });
    expect(res.status).toBe(200);
  });

  it('stays closed when Infisical resolves SENTRY_ENVIRONMENT to production, even with the dev override set', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).endsWith('/api/v1/auth/universal-auth/login')) {
          return Response.json({ accessToken: 'infisical-token' });
        }
        if (String(url).includes('/api/v3/secrets/raw')) {
          return Response.json({ secrets: [{ secretKey: 'SENTRY_ENVIRONMENT', secretValue: 'production' }] });
        }
        return new Response('not found', { status: 404 });
      }),
    );
    const res = await post('/securities/import', null, {
      ADMIN_OPEN_IN_DEV: 'true',
      // No raw env.SENTRY_ENVIRONMENT set here — the 'production' verdict must
      // come from the resolveSecret-backed Infisical value, proving
      // isExplicitOpenAdmin() no longer reads env.SENTRY_ENVIRONMENT directly.
      INFISICAL_BASE_URL: 'https://infisical.test',
      INFISICAL_ENV: 'prod',
      INFISICAL_APP_PROJECT_ID: 'admin-open-dev',
      INFISICAL_APP_CLIENT_ID: 'app-client',
      INFISICAL_APP_CLIENT_SECRET: 'app-secret',
    });
    expect(res.status).toBe(401);
  });

  it('uses paid-plan import size defaults unless overridden', async () => {
    const res = await post(
      '/securities/import',
      'ingest-secret',
      env,
      '{}',
      { 'content-length': '1000000' },
    );
    expect(res.status).toBe(200);
  });

  it('lets env vars lower import caps for a lean profile', async () => {
    const body = JSON.stringify({ prices: [{ ticker: 'A' }, { ticker: 'B' }, { ticker: 'C' }, { ticker: 'D' }] });
    const res = await post('/securities/import', 'ingest-secret', { ...env, IMPORT_MAX_PRICES: '3' }, body);
    expect(res.status).toBe(413);
    const json = (await res.json()) as { limits: { prices: number } };
    expect(json.limits.prices).toBe(3);
  });

  it('resolves import caps from Infisical secrets, overriding the env/wrangler.toml fallback', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).endsWith('/api/v1/auth/universal-auth/login')) {
          return Response.json({ accessToken: 'infisical-token' });
        }
        if (String(url).includes('/api/v3/secrets/raw')) {
          return Response.json({
            secrets: [
              { secretKey: 'INGEST_TOKEN', secretValue: 'ingest-secret' },
              { secretKey: 'IMPORT_MAX_PRICES', secretValue: '3' },
            ],
          });
        }
        return new Response('not found', { status: 404 });
      }),
    );
    const body = JSON.stringify({ prices: [{ ticker: 'A' }, { ticker: 'B' }, { ticker: 'C' }, { ticker: 'D' }] });
    const res = await post(
      '/securities/import',
      'ingest-secret',
      {
        ADMIN_TOKEN: 'admin-secret',
        // wrangler.toml-backed fallback value; must be overridden by the
        // Infisical-provided '3' above, proving importLimits() is now
        // resolveSecret-backed rather than reading env.IMPORT_MAX_PRICES directly.
        IMPORT_MAX_PRICES: '250',
        INFISICAL_BASE_URL: 'https://infisical.test',
        INFISICAL_ENV: 'prod',
        INFISICAL_APP_PROJECT_ID: 'admin-import-limits',
        INFISICAL_APP_CLIENT_ID: 'app-client',
        INFISICAL_APP_CLIENT_SECRET: 'app-secret',
      },
      body,
    );
    expect(res.status).toBe(413);
    const json = (await res.json()) as { limits: { prices: number } };
    expect(json.limits.prices).toBe(3);
  });
});
