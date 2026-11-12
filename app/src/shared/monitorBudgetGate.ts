/**
 * src/shared/monitorBudgetGate.ts
 *
 * Read-side self-throttle feedback loop: congress.trade polls the API Usage
 * Monitor's cross-app `GET /api/budget-status` (usage.jays.services) so
 * discretionary, non-essential spend can back off a provider the monitor
 * already reports at/over its monthly budget — closing the loop on
 * shared/thirdPartyTelemetry.ts, which only ever pushes usage TO the monitor
 * and never reads anything back.
 *
 * This is deliberately a SOFT, ADVISORY layer:
 *   - It composes UNDER any hard, CT-local resource governor (e.g. an LLM USD
 *     ceiling or D1 write budget) — those remain the last-resort stop. This
 *     module only ever tells discretionary work "don't bother calling this
 *     provider right now", earlier and informed by spend CT can't see locally
 *     (other apps sharing the same provider account, e.g. a shared OpenRouter
 *     key).
 *   - It NEVER blocks the essential real-time per-filing ingestion path —
 *     callers choose to consult it only from discretionary lanes (currently
 *     just the backlog autopilot; see extraction/autopilot.ts).
 *   - It FAILS OPEN, always: not configured, unreachable, timed out, a non-2xx
 *     response, or a malformed body all resolve to "not throttled". A bug or
 *     outage in this feedback loop must never be able to stall the pipeline.
 *
 * Bounded + cached: one GET, bounded by USAGE_MONITOR_BUDGET_STATUS_TIMEOUT_MS
 * (default 5s), memoized in isolate memory for
 * USAGE_MONITOR_BUDGET_STATUS_CACHE_TTL_MS (default 2min) so a busy backlog
 * drain (many docs per tick, many ticks per run) services every caller in
 * this isolate from one poll per cache window instead of hammering the
 * monitor.
 */

import { resolveSecrets } from '../secrets/infisical.ts';
import { normalizeUsageMonitorBaseUrl } from './thirdPartyTelemetry.ts';
import type { Env } from './types.ts';

const BUDGET_STATUS_PATH = '/api/budget-status';

const DEFAULT_CACHE_TTL_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 15_000;
/** Only the monitor's literal "exceeded" status throttles by default. */
const DEFAULT_THRESHOLD = 1.0;

export type MonitorBudgetLevel = 'ok' | 'warning' | 'exceeded' | 'unconfigured';

export interface MonitorProviderBudget {
  name: string;
  displayName?: string;
  status: MonitorBudgetLevel;
  percentUsed: number | null;
}

interface MonitorBudgetStatusResponse {
  ok: true;
  providers: MonitorProviderBudget[];
  summary?: {
    percentUsed: number | null;
    overBudget: boolean;
    warning: boolean;
  };
}

export interface ProviderThrottleDecision {
  /** True when this provider should be treated as advisory-throttled right now. */
  throttle: boolean;
  /** Best-effort human-readable reason, safe to log (no secrets/PII). */
  reason: string;
  /** The monitor's reported status for the matched provider, if any. */
  status?: MonitorBudgetLevel;
  percentUsed?: number | null;
}

// --- Provider-name matching --------------------------------------------------
// The monitor's read-time joins normalize producer/provider names down to a
// canonical alias (see provider-identity.ts on the monitor side, not
// importable here). This mirrors just the handful of aliases relevant to
// congress.trade's own `Provider` union (bakeoff.ts) so a CT-side key such as
// `gemini` matches a monitor Provider row configured as "Google AI"/"Gemini".
// Matching is intentionally conservative: no match => not throttled (fail
// open), never the reverse.
const PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  gemini: 'googleai',
  grok: 'xai',
  llamaparse: 'llamaindex',
};

