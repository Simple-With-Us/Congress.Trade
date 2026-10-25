/**
 * src/prices/massive.ts
 * OWNER: prices
 *
 * Massive (Polygon.io) price client — same {@link PriceClient} interface as the
 * FMP client, so the price service can use either (or both, as a fallback chain)
 * via the PRICE_PROVIDER setting. Uses the daily aggregates endpoint with
 * `adjusted=true` (split-adjusted closes). The S&P benchmark is fetched as SPY
 * (a plain equity), because Massive's index symbols (I:SPX) need a separate
 * Indices entitlement that the Stocks plan lacks.
 */

import type { Close } from './compute.ts';
import type { PriceClient } from './types.ts';
import { trackedFetch } from '../shared/thirdPartyTelemetry.ts';
import { with429Retries, type Retry429Options } from './retry429.ts';

/**
 * Parse a Massive/Polygon daily-aggs response into descending [{date, close}].
 * Shape: { results: [{ t: <ms epoch>, c: <close>, o,h,l,v,… }] }. `t` is the
 * start of the trading day; sliced to a UTC YYYY-MM-DD (correct for US sessions).
 */
export function parseMassiveAggs(json: unknown): Close[] {
  const arr =
    json && typeof json === 'object' && Array.isArray((json as { results?: unknown[] }).results)
      ? ((json as { results: unknown[] }).results as Array<{ t?: unknown; c?: unknown }>)
      : null;
  if (!arr) return [];
  const out: Close[] = [];
  for (const r of arr) {
    const date = typeof r.t === 'number' ? new Date(r.t).toISOString().slice(0, 10) : null;
    const close = typeof r.c === 'number' ? r.c : null;
    if (date && close != null) out.push({ date, close });
  }
  out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)); // descending
  return out;
}

const BASE = 'https://api.massive.com/v2/aggs/ticker/';

export function buildMassivePriceClient(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  retry: Retry429Options = {},
): PriceClient {
  async function aggs(symbol: string, from: string, to: string): Promise<Close[]> {
    const url =
      BASE +
      encodeURIComponent(symbol) +
      '/range/1/day/' +
      from +
      '/' +
      to +
      '?adjusted=true&sort=desc&limit=50000&apiKey=' +
      encodeURIComponent(apiKey);
    // 429s (shared-key per-minute limit) are retried with backoff first — see
    // ./retry429.ts. A 429 that still persists after the retries throws below.
    const res = await with429Retries(() => trackedFetch(url, {
      headers: { 'user-agent': 'congress.trade/0.1 (+https://congress.trade)', accept: 'application/json' },
    }, { service: 'market-prices', operation: 'fetch-price-history' }, fetchImpl), retry);
    if (!res.ok) {
      if (res.status === 404) return []; // symbol not found → genuinely no data (safe to negative-cache)
      // Auth/rate/server errors (401/403/429/5xx) fail identically for every
      // ticker — throw so the caller skips + retries rather than negative-caching
      // priceable tickers during a transient outage.
      throw new Error('MASSIVE_HTTP_' + res.status);
    }
    return parseMassiveAggs(await res.json());
  }
  return {
    eodHistory: (symbol, from, to) => aggs(symbol, from, to),
    spxHistory: (from, to) => aggs('SPY', from, to),
  };
}
