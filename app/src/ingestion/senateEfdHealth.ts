/**
 * Direct Senate eFD (efdsearch.senate.gov) reachability probe.
 *
 * Cached in CONFIG_KV so `/api/health` can surface a dead residential proxy
 * without dialing the Mango device on every health request.
 */

import { trackedFetch } from '../shared/thirdPartyTelemetry.ts';
import type { Env } from '../shared/types.ts';
import { BROWSER_HEADERS, SENATE_SEARCH } from './senateSource.ts';

export const SENATE_EFD_HEALTH_KV_KEY = 'senate-efd:health';
export const SENATE_EFD_PROBE_TIMEOUT_MS = 8_000;

/**
 * Re-probe cadence, read off the cached record.  The box's direct egress has
 * been edge-denied by eFD's Akamai (SERVE_403) since at least 2026-10-16, so
 * probing on every watcher minute sent about 1,440 denied requests a day
 * (CT-2442).  A failed probe is re-checked at most every 30 minutes.  An ok
 * probe is refreshed every 15, inside pipelineHealth's 20-minute staleness
 * bar for this check, so a healthy probe never reads as stale.
 */
export const SENATE_EFD_PROBE_RETRY_MS = 30 * 60_000;
export const SENATE_EFD_PROBE_OK_REFRESH_MS = 15 * 60_000;

export interface SenateEfdProbeRecord {
  ok: boolean;
  status: number | null;
  checkedAt: string;
  /** `direct` or `proxy` — how the last successful watcher poll reached eFD. */
  egress?: string | null;
  error?: string | null;
}

export async function probeSenateEfdLanding(
  fetchImpl: typeof fetch = globalThis.fetch,
  timeoutMs = SENATE_EFD_PROBE_TIMEOUT_MS,
): Promise<SenateEfdProbeRecord> {
  const checkedAt = new Date().toISOString();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await trackedFetch(
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
      fetchImpl,
    );
    clearTimeout(timeoutId);
    const ok = res.status >= 200 && res.status < 400;
    return {
      ok,
      status: res.status,
      checkedAt,
      egress: 'direct',
      error: ok ? null : `HTTP ${res.status}`,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    return {
      ok: false,
      status: null,
      checkedAt,
      egress: 'direct',
      error: (err as Error).message,
    };
  }
}

/** True when the cached probe is old enough (or missing) to send another request. */
export function senateEfdProbeDue(prev: SenateEfdProbeRecord | null, now: Date): boolean {
  if (!prev) return true;
  const checkedMs = Date.parse(prev.checkedAt);
  if (!Number.isFinite(checkedMs)) return true;
  const ageMs = now.getTime() - checkedMs;
  if (ageMs < 0) return true;
  return ageMs >= (prev.ok ? SENATE_EFD_PROBE_OK_REFRESH_MS : SENATE_EFD_PROBE_RETRY_MS);
}

export async function refreshSenateEfdHealth(
  env: Env,
  now = new Date(),
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<void> {
  if (!senateEfdProbeDue(await readSenateEfdProbe(env), now)) return;
  const rec = await probeSenateEfdLanding(fetchImpl, SENATE_EFD_PROBE_TIMEOUT_MS);
  rec.checkedAt = now.toISOString();
  await persistSenateEfdProbe(env, rec);
}

export async function readSenateEfdProbe(env: Env): Promise<SenateEfdProbeRecord | null> {
  if (!env.CONFIG_KV) return null;
  try {
    const raw = await env.CONFIG_KV.get(SENATE_EFD_HEALTH_KV_KEY, 'json');
    if (!raw || typeof raw !== 'object') return null;
    const rec = raw as SenateEfdProbeRecord;
    if (typeof rec.ok !== 'boolean' || typeof rec.checkedAt !== 'string') return null;
    return rec;
  } catch {
    return null;
  }
}

export async function persistSenateEfdProbe(env: Env, rec: SenateEfdProbeRecord): Promise<void> {
  if (!env.CONFIG_KV) return;
  try {
    await env.CONFIG_KV.put(SENATE_EFD_HEALTH_KV_KEY, JSON.stringify(rec), {
      expirationTtl: 86_400,
    });
  } catch {
    /* best-effort */
  }
}
