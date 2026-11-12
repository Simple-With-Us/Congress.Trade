/**
 * src/prices/terminalListing.ts
 * OWNER: prices
 *
 * Sweep for tickers confirmed no longer trading (CT-2466). The evidence is
 * already on securities_ref: a last trade far before the last completed
 * session, optionally combined with the repeat not-found stage. No new data
 * vendor. Marked rows leave the pending set and the stall clock, and stay
 * visible on the st_peer_prices health check.
 */

import type { Env } from '../shared/types.ts';
import { all, get } from '../shared/db.ts';
import { excludeCompetitorFixtureTransactionSql } from '../shared/competitorFixtures.ts';
import { isCurrentPriceFresh } from './staleness.ts';
import {
  formatTerminalReason,
  isConfirmedNoLongerTradingDate,
  lastTradingDay,
  markTickerPriceUnavailable,
  PRICE_UNAVAILABLE_TERMINAL,
  terminalLastTradeCutoff,
  terminalReasonForListing,
} from './service.ts';

/** Oldest last-trade dates marked per pass. The next pass continues the rest. */
export const TERMINAL_SWEEP_MAX_BATCH = 200;

export interface TerminalSweepResult {
  marked: number;
  qualified: number;
}

export interface TerminalTickerSample {
  ticker: string;
  reason: string;
  since: string | null;
  lastTrade: string | null;
}

/**
 * SQL fragment: `FROM securities_ref sr WHERE …` (no binds) over terminal
 * tickers that still have a non-competitor-fixture, non-deprecated trade.
 * Select `sr.ticker` and `sr.price_unavailable_reason`.
 */
export function stTerminalTickersFromSql(): string {
  return `
  FROM securities_ref sr
 WHERE sr.price_unavailable = ${PRICE_UNAVAILABLE_TERMINAL}
   AND EXISTS (
     SELECT 1 FROM transactions t
      WHERE t.ticker = sr.ticker
        AND t.tx_date IS NOT NULL AND t.tx_date >= '1990-01-01'
        AND t.deprecated_at IS NULL
        AND ${excludeCompetitorFixtureTransactionSql('t')}
   )`;
}

/**
 * Mark tickers whose latest_price_date is older than the terminal cutoff.
 * Requires a fresh EOD corpus so a provider outage, which ages every ticker
 * together, does not terminalize the universe. Does not call Socratic.Trade.
 * Already-terminal rows are left alone, including their since-date.
 */
export async function markTerminalPeerPriceTickers(
  env: Env,
  now = new Date(),
): Promise<TerminalSweepResult> {
  if (!env.DB) return { marked: 0, qualified: 0 };
  const cutoff = terminalLastTradeCutoff(now);
  const where = `
  FROM securities_ref sr
 WHERE sr.latest_price_date IS NOT NULL
   AND sr.latest_price_date < ?
   AND COALESCE(sr.price_unavailable, 0) <> ${PRICE_UNAVAILABLE_TERMINAL}
   AND EXISTS (
     SELECT 1 FROM transactions t
      WHERE t.ticker = sr.ticker
        AND t.tx_date IS NOT NULL AND t.tx_date >= '1990-01-01'
        AND t.deprecated_at IS NULL
        AND ${excludeCompetitorFixtureTransactionSql('t')}
   )`;
  let qualified = 0;
  let rows: Array<{ ticker: string; latest_price_date: string; price_unavailable: number | null }> = [];
  try {
    // One read for the corpus gate and the candidate count. The comment keeps
    // this statement distinct from the catch-up's own corpus probe.
    const counted = await get<{ d: string | null; n: number }>(
      env.DB,
      `/* terminal-peer-price */ SELECT
         (SELECT MAX(latest_price_date) FROM securities_ref) AS d,
         (SELECT COUNT(*) ${where}) AS n`,
      [cutoff],
    );
    const corpusLatest = counted?.d && counted.d.length >= 10 ? counted.d.slice(0, 10) : null;
    if (!isCurrentPriceFresh(corpusLatest, lastTradingDay(now))) {
      return { marked: 0, qualified: 0 };
    }
    qualified = Number(counted?.n ?? 0);
    if (qualified <= 0) return { marked: 0, qualified: 0 };
    rows = await all<{ ticker: string; latest_price_date: string; price_unavailable: number | null }>(
      env.DB,
      `/* terminal-peer-price */ SELECT sr.ticker AS ticker,
              sr.latest_price_date AS latest_price_date,
              sr.price_unavailable AS price_unavailable
         ${where}
        ORDER BY sr.latest_price_date ASC, sr.ticker ASC
        LIMIT ${TERMINAL_SWEEP_MAX_BATCH}`,
      [cutoff],
    );
  } catch (err) {
    console.warn('terminal peer-price sweep failed:', (err as Error).message);
    return { marked: 0, qualified: 0 };
  }
  const nowIso = now.toISOString();
  let marked = 0;
  for (const row of rows) {
    if (!isConfirmedNoLongerTradingDate(row.latest_price_date, now)) continue;
    const stage = Number(row.price_unavailable ?? 0);
    const reason = terminalReasonForListing(stage);
    await markTickerPriceUnavailable(env, row.ticker, formatTerminalReason(now, reason, row.latest_price_date), {
      checkedAt: nowIso,
      stage: PRICE_UNAVAILABLE_TERMINAL,
    });
    marked++;
  }
  if (qualified > rows.length) {
    console.log(
      `terminal peer-price sweep marked ${marked} of ${qualified} (cap ${TERMINAL_SWEEP_MAX_BATCH}); the rest wait for the next pass`,
    );
  }
  return { marked, qualified };
}
