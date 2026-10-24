/**
 * Senate eFD (efdsearch.senate.gov) functional-probe record, cached in
 * CONFIG_KV so `/api/health` can report eFD state without dialing eFD.
 *
 * The probe itself lives in residentialProxyHealth.ts (CT-2416): it runs the
 * real landing GET + agreement POST through the same residential proxy as
 * senateSource.ts.  The old unproxied direct GET was dropped (owner ruling
 * 2026-10-16) because datacenter egress is a structural 403 that said nothing
 * about whether ingestion works.  Each probe sends eFD one agreement POST, so
 * it dials at most every 30 minutes and not at all while the watcher's
 * edge-deny backoff is active (CT-2442).
 */

import { z } from 'zod';
import type { Env } from '../shared/types.ts';

export const SENATE_EFD_HEALTH_KV_KEY = 'senate-efd:health';
export const SENATE_EFD_PROBE_TIMEOUT_MS = 8_000;

/**
 * ok        landing GET 200 + csrf token, agreement POST 3xx (or a 200 without
 *           the agreement form), as establishSenateSession judges it.
 * blocked   eFD's Akamai edge denied a step (classifySenateHttpFailure
 *           `edge_denied`: a 403 from AkamaiGHost or with the Access Denied page).
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
  /** When an eFD dial was last attempted (carried across relay-down records; drives the 30-minute throttle). */
  lastDialedAt?: string | null;
}

/**
 * Trust boundary for the cached probe record in CONFIG_KV.  `ok` and
 * `checkedAt` are required, as before; a legacy direct-GET record (no
 * `state`) still parses, and pipelineHealth ignores it.  A record with a
 * wrong-typed field reads as no record, so the probe dials again (still
 * subject to the edge-deny backoff).  Unknown fields are dropped.
 */
export const SenateEfdProbeRecordSchema = z.object({
  ok: z.boolean(),
  status: z.number().int().nullable().catch(null),
  checkedAt: z.string(),
  egress: z.string().nullish(),
  error: z.string().nullish(),
  state: z.enum(['ok', 'blocked', 'degraded']).optional(),
  step: z.string().nullish(),
  dialed: z.boolean().optional(),
  lastDialedAt: z.string().nullish(),
});

export async function readSenateEfdProbe(env: Env): Promise<SenateEfdProbeRecord | null> {
  if (!env.CONFIG_KV) return null;
  try {
    const parsed = SenateEfdProbeRecordSchema.safeParse(await env.CONFIG_KV.get(SENATE_EFD_HEALTH_KV_KEY, 'json'));
    return parsed.success ? { ...parsed.data, status: parsed.data.status ?? null } : null;
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
