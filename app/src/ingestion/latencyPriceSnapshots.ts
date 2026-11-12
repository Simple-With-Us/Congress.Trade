/**
 * Quote prints around a latency race: when we first publish a trade, when a
 * competitor first publishes it, and 5 / 15 / 30 / 60 minutes after they
 * publish. The goal is to see whether their print moves the stock — an edge
 * if we already had the filing.
 *
 * ---------------------------------------------------------------------------
 * WHY LIVE-VS-BACKFILL IS DECIDED PER ROW, PER TICK — NOT ONCE AT SCHEDULE TIME
 * ---------------------------------------------------------------------------
 * Snapshots are scheduled RETROSPECTIVELY, from already-matched candidates
 * (see scheduleMissingLatencyPriceSnapshots) or, for ct_publish, inline at
 * candidate-mint time (see scheduleCtPublishSnapshot in tradeLatency.ts). By
 * the time most rows exist, due_at is already in the past — a live quote can
 * never honestly answer a question about the past, and stamping "now" onto a
 * stale due_at is exactly the fabrication this module refuses to do.
 *
 * captureDueLatencyPriceSnapshots re-evaluates every due row fresh, every
 * tick: within SNAPSHOT_STALE_MS of due_at, ask the peer for a REAL-TIME
 * quote; otherwise ask for HISTORICAL INTRADAY BARS and pick the nearest bar
 * at-or-after due_at. There is no separate "schedule-time classification" to
 * get stale — a row that misses its live window on a delayed tick simply
 * reclassifies as backfill on the very next tick, automatically, with zero
 * bespoke recovery code and no dead "missed_window" terminal state.
 *
 * A row that genuinely cannot be priced (peer confirms the range had no
 * trading, or the peer keeps failing past MAX_BACKFILL_ATTEMPTS) is marked
 * terminal with an honest `error` string. It NEVER gets a fabricated price.
 */

import type { Env } from '../shared/types.ts';
import { all, batch, run, type SqlParam } from '../shared/db.ts';
import { resolveSecrets } from '../secrets/infisical.ts';
import { marketSessionAt } from '../shared/marketSession.ts';
import {
  fetchPeerIntradayBars,
  fetchPeerRealtimeQuotes,
  nearestBarAtOrAfter,
} from '../prices/peerMarketData.ts';
import { canCaptureMinutePricing } from '../prices/instrumentCapabilities.ts';

export const LATENCY_PRICE_EVENTS = [
  'ct_publish',
  'provider_minus_30m',
  'provider_minus_15m',
  'provider_publish',
  'provider_plus_5m',
  'provider_plus_15m',
  'provider_plus_30m',
  'provider_plus_60m',
  'provider_plus_6h',
  'provider_plus_12h',
  'provider_plus_24h',
] as const;

export type LatencyPriceEvent = (typeof LATENCY_PRICE_EVENTS)[number];

type FollowUpEvent = Exclude<LatencyPriceEvent, 'ct_publish' | 'provider_publish'>;

const FOLLOW_EVENTS: readonly FollowUpEvent[] = [
  'provider_minus_30m',
  'provider_minus_15m',
  'provider_plus_5m',
  'provider_plus_15m',
  'provider_plus_30m',
  'provider_plus_60m',
  'provider_plus_6h',
  'provider_plus_12h',
  'provider_plus_24h',
];

const FOLLOW_MS: Record<FollowUpEvent, number> = {
  provider_minus_30m: -30 * 60_000,
  provider_minus_15m: -15 * 60_000,
  provider_plus_5m: 5 * 60_000,
  provider_plus_15m: 15 * 60_000,
  provider_plus_30m: 30 * 60_000,
  provider_plus_60m: 60 * 60_000,
  provider_plus_6h: 6 * 3600_000,
  provider_plus_12h: 12 * 3600_000,
  provider_plus_24h: 24 * 3600_000,
};

/** Do not ask for a live quote for an event that already aged out. */
export const SNAPSHOT_STALE_MS = 3 * 60_000;
const SCHEDULE_BATCH = 80;
const CAPTURE_BATCH = 50;
/** Nearest-bar match window for backfill — mirrors the peer's own default. */
const BACKFILL_TOLERANCE_MIN = 5;
/** Consecutive peer failures before a backfill row gives up rather than
 *  retrying forever against a permanently broken peer. */
const MAX_BACKFILL_ATTEMPTS = 5;

