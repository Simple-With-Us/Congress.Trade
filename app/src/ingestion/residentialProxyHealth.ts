/**
 * src/ingestion/residentialProxyHealth.ts
 *
 * Probe and health helpers for the Texas GL.iNet Mango tinyproxy (HTTP CONNECT)
 * and the retired Mac residential-proxy daemon (GET /health JSON).
 */

import { trackedFetch } from '../shared/thirdPartyTelemetry.ts';
import {
  createProxiedFetch,
  DEFAULT_RESIDENTIAL_PROXY_URL,
  resolveResidentialProxyUrl,
} from '../shared/proxyFetch.ts';
import type { Env } from '../shared/types.ts';

export const RESIDENTIAL_PROXY_HEALTH_KV_KEY = 'residential-proxy:health';
export const RESIDENTIAL_PROXY_PROBE_TIMEOUT_MS = 5_000;

/**
 * Any HTTP response through CONNECT (2xx/3xx/4xx from origin) means the proxy
 * accepted the tunnel.  Connection / proxy-auth / ACL failures throw or time out.
 */
export const RESIDENTIAL_PROXY_CONNECT_PROBE_URL = 'https://example.com/';

/** Cached probe result for pipelineHealth (no live hop on /api/health). */
export interface ResidentialProxyProbeRecord {
  ok: boolean;
  status: number | null;
  checkedAt: string;
  host: string | null;
  /** How liveness was determined (for operator dashboards). */
  method?: 'daemon-health' | 'connect';
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
  /** How liveness was determined when reachable. */
  method?: 'daemon-health' | 'connect';
  /** Proxy URL outbound traffic will actually use when nothing is configured. */
  effectiveProxyUrl?: string;
  /** True when `configured` is false but the Mango fallback still applies. */
  usingDefault?: boolean;
  checkedAt?: string;
}

function residentialProxyHost(proxyUrl: string): string | null {
  try {
    return new URL(proxyUrl).host;
  } catch {
    return 'invalid-url';
  }
}

async function probeDaemonHealthEndpoint(
  cleanUrl: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<ResidentialProxyHealthResult | null> {
  const healthEndpoint = `${cleanUrl}/health`;
  const t0 = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await trackedFetch(
      healthEndpoint,
      {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      },
      { service: 'filing-discovery', operation: 'probe-residential-proxy-daemon-health' },
      fetchImpl,
    );

    clearTimeout(timeoutId);
    const latencyMs = Date.now() - t0;

    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return null;
    }

    let data: { ok?: boolean; service?: string; uptime?: number } = {};
    try {
      data = (await res.json()) as typeof data;
    } catch {
      await res.body?.cancel().catch(() => {});
      return null;
    }

    return {
      configured: true,
      proxyUrl: cleanUrl,
      reachable: true,
      status: res.status,
      service: data.service,
      uptime: data.uptime,
      latencyMs,
      method: 'daemon-health',
    };
  } catch {
    clearTimeout(timeoutId);
    return null;
  }
}

