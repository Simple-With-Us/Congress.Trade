import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { browserSecurityHeaders, browserSecurityHeadersMiddleware, buildContentSecurityPolicy } from '../headers.ts';

describe('browserSecurityHeaders', () => {
  it('sets clickjacking, MIME, referrer, permissions, and CSP defenses', () => {
    const headers = browserSecurityHeaders('https://congress.trade/');
    expect(headers.get('x-frame-options')).toBe('DENY');
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(headers.get('permissions-policy')).toContain('camera=()');
    expect(headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(headers.get('content-security-policy')).toContain("connect-src 'self' https://cloudflareinsights.com https://static.cloudflareinsights.com");
    expect(headers.get('content-security-policy')).toContain('https://static.cloudflareinsights.com');
  });

  it('sets HSTS only for HTTPS requests', () => {
    expect(browserSecurityHeaders('https://congress.trade/').get('strict-transport-security')).toBe(
      'max-age=31536000',
    );
    expect(browserSecurityHeaders('http://localhost:8787/').get('strict-transport-security')).toBeNull();
  });

  it('documents only the current inline dashboard exceptions', () => {
    const csp = browserSecurityHeaders('https://congress.trade/').get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("object-src 'none'");
    // worker-src is locked down to 'none' when Sentry is not enabled.
    expect(csp).toContain("worker-src 'none'");
    expect(csp).not.toContain('*');
  });

  it('no longer carries the Google Fonts exceptions now that fonts are self-hosted (QABUGHUNT-01 / WEBPERF-01)', () => {
    const csp = browserSecurityHeaders('https://congress.trade/').get('content-security-policy') ?? '';
    expect(csp).not.toContain('fonts.googleapis.com');
    expect(csp).not.toContain('fonts.gstatic.com');
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("font-src 'self' data:");
  });

  it('adds Datadog RUM origins only when a complete public config is supplied', () => {
    const off = buildContentSecurityPolicy();
    expect(off).not.toContain('datadoghq-browser-agent.com');
    expect(off).not.toContain('browser-intake');
    const on = buildContentSecurityPolicy({
      rumScriptSrc: 'https://www.datadoghq-browser-agent.com/us5/v5/datadog-rum.js',
      rumConnectOrigins: ['https://browser-intake-us5-datadoghq.com'],
    });
    expect(on).toContain('https://www.datadoghq-browser-agent.com');
    expect(on).toContain('https://browser-intake-us5-datadoghq.com');
    expect(on).not.toContain('*');
  });

  it('adds Sentry browser origins only when a DSN-backed script is supplied', () => {
    const off = buildContentSecurityPolicy();
    expect(off).not.toContain('browser.sentry-cdn.com');
    expect(off).not.toContain('ingest.us.sentry.io');
    const on = buildContentSecurityPolicy({
      sentryScriptSrc: 'https://browser.sentry-cdn.com/10.70.0/bundle.tracing.replay.feedback.min.js',
      sentryConnectOrigins: ['https://o1.ingest.us.sentry.io'],
    });
    expect(on).toContain('https://browser.sentry-cdn.com');
    expect(on).toContain('https://o1.ingest.us.sentry.io');
    // Sentry Replay creates a blob: worker; allow it when the Sentry script
    // is enabled. Without this, every page load logs a CSP violation and the
    // replay worker silently fails to start.
    expect(on).toContain("worker-src 'self' blob:");
    expect(off).toContain("worker-src 'none'");
    expect(on).not.toContain('*');
  });

  it('attaches headers to a completed Hono response', async () => {
    const app = new Hono();
    app.use('*', browserSecurityHeadersMiddleware);
    app.get('/health', (c) => c.json({ ok: true }));
    const response = await app.request('https://congress.trade/health');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('strict-transport-security')).toBe('max-age=31536000');
  });

  it('keeps nosniff and HSTS when the Sentry browser loader is enabled', async () => {
    const app = new Hono();
    app.use('*', browserSecurityHeadersMiddleware);
    app.get('/health', (c) => c.json({ ok: true }));
    const response = await app.request('https://congress.trade/health', {}, {
      SENTRY_DSN: 'https://key@o1.ingest.us.sentry.io/1',
    });
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('strict-transport-security')).toBe('max-age=31536000');
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).toContain('https://browser.sentry-cdn.com');
    expect(csp).toContain('https://o1.ingest.us.sentry.io');
  });
});
