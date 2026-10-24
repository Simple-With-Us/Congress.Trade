/**
 * src/prices/notCovered.ts
 * OWNER: prices
 *
 * Socratic.Trade coverage gaps (CT-2443): tickers ST cannot price are marked
 * stage 4 (`PRICE_UNAVAILABLE_NOT_COVERED`) so they stop holding the
 * `st_peer_prices` stall alert, stay visible as a count, and get retried daily.
 * No new table/column — stage 4 reuses the existing `price_unavailable` state
 * machine in ./service.ts.
 */

import type { Env } from '../shared/types.ts';
import { all, run } from '../shared/db.ts';
import { excludeCompetitorFixtureTransactionSql } from '../shared/competitorFixtures.ts';
import { getSharedFmpPacer } from '../shared/pace.ts';
import type { PriceClient } from './fmp.ts';
import {
  isFatalPriceProviderError,
  isStaleListingDate,
  lastTradingDay,
  markTickerPriceUnavailable,
  notCoveredReason,
  NOT_COVERED_CAUSE_LAST_ERRORED,
  NOT_COVERED_CAUSE_STUCK_PENDING,
  ST_FETCH_ERROR_REASON_PREFIX,
  planTickerEodFetch,
  PRICE_UNAVAILABLE_NOT_COVERED,
  writeTickerEodHistory,
} from './service.ts';
import {
  readCorpusLatestPriceDate,
  stPeerPricePendingBindParams,
  stPeerPricePendingBindsForSubqueries,
  stPeerPricePendingFromSql,
} from './peerPricePending.ts';
import { isCurrentPriceFresh } from './staleness.ts';

/** A pending ticker with no price_checked_at progress for this long is ST-unpriceable (rule b). */
export const ST_NOT_COVERED_STUCK_HOURS = 72;
/** Sweep safety cap: more qualifiers than this is an outage, not a coverage gap — mark none. */
export const ST_NOT_COVERED_MAX_BATCH = 50;
/** Re-check probe window (days) for stage-4 tickers. */
export const NOT_COVERED_RECHECK_LOOKBACK_DAYS = 30;
/** Stage-4 tickers retried per daily re-check, oldest price_checked_at first. */
export const NOT_COVERED_RECHECK_MAX_TICKERS = 200;

/**
 * SQL fragment: `FROM securities_ref sr WHERE …` (no binds) over tickers marked
 * not covered by ST that still have a non-competitor-fixture, non-deprecated
 * trade (the same transaction filters as the pending SQL).  Driven from the
 * small securities_ref table with an EXISTS probe so the per-minute
 * /api/health read does not scan transactions.  Select `sr.ticker`.
 */
export function stNotCoveredTickersFromSql(): string {
  return `
  FROM securities_ref sr
 WHERE sr.price_unavailable = ${PRICE_UNAVAILABLE_NOT_COVERED}
   AND EXISTS (
     SELECT 1 FROM transactions t
      WHERE t.ticker = sr.ticker
        AND t.tx_date IS NOT NULL AND t.tx_date >= '1990-01-01'
        AND t.deprecated_at IS NULL
        AND ${excludeCompetitorFixtureTransactionSql('t')}
   )`;
}

export interface NotCoveredSweepResult {
  marked: number;
  qualified: number;
}

/**
 * Rule (b): mark every ticker that is in the pending set AND whose
 * price_checked_at is older than ST_NOT_COVERED_STUCK_HOURS. Safety gates (all
 * required, or nothing is marked): the EOD corpus is current through the last
 * trading day (ST is delivering for everyone else), and at most
 * ST_NOT_COVERED_MAX_BATCH tickers qualify (more than that is an outage —
 * warn and let the alarm keep paging). Tickers with no non-competitor-fixture
 * trade are skipped by markTickerPriceUnavailable.
 */
