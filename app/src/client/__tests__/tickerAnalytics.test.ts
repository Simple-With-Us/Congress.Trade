/**
 * src/client/__tests__/tickerAnalytics.test.ts
 *
 * Pins the company-drawer parity block on `GET /api/client/v1/ticker/:ticker`
 * (`?include=analytics`) — buy pressure, the buys/sells time series, top
 * buyers/sellers and the "Performance After Buys" backtest.
 *
 * The three properties that actually matter to a shipped, App-Store-frozen
 * binary are pinned here:
 *   1. WITHOUT `include=analytics` the envelope is byte-for-byte what older
 *      decoders already parse (no `analytics` key at all).
 *   2. WITH it, the numbers come from the same analytics builders the website's
 *      drawer uses, projected into the phone-shaped DTO.
 *   3. An analytics failure degrades that ONE section to `analytics: null`
 *      instead of blanking the trade list the endpoint primarily exists for.
 *
 * Deliberately a standalone file with its own narrow D1 double: routes.test.ts'
 * shared `makeEnv` models the feed corpus only, and teaching it the analytics
 * builders' SQL would put a large edit on a file other lanes are editing.
 */

import { describe, expect, it } from 'vitest';
import { buildClientRouter } from '../routes.ts';
import type { Env } from '../../shared/types.ts';

type Row = Record<string, unknown>;

interface Fixture {
  /** Rows the trade-list + client summary queries see. */
  trades: Row[];
  /** Analytics ticker-summary aggregate (buildTickerSummaryQuery). */
  tickerSummary: Row;
  /** Buys/sells per period (buildTickerTimeSeriesQuery). */
  series: Row[];
  topBuyers: Row[];
  topSellers: Row[];
  /** Buy-cohort trade dates (buildTickerBacktestCohortQuery). */
  cohort: Array<{ tx_date: string }>;
  priceEod: Array<{ date: string; close: number }>;
  spxEod: Array<{ date: string; close: number }>;
  /** When set, the named analytics query rejects — the degrade path. */
  failOn?: 'summary' | 'series' | 'traders' | 'cohort' | 'price';
}

function tradeRow(over: Partial<Row> = {}): Row {
  return {
    id: 'tx_1',
    doc_id: 'H-2026-1',
    filer_id: 'P000197',
    tx_date: '2026-03-02',
    owner: 'self',
    asset_name: 'Apple Inc',
    ticker: 'AAPL',
    asset_type: 'ST',
    tx_type: 'B',
    amount_min: 15_001,
    amount_max: 50_000,
    is_option: 0,
    cap_gains_over_200: 0,
    raw_text: null,
    confidence: 0.95,
    source: 'primary',
    row_key: 'v1:primary:0:t1',
    created_at: '2026-03-05T00:00:00.000Z',
    cursor_seq: 100,
    est_value: 32_500,
    filer_full_name: 'Nancy Pelosi',
    filer_state: 'CA',
    filer_photo_url: null,
    filing_filed_date: '2026-03-04',
    filing_first_seen_at: '2026-03-05T00:00:00.000Z',
    filing_source_url: 'https://example.test/1.pdf',
    __chamber: 'house',
    __member_name: 'Nancy Pelosi',
    __party: 'Democrat',
    ...over,
  };
}

/**
 * A price series long enough that every default horizon (21/63/126/252 trading
 * days) has forward history for the cohort dates, so the backtest reports real
 * numbers rather than "insufficient history" nulls.
 */
function priceSeries(startClose: number, days: number, dailyDrift: number) {
  const out: Array<{ date: string; close: number }> = [];
  const start = Date.UTC(2026, 0, 1);
  for (let i = 0; i < days; i += 1) {
    out.push({
      date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
      close: Number((startClose * (1 + dailyDrift) ** i).toFixed(4)),
    });
  }
  return out;
}