async function probeConnectEgress(
  proxyUrl: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<ResidentialProxyHealthResult> {
  const cleanUrl = proxyUrl.replace(/\/$/, '');
  const t0 = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const proxiedFetch = createProxiedFetch(cleanUrl, fetchImpl);

  try {
    const res = await trackedFetch(
      RESIDENTIAL_PROXY_CONNECT_PROBE_URL,
      {
        method: 'HEAD',
        redirect: 'follow',
        signal: controller.signal,
      },
      { service: 'filing-discovery', operation: 'probe-residential-proxy-connect' },
      proxiedFetch,
    );

    clearTimeout(timeoutId);
    const latencyMs = Date.now() - t0;
    await res.body?.cancel().catch(() => {});

    // Proxy down / ACL / auth problems usually surface as throws.  Any parsed
    // HTTP status means CONNECT succeeded and egress spoke to the origin.
    const reachable = res.status > 0 && res.status < 600;
    return {
      configured: true,
      proxyUrl: cleanUrl,
      reachable,
      status: res.status,
      latencyMs,
      method: 'connect',
      error: reachable ? undefined : `Unexpected status ${res.status}`,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    return {
      configured: true,
      proxyUrl: cleanUrl,
      reachable: false,
      latencyMs: Date.now() - t0,
      method: 'connect',
      error: (err as Error).message,
    };
  }
}

/**
 * Probe residential proxy liveness.
 *
 * 1. Retired Mac daemon: GET `{proxy}/health` JSON (historical).
 * 2. Mango tinyproxy: HTTP CONNECT egress to {@link RESIDENTIAL_PROXY_CONNECT_PROBE_URL}.
 */
export async function probeResidentialProxyHealth(
  proxyUrlOrEnv?: string | Env,
  fetchImpl: typeof fetch = globalThis.fetch,
  timeoutMs = RESIDENTIAL_PROXY_PROBE_TIMEOUT_MS,
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
  const daemon = await probeDaemonHealthEndpoint(cleanUrl, fetchImpl, timeoutMs);
  if (daemon?.reachable) {
    return daemon;
  }

  const connect = await probeConnectEgress(cleanUrl, fetchImpl, timeoutMs);
  if (!connect.reachable && connect.error == null && connect.status != null) {
    connect.error = `HTTP ${connect.status}`;
  }
  return connect;
}

export async function refreshResidentialProxyHealth(env: Env, now = new Date()): Promise<void> {
  const proxyUrl = resolveResidentialProxyUrl(env, { allowDefault: false });
  const checkedAt = now.toISOString();
  if (!proxyUrl) {
    await persistResidentialProxyProbe(env, { ok: true, status: null, checkedAt, host: null });
    return;
  }
  const result = await probeResidentialProxyHealth(env, globalThis.fetch, RESIDENTIAL_PROXY_PROBE_TIMEOUT_MS);
  const host = result.proxyUrl ? residentialProxyHost(result.proxyUrl) : null;
  await persistResidentialProxyProbe(env, {
    ok: result.reachable,
    status: result.status ?? null,
    checkedAt,
    host,
    method: result.method,
  });
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

/** Live probe for GET /api/health/residential-proxy (pages when CONNECT is dead). */
export async function probeResidentialProxyLive(
  env: Env,
  now = new Date(),
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<{
  ok: boolean;
  configured: boolean;
  host: string | null;
  status: number | null;
  method: ResidentialProxyProbeRecord['method'] | null;
  detail: string;
  checkedAt: string;
}> {
  const checkedAt = now.toISOString();
  const proxyUrl = resolveResidentialProxyUrl(env, { allowDefault: false });
  if (!proxyUrl) {
    return {
      ok: true,
      configured: false,
      host: null,
      status: null,
      method: null,
      detail:
        'Residential proxy env unset — Senate/House egress uses the Mango default only when allowDefault applies at fetch time.',
      checkedAt,
    };
  }

  const host = residentialProxyHost(proxyUrl);
  const result = await probeResidentialProxyHealth(env, fetchImpl, RESIDENTIAL_PROXY_PROBE_TIMEOUT_MS);
  const ok = result.reachable;
  const detail = ok
    ? `Residential proxy live at ${host} via ${result.method ?? 'probe'}`
      + (result.status != null ? ` (HTTP ${result.status})` : '')
    : `Residential proxy DOWN at ${host}`
      + (result.error ? `: ${result.error}` : result.status != null ? ` (HTTP ${result.status})` : '')
      + ' — restart tinyproxy on the Mango peer or fix WG/ACL/auth in Infisical.';

  await persistResidentialProxyProbe(env, {
    ok,
    status: result.status ?? null,
    checkedAt,
    host,
    method: result.method,
  });

  return {
    ok,
    configured: true,
    host,
    status: result.status ?? null,
    method: result.method ?? null,
    detail,
    checkedAt,
  };
}
