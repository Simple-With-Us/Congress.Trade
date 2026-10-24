import { describe, expect, it } from 'vitest';
import { buildAdminRouter } from '../routes.ts';

const app = buildAdminRouter();

const SECRET_VALUE = 'sk-super-secret-value-must-never-leak';

function env() {
  return {
    ADMIN_TOKEN: 'admin-secret',
    FMP_API_KEY: SECRET_VALUE,
    SCRAPE_GUARD_ENABLED: 'true',
  } as never;
}

describe('GET /config-sources (single-source-of-truth audit)', () => {
  it('reports per-key live source without ever exposing values', async () => {
    const res = await app.request(
      '/config-sources',
      { headers: { Authorization: 'Bearer admin-secret' } },
      env(),
    );
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain(SECRET_VALUE);
    expect(raw).not.toContain('admin-secret');
    const body = JSON.parse(raw) as {
      resolver: { enabled: boolean };
      items: Array<{ key: string; category: string; source: string }>;
      envOnly: Array<{ key: string; configured: boolean }>;
      bootstrap: Array<{ key: string; configured: boolean }>;
    };
    // No Infisical configured in this env -> resolver disabled, env fallback wins.
    expect(body.resolver.enabled).toBe(false);
    const fmp = body.items.find((i) => i.key === 'FMP_API_KEY');
    expect(fmp).toMatchObject({ category: 'provider-keys', source: 'env' });
    const stripe = body.items.find((i) => i.key === 'STRIPE_SECRET_KEY');
    expect(stripe?.source).toBe('missing');
    const guard = body.items.find((i) => i.key === 'SCRAPE_GUARD_ENABLED');
    expect(guard?.source).toBe('env');
    // Env-only + bootstrap registries are present (names only).
    expect(body.envOnly.map((e) => e.key)).toContain('SENTRY_DSN');
    expect(body.items.some((i) => i.key === 'DD_API_KEY' && i.category === 'integrations')).toBe(true);
    expect(body.items.some((i) => i.key === 'DD_SITE' && i.category === 'integrations')).toBe(true);
    expect(body.items.some((i) => i.key === 'DD_CLIENT_TOKEN' && i.category === 'integrations')).toBe(true);
    expect(body.bootstrap.map((e) => e.key)).toContain('INFISICAL_APP_CLIENT_ID');
    // The knobs consolidated in this change are all in the registry.
    for (const key of [
      'ST_PEER_MAX_PER_MINUTE', 'FMP_MAX_PER_MINUTE', 'EDGAR_MAX_PER_MINUTE', 'DISCLOSURE_LATENCY_PROVIDERS',
      'SEED_HOUSE_URL', 'HOUSE_LIVE_SEARCH_ENABLED', 'ARBITRATION_ENABLED',
      'VISION_PRIMARY_MODEL', 'ADMIN_OPEN_IN_DEV',
    ]) {
      expect(body.items.some((i) => i.key === key)).toBe(true);
    }
  });

  it('stays behind admin auth', async () => {
    const res = await app.request('/config-sources', {}, env());
    expect(res.status).toBe(401);
  });
});
