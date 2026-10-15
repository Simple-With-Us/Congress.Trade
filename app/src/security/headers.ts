/**
 * Browser security headers for Worker-generated responses.
 *
 * The dashboard is currently one static document with inline CSS, script, and
 * event handlers. The CSP therefore keeps narrowly scoped inline exceptions
 * while denying frames, objects, cross-origin connections, and other default
 * loads. Removing those two exceptions is the follow-up once the dashboard is
 * split into nonceable/static assets. script-src also allows
 * https://static.cloudflareinsights.com for Cloudflare's auto-injected Web
 * Analytics beacon (RUM), which the zone injects into every HTML response.
 *
 * style-src/font-src no longer carry fonts.googleapis.com/fonts.gstatic.com
 * exceptions (QABUGHUNT-01 / WEBPERF-01): every font (Zilla Slab, and now
 * Inter) is self-hosted under /assets/*, so the third-party Google Fonts
 * request — and the CSP holes it required — is gone, not just fixed.
 *
 * worker-src is widened to 'self' blob: only when Sentry is enabled, because
 * the Sentry browser SDK's Replay integration (bundle.tracing.replay.*) creates
 * a blob: worker to capture DOM mutations. Without this, every page load emits
 * a console error and the replay worker silently fails to start. Without
 * Sentry, the default 'none' for worker-src is the right tight default.
 */

import type { MiddlewareHandler } from 'hono';
import { DATADOG_RUM_SCRIPT_ORIGIN } from '../shared/datadogRum.ts';
import { getDatadogInitInput } from '../shared/datadog.ts';
import { resolveDatadogRum } from '../shared/datadogRuntime.ts';
import { resolveSentryBrowser, SENTRY_BROWSER_SCRIPT_ORIGIN } from '../shared/sentryBrowser.ts';
import type { Env } from '../shared/types.ts';
import { isSecureRequest, isSecureRequestParts } from './requestProtocol.ts';

export function buildContentSecurityPolicy(opts: {
  rumScriptSrc?: string;
  rumConnectOrigins?: readonly string[];
  sentryScriptSrc?: string;
  sentryConnectOrigins?: readonly string[];
} = {}): string {
  const script = [
    "'self'",
    "'unsafe-inline'",
    'https://static.cloudflareinsights.com',
    ...(opts.rumScriptSrc ? [DATADOG_RUM_SCRIPT_ORIGIN] : []),
    ...(opts.sentryScriptSrc ? [SENTRY_BROWSER_SCRIPT_ORIGIN] : []),
  ].join(' ');
  const connect = [
    "'self'",
    'https://cloudflareinsights.com',
    'https://static.cloudflareinsights.com',
    ...(opts.rumConnectOrigins ?? []),
    ...(opts.sentryConnectOrigins ?? []),
  ].join(' ');
  // Sentry Replay creates a blob: worker. 'self' is also needed so the worker
  // can importScripts from the Sentry CDN origin (already in script-src).
  const worker = opts.sentryScriptSrc ? "'self' blob:" : "'none'";
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    `script-src ${script}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    // Auto-injected Web Analytics loads from static.cloudflareinsights.com
    // (script-src) and beacons to cloudflareinsights.com — or, on a proxied
    // zone, to same-origin /cdn-cgi/rum ('self'). Allow both so the beacon
    // is not CSP-blocked on every anonymous load (issue #1457).
    // Datadog RUM origins are added only when a complete public RUM config exists.
    `connect-src ${connect}`,
    `worker-src ${worker}`,
    "form-action 'self'",
  ].join('; ');
}

const CONTENT_SECURITY_POLICY = buildContentSecurityPolicy();

const BASE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'Permissions-Policy': 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

/**
 * @param opts.secure whether the client-facing hop used TLS. Callers with a
 *   request Context should pass `isSecureRequest(c)` — behind the production
 *   proxy the socket URL is always `http:`, so inferring it from `requestUrl`
 *   alone silently drops HSTS. See ./requestProtocol.ts.
 */
export function browserSecurityHeaders(requestUrl: string, opts: {
  secure?: boolean;
  rumScriptSrc?: string;
  rumConnectOrigins?: readonly string[];
  sentryScriptSrc?: string;
  sentryConnectOrigins?: readonly string[];
} = {}): Headers {
  const headers = new Headers(BASE_HEADERS);
  const widen =
    Boolean(opts.rumScriptSrc) ||
    Boolean(opts.rumConnectOrigins && opts.rumConnectOrigins.length > 0) ||
    Boolean(opts.sentryScriptSrc) ||
    Boolean(opts.sentryConnectOrigins && opts.sentryConnectOrigins.length > 0);
  if (widen) {
    headers.set(
      'Content-Security-Policy',
      buildContentSecurityPolicy({
        rumScriptSrc: opts.rumScriptSrc,
        rumConnectOrigins: opts.rumConnectOrigins,
        sentryScriptSrc: opts.sentryScriptSrc,
        sentryConnectOrigins: opts.sentryConnectOrigins,
      }),
    );
  }
  const secure = opts.secure ?? isSecureRequestParts(undefined, undefined, requestUrl);
  if (secure) {
    // Deliberately omit includeSubDomains/preload until every sibling hostname
    // is audited; the app still pins HTTPS for its own host for one year.
    headers.set('Strict-Transport-Security', 'max-age=31536000');
  }
  return headers;
}

export const browserSecurityHeadersMiddleware: MiddlewareHandler = async (c, next) => {
  await next();
  const env = (c.env ?? {}) as Env;
  let rumScriptSrc: string | undefined;
  let rumConnectOrigins: readonly string[] | undefined;
  let sentryScriptSrc: string | undefined;
  let sentryConnectOrigins: readonly string[] | undefined;
  try {
    const rum = resolveDatadogRum({
      ...(getDatadogInitInput() ?? {}),
      ...env,
    });
    if (rum.enabled) {
      rumScriptSrc = rum.scriptSrc;
      rumConnectOrigins = rum.connectOrigins;
    }
  } catch {
    // CSP stays tight.  Never skip nosniff/HSTS because telemetry resolution threw.
  }
  try {
    const sentry = resolveSentryBrowser(env);
    if (sentry.enabled) {
      sentryScriptSrc = sentry.scriptSrc;
      sentryConnectOrigins = [sentry.connectOrigin];
    }
  } catch {
    // Same: missing/undefined env must not strip browser security headers.
  }
  for (const [name, value] of browserSecurityHeaders(c.req.url, {
    secure: isSecureRequest(c),
    rumScriptSrc,
    rumConnectOrigins,
    sentryScriptSrc,
    sentryConnectOrigins,
  })) {
    c.header(name, value);
  }
};
