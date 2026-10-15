/**
 * Shared definition of which traded tickers still need Socratic.Trade peer
 * price refresh.  Keeps the stall detector, `selectTickersNeedingPrices`, and
 * operator pending counts aligned.
 */

import { excludeCompetitorFixtureTransactionSql } from '../shared/competitorFixtures.ts';
import {
  PRICE_UNAVAILABLE_NOT_FOUND_FIRST,
  lastTradingDay,
  priceUnavailableCutoffIso,
  priceUnavailableFirstRecheckCutoffIso,
} from './service.ts';

export interface PeerPricePendingSql {
  /** SQL fragment starting at FROM transactions … (no leading SELECT). */
  fromSql: string;
  params: string[];
}

/**
 * Tickers that still need an EOD/current price refresh attempt.  Matches
 * `selectTickersNeedingPrices` selection semantics (staleness, missing
 * price_eod despite metadata, negative-cache TTL).
 */
export function buildPeerPricePendingSql(now = new Date()): PeerPricePendingSql {
  const freshThrough = lastTradingDay(now);
  const unavailableCutoff = priceUnavailableCutoffIso(now);
  const firstUnavailableCutoff = priceUnavailableFirstRecheckCutoffIso(now);
  const fromSql = `
  FROM transactions t
  LEFT JOIN securities_ref sr ON sr.ticker = t.ticker
 WHERE t.ticker IS NOT NULL AND t.ticker <> ''
   AND t.tx_date IS NOT NULL AND t.tx_date >= '1990-01-01'
   AND t.deprecated_at IS NULL
   AND ${excludeCompetitorFixtureTransactionSql('t')}
   AND (
     sr.latest_price_date IS NULL
     OR sr.latest_price_date < ?
     OR NOT EXISTS (SELECT 1 FROM price_eod pe WHERE pe.ticker = t.ticker)
   )
   AND NOT (
     COALESCE(sr.price_unavailable, 0) <> 0
     AND sr.price_checked_at IS NOT NULL
     AND sr.price_checked_at >= CASE
           WHEN sr.price_unavailable = ${PRICE_UNAVAILABLE_NOT_FOUND_FIRST} THEN ?
           ELSE ?
         END
   )`;
  return {
    fromSql,
    params: [freshThrough, firstUnavailableCutoff, unavailableCutoff],
  };
}
