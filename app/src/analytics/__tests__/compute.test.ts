/**
 * src/analytics/__tests__/compute.test.ts
 *
 * Unit tests for the pure analytics post-processing helpers.
 */

import { describe, it, expect } from 'vitest';
import {
  aggregateMemberDualPerformance,
  aggregateMemberPerformance,
  annualizeExcess,
  aggregateTickerBacktest,
  computeConvictionScore,
  convictionDirection,
  BACKTEST_MIN_N,
  bracketMidpoint,
  idxOnOrBefore,
  lagBucket,
  netSentiment,
  percentileFromHistogram,
  round,
  summarizeLag,
  topPerGroup,
  type LagRow,
  type MemberPerfRow,
  type PriceBar,
} from '../compute.ts';

describe('bracketMidpoint', () => {
  it('returns the midpoint of a closed bracket', () => {
    expect(bracketMidpoint(1001, 15000)).toBe(8000.5);
    expect(bracketMidpoint(15001, 50000)).toBe(32500.5);
  });
  it('falls back to the floor for the open top tier (max == null)', () => {
    expect(bracketMidpoint(50000001, null)).toBe(50000001);
  });
  it('returns 0 when the amount is entirely missing', () => {
    expect(bracketMidpoint(null, null)).toBe(0);
  });
});

describe('netSentiment', () => {
  it('is the buy share of directional activity', () => {
    expect(netSentiment(3, 1)).toBe(0.75);
    expect(netSentiment(0, 4)).toBe(0);
    expect(netSentiment(5, 0)).toBe(1);
  });
  it('is null when there is no directional activity', () => {
    expect(netSentiment(0, 0)).toBeNull();
  });
});

describe('round', () => {
  it('rounds to the requested precision', () => {
    expect(round(0.123456, 2)).toBe(0.12);
    expect(round(0.125, 2)).toBe(0.13);
    expect(round(1234.5)).toBe(1234.5);
  });
});

describe('lagBucket', () => {
  it('assigns days to the right display bucket', () => {
    expect(lagBucket(0)).toBe('0-7d');
    expect(lagBucket(7)).toBe('0-7d');
    expect(lagBucket(8)).toBe('8-14d');
    expect(lagBucket(30)).toBe('15-30d');
    expect(lagBucket(45)).toBe('31-45d');
    expect(lagBucket(50)).toBe('46-59d');
    expect(lagBucket(60)).toBe('60d+');
    expect(lagBucket(900)).toBe('60d+');
  });
});

describe('percentileFromHistogram', () => {
  const rows: LagRow[] = [
    { lagDays: 1, count: 10 },
    { lagDays: 10, count: 10 },
    { lagDays: 100, count: 10 },
  ];
  it('computes weighted percentiles', () => {
    expect(percentileFromHistogram(rows, 50)).toBe(10);
    expect(percentileFromHistogram(rows, 90)).toBe(100);
    expect(percentileFromHistogram(rows, 0)).toBe(1);
  });
  it('returns null for an empty histogram', () => {
    expect(percentileFromHistogram([], 50)).toBeNull();
    expect(percentileFromHistogram([{ lagDays: 5, count: 0 }], 50)).toBeNull();
  });
});

describe('summarizeLag', () => {
  it('summarizes count, median, p90, over-45 share, and buckets', () => {
    const rows: LagRow[] = [
      { lagDays: 3, count: 5 }, // 0-7d
      { lagDays: 12, count: 3 }, // 8-14d
      { lagDays: 50, count: 2 }, // 46-59d, also > 45
    ];
    const s = summarizeLag(rows);
    expect(s.count).toBe(10);
    expect(s.medianLagDays).toBe(3);
    expect(s.overFortyFivePct).toBe(0.2);
    const byBucket = Object.fromEntries(s.distribution.map((d) => [d.bucket, d.count]));
    expect(byBucket['0-7d']).toBe(5);
    expect(byBucket['8-14d']).toBe(3);
    expect(byBucket['46-59d']).toBe(2);
    // every fixed bucket is present (zero-filled)
    expect(s.distribution).toHaveLength(6);
  });
  it('handles an empty histogram with null stats', () => {
    const s = summarizeLag([]);
    expect(s.count).toBe(0);
    expect(s.medianLagDays).toBeNull();
    expect(s.overFortyFivePct).toBeNull();
    expect(s.distribution.every((d) => d.count === 0)).toBe(true);
  });
});

