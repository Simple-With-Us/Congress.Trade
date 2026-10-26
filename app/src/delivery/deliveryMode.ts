/**
 * src/delivery/deliveryMode.ts
 *
 * Admin-controlled pause switch for every subscriber alert channel
 * (webhooks, APNs push, SSE live feed).  Added by GB-Publisher.
 *
 * The mode is the `CT_DELIVERY_MODE` app setting, read from the in-memory
 * Infisical snapshot owned by settings/settingsService.ts.  There is no env
 * read here and no silent fallback: if the settings service never booted,
 * readDeliveryMode() throws, so delivery fails closed (outbox rows stay
 * pending and nothing is sent) instead of guessing.  An unset key means the
 * documented default, `deliver`.  A value that is set but unrecognized fails
 * safe to `hold` (nothing is sent, nothing is lost) and is reported loudly by
 * the `delivery_mode` health check.
 *
 *   deliver  — current behavior.
 *   hold     — outbox rows are written but never dispatched.  Switching back
 *              to `deliver` releases them in bounded per-tick batches.
 *              Switching from `hold` to `suppress` drops the held backlog.
 *   suppress — outbox rows are written and immediately marked `suppressed`
 *              (terminal, never sent) with an audit reason.  For bulk
 *              republishes and corrections.  Independent of the per-request
 *              `correction: true` republish mode (PR #2867), which keeps
 *              unchanged rows' ids so they never re-enter the outbox at all.
 *
 * Every change made through PUT /api/admin/settings is recorded in
 * `delivery_mode_audit` (who, when, from, to, reason).
 */

import type { Env } from '../shared/types.ts';
import { all, run } from '../shared/db.ts';
import { appSettings, isSettingsInitialized } from '../settings/settingsService.ts';
import type { PipelineCheck } from '../shared/pipelineHealth.ts';

export const DELIVERY_MODE_SETTING_KEY = 'CT_DELIVERY_MODE';
export const DELIVERY_MODES = ['deliver', 'hold', 'suppress'] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];
export const DEFAULT_DELIVERY_MODE: DeliveryMode = 'deliver';

/** Health warns (critical → loud pipeline alert) once a non-default mode is this old. */
export const DELIVERY_MODE_WARN_MINUTES = 60;

export class DeliveryModeUnavailableError extends Error {
  constructor() {
    super(
      `${DELIVERY_MODE_SETTING_KEY} unavailable: app settings are not initialized from Infisical; ` +
        'refusing to dispatch subscriber alerts. See INFISICAL.md.',
    );
    this.name = 'DeliveryModeUnavailableError';
  }
}

export interface DeliveryModeReading {
  mode: DeliveryMode;
  /** Raw snapshot value; undefined when the key is unset (default applies). */
  raw: string | undefined;
  /** True when the raw value is set but not one of DELIVERY_MODES. */
  invalid: boolean;
}

/**
 * Test-only pin, kept on globalThis so the vitest setup file can set it
 * without importing (and so pre-loading, past vi.mock) this module graph.
 * Production never sets it.
 */
export const DELIVERY_MODE_TEST_PIN = '__ctDeliveryModeTestPin';

function testPin(): DeliveryMode | null {
  const pinned = (globalThis as Record<string, unknown>)[DELIVERY_MODE_TEST_PIN];
  return isDeliveryMode(pinned) ? pinned : null;
}

/** Tests only: pin the mode without booting the settings service. Pass null to clear. */
export function __setDeliveryModeForTests(mode: DeliveryMode | null): void {
  (globalThis as Record<string, unknown>)[DELIVERY_MODE_TEST_PIN] = mode ?? undefined;
}

export function isDeliveryMode(value: unknown): value is DeliveryMode {
  return typeof value === 'string' && (DELIVERY_MODES as readonly string[]).includes(value);
}

/** Synchronous, memory-only read of the current mode. Throws if settings never booted. */
export function readDeliveryModeDetail(): DeliveryModeReading {
  const pinned = testPin();
  if (pinned) return { mode: pinned, raw: pinned, invalid: false };
  if (!isSettingsInitialized()) throw new DeliveryModeUnavailableError();
  const raw = appSettings().get(DELIVERY_MODE_SETTING_KEY);
  if (raw === undefined || raw.trim() === '') return { mode: DEFAULT_DELIVERY_MODE, raw: undefined, invalid: false };
  const normalized = raw.trim().toLowerCase();
  if (isDeliveryMode(normalized)) return { mode: normalized, raw, invalid: false };
  return { mode: 'hold', raw, invalid: true };
}

export function readDeliveryMode(): DeliveryMode {
  return readDeliveryModeDetail().mode;
}

// --- audit ---------------------------------------------------------------

export interface DeliveryModeAuditEntry {
  id: string;
  mode: string;
  previousMode: string | null;
  actor: string;
  reason: string | null;
  createdAt: string;
}

interface AuditRow {
  id: string;
  mode: string;
  previous_mode: string | null;
  actor: string;
  reason: string | null;
  created_at: string;
}

