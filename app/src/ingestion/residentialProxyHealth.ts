/**
 * src/ingestion/residentialProxyHealth.ts
 *
 * Probe and health helpers for the residential Tailscale proxy.
 */

import { trackedFetch } from '../shared/thirdPartyTelemetry.ts';
import { createProxiedFetch, DEFAULT_RESIDENTIAL_PROXY_URL, resolveResidentialProxyUrl } from '../shared/proxyFetch.ts';
import type { Env } from '../shared/types.ts';
import {
  BROWSER_HEADERS,
  CookieJar,
  looksLikeAkamaiAccessDenied,
  parseCsrfMiddlewareToken,
  SENATE_SEARCH,
} from './senateSource.ts';
import {
  persistSenateEfdProbe,
  readSenateEfdProbe,
  SENATE_EFD_PROBE_TIMEOUT_MS,
  type SenateEfdProbeRecord,
} from './senateEfdHealth.ts';

export const RESIDENTIAL_PROXY_HEALTH_KV_KEY = 'residential-proxy:health';
export const RESIDENTIAL_PROXY_PROBE_TIMEOUT_MS = 5_000;

/** Cheap origin fetched *through* the HTTP proxy (never GET {proxy}/health). */
export const RESIDENTIAL_PROXY_PROBE_TARGET_URL = 'http://example.com/';

/** Cached proxy-egress probe for pipelineHealth (no live hop on /api/health). */
export interface ResidentialProxyProbeRecord {
  ok: boolean;
  status: number | null;
  checkedAt: string;
  host: string | null;
}

export interface ResidentialProxyHealthResult {
  /** An operator explicitly set a residential proxy env. */
  configured: boolean;
  proxyUrl?: string;
  reachable: boolean;
  status?: number;
  service?: string;
  uptime?: number;
  latencyMs?: number;
  error?: string;
  /** Proxy URL outbound traffic will actually use when nothing is configured. */
  effectiveProxyUrl?: string;
  /** True when `configured` is false but the Mango fallback still applies. */
  usingDefault?: boolean;
}

/**
 * Probe residential proxy liveness by tunneling a cheap HTTP request through it
 * (equivalent to `curl -x {proxy} http://example.com`).  Never issues a plain
 * GET to `{proxy}/health` — tinyproxy has no health route and will wedge workers.
 */
export async function probeResidentialProxyHealth(
  proxyUrlOrEnv?: string | Env,
  fetchImpl: typeof fetch = globalThis.fetch,
  timeoutMs = 5000,
): Promise<ResidentialProxyHealthResult> {
  // `allowDefault: false`: this is a diagnostic, so "configured" must mean an
  // operator actually set a proxy env — not that `resolveResidentialProxyUrl`
  // handed back the Mango fallback.  Resolving with the default here would
  // make `configured` permanently true and send a live request to the Mango
  // device on every call, including from unit tests that pass no fetch mock.
  const proxyUrl = typeof proxyUrlOrEnv === 'string'
    ? proxyUrlOrEnv
    : resolveResidentialProxyUrl(proxyUrlOrEnv, { allowDefault: false });

  if (!proxyUrl) {
    return {
      configured: false,
      reachable: false,
      // Egress still has a path — `resolveResidentialProxyUrl` falls back to
      // the Mango proxy — so surface what traffic will actually use while
      // still reporting the missing configuration.
      effectiveProxyUrl: DEFAULT_RESIDENTIAL_PROXY_URL,
      usingDefault: true,
    };
  }

  const cleanUrl = proxyUrl.replace(/\/$/, '');
  const proxiedFetch = createProxiedFetch(cleanUrl, fetchImpl);
  const t0 = Date.now();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await trackedFetch(
      RESIDENTIAL_PROXY_PROBE_TARGET_URL,
      {
        method: 'GET',
        headers: { accept: 'text/html' },
        signal: controller.signal,
      },
      { service: 'filing-discovery', operation: 'probe-residential-proxy-health' },
      proxiedFetch,
    );

    clearTimeout(timeoutId);
    const latencyMs = Date.now() - t0;
    const reachable = res.status >= 200 && res.status < 600;

    if (reachable) {
      return {
        configured: true,
        proxyUrl: cleanUrl,
        reachable: true,
        status: res.status,
        latencyMs,
      };
    }

    return {
      configured: true,
      proxyUrl: cleanUrl,
      reachable: false,
      status: res.status,
      latencyMs,
      error: `HTTP ${res.status}`,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    return {
      configured: true,
      proxyUrl: cleanUrl,
      reachable: false,
      latencyMs: Date.now() - t0,
      error: (err as Error).message,
    };
  }
}

