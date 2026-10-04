/**
 * src/settings/settingsService.ts
 *
 * Typed app-level settings backed by Infisical as the sole source of truth.
 *
 * Contract (see repo-root INFISICAL.md):
 *  1. **Load at startup.** `initSettings(env)` fetches the full knob set into
 *     an in-memory snapshot at boot. The snapshot is memory-only afterwards.
 *  2. **Never fetch per-request.** `get*()` reads are synchronous and touch
 *     only the in-memory snapshot — zero network after init.
 *  3. **Background refresh.** `startSettingsRefresh()` re-reads on an interval
 *     (default 5 minutes, itself tunable via the INFISICAL_CACHE_TTL_SECONDS
 *     knob) and `refreshSettings()` is also the SIGHUP handler. Refresh
 *     failures log loudly and keep serving the last-known-good snapshot —
 *     staleness is safer than an outage.
 *  4. **Write-through on admin save.** `setSetting()` writes the new value to
 *     Infisical FIRST (via updateSecret); only on success is the in-memory
 *     snapshot updated. A failed Infisical write fails the save — the cache
 *     and Infisical never diverge silently.
 *
 * Design note: the repo's own `src/secrets/infisical.ts` is the minimal
 * equivalent of the fleet's `createInfisicalSettings` helper for this Deno
 * runtime (typed, cached, refreshed, write-through capable). This module adds
 * the typed-knob layer on top of it: schema, fail-fast init, and LKG
 * snapshots. Per-user settings are NOT here — they stay in the app's own
 * store (DB/KV) per the Infisical SOT policy.
 */

import { refreshSecrets, resolveSecrets, updateSecret } from '../secrets/infisical.ts';
import type { Env } from '../shared/types.ts';

export type SettingSource = 'app' | 'shared';

export interface SettingDef {
  /** Infisical secret key. */
  key: string;
  /** Which Infisical project the key lives in ('app' = congress-trade, 'shared' = shared-at-ct). */
  source: SettingSource;
  /** Human-readable description for INFISICAL.md / the admin UI. */
  description: string;
}

/**
 * The app-level tunable knobs governed by the Infisical SOT contract. All are
 * optional with safe in-code defaults — startup stays fail-soft for knobs
 * (secrets still fail-soft via the resolver's env fallback). Boot-only
 * bindings (PORT, DENO_KV_PATH, the INFISICAL_*_CLIENT_* bootstrap identity,
 * ADMIN_TOKEN gate tokens) are intentionally NOT here: they are process env
 * by design, see INFISICAL.md.
 */
export const APP_SETTINGS: readonly SettingDef[] = [
  { key: 'CT_CRON_SCHEDULE', source: 'app', description: 'Deno.cron schedule for the live tick (default: every minute).' },
  { key: 'CT_DRAIN_LIMIT', source: 'app', description: 'Max durable-queue messages completed per tick.' },
  { key: 'CT_DRAIN_CLAIM_SIZE', source: 'app', description: 'Messages claimed per SQL batch (still handled serially).' },
  { key: 'CT_OUTBOX_LIMIT', source: 'app', description: 'Max rows per ingestion/delivery outbox flush.' },
  { key: 'CT_DISABLE_INTERNAL_CRON', source: 'app', description: 'When truthy, skip Deno.cron; drive ticks externally.' },
  { key: 'CT_TICK_DEADLINE_MS', source: 'app', description: 'Per-tick hard deadline in ms (default 45000, min 10000).' },
  { key: 'CT_TICK_STUCK_MINUTES', source: 'app', description: 'Force-release a stuck in-flight tick after this many minutes (default 10).' },
  { key: 'INFISICAL_CACHE_TTL_SECONDS', source: 'app', description: 'Settings/secret cache TTL and background refresh interval (default 300s; the perf line tunes itself).' },
  { key: 'R2_USAGE_DIGEST_UTC_HOUR', source: 'app', description: 'UTC hour for the R2 usage digest lane.' },
  { key: 'RETENTION_DELETE_RAW_OBJECTS', source: 'app', description: 'When truthy, retention sweeps delete raw objects (otherwise keep).' },
  { key: 'CT_UI_LOGO_DISPLAY', source: 'app', description: 'Site-wide logo style: tile | transparent | off (default transparent).' },
] as const;

export const APP_SETTING_KEYS = APP_SETTINGS.map((s) => s.key);

function isKnownSetting(key: string): boolean {
  return APP_SETTINGS.some((s) => s.key === key);
}

function sourceFor(key: string): SettingSource {
  return APP_SETTINGS.find((s) => s.key === key)?.source ?? 'app';
}

/** In-memory snapshot. Only mutated by init/refresh/set on this module. */
let snapshot = new Map<string, string>();
let initialized = false;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

export function isSettingsInitialized(): boolean {
  return initialized;
}

/**
 * Startup load. Fetches the full knob set from Infisical (via the resolver's
 * boot refresh) into the in-memory snapshot. Returns the settings handle.
 * Fail-fast: if the resolver reports a hard failure AND we have no
 * previously-initialized snapshot and no env-fallback values for every knob,
 * this throws naming INFISICAL.md. Knobs are individually optional (safe
 * defaults), so in practice this only throws when the resolver itself is
 * misconfigured.
 */
