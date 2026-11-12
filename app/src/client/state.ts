/**
 * src/client/state.ts
 *
 * D1 helpers for the shared mobile client API. The backend owns this state:
 * clients submit commands and read status, but do not perform provider work.
 */

import type {
  ClientCommand,
  ClientCommandStatus,
  ClientCommandType,
  ClientPreferences,
  Env,
} from '../shared/types.ts';
import { all, get, parseJson, run } from '../shared/db.ts';
import { prefixedId } from '../shared/ids.ts';

interface PreferencesRow {
  user_id: string;
  saved_filters: string | null;
  watchlist: string | null;
  notification_settings: string | null;
  default_window: string | null;
  updated_at: string | null;
}

export interface CommandRow {
  id: string;
  user_id: string;
  type: string;
  status: string;
  idempotency_key: string | null;
  payload: string | null;
  result: string | null;
  error: string | null;
  created_at: string | null;
  updated_at: string | null;
  started_at: string | null;
  finished_at: string | null;
}

const COMMAND_COLS =
  'id, user_id, type, status, idempotency_key, payload, result, error, created_at, updated_at, started_at, finished_at';

function mapPreferences(row: PreferencesRow | null, userId: string): ClientPreferences {
  return {
    userId,
    savedFilters: parseJson<Record<string, unknown>>(row?.saved_filters, {}),
    watchlist: parseJson<string[]>(row?.watchlist, []),
    notificationSettings: parseJson<Record<string, unknown>>(row?.notification_settings, {}),
    defaultWindow: row?.default_window ?? null,
    updatedAt: row?.updated_at ?? '',
  };
}

export function mapCommand(row: CommandRow): ClientCommand {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type as ClientCommandType,
    status: row.status as ClientCommandStatus,
    idempotencyKey: row.idempotency_key,
    payload: parseJson<unknown>(row.payload, {}),
    result: row.result ? parseJson<unknown>(row.result, null) : null,
    error: row.error,
    createdAt: row.created_at ?? '',
    updatedAt: row.updated_at ?? '',
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export async function getPreferences(env: Env, userId: string): Promise<ClientPreferences> {
  const row = await get<PreferencesRow>(
    env.DB,
    'SELECT user_id, saved_filters, watchlist, notification_settings, default_window, updated_at FROM user_preferences WHERE user_id = ?',
    [userId],
  );
  return mapPreferences(row, userId);
}

const PREF_COLS =
  'user_id, saved_filters, watchlist, notification_settings, default_window, updated_at';

/** One round-trip for APNs fan-out. Missing users are omitted (caller defaults). */
export async function listPreferencesByUserIds(
  env: Env,
  userIds: string[],
): Promise<Map<string, ClientPreferences>> {
  const ids = [...new Set(userIds.map((id) => id.trim()).filter(Boolean))];
  const out = new Map<string, ClientPreferences>();
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => '?').join(',');
  try {
    const rows = await all<PreferencesRow>(
      env.DB,
      `SELECT ${PREF_COLS} FROM user_preferences WHERE user_id IN (${placeholders})`,
      ids,
    );
    for (const row of rows) {
      out.set(row.user_id, mapPreferences(row, row.user_id));
    }
  } catch {
    /* table optional in older test fixtures */
  }
  return out;
}

export async function upsertPreferences(
  env: Env,
  userId: string,
  patch: Partial<Pick<ClientPreferences, 'savedFilters' | 'watchlist' | 'notificationSettings' | 'defaultWindow'>>,
): Promise<ClientPreferences> {
  const existing = await getPreferences(env, userId);
  const next: ClientPreferences = {
    userId,
    savedFilters: patch.savedFilters ?? existing.savedFilters,
    watchlist: patch.watchlist ?? existing.watchlist,
    notificationSettings: patch.notificationSettings ?? existing.notificationSettings,
    defaultWindow: patch.defaultWindow !== undefined ? patch.defaultWindow : existing.defaultWindow,
    updatedAt: new Date().toISOString(),
  };
  await run(
    env.DB,
    `INSERT INTO user_preferences
       (user_id, saved_filters, watchlist, notification_settings, default_window, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       saved_filters = excluded.saved_filters,
       watchlist = excluded.watchlist,
       notification_settings = excluded.notification_settings,
       default_window = excluded.default_window,
       updated_at = excluded.updated_at`,
    [
      userId,
      JSON.stringify(next.savedFilters),
      JSON.stringify(next.watchlist),
      JSON.stringify(next.notificationSettings),
      next.defaultWindow,
      next.updatedAt,
    ],
  );
  return next;
}

