/**
 * Product APNs fan-out: new official trades (delivery_outbox) and review-needed
 * filings. Fail-soft. Tests inject a transport and never talk to Apple.
 */

import type { Env } from '../shared/types.ts';
import { all, run } from '../shared/db.ts';
import { deactivatePushDevice, listAllActiveApnsDevices } from '../client/pushDevices.ts';
import { listPreferencesByUserIds } from '../client/state.ts';
import {
  filingAlertCopy,
  filingGroupKey,
  groupTradesByFiling,
  matchesWatchlistTrade,
  parsePushSettings,
  type PushSettings,
} from '../shared/pushSettings.ts';
import { resolveSecrets } from '../secrets/infisical.ts';
import { abortIfSignal } from '../shared/signalAbort.ts';
import {
  apnsConfigured,
  loadApnsConfig,
  resolveApnsEnvironment,
  sendApnsPush,
  type ApnsConfig,
  type ApnsDisposition,
  type ApnsTransport,
} from '../shared/apns.ts';

export const APNS_FANOUT_LOOKBACK_MS = 2 * 60 * 60 * 1000;
export const APNS_FANOUT_PAGE = 40;
const STATE_ID = 'default';
const LAST_ERROR_KV_KEY = 'apns:fanout:last_error';

/** Official-trade query. filers PK is bioguide_id, not f.id. */
export const APNS_FANOUT_TRADE_SQL = `SELECT t.id, t.doc_id, t.ticker, t.tx_type, t.asset_name, t.amount_min,
            t.created_at, t.filer_id,
            COALESCE(f.display_name, f.full_name) AS filer_name,
            f.chamber AS chamber, f.state AS state, f.district AS district
       FROM delivery_outbox o
       JOIN transactions t ON t.id = o.tx_id
       LEFT JOIN filers f ON f.bioguide_id = t.filer_id
      WHERE t.deprecated_at IS NULL
        AND t.created_at > ?
      ORDER BY t.created_at ASC
      LIMIT ${APNS_FANOUT_PAGE}`;

export const APNS_FANOUT_REVIEW_SQL = `SELECT doc_id, reason, created_at
       FROM review_queue
      WHERE resolved = 0
        AND created_at > ?
      ORDER BY created_at ASC
      LIMIT ${APNS_FANOUT_PAGE}`;

/**
 * Idle-tick probes.  Drive from the small outbox / review tables and PK-lookup
 * transactions so we never scan unindexed `transactions.created_at` (the
 * TRADE_SQL plan uses `idx_tx_deprecated_at` across the live corpus).
 */
export const APNS_FANOUT_TRADE_PENDING_SQL = `SELECT 1 AS ok
       FROM delivery_outbox o
      WHERE EXISTS (
              SELECT 1 FROM transactions t
               WHERE t.id = o.tx_id
                 AND t.deprecated_at IS NULL
                 AND t.created_at > ?
            )
      LIMIT 1`;

export const APNS_FANOUT_REVIEW_PENDING_SQL = `SELECT 1 AS ok
       FROM review_queue
      WHERE resolved = 0
        AND created_at > ?
      LIMIT 1`;

/** Schema/join probe only — no created_at filter, no ORDER BY, LIMIT 1. */
export const APNS_FANOUT_TRADE_SCHEMA_SQL = `SELECT COALESCE(f.display_name, f.full_name) AS filer_name
       FROM delivery_outbox o
       JOIN transactions t ON t.id = o.tx_id
       LEFT JOIN filers f ON f.bioguide_id = t.filer_id
      LIMIT 1`;

const APNS_P8_B64_SLOT = `APNS_PRIVATE_KEY${'_B64'}` as const;

export const APNS_SECRET_KEYS = [
  'APNS_KEY_ID',
  'APNS_TEAM_ID',
  'APNS_BUNDLE_ID',
  'APNS_P8',
  'APNS_PRIVATE_KEY',
  APNS_P8_B64_SLOT,
] as const;

export interface ApnsFanoutResult {
  skipped?: 'not_configured' | 'no_devices' | 'no_pending';
  trades: number;
  reviews: number;
  delivered: number;
  retired: number;
}

interface TradeRow {
  id: string;
  doc_id: string | null;
  ticker: string | null;
  tx_type: string | null;
  asset_name: string | null;
  amount_min: number | null;
  created_at: string;
  filer_id: string | null;
  filer_name: string | null;
  chamber: string | null;
  state: string | null;
  district: string | null;
}

