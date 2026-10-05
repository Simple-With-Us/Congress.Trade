/**
 * src/analytics/compute.ts
 * OWNER: analytics
 *
 * Pure post-processing helpers for the analytics layer: the bracket-midpoint
 * math (the TypeScript mirror of BRACKET_MIDPOINT_SQL), buy/sell sentiment, and
 * the filing-lag distribution summary (SQLite has no percentile function, so we
 * compute median / p90 in the Worker from a returned histogram). All functions
 * are pure + deterministic so they unit-test without a database.
 */

import {
  bracketMidpoint as sharedBracketMidpoint,
  LAG_BUCKETS as SHARED_LAG_BUCKETS,
} from '@jaywedgeworth22/congress-trading-shared';
import { computePerformance } from '../prices/compute.ts';

/**
 * Estimated dollar value of one STOCK Act bracket. Mirror of
 * BRACKET_MIDPOINT_SQL: midpoint of [min,max]; open top tier (max == null) →
 * floor (min); missing amount → 0.
 */
export function bracketMidpoint(min: number | null, max: number | null): number {
  return sharedBracketMidpoint(min, max);
}

/**
 * Buy/sell sentiment in [0,1]: share of directional (P+S) activity that is
 * buying. 1 = all buys, 0 = all sells, 0.5 = balanced. null when there is no
 * directional activity (avoids a divide-by-zero that would read as "all sells").
 */
export function netSentiment(buys: number, sells: number): number | null {
  const total = buys + sells;
  if (total <= 0) return null;
  return buys / total;
}

/** Round to `dp` decimal places (helper for stable JSON numbers). */
export function round(n: number, dp = 2): number {
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}

// ---------------------------------------------------------------------------
// Filing-lag distribution
// ---------------------------------------------------------------------------

/** Fixed buckets (in days) for the disclosure-lag histogram, in display order. */
export const LAG_BUCKETS: ReadonlyArray<{ label: string; max: number | null }> = SHARED_LAG_BUCKETS;

/** Assign a lag (in whole days) to its display bucket label. */
export function lagBucket(days: number): string {
  for (const b of LAG_BUCKETS) {
    if (b.max == null || days <= b.max) return b.label;
  }
  return LAG_BUCKETS[LAG_BUCKETS.length - 1].label;
}

export interface LagRow {
  lagDays: number;
  count: number;
}

export interface LagSummary {
  count: number;
  medianLagDays: number | null;
  p90LagDays: number | null;
  /** Fraction (0..1) of disclosures filed more than 45 days after the trade. */
  overFortyFivePct: number | null;
  distribution: Array<{ bucket: string; count: number }>;
}

/**
 * Weighted percentile (0..100) over a histogram of (value,count) pairs. Returns
 * the smallest value whose cumulative count reaches the percentile rank. null
 * for an empty histogram.
 */
export function percentileFromHistogram(rows: LagRow[], percentile: number): number | null {
  const sorted = rows
    .filter((r) => Number.isFinite(r.lagDays) && r.count > 0)
    .sort((a, b) => a.lagDays - b.lagDays);
  const total = sorted.reduce((s, r) => s + r.count, 0);
  if (total === 0) return null;
  const rank = (percentile / 100) * total;
  let cum = 0;
  for (const r of sorted) {
    cum += r.count;
    if (cum >= rank) return r.lagDays;
  }
  return sorted[sorted.length - 1].lagDays;
}

/**
 * Summarize a filing-lag histogram into count, median, p90, the share filed
 * after the 45-day STOCK Act deadline, and the fixed-bucket distribution.
 */
export function summarizeLag(rows: LagRow[]): LagSummary {
  const clean = rows.filter((r) => Number.isFinite(r.lagDays) && r.count > 0);
  const count = clean.reduce((s, r) => s + r.count, 0);
  const distribution = LAG_BUCKETS.map((b) => ({ bucket: b.label, count: 0 }));
  const indexByLabel = new Map(distribution.map((d, i) => [d.bucket, i]));
  let over45 = 0;
  for (const r of clean) {
    const idx = indexByLabel.get(lagBucket(r.lagDays));
    if (idx != null) distribution[idx].count += r.count;
    if (r.lagDays > 45) over45 += r.count;
  }
  return {
    count,
    medianLagDays: percentileFromHistogram(clean, 50),
    p90LagDays: percentileFromHistogram(clean, 90),
    overFortyFivePct: count > 0 ? round(over45 / count, 4) : null,
    distribution,
  };
}

