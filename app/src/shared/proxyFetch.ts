/**
 * src/shared/proxyFetch.ts
 *
 * Lightweight proxied fetch client wrapper for Deno and Node environments.
 * When a residential proxy URL (e.g. http://10.99.0.2:8888 for the
 * glinet-mango device on the WireGuard mesh) is provided, outbound
 * HTTP/HTTPS requests are tunneled through the proxy so requests appear
 * from the residential IP (bypassing datacenter anti-bot filters like
 * Imperva).
 *
 * Owner 2026-09-09: the Mac is retired from the residential proxy role
 * (board `ab688ea5`).  The little proxy server is now the GL.iNet Mango
 * on the Hetzner WireGuard mesh (interface `wg-ct`, peer `10.99.0.2`,
 * HTTP CONNECT proxy on port 8888).  Configure
 * `RESIDENTIAL_PROXY_URL=http://10.99.0.2:8888` in Infisical prod env
 * for `congress-trade` so all server-side scraping + FMP latency probes
 * bounce through it.
 */

declare const Deno: {
  createHttpClient?: (options: { proxy?: { url: string } }) => unknown;
} | undefined;

/**
 * Canonical residential proxy URL.  The Mango HTTP CONNECT proxy is
 * reachable from the Hetzner server directly via the `wg-ct` WireGuard
 * mesh; no NAT dance is needed.  The user can still override via the
 * `RESIDENTIAL_PROXY_URL` / `RESIDENTIAL_PROXY_HOST` Infisical keys.
 */
export const DEFAULT_RESIDENTIAL_PROXY_URL = 'http://10.99.0.2:8888';

const clientCache = new Map<string, unknown>();

/**
 * Creates or retrieves a cached HTTP client configured with the given proxy URL.
 */
export function getDenoHttpClient(proxyUrl?: string): unknown | undefined {
  if (!proxyUrl || typeof Deno === 'undefined' || typeof Deno.createHttpClient !== 'function') {
    return undefined;
  }
  const cleanUrl = proxyUrl.trim();
  if (!cleanUrl) return undefined;

  let client = clientCache.get(cleanUrl);
  if (!client) {
    try {
      client = Deno.createHttpClient({ proxy: { url: cleanUrl } });
      clientCache.set(cleanUrl, client);
    } catch (err) {
      // The proxy URL can carry credentials as userinfo; never log them.
      const redact = (s: string) => s.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, '$1[redacted]@');
      console.warn(
        `proxyFetch: failed to create Deno HTTP client for ${redact(cleanUrl)}:`,
        redact((err as Error).message ?? String(err)),
      );
      return undefined;
    }
  }
  return client;
}

/**
 * Wraps a fetch function to route outbound requests through the specified proxy URL.
 * If no proxy is configured or the proxy client cannot be initialized, returns the underlying fetch.
 */
export function createProxiedFetch(
  proxyUrl?: string,
  baseFetch: typeof fetch = globalThis.fetch,
): typeof fetch {
  if (!proxyUrl) return baseFetch;
  const cleanUrl = proxyUrl.trim();
  if (!cleanUrl) return baseFetch;

  const client = getDenoHttpClient(cleanUrl);
  if (!client) return baseFetch;

  return async function proxiedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const fetchInit = { ...init, client } as RequestInit & { client?: unknown };
    return baseFetch(input, fetchInit as RequestInit);
  };
}

/**
 * Formats host, port, username, and password into a standard HTTP proxy URL.
 */
export function formatProxyUrl(opts: {
  host?: string;
  port?: string | number;
  username?: string;
  password?: string;
  protocol?: string;
}): string | undefined {
  if (!opts.host) return undefined;
  const portStr = opts.port ? `:${opts.port}` : '';
  const proto = opts.protocol ? opts.protocol.replace(/:$/, '') : 'http';
  const auth = opts.username && opts.password
    ? `${encodeURIComponent(opts.username)}:${encodeURIComponent(opts.password)}@`
    : '';
  return `${proto}://${auth}${opts.host.trim()}${portStr}`;
}

/**
 * Helper to resolve the effective residential proxy URL from Env or process.env.
 * Falls back to {@link DEFAULT_RESIDENTIAL_PROXY_URL} when nothing is configured
 * so the server-side Senate / House / FMP probes always have a path.
 *
 * Pass `{ allowDefault: false }` to ask the *other* question — "did an operator
 * explicitly configure a residential proxy?" — which is what health and
 * observability surfaces need.  Without that distinction the Mango fallback
 * makes every "configured" check unconditionally true, so a missed
 * `RESIDENTIAL_PROXY_URL` in Coolify becomes undetectable — the exact
 * misconfiguration the fallback exists to survive.  Egress paths keep the
 * default (always have a residential route); diagnostics opt out of it.
 */
export function resolveResidentialProxyUrl(
  env?: {
    RESIDENTIAL_PROXY_URL?: string;
    SENATE_PROXY_URL?: string;
    HTTP_PROXY?: string;
    HTTPS_PROXY?: string;
    RESIDENTIAL_PROXY_HOST?: string;
    RESIDENTIAL_PROXY_PORT?: string | number;
    RESIDENTIAL_PROXY_USERNAME?: string;
    RESIDENTIAL_PROXY_PASSWORD?: string;
  },
  opts?: { allowDefault?: boolean },
): string | undefined {
  const direct =
    env?.RESIDENTIAL_PROXY_URL?.trim() ||
    env?.SENATE_PROXY_URL?.trim() ||
    (typeof process !== 'undefined' ? process.env?.RESIDENTIAL_PROXY_URL?.trim() : undefined) ||
    (typeof process !== 'undefined' ? process.env?.SENATE_PROXY_URL?.trim() : undefined) ||
    (typeof process !== 'undefined' ? process.env?.HTTPS_PROXY?.trim() : undefined) ||
    (typeof process !== 'undefined' ? process.env?.HTTP_PROXY?.trim() : undefined);
  if (direct) return direct;

  const host = env?.RESIDENTIAL_PROXY_HOST?.trim() || (typeof process !== 'undefined' ? process.env?.RESIDENTIAL_PROXY_HOST?.trim() : undefined);
  const port = env?.RESIDENTIAL_PROXY_PORT || (typeof process !== 'undefined' ? process.env?.RESIDENTIAL_PROXY_PORT : undefined);
  const username = env?.RESIDENTIAL_PROXY_USERNAME?.trim() || (typeof process !== 'undefined' ? process.env?.RESIDENTIAL_PROXY_USERNAME?.trim() : undefined);
  const password = env?.RESIDENTIAL_PROXY_PASSWORD?.trim() || (typeof process !== 'undefined' ? process.env?.RESIDENTIAL_PROXY_PASSWORD?.trim() : undefined);

  if (host) {
    return formatProxyUrl({ host, port, username, password });
  }

  // Nothing explicitly configured.  Diagnostics ask with
  // `allowDefault: false` because they need to report the *absence* of
  // configuration rather than the effective egress path.
  if (opts?.allowDefault === false) return undefined;

  // Last-resort fallback so the FMP latency probe and Senate / House
  // scrapers always have a residential path when nothing is configured.
  // The Mango HTTP CONNECT proxy is the only res-IP bounce in the fleet
  // since the Mac residential-proxy was retired (board `ab688ea5`).
  return DEFAULT_RESIDENTIAL_PROXY_URL;
}