describe('topPerGroup', () => {
  it('keeps the first n items per group key in input order', () => {
    const items = [
      { k: 'a', v: 1 },
      { k: 'a', v: 2 },
      { k: 'a', v: 3 },
      { k: 'b', v: 9 },
    ];
    const out = topPerGroup(items, (x) => x.k, 2);
    expect(out.get('a')!.map((x) => x.v)).toEqual([1, 2]);
    expect(out.get('b')!.map((x) => x.v)).toEqual([9]);
  });
});

describe('aggregateMemberPerformance', () => {
  const row = (over: Partial<MemberPerfRow> = {}): MemberPerfRow => ({
    isOption: false,
    priceAtTrade: 100,
    currentPrice: 120,
    spxAtTrade: 100,
    ...over,
  });

  it('returns all-null stats for an empty / unpriced set', () => {
    const empty = aggregateMemberPerformance([], 110);
    expect(empty).toMatchObject({
      tradeCount: 0,
      scoredCount: 0,
      winRate: null,
      medianReturn: null,
      medianExcess: null,
    });
    // Rows present but no usable price anchors -> counted but not scored.
    const unpriced = aggregateMemberPerformance(
      [row({ priceAtTrade: null }), row({ currentPrice: null })],
      110,
    );
    expect(unpriced.tradeCount).toBe(2);
    expect(unpriced.scoredCount).toBe(0);
    expect(unpriced.medianReturn).toBeNull();
  });

  it('excludes options from the scored set but counts them in tradeCount', () => {
    const out = aggregateMemberPerformance([row(), row({ isOption: true })], 100);
    expect(out.tradeCount).toBe(2);
    expect(out.scoredCount).toBe(1);
  });

  it('computes return, alpha vs S&P, and win-rate as fractions', () => {
    // S&P flat (100->100) so excess == asset return for both trades.
    // Trade A: stock +20% (100->120) => excess +0.20 (win)
    // Trade B: stock -10% (200->180) => excess -0.10 (loss)
    const out = aggregateMemberPerformance(
      [
        row({ priceAtTrade: 100, currentPrice: 120, spxAtTrade: 100 }),
        row({ priceAtTrade: 200, currentPrice: 180, spxAtTrade: 100 }),
      ],
      100,
    );
    expect(out.scoredCount).toBe(2);
    expect(out.medianReturn).toBeCloseTo(0.05, 5); // median of +0.20 and -0.10
    expect(out.winRate).toBeCloseTo(0.5, 5); // 1 of 2 beat the market
    expect(out.medianExcess).toBeCloseTo(0.05, 5); // median of +0.20 and -0.10
  });

  it('skips stale-priced rows when priceFreshThrough is set', () => {
    const dual = aggregateMemberDualPerformance(
      [
        row({
          txType: 'P',
          priceAtTrade: 100,
          currentPrice: 120,
          spxAtTrade: 100,
          currentPriceDate: '2026-07-01',
          spxNow: 105,
        }),
        row({
          txType: 'P',
          priceAtTrade: 100,
          currentPrice: 110,
          spxAtTrade: 100,
          currentPriceDate: '2026-08-01',
          spxNow: 100,
        }),
      ],
      110,
      { priceFreshThrough: '2026-08-01' },
    );
    expect(dual.tradeDate.scoredCount).toBe(1);
    expect(dual.tradeDate.avgReturn).toBeCloseTo(0.1, 5);
  });

  it('skips a missing current price date when priceFreshThrough is set', () => {
    const out = aggregateMemberPerformance(
      [
        row({ currentPriceDate: null }),
        row({ currentPriceDate: '' }),
        row({
          currentPriceDate: '2026-08-01',
          priceAtTrade: 100,
          currentPrice: 110,
          spxAtTrade: 100,
        }),
      ],
      100,
      { priceFreshThrough: '2026-08-01' },
    );
    expect(out.tradeCount).toBe(3);
    expect(out.scoredCount).toBe(1);
    expect(out.avgReturn).toBeCloseTo(0.1, 5);
  });

  it('leaves excess null (but still scores the return) when no S&P anchor exists', () => {
    const out = aggregateMemberPerformance([row({ spxAtTrade: null })], null);
    expect(out.scoredCount).toBe(1);
    expect(out.medianReturn).toBeCloseTo(0.2, 5);
    expect(out.winRate).toBeNull();
    expect(out.medianExcess).toBeNull();
  });

  it('buysOnly skips sells; filing anchor uses priceAtFiling', () => {
    const rows: MemberPerfRow[] = [
      row({
        txType: 'B',
        priceAtTrade: 100,
        currentPrice: 120,
        spxAtTrade: 100,
        priceAtFiling: 110,
        spxAtFiling: 100,
        elapsedDaysSinceFiling: 365.25,
      }),
      row({
        txType: 'S',
        priceAtTrade: 50,
        currentPrice: 200,
        spxAtTrade: 100,
        priceAtFiling: 50,
        spxAtFiling: 100,
        elapsedDaysSinceFiling: 365.25,
      }),
    ];
    const trade = aggregateMemberPerformance(rows, 100, { anchor: 'trade', buysOnly: true });
    expect(trade.tradeCount).toBe(1);
    expect(trade.scoredCount).toBe(1);
    expect(trade.avgReturn).toBeCloseTo(0.2, 5); // 100→120, sell ignored

    const filing = aggregateMemberPerformance(rows, 100, {
      anchor: 'filing',
      buysOnly: true,
      annualize: true,
    });
    expect(filing.scoredCount).toBe(1);
    // filing 110→120 = ~9.09% excess (SPX flat)
    expect(filing.avgExcess).toBeCloseTo(120 / 110 - 1, 4);
    // full year → annualized ≈ cumulative
    expect(filing.avgAnnualizedExcess).toBeCloseTo(120 / 110 - 1, 4);
  });
});