/**
 * Pick the top `n` items per group key from a flat list, preserving the list's
 * existing order within each group (callers pre-sort). Used to fold the
 * cluster-buy "politicians" follow-up query into per-cluster top-politician lists.
 */
export function topPerGroup<T>(items: T[], keyOf: (x: T) => string, n: number): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = keyOf(item);
    const arr = out.get(k);
    if (arr) {
      if (arr.length < n) arr.push(item);
    } else {
      out.set(k, [item]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Politician realized-performance aggregate ("skill" signal)
// ---------------------------------------------------------------------------

/** Median of a numeric list, or null when empty. */
function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/** One trade's cached performance anchors (from tx_performance + securities_ref). */
export interface MemberPerfRow {
  isOption: boolean;
  priceAtTrade: number | null;
  currentPrice: number | null;
  spxAtTrade: number | null;
  /** 'P' buy / 'S' sell / other. Dual aggregate scores buys only. */
  txType?: string | null;
  /** Close on/before the public filing (disclosure) date. */
  priceAtFiling?: number | null;
  spxAtFiling?: number | null;
  /**
   * Calendar days from the filing (or fallback) anchor to now. Used to
   * annualize filing-date excess with the same formula the Top Performers
   * board uses for its (reference-only) annualized figure: 365.25 /
   * max(30, elapsedDays). Top Performers itself ranks by the non-annualized,
   * winsorized avgExcess — see avgAnnualizedExcess below.
   */
  elapsedDaysSinceFiling?: number | null;
  /** Estimated trade volume in USD for size weighting. */
  estVolume?: number | null;
  /** The day `currentPrice` is from (securities_ref.current_price_date). */
  currentPriceDate?: string | null;
  /**
   * S&P 500 close on or before `currentPriceDate`, so the benchmark's exit leg
   * ends on the SAME day as the asset's.  When absent the aggregate falls back to
   * the single `currentSpx` it is handed (the pre-alignment behaviour).
   */
  spxNow?: number | null;
}

/**
 * Realized-performance aggregate for one politician's trades. All return figures are
 * FRACTIONS (0.18 = +18%), matching computePerformance / the /performance
 * endpoint. `winRate` is the share (0..1) of scored trades that beat the S&P.
 *
 * This is the security's move SINCE the disclosed trade (the same basis as
 * /performance), not cost-basis P&L — for buys it reads as "did the pick go up,
 * and did it beat the market." Options and unpriced tickers are excluded from
 * the scored set so they don't dilute the stats.
 *
 * Prefer {@link aggregateMemberDualPerformance} for product surfaces: buys only,
 * trade-date skill and filing-date copy-trade as separate legs.
 */
export interface MemberPerfSummary {
  tradeCount: number; // rows considered for this leg (usually buy count)
  scoredCount: number; // trades with usable price anchors
  winRate: number | null; // share with positive excess return (0..1)
  medianReturn: number | null;
  medianExcess: number | null;
  avgReturn: number | null;
  /**
   * Size-weighted average excess return. On the filing-date leg this is the
   * SAME statistic Top Performers ranks and displays by (though this
   * per-member computation is not asset-class filtered or winsorized the way
   * the leaderboard SQL is — see buildMemberPerformanceLeaderboardQuery).
   */
  avgExcess: number | null;
  /**
   * Equal-weighted average of annualized excess returns. Present on the
   * filing-date leg using the same formula as Top Performers' reference-only
   * annualized figure; NOT the ranking metric (Top Performers ranks by the
   * non-annualized avgExcess above). Null when no scored excess or when this
   * leg does not annualize.
   */
  avgAnnualizedExcess?: number | null;
}

/** Dual-anchor buy skill: trade-date (their timing) vs filing-date (copy-trade). */
export interface MemberDualPerformance {
  side: 'buys';
  buyCount: number;
  /** Approx skill: stock move since their trade date vs S&P. Buys only. */
  tradeDate: MemberPerfSummary;
  /**
   * Copy-trade: if you bought when the disclosure went public. Buys only.
   * filingDate.avgExcess is the same statistic Top Performers displays/sorts
   * by; avgAnnualizedExcess is reference-only (see MemberPerfSummary above).
   */
  filingDate: MemberPerfSummary;
}

const mean = (nums: number[]): number | null =>
  nums.length ? round(nums.reduce((a, b) => a + b, 0) / nums.length, 4) : null;

/** Annualize a cumulative excess return the same way as the member-performance leaderboard. */
export function annualizeExcess(excess: number, elapsedDays: number | null | undefined): number | null {
  if (!Number.isFinite(excess) || elapsedDays == null || !Number.isFinite(elapsedDays) || elapsedDays <= 0) {
    return null;
  }
  const denom = Math.max(30, elapsedDays);
  return excess * (365.25 / denom);
}

type PerfAnchor = 'trade' | 'filing';

function isBuyRow(r: MemberPerfRow): boolean {
  const t = (r.txType || '').toUpperCase();
  return t === 'B' || t === 'P' || t === 'PURCHASE' || t === 'BUY';
}

function rowAnchors(
  r: MemberPerfRow,
  anchor: PerfAnchor,
): { priceAt: number | null; spxAt: number | null } {
  if (anchor === 'filing') {
    return {
      priceAt: r.priceAtFiling ?? null,
      spxAt: r.spxAtFiling ?? null,
    };
  }
  return { priceAt: r.priceAtTrade, spxAt: r.spxAtTrade };
}

/**
 * Realized-performance aggregate. By default scores every non-option row with a
 * trade-date price (legacy). Pass `buysOnly` / `anchor: 'filing'` for the dual
 * product legs.
 */
export function aggregateMemberPerformance(
  rows: MemberPerfRow[],
  currentSpx: number | null,
  opts: {
    anchor?: PerfAnchor;
    buysOnly?: boolean;
    annualize?: boolean;
    /** Skip trades whose current price is older than this YYYY-MM-DD bar. */
    priceFreshThrough?: string;
  } = {},
): MemberPerfSummary {
  const anchor = opts.anchor ?? 'trade';
  const buysOnly = opts.buysOnly === true;
  const doAnnualize = opts.annualize === true && anchor === 'filing';

  const considered = buysOnly ? rows.filter(isBuyRow) : rows;
  const returns: number[] = [];
  const excesses: number[] = [];
  const annualized: number[] = [];
  const weights: number[] = [];

  const freshThrough = opts.priceFreshThrough?.slice(0, 10);
  for (const r of considered) {
    if (r.isOption) continue;
    if (freshThrough && r.currentPriceDate) {
      const d = r.currentPriceDate.slice(0, 10);
      if (d < freshThrough) continue;
    }
    const { priceAt, spxAt } = rowAnchors(r, anchor);
    if (priceAt == null || r.currentPrice == null) continue;
    const perf = computePerformance(priceAt, r.currentPrice, spxAt, r.spxNow ?? currentSpx);
    if (perf.assetReturn == null) continue;
    returns.push(perf.assetReturn);
    
    // Default weight is 1 if estVolume is not provided or 0 to avoid completely ignoring row.
    const weight = r.estVolume && r.estVolume > 0 ? r.estVolume : 1;
    weights.push(weight);
    
    if (perf.excessReturn != null) {
      excesses.push(perf.excessReturn);
      if (doAnnualize) {
        const ann = annualizeExcess(perf.excessReturn, r.elapsedDaysSinceFiling);
        if (ann != null) annualized.push(ann);
      }
    }
  }
  const wins = excesses.filter((x) => x > 0).length;
  
  // Helper for weighted mean
  const weightedMean = (nums: number[], wts: number[]): number | null => {
    if (!nums.length || nums.length !== wts.length) return null;
    let sumWeight = 0;
    let sumValue = 0;
    for (let i = 0; i < nums.length; i++) {
      sumWeight += wts[i];
      sumValue += nums[i] * wts[i];
    }
    return sumWeight > 0 ? round(sumValue / sumWeight, 4) : null;
  };

  const med = (nums: number[]): number | null => {
    const m = median(nums);
    return m == null ? null : round(m, 4);
  };
  return {
    tradeCount: considered.length,
    scoredCount: returns.length,
    winRate: excesses.length ? round(wins / excesses.length, 4) : null,
    medianReturn: med(returns),
    medianExcess: med(excesses),
    avgReturn: weightedMean(returns, weights),
    avgExcess: weightedMean(excesses, weights),
    avgAnnualizedExcess: doAnnualize ? weightedMean(annualized, weights) : null,
  };
}

/**
 * Buys-only dual performance for one politician:
 * - tradeDate: approx skill from their trade date
 * - filingDate: copy-trade from public disclosure date (+ annualized excess)
 *
 * Sells/exchanges/options are not mixed into either skill score (exit timing is
 * a different product story and needs cost basis we don't have).
 */
export function aggregateMemberDualPerformance(
  rows: MemberPerfRow[],
  currentSpx: number | null,
  opts: { priceFreshThrough?: string } = {},
): MemberDualPerformance {
  const buyCount = rows.filter(isBuyRow).length;
  const perfOpts = { priceFreshThrough: opts.priceFreshThrough };
  return {
    side: 'buys',
    buyCount,
    tradeDate: aggregateMemberPerformance(rows, currentSpx, { anchor: 'trade', buysOnly: true, ...perfOpts }),
    filingDate: aggregateMemberPerformance(rows, currentSpx, {
      anchor: 'filing',
      buysOnly: true,
      annualize: true,
      ...perfOpts,
    }),
  };
}

// ---------------------------------------------------------------------------
// Per-ticker congressional backtest ("how did names do after Congress bought")
// ---------------------------------------------------------------------------

/** One daily close bar; series are ASCENDING by date. */
export interface PriceBar {
  date: string;
  close: number;
}

export interface BacktestHorizon {
  days: number; // trading-day horizon (21/63/126/252)
  tradeCount: number; // buy events in the cohort (window)
  n: number; // events with complete forward price history at this horizon
  medianReturn: number | null;
  avgReturn: number | null;
  winRate: number | null; // share of scored events beating the S&P (excess > 0)
  medianExcess: number | null;
  avgExcess: number | null;
}

/** Minimum scored events before a horizon's stats are reported (else nulls). */
export const BACKTEST_MIN_N = 5;

/** Index of the last bar with date <= `date` (ascending series), or -1. Binary search. */
export function idxOnOrBefore(series: PriceBar[], date: string): number {
  let lo = 0;
  let hi = series.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].date <= date) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * Backtest a ticker's congressional BUY cohort: for each horizon N (trading
 * days), the forward return of the name from the trade date vs the S&P over the
 * same calendar span. Pure + deterministic.
 *
 * Entry = the close on/before each buy's tx_date (matches price_at_trade
 * semantics); forward = the close N trading days later (entryIdx + N in the
 * ascending series). Excess subtracts the S&P return over the same entry→forward
 * dates. Returns are FRACTIONS (0.18 = +18%). Events lacking forward history
 * (recent buys, delisted names) are counted in tradeCount but excluded from n —
 * surface both so callers can judge coverage. Horizons with n < BACKTEST_MIN_N
 * report null stats rather than noise.
 */