function makeEnv(fx: Fixture): { env: Env; seen: string[] } {
  const kv = new Map<string, string>();
  const seen: string[] = [];

  const prepare = (sql: string) => ({
    params: [] as unknown[],
    bind(...params: unknown[]) {
      this.params = params;
      return this;
    },
    async first<T>() {
      return ((await this.all<T>()).results[0] ?? null) as T | null;
    },
    async all<T>(): Promise<{ results: T[] }> {
      seen.push(sql);
      const results = (rows(sql, this.params) ?? []) as T[];
      return { results };
    },
    async run() {
      return { success: true, meta: { changes: 1 } };
    },
  });

  const fail = (which: Fixture['failOn']) => {
    if (fx.failOn === which) throw new Error(`simulated D1 failure: ${which}`);
  };

  function rows(sql: string, params: unknown[]): Row[] {
    // --- price history -----------------------------------------------------
    // CT-2459 bounded backtest series: honor the cohort-min bound (params
    // carry [ticker, min, ticker, min] / [min, min]) plus the one
    // on-or-before bar, exactly as SQLite would.
    if (/COUNT\(\*\) AS n FROM price_eod/i.test(sql)) {
      fail('price');
      return [{ n: fx.priceEod.length }];
    }
    if (/FROM price_eod/i.test(sql)) {
      fail('price');
      if (/MAX\(date\)/i.test(sql)) {
        const min = String(params[1] ?? '');
        const before = fx.priceEod.filter((b) => String(b.date) <= min);
        const anchor = before.length ? [before[before.length - 1]] : [];
        return [...anchor, ...fx.priceEod.filter((b) => String(b.date) > min)];
      }
      return fx.priceEod;
    }
    if (/FROM spx_eod/i.test(sql)) {
      if (/MAX\(date\)/i.test(sql)) {
        const min = String(params[0] ?? '');
        const before = fx.spxEod.filter((b) => String(b.date) <= min);
        const anchor = before.length ? [before[before.length - 1]] : [];
        return [...anchor, ...fx.spxEod.filter((b) => String(b.date) > min)];
      }
      return fx.spxEod;
    }

    // --- securities_ref ----------------------------------------------------
    if (/FROM securities_ref WHERE ticker = \?/i.test(sql)) {
      return [{ ticker: 'AAPL', company_name: 'Apple Inc', sector: 'Technology' }];
    }

    // --- the CLIENT contract's own all-time summary -------------------------
    // Distinguished from the analytics ticker summary by `exchange_count`,
    // which only client/queries.ts' tickerSummarySql selects.
    if (/AS exchange_count/i.test(sql)) {
      return [
        {
          total_trades: fx.trades.length,
          buy_count: fx.trades.filter((r) => r.tx_type === 'B').length,
          sell_count: fx.trades.filter((r) => r.tx_type === 'S').length,
          exchange_count: 0,
          member_count: new Set(fx.trades.map((r) => r.filer_id)).size,
          est_volume: fx.trades.reduce((s, r) => s + Number(r.est_value ?? 0), 0),
          est_net_flow: 0,
          first_trade: '2026-03-02',
          last_trade: '2026-03-02',
        },
      ];
    }

    // --- analytics: ticker summary -----------------------------------------
    if (/AS total_trades/i.test(sql) && /AS member_count/i.test(sql)) {
      fail('summary');
      return [fx.tickerSummary];
    }

    // --- analytics: buys/sells over time ------------------------------------
    if (/strftime\(\?, t\.tx_date\) AS period/i.test(sql)) {
      fail('series');
      return fx.series;
    }

    // --- analytics: top buyers / sellers ------------------------------------
    if (/GROUP BY t\.filer_id/i.test(sql) && /AS trade_count/i.test(sql)) {
      fail('traders');
      // buildTickerTopTradersQuery binds [ticker, ...txTypes]; Buy expands to
      // B+P, Sell stays S — that param tail is how the two calls differ.
      return params.includes('S') ? fx.topSellers : fx.topBuyers;
    }

    // --- analytics: buy cohort ----------------------------------------------
    if (/SELECT t\.tx_date AS tx_date/i.test(sql)) {
      fail('cohort');
      return fx.cohort;
    }

    // --- feed COUNT(*) -------------------------------------------------------
    if (/COUNT\(\*\) AS total(?:\s|,|$)/i.test(sql)) return [{ total: fx.trades.length }];

    // --- feed page ------------------------------------------------------------
    if (/FROM transactions t/i.test(sql) || /FROM \(/i.test(sql)) return fx.trades;

    return [];
  }

  const env = {
    DB: { prepare } as unknown as D1Database,
    CONFIG_KV: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => {
        kv.set(k, v);
      },
      delete: async (k: string) => {
        kv.delete(k);
      },
    },
    INGEST_QUEUE: { send: async () => {}, sendBatch: async () => {} },
    DELIVERY_QUEUE: { send: async () => {}, sendBatch: async () => {} },
  } as unknown as Env;

  return { env, seen };
}