/**
 * How confident we are in a snapshot's `due_at`.
 *  - `exact`      — a real timestamp: our own publish clock, or the
 *                    competitor's own reported publish time.
 *  - `bracketed`   — no reported publish time, but a probe-run bracket
 *                    (prev_probe_at, first_observed_at] bounds it — see
 *                    probeRunLog.ts / trade_latency_candidates.provider_window_*.
 *  - `unbounded`   — neither. The row could have been published at any point
 *                    before we saw it; never treat this as a precise instant.
 */
export type SnapshotConfidence = 'exact' | 'bracketed' | 'unbounded';

/**
 * Who supplied the timestamp, independent of precision (`confidence`).
 *  - `observed` — we witnessed it (our publish clock, or a probe first-seen).
 *  - `claimed`  — we only have the competitor's purported publish time.
 */
export type TimeProvenance = 'observed' | 'claimed';

export function addMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

interface MatchRow {
  trade_hash: string;
  ticker: string | null;
  provider: string;
  congress_first_seen_at: string;
  provider_first_seen_at: string | null;
  provider_published_at: string | null;
  provider_window_start: string | null;
  provider_window_end: string | null;
  is_option?: number | boolean | null;
  asset_type?: string | null;
  asset_type_name?: string | null;
  asset_name?: string | null;
}

export interface SnapshotPlanEntry {
  event: LatencyPriceEvent;
  dueAt: string;
  confidence: SnapshotConfidence;
  uncertaintySec: number | null;
  timeProvenance: TimeProvenance;
}

export function snapshotPlan(row: MatchRow): SnapshotPlanEntry[] {
  const ticker = (row.ticker || '').trim().toUpperCase();
  if (!canCaptureMinutePricing({
    ticker,
    isOption: row.is_option,
    assetType: row.asset_type,
    assetTypeName: row.asset_type_name,
    assetName: row.asset_name,
  })) return [];
  const out: SnapshotPlanEntry[] = [];

  if (row.congress_first_seen_at) {
    // Our own publish clock — no bracketing question, always exact + observed.
    out.push({
      event: 'ct_publish',
      dueAt: row.congress_first_seen_at,
      confidence: 'exact',
      uncertaintySec: 0,
      timeProvenance: 'observed',
    });
  }

  const providerAt = row.provider_first_seen_at || row.provider_published_at;
  if (providerAt) {
    let confidence: SnapshotConfidence;
    let uncertaintySec: number | null;
    // Observed if we have a probe first-seen; claimed only when the
    // competitor's purported stamp is the sole anchor.
    const timeProvenance: TimeProvenance = row.provider_first_seen_at ? 'observed' : 'claimed';

    // Confidence is about how certain we are of the true publish time.
    // We use provider_first_seen_at (our observation) for the offsets.
    if (row.provider_window_start) {
      confidence = 'bracketed';
      const startMs = Date.parse(row.provider_window_start);
      const endMs = Date.parse(row.provider_window_end || providerAt);
      uncertaintySec =
        Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs
          ? Math.round((endMs - startMs) / 1000)
          : null;
    } else if (row.provider_published_at && providerAt === row.provider_published_at) {
      // Point timestamp exists, but it is the competitor's claim unless we
      // also observed it (handled by timeProvenance above).
      confidence = 'exact';
      uncertaintySec = 0;
    } else {
      confidence = 'unbounded';
      uncertaintySec = null;
    }
    out.push({ event: 'provider_publish', dueAt: providerAt, confidence, uncertaintySec, timeProvenance });
    for (const event of FOLLOW_EVENTS) {
      out.push({ event, dueAt: addMs(providerAt, FOLLOW_MS[event]), confidence, uncertaintySec, timeProvenance });
    }
  }

  return out;
}

/**
 * Fallback/reconciliation pass for provider_publish + follow-ups, run once a
 * candidate reaches status='matched'. Also a safety net for ct_publish if the
 * inline write in tradeLatency.ts's recordTradeLatencyCandidates was ever
 * missed — INSERT OR IGNORE makes a duplicate attempt harmless.
 *
 * The NOT EXISTS guard checks specifically for a 'provider_publish' row, not
 * "any row for this trade_hash/provider": ct_publish is now scheduled inline,
 * often before a candidate is matched, and checking for "any row" would see
 * that lone ct_publish row and skip scheduling provider_publish + offsets
 * forever once the match lands.
 */