export function aggregateTickerBacktest(
  cohortDates: string[],
  priceAsc: PriceBar[],
  spxAsc: PriceBar[],
  horizons: number[],
): { tradeCount: number; horizons: BacktestHorizon[] } {
  const med = (nums: number[]): number | null => {
    const m = median(nums);
    return m == null ? null : round(m, 4);
  };
  const out: BacktestHorizon[] = horizons.map((N) => {
    const returns: number[] = [];
    const excesses: number[] = [];
    for (const d of cohortDates) {
      const ei = idxOnOrBefore(priceAsc, d);
      if (ei < 0) continue;
      const fi = ei + N;
      if (fi >= priceAsc.length) continue; // insufficient forward history
      const entry = priceAsc[ei].close;
      const fwd = priceAsc[fi].close;
      if (!(entry > 0)) continue;
      const assetReturn = fwd / entry - 1;
      returns.push(assetReturn);
      const se = idxOnOrBefore(spxAsc, priceAsc[ei].date);
      const sf = idxOnOrBefore(spxAsc, priceAsc[fi].date);
      if (se >= 0 && sf >= 0 && spxAsc[se].close > 0) {
        excesses.push(assetReturn - (spxAsc[sf].close / spxAsc[se].close - 1));
      }
    }
    const enough = returns.length >= BACKTEST_MIN_N;
    return {
      days: N,
      tradeCount: cohortDates.length,
      n: returns.length,
      medianReturn: enough ? med(returns) : null,
      avgReturn: enough ? mean(returns) : null,
      winRate: enough && excesses.length ? round(excesses.filter((x) => x > 0).length / excesses.length, 4) : null,
      medianExcess: enough && excesses.length ? med(excesses) : null,
      avgExcess: enough && excesses.length ? mean(excesses) : null,
    };
  });
  return { tradeCount: cohortDates.length, horizons: out };
}