describe('annualizeExcess', () => {
  it('uses max(30, elapsed) day floor like the leaderboard SQL', () => {
    expect(annualizeExcess(0.1, 365.25)).toBeCloseTo(0.1, 6);
    expect(annualizeExcess(0.1, 10)).toBeCloseTo(0.1 * (365.25 / 30), 6);
    expect(annualizeExcess(0.1, null)).toBeNull();
    expect(annualizeExcess(0.1, 0)).toBeNull();
  });
});

describe('aggregateMemberDualPerformance', () => {
  it('returns separate trade-date and filing-date buy legs', () => {
    const dual = aggregateMemberDualPerformance(
      [
        {
          isOption: false,
          txType: 'B',
          priceAtTrade: 100,
          spxAtTrade: 100,
          priceAtFiling: 105,
          spxAtFiling: 100,
          currentPrice: 120,
          elapsedDaysSinceFiling: 182.625, // half year → annualize * 2
        },
        {
          isOption: false,
          txType: 'S',
          priceAtTrade: 100,
          spxAtTrade: 100,
          priceAtFiling: 100,
          spxAtFiling: 100,
          currentPrice: 50,
          elapsedDaysSinceFiling: 100,
        },
      ],
      100,
    );
    expect(dual.side).toBe('buys');
    expect(dual.buyCount).toBe(1);
    expect(dual.tradeDate.avgReturn).toBeCloseTo(0.2, 5);
    expect(dual.filingDate.avgReturn).toBeCloseTo(120 / 105 - 1, 4);
    // excess ≈ 0.1429 cumulative; half year → ~0.2857 annualized
    expect(dual.filingDate.avgAnnualizedExcess).toBeCloseTo((120 / 105 - 1) * 2, 3);
  });
});