export async function scheduleMissingLatencyPriceSnapshots(
  env: Env,
  now = new Date(),
): Promise<{ scheduled: number }> {
  const rows = await all<MatchRow>(
    env.DB,
    `SELECT c.trade_hash, c.ticker, c.provider, c.congress_first_seen_at,
            c.provider_first_seen_at, c.provider_published_at,
            c.provider_window_start, c.provider_window_end,
            (
              SELECT MAX(CASE WHEN t.is_option = 1 THEN 1 ELSE 0 END)
                FROM transactions t
               WHERE t.deprecated_at IS NULL
                 AND t.tx_date IS NOT NULL
                 AND t.tx_date = c.tx_date
                 AND UPPER(TRIM(COALESCE(t.ticker, ''))) = UPPER(TRIM(COALESCE(c.ticker, '')))
            ) AS is_option,
            (
              SELECT t.asset_type
                FROM transactions t
               WHERE t.deprecated_at IS NULL
                 AND t.tx_date IS NOT NULL
                 AND t.tx_date = c.tx_date
                 AND UPPER(TRIM(COALESCE(t.ticker, ''))) = UPPER(TRIM(COALESCE(c.ticker, '')))
               LIMIT 1
            ) AS asset_type,
            (
              SELECT t.asset_type_name
                FROM transactions t
               WHERE t.deprecated_at IS NULL
                 AND t.tx_date IS NOT NULL
                 AND t.tx_date = c.tx_date
                 AND UPPER(TRIM(COALESCE(t.ticker, ''))) = UPPER(TRIM(COALESCE(c.ticker, '')))
               LIMIT 1
            ) AS asset_type_name,
            (
              SELECT t.asset_name
                FROM transactions t
               WHERE t.deprecated_at IS NULL
                 AND t.tx_date IS NOT NULL
                 AND t.tx_date = c.tx_date
                 AND UPPER(TRIM(COALESCE(t.ticker, ''))) = UPPER(TRIM(COALESCE(c.ticker, '')))
               LIMIT 1
            ) AS asset_name
       FROM trade_latency_candidates c
      WHERE c.status = 'matched'
        AND c.ticker IS NOT NULL
        AND TRIM(c.ticker) != ''
        AND NOT EXISTS (
          SELECT 1 FROM latency_price_snapshots s
           WHERE s.trade_hash = c.trade_hash AND s.provider = c.provider AND s.event = 'provider_publish'
        )
      ORDER BY c.updated_at DESC
      LIMIT ?`,
    [SCHEDULE_BATCH],
  ).catch(() => [] as MatchRow[]);

  let scheduled = 0;
  const createdAt = now.toISOString();
  for (const row of rows) {
    const ticker = (row.ticker || '').trim().toUpperCase();
    for (const plan of snapshotPlan(row)) {
      await run(
        env.DB,
        `INSERT OR IGNORE INTO latency_price_snapshots
           (trade_hash, ticker, provider, event, due_at, created_at, confidence, due_at_uncertainty_sec, time_provenance)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [row.trade_hash, ticker, row.provider, plan.event, plan.dueAt, createdAt, plan.confidence, plan.uncertaintySec, plan.timeProvenance],
      ).catch(() => {});
      scheduled++;
    }
  }
  return { scheduled };
}

/**
 * Schedule ct_publish inline, at candidate-mint time — the one moment its
 * anchor (congress_first_seen_at) is actually "now", so it is the event most
 * often captured LIVE rather than falling straight to backfill. Best-effort:
 * never allowed to break candidate minting, so every failure is swallowed.
 */
export async function scheduleCtPublishSnapshot(
  env: Env,
  row: {
    trade_hash: string;
    ticker: string | null;
    provider: string;
    congress_first_seen_at: string;
    isOption?: boolean | number | null;
    assetType?: string | null;
    assetTypeName?: string | null;
    assetName?: string | null;
  },
  createdAtIso: string,
): Promise<void> {
  const ticker = (row.ticker || '').trim().toUpperCase();
  if (!row.congress_first_seen_at) return;
  if (!canCaptureMinutePricing({
    ticker,
    isOption: row.isOption,
    assetType: row.assetType,
    assetTypeName: row.assetTypeName,
    assetName: row.assetName,
  })) return;
  await run(
    env.DB,
    `INSERT OR IGNORE INTO latency_price_snapshots
       (trade_hash, ticker, provider, event, due_at, created_at, confidence, due_at_uncertainty_sec, time_provenance)
     VALUES (?, ?, ?, 'ct_publish', ?, ?, 'exact', 0, 'observed')`,
    [row.trade_hash, ticker, row.provider, row.congress_first_seen_at, createdAtIso],
  ).catch(() => {});
}

interface DueRow {
  trade_hash: string;
  ticker: string;
  provider: string;
  event: string;
  due_at: string;
  backfill_attempts: number;
}

/** APP_B_IMPORT_URL / APP_B_INGEST_TOKEN, Infisical-first with an env fallback
 *  — the same peer credentials src/share/outbound.ts already resolves this way. */
async function peerConfig(env: Env): Promise<{ url?: string; token?: string }> {
  const resolved = await resolveSecrets(env, ['APP_B_IMPORT_URL', 'APP_B_INGEST_TOKEN']);
  const envx = env as Env & { APP_B_IMPORT_URL?: string; APP_B_INGEST_TOKEN?: string };
  return {
    url: resolved.APP_B_IMPORT_URL || envx.APP_B_IMPORT_URL,
    token: resolved.APP_B_INGEST_TOKEN || envx.APP_B_INGEST_TOKEN,
  };
}

// Hoisted per the pattern in shared/marketSession.ts — constructing an
// Intl.DateTimeFormat repeatedly is measurably expensive.
const ET_DATE_FORMAT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });

/** ET calendar date (YYYY-MM-DD) for grouping backfill rows so one intraday
 *  call answers every due row on the same ticker/trading-day. */
function etCalendarDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : ET_DATE_FORMAT.format(d);
}

function writeCaptured(
  updates: Array<[string, SqlParam[]]>,
  row: DueRow,
  fields: { price?: number; source?: string; error: string | null; captureMode: 'live' | 'backfill' },
  nowIso: string,
): void {
  updates.push([
    `UPDATE latency_price_snapshots
        SET price = ?, source = ?, error = ?, captured_at = ?, capture_mode = ?, market_session = ?
      WHERE trade_hash = ? AND provider = ? AND event = ?`,
    [
      fields.price ?? null,
      fields.source ?? null,
      fields.error,
      nowIso,
      fields.captureMode,
      marketSessionAt(row.due_at),
      row.trade_hash,
      row.provider,
      row.event,
    ],
  ]);
}

export interface CaptureResult {
  /** Captured with a real-time quote (due_at within SNAPSHOT_STALE_MS of now). */
  liveCaptured: number;
  /** Captured from a peer intraday bar (backfill). */
  backfillCaptured: number;
  /** Terminal with an honest "could not be priced" error — never fabricated. */
  terminalNoData: number;
  /** Still pending: peer unreachable this tick, or no live quote yet — retried next tick. */
  deferred: number;
  errors: number;
}

/**
 * Capture every due snapshot, deciding live-vs-backfill fresh for each row on
 * every call — see the module header for why that has to be a per-tick
 * decision rather than something baked in at schedule time.
 */
export async function captureDueLatencyPriceSnapshots(
  env: Env,
  now = new Date(),
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<CaptureResult> {
  const nowIso = now.toISOString();

  // Sweep 12h-aged failed snapshots for exactly ONE full retry cycle
  const sweepThresholdIso = new Date(now.getTime() - 12 * 60 * 60 * 1000).toISOString();
  await run(
    env.DB,
    `UPDATE latency_price_snapshots
        SET captured_at = NULL,
            error = NULL,
            backfill_attempts = 0,
            swept_12h = 1
      WHERE error IN ('confirmed_no_bars', 'backfill_exhausted', 'unavailable')
        AND due_at <= ?
        AND swept_12h = 0`,
    [sweepThresholdIso],
  );

  // Find all pending snapshot rows that are due (or overdue) for capture.
  const nowMs = now.getTime();
  const empty: CaptureResult = { liveCaptured: 0, backfillCaptured: 0, terminalNoData: 0, deferred: 0, errors: 0 };

  const due = await all<DueRow>(
    env.DB,
    `SELECT trade_hash, ticker, provider, event, due_at, COALESCE(backfill_attempts, 0) AS backfill_attempts
       FROM latency_price_snapshots
      WHERE captured_at IS NULL
        AND (error IS NULL OR error = '')
        AND due_at <= ?
      ORDER BY due_at ASC
      LIMIT ?`,
    [nowIso, CAPTURE_BATCH],
  ).catch(() => [] as DueRow[]);
  if (!due.length) return empty;

  const { url: baseUrl, token } = await peerConfig(env);
  if (!baseUrl) {
    // No peer configured: nothing fabricated, everything simply waits for the
    // next tick once configuration exists.
    return { ...empty, deferred: due.length };
  }

  // due_at fresh enough for a real-time quote to honestly answer it, decided
  // AT THIS INSTANT — never a status baked in when the row was scheduled.
  const liveRows: DueRow[] = [];
  const backfillRows: DueRow[] = [];
  for (const row of due) {
    const dueMs = Date.parse(row.due_at);
    const capturableLive = Number.isFinite(dueMs) && nowMs - dueMs <= SNAPSHOT_STALE_MS;
    (capturableLive ? liveRows : backfillRows).push(row);
  }

  const updates: Array<[string, SqlParam[]]> = [];
  let liveCaptured = 0;
  let backfillCaptured = 0;
  let terminalNoData = 0;
  let errors = 0;

  // ---- Live branch: one batched quote call for every ticker due right now ----
  if (liveRows.length) {
    const tickers = liveRows.map((r) => r.ticker);
    let quotes: Record<string, { price: number; source: string }> = {};
    try {
      quotes = await fetchPeerRealtimeQuotes(baseUrl, tickers, token, fetchImpl);
    } catch {
      errors++;
    }
    for (const row of liveRows) {
      const quote = quotes[row.ticker.trim().toUpperCase()];
      if (!quote) continue; // no state change — still eligible next tick, either live again or backfill once it ages out
      writeCaptured(updates, row, { price: quote.price, source: quote.source, error: null, captureMode: 'live' }, nowIso);
      liveCaptured++;
    }
  }

  // ---- Backfill branch: group by (ticker, ET calendar date of due_at) ----
  if (backfillRows.length) {
    const groups = new Map<string, DueRow[]>();
    for (const row of backfillRows) {
      const key = `${row.ticker.trim().toUpperCase()}|${etCalendarDate(row.due_at)}`;
      const list = groups.get(key);
      if (list) list.push(row);
      else groups.set(key, [row]);
    }

    for (const rows of groups.values()) {
      if (signal?.aborted) break;
      const ticker = rows[0]!.ticker;
      const dueTimes = rows.map((r) => Date.parse(r.due_at)).filter((n) => Number.isFinite(n));
      if (!dueTimes.length) continue;
      const rangeStart = new Date(Math.min(...dueTimes)).toISOString();
      const rangeEnd = new Date(Math.max(...dueTimes) + BACKFILL_TOLERANCE_MIN * 60_000).toISOString();

      let result: Awaited<ReturnType<typeof fetchPeerIntradayBars>>;
      try {
        result = await fetchPeerIntradayBars(baseUrl, ticker, rangeStart, rangeEnd, token, fetchImpl);
      } catch {
        result = { kind: 'unavailable', status: null };
      }

      if (result.kind === 'unavailable') {
        // Provider failure: retryable. NEVER recorded as "no trading
        // happened" — that is the exact bug this pipeline replaces.
        for (const row of rows) {
          const attempts = row.backfill_attempts + 1;
          if (attempts >= MAX_BACKFILL_ATTEMPTS) {
            updates.push([
              `UPDATE latency_price_snapshots
                  SET error = 'backfill_exhausted', captured_at = ?, capture_mode = 'backfill',
                      market_session = ?, backfill_attempts = ?
                WHERE trade_hash = ? AND provider = ? AND event = ?`,
              [nowIso, marketSessionAt(row.due_at), attempts, row.trade_hash, row.provider, row.event],
            ]);
            terminalNoData++;
          } else {
            updates.push([
              `UPDATE latency_price_snapshots SET backfill_attempts = ?
                WHERE trade_hash = ? AND provider = ? AND event = ?`,
              [attempts, row.trade_hash, row.provider, row.event],
            ]);
          }
        }
        continue;
      }

      // result.kind === 'ok' - the peer definitively answered.
      //
      // A SINGLE empty response is NOT proof that no trading happened. ST's intraday route only
      // distinguishes "provider failed" (non-200) from "genuinely no bars" (200 + []) once
      // Socratic.Trade PR #2959 is live; before that every failure mode - missing credential,
      // timeout, upstream 500 - collapses into 200 {bars: []}. Terminating on the first empty
      // answer would let one ST-side hiccup convert this entire reopened backlog into
      // "confirmed no trading happened" at CAPTURE_BATCH rows/minute, and the due query
      // (captured_at IS NULL) can never re-select them. That is the silent-blanking bug this
      // pipeline exists to remove, re-entering through deploy ordering rather than through code.
      //
      // So empty answers must CORROBORATE: count them like a provider failure and only conclude
      // no-bars once the same range has come back empty MAX_BACKFILL_ATTEMPTS times. A real
      // weekend or halt still terminates, just over a few ticks instead of one. This also removes
      // the human dependency on merging #2959 before this ships.
      if (result.bars.length === 0) {
        for (const row of rows) {
          const attempts = row.backfill_attempts + 1;
          if (attempts >= MAX_BACKFILL_ATTEMPTS) {
            updates.push([
              `UPDATE latency_price_snapshots
                  SET error = 'confirmed_no_bars', captured_at = ?, capture_mode = 'backfill',
                      market_session = ?, backfill_attempts = ?
                WHERE trade_hash = ? AND provider = ? AND event = ?`,
              [nowIso, marketSessionAt(row.due_at), attempts, row.trade_hash, row.provider, row.event],
            ]);
            terminalNoData++;
          } else {
            updates.push([
              `UPDATE latency_price_snapshots SET backfill_attempts = ?
                WHERE trade_hash = ? AND provider = ? AND event = ?`,
              [attempts, row.trade_hash, row.provider, row.event],
            ]);
          }
        }
        continue;
      }

      for (const row of rows) {
        const bar = nearestBarAtOrAfter(result.bars, row.due_at, BACKFILL_TOLERANCE_MIN);
        if (bar) {
          writeCaptured(updates, row, { price: bar.c, source: 'peer-intraday', error: null, captureMode: 'backfill' }, nowIso);
          backfillCaptured++;
        } else {
          updates.push([
            `UPDATE latency_price_snapshots
                SET error = 'no_bar_in_tolerance', captured_at = ?, capture_mode = 'backfill', market_session = ?
              WHERE trade_hash = ? AND provider = ? AND event = ?`,
            [nowIso, marketSessionAt(row.due_at), row.trade_hash, row.provider, row.event],
          ]);
          terminalNoData++;
        }
      }
    }
  }

  if (updates.length) {
    try {
      await batch(env.DB, updates);
    } catch {
      errors++;
    }
  }

  const deferred = due.length - liveCaptured - backfillCaptured - terminalNoData;
  return { liveCaptured, backfillCaptured, terminalNoData, deferred: Math.max(deferred, 0), errors };
}

export interface PriceEdgeBucket {
  event: LatencyPriceEvent;
  n: number;
  medianBps: number | null;
}

/**
 * Median basis-point move from provider_publish to each follow-up print,
 * restricted to pairs captured in the SAME market session (both 'regular') so
 * a print that straddles the 16:00 close is excluded rather than silently
 * diluting the comparison — see shared/marketSession.ts.
 */
export async function summarizeProviderPublishBump(env: Env): Promise<PriceEdgeBucket[]> {
  const rows = await all<{
    event: LatencyPriceEvent;
    bps: number;
  }>(
    env.DB,
    `SELECT later.event AS event,
            10000.0 * (later.price - pub.price) / pub.price AS bps
       FROM latency_price_snapshots pub
       JOIN latency_price_snapshots later
         ON later.trade_hash = pub.trade_hash
        AND later.provider = pub.provider
      WHERE pub.event = 'provider_publish'
        AND later.event IN ('provider_minus_30m', 'provider_minus_15m', 'provider_plus_5m', 'provider_plus_15m', 'provider_plus_30m', 'provider_plus_60m')
        AND pub.price IS NOT NULL AND pub.price > 0
        AND later.price IS NOT NULL
        AND pub.market_session = 'regular'
        AND later.market_session = 'regular'`,
  ).catch(() => []);

  const byEvent = new Map<LatencyPriceEvent, number[]>();
  for (const row of rows) {
    const list = byEvent.get(row.event) ?? [];
    list.push(row.bps);
    byEvent.set(row.event, list);
  }
  const out: PriceEdgeBucket[] = [];
  for (const event of FOLLOW_EVENTS) {
    const list = (byEvent.get(event) ?? []).slice().sort((a, b) => a - b);
    const mid = list.length ? list[Math.floor((list.length - 1) / 2)]! : null;
    out.push({ event, n: list.length, medianBps: mid });
  }
  return out;
}

export async function runLatencyPriceSnapshotTick(
  env: Env,
  now = new Date(),
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<{ scheduled: number } & CaptureResult> {
  const scheduled = await scheduleMissingLatencyPriceSnapshots(env, now);
  const captured = await captureDueLatencyPriceSnapshots(env, now, fetchImpl, signal);
  return { scheduled: scheduled.scheduled, ...captured };
}
