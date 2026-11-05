/**
 * Senate intake relay status: the heartbeat of the headless automation
 * relay into Congress.Trade.
 *
 * The Mac eFD fetcher (headless Chrome, CT-2442) discovers Senate PTRs
 * out-of-band and relays them in through POST /api/admin/senate-ptr-intake.  
 * That endpoint used to record nothing, so no surface could say whether the
 * relay was alive, when it last delivered, or what a delivery carried.  
 * Every intake call now writes one small CONFIG_KV record (best-effort: a
 * KV failure never fails the intake), and the admin review queue reads it
 * back so the queue view can show the relay status next to the work it
 * feeds.
 */

import type { Env } from '../shared/types.ts';

export const SENATE_INTAKE_STATUS_KV_KEY = 'senate-intake:last';

/**
 * The fetcher runs every 15 minutes, so a relay silent for 45 minutes has
 * missed about three runs and reads stale.
 */
export const SENATE_INTAKE_STALE_AFTER_MS = 45 * 60_000;

export interface SenateIntakeRecord {
  /** ISO timestamp of the intake call. */
  receivedAt: string;
  /** Rows the fetcher sent in the call. */
  received: number;
  /** Rows that converted to Senate filings. */
  converted: number;
  /** Rows that did not convert. */
  rejected: number;
  /** Filings newly inserted by the call (always 0 on a dry run). */
  newCount: number;
  /** True when the call was a dry run and nothing was ingested. */
  dryRun: boolean;
}

export interface SenateIntakeStatus extends SenateIntakeRecord {
  /** Milliseconds between the record's receivedAt and the read time. */
  ageMs: number;
  /** True when the last relay is older than SENATE_INTAKE_STALE_AFTER_MS. */
  stale: boolean;
}

/** Best-effort heartbeat write; never throws into the intake path. */
export async function recordSenateIntake(env: Env, rec: SenateIntakeRecord): Promise<void> {
  if (!env.CONFIG_KV) return;
  try {
    await env.CONFIG_KV.put(SENATE_INTAKE_STATUS_KV_KEY, JSON.stringify(rec));
  } catch {
    /* best-effort: the review queue reads a missing record as never-run */
  }
}

function isSenateIntakeRecord(raw: unknown): raw is SenateIntakeRecord {
  if (!raw || typeof raw !== 'object') return false;
  const rec = raw as Record<string, unknown>;
  return typeof rec.receivedAt === 'string'
    && typeof rec.received === 'number'
    && typeof rec.converted === 'number'
    && typeof rec.rejected === 'number'
    && typeof rec.newCount === 'number'
    && typeof rec.dryRun === 'boolean';
}

/** The last relay's status, or null when the relay has never called in. */
export async function readSenateIntakeStatus(env: Env, now = new Date()): Promise<SenateIntakeStatus | null> {
  if (!env.CONFIG_KV) return null;
  let raw: unknown;
  try {
    raw = await env.CONFIG_KV.get(SENATE_INTAKE_STATUS_KV_KEY, 'json');
  } catch {
    return null;
  }
  if (!isSenateIntakeRecord(raw)) return null;
  const receivedMs = Date.parse(raw.receivedAt);
  const ageMs = Number.isFinite(receivedMs) ? Math.max(0, now.getTime() - receivedMs) : Infinity;
  return { ...raw, ageMs, stale: ageMs > SENATE_INTAKE_STALE_AFTER_MS };
}