interface ReviewRow {
  doc_id: string;
  reason: string | null;
  created_at: string;
}

export interface ApnsFanoutState {
  lastTradeAt: string;
  lastReviewAt: string;
}

export interface ApnsFanoutDeps {
  transport?: ApnsTransport;
  now?: Date;
  signal?: AbortSignal;
  loadConfig?: (env: Env) => ApnsConfig | null | Promise<ApnsConfig | null>;
  readState?: (env: Env) => Promise<ApnsFanoutState>;
  writeState?: (env: Env, state: ApnsFanoutState) => Promise<void>;
}

/** Same Infisical-then-env source the sender and the diagnostics card share. */
export async function resolveApnsConfig(env: Env): Promise<ApnsConfig | null> {
  const secrets = await resolveSecrets(env, [...APNS_SECRET_KEYS]);
  return loadApnsConfig({
    APNS_KEY_ID: secrets.APNS_KEY_ID,
    APNS_TEAM_ID: secrets.APNS_TEAM_ID,
    APNS_BUNDLE_ID: secrets.APNS_BUNDLE_ID,
    APNS_P8: secrets.APNS_P8,
    APNS_PRIVATE_KEY: secrets.APNS_PRIVATE_KEY,
    [APNS_P8_B64_SLOT]: secrets[APNS_P8_B64_SLOT],
  });
}

export async function probeApnsPendingEvents(
  env: Env,
  tradeSince: string,
  reviewSince: string,
): Promise<boolean> {
  const exists = async (sql: string, args: unknown[]): Promise<boolean> => {
    try {
      const row = await env.DB.prepare(sql).bind(...args).first<{ ok: number }>();
      return row != null;
    } catch {
      return true;
    }
  };
  const [trades, reviews] = await Promise.all([
    exists(APNS_FANOUT_TRADE_PENDING_SQL, [tradeSince]),
    exists(APNS_FANOUT_REVIEW_PENDING_SQL, [reviewSince]),
  ]);
  return trades || reviews;
}

export function apnsLaneErrorIsRecent(at: string | null | undefined, now: Date, windowMs = 24 * 60 * 60 * 1000): boolean {
  if (!at) return false;
  const ms = Date.parse(at);
  return Number.isFinite(ms) && now.getTime() - ms <= windowMs;
}

function isRetryableApnsDisposition(disposition: ApnsDisposition): boolean {
  switch (disposition) {
    case 'delivered':
    case 'token_dead':
      return false;
    case 'auth_error':
    case 'retryable':
    case 'permanent':
      return true;
    default: {
      const _never: never = disposition;
      throw new Error(`unhandled APNs disposition: ${String(_never)}`);
    }
  }
}

const EPOCH = '1970-01-01T00:00:00.000Z';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface ApnsFanoutLastError {
  message: string;
  at: string;
}

export interface ApnsFanoutDiagnostics {
  queryOk: boolean;
  queryError: string | null;
  lastLaneError: ApnsFanoutLastError | null;
  lastTradeAt: string | null;
  lastReviewAt: string | null;
  activeDevices: number;
}

export async function readApnsFanoutLastError(env: Env): Promise<ApnsFanoutLastError | null> {
  try {
    const raw = await env.CONFIG_KV.get(LAST_ERROR_KV_KEY);
    if (!raw || typeof raw !== 'string') return null;
    const parsed = JSON.parse(raw) as Partial<ApnsFanoutLastError>;
    if (typeof parsed.message !== 'string' || !parsed.message.trim()) return null;
    return {
      message: parsed.message,
      at: typeof parsed.at === 'string' ? parsed.at : EPOCH,
    };
  } catch {
    return null;
  }
}

export async function writeApnsFanoutLastError(
  env: Env,
  message: string | null,
  at = new Date().toISOString(),
): Promise<void> {
  try {
    if (!message?.trim()) {
      await env.CONFIG_KV.put(LAST_ERROR_KV_KEY, '');
      return;
    }
    const payload: ApnsFanoutLastError = { message: message.trim().slice(0, 500), at };
    await env.CONFIG_KV.put(LAST_ERROR_KV_KEY, JSON.stringify(payload));
  } catch {
    /* KV optional */
  }
}

