/**
 * src/client/__tests__/feedAmountFilter.test.ts
 *
 * Pins the `$` amount bounds on `GET /api/client/v1/feed`.
 *
 * The property that matters is NOT that the page is narrowed — a client could
 * do that itself — but that `total` is recomputed under the SAME predicate.
 * A client-side amount filter would leave `total` reporting the unfiltered
 * corpus, so "Page 1 of 1,788" would sit above three visible rows. Same
 * reasoning as the asset-class and chamber filters: any filter that changes
 * what the user sees must also change the count the user is shown.
 *
 * Both bounds compare against `transactions.amount_min` — the disclosed STOCK
 * Act bracket FLOOR, not a true trade value (no such value is disclosed).
 * `maxAmount=50000` therefore means "brackets that START at or below $50,000",
 * which is why the ladder-aligned bracket floors are the only sensible inputs.
 * That semantic is pinned below because it is easy to misread as a cap on the
 * trade's worth.
 */

import { describe, expect, it } from 'vitest';
import { buildClientRouter } from '../routes.ts';
import type { Env } from '../../shared/types.ts';

type Row = Record<string, unknown>;

/** The STOCK Act bracket ladder, as the web Delivery filter enumerates it. */
const BRACKETS: Array<[number, number | null]> = [
  [1_001, 15_000],
  [15_001, 50_000],
  [50_001, 100_000],
  [100_001, 250_000],
  [250_001, 500_000],
];

function tradeRow(i: number, amountMin: number, amountMax: number | null): Row {
  return {
    id: `tx_${i}`,
    doc_id: `H-2026-${i}`,
    filer_id: 'P000197',
    tx_date: '2026-03-02',
    owner: 'self',
    asset_name: 'Apple Inc',
    ticker: 'AAPL',
    asset_type: 'ST',
    tx_type: 'B',
    amount_min: amountMin,
    amount_max: amountMax,
    is_option: 0,
    cap_gains_over_200: 0,
    raw_text: null,
    confidence: 0.95,
    source: 'primary',
    row_key: `v1:primary:0:t${i}`,
    created_at: '2026-03-05T00:00:00.000Z',
    cursor_seq: 100 + i,
    est_value: amountMax == null ? amountMin : Math.round((amountMin + amountMax) / 2),
    filer_full_name: 'Nancy Pelosi',
    filer_state: 'CA',
    filer_photo_url: null,
    filing_filed_date: '2026-03-04',
    filing_first_seen_at: '2026-03-05T00:00:00.000Z',
    filing_source_url: 'https://example.test/1.pdf',
    __chamber: 'house',
    __member_name: 'Nancy Pelosi',
    __party: 'Democrat',
  };
}

/**
 * Three rows per bracket, so a `limit` smaller than the match set proves
 * `total` is a server-side COUNT rather than the page length.
 */
const CORPUS: Row[] = BRACKETS.flatMap(([lo, hi], b) =>
  [0, 1, 2].map((k) => tradeRow(b * 3 + k, lo, hi)),
);

