/**
 * src/export/priceNeeds.ts
 * OWNER: export / prices
 *
 * Token-gated export that tells App B (Socratic.Trade) which congressional
 * tickers still lack enough price/SPX history for per-trade performance vs
 * the S&P 500. App B deep-shares EOD closes for these tickers into
 * POST /api/admin/securities/import; that path recomputes tx_performance.
 */

import type { Env } from '../shared/types.ts';
import { all, get } from '../shared/db.ts';
import {
  lastTradingDay,
  PRICE_UNAVAILABLE_NOT_FOUND_FIRST,
  priceUnavailableCutoffIso,
  priceUnavailableFirstRecheckCutoffIso,
} from '../prices/service.ts';

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;

export interface PriceNeedTicker {
  ticker: string;
  oldestTradeDate: string;
  latestPriceDate: string | null;
  earliestPriceDate: string | null;
  trades: number;
  missingPriceAnchors: number;
  missingSpxAnchors: number;
  needsDeepHistory: boolean;
  reasons: string[];
}

export interface PriceNeedsExport {
  generatedAt: string;
  spx: {
    oldestTradeDate: string | null;
    latestCached: string | null;
    earliestCached: string | null;
    needsHistoryBefore: string | null;
  };
  summary: {
    distinctTickers: number;
    tickersNeedingPrices: number;
    tradesMissingPriceAnchor: number;
    tradesMissingSpxAnchor: number;
  };
  tickers: PriceNeedTicker[];
  pagination: { nextCursor: string | null; limit: number };
}

export interface PriceNeedsQuery {
  limit: number;
  cursor: string | null;
}