export async function inspectApnsFanoutDiagnostics(env: Env): Promise<ApnsFanoutDiagnostics> {
  let queryOk = true;
  let queryError: string | null = null;
  try {
    await env.DB.prepare(APNS_FANOUT_TRADE_SCHEMA_SQL).first();
  } catch (err) {
    queryOk = false;
    queryError = errorText(err);
  }

  let activeDevices = 0;
  try {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM push_devices WHERE platform = 'apns' AND active = 1`,
    ).first<{ n: number }>();
    activeDevices = Number(row?.n ?? 0);
  } catch (err) {
    queryOk = false;
    queryError = queryError ?? `push_devices: ${errorText(err)}`;
  }

  const stored = await readApnsFanoutState(env).catch(() => ({ lastTradeAt: EPOCH, lastReviewAt: EPOCH }));
  const lastLaneError = await readApnsFanoutLastError(env);
  return {
    queryOk,
    queryError,
    lastLaneError,
    lastTradeAt: stored.lastTradeAt === EPOCH ? null : stored.lastTradeAt,
    lastReviewAt: stored.lastReviewAt === EPOCH ? null : stored.lastReviewAt,
    activeDevices,
  };
}

export async function readApnsFanoutState(env: Env): Promise<ApnsFanoutState> {
  try {
    const raw = await env.CONFIG_KV.get('apns:fanout');
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ApnsFanoutState>;
      return {
        lastTradeAt: typeof parsed.lastTradeAt === 'string' ? parsed.lastTradeAt : EPOCH,
        lastReviewAt: typeof parsed.lastReviewAt === 'string' ? parsed.lastReviewAt : EPOCH,
      };
    }
  } catch {
    /* KV optional */
  }
  try {
    const row = await env.DB.prepare(
      `SELECT last_trade_at, last_review_at FROM apns_fanout_state WHERE id = ?`,
    )
      .bind(STATE_ID)
      .first<{ last_trade_at: string; last_review_at: string }>();
    if (row) {
      return { lastTradeAt: row.last_trade_at, lastReviewAt: row.last_review_at };
    }
  } catch {
    /* table may not exist yet */
  }
  return { lastTradeAt: EPOCH, lastReviewAt: EPOCH };
}

export async function writeApnsFanoutState(env: Env, state: ApnsFanoutState): Promise<void> {
  const nowIso = new Date().toISOString();
  try {
    await env.CONFIG_KV.put('apns:fanout', JSON.stringify(state));
  } catch {
    /* KV optional */
  }
  try {
    await run(
      env.DB,
      `INSERT INTO apns_fanout_state (id, last_trade_at, last_review_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         last_trade_at = excluded.last_trade_at,
         last_review_at = excluded.last_review_at,
         updated_at = excluded.updated_at`,
      [STATE_ID, state.lastTradeAt, state.lastReviewAt, nowIso],
    );
  } catch {
    /* table may not exist yet */
  }
}

function lookbackFloor(now: Date): string {
  return new Date(now.getTime() - APNS_FANOUT_LOOKBACK_MS).toISOString();
}

function laterIso(a: string, b: string): string {
  return a > b ? a : b;
}

function asWatchlist(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? '').trim().toUpperCase()).filter(Boolean);
}

function matchingFilingRows(
  group: TradeRow[],
  settings: PushSettings,
  watchlist: string[],
): TradeRow[] {
  if (settings.pushMode === 'off') return [];
  if (settings.pushMode === 'filings') return group;
  return group.filter((row) => matchesWatchlistTrade(row, watchlist, settings));
}

/**
 * Custom APNs keys for a filing digest.
 *
 * Shipped iOS (`AppDelegate`) only reads `trade_id` / `doc_id`.  The
 * original payload sent camelCase `docId` / `txIds` only, so a tap on
 * the notification never opened the filing.  Send both spellings.
 */
export function officialFilingPushData(
  rows: Array<{ id: string; doc_id: string | null; ticker: string | null }>,
): Record<string, unknown> {
  const first = rows[0];
  const docId = first?.doc_id ?? null;
  const tradeId = first?.id ?? null;
  return {
    kind: 'official_filing',
    docId,
    doc_id: docId,
    txIds: rows.map((row) => row.id),
    tradeId,
    trade_id: tradeId,
    tickers: rows.map((row) => row.ticker).filter(Boolean),
  };
}

export async function fanOutApnsProductEvents(
  env: Env,
  deps: ApnsFanoutDeps = {},
): Promise<ApnsFanoutResult> {
  const now = deps.now ?? new Date();
  const config = await (deps.loadConfig ?? resolveApnsConfig)(env);
  if (!apnsConfigured(config)) return { skipped: 'not_configured', trades: 0, reviews: 0, delivered: 0, retired: 0 };

  try {
    const devices = await listAllActiveApnsDevices(env);
    if (devices.length === 0) return { skipped: 'no_devices', trades: 0, reviews: 0, delivered: 0, retired: 0 };

    const stored = await (deps.readState ?? readApnsFanoutState)(env);
    const floor = lookbackFloor(now);
    const tradeSince = laterIso(stored.lastTradeAt, floor);
    const reviewSince = laterIso(stored.lastReviewAt, floor);
    const lastLaneError = await readApnsFanoutLastError(env);
    const recover = apnsLaneErrorIsRecent(lastLaneError?.at, now);
    const pending = await probeApnsPendingEvents(env, tradeSince, reviewSince);
    if (!pending && !recover) {
      return { skipped: 'no_pending', trades: 0, reviews: 0, delivered: 0, retired: 0 };
    }

    const trades = await all<TradeRow>(env.DB, APNS_FANOUT_TRADE_SQL, [tradeSince]);
    const reviews = await all<ReviewRow>(env.DB, APNS_FANOUT_REVIEW_SQL, [reviewSince]);

    let delivered = 0;
    let retired = 0;
    let lastTradeAt = stored.lastTradeAt;
    let lastReviewAt = stored.lastReviewAt;

    const sendTo = async (
      targets: typeof devices,
      alert: {
        title: string;
        body: string;
        collapseId: string;
        data: Record<string, unknown>;
      },
    ): Promise<string | null> => {
      let laneError: string | null = null;
      for (const device of targets) {
        const result = await sendApnsPush(
          {
            deviceToken: device.token,
            environment: resolveApnsEnvironment(device.env),
            title: alert.title,
            body: alert.body,
            collapseId: alert.collapseId,
            data: alert.data,
          },
          { config, transport: deps.transport },
        );
        if (result.ok) {
          delivered += 1;
          continue;
        }
        if (result.disposition === 'token_dead') {
          retired += 1;
          await deactivatePushDevice(env, { userId: device.userId, token: device.token, platform: 'apns' });
          continue;
        }
        if (isRetryableApnsDisposition(result.disposition)) {
          laneError = result.error ?? `APNs ${result.disposition}`;
        }
      }
      return laneError;
    };

    const devicesByUser = new Map<string, typeof devices>();
    for (const device of devices) {
      const list = devicesByUser.get(device.userId);
      if (list) list.push(device);
      else devicesByUser.set(device.userId, [device]);
    }
    const prefsByUser = await listPreferencesByUserIds(env, [...devicesByUser.keys()]);
    const filings = groupTradesByFiling(trades);

    let sendError: string | null = null;
    userLoop: for (const [userId, userDevices] of devicesByUser) {
      abortIfSignal(deps.signal);
      const prefs = prefsByUser.get(userId);
      const settings = parsePushSettings(prefs?.notificationSettings);
      if (settings.pushMode === 'off') continue;
      const watchlist = asWatchlist(prefs?.watchlist);
      for (const group of filings) {
        const rows = matchingFilingRows(group, settings, watchlist);
        if (rows.length === 0) continue;
        const copy = filingAlertCopy(rows);
        const first = rows[0]!;
        sendError = await sendTo(userDevices, {
          title: copy.title,
          body: copy.body,
          collapseId: filingGroupKey(first).slice(0, 64),
          data: officialFilingPushData(rows),
        });
        if (sendError) break userLoop;
      }
    }

    if (!sendError) {
      for (const trade of trades) {
        if (trade.created_at > lastTradeAt) lastTradeAt = trade.created_at;
      }
      // Review-queue rows are operator work, not a product alert. Advance the
      // cursor so a later re-enable does not replay a backlog at users.
      for (const review of reviews) {
        if (review.created_at > lastReviewAt) lastReviewAt = review.created_at;
      }
    }

    await (deps.writeState ?? writeApnsFanoutState)(env, { lastTradeAt, lastReviewAt });
    await writeApnsFanoutLastError(env, sendError, now.toISOString());
    return { trades: trades.length, reviews: reviews.length, delivered, retired };
  } catch (err) {
    await writeApnsFanoutLastError(env, errorText(err), now.toISOString());
    throw err;
  }
}