export async function markStuckPeerPriceTickersNotCovered(
  env: Env,
  now = new Date(),
): Promise<NotCoveredSweepResult> {
  const corpusLatest = await readCorpusLatestPriceDate(env);
  if (!isCurrentPriceFresh(corpusLatest, lastTradingDay(now))) {
    return { marked: 0, qualified: 0 };
  }
  const params = stPeerPricePendingBindParams(now);
  const stuckCutoff = new Date(now.getTime() - ST_NOT_COVERED_STUCK_HOURS * 3_600_000).toISOString();
  const rows = await all<{ ticker: string; last_reason: string | null }>(
    env.DB,
    `SELECT DISTINCT t.ticker AS ticker, sr.price_unavailable_reason AS last_reason ${stPeerPricePendingFromSql()}
       AND sr.price_checked_at IS NOT NULL
       AND sr.price_checked_at < ?
     ORDER BY t.ticker ASC
     LIMIT ${ST_NOT_COVERED_MAX_BATCH + 1}`,
    [...stPeerPricePendingBindsForSubqueries(params, 1), stuckCutoff],
  );
  if (rows.length > ST_NOT_COVERED_MAX_BATCH) {
    console.warn(
      `not-covered sweep skipped: ${rows.length}+ tickers stuck while pending (cap ${ST_NOT_COVERED_MAX_BATCH}) — looks like an outage, not a coverage gap`,
    );
    return { marked: 0, qualified: rows.length };
  }
  const nowIso = now.toISOString();
  for (const { ticker, last_reason } of rows) {
    // Say WHY, and only what is known:  72h without a completed check is the
    // proven fact;  an error marker adds that the LAST attempt failed (with the
    // message).  One marker is not an error streak, so the cause never says so.  Either way the
    // daily re-check retries it, so a recovered ST reprices it within a day.
    const lastError = last_reason?.startsWith(ST_FETCH_ERROR_REASON_PREFIX)
      ? last_reason.slice(ST_FETCH_ERROR_REASON_PREFIX.length)
      : null;
    const reason = notCoveredReason(
      now,
      lastError
        ? `${NOT_COVERED_CAUSE_STUCK_PENDING}; ${NOT_COVERED_CAUSE_LAST_ERRORED} (${lastError})`
        : NOT_COVERED_CAUSE_STUCK_PENDING,
    );
    await markTickerPriceUnavailable(env, ticker, reason, {
      checkedAt: nowIso,
      stage: PRICE_UNAVAILABLE_NOT_COVERED,
    });
  }
  return { marked: rows.length, qualified: rows.length };
}

/** Advance price_checked_at only; stage 4 and the since-dated reason stay. */
async function restampNotCovered(env: Env, ticker: string, nowIso: string): Promise<void> {
  await run(
    env.DB,
    `UPDATE securities_ref SET price_checked_at = ?
      WHERE ticker = ? AND price_unavailable = ${PRICE_UNAVAILABLE_NOT_COVERED}`,
    [nowIso, ticker],
  );
}

/** Make the normal refresh re-select a ticker whose cached history is incomplete. */
async function clearLatestPriceDate(env: Env, ticker: string): Promise<void> {
  await run(env.DB, 'UPDATE securities_ref SET latest_price_date = NULL WHERE ticker = ?', [ticker]);
}

export interface NotCoveredRecheckResult {
  checked: number;
  repriced: number;
  restamped: number;
  /** Repriced tickers whose full history from the oldest trade was then fetched. */
  backfilled: number;
  aborted: boolean;
  errors: string[];
}

/**
 * Daily re-check: retry up to `max` stage-4 tickers (oldest price_checked_at
 * first) through the given price client. A non-empty result whose newest close
 * is on/after the ticker's previous latest_price_date (any close when null)
 * and not stale per PRICE_STALE_LISTING_DAYS is written through the SAME
 * upsert path runPriceRefresh uses (stage cleared to 0, reason cleared).
 * Anything else restamps price_checked_at only, keeping stage 4 and the
 * original since-date. Fatal provider errors abort without touching tickers.
 * Once-per-UTC-day gating lives with the caller (jobs.ts lane stamp).
 */