function residentialProxyHost(proxyUrl: string): string | null {
  try {
    return new URL(proxyUrl).host;
  } catch {
    return 'invalid-url';
  }
}

export async function refreshResidentialProxyHealth(env: Env, now = new Date()): Promise<void> {
  const proxyUrl = resolveResidentialProxyUrl(env, { allowDefault: false });
  const checkedAt = now.toISOString();
  if (!proxyUrl) {
    await persistResidentialProxyProbe(env, { ok: true, status: null, checkedAt, host: null });
    await refreshSenateEfdProxyProbe(env, now, { proxyUrl: undefined, proxyReachable: false });
    return;
  }
  const result = await probeResidentialProxyHealth(env, globalThis.fetch, RESIDENTIAL_PROXY_PROBE_TIMEOUT_MS);
  const host = result.proxyUrl ? residentialProxyHost(result.proxyUrl) : null;
  await persistResidentialProxyProbe(env, {
    ok: result.reachable,
    status: result.status ?? null,
    checkedAt,
    host,
  });
  await refreshSenateEfdProxyProbe(env, now, { proxyUrl, proxyReachable: result.reachable });
}

// ---------------------------------------------------------------------------
// Senate eFD functional probe (CT-2416)
// ---------------------------------------------------------------------------

/** Dial eFD at most this often; relay-down records are written every tick (no eFD hop). */
export const SENATE_EFD_PROXY_PROBE_INTERVAL_MS = 15 * 60_000;

// Literal (not derived from SENATE_SEARCH) so suites that vi.mock senateSource
// without these exports can still import this module.
const SENATE_EFD_HOME = 'https://efdsearch.senate.gov/search/home/';
const SENATE_EFD_ORIGIN = 'https://efdsearch.senate.gov';

/**
 * Exercise the path Senate ingestion actually needs, through the same
 * residential proxy `senateSource.ts` uses: GET /search/ (200 + csrf token),
 * then the agreement POST to /search/home/ (200/302).  The example.com
 * liveness hop above cannot see an eFD anti-bot block; this can.
 *
 * Classification:
 *   ok        both steps passed
 *   blocked   either step returned Akamai's "Access Denied" 403
 *   degraded  proxy unreachable / transport error, or any other failure
 */
