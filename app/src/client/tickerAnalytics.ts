/**
 * src/client/tickerAnalytics.ts
 *
 * The company-drawer analytics block for `GET /api/client/v1/ticker/:ticker`,
 * served ONLY when the caller opts in with `?include=analytics`.
 *
 * WHY THIS LIVES UNDER /api/client/v1 AND NOT AS AN iOS CALL TO /api/analytics
 * ---------------------------------------------------------------------------
 * The website's company drawer is built from two INTERNAL web routes
 * (`GET /api/analytics/ticker/:t` + `.../backtest`). Pointing iOS at those
 * would bind a shipped, App-Store-frozen binary to an envelope the analytics
 * layer reshapes freely (it stamps a web-shaped `meta()` and returns
 * `recentTrades[].rawText`, i.e. raw filing text, which the phone never
 * renders), and it would fork the client contract the repo rule says the
 * backend owns. It would also cost the drawer two extra round trips on
 * cellular and make iOS decode a SECOND copy of the recent-trade list it
 * already has in `items`.
 *
 * So the numbers come from the SAME analytics BUILDERS the website uses
 * (`buildTickerSummaryQuery` / `TimeSeries` / `TopTraders` / `BacktestCohort`
 * + `aggregateTickerBacktest`), guaranteeing the phone and the web drawer
 * cannot drift, but they are projected into a stable, phone-shaped DTO on the
 * one client-facing contract.
 *
 * WHY IT IS OPT-IN
 * ----------------
 * The backtest leg reads this ticker's full `price_eod` history AND the whole
 * `spx_eod` table. That is fine behind a KV cache for a drawer the user
 * deliberately opened; it is not fine as unconditional work on every
 * `/ticker/:ticker` read (the same endpoint iOS uses for a plain trade list).
 * `?include=analytics` keeps existing callers on exactly the cost and shape
 * they have today, and the whole block is cached in CONFIG_KV for 10 minutes
 * — same TTL as the analytics routes it mirrors.
 */

import type { Env } from '../shared/types.ts';
import { all, first } from '../shared/db.ts';
import { cached, cacheKey } from '../shared/kvCache.ts';
import {
  asWindow,
  asPartyBucket,
  autoGranularity,
  isGranularity,
  type CommonFilters,
  type Granularity,
  type Window,
} from '../analytics/sql.ts';
import {
  buildTickerBacktestCohortQuery,
  buildBacktestPriceQuery,
  buildBacktestSpxQuery,
  buildPricedDaysCountQuery,
  buildTickerSummaryQuery,
  buildTickerTimeSeriesQuery,
  buildTickerTopTradersQuery,
} from '../analytics/builders.ts';
import {
  aggregateTickerBacktest,
  netSentiment,
  BACKTEST_MIN_N,
  type BacktestHorizon,
  type PriceBar,
} from '../analytics/compute.ts';
import { cleanFilerName } from '../extraction/nameNormalizer.ts';
import { num, str, usd } from './utils.ts';

/** Default forward horizons, in trading days — same set the web drawer shows. */
const DEFAULT_HORIZONS = [21, 63, 126, 252];

/** Cache TTL (seconds). Matches `/api/analytics/ticker/:t`'s own 600s. */
const TICKER_ANALYTICS_TTL_SEC = 600;

export interface ClientTickerTrader {
  filerId: string | null;
  fullName: string | null;
  partyBucket: 'D' | 'R' | 'O' | null;
  photoUrl: string | null;
  tradeCount: number;
  estVolumeUsd: number;
}

export interface ClientTickerSeriesPoint {
  period: string | null;
  buys: number;
  sells: number;
  estBuyVolUsd: number;
  estSellVolUsd: number;
}

export interface ClientTickerWindowSummary {
  totalTrades: number;
  buyCount: number;
  sellCount: number;
  memberCount: number;
  estVolumeUsd: number;
  estNetFlowUsd: number;
  /**
   * Buy pressure: buys / (buys + sells) as a 0..1 fraction, `null` when the
   * window holds no directional trade. Computed server-side (same
   * `netSentiment` the web KPI strip renders) so no client re-derives it.
   */
  netSentiment: number | null;
  firstTrade: string | null;
  lastTrade: string | null;
}

export interface ClientTickerBacktest {
  /** Buy events in the cohort (before forward-history availability). */
  totalBuyEvents: number;
  /** Priced days available for this ticker — coverage honesty. */
  pricedDays: number;
  /** Horizons with fewer than this many scored events report null stats. */
  minN: number;
  horizons: BacktestHorizon[];
}

export interface ClientTickerAnalytics {
  window: Window;
  granularity: Granularity;
  asOf: string;
  /** Every dollar figure is a STOCK Act bracket-midpoint ESTIMATE. */
  estimatedAmounts: true;
  /**
   * Windowed aggregates. Distinct from the envelope's top-level `summary`,
   * which stays ALL-TIME so existing decoders keep their current meaning.
   */
  summary: ClientTickerWindowSummary;
  series: ClientTickerSeriesPoint[];
  topBuyers: ClientTickerTrader[];
  topSellers: ClientTickerTrader[];
  backtest: ClientTickerBacktest;
}

export interface TickerAnalyticsOptions {
  window?: string;
  granularity?: string;
}

