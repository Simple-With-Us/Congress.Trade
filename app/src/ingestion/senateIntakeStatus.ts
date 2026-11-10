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
 *
 * Runs vs deliveries: this module also carries the fetcher RUN heartbeat
 * (see the second half of the file).  A run only becomes a delivery when
 * it finds new filings, so the delivery record alone cannot say whether
 * the fetcher is alive — the run record can.
 */

import type { Env } from '../shared/types.ts';

export const SENATE_INTAKE_STATUS_KV_KEY = 'senate-intake:last';

/**
 * Inside the fetcher's active window a relay silent for 45 minutes has
 * missed about three runs and reads stale.
 */
export const SENATE_INTAKE_STALE_AFTER_MS = 45 * 60_000;

/**
 * The Mac fetcher's LaunchAgent (com.jay.efd-fetcher) fires every
 * 15 minutes from 06:00 to 22:00 Mac-local time (America/Chicago) and is
 * idle overnight by design, so staleness is judged against that window:
 * overnight silence inside the scheduled gap is not a dead fetcher.
 */
const FETCHER_TZ = 'America/Chicago';
const FETCHER_WINDOW_START_HOUR = 6;
const FETCHER_WINDOW_END_HOUR = 22;

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
  /** True when the call reached the server but ingest itself failed. */
  failed?: boolean;
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
    && typeof rec.dryRun === 'boolean'
    && (rec.failed === undefined || typeof rec.failed === 'boolean');
}

interface ChicagoParts { year: number; month: number; day: number; hour: number; minute: number }

function chicagoParts(d: Date): ChicagoParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: FETCHER_TZ, year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  }).formatToParts(d);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') % 24, minute: get('minute') };
}

/** UTC instant of a fetcher-local wall time on a given fetcher-local date. */
function chicagoWallToUtcMs(year: number, month: number, day: number, hour: number, minute: number): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const rendered = chicagoParts(new Date(guess));
  const renderedAsUtc = Date.UTC(rendered.year, rendered.month - 1, rendered.day, rendered.hour, rendered.minute);
  return guess - (renderedAsUtc - guess);
}

function addDays(p: ChicagoParts, days: number): ChicagoParts {
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: p.hour, minute: p.minute };
}

/**
 * Window-aware staleness.  Inside the 06:00–22:00 window the plain
 * threshold applies, except that silence before today's window opened
 * only counts from the open.  Outside the window the record is judged as
 * of the most recent close: a relay that had already gone stale before
 * the close stays stale overnight, and one that called near the close is
 * fresh until the window reopens and the threshold passes there.
 */
function isStale(receivedMs: number, now: Date): boolean {
  if (!Number.isFinite(receivedMs)) return true;
  const nowMs = now.getTime();
  const p = chicagoParts(now);
  const inWindow = p.hour >= FETCHER_WINDOW_START_HOUR && p.hour < FETCHER_WINDOW_END_HOUR;
  if (inWindow) {
    const openMs = chicagoWallToUtcMs(p.year, p.month, p.day, FETCHER_WINDOW_START_HOUR, 0);
    if (receivedMs >= openMs) return nowMs - receivedMs > SENATE_INTAKE_STALE_AFTER_MS;
    const prev = addDays(p, -1);
    const closeMs = chicagoWallToUtcMs(prev.year, prev.month, prev.day, FETCHER_WINDOW_END_HOUR, 0);
    if (receivedMs < closeMs - SENATE_INTAKE_STALE_AFTER_MS) return true;
    return nowMs - openMs > SENATE_INTAKE_STALE_AFTER_MS;
  }
  const closeDay = p.hour >= FETCHER_WINDOW_END_HOUR ? p : addDays(p, -1);
  const closeMs = chicagoWallToUtcMs(closeDay.year, closeDay.month, closeDay.day, FETCHER_WINDOW_END_HOUR, 0);
  if (receivedMs >= closeMs) return false;
  return closeMs - receivedMs > SENATE_INTAKE_STALE_AFTER_MS;
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
  return { ...raw, ageMs, stale: isStale(receivedMs, now) };
}

// ---------------------------------------------------------------------------
// Fetcher run heartbeat (CT-2462).  The delivery record above only exists
// when a run finds NEW filings, so a quiet stretch — the norm — was
// indistinguishable from a dead fetcher: the review queue read "never
// reported" while the fetcher ran every 15 minutes.  The fetcher now also
// reports every completed run (ok / blocked / error) to
// POST /api/admin/senate-fetcher-run, and each report overwrites this
// record.  The queue renders it as its own line, separate from deliveries:
// runs answer "is the fetcher alive", deliveries answer "when did new
// filings last arrive".

export const SENATE_FETCHER_RUN_KV_KEY = 'senate-fetcher:last-run';

export type SenateFetcherRunStatus = 'ok' | 'blocked' | 'error';
export type SenateFetcherRole = 'agents' | 'jay';

export interface SenateFetcherRunRecord {
  /** ISO timestamp of the run, as reported by the fetcher. */
  ranAt: string;
  /** ISO timestamp of when the app received the report (server clock). */
  receivedAt: string;
  /** Outcome of the run: completed, blocked by the Senate, or errored. */
  status: SenateFetcherRunStatus;
  /** Rows the run's search returned (0 when it never got that far). */
  rows: number;
  /** Rows that were new to the fetcher on this run. */
  newCount: number;
  /** Which Mac copy ran: the agents primary or Jay's standby. */
  role: SenateFetcherRole;
}

export interface SenateFetcherRunState extends SenateFetcherRunRecord {
  /** Milliseconds between the record's receivedAt and the read time. */
  ageMs: number;
  /** True when the last reported run is older than the stale threshold. */
  stale: boolean;
}

/** Best-effort run-heartbeat write; never throws into the report path. */
export async function recordSenateFetcherRun(env: Env, rec: SenateFetcherRunRecord): Promise<void> {
  if (!env.CONFIG_KV) return;
  try {
    await env.CONFIG_KV.put(SENATE_FETCHER_RUN_KV_KEY, JSON.stringify(rec));
  } catch {
    /* best-effort: the review queue reads a missing record as no runs yet */
  }
}

function isSenateFetcherRunRecord(raw: unknown): raw is SenateFetcherRunRecord {
  if (!raw || typeof raw !== 'object') return false;
  const rec = raw as Record<string, unknown>;
  return typeof rec.ranAt === 'string'
    && typeof rec.receivedAt === 'string'
    && (rec.status === 'ok' || rec.status === 'blocked' || rec.status === 'error')
    && typeof rec.rows === 'number'
    && typeof rec.newCount === 'number'
    && (rec.role === 'agents' || rec.role === 'jay');
}

/** The last reported fetcher run, or null when no run has been reported. */
export async function readSenateFetcherRunStatus(env: Env, now = new Date()): Promise<SenateFetcherRunState | null> {
  if (!env.CONFIG_KV) return null;
  let raw: unknown;
  try {
    raw = await env.CONFIG_KV.get(SENATE_FETCHER_RUN_KV_KEY, 'json');
  } catch {
    return null;
  }
  if (!isSenateFetcherRunRecord(raw)) return null;
  const receivedMs = Date.parse(raw.receivedAt);
  const ageMs = Number.isFinite(receivedMs) ? Math.max(0, now.getTime() - receivedMs) : Infinity;
  return { ...raw, ageMs, stale: isStale(receivedMs, now) };
}