describe('aggregateTickerBacktest', () => {
  // 12 ascending daily bars, close = 100,101,...,111 over 2026-02-01..2026-02-12.
  const price: PriceBar[] = Array.from({ length: 12 }, (_, i) => ({
    date: `2026-02-${String(i + 1).padStart(2, '0')}`,
    close: 100 + i,
  }));
  const spxFlat: PriceBar[] = price.map((b) => ({ date: b.date, close: 5000 }));

  it('idxOnOrBefore finds the last bar on/before a date (binary search)', () => {
    expect(idxOnOrBefore(price, '2026-02-01')).toBe(0);
    expect(idxOnOrBefore(price, '2026-02-05')).toBe(4);
    expect(idxOnOrBefore(price, '2026-01-01')).toBe(-1); // before all history
    expect(idxOnOrBefore(price, '2026-12-31')).toBe(11); // after all history
  });

  it('computes forward return + excess per horizon (flat SPX → excess == return)', () => {
    const cohort = Array(6).fill('2026-02-01'); // entry idx 0, close 100
    const r = aggregateTickerBacktest(cohort, price, spxFlat, [1, 3]);
    expect(r.tradeCount).toBe(6);
    const h1 = r.horizons.find((h) => h.days === 1)!;
    expect(h1.n).toBe(6);
    expect(h1.medianReturn).toBeCloseTo(0.01, 5); // 101/100 - 1
    expect(h1.winRate).toBeCloseTo(1, 5); // excess 0.01 > 0
    expect(h1.medianExcess).toBeCloseTo(0.01, 5);
    const h3 = r.horizons.find((h) => h.days === 3)!;
    expect(h3.medianReturn).toBeCloseTo(0.03, 5); // 103/100 - 1
  });

  it('excludes events lacking forward history but counts them in tradeCount', () => {
    const cohort = Array(5).fill('2026-02-12'); // last bar (idx 11) → no forward bar
    const r = aggregateTickerBacktest(cohort, price, spxFlat, [1]);
    expect(r.horizons[0].tradeCount).toBe(5);
    expect(r.horizons[0].n).toBe(0);
    expect(r.horizons[0].medianReturn).toBeNull();
  });

  it(`reports null stats when fewer than BACKTEST_MIN_N (${BACKTEST_MIN_N}) scored events`, () => {
    const cohort = ['2026-02-01', '2026-02-02', '2026-02-03']; // 3 < 5
    const r = aggregateTickerBacktest(cohort, price, spxFlat, [1]);
    expect(r.horizons[0].n).toBe(3);
    expect(r.horizons[0].medianReturn).toBeNull();
    expect(r.horizons[0].winRate).toBeNull();
  });

  it('subtracts the S&P return for excess (parallel SPX rise → ~0 excess, no win)', () => {
    const spxRising: PriceBar[] = price.map((b, i) => ({ date: b.date, close: 1000 + 10 * i })); // +1%/day
    const cohort = Array(6).fill('2026-02-01');
    const h1 = aggregateTickerBacktest(cohort, price, spxRising, [1]).horizons[0];
    expect(h1.medianReturn).toBeCloseTo(0.01, 5); // asset +1%
    expect(h1.medianExcess).toBeCloseTo(0, 5); // SPX also +1% → excess ~0
    expect(h1.winRate).toBeCloseTo(0, 5); // 0 is not > 0
  });
});

