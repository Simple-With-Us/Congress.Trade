/**
 * Same-day price retry after a stamped market-data lane (CT-2409).
 * Kept out of peerPricePending.ts so the pending-SQL owners (#2724, #2738,
 * open #2748) stay the only editors of that file.
 */

import type { Env } from '../shared/types.ts';
import { get } from '../shared/db.ts';
import { lastTradingDay } from './service.ts';
import { isCurrentPriceFresh } from './staleness.ts';
import {
  ST_PEER_PRICE_TAIL_STALL_MAX_PENDING,
  stPeerPricePendingBindParams,
  stPeerPricePendingBindsOnce,
  stPeerPricePendingFromSql,
} from './peerPricePending.ts';

/**
 * True when the hourly market-data tick should pull prices even if today's
 * lane stamp is already set.  A caught refresh throw used to stamp the UTC
 * day anyway, which parked the corpus until the next 00:07Z.
 * A current corpus with only a tiny never-priced tail is not a catch-up.
 */
export async function peerPricesNeedCatchUp(env: Env, now = new Date()): Promise<boolean> {
  try {
    // Do not use readCorpusLatestPriceDate here.  That helper turns a query
    // error into null, which would look like an empty corpus and retry every hour.
    const row = await get<{ d: string | null }>(
      env.DB,
      'SELECT MAX(latest_price_date) AS d FROM securities_ref',
    );
    const corpus = row?.d && row.d.length >= 10 ? row.d.slice(0, 10) : null;
    const freshThrough = lastTradingDay(now);
    if (!isCurrentPriceFresh(corpus, freshThrough)) return true;
    const params = stPeerPricePendingBindParams(now);
    const pending = await get<{ n: number }>(
      env.DB,
      `SELECT COUNT(DISTINCT t.ticker) AS n ${stPeerPricePendingFromSql()}`,
      stPeerPricePendingBindsOnce(params),
    );
    return Number(pending?.n ?? 0) > ST_PEER_PRICE_TAIL_STALL_MAX_PENDING;
  } catch {
    return false;
  }
}
