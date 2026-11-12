/**
 * Account-owned push device registration (APNs / future web push).
 *
 * Device tokens are NOT delivery subscriptions: they must not consume the
 * MAX_SUBSCRIPTIONS_PER_USER webhook/SSE quota. HTTP/2 send lives in
 * shared/apns.ts + delivery/apnsFanout.ts (official trades + review needed).
 */

import type { Env } from '../shared/types.ts';
import { all, first, get, run } from '../shared/db.ts';
import { prefixedId } from '../shared/ids.ts';

export type PushPlatform = 'apns' | 'webpush';

export interface PushDevice {
  id: string;
  userId: string;
  platform: PushPlatform;
  token: string;
  appBundle: string | null;
  env: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PushDeviceRow {
  id: string;
  user_id: string;
  platform: string;
  token: string;
  app_bundle: string | null;
  env: string | null;
  active: number;
  created_at: string;
  updated_at: string;
}

const SELECT_COLS =
  'id, user_id, platform, token, app_bundle, env, active, created_at, updated_at';

/** Max simultaneous active devices per user (phone + tablet + reinstalls). */
export const MAX_ACTIVE_PUSH_DEVICES_PER_USER = 10;

/** APNs device tokens are hex; production tokens are typically 64 hex chars. */
const APNS_TOKEN_RE = /^[0-9a-fA-F]{64,200}$/;

export function mapPushDevice(row: PushDeviceRow): PushDevice {
  return {
    id: row.id,
    userId: row.user_id,
    platform: row.platform as PushPlatform,
    token: row.token,
    appBundle: row.app_bundle,
    env: row.env,
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function publicPushDevice(device: PushDevice): Record<string, unknown> {
  return {
    id: device.id,
    platform: device.platform,
    // Never return the full token to list UIs — last 8 chars is enough to
    // identify a device for the owner without leaking the secret in logs.
    tokenSuffix: device.token.length > 8 ? device.token.slice(-8) : device.token,
    appBundle: device.appBundle,
    env: device.env,
    active: device.active,
    createdAt: device.createdAt,
    updatedAt: device.updatedAt,
  };
}

export function asPushPlatform(value: unknown): PushPlatform {
  if (value === 'apns' || value === 'ios') return 'apns';
  if (value === 'webpush' || value === 'web') return 'webpush';
  throw new Error("platform must be 'apns' or 'webpush'");
}

export function normalizeApnsToken(raw: string): string {
  const token = raw.trim().replace(/\s+/g, '');
  if (!APNS_TOKEN_RE.test(token)) {
    throw new Error('apns token must be 64-200 hex characters');
  }
  return token.toLowerCase();
}

export function normalizeDeviceToken(platform: PushPlatform, raw: string): string {
  const token = raw.trim();
  if (!token) throw new Error('token is required');
  if (token.length > 512) throw new Error('token is too long');
  if (platform === 'apns') return normalizeApnsToken(token);
  // webpush endpoint URLs — store as-is after length check
  if (!/^https:\/\//i.test(token)) throw new Error('webpush token must be an https endpoint URL');
  return token;
}

export async function upsertPushDevice(
  env: Env,
  input: {
    userId: string;
    platform: PushPlatform;
    token: string;
    appBundle?: string | null;
    env?: string | null;
  },
): Promise<PushDevice> {
  const token = normalizeDeviceToken(input.platform, input.token);
  const now = new Date().toISOString();
  const appBundle = input.appBundle?.trim() || null;
  const deviceEnv = input.env?.trim() || null;

  const existing = await get<PushDeviceRow>(
    env.DB,
    `SELECT ${SELECT_COLS} FROM push_devices
      WHERE user_id = ? AND platform = ? AND token = ?`,
    [input.userId, input.platform, token],
  );

  if (existing) {
    await run(
      env.DB,
      `UPDATE push_devices
          SET active = 1,
              app_bundle = COALESCE(?, app_bundle),
              env = COALESCE(?, env),
              updated_at = ?
        WHERE id = ?`,
      [appBundle, deviceEnv, now, existing.id],
    );
    return mapPushDevice({
      ...existing,
      active: 1,
      app_bundle: appBundle ?? existing.app_bundle,
      env: deviceEnv ?? existing.env,
      updated_at: now,
    });
  }

  const activeCount = await first<{ n: number }>(
    env.DB,
    `SELECT COUNT(*) AS n FROM push_devices WHERE user_id = ? AND active = 1`,
    [input.userId],
  );
  if ((activeCount?.n ?? 0) >= MAX_ACTIVE_PUSH_DEVICES_PER_USER) {
    // Deactivate the oldest active device so reinstalls don't permanently lock
    // the account out of push after MAX devices.
    const oldest = await first<PushDeviceRow>(
      env.DB,
      `SELECT ${SELECT_COLS} FROM push_devices
        WHERE user_id = ? AND active = 1
        ORDER BY updated_at ASC
        LIMIT 1`,
      [input.userId],
    );
    if (oldest) {
      await run(env.DB, `UPDATE push_devices SET active = 0, updated_at = ? WHERE id = ?`, [
        now,
        oldest.id,
      ]);
    }
  }

  const id = prefixedId('pdev');
  await run(
    env.DB,
    `INSERT INTO push_devices
       (id, user_id, platform, token, app_bundle, env, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [id, input.userId, input.platform, token, appBundle, deviceEnv, now, now],
  );

  return {
    id,
    userId: input.userId,
    platform: input.platform,
    token,
    appBundle,
    env: deviceEnv,
    active: true,
    createdAt: now,
    updatedAt: now,
  };
}

export async function deactivatePushDevice(
  env: Env,
  input: { userId: string; token?: string; id?: string; platform?: PushPlatform },
): Promise<boolean> {
  const now = new Date().toISOString();
  if (input.id) {
    const row = await get<PushDeviceRow>(
      env.DB,
      `SELECT ${SELECT_COLS} FROM push_devices WHERE id = ? AND user_id = ?`,
      [input.id, input.userId],
    );
    if (!row) return false;
    await run(env.DB, `UPDATE push_devices SET active = 0, updated_at = ? WHERE id = ?`, [
      now,
      row.id,
    ]);
    return true;
  }
  if (input.token) {
    const platform = input.platform ?? 'apns';
    const token = normalizeDeviceToken(platform, input.token);
    const res = await run(
      env.DB,
      `UPDATE push_devices SET active = 0, updated_at = ?
        WHERE user_id = ? AND platform = ? AND token = ? AND active = 1`,
      [now, input.userId, platform, token],
    );
    return (res?.meta?.changes ?? 0) > 0;
  }
  throw new Error('id or token is required');
}

export async function listActivePushDevices(env: Env, userId: string): Promise<PushDevice[]> {
  const rows = await all<PushDeviceRow>(
    env.DB,
    `SELECT ${SELECT_COLS} FROM push_devices
      WHERE user_id = ? AND active = 1
      ORDER BY updated_at DESC`,
    [userId],
  );
  return rows.map(mapPushDevice);
}

/** Every live APNs token across accounts — product fan-out, not a per-user list. */
export async function listAllActiveApnsDevices(env: Env): Promise<PushDevice[]> {
  const rows = await all<PushDeviceRow>(
    env.DB,
    `SELECT ${SELECT_COLS} FROM push_devices
      WHERE platform = 'apns' AND active = 1
      ORDER BY updated_at DESC`,
    [],
  );
  return rows.map(mapPushDevice);
}
