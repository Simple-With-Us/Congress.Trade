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

export async function refreshSenateEfdHealth(env: Env, now = new Date()): Promise<void> {
  const rec = await probeSenateEfdLanding(globalThis.fetch, SENATE_EFD_PROBE_TIMEOUT_MS);
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