function normalizeProviderToken(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function canonicalProviderToken(value: string): string {
  const token = normalizeProviderToken(value);
  return PROVIDER_ALIASES[token] ?? token;
}

function intVar(raw: string | undefined, fallback: number, max?: number): number {
  const n = Number.parseInt((raw ?? '').trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return max != null ? Math.min(n, max) : n;
}

function floatVar(raw: string | undefined, fallback: number): number {
  const n = Number.parseFloat((raw ?? '').trim());
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function falsy(v: string | undefined): boolean {
  return /^(0|false|no|off)$/i.test((v ?? '').trim());
}

// --- Isolate-memory stale cache ----------------------------------------------

interface CacheEntry {
  fetchedAt: number;
  value: MonitorBudgetStatusResponse | null;
}

let cache: CacheEntry | null = null;
/** Dedupe concurrent cold-cache callers within the same isolate onto one fetch. */
let inFlight: Promise<MonitorBudgetStatusResponse | null> | null = null;

/** Test-only: drop the isolate cache so the next call re-fetches. */
export function __resetMonitorBudgetGateCacheForTests(): void {
  cache = null;
  inFlight = null;
}

interface ReceiverConfig {
  url: string;
  token: string;
}

let loggedMissingReadToken = false;

async function resolveReceiverConfig(env: Env): Promise<ReceiverConfig | null> {
  const secrets = await resolveSecrets(env, [
    'USAGE_MONITOR_INGEST_URL',
    'USAGE_MONITOR_INGEST_TOKEN',
    'USAGE_MONITOR_READ_TOKEN',
  ]);
  const configuredUrl = secrets.USAGE_MONITOR_INGEST_URL?.trim();
  // Never fall back to the ingest token: the monitor denies ingest-token reads
  // in production (its Wave C / C10 hardening), so the old fallback sent
  // doomed 401 requests that made the gate look configured while it silently
  // failed open.
  const token = secrets.USAGE_MONITOR_READ_TOKEN?.trim();
  if (!token && secrets.USAGE_MONITOR_INGEST_TOKEN?.trim() && !loggedMissingReadToken) {
    console.log(
      'usage-monitor budget gate disabled: USAGE_MONITOR_READ_TOKEN is not configured (the ingest token cannot authorize reads)',
    );
    loggedMissingReadToken = true;
  }
  if (!configuredUrl || !token) return null;
  const baseUrl = normalizeUsageMonitorBaseUrl(configuredUrl);
  if (!baseUrl) return null;
  return { url: `${baseUrl}${BUDGET_STATUS_PATH}`, token };
}

function isMonitorBudgetStatusResponse(value: unknown): value is MonitorBudgetStatusResponse {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return obj.ok === true && Array.isArray(obj.providers);
}

let loggedMonitorError = false;

/**
 * Fetch the monitor's budget-status, bounded by a timeout, never throwing.
 * Returns null on ANY failure (not configured, network error, timeout,
 * non-2xx, malformed body) — the caller's fail-open contract.
 */
async function fetchBudgetStatusUncached(env: Env): Promise<MonitorBudgetStatusResponse | null> {
  try {
    const config = await resolveReceiverConfig(env);
    if (!config) return null;
    const timeoutMs = intVar(env.USAGE_MONITOR_BUDGET_STATUS_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // A deliberate plain `fetch`, not trackedFetch: this is an infra
      // read-back to the monitor itself, not a billable third-party provider
      // call, and must never recursively enqueue its own usage telemetry.
      const res = await fetch(config.url, {
        method: 'GET',
        headers: { authorization: `Bearer ${config.token}` },
        signal: controller.signal,
      });
      if (!res.ok) {
        if (!loggedMonitorError && (res.status === 401 || res.status === 403 || res.status === 503)) {
          console.log(`usage-monitor budget gate failed (status ${res.status}): read token may be invalid or ingest fallback denied`);
          loggedMonitorError = true;
        }
        return null;
      }
      loggedMonitorError = false;
      const body: unknown = await res.json().catch(() => null);
      return isMonitorBudgetStatusResponse(body) ? body : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

function cacheTtlMs(env: Env): number {
  return intVar(env.USAGE_MONITOR_BUDGET_STATUS_CACHE_TTL_MS, DEFAULT_CACHE_TTL_MS);
}

/**
 * Cached accessor for the monitor's budget-status. Returns null when the
 * monitor is unconfigured/unreachable (fail open) — callers must treat null
 * as "no information available", never as "everything is over budget".
 */
async function getBudgetStatus(env: Env, now = Date.now()): Promise<MonitorBudgetStatusResponse | null> {
  if (cache && now - cache.fetchedAt < cacheTtlMs(env)) return cache.value;
  if (inFlight) return inFlight;
  inFlight = fetchBudgetStatusUncached(env)
    .then((value) => {
      cache = { fetchedAt: Date.now(), value };
      return value;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

function throttleEnabled(env: Env): boolean {
  return !falsy(env.USAGE_MONITOR_BUDGET_THROTTLE_ENABLED);
}

function throttleThreshold(env: Env): number {
  return floatVar(env.USAGE_MONITOR_BUDGET_THROTTLE_THRESHOLD, DEFAULT_THRESHOLD);
}

function findProvider(
  status: MonitorBudgetStatusResponse,
  provider: string,
): MonitorProviderBudget | null {
  const canonical = canonicalProviderToken(provider);
  for (const candidate of status.providers) {
    if (canonicalProviderToken(candidate.name) === canonical) return candidate;
    if (candidate.displayName && canonicalProviderToken(candidate.displayName) === canonical) return candidate;
  }
  return null;
}

/**
 * Advisory throttle decision for one CT provider key (bakeoff.ts's `Provider`
 * union, e.g. "openrouter", "gemini", "anthropic"). Never throws; always
 * fails open (throttle: false) when the monitor is disabled, unconfigured,
 * unreachable, or the provider isn't found in its response.
 */
export async function getProviderThrottleDecision(
  env: Env,
  provider: string,
): Promise<ProviderThrottleDecision> {
  if (!throttleEnabled(env)) {
    return { throttle: false, reason: 'usage-monitor budget throttle disabled' };
  }
  const status = await getBudgetStatus(env).catch(() => null);
  if (!status) {
    return { throttle: false, reason: 'usage-monitor budget-status unavailable (failing open)' };
  }
  const match = findProvider(status, provider);
  if (!match) {
    return { throttle: false, reason: `usage-monitor has no budget row for provider "${provider}"` };
  }
  if (match.status === 'unconfigured') {
    return { throttle: false, reason: `usage-monitor: "${provider}" has no monthly budget configured`, status: match.status };
  }
  const threshold = throttleThreshold(env);
  const overThreshold = match.percentUsed != null && match.percentUsed >= threshold;
  const throttle = match.status === 'exceeded' || overThreshold;
  const percentLabel = match.percentUsed != null ? `${Math.round(match.percentUsed * 100)}%` : 'unknown';
  return {
    throttle,
    reason: throttle
      ? `usage-monitor reports "${provider}" at ${percentLabel} of budget (status=${match.status})`
      : `usage-monitor reports "${provider}" at ${percentLabel} of budget (status=${match.status}, under threshold)`,
    status: match.status,
    percentUsed: match.percentUsed,
  };
}

/**
 * Convenience for call sites (e.g. autopilot.ts) that want a single yes/no
 * over a SET of providers used together for one unit of work (e.g. a
 * multi-model agreement trio) — true only when EVERY listed provider is
 * currently throttled, so a doc is deferred only when none of its configured
 * models would spend on-budget money anyway. Returns the first throttled
 * provider's decision for logging when true.
 */
export async function allProvidersThrottled(
  env: Env,
  providers: readonly string[],
): Promise<{ throttled: boolean; decision?: ProviderThrottleDecision; provider?: string }> {
  const uniqueProviders = [...new Set(providers)];
  if (uniqueProviders.length === 0) return { throttled: false };
  const decisions = await Promise.all(
    uniqueProviders.map(async (provider) => ({ provider, decision: await getProviderThrottleDecision(env, provider) })),
  );
  const allThrottled = decisions.every((entry) => entry.decision.throttle);
  if (!allThrottled) return { throttled: false };
  const first = decisions[0];
  return { throttled: true, decision: first.decision, provider: first.provider };
}