function fixture(over: Partial<Fixture> = {}): Fixture {
  return {
    trades: [tradeRow()],
    tickerSummary: {
      total_trades: 12,
      buy_count: 9,
      sell_count: 3,
      member_count: 7,
      est_volume: 1_234_567.4,
      est_net_flow: 987_654.6,
      first_trade: '2026-01-05',
      last_trade: '2026-03-02',
    },
    series: [
      { period: '2026-01', buys: 4, sells: 1, est_buy_vol: 400_000, est_sell_vol: 90_000 },
      { period: '2026-02', buys: 5, sells: 2, est_buy_vol: 500_000, est_sell_vol: 244_567 },
    ],
    topBuyers: [
      {
        filer_id: 'P000197',
        full_name: 'Hon. Nancy Pelosi',
        party: 'Democrat',
        photo_url: 'https://example.test/p.jpg',
        trade_count: 5,
        est_volume: 800_000.2,
      },
    ],
    topSellers: [
      {
        filer_id: 'G000596',
        full_name: 'Markwayne Mullin',
        party: 'Republican',
        photo_url: null,
        trade_count: 2,
        est_volume: 120_000,
      },
    ],
    cohort: [
      { tx_date: '2026-01-05' },
      { tx_date: '2026-01-12' },
      { tx_date: '2026-01-20' },
      { tx_date: '2026-02-02' },
      { tx_date: '2026-02-10' },
      { tx_date: '2026-02-18' },
    ],
    priceEod: priceSeries(100, 400, 0.001),
    spxEod: priceSeries(5_000, 400, 0.0005),
    ...over,
  };
}

interface TickerBody {
  ticker: string;
  summary: { totalTrades: number };
  items: unknown[];
  total?: number;
  analytics?: {
    window: string;
    granularity: string;
    estimatedAmounts: boolean;
    summary: {
      totalTrades: number;
      buyCount: number;
      sellCount: number;
      memberCount: number;
      estVolumeUsd: number;
      estNetFlowUsd: number;
      netSentiment: number | null;
    };
    series: Array<{ period: string | null; buys: number; sells: number; estBuyVolUsd: number }>;
    topBuyers: Array<{ filerId: string | null; fullName: string | null; partyBucket: string | null; photoUrl: string | null; estVolumeUsd: number }>;
    topSellers: Array<{ filerId: string | null; partyBucket: string | null }>;
    backtest: {
      totalBuyEvents: number;
      pricedDays: number;
      minN: number;
      horizons: Array<{ days: number; n: number; medianReturn: number | null; medianExcess: number | null }>;
    };
  } | null;
}

async function getTicker(fx: Fixture, query = ''): Promise<{ status: number; body: TickerBody }> {
  const { env } = makeEnv(fx);
  const app = buildClientRouter();
  const res = await app.request(`http://localhost/ticker/AAPL${query}`, {}, env);
  return { status: res.status, body: (await res.json()) as TickerBody };
}