describe('computeConvictionScore', () => {
  // Baseline = the panel's full-data worked example (expected ~69, BUY).
  const full = {
    memberCount: 8,
    buyCount: 17,
    sellCount: 3,
    netSentiment: 0.85,
    estNetFlowUsd: 1_000_000,
    tradeCount: 28,
    dMembers: 4,
    rMembers: 3,
    deltaCount: 6,
    recentMembers: 4,
    lateShare: 0.1,
    skill: { wMeanWinRate: 0.7, totalScoredCount: 30, medianExcessPositive: true },
  };

  it('scores the full-data example in the panel-predicted range (BUY, ~69)', () => {
    const r = computeConvictionScore(full);
    expect(r.direction).toBe('BUY');
    expect(r.fallback).toBe(false);
    expect(r.score).toBeGreaterThanOrEqual(62);
    expect(r.score).toBeLessThanOrEqual(76);
    expect(r.components.skill).not.toBeNull();
  });

  it('uses the data-gap fallback (no skill) when no realized evidence', () => {
    const r = computeConvictionScore({ ...full, skill: null });
    expect(r.fallback).toBe(true);
    expect(r.components.skill).toBeNull();
    expect(r.score).toBeGreaterThanOrEqual(60);
  });

  it('caps a single-politician name at 25 (an idea, not conviction)', () => {
    const r = computeConvictionScore({
      ...full,
      memberCount: 1,
      dMembers: 1,
      rMembers: 0,
      skill: null,
    });
    expect(r.score).toBeLessThanOrEqual(25);
  });

  it('suppresses entirely (null score) when tradeCount < 3', () => {
    const r = computeConvictionScore({ ...full, tradeCount: 2 });
    expect(r.score).toBeNull();
  });

  it('caps at 20 and gives no direction when there is no directional activity', () => {
    const r = computeConvictionScore({
      ...full,
      netSentiment: null,
      buyCount: 0,
      sellCount: 0,
    });
    expect(r.direction).toBeNull();
    expect(r.score).toBeLessThanOrEqual(20);
  });

  it('rewards bipartisan consensus over single-party (party factor)', () => {
    // Moderate inputs so the score sits below the no-skill 60 cap and the party
    // difference is observable rather than clamped away.
    const moderate = {
      memberCount: 4,
      buyCount: 7,
      sellCount: 1,
      netSentiment: 0.875,
      estNetFlowUsd: 200_000,
      tradeCount: 8,
      deltaCount: 2,
      recentMembers: 2,
      lateShare: 0.1,
      skill: null,
    };
    const bipartisan = computeConvictionScore({ ...moderate, dMembers: 2, rMembers: 2 });
    const onePartyOnly = computeConvictionScore({ ...moderate, dMembers: 4, rMembers: 0 });
    expect(bipartisan.score!).toBeGreaterThan(onePartyOnly.score!);
  });

  it('labels SELL conviction when sentiment is net-sell', () => {
    const r = computeConvictionScore({
      ...full,
      buyCount: 3,
      sellCount: 17,
      netSentiment: 0.15,
      estNetFlowUsd: -1_000_000,
    });
    expect(r.direction).toBe('SELL');
  });

  it('treats a perfectly balanced ticker as neutral (no direction) and caps it at 20', () => {
    // Equal buys/sells with no net dollar flow → genuinely neutral: no direction,
    // and capped like the no-directional case so it can't rank as high conviction.
    const r = computeConvictionScore({
      ...full,
      buyCount: 10,
      sellCount: 10,
      netSentiment: 0.5,
      estNetFlowUsd: 0,
    });
    expect(r.direction).toBeNull();
    expect(r.score).toBeLessThanOrEqual(20);
  });

  it('scores net-flow symmetrically: a big-outflow SELL matches a big-inflow BUY', () => {
    // Same magnitude of supporting flow ($4M) should yield the same net-flow
    // component for a SELL (outflow) as for a BUY (inflow).
    const buy = computeConvictionScore({
      ...full,
      buyCount: 17,
      sellCount: 3,
      netSentiment: 0.85,
      estNetFlowUsd: 4_000_000,
    });
    const sell = computeConvictionScore({
      ...full,
      buyCount: 3,
      sellCount: 17,
      netSentiment: 0.15,
      estNetFlowUsd: -4_000_000,
    });
    expect(buy.direction).toBe('BUY');
    expect(sell.direction).toBe('SELL');
    expect(sell.components.netflow).toBe(buy.components.netflow);
    expect(sell.components.netflow).toBeGreaterThan(0);
  });

  it('does not credit net-flow that runs against the conviction direction', () => {
    // Net buying (BUY) but a net dollar OUTflow → flow opposes the signal → 0.
    const r = computeConvictionScore({
      ...full,
      buyCount: 17,
      sellCount: 3,
      netSentiment: 0.85,
      estNetFlowUsd: -4_000_000,
    });
    expect(r.direction).toBe('BUY');
    expect(r.components.netflow).toBe(0);
  });
});

describe('convictionDirection', () => {
  it('is BUY when buying dominates, SELL when selling dominates', () => {
    expect(convictionDirection(0.75, 0)).toBe('BUY');
    expect(convictionDirection(0.25, 0)).toBe('SELL');
  });
  it('breaks an exact tie on net-flow sign, else null', () => {
    expect(convictionDirection(0.5, 1)).toBe('BUY');
    expect(convictionDirection(0.5, -1)).toBe('SELL');
    expect(convictionDirection(0.5, 0)).toBeNull();
  });
  it('is null with no directional activity', () => {
    expect(convictionDirection(null, 5_000_000)).toBeNull();
  });
});