/** `include=` is a CSV token list; unknown tokens are ignored, not an error. */
export function wantsAnalytics(include: string | undefined): boolean {
  if (!include) return false;
  return include
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .includes('analytics');
}

function filerName(v: unknown): string | null {
  const name = str(v);
  return name ? cleanFilerName(name) || name : null;
}

function mapTrader(row: Record<string, unknown>): ClientTickerTrader {
  return {
    filerId: str(row.filer_id),
    fullName: filerName(row.full_name),
    partyBucket: asPartyBucket(row.party) ?? null,
    photoUrl: str(row.photo_url),
    tradeCount: num(row.trade_count),
    estVolumeUsd: usd(row.est_volume),
  };
}

/**
 * Compute (or serve from KV) the drawer analytics for one ticker.
 *
 * Deliberately narrow filter surface: `window` (+ optional `granularity`)
 * only, exactly what the website's drawer passes. Chamber/party/source are NOT
 * accepted here — the web drawer does not scope by them either, and every
 * extra dimension multiplies the cache keyspace for a screen that is opened
 * one ticker at a time.
 */
export async function tickerAnalytics(
  env: Env,
  ticker: string,
  opts: TickerAnalyticsOptions = {},
): Promise<ClientTickerAnalytics> {
  const window = asWindow(opts.window, 'all');
  const granularity: Granularity = isGranularity(opts.granularity)
    ? opts.granularity
    : autoGranularity(window);
  const f: CommonFilters = { window };

  return cached(
    env,
    cacheKey(`client-ticker:${ticker}`, { window, granularity }),
    TICKER_ANALYTICS_TTL_SEC,
    async () => {
      const sumQ = buildTickerSummaryQuery(ticker, f);
      const seriesQ = buildTickerTimeSeriesQuery(ticker, { ...f, granularity });
      const buyersQ = buildTickerTopTradersQuery(ticker, 'B', f);
      const sellersQ = buildTickerTopTradersQuery(ticker, 'S', f);
      // Cohort follows the SAME window as the rest of the block — the website's
      // drawer passes its `window` straight through to `.../backtest` too, so
      // matching it is what keeps the two surfaces reporting one number.
      const cohortQ = buildTickerBacktestCohortQuery(ticker, f);

      const [sumRow, seriesRows, buyerRows, sellerRows, cohortRows] =
        await Promise.all([
          first<Record<string, unknown>>(env.DB, sumQ.sql, sumQ.params),
          all<Record<string, unknown>>(env.DB, seriesQ.sql, seriesQ.params),
          all<Record<string, unknown>>(env.DB, buyersQ.sql, buyersQ.params),
          all<Record<string, unknown>>(env.DB, sellersQ.sql, sellersQ.params),
          all<{ tx_date: string }>(env.DB, cohortQ.sql, cohortQ.params),
        ]);

      const s = sumRow ?? {};
      const buyCount = num(s.buy_count);
      const sellCount = num(s.sell_count);
      const cohortDates = cohortRows
        .map((row) => str(row.tx_date))
        .filter((d): d is string => !!d);
      // CT-2459: bound both price series to the cohort window (was: full
      // ticker history + full spx_eod per cache miss). pricedDays keeps its
      // full-coverage meaning via a COUNT query.
      const countQ = buildPricedDaysCountQuery(ticker);
      const pricedDaysRow = await first<{ n: number }>(env.DB, countQ.sql, countQ.params);
      let priceAsc: PriceBar[] = [];
      let spxAsc: PriceBar[] = [];
      if (cohortDates.length > 0) {
        const cohortMin = cohortDates.reduce((a, b) => (b < a ? b : a));
        const priceQ = buildBacktestPriceQuery(ticker, cohortMin);
        const spxQ = buildBacktestSpxQuery(cohortMin);
        [priceAsc, spxAsc] = await Promise.all([
          all<PriceBar>(env.DB, priceQ.sql, priceQ.params),
          all<PriceBar>(env.DB, spxQ.sql, spxQ.params),
        ]);
      }
      const bt = aggregateTickerBacktest(cohortDates, priceAsc, spxAsc, DEFAULT_HORIZONS);

      return {
        window,
        granularity,
        asOf: new Date().toISOString(),
        estimatedAmounts: true as const,
        summary: {
          totalTrades: num(s.total_trades),
          buyCount,
          sellCount,
          memberCount: num(s.member_count),
          estVolumeUsd: usd(s.est_volume),
          estNetFlowUsd: usd(s.est_net_flow),
          netSentiment: netSentiment(buyCount, sellCount),
          firstTrade: str(s.first_trade),
          lastTrade: str(s.last_trade),
        },
        series: seriesRows.map((row) => ({
          period: str(row.period),
          buys: num(row.buys),
          sells: num(row.sells),
          estBuyVolUsd: usd(row.est_buy_vol),
          estSellVolUsd: usd(row.est_sell_vol),
        })),
        topBuyers: buyerRows.map(mapTrader),
        topSellers: sellerRows.map(mapTrader),
        backtest: {
          totalBuyEvents: bt.tradeCount,
          pricedDays: num(pricedDaysRow?.n),
          minN: BACKTEST_MIN_N,
          horizons: bt.horizons,
        },
      };
    },
  );
}