// ---------------------------------------------------------------------------
// Per-ticker composite conviction score (0-100) — expert-panel synthesis
// ---------------------------------------------------------------------------
//
// Distinct-politician-consensus base, gated by realized politician skill + disclosure
// integrity, with multiplicative anti-gaming guards and hard thin-sample caps.
// Built ONLY from fields App A already returns. Returns are direction-aware
// (buy vs sell conviction). All sub-factors clamp to [0,100]. See PR for the
// full rationale + worked examples.

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/** Politician-skill rollup for the ticker's contributing politicians (or null = data gap). */
export interface ConvictionSkill {
  /** scoredCount-weighted mean winRate over politicians with scoredCount>=5. */
  wMeanWinRate: number;
  /** total scored trades across contributing politicians (coverage). */
  totalScoredCount: number;
  /** aggregate medianExcess > 0 (else skill is capped at 50). */
  medianExcessPositive: boolean;
}

export interface ConvictionInput {
  memberCount: number;
  buyCount: number;
  sellCount: number;
  netSentiment: number | null; // buys/(buys+sells); null = no directional activity
  estNetFlowUsd: number;
  tradeCount: number;
  dMembers: number; // distinct D politicians (cluster); 0 if none
  rMembers: number; // distinct R politicians
  deltaCount: number | null; // momentum: recent-minus-prior count (trending)
  recentMembers: number | null;
  lateShare: number | null; // share of the ticker's trades filed >45d after tx_date; null = unknown
  skill?: ConvictionSkill | null; // null/undefined => data-gap fallback (drop skill factor)
}

