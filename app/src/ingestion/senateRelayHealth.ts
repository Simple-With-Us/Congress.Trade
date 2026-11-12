/**
 * Senate residential-relay liveness.
 *
 * Search and document fetch prefer `SENATE_RELAY_URL` (named tunnel
 * `https://scout.jays.services` → Mac `senate-relay` `/fetch-ptr` + `/fetch-doc`).
 * That hostname is permanent (#1779).  The process behind it is not: it still
 * runs on one residential Mac.  When the tunnel origin is down (Cloudflare 502)
 * Imperva sometimes still allows the production box's own egress — so callers
 * fall back to the direct eFD path instead of failing closed on a sleeping
 * laptop.  `/fetch-doc` is unchanged when the relay answers.
 *
 * This module is the loud side of that bargain: a cheap GET `/health` against
 * the configured relay, cached in CONFIG_KV so `/api/health` does not add a
 * live outbound hop, and a dedicated `/api/health/senate-relay` that probes
 * live so a dead Mac pages in minutes rather than after polling_senate's 3h
 * window.
 */

import type { Env } from '../shared/types.ts';
import { trackedFetch } from '../shared/thirdPartyTelemetry.ts';

export const SENATE_RELAY_HEALTH_KV_KEY = 'senate-relay:health';
export const SENATE_RELAY_PROBE_TIMEOUT_MS = 5_000;

/** Cloudflare origin-down / edge-timeout class.  Not upstream eFD statuses. */
const RELAY_UNREACHABLE_STATUS = new Set([502, 503, 504, 521, 522, 523, 524]);

export interface SenateRelayProbeRecord {
  ok: boolean;
  status: number | null;
  checkedAt: string;
  host: string | null;
}

export interface SenateRelayHealthResult {
  ok: boolean;
  configured: boolean;
  mode: 'relay' | 'direct';
  host: string | null;
  status: number | null;
  detail: string;
  checkedAt: string;
}

export function senateRelayBaseUrl(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/\/$/, '');
}

export function senateRelayAuthHeaders(secret: string | undefined): Record<string, string> {
  const token = secret?.trim();
  if (!token) return {};
  return { authorization: `Bearer ${token}` };
}

export function senateRelayHost(raw: string | undefined): string | null {
  const base = senateRelayBaseUrl(raw);
  if (!base) return null;
  try {
    return new URL(base).host;
  } catch {
    return 'invalid-url';
  }
}

/**
 * True when the relay itself is gone (laptop asleep, tunnel origin down,
 * network error).  False for mirrored upstream statuses (404/403/400) so
 * #1610's `/fetch-doc` retry semantics stay intact.
 */
export function isSenateRelayUnreachable(res: Response | null, err?: unknown): boolean {
  if (err) return true;
  if (!res) return true;
  return RELAY_UNREACHABLE_STATUS.has(res.status);
}

export async function probeSenateRelay(
  env: Env,
  now = new Date(),
  fetchImpl: typeof fetch = fetch,
): Promise<SenateRelayHealthResult> {
  const checkedAt = now.toISOString();
  const base = senateRelayBaseUrl(env.SENATE_RELAY_URL);
  const host = senateRelayHost(env.SENATE_RELAY_URL);
  if (!base) {
    const result: SenateRelayHealthResult = {
      ok: true,
      configured: false,
      mode: 'direct',
      host: null,
      status: null,
      detail:
        'SENATE_RELAY_URL unset — Senate search and document fetch use the box egress.  Direct is the durable path when Imperva allows it.',
      checkedAt,
    };
    await persistSenateRelayProbe(env, { ok: true, status: null, checkedAt, host: null });
    return result;
  }

  let status: number | null = null;
  try {
    const res = await trackedFetch(
      `${base}/health`,
      { method: 'GET', signal: AbortSignal.timeout(SENATE_RELAY_PROBE_TIMEOUT_MS) },
      { service: 'filing-discovery', operation: 'probe-senate-relay' },
      fetchImpl,
    );
    status = res.status;
    await res.body?.cancel().catch(() => {});
    const ok = res.ok;
    const result: SenateRelayHealthResult = {
      ok,
      configured: true,
      mode: 'relay',
      host,
      status,
      detail: ok
        ? `Senate relay live at ${host}`
        : `Senate relay unreachable at ${host} (HTTP ${status}).  Search/docs fall back to direct eFD while this is down.`,
      checkedAt,
    };
    await persistSenateRelayProbe(env, { ok, status, checkedAt, host });
    return result;
  } catch (err) {
    const result: SenateRelayHealthResult = {
      ok: false,
      configured: true,
      mode: 'relay',
      host,
      status,
      detail: `Senate relay probe failed at ${host}: ${(err as Error).message}.  Search/docs fall back to direct eFD while this is down.`,
      checkedAt,
    };
    await persistSenateRelayProbe(env, { ok: false, status, checkedAt, host });
    return result;
  }
}

export async function refreshSenateRelayHealth(env: Env, now = new Date()): Promise<void> {
  await probeSenateRelay(env, now);
}

export async function readSenateRelayProbe(env: Env): Promise<SenateRelayProbeRecord | null> {
  if (!env.CONFIG_KV) return null;
  try {
    const raw = await env.CONFIG_KV.get(SENATE_RELAY_HEALTH_KV_KEY, 'json');
    if (!raw || typeof raw !== 'object') return null;
    const rec = raw as SenateRelayProbeRecord;
    if (typeof rec.ok !== 'boolean' || typeof rec.checkedAt !== 'string') return null;
    return rec;
  } catch {
    return null;
  }
}

async function persistSenateRelayProbe(env: Env, rec: SenateRelayProbeRecord): Promise<void> {
  if (!env.CONFIG_KV) return;
  try {
    await env.CONFIG_KV.put(SENATE_RELAY_HEALTH_KV_KEY, JSON.stringify(rec), {
      expirationTtl: 86_400,
    });
  } catch {
    /* best-effort; pipelineHealth treats a missing probe as unknown */
  }
}