export async function recheckNotCoveredPeerPrices(
  env: Env,
  client: PriceClient,
  opts: {
    now?: Date;
    max?: number;
    pace?: () => Promise<void>;
    signal?: AbortSignal;
  } = {},
): Promise<NotCoveredRecheckResult> {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const max = opts.max ?? NOT_COVERED_RECHECK_MAX_TICKERS;
  const pace = opts.pace ?? getSharedFmpPacer();
  const result: NotCoveredRecheckResult = {
    checked: 0,
    repriced: 0,
    restamped: 0,
    backfilled: 0,
    aborted: false,
    errors: [],
  };
  if (max <= 0) return result;
  const rows = await all<{ ticker: string; latest_price_date: string | null }>(
    env.DB,
    `SELECT sr.ticker AS ticker, sr.latest_price_date AS latest_price_date
       FROM securities_ref sr
      WHERE sr.price_unavailable = ${PRICE_UNAVAILABLE_NOT_COVERED}
      ORDER BY sr.price_checked_at ASC
      LIMIT ?`,
    [max],
  );
  for (const { ticker, latest_price_date: prevLatest } of rows) {
    if (opts.signal?.aborted) {
      result.aborted = true;
      break;
    }
    // Bounded probe:  stage-4 tickers are known-unpriceable, so a recent window
    // is enough to see that ST started pricing one.  A cold cache would
    // otherwise re-request years of daily bars every day.  When a ticker
    // recovers through a clamped window, its full history is fetched right
    // after (below), so trades older than the window get priced too.
    const fetchPlan = await planTickerEodFetch(env, ticker, {
      maxLookbackDays: NOT_COVERED_RECHECK_LOOKBACK_DAYS,
    });
    if (!fetchPlan) {
      // No dated trade to price from:  rotate the oldest-first window like the
      // error path, or this row holds one of the daily slots forever.
      await restampNotCovered(env, ticker, nowIso);
      result.restamped++;
      continue;
    }
    let hist;
    try {
      await pace();
      hist = await client.eodHistory(ticker, fetchPlan.from, fetchPlan.to);
    } catch (e) {
      result.errors.push(ticker + ': ' + (e as Error).message);
      if (isFatalPriceProviderError(e, false)) {
        result.aborted = true;
        break;
      }
      // Non-fatal per-ticker error: restamp so the oldest-first window rotates
      // instead of retrying the same erroring tickers every day.
      await restampNotCovered(env, ticker, nowIso);
      result.restamped++;
      continue;
    }
    result.checked++;
    const newest = hist[0];
    const accepted =
      newest != null &&
      !isStaleListingDate(newest.date, now) &&
      (prevLatest == null || newest.date >= prevLatest);
    if (accepted) {
      await writeTickerEodHistory(env, ticker, hist, nowIso, { stage: 0, reason: null });
      result.repriced++;
      if (fetchPlan.fullFrom < fetchPlan.from) {
        // The probe stopped short of what the trades need, yet the write above
        // stamped latest_price_date current, so the normal refresh would never
        // re-select this ticker and trades before the probe window would keep
        // a NULL price_at_trade.  Fetch the full window now.  This costs one
        // extra ST call only on the rare day a stage-4 ticker recovers.
        try {
          await pace();
          const older = await client.eodHistory(ticker, fetchPlan.fullFrom, fetchPlan.to);
          if (older.length > 0) {
            await writeTickerEodHistory(env, ticker, older, nowIso, { stage: 0, reason: null });
          }
          result.backfilled++;
        } catch (e) {
          result.errors.push(ticker + ' (backfill): ' + (e as Error).message);
          // Stop marking it current so selectTickersNeedingPrices re-selects
          // it and the normal refresh fetches the full window instead.
          await clearLatestPriceDate(env, ticker);
          if (isFatalPriceProviderError(e, false)) {
            result.aborted = true;
            break;
          }
        }
      }
    } else {
      await restampNotCovered(env, ticker, nowIso);
      result.restamped++;
    }
  }
  return result;
}