export interface ConvictionResult {
  score: number | null; // 0..100; null when suppressed (tradeCount < 3)
  direction: 'BUY' | 'SELL' | null;
  fallback: boolean; // true when the no-skill-data fallback weighting was used
  components: {
    breadth: number;
    party: number;
    skill: number | null;
    skew: number;
    momentum: number;
    netflow: number;
    base: number;
    integrityMult: number;
    dominanceMult: number;
  };
}

const BREADTH_REF = 12; // cluster-buys default ceiling

/**
 * Resolve the conviction direction from net sentiment, with net flow as the
 * tiebreaker. BUY when buying dominates the directional trade count, SELL when
 * selling dominates. A perfectly balanced count (netSentiment === 0.5) is NOT
 * sell — it breaks the tie on net-flow sign, and only when flow is also exactly
 * balanced (or absent) does it return null. null directional activity → null.
 * Exported so the route can pick the matching (ticker, tx_type) party cluster.
 */
export function convictionDirection(
  netSentiment: number | null,
  estNetFlowUsd: number,
): 'BUY' | 'SELL' | null {
  if (netSentiment == null) return null;
  if (netSentiment > 0.5) return 'BUY';
  if (netSentiment < 0.5) return 'SELL';
  // Exactly balanced by count — let the dollar flow break the tie.
  if (estNetFlowUsd > 0) return 'BUY';
  if (estNetFlowUsd < 0) return 'SELL';
  return null;
}