export async function probeSenateEfdThroughProxy(
  proxyUrl: string,
  fetchImpl: typeof fetch = globalThis.fetch,
  timeoutMs = SENATE_EFD_PROBE_TIMEOUT_MS,
  now = new Date(),
): Promise<SenateEfdProbeRecord> {
  const checkedAt = now.toISOString();
  const proxiedFetch = createProxiedFetch(proxyUrl.replace(/\/$/, ''), fetchImpl);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const base = { checkedAt, egress: 'proxy', dialed: true } as const;
  let step = 'GET /search/';
  try {
    const landing = await trackedFetch(
      SENATE_SEARCH,
      {
        method: 'GET',
        headers: {
          ...BROWSER_HEADERS,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        signal: controller.signal,
      },
      { service: 'filing-discovery', operation: 'probe-senate-efd-landing' },
      proxiedFetch,
    );
    const landingHtml = await landing.text().catch(() => '');
    if (landing.status !== 200) {
      return classifyEfdFailure(base, step, landing.status, landingHtml);
    }
    const jar = new CookieJar();
    jar.absorb(landing);
    const token = parseCsrfMiddlewareToken(landingHtml);
    if (!token && !jar.get('csrftoken')) {
      return { ...base, ok: false, state: 'degraded', status: 200, step, error: 'eFD landing has no csrf token' };
    }

    step = 'POST /search/home/';
    const agree = await trackedFetch(
      SENATE_EFD_HOME,
      {
        method: 'POST',
        headers: {
          ...BROWSER_HEADERS,
          'content-type': 'application/x-www-form-urlencoded',
          cookie: jar.header(),
          referer: SENATE_SEARCH,
          origin: SENATE_EFD_ORIGIN,
        },
        body: new URLSearchParams({
          prohibition_agreement: '1',
          csrfmiddlewaretoken: token || jar.get('csrftoken') || '',
        }).toString(),
        redirect: 'manual',
        signal: controller.signal,
      },
      { service: 'filing-discovery', operation: 'probe-senate-efd-agreement' },
      proxiedFetch,
    );
    const agreeBody = await agree.text().catch(() => '');
    if (agree.status === 200 || agree.status === 302) {
      return { ...base, ok: true, state: 'ok', status: agree.status, step, error: null };
    }
    return classifyEfdFailure(base, step, agree.status, agreeBody);
  } catch (err) {
    return {
      ...base,
      ok: false,
      state: 'degraded',
      status: null,
      step,
      error: `relay/transport error: ${(err as Error).message}`,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function classifyEfdFailure(
  base: { checkedAt: string; egress: 'proxy'; dialed: true },
  step: string,
  status: number,
  body: string,
): SenateEfdProbeRecord {
  if (status === 403 && looksLikeAkamaiAccessDenied(body)) {
    return { ...base, ok: false, state: 'blocked', status, step, error: 'eFD anti-bot block (Akamai Access Denied)' };
  }
  return { ...base, ok: false, state: 'degraded', status, step, error: `HTTP ${status}` };
}

/**
 * Refresh the cached eFD probe.  Relay down/unconfigured is recorded every
 * call without dialing eFD; otherwise eFD is dialed at most once per
 * SENATE_EFD_PROXY_PROBE_INTERVAL_MS.
 */
export async function refreshSenateEfdProxyProbe(
  env: Env,
  now: Date,
  ctx: { proxyUrl: string | undefined; proxyReachable: boolean },
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<void> {
  const checkedAt = now.toISOString();
  if (!ctx.proxyUrl) {
    await persistSenateEfdProbe(env, {
      ok: false, state: 'degraded', status: null, checkedAt, egress: 'proxy', dialed: false,
      step: null, error: 'residential proxy not configured',
    });
    return;
  }
  if (!ctx.proxyReachable) {
    await persistSenateEfdProbe(env, {
      ok: false, state: 'degraded', status: null, checkedAt, egress: 'proxy', dialed: false,
      step: null, error: 'residential proxy down',
    });
    return;
  }
  const last = await readSenateEfdProbe(env);
  const lastMs = last?.dialed ? Date.parse(last.checkedAt) : NaN;
  if (Number.isFinite(lastMs) && now.getTime() - lastMs < SENATE_EFD_PROXY_PROBE_INTERVAL_MS) return;
  const rec = await probeSenateEfdThroughProxy(ctx.proxyUrl, fetchImpl, SENATE_EFD_PROBE_TIMEOUT_MS, now);
  await persistSenateEfdProbe(env, rec);
}

export async function readResidentialProxyProbe(env: Env): Promise<ResidentialProxyProbeRecord | null> {
  if (!env.CONFIG_KV) return null;
  try {
    const raw = await env.CONFIG_KV.get(RESIDENTIAL_PROXY_HEALTH_KV_KEY, 'json');
    if (!raw || typeof raw !== 'object') return null;
    const rec = raw as ResidentialProxyProbeRecord;
    if (typeof rec.ok !== 'boolean' || typeof rec.checkedAt !== 'string') return null;
    return rec;
  } catch {
    return null;
  }
}

async function persistResidentialProxyProbe(env: Env, rec: ResidentialProxyProbeRecord): Promise<void> {
  if (!env.CONFIG_KV) return;
  try {
    await env.CONFIG_KV.put(RESIDENTIAL_PROXY_HEALTH_KV_KEY, JSON.stringify(rec), {
      expirationTtl: 86_400,
    });
  } catch {
    /* best-effort; pipelineHealth treats a missing probe as unknown */
  }
}