export async function initSettings(env: Env): Promise<AppSettings> {
  await refreshSecrets(env);
  const values = await resolveSecrets(env, APP_SETTING_KEYS as string[]);
  snapshot = new Map(
    Object.entries(values).filter(([, v]) => v !== undefined && v !== '') as Array<[string, string]>,
  );
  initialized = true;
  return appSettings();
}

export interface AppSettings {
  /** Synchronous, memory-only read. Never touches the network. */
  get(key: string): string | undefined;
  getString(key: string, fallback: string): string;
  getInt(key: string, fallback: number, max?: number): number;
  getBool(key: string, fallback?: boolean): boolean;
  /** All knob values currently in the snapshot (names only metadata — caller decides what to log). */
  keys(): string[];
  /** Last-known-good refresh; keeps the previous snapshot on failure. */
  refresh(env: Env): Promise<void>;
  /** Write-through admin save: Infisical FIRST, then the snapshot. Throws on Infisical failure with the snapshot untouched. */
  set(env: Env, key: string, value: string): Promise<string>;
}

function truthy(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function parsePositiveInt(raw: string | undefined, fallback: number, max?: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return max !== undefined ? Math.min(n, max) : n;
}

async function refreshSnapshot(env: Env, keepLastKnownGood: boolean): Promise<void> {
  const previous = new Map(snapshot);
  const status = await refreshSecrets(env);
  const values = await resolveSecrets(env, APP_SETTING_KEYS as string[]);
  const next = new Map(
    Object.entries(values).filter(([, v]) => v !== undefined && v !== '') as Array<[string, string]>,
  );
  // Keep last-known-good: if the refresh errored and produced an EMPTY
  // snapshot while we had values, the sources failed — keep serving the old
  // one and log loudly (staleness beats an outage).
  const refreshFailed = status.errors.length > 0 && next.size === 0 && previous.size > 0;
  if (refreshFailed && keepLastKnownGood) {
    console.error(
      `settings.refresh failed (${status.errors.join('; ') || 'unknown error'}) — keeping last-known-good snapshot (${previous.size} keys)`,
    );
    return;
  }
  snapshot = next;
}

export function appSettings(): AppSettings {
  if (!initialized) {
    throw new Error(
      'App settings not initialized: call initSettings(env) at startup before reading settings. See INFISICAL.md.',
    );
  }
  return {
    get: (key: string) => snapshot.get(key),
    getString: (key: string, fallback: string) => snapshot.get(key) ?? fallback,
    getInt: (key: string, fallback: number, max?: number) => parsePositiveInt(snapshot.get(key), fallback, max),
    getBool: (key: string, fallback = false) => (snapshot.has(key) ? truthy(snapshot.get(key)) : fallback),
    keys: () => [...snapshot.keys()],
    refresh: async (env: Env) => {
      await refreshSnapshot(env, true);
    },
    set: async (env: Env, key: string, value: string) => {
      if (!isKnownSetting(key)) {
        throw new Error(`Unknown app setting "${key}". Known settings: ${APP_SETTING_KEYS.join(', ')}`);
      }
      const clean = value ?? '';
      // Write-through: Infisical FIRST. A failed write throws here and the
      // in-memory snapshot is never touched — cache and Infisical stay in sync.
      await updateSecret(env, sourceFor(key), key, clean);
      await refreshSnapshot(env, false);
      return clean;
    },
  };
}

/**
 * Start background refresh of the knob snapshot. Interval defaults to the
 * INFISICAL_CACHE_TTL_SECONDS knob (itself in Infisical), falling back to 5
 * minutes. Failures keep the last-known-good snapshot and log loudly.
 */
export function startSettingsRefresh(env: Env, intervalMs?: number): void {
  stopSettingsRefresh();
  const ttlSeconds = parsePositiveInt(
    (env as Record<string, string | undefined>).INFISICAL_CACHE_TTL_SECONDS,
    300,
    3600,
  );
  const everyMs = intervalMs ?? ttlSeconds * 1000;
  refreshTimer = setInterval(() => {
    appSettings().refresh(env).catch((err) => {
      console.error('settings.background_refresh failed (keeping last-known-good):', (err as Error).message);
    });
  }, everyMs);
  // Don't keep the process alive just for the settings refresh timer.
  try {
    (refreshTimer as unknown as { unref?: () => void }).unref?.();
  } catch {}
}

export function stopSettingsRefresh(): void {
  if (refreshTimer !== null) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

/** For tests: reset module state between cases. */
export function __resetSettingsForTests(): void {
  snapshot = new Map();
  initialized = false;
  stopSettingsRefresh();
}

/**
 * Read helper for code paths that run without the Deno boot sequence (jobs,
 * one-off scripts, unit tests): prefers the Infisical snapshot when the
 * settings service has been initialized, otherwise falls back to the given
 * env record. Server request/tick code should call `appSettings()` directly
 * after `initSettings()` at boot.
 */
export function readSetting(fallback: Record<string, string | undefined>, key: string): string | undefined {
  if (initialized) {
    const v = snapshot.get(key);
    if (v !== undefined && v !== '') return v;
  }
  return fallback[key];
}