function mapAudit(row: AuditRow): DeliveryModeAuditEntry {
  return {
    id: row.id,
    mode: row.mode,
    previousMode: row.previous_mode,
    actor: row.actor,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

export async function recordDeliveryModeChange(
  env: Env,
  entry: { mode: string; previousMode: string | null; actor: string; reason?: string | null; now?: Date },
): Promise<DeliveryModeAuditEntry> {
  const row: AuditRow = {
    id: `dma_${crypto.randomUUID()}`,
    mode: entry.mode,
    previous_mode: entry.previousMode,
    actor: entry.actor.slice(0, 200),
    reason: entry.reason ? entry.reason.slice(0, 500) : null,
    created_at: (entry.now ?? new Date()).toISOString(),
  };
  await run(
    env.DB,
    `INSERT INTO delivery_mode_audit (id, mode, previous_mode, actor, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [row.id, row.mode, row.previous_mode, row.actor, row.reason, row.created_at],
  );
  return mapAudit(row);
}

export async function listDeliveryModeAudit(env: Env, limit = 50): Promise<DeliveryModeAuditEntry[]> {
  const rows = await all<AuditRow>(
    env.DB,
    `SELECT id, mode, previous_mode, actor, reason, created_at
       FROM delivery_mode_audit ORDER BY created_at DESC LIMIT ?`,
    [Math.min(Math.max(Math.floor(limit), 1), 500)],
  );
  return rows.map(mapAudit);
}

/** Latest audit row, or null when there is none (or the table is missing). */
export async function latestDeliveryModeChange(env: Env): Promise<DeliveryModeAuditEntry | null> {
  try {
    return (await listDeliveryModeAudit(env, 1))[0] ?? null;
  } catch {
    return null;
  }
}

/** Reason stamped on suppressed outbox rows (last_error) so each one is traceable to a change. */
export function suppressionReason(latest: DeliveryModeAuditEntry | null): string {
  if (latest && latest.mode === 'suppress') {
    const why = latest.reason ? `: ${latest.reason}` : '';
    return `suppressed by ${DELIVERY_MODE_SETTING_KEY}=suppress (audit ${latest.id}, ${latest.actor}, ${latest.createdAt}${why})`.slice(0, 1000);
  }
  return `suppressed by ${DELIVERY_MODE_SETTING_KEY}=suppress (no audit row: set outside PUT /api/admin/settings)`;
}

// --- health ----------------------------------------------------------------

/**
 * `delivery_mode` pipeline check.  deliver → ok.  Non-default modes are
 * `degraded` (visible on /api/health and the admin dashboard) until they are
 * DELIVERY_MODE_WARN_MINUTES old, then `critical`, which the loud pipeline
 * sweep turns into a Sentry error plus a publisher wake.  A non-default mode
 * with no matching audit row (set directly in Infisical) or an invalid value
 * is `critical` at once, because nobody recorded why alerts are off.
 */
export async function collectDeliveryModeCheck(env: Env, now = new Date()): Promise<PipelineCheck> {
  let reading: DeliveryModeReading;
  try {
    reading = readDeliveryModeDetail();
  } catch (err) {
    return { id: 'delivery_mode', status: 'critical', detail: (err as Error).message, value: null };
  }
  if (reading.mode === 'deliver') {
    return { id: 'delivery_mode', status: 'ok', detail: 'Subscriber alerts delivering', value: { mode: 'deliver' } };
  }
  const latest = await latestDeliveryModeChange(env);
  return evaluateDeliveryModeCheck(reading, latest, now);
}

export function evaluateDeliveryModeCheck(
  reading: DeliveryModeReading,
  latest: DeliveryModeAuditEntry | null,
  now: Date,
  warnMinutes = DELIVERY_MODE_WARN_MINUTES,
): PipelineCheck {
  if (reading.mode === 'deliver') {
    return { id: 'delivery_mode', status: 'ok', detail: 'Subscriber alerts delivering', value: { mode: 'deliver' } };
  }
  const label = reading.mode === 'hold' ? 'HELD' : 'SUPPRESSED';
  if (reading.invalid) {
    return {
      id: 'delivery_mode',
      status: 'critical',
      detail: `Subscriber alerts ${label}: ${DELIVERY_MODE_SETTING_KEY} has invalid value (expected deliver|hold|suppress); failing safe to hold`,
      value: { mode: reading.mode, invalid: true, since: null, minutes: null, warnMinutes },
    };
  }
  const audited = latest && latest.mode === reading.mode ? latest : null;
  if (!audited) {
    return {
      id: 'delivery_mode',
      status: 'critical',
      detail: `Subscriber alerts ${label} (${DELIVERY_MODE_SETTING_KEY}=${reading.mode}) with no audit row — set outside PUT /api/admin/settings`,
      value: { mode: reading.mode, invalid: false, since: null, minutes: null, warnMinutes },
    };
  }
  const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(audited.createdAt)) / 60_000));
  const over = minutes >= warnMinutes;
  return {
    id: 'delivery_mode',
    status: over ? 'critical' : 'degraded',
    detail:
      `Subscriber alerts ${label} for ${minutes}m by ${audited.actor}` +
      (audited.reason ? ` (${audited.reason})` : '') +
      (over ? ` — over ${warnMinutes}m, switch ${DELIVERY_MODE_SETTING_KEY} back to deliver` : ` (warns at ${warnMinutes}m)`),
    value: { mode: reading.mode, invalid: false, since: audited.createdAt, minutes, warnMinutes, actor: audited.actor, auditId: audited.id },
  };
}
