/**
 * src/ingestion/residentialProxyHealth.ts
 *
 * Probe and health helpers for the residential Tailscale proxy.
 */

import { z } from 'zod';
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
/**
 * After a recorded Akamai block, wait this long before probing again.  Mirrors
 * senateSource's SENATE_AKAMAI_BLOCK_BACKOFF_MS (30m): no point POSTing to an
 * endpoint that is refusing this egress more often than ingestion itself does.
 */
export const SENATE_EFD_BLOCKED_PROBE_INTERVAL_MS = 30 * 60_000;

// Literal (not derived from SENATE_SEARCH) so suites that vi.mock senateSource
// without these exports can still import this module.
const SENATE_EFD_HOME = 'https://efdsearch.senate.gov/search/home/';
const SENATE_EFD_ORIGIN = 'https://efdsearch.senate.gov';

/**
 * Per-step headers on top of BROWSER_HEADERS.  These must match
 * `establishSenateSession` in senateSource.ts exactly (pinned by a test):
 * Akamai scores browser fidelity, so a thinner probe could be refused while the
 * real handshake succeeds (or vice versa).
 */
export const SENATE_EFD_LANDING_HEADERS: Readonly<Record<string, string>> = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
};
export const SENATE_EFD_AGREEMENT_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'application/x-www-form-urlencoded',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'same-origin',
};

/** eFD pages we classify are small; cap what we scan and keep. */
const EFD_BODY_MAX_CHARS = 512 * 1024;
/**
 * Trust boundary for eFD response bodies: coerce anything unreadable or
 * non-string to '' and bound the size before it reaches the classifier.
 */
export const SenateEfdResponseBodySchema = z
  .string()
  .catch('')
  .transform((body) => body.slice(0, EFD_BODY_MAX_CHARS));

async function readEfdBody(res: Response): Promise<string> {
  return SenateEfdResponseBodySchema.parse(await res.text().catch(() => ''));
}

/**
 * Transport errors can embed the proxy URL (`http://user:pass@host`), and this
 * text is persisted to CONFIG_KV and served on /health/deep.  Strip URL
 * userinfo and any configured proxy credentials, and bound the length.
 */
export function sanitizeEfdTransportError(err: unknown, secrets: Array<string | undefined> = []): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err ?? 'unknown');
  let out = raw.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, '$1[redacted]@');
  for (const secret of secrets) {
    if (secret && secret.length >= 3) out = out.split(secret).join('[redacted]');
  }
  return out.slice(0, 200);
}

/**
 * Exercise the path Senate ingestion actually needs, through the same
 * residential proxy `senateSource.ts` uses: GET /search/ (200 + csrf token),
 * then the agreement POST to /search/home/ (200/302).  The example.com
 * liveness hop above cannot see an eFD anti-bot block; this can.
 *
 * Each request gets its own `timeoutMs` budget, so a slow landing GET cannot
 * starve the agreement POST.
 *
 * Classification:
 *   ok        both steps passed
 *   blocked   either step returned Akamai's "Access Denied" 403
 *   degraded  proxy unreachable / transport error / timeout, or any other failure
 */
export async function probeSenateEfdThroughProxy(
  proxyUrl: string,
  fetchImpl: typeof fetch = globalThis.fetch,
  timeoutMs = SENATE_EFD_PROBE_TIMEOUT_MS,
  now = new Date(),
  secrets: Array<string | undefined> = [],
): Promise<SenateEfdProbeRecord> {
  const checkedAt = now.toISOString();
  const proxiedFetch = createProxiedFetch(proxyUrl.replace(/\/$/, ''), fetchImpl);
  const base = { checkedAt, egress: 'proxy', dialed: true } as const;
  let step = 'GET /search/';
  let timedOut = false;
  const withTimeout = async <T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      return await run(controller.signal);
    } finally {
      clearTimeout(timeoutId);
    }
  };
  try {
    const { landing, landingHtml } = await withTimeout(async (signal) => {
      const res = await trackedFetch(
        SENATE_SEARCH,
        { method: 'GET', headers: { ...BROWSER_HEADERS, ...SENATE_EFD_LANDING_HEADERS }, signal },
        { service: 'filing-discovery', operation: 'probe-senate-efd-landing' },
        proxiedFetch,
      );
      return { landing: res, landingHtml: await readEfdBody(res) };
    });
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
    const { agree, agreeBody } = await withTimeout(async (signal) => {
      const res = await trackedFetch(
        SENATE_EFD_HOME,
        {
          method: 'POST',
          headers: {
            ...BROWSER_HEADERS,
            ...SENATE_EFD_AGREEMENT_HEADERS,
            cookie: jar.header(),
            referer: SENATE_SEARCH,
            origin: SENATE_EFD_ORIGIN,
          },
          body: new URLSearchParams({
            prohibition_agreement: '1',
            csrfmiddlewaretoken: token || jar.get('csrftoken') || '',
          }).toString(),
          redirect: 'manual',
          signal,
        },
        { service: 'filing-discovery', operation: 'probe-senate-efd-agreement' },
        proxiedFetch,
      );
      return { agree: res, agreeBody: await readEfdBody(res) };
    });
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
      error: timedOut
        ? `relay/transport timeout after ${timeoutMs}ms`
        : `relay/transport error: ${sanitizeEfdTransportError(err, secrets)}`,
    };
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

