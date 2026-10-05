/**
 * src/ingestion/residentialProxyHealth.ts
 *
 * Probe and health helpers for the residential Tailscale proxy.
 */

import { trackedFetch } from '../shared/thirdPartyTelemetry.ts';
import { DEFAULT_RESIDENTIAL_PROXY_URL, resolveResidentialProxyUrl } from '../shared/proxyFetch.ts';
import type { Env } from '../shared/types.ts';

export const RESIDENTIAL_PROXY_HEALTH_KV_KEY = 'residential-proxy:health';
export const RESIDENTIAL_PROXY_PROBE_TIMEOUT_MS = 5_000;

/** Cached GET /health result for pipelineHealth (no live hop on /api/health). */
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
 * Probe the health endpoint of the residential proxy daemon.
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
      { service: 'filing-discovery', operation: 'probe-residential-proxy-health' },
      fetchImpl,
    );

    clearTimeout(timeoutId);
    const latencyMs = Date.now() - t0;

    if (res.ok) {
      let data: { ok?: boolean; service?: string; uptime?: number } = {};
      try {
        data = (await res.json()) as typeof data;
      } catch {}
      return {
        configured: true,
        proxyUrl: cleanUrl,
        reachable: true,
        status: res.status,
        service: data.service,
        uptime: data.uptime,
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