/** Compute the 0-100 conviction score for one ticker+direction. Pure. */
export function computeConvictionScore(i: ConvictionInput): ConvictionResult {
  const direction = convictionDirection(i.netSentiment, i.estNetFlowUsd);

  const fBreadth = clamp((100 * Math.log(1 + i.memberCount)) / Math.log(1 + BREADTH_REF), 0, 100);

  const both = (i.dMembers > 0 ? 1 : 0) + (i.rMembers > 0 ? 1 : 0);
  const fParty = both === 2 ? 100 : both === 1 ? 45 : 0;

  // Politician skill rollup (or fallback when sparse).
  const skillEnough = !!i.skill && i.skill.totalScoredCount >= 3;
  let fSkill: number | null = null;
  if (skillEnough && i.skill) {
    let s = clamp((i.skill.wMeanWinRate - 0.5) / 0.3, 0, 1) * 100;
    if (!i.skill.medianExcessPositive) s = Math.min(s, 50);
    fSkill = s * Math.min(1, i.skill.totalScoredCount / 10);
  }

  const directional = i.buyCount + i.sellCount;
  const fSkew =
    i.netSentiment == null ? 0 : Math.abs(i.netSentiment - 0.5) * 2 * Math.min(1, directional / 8) * 100;

  const fMomentum =
    100 * clamp((i.deltaCount ?? 0) / 8, 0, 1) * Math.min(1, (i.recentMembers ?? 0) / 3);

  // Net-flow strength is symmetric in the conviction direction: dollars flowing
  // WITH the signal (inflow for BUY, outflow for SELL) strengthen it; dollars
  // against it count as 0. Saturates at $5M of supporting flow. (Earlier this
  // mapped raw signed flow onto [0,100], which scored every SELL's outflow as
  // weak and biased the composite toward BUY.)
  const dirSign = direction === 'SELL' ? -1 : 1;
  const supportingFlow = dirSign * i.estNetFlowUsd;
  const fNetflow = clamp(supportingFlow / 5_000_000, 0, 1) * 100;

  // Additive base — 100% aggregate Congressional market consensus
  // (Breadth 35%, Party 25%, Skew 20%, Momentum 10%, Net Flow 10%).
  // Member skill track record is preserved in `components.skill` for trade-level scoring.
  const fallback = fSkill == null;
  const base = 0.35 * fBreadth + 0.25 * fParty + 0.20 * fSkew + 0.10 * fMomentum + 0.10 * fNetflow;

  // Multiplicative anti-gaming gates.
  const integrityMult = i.lateShare == null ? 0.9 : clamp(1 - 0.4 * i.lateShare, 0.6, 1);
  const conc = i.memberCount > 0 ? i.tradeCount / i.memberCount : i.tradeCount;
  const baseConc = conc > 8 ? 0.65 : conc > 4 ? 0.8 : 1.0;
  const partyBonus = i.dMembers >= 1 && i.rMembers >= 1 ? 1.08 : 1.0;
  const dominanceMult = clamp(baseConc * partyBonus, 0.5, 1.0);

  let raw = base * integrityMult * dominanceMult;

  // Hard caps.
  if (i.memberCount < 2) raw = Math.min(raw, 25);
  // No resolved BUY/SELL direction (no directional activity, or a perfectly
  // balanced ticker with no net flow) → cap hard: breadth/party/momentum must
  // not surface a directionless name as high conviction.
  if (direction == null) raw = Math.min(raw, 20);

  const components = {
    breadth: round(fBreadth, 1),
    party: fParty,
    skill: fSkill == null ? null : round(fSkill, 1),
    skew: round(fSkew, 1),
    momentum: round(fMomentum, 1),
    netflow: round(fNetflow, 1),
    base: round(base, 1),
    integrityMult: round(integrityMult, 3),
    dominanceMult: round(dominanceMult, 3),
  };

  // Suppress entirely (null, not 0) when there's no real signal in the window.
  if (i.tradeCount < 3) return { score: null, direction: null, fallback, components };

  return { score: Math.round(clamp(raw, 0, 100)), direction, fallback, components };
}