/** Configured proxy credential values, so a transport error can be scrubbed of them. */
function proxyCredentialSecrets(env: Env): string[] {
  const penv = typeof process !== 'undefined' ? process.env : undefined;
  return [
    env?.RESIDENTIAL_PROXY_USERNAME, env?.RESIDENTIAL_PROXY_PASSWORD,
    penv?.RESIDENTIAL_PROXY_USERNAME, penv?.RESIDENTIAL_PROXY_PASSWORD,
  ].map((v) => v?.trim()).filter((v): v is string => Boolean(v));
}

/**
 * Refresh the cached eFD probe.  Relay down/unconfigured is recorded every
 * call without dialing eFD; otherwise eFD is dialed at most once per
 * SENATE_EFD_PROXY_PROBE_INTERVAL_MS (SENATE_EFD_BLOCKED_PROBE_INTERVAL_MS
 * after an Akamai block), measured from the last attempted dial
 * (`lastDialedAt`), so relay flaps cannot shorten the interval.
 *
 * An attempt that fails in transport or times out still counts: Akamai can
 * tarpit or reset a request it has already scored, so re-dialing on the next
 * tick would bring back the retry churn CT-2416 removes.
 *
 * A stored `blocked` record is never overwritten by a relay-down record: the
 * relay outage is the residential_proxy check's to report, and replacing the
 * Akamai verdict with `degraded` would silently downgrade a critical alert.
 */
export async function refreshSenateEfdProxyProbe(
  env: Env,
  now: Date,
  ctx: { proxyUrl: string | undefined; proxyReachable: boolean },
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<void> {
  const checkedAt = now.toISOString();
  const last = await readSenateEfdProbe(env);
  // Relay-down records must not reset the throttle: carry the last real dial
  // forward so a flapping relay cannot trigger an eFD hit on every recovery.
  const lastDialedAt = last?.lastDialedAt ?? (last?.dialed ? last.checkedAt : null);
  if (!ctx.proxyUrl || !ctx.proxyReachable) {
    if (last?.state === 'blocked') return;
    await persistSenateEfdProbe(env, {
      ok: false, state: 'degraded', status: null, checkedAt, egress: 'proxy', dialed: false, lastDialedAt,
      step: null, error: ctx.proxyUrl ? 'residential proxy down' : 'residential proxy not configured',
    });
    return;
  }
  const lastMs = lastDialedAt ? Date.parse(lastDialedAt) : NaN;
  const intervalMs = last?.state === 'blocked' ? SENATE_EFD_BLOCKED_PROBE_INTERVAL_MS : SENATE_EFD_PROXY_PROBE_INTERVAL_MS;
  if (Number.isFinite(lastMs) && now.getTime() - lastMs < intervalMs) {
    // Throttled.  If the stored record is a relay-down one, the relay is back
    // but eFD state is unknown until the next allowed dial, so leave it as is
    // (pipelineHealth keeps reporting degraded for at most 15 minutes).
    return;
  }
  const rec = await probeSenateEfdThroughProxy(
    ctx.proxyUrl, fetchImpl, SENATE_EFD_PROBE_TIMEOUT_MS, now,
    proxyCredentialSecrets(env),
  );
  await persistSenateEfdProbe(env, { ...rec, lastDialedAt: checkedAt });
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
