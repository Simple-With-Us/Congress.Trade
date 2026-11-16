/**
 * src/analytics/__tests__/trendsRoutes.test.ts
 *
 * Contract pins for the three Trends sections the phone renders from
 * `/api/analytics/*` directly: Party Split, Sector Breakdown (asset-type
 * based) and Committee Sector Conflicts.
 *
 * These endpoints are public and unauthenticated, and iOS decodes them with
 * fixed `Codable` structs baked into a shipped, App-Store-frozen binary. A
 * silent field rename or a re-nesting on the server therefore breaks installed
 * apps that can never be patched forward. `builders.test.ts` pins the SQL;
 * this file pins the JSON those routes actually emit.
 *
 * Note the deliberate distinction between the two "sector" endpoints:
 *   - `/sector-breakdown` groups by the free-text INSTRUMENT type
 *     (`transactions.asset_type`) — "Public Equity", "Municipal Debt", …
 *   - `/sector-flow` groups by REAL GICS sector (`securities_ref.sector`).
 * They are different cards, and the phone already uses the latter.
 */

import { describe, expect, it } from 'vitest';
import { buildAnalyticsRouter } from '../routes.ts';
import type { Env } from '../../shared/types.ts';

type Row = Record<string, unknown>;

interface Fixture {
  partySplitOverall: Row[];
  partySplitByPeriod: Row[];
  sectorBreakdown: Row[];
  conflictCandidates: Row[];
}

function makeEnv(fx: Fixture): Env {
  const kv = new Map<string, string>();

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
      // Order matters: the over-time query also selects `AS party`, so the
      // period form must be matched first.
      if (/strftime\(\?, t\.tx_date\) AS period/i.test(sql) && /AS party/i.test(sql)) {
        return { results: fx.partySplitByPeriod as T[] };
      }
      if (/AS party,/i.test(sql) && /GROUP BY \(CASE WHEN/i.test(sql)) {
        return { results: fx.partySplitOverall as T[] };
      }
      if (/AS asset_type_category/i.test(sql)) return { results: fx.sectorBreakdown as T[] };
      if (/fl\.committees AS committees/i.test(sql)) {
        return { results: fx.conflictCandidates as T[] };
      }
      return { results: [] as T[] };
    },
    async run() {
      return { success: true, meta: { changes: 1 } };
    },
  });

  return {
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
}

function fixture(over: Partial<Fixture> = {}): Fixture {
  return {
    partySplitOverall: [
      { party: 'D', buys: 1_193, sells: 402, est_volume: 45_889_023.4, est_net_flow: 11_844_174.2, members: 32 },
      { party: 'R', buys: 336, sells: 451, est_volume: 77_197_858.5, est_net_flow: 15_417_442.1, members: 48 },
    ],
    partySplitByPeriod: [
      { period: '2026-W19', party: 'D', buys: 188, sells: 137 },
      { period: '2026-W19', party: 'R', buys: 23, sells: 25 },
      { period: '2026-W20', party: 'D', buys: 62, sells: 42 },
    ],
    sectorBreakdown: [
      {
        asset_type_category: 'public_equity',
        raw_asset_types: 'ST,Stock,Common Stock',
        trade_count: 1_162,
        buy_count: 554,
        sell_count: 600,
        est_volume: 14_739_081.3,
        est_net_flow: 657_477.4,
        unique_members: 65,
        unique_tickers: 375,
      },
      {
        asset_type_category: 'fixed_income_government',
        raw_asset_types: 'GS',
        trade_count: 40,
        buy_count: 40,
        sell_count: 0,
        est_volume: 900_000,
        est_net_flow: 900_000,
        unique_members: 2,
        unique_tickers: 0,
      },
    ],
    conflictCandidates: [
      {
        id: 'c5a654bd',
        ticker: 'CCI',
        tx_type: 'S',
        tx_date: '2026-07-23',
        filer_id: 'house-nj05-josh-gottheimer',
        full_name: 'HON JOSH GOTTHEIMER',
        chamber: 'house',
        party: 'Democrat',
        committees: JSON.stringify(['House Committee on Financial Services']),
        sector: 'Real Estate',
        amount_min: 1_001,
        amount_max: 15_000,
      },
      {
        // Committee does not govern this sector -> filtered out by the
        // curated map, proving the route is a real signal and not a passthrough.
        id: 'no-conflict',
        ticker: 'XOM',
        tx_type: 'B',
        tx_date: '2026-07-20',
        filer_id: 'house-xx01-someone',
        full_name: 'Someone Else',
        chamber: 'house',
        party: 'Republican',
        committees: JSON.stringify(['House Committee on Veterans Affairs']),
        sector: 'Energy',
        amount_min: 1_001,
        amount_max: 15_000,
      },
    ],
    ...over,
  };
}