function makeEnv(corpus: Row[]): Env {
  const kv = new Map<string, string>();

  /**
   * Applies the amount predicates the way buildTxFilters emits them. Params
   * must be consumed in emission order: the page query leads with the
   * `t.cursor_seq > ?` bind (includeCursor), the COUNT query does not — so the
   * amount binds sit at different offsets in the two statements.
   */
  const applyAmounts = (sql: string, params: unknown[]) => {
    let rows = [...corpus];
    let i = 0;
    if (/t\.cursor_seq > \?/i.test(sql)) i += 1;
    if (/t\.ticker = \?/i.test(sql)) i += 1;
    if (/t\.amount_min >= \?/i.test(sql)) {
      const min = Number(params[i++]);
      rows = rows.filter((r) => Number(r.amount_min) >= min);
    }
    if (/t\.amount_min <= \?/i.test(sql)) {
      const max = Number(params[i++]);
      rows = rows.filter((r) => Number(r.amount_min) <= max);
    }
    return rows;
  };

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
      const matched = applyAmounts(sql, this.params);
      if (/COUNT\(\*\) AS total(?:\s|,|$)/i.test(sql)) {
        return { results: [{ total: matched.length } as T] };
      }
      if (/FROM transactions t/i.test(sql) || /FROM \(/i.test(sql)) {
        // Page LIMIT is last; an earlier LIMIT is the cheap twin-candidate window (#2062).
        // The latency join's LIMIT 1 is not the page size.
        const pageSql = sql.replace(/LEFT JOIN trade_latency_candidates[\s\S]*$/i, '');
        const limitMatches = [...pageSql.matchAll(/LIMIT\s+(\d+)/gi)];
        const limit = Number(limitMatches.at(-1)?.[1] ?? matched.length);
        const offset = Number(sql.match(/OFFSET\s+(\d+)/i)?.[1] ?? 0);
        const ordered = /DESC/i.test(sql)
          ? [...matched].sort((a, b) => Number(b.cursor_seq) - Number(a.cursor_seq))
          : [...matched].sort((a, b) => Number(a.cursor_seq) - Number(b.cursor_seq));
        return { results: ordered.slice(offset, offset + limit) as T[] };
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

interface FeedBody {
  items: Array<{ id: string; transaction: { amountMin: number | null; amountMax: number | null } }>;
  count: number;
  total?: number;
  limit: number;
}

async function feed(query: string, corpus: Row[] = CORPUS): Promise<FeedBody> {
  const app = buildClientRouter();
  const res = await app.request(`http://localhost/feed?${query}`, {}, makeEnv(corpus));
  expect(res.status).toBe(200);
  return (await res.json()) as FeedBody;
}

describe('GET /api/client/v1/feed — $ amount bounds', () => {
  it('narrows total, not just the page, so the count cannot lie', async () => {
    const all = await feed('limit=50');
    expect(all.total).toBe(15);

    // One bracket = 3 rows, but ask for a single row: `count` is the page,
    // `total` is the match set. A client-side filter could not produce this.
    const oneBracket = await feed('limit=1&minAmount=50001&maxAmount=50001');
    expect(oneBracket.count).toBe(1);
    expect(oneBracket.items).toHaveLength(1);
    expect(oneBracket.total).toBe(3);
  });

  it('applies minAmount alone as an inclusive floor', async () => {
    const res = await feed('limit=50&minAmount=100001');
    // 100,001–250,000 and 250,001–500,000 → 6 rows.
    expect(res.total).toBe(6);
    expect(res.items).toHaveLength(6);
    expect(res.items.every((i) => (i.transaction.amountMin ?? 0) >= 100_001)).toBe(true);
  });

  it('applies maxAmount alone as an inclusive ceiling on the bracket FLOOR', async () => {
    // Both bounds test `amount_min`. A bracket whose floor is 50,001 matches
    // maxAmount=50001 even though the bracket reaches $100,000 — the cap is on
    // where the bracket starts, because a trade's true value is never disclosed.
    const atFloor = await feed('limit=50&maxAmount=50001');
    expect(atFloor.total).toBe(9);
    expect(atFloor.items.some((i) => i.transaction.amountMax === 100_000)).toBe(true);

    // One dollar lower excludes that whole bracket.
    const belowFloor = await feed('limit=50&maxAmount=50000');
    expect(belowFloor.total).toBe(6);
    expect(belowFloor.items.every((i) => (i.transaction.amountMin ?? 0) <= 50_000)).toBe(true);
  });

  it('combines both bounds into a closed band on the bracket floor', async () => {
    const band = await feed('limit=50&minAmount=15001&maxAmount=100001');
    // Floors 15,001 / 50,001 / 100,001 → 9 rows.
    expect(band.total).toBe(9);
    expect(band.items).toHaveLength(9);
  });

  it('ignores absent, empty and negative bounds instead of erroring', async () => {
    for (const q of ['limit=50', 'limit=50&minAmount=', 'limit=50&minAmount=-5', 'limit=50&maxAmount=abc']) {
      const res = await feed(q);
      expect(res.total).toBe(15);
    }
  });

  it('returns an empty match set (not the whole corpus) for an inverted band', async () => {
    // min > max is unsatisfiable. It must come back empty with total 0 rather
    // than silently dropping one bound and showing everything.
    const res = await feed('limit=50&minAmount=250001&maxAmount=15000');
    expect(res.items).toHaveLength(0);
    expect(res.total).toBe(0);
  });
});
