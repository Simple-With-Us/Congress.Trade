/**
 * Senate eFD (efdsearch.senate.gov) functional-probe record, cached in
 * CONFIG_KV so `/api/health` can report eFD state without dialing eFD.
 *
 * The probe itself lives in residentialProxyHealth.ts (CT-2416): it runs the
 * real landing GET + agreement POST through the same residential proxy as
 * senateSource.ts.  The old unproxied direct GET was dropped (owner ruling
 * 2026-10-16) because datacenter egress is a structural 403 that said nothing
 * about whether ingestion works.
 */

import type { Env } from '../shared/types.ts';

export const SENATE_EFD_HEALTH_KV_KEY = 'senate-efd:health';
export const SENATE_EFD_PROBE_TIMEOUT_MS = 8_000;

/**
 * ok        landing GET 200 + csrf token, agreement POST 200/302.
 * blocked   eFD answered with the Akamai "Access Denied" 403 (anti-bot).
 * degraded  relay/proxy down or unconfigured, or eFD misbehaved otherwise.
 */
export type SenateEfdProbeState = 'ok' | 'blocked' | 'degraded';

export interface SenateEfdProbeRecord {
  ok: boolean;
  status: number | null;
  checkedAt: string;
  /** Egress used by the probe (`proxy`); legacy records carry `direct`. */
  egress?: string | null;
  error?: string | null;
  /** Absent on legacy direct-GET records, which pipelineHealth ignores. */
  state?: SenateEfdProbeState;
  /** Which step decided the state, e.g. `POST /search/home/`. */
  step?: string | null;
  /**
   * True when the probe that wrote this record attempted an eFD dial, including
   * one that then failed in transport or timed out (it still counts against the
   * throttle).  False on relay-down / unconfigured records, which never dial.
   */
  dialed?: boolean;
  /** When an eFD dial was last attempted (carried across relay-down records; drives the 15-minute throttle). */
  lastDialedAt?: string | null;
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
