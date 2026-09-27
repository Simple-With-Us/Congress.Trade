/**
 * src/ui/__tests__/routes.test.ts
 *
 * SEOSOCIAL-01 / SEOSOCIAL-03: robots.txt keeps the AI-crawler blocks and the
 * general `Disallow: /api/`, but re-opens the specific read-only render
 * paths the SPA needs so Googlebot/Bingbot can actually see rendered
 * content — and points crawlers at the new sitemap. `/sitemap.xml` is wired
 * through to the sitemap module and never 500s even with no DB.
 */

import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { buildUiRouter } from '../routes.ts';
import { browserSecurityHeadersMiddleware } from '../../security/headers.ts';
import { resetSitemapCacheForTests } from '../sitemap.ts';

describe('/robots.txt', () => {
  it('allows the read-only render paths the SPA needs under the general Disallow: /api/', async () => {
    const app = buildUiRouter();
    const res = await app.request('http://localhost/robots.txt', {}, {} as never);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const body = await res.text();

    const wildcardGroup = body.slice(0, body.indexOf('User-Agent: GPTBot'));
    expect(wildcardGroup).toContain('User-Agent: *');
    expect(wildcardGroup).toContain('Allow: /api/analytics/');
    expect(wildcardGroup).toContain('Allow: /api/transactions');
    expect(wildcardGroup).toContain('Allow: /api/photos/');
    expect(wildcardGroup).toContain('Allow: /api/logos/');
    expect(wildcardGroup).toContain('Allow: /api/feed.xml');
    // The general block stays — only the specific render paths are re-opened.
    expect(wildcardGroup).toContain('Disallow: /api/');
  });

  it('still blocks every AI/LLM crawler outright (unchanged policy)', async () => {
    const app = buildUiRouter();
    const res = await app.request('http://localhost/robots.txt', {}, {} as never);
    const body = await res.text();
    const aiGroup = body.slice(body.indexOf('User-Agent: GPTBot'));
    expect(aiGroup).toContain('User-Agent: GPTBot');
    expect(aiGroup).toContain('User-Agent: ClaudeBot');
    expect(aiGroup).toContain('User-Agent: anthropic-ai');
    expect(aiGroup.trim().endsWith('Disallow: /')).toBe(false); // Sitemap: line follows
    expect(aiGroup).toMatch(/Disallow: \/\s*\n\s*\nSitemap: /);
  });

  it('points crawlers at the sitemap', async () => {
    const app = buildUiRouter();
    const res = await app.request('http://localhost/robots.txt', {}, {} as never);
    const body = await res.text();
    expect(body).toContain('Sitemap: https://congress.trade/sitemap.xml');
  });
});

describe('/sitemap.xml', () => {
  it('serves a cached, valid XML sitemap even with no DB binding', async () => {
    resetSitemapCacheForTests();
    const app = buildUiRouter();
    const res = await app.request('http://localhost/sitemap.xml', {}, {} as never);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/xml');
    expect(res.headers.get('cache-control')).toContain('max-age=3600');
    const body = await res.text();
    expect(body).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(body).toContain('<loc>https://congress.trade/</loc>');
  });
});