export function parsePriceNeedsQuery(q: Record<string, string | undefined>): PriceNeedsQuery {
  const rawLimit = Number(q.limit ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(Math.floor(rawLimit), MAX_LIMIT)
    : DEFAULT_LIMIT;
  const cursor = typeof q.cursor === 'string' && q.cursor.trim()
    ? q.cursor.trim().toUpperCase()
    : null;
  return { limit, cursor };
}

/**
 * Tickers still negative-cached as unavailable are excluded while their TTL is
 * active (same two-stage policy as selectTickersNeedingPrices), so App B does
 * not thrash delisted/foreign names every night.
 */
function unavailableExclusionSql(): string {
  return `NOT (
    COALESCE(sr.price_unavailable, 0) <> 0
    AND sr.price_checked_at IS NOT NULL
    AND sr.price_checked_at >= CASE
          WHEN sr.price_unavailable = ${PRICE_UNAVAILABLE_NOT_FOUND_FIRST} THEN ?
          ELSE ?
        END
  )`;
}

/**
 * A ticker "needs" a share when any live dated trade cannot yet form a full
 * performance anchor, or price history does not reach the oldest trade date,
 * or current prices are stale for excess-return display.
 */
export async function buildPriceNeedsExport(
  env: Env,
  query: PriceNeedsQuery,
  now: Date = new Date(),
): Promise<PriceNeedsExport> {
  const freshThrough = lastTradingDay(now);
  const unavailableCutoff = priceUnavailableCutoffIso(now);
  const firstUnavailableCutoff = priceUnavailableFirstRecheckCutoffIso(now);
  const generatedAt = now.toISOString();

  const baseWhere = `
    t.deprecated_at IS NULL
    AND t.ticker IS NOT NULL AND t.ticker <> ''
    AND t.tx_date IS NOT NULL AND t.tx_date <> ''
    AND t.tx_date >= '1990-01-01'  /* ignore pre-market garbage (e.g. year 1202) in the EOD window math */
    AND ${unavailableExclusionSql()}
  `;

  // Per-ticker aggregates for the page of needs. Cursor is keyset on ticker.
  // needsDeepHistory when earliest cached close is null or after oldest trade.
  const params: Array<string | number> = [firstUnavailableCutoff, unavailableCutoff];
  let cursorClause = '';
  if (query.cursor) {
    cursorClause = 'AND t.ticker > ?';
    params.push(query.cursor);
  }
  params.push(freshThrough, query.limit + 1); // +1 to detect next page

  const rows = await all<{
    ticker: string;
    oldest_trade_date: string;
    latest_price_date: string | null;
    earliest_price_date: string | null;
    trades: number;
    missing_price_anchors: number;
    missing_spx_anchors: number;
  }>(
    env.DB,
    `SELECT t.ticker AS ticker,
            MIN(t.tx_date) AS oldest_trade_date,
            MAX(sr.latest_price_date) AS latest_price_date,
            (SELECT MIN(p.date) FROM price_eod p WHERE p.ticker = t.ticker) AS earliest_price_date,
            COUNT(*) AS trades,
            SUM(CASE WHEN tp.price_at_trade IS NULL OR tp.price_at_trade <= 0 THEN 1 ELSE 0 END) AS missing_price_anchors,
            SUM(CASE WHEN tp.spx_at_trade IS NULL OR tp.spx_at_trade <= 0 THEN 1 ELSE 0 END) AS missing_spx_anchors
       FROM transactions t
       LEFT JOIN securities_ref sr ON sr.ticker = t.ticker
       LEFT JOIN tx_performance tp ON tp.tx_id = t.id
      WHERE ${baseWhere}
        ${cursorClause}
      GROUP BY t.ticker
     HAVING missing_price_anchors > 0
         OR missing_spx_anchors > 0
         OR latest_price_date IS NULL
         OR latest_price_date < ?
         OR earliest_price_date IS NULL
         OR earliest_price_date > MIN(t.tx_date)
      ORDER BY t.ticker ASC
      LIMIT ?`,
    params,
  );

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const nextCursor = hasMore ? page[page.length - 1]?.ticker ?? null : null;

  const tickers: PriceNeedTicker[] = page.map((r) => {
    const reasons: string[] = [];
    const missingPrice = Number(r.missing_price_anchors) || 0;
    const missingSpx = Number(r.missing_spx_anchors) || 0;
    const earliest = r.earliest_price_date;
    const latest = r.latest_price_date;
    const oldest = r.oldest_trade_date;
    if (missingPrice > 0) reasons.push('missing_price_anchor');
    if (missingSpx > 0) reasons.push('missing_spx_anchor');
    if (!earliest) reasons.push('no_price_history');
    else if (earliest > oldest) reasons.push('history_after_oldest_trade');
    if (!latest) reasons.push('no_latest_price');
    else if (latest < freshThrough) reasons.push('stale_latest_price');
    const needsDeepHistory = !earliest || earliest > oldest;
    return {
      ticker: r.ticker,
      oldestTradeDate: oldest,
      latestPriceDate: latest,
      earliestPriceDate: earliest,
      trades: Number(r.trades) || 0,
      missingPriceAnchors: missingPrice,
      missingSpxAnchors: missingSpx,
      needsDeepHistory,
      reasons,
    };
  });

  // Global summary (independent of page cursor) — small aggregate queries.
  const summaryRow = await get<{
    distinct_tickers: number;
    needing: number;
    miss_price: number;
    miss_spx: number;
  }>(
    env.DB,
    `SELECT
       (SELECT COUNT(DISTINCT t.ticker)
          FROM transactions t
         WHERE t.deprecated_at IS NULL
           AND t.ticker IS NOT NULL AND t.ticker <> ''
           AND t.tx_date IS NOT NULL AND t.tx_date <> ''
           AND t.tx_date >= '1990-01-01') AS distinct_tickers,
       (SELECT COUNT(*) FROM (
          SELECT t.ticker
            FROM transactions t
            LEFT JOIN securities_ref sr ON sr.ticker = t.ticker
            LEFT JOIN tx_performance tp ON tp.tx_id = t.id
           WHERE ${baseWhere}
           GROUP BY t.ticker
          HAVING SUM(CASE WHEN tp.price_at_trade IS NULL OR tp.price_at_trade <= 0 THEN 1 ELSE 0 END) > 0
              OR SUM(CASE WHEN tp.spx_at_trade IS NULL OR tp.spx_at_trade <= 0 THEN 1 ELSE 0 END) > 0
              OR MAX(sr.latest_price_date) IS NULL
              OR MAX(sr.latest_price_date) < ?
              OR (SELECT MIN(p.date) FROM price_eod p WHERE p.ticker = t.ticker) IS NULL
              OR (SELECT MIN(p.date) FROM price_eod p WHERE p.ticker = t.ticker) > MIN(t.tx_date)
       )) AS needing,
       (SELECT COUNT(*)
          FROM transactions t
          LEFT JOIN tx_performance tp ON tp.tx_id = t.id
         WHERE t.deprecated_at IS NULL
           AND t.ticker IS NOT NULL AND t.ticker <> ''
           AND t.tx_date IS NOT NULL AND t.tx_date <> ''
           AND t.tx_date >= '1990-01-01'
           AND (tp.price_at_trade IS NULL OR tp.price_at_trade <= 0)) AS miss_price,
       (SELECT COUNT(*)
          FROM transactions t
          LEFT JOIN tx_performance tp ON tp.tx_id = t.id
         WHERE t.deprecated_at IS NULL
           AND t.ticker IS NOT NULL AND t.ticker <> ''
           AND t.tx_date IS NOT NULL AND t.tx_date <> ''
           AND t.tx_date >= '1990-01-01'
           AND (tp.spx_at_trade IS NULL OR tp.spx_at_trade <= 0)) AS miss_spx`,
    [firstUnavailableCutoff, unavailableCutoff, freshThrough],
  );

  const oldestTrade = await get<{ d: string | null }>(
    env.DB,
    `SELECT MIN(tx_date) AS d FROM transactions
      WHERE deprecated_at IS NULL AND ticker IS NOT NULL AND ticker <> ''
        AND tx_date >= '1990-01-01'`,
  );
  const spxCached = await get<{ mn: string | null; mx: string | null }>(
    env.DB,
    'SELECT MIN(date) AS mn, MAX(date) AS mx FROM spx_eod',
  );
  const oldestTradeDate = oldestTrade?.d ?? null;
  const earliestSpx = spxCached?.mn ?? null;
  const needsHistoryBefore =
    oldestTradeDate && (!earliestSpx || earliestSpx > oldestTradeDate) ? oldestTradeDate : null;

  return {
    generatedAt,
    spx: {
      oldestTradeDate,
      latestCached: spxCached?.mx ?? null,
      earliestCached: earliestSpx,
      needsHistoryBefore,
    },
    summary: {
      distinctTickers: Number(summaryRow?.distinct_tickers) || 0,
      tickersNeedingPrices: Number(summaryRow?.needing) || 0,
      tradesMissingPriceAnchor: Number(summaryRow?.miss_price) || 0,
      tradesMissingSpxAnchor: Number(summaryRow?.miss_spx) || 0,
    },
    tickers,
    pagination: { nextCursor, limit: query.limit },
  };
}