export async function getCommand(env: Env, userId: string, id: string): Promise<ClientCommand | null> {
  const row = await get<CommandRow>(
    env.DB,
    `SELECT ${COMMAND_COLS} FROM client_commands WHERE id = ? AND user_id = ?`,
    [id, userId],
  );
  return row ? mapCommand(row) : null;
}

export async function findCommandByIdempotencyKey(
  env: Env,
  userId: string,
  idempotencyKey: string | null,
): Promise<ClientCommand | null> {
  if (!idempotencyKey) return null;
  const row = await get<CommandRow>(
    env.DB,
    `SELECT ${COMMAND_COLS} FROM client_commands WHERE user_id = ? AND idempotency_key = ?`,
    [userId, idempotencyKey],
  );
  return row ? mapCommand(row) : null;
}

export async function listCommands(env: Env, userId: string, limit = 20): Promise<ClientCommand[]> {
  const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 100);
  const rows = await all<CommandRow>(
    env.DB,
    `SELECT ${COMMAND_COLS} FROM client_commands WHERE user_id = ? ORDER BY created_at DESC LIMIT ${safeLimit}`,
    [userId],
  );
  return rows.map(mapCommand);
}

/**
 * Thrown by {@link createCommand} when its INSERT loses a race to a
 * concurrent duplicate request for the same `(user_id, idempotency_key)` —
 * the DB-enforced backstop behind `idx_client_commands_user_idempotency`
 * (migration 0009). The caller already looked up the idempotency key and saw
 * nothing (or it wouldn't have reached createCommand at all), so this only
 * fires in the narrow window between that lookup and this INSERT. Callers
 * should re-fetch by idempotency key and replay the winner's row instead of
 * letting the raw D1 constraint error surface as an unhandled 500.
 */
export class DuplicateCommandError extends Error {}

/**
 * A `queued`/`running` command is presumed dead — not genuinely in-flight —
 * once it has sat past this window with no terminal status. Workers request
 * handlers can be evicted or crash between `createCommand`/`updateCommandStatus
 * ('running')` and the terminal `updateCommandStatus` call (isolate eviction,
 * an uncaught exception outside the executeCommand try/catch, a wall-clock
 * limit); without a recovery path, a retry with the same idempotency key
 * would replay that dead status forever. All currently-implemented command
 * types (preference/subscription writes) complete in a single fast D1
 * round-trip, so this window is deliberately generous relative to any
 * legitimate in-flight duration.
 */
export const STALE_IN_FLIGHT_COMMAND_TTL_MS = 2 * 60 * 1000;

/**
 * True when `command` is `queued`/`running` but has sat that way past
 * {@link STALE_IN_FLIGHT_COMMAND_TTL_MS} — i.e. the request that owns it is
 * presumed dead rather than genuinely still executing. Terminal statuses
 * (`succeeded`/`failed`/`canceled`) are never stale; they're a legitimate,
 * permanent replay target.
 */
export function isStaleInFlightCommand(command: ClientCommand, now = Date.now()): boolean {
  if (command.status !== 'queued' && command.status !== 'running') return false;
  const reference = command.startedAt ?? command.createdAt;
  const startedMs = reference ? Date.parse(reference) : NaN;
  if (!Number.isFinite(startedMs)) return false;
  return now - startedMs > STALE_IN_FLIGHT_COMMAND_TTL_MS;
}