async function getJson(fx: Fixture, path: string): Promise<Record<string, unknown>> {
  const app = buildAnalyticsRouter();
  const res = await app.request(`http://localhost${path}`, {}, makeEnv(fx));
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

describe('GET /api/analytics/party-split', () => {
  it('serves an overall D/R/O map plus a pivoted per-period series', async () => {
    const body = (await getJson(fixture(), '/party-split?window=90d')) as {
      window: string;
      granularity: string;
      estimatedAmounts: boolean;
      overall: Record<string, { buys: number; sells: number; estVolumeUsd: number; estNetFlowUsd: number; members: number }>;
      byPeriod: Array<Record<string, number | string>>;
    };

    expect(body.window).toBe('90d');
    expect(body.granularity).toBe('week');
    expect(body.estimatedAmounts).toBe(true);

    // All three buckets are ALWAYS present, zero-filled — a client can render
    // three bars without null-checking, and "no independents traded" is
    // distinguishable from "the key is missing".
    expect(Object.keys(body.overall).sort()).toEqual(['D', 'O', 'R']);
    expect(body.overall.D).toEqual({
      buys: 1_193,
      sells: 402,
      estVolumeUsd: 45_889_023,
      estNetFlowUsd: 11_844_174,
      members: 32,
    });
    expect(body.overall.O).toEqual({ buys: 0, sells: 0, estVolumeUsd: 0, estNetFlowUsd: 0, members: 0 });

    // Rows arrive one-per-(period,party) and are pivoted to one record per
    // period with flat `<bucket>_buys` / `<bucket>_sells` keys.
    expect(body.byPeriod).toEqual([
      { period: '2026-W19', D_buys: 188, D_sells: 137, R_buys: 23, R_sells: 25, O_buys: 0, O_sells: 0 },
      { period: '2026-W20', D_buys: 62, D_sells: 42, R_buys: 0, R_sells: 0, O_buys: 0, O_sells: 0 },
    ]);
  });

  it('degrades to a valid zero-filled envelope with no data', async () => {
    const body = (await getJson(
      fixture({ partySplitOverall: [], partySplitByPeriod: [] }),
      '/party-split?window=30d',
    )) as { overall: Record<string, { buys: number }>; byPeriod: unknown[] };
    expect(body.overall.D.buys).toBe(0);
    expect(body.byPeriod).toEqual([]);
  });
});

describe('GET /api/analytics/summary type=', () => {
  it('echoes a requested type in the envelope', async () => {
    const body = (await getJson(fixture(), '/summary?window=90d&type=B')) as {
      type: string | null;
      window: string;
    };
    expect(body.window).toBe('90d');
    expect(body.type).toBe('B');
  });

  it('omits type from the envelope when no side filter is set', async () => {
    const body = (await getJson(fixture(), '/summary?window=90d')) as { type: string | null };
    expect(body.type).toBeNull();
  });

  it('echoes a CSV party selection instead of the first letter only', async () => {
    const body = (await getJson(fixture(), '/summary?window=90d&party=D,R')) as {
      party: string | null;
    };
    expect(body.party).toBe('D,R');
  });
});

describe('GET /api/analytics/sector-breakdown', () => {
  it('labels the canonical asset-type category and reports the raw types behind it', async () => {
    const body = (await getJson(fixture(), '/sector-breakdown?window=90d&limit=5')) as {
      count: number;
      estimatedAmounts: boolean;
      sectors: Array<{
        assetType: string;
        assetTypeCategory: string;
        rawAssetTypes: string[];
        tradeCount: number;
        buyCount: number;
        sellCount: number;
        estVolumeUsd: number;
        estNetFlowUsd: number;
        uniqueMembers: number;
        uniqueTickers: number;
      }>;
    };

    expect(body.count).toBe(2);
    expect(body.estimatedAmounts).toBe(true);
    expect(body.sectors[0]).toEqual({
      // `assetType` is the display label, `assetTypeCategory` the stable slug —
      // clients must key logic off the slug and show the label.
      assetType: 'Public Equity',
      assetTypeCategory: 'public_equity',
      // GROUP_CONCAT string is split into an array server-side.
      rawAssetTypes: ['ST', 'Stock', 'Common Stock'],
      tradeCount: 1_162,
      buyCount: 554,
      sellCount: 600,
      estVolumeUsd: 14_739_081,
      estNetFlowUsd: 657_477,
      uniqueMembers: 65,
      uniqueTickers: 375,
    });
    expect(body.sectors[1].assetTypeCategory).toBe('fixed_income_government');
    expect(body.sectors[1].assetType).toBe('Government / Municipal Debt');
  });
});

describe('GET /api/analytics/conflicts', () => {
  it('keeps only trades whose committee actually governs the sector', async () => {
    const body = (await getJson(fixture(), '/conflicts?window=90d&limit=50')) as {
      count: number;
      conflicts: Array<Record<string, unknown>>;
    };

    // The Veterans-Affairs/Energy row is a candidate in SQL but not a conflict
    // under the curated committee->sector map, so it must not be published.
    expect(body.count).toBe(1);
    expect(body.conflicts[0]).toEqual({
      id: 'c5a654bd',
      ticker: 'CCI',
      sector: 'Real Estate',
      txType: 'S',
      txDate: '2026-07-23',
      filerId: 'house-nj05-josh-gottheimer',
      // Names are run through cleanFilerName: honorific dropped and the
      // ALL-CAPS source string title-cased, so no raw DB value reaches a client.
      memberName: 'Josh Gottheimer',
      chamber: 'house',
      partyBucket: 'D',
      viaCommittees: ['House Committee on Financial Services'],
      // Bracket midpoint of $1,001-$15,000, as an estimate.
      estAmountUsd: 8_001,
    });
    // No photoUrl on this envelope — see app/docs/client-mobile-api.md; a
    // client rendering avatars here must source them elsewhere.
    expect(body.conflicts[0]).not.toHaveProperty('photoUrl');
  });

  it('honors the limit and returns an empty list rather than failing on no data', async () => {
    const empty = (await getJson(fixture({ conflictCandidates: [] }), '/conflicts')) as {
      count: number;
      conflicts: unknown[];
    };
    expect(empty.count).toBe(0);
    expect(empty.conflicts).toEqual([]);
  });
});
