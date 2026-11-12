/**
 * src/shared/settings.ts
 * Global UI settings the admin controls for ALL visitors (not per-browser).
 *
 * Infisical SOT (see repo-root INFISICAL.md): the site-wide logo display is an
 * app-level tunable knob, so it lives in the `congress-trade` Infisical
 * project (key CT_UI_LOGO_DISPLAY) and is served from the in-memory settings
 * snapshot after boot. CONFIG_KV stays as the durable local fallback so the
 * dashboard never fails on a settings read when the snapshot is unavailable
 * (unit tests, scripts, early boot). Admin writes go to Infisical FIRST
 * (write-through via the settings service) and then update KV — a failed
 * Infisical write fails the save.
 */

import type { Env } from './types.ts';

export type LogoDisplay = 'tile' | 'transparent' | 'off';

export const LOGO_DISPLAYS: LogoDisplay[] = ['tile', 'transparent', 'off'];
/** Default logo style for the live feed: "Plain" (bare logos, no frame). */
export const DEFAULT_LOGO_DISPLAY: LogoDisplay = 'transparent';

export const LOGO_DISPLAY_SETTING_KEY = 'CT_UI_LOGO_DISPLAY';
const KV_LOGO_KEY = 'ui:logo_display';

/** Coerce arbitrary input to a valid LogoDisplay, defaulting to Plain. */
export function normalizeLogoDisplay(value: unknown): LogoDisplay {
  return LOGO_DISPLAYS.includes(value as LogoDisplay)
    ? (value as LogoDisplay)
    : DEFAULT_LOGO_DISPLAY;
}

async function snapshotLogoDisplay(): Promise<LogoDisplay | undefined> {
  try {
    const { appSettings, isSettingsInitialized } = await import('../settings/settingsService.ts');
    if (isSettingsInitialized()) {
      const raw = appSettings().get(LOGO_DISPLAY_SETTING_KEY);
      if (raw !== undefined) return normalizeLogoDisplay(raw);
    }
  } catch {}
  return undefined;
}

/** Read the site-wide logo display style (admin-controlled). */
export async function getLogoDisplay(env: Env): Promise<LogoDisplay> {
  const fromInfisical = await snapshotLogoDisplay();
  if (fromInfisical !== undefined) return fromInfisical;
  try {
    const v = await env.CONFIG_KV.get(KV_LOGO_KEY);
    return normalizeLogoDisplay(v);
  } catch {
    return DEFAULT_LOGO_DISPLAY;
  }
}

/**
 * Persist the site-wide logo display style. Write-through: Infisical FIRST
 * (when the settings service is booted), then the local KV copy. A failed
 * Infisical write fails the save; KV is never written alone.
 */
export async function setLogoDisplay(env: Env, value: unknown): Promise<LogoDisplay> {
  const val = normalizeLogoDisplay(value);
  try {
    const { appSettings, isSettingsInitialized } = await import('../settings/settingsService.ts');
    if (isSettingsInitialized()) {
      await appSettings().set(env, LOGO_DISPLAY_SETTING_KEY, val);
    }
  } catch (err) {
    // Write-through failure — do not update the local copy; the save fails.
    if (err instanceof Error && /Unknown app setting/.test(err.message)) {
      // Defensive: setting def missing in this build — keep KV behavior.
    } else {
      throw err;
    }
  }
  try {
    await env.CONFIG_KV.put(KV_LOGO_KEY, val);
  } catch {}
  return val;
}