describe('SEOSOCIAL-05: ?trade= permalinks get a real share card', () => {
  function dbEnv(row: Record<string, unknown> | null) {
    return {
      DB: {
        prepare: () => ({
          bind() {
            return this;
          },
          async first() {
            return row;
          },
        }),
      },
    } as never;
  }

  it('renders filer + verb + ticker + bracket + date from the joined transaction/filer row', async () => {
    const env = dbEnv({
      tx_type: 'B',
      ticker: 'nvda',
      asset_name: 'NVIDIA Corp',
      amount_min: 1_000_001,
      amount_max: 5_000_000,
      tx_date: '2026-08-05',
      filer_id: 'P000197',
      full_name: 'Nancy Pelosi',
      chamber: 'house',
      party: 'Democrat',
      state: 'CA',
      district: '11',
    });
    const app = buildUiRouter();
    const res = await app.request('http://localhost/?trade=aa349372-0000', {}, env);
    const html = await res.text();
    expect(html).toContain('content="Nancy Pelosi (D-CA-11) bought NVDA ($1m - $5m) · Aug 5, 2026"');
    expect(html).toContain('og-image-company.png');
  });

  it('falls back to the default card for an unresolved trade id (never 500s)', async () => {
    const env = dbEnv(null);
    const app = buildUiRouter();
    const res = await app.request('http://localhost/?trade=does-not-exist', {}, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('content="Congress.Trade"');
  });

  it('never throws when the DB query itself throws', async () => {
    const env = {
      DB: {
        prepare: () => ({
          bind() {
            return this;
          },
          async first() {
            throw new Error('D1 unavailable');
          },
        }),
      },
    } as never;
    const app = buildUiRouter();
    const res = await app.request('http://localhost/?trade=aa349372-0000', {}, env);
    expect(res.status).toBe(200);
  });
});

describe('Datadog RUM injection', () => {
  it('leaves public HTML without a RUM snippet when keys are missing', async () => {
    const app = buildUiRouter();
    const home = await app.request('http://localhost/', {}, {} as never);
    const legal = await app.request('http://localhost/privacy-policy', {}, {} as never);
    const homeHtml = await home.text();
    const legalHtml = await legal.text();
    expect(homeHtml).not.toContain('%GA_SCRIPT%');
    expect(homeHtml).not.toContain('DD_RUM');
    expect(legalHtml).not.toContain('DD_RUM');
  });

  it('injects RUM on public pages when client token, application id, and site exist', async () => {
    const env = {
      DD_CLIENT_TOKEN: 'pub_token',
      DD_APPLICATION_ID: 'app-id-1',
      DD_SITE: 'us5.datadoghq.com',
      DD_API_KEY: 'secret-api-key-must-not-leak',
    } as never;
    const app = buildUiRouter();
    const home = await app.request('http://localhost/', {}, env);
    const legal = await app.request('http://localhost/terms-of-service', {}, env);
    const homeHtml = await home.text();
    const legalHtml = await legal.text();
    expect(homeHtml).toContain('DD_RUM');
    expect(homeHtml).toContain('pub_token');
    expect(homeHtml).toContain('www.datadoghq-browser-agent.com/us5/v5/datadog-rum.js');
    expect(homeHtml).not.toContain('secret-api-key-must-not-leak');
    expect(legalHtml).toContain('DD_RUM');
    expect(legalHtml).not.toContain('secret-api-key-must-not-leak');

    const wrapped = new Hono();
    wrapped.use('*', browserSecurityHeadersMiddleware);
    wrapped.route('/', app);
    const guarded = await wrapped.request('http://localhost/', {}, env);
    const csp = guarded.headers.get('content-security-policy') ?? '';
    expect(csp).toContain('https://www.datadoghq-browser-agent.com');
    expect(csp).toContain('https://browser-intake-us5-datadoghq.com');
  });
});

describe('iOS Beta / TestFlight redirect routes', () => {
  it('uses the app-specific invitation when no install URL is configured', async () => {
    const app = buildUiRouter();
    for (const path of ['/beta', '/testflight', '/ios', '/app']) {
      const res = await app.request(`http://localhost${path}`, {}, {} as never);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('https://testflight.apple.com/join/VNUEU6Ge');
    }
  });

  it.each([
    'https://testflight.apple.com/',
    'https://testflight.apple.com/join/trade.congress.ios',
    'http://testflight.apple.com/join/VNUEU6Ge',
    'https://example.com/install',
    'not a URL',
  ])('does not advertise an invalid configured install destination: %s', async (url) => {
    const app = buildUiRouter();
    const res = await app.request('http://localhost/beta', {}, { IOS_TESTFLIGHT_URL: url } as never);
    expect(res.headers.get('location')).toBe('https://testflight.apple.com/join/VNUEU6Ge');
  });

  it('redirects /beta, /testflight, /ios, /app to the configured TestFlight or App Store URL', async () => {
    const app = buildUiRouter();
    const env = { IOS_TESTFLIGHT_URL: 'https://testflight.apple.com/join/xyz123' } as never;

    for (const path of ['/beta', '/testflight', '/ios', '/app']) {
      const res = await app.request(`http://localhost${path}`, {}, env);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('https://testflight.apple.com/join/xyz123');
    }
  });

  it('falls back to App Store when IOS_APP_STORE_ID is set without custom TestFlight URL', async () => {
    const app = buildUiRouter();
    const env = { IOS_APP_STORE_ID: '6798076688' } as never;
    const res = await app.request('http://localhost/beta', {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://apps.apple.com/app/id6798076688');
  });
});