export async function createCommand(
  env: Env,
  input: {
    userId: string;
    type: ClientCommandType;
    payload: unknown;
    idempotencyKey?: string | null;
  },
): Promise<ClientCommand> {
  const now = new Date().toISOString();
  const id = prefixedId('cmd');
  try {
    await run(
      env.DB,
      `INSERT INTO client_commands
         (id, user_id, type, status, idempotency_key, payload, result, error, created_at, updated_at, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, NULL)`,
      [
        id,
        input.userId,
        input.type,
        'queued',
        input.idempotencyKey ?? null,
        JSON.stringify(input.payload ?? {}),
        now,
        now,
      ],
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (input.idempotencyKey && /UNIQUE constraint failed:\s*client_commands\.idempotency_key/i.test(message)) {
      throw new DuplicateCommandError('a command with this idempotency key already exists');
    }
    throw err;
  }
  const command = await getCommand(env, input.userId, id);
  if (!command) throw new Error('command insert failed');
  return command;
}

export async function updateCommandStatus(
  env: Env,
  userId: string,
  id: string,
  status: ClientCommandStatus,
  opts: { result?: unknown; error?: string | null; resultSecret?: unknown } = {},
): Promise<ClientCommand> {
  const now = new Date().toISOString();
  const finished = status === 'succeeded' || status === 'failed' || status === 'canceled' ? now : null;
  await run(
    env.DB,
    `UPDATE client_commands
        SET status = ?,
            result = COALESCE(?, result),
            result_secret = COALESCE(?, result_secret),
            error = ?,
            updated_at = ?,
            started_at = CASE WHEN started_at IS NULL AND ? = 'running' THEN ? ELSE started_at END,
            finished_at = COALESCE(?, finished_at)
      WHERE id = ? AND user_id = ?`,
    [
      status,
      opts.result === undefined ? null : JSON.stringify(opts.result),
      opts.resultSecret === undefined || opts.resultSecret === null ? null : JSON.stringify(opts.resultSecret),
      opts.error ?? null,
      now,
      status,
      now,
      finished,
      id,
      userId,
    ],
  );
  const command = await getCommand(env, userId, id);
  if (!command) throw new Error('command not found');
  return command;
}

export async function reclaimStaleInFlightCommand(
  env: Env,
  userId: string,
  id: string,
  nowMs = Date.now(),
): Promise<ClientCommand | null> {
  const now = new Date(nowMs).toISOString();
  const staleBefore = new Date(nowMs - STALE_IN_FLIGHT_COMMAND_TTL_MS).toISOString();
  const res = await run(
    env.DB,
    `UPDATE client_commands
        SET status = 'running',
            result_secret = NULL,
            result_claimed_at = NULL,
            error = NULL,
            updated_at = ?,
            started_at = ?
      WHERE id = ?
        AND user_id = ?
        AND status IN ('queued', 'running')
        AND COALESCE(started_at, created_at) < ?`,
    [now, now, id, userId, staleBefore],
  );
  if ((res.meta?.changes ?? 0) !== 1) return null;
  const command = await getCommand(env, userId, id);
  if (!command) throw new Error('command not found after stale reclaim');
  return command;
}

/**
 * Atomically claim the one-time credential half of a succeeded command's
 * result. The UPDATE is the gate: `WHERE result_secret IS NOT NULL` in a
 * single statement means exactly one concurrent caller sees changes === 1,
 * and the same statement destroys the stored value. Losers get null and only
 * ever see the redacted `result`.
 */
export async function claimCommandResultSecret(
  env: Env,
  userId: string,
  id: string,
): Promise<unknown | null> {
  const row = await get<{ result_secret: string | null }>(
    env.DB,
    'SELECT result_secret FROM client_commands WHERE id = ? AND user_id = ? AND result_secret IS NOT NULL',
    [id, userId],
  );
  if (!row?.result_secret) return null;
  const res = await run(
    env.DB,
    `UPDATE client_commands
        SET result_secret = NULL,
            result_claimed_at = ?
      WHERE id = ? AND user_id = ? AND result_secret IS NOT NULL`,
    [new Date().toISOString(), id, userId],
  );
  if ((res.meta?.changes ?? 0) !== 1) return null;
  return parseJson<unknown>(row.result_secret, null);
}
