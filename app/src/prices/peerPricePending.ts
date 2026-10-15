/**
 * Shared predicate for "this ticker still needs a peer EOD price" — used by the
 * st_peer_prices stall detector and kept aligned with selectTickersNeedingPrices.
 */

import type { Env } from '../shared/types.ts';
import { get } from '../shared/db.ts';
import { excludeCompetitorFixtureTransactionSql } from '../shared/competitorFixtures.ts';
import {
  lastTradingDay,
  PRICE_UNAVAILABLE_NOT_FOUND_FIRST,
  priceUnavailableCutoffIso,
  priceUnavailableFirstRecheckCutoffIso,
} from './service.ts';
import { isCurrentPriceFresh } from './staleness.ts';

/** Do not page on a tiny tail when the indexed corpus bar is already current. */
export const ST_PEER_PRICE_TAIL_STALL_MAX_PENDING = 5;

export interface StPeerPricePendingParams {
  freshThrough: string;
  firstUnavailableCutoff: string;
  unavailableCutoff: string;
}

export function stPeerPricePendingBindParams(now = new Date()): StPeerPricePendingParams {
  return {
    freshThrough: lastTradingDay(now),
    firstUnavailableCutoff: priceUnavailableFirstRecheckCutoffIso(now),
    unavailableCutoff: priceUnavailableCutoffIso(now),
  };
}

/**
 * SQL fragment: `FROM transactions t … WHERE …` with four bind slots in order:
 * freshThrough, firstUnavailableCutoff, unavailableCutoff (twice in CASE).
 */
export function stPeerPricePendingFromSql(): string {
  const stageFirst = PRICE_UNAVAILABLE_NOT_FOUND_FIRST;
  return `
  FROM transactions t
  LEFT JOIN securities_ref sr ON sr.ticker = t.ticker
 WHERE t.ticker IS NOT NULL AND TRIM(t.ticker) != ''
   AND t.tx_date IS NOT NULL AND t.tx_date >= '1990-01-01'
   AND t.deprecated_at IS NULL
   AND ${excludeCompetitorFixtureTransactionSql('t')}
   AND (
     sr.latest_price_date IS NULL
     OR sr.latest_price_date < ?
   )
   AND NOT (
     COALESCE(sr.price_unavailable, 0) <> 0
     AND sr.price_checked_at IS NOT NULL
     AND sr.price_checked_at >= CASE
           WHEN sr.price_unavailable = ${stageFirst} THEN ?
           ELSE ?
         END
   )`;
}

export async function readCorpusLatestPriceDate(env: Env): Promise<string | null> {
  try {
    const row = await get<{ d: string | null }>(
      env.DB,
      'SELECT MAX(latest_price_date) AS d FROM securities_ref',
    );
    const d = row?.d;
    return d && d.length >= 10 ? d.slice(0, 10) : null;
  } catch {
    return null;
  }
}

/**
 * When the bulk EOD corpus is already through the last completed session, a
 * handful of permanently-unpriceable tail tickers must not hold the stall alarm.
 */
export function isTailOnlyPeerPriceBacklog(
  pending: number,
  corpusLatest: string | null,
  now: Date,
): boolean {
  if (pending <= 0 || pending > ST_PEER_PRICE_TAIL_STALL_MAX_PENDING) return false;
  const freshThrough = lastTradingDay(now);
  return isCurrentPriceFresh(corpusLatest, freshThrough);
}