describe('GET /api/client/v1/ticker/:ticker — company-drawer analytics', () => {
  it('omits the analytics key entirely when the caller does not opt in', async () => {
    const { status, body } = await getTicker(fixture());
    expect(status).toBe(200);
    // Not `analytics: null` — the key must be ABSENT, so a decoder written
    // against today's envelope sees exactly the bytes it sees today.
    expect(Object.prototype.hasOwnProperty.call(body, 'analytics')).toBe(false);
    expect(body.ticker).toBe('AAPL');
    expect(body.items).toHaveLength(1);
  });

  it('serves buy pressure, the time series, top traders and the backtest on include=analytics', async () => {
    const { status, body } = await getTicker(fixture(), '?include=analytics');
    expect(status).toBe(200);
    const a = body.analytics;
    expect(a).toBeTruthy();
    if (!a) return;

    // The trade list this endpoint primarily serves is untouched by the block.
    expect(body.items).toHaveLength(1);

    // Buy pressure = buys / (buys + sells), computed server-side so no client
    // re-derives it (9 / 12).
    expect(a.summary.netSentiment).toBeCloseTo(0.75, 10);
    expect(a.summary.buyCount).toBe(9);
    expect(a.summary.sellCount).toBe(3);
    expect(a.summary.memberCount).toBe(7);
    // Dollar figures are whole-dollar estimates (bracket midpoints).
    expect(a.summary.estVolumeUsd).toBe(1_234_567);
    expect(a.summary.estNetFlowUsd).toBe(987_655);
    expect(a.estimatedAmounts).toBe(true);

    // The windowed analytics summary is DISTINCT from the envelope's all-time
    // `summary`, which keeps its existing meaning for older decoders.
    expect(body.summary.totalTrades).toBe(1);
    expect(a.summary.totalTrades).toBe(12);

    expect(a.series.map((p) => p.period)).toEqual(['2026-01', '2026-02']);
    expect(a.series[0]).toMatchObject({ buys: 4, sells: 1, estBuyVolUsd: 400_000 });

    // Top traders arrive phone-shaped: cleaned name, bucketed party, photo.
    expect(a.topBuyers).toHaveLength(1);
    expect(a.topBuyers[0]).toMatchObject({
      filerId: 'P000197',
      partyBucket: 'D',
      photoUrl: 'https://example.test/p.jpg',
      estVolumeUsd: 800_000,
    });
    expect(a.topBuyers[0].fullName).not.toMatch(/Hon\./);
    expect(a.topSellers[0]).toMatchObject({ filerId: 'G000596', partyBucket: 'R' });

    // "Performance After Buys": all four default horizons, coverage disclosed.
    expect(a.backtest.horizons.map((h) => h.days)).toEqual([21, 63, 126, 252]);
    expect(a.backtest.totalBuyEvents).toBe(6);
    expect(a.backtest.pricedDays).toBe(400);
    expect(a.backtest.minN).toBe(5);
    const h21 = a.backtest.horizons[0];
    expect(h21.n).toBe(6);
    // Ticker drifts +0.1%/day vs SPX +0.05%/day, so 21 days of excess is positive.
    expect(h21.medianReturn).toBeGreaterThan(0);
    expect(h21.medianExcess).toBeGreaterThan(0);
  });

  it('reports null stats for a horizon that lacks forward price history', async () => {
    // 80 priced days: every cohort date can be scored at 21 days, none at
    // 126/252. Those long horizons must say "no number", never a fabricated
    // one derived from the short window that happens to exist.
    const { body } = await getTicker(
      fixture({ priceEod: priceSeries(100, 80, 0.001), spxEod: priceSeries(5_000, 80, 0.0005) }),
      '?include=analytics',
    );
    const horizons = body.analytics?.backtest.horizons ?? [];
    expect(horizons.find((h) => h.days === 21)?.n).toBe(6);
    expect(horizons.find((h) => h.days === 21)?.medianReturn).toBeGreaterThan(0);
    for (const days of [126, 252]) {
      const h = horizons.find((x) => x.days === days);
      expect(h?.n).toBe(0);
      expect(h?.medianReturn).toBeNull();
      expect(h?.medianExcess).toBeNull();
    }
    // `totalBuyEvents` stays the full cohort at every horizon, so the client
    // can render "6 buys, 0 scored at 252d" rather than implying zero buys.
    expect(body.analytics?.backtest.totalBuyEvents).toBe(6);
  });

  it('withholds stats below the small-sample floor instead of publishing them', async () => {
    // 4 buy events < BACKTEST_MIN_N (5): n is reported honestly, the derived
    // statistics are null.
    const { body } = await getTicker(
      fixture({
        cohort: [
          { tx_date: '2026-01-05' },
          { tx_date: '2026-01-12' },
          { tx_date: '2026-01-20' },
          { tx_date: '2026-02-02' },
        ],
      }),
      '?include=analytics',
    );
    const h21 = body.analytics?.backtest.horizons.find((h) => h.days === 21);
    expect(h21?.n).toBe(4);
    expect(h21?.medianReturn).toBeNull();
    expect(h21?.medianExcess).toBeNull();
  });

  it('degrades analytics to null without losing the trade list when a query fails', async () => {
    const { status, body } = await getTicker(fixture({ failOn: 'series' }), '?include=analytics');
    expect(status).toBe(200);
    // The key is PRESENT and null — "unavailable right now", which the client
    // must not read as "no activity".
    expect(Object.prototype.hasOwnProperty.call(body, 'analytics')).toBe(true);
    expect(body.analytics).toBeNull();
    expect(body.items).toHaveLength(1);
    expect(body.summary.totalTrades).toBe(1);
  });

  it('treats include= as a CSV token list and ignores unknown tokens', async () => {
    const withAnalytics = await getTicker(fixture(), '?include=asset,analytics');
    expect(withAnalytics.body.analytics).toBeTruthy();

    const unknownOnly = await getTicker(fixture(), '?include=asset,summary');
    expect(Object.prototype.hasOwnProperty.call(unknownOnly.body, 'analytics')).toBe(false);
  });

  it('honors the window param and derives a granularity for it', async () => {
    // Window vocabulary is the analytics layer's own: `all`, `<N>d`,
    // `this_cy`, `last_cy`. There is no `1y` token — it falls back to the
    // route default rather than erroring, so a client that invents one gets
    // all-time data silently. Pinned here because that is a real footgun for
    // a client author reading "window" and typing a year.
    const oneYear = await getTicker(fixture(), '?include=analytics&window=365d');
    expect(oneYear.body.analytics?.window).toBe('365d');
    expect(oneYear.body.analytics?.granularity).toBe('month');

    const short = await getTicker(fixture(), '?include=analytics&window=30d');
    expect(short.body.analytics?.granularity).toBe('day');

    const explicit = await getTicker(fixture(), '?include=analytics&window=365d&granularity=week');
    expect(explicit.body.analytics?.granularity).toBe('week');

    const bogus = await getTicker(fixture(), '?include=analytics&window=1y');
    expect(bogus.body.analytics?.window).toBe('all');
  });

  it('serves a second identical request from the KV cache rather than re-querying', async () => {
    const { env, seen } = makeEnv(fixture());
    const app = buildClientRouter();
    const url = 'http://localhost/ticker/AAPL?include=analytics';
    await app.request(url, {}, env);
    const afterFirst = seen.filter((s) => /strftime\(\?, t\.tx_date\) AS period/i.test(s)).length;
    await app.request(url, {}, env);
    const afterSecond = seen.filter((s) => /strftime\(\?, t\.tx_date\) AS period/i.test(s)).length;
    expect(afterFirst).toBe(1);
    // The whole analytics block is cached under one key, so the second read
    // pays for the trade list only — the drawer's expensive leg runs once.
    expect(afterSecond).toBe(1);
  });
});
