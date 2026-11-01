/**
 * src/prices/peer.ts
 * OWNER: prices
 *
 * Peer price client (cache-aside). Hits the public /api/market/* endpoints of a
 * sibling app (e.g. Socratic.Trade) to pull prices it already fetched.
 *
 * Modes:
 *  - soft (default): empty / non-2xx / network → [] so a secondary client can
 *    take over (legacy peer-first fallback stack).
 *  - strict: peer-primary (PRICE_PROVIDER=peer). Auth/plan failures throw
 *    PEER_HTTP_<status> so the refresh run aborts visibly instead of silently
 *    spending the shared Massive key. Empty series still returns [] (ticker
 *    simply has no history on the peer; last-resort Massive may then run).
 */

import type { Close } from './compute.ts';
import type { PriceClient } from './types.ts';
import { trackedFetch } from '../shared/thirdPartyTelemetry.ts';

/** Thrown in strict mode when ST answers `{ error: "stale" }` (usually HTTP 502). */
export class PeerStaleResponseError extends Error {
  readonly closes: Close[];
  constructor(closes: Close[]) {
    super('PEER_STALE_RESPONSE');
    this.name = 'PeerStaleResponseError';
    this.closes = closes;
  }
}

export function isPeerStaleResponseError(e: unknown): e is PeerStaleResponseError {
  if (e instanceof PeerStaleResponseError) return true;
  if (typeof e !== 'object' || e === null) return false;
  const err = e as { message?: unknown; closes?: unknown };
  return err.message === 'PEER_STALE_RESPONSE' && Array.isArray(err.closes);
}

function parsePeerCloses(raw: unknown): Close[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (c): c is Close =>
      Boolean(c) &&
      typeof c.date === 'string' &&
      typeof c.close === 'number' &&
      Number.isFinite(c.close) &&
      c.close > 0,
  );
}

export interface PeerPriceClientOptions {
  /**
   * When true, non-2xx (except 404) and network failures throw PEER_HTTP_* so a
   * peer-only price plan does not look like "no data". Soft mode (default)
   * returns [] so a secondary provider can fall through.
   */
  strict?: boolean;
}

/**
 * Builds a PriceClient that fetches from a peer's REST API.
 */
export function buildPeerPriceClient(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  authToken?: string,
  opts: PeerPriceClientOptions = {},
): PriceClient {
  const origin = new URL(baseUrl).origin;
  const strict = opts.strict === true;
  // The peer's read endpoints are bearer-gated; send the same token we already
  // push with (APP_B_INGEST_TOKEN). Omitted entirely when unset so the client
  // stays usable against an open peer.
  const headers: Record<string, string> = {
    'user-agent': 'congress.trade/0.1 (+https://congress.trade) PeerClient',
    'accept': 'application/json',
  };
  if (authToken) headers['authorization'] = `Bearer ${authToken}`;

  /** Normalize to date-descending so service.ts can treat closes[0] as latest
   *  even if a peer revision ships ascending bars. */
  function descending(closes: Close[]): Close[] {
    if (closes.length < 2) return closes;
    const out = closes.slice();
    out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    return out;
  }

  async function getCloses(
    url: string,
    operation: 'fetch-peer-price-history' | 'fetch-peer-spx-history',
  ): Promise<Close[]> {
    try {
      const res = await trackedFetch(url, {
        headers,
      }, { service: 'market-prices', operation, dynamicTarget: 'peer-app' }, fetchImpl);
      if (res.status === 404) return [];
      if (!res.ok) {
        if (strict && res.status === 502) {
          try {
            const data = await res.json() as { ok?: boolean; error?: string; closes?: unknown };
            if (data?.error === 'stale') {
              throw new PeerStaleResponseError(descending(parsePeerCloses(data.closes)));
            }
          } catch (e) {
            if (isPeerStaleResponseError(e)) throw e;
          }
        }
        if (strict) throw new Error(`PEER_HTTP_${res.status}`);
        return [];
      }
      const data = await res.json() as { closes?: Close[] };
      const rawCloses = Array.isArray(data?.closes) ? data.closes : [];
      return rawCloses.filter(
        (c): c is Close =>
          Boolean(c) &&
          typeof c.date === 'string' &&
          typeof c.close === 'number' &&
          Number.isFinite(c.close) &&
          c.close > 0,
      );
    } catch (e) {
      if (isPeerStaleResponseError(e)) throw e;
      if (e instanceof Error && e.message.startsWith('PEER_HTTP_')) throw e;
      if (strict) {
        const msg = e instanceof Error ? e.message : String(e ?? 'network');
        throw new Error(`PEER_HTTP_0:${msg.slice(0, 80)}`);
      }
      return [];
    }
  }

  async function eodHistory(symbol: string, from: string, to: string): Promise<Close[]> {
    const normalizedSymbol = symbol.trim().toUpperCase();
    const url = `${origin}/api/market/prices/${encodeURIComponent(normalizedSymbol)}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    return descending(await getCloses(url, 'fetch-peer-price-history'));
  }

  async function spxHistory(from: string, to: string): Promise<Close[]> {
    const url = `${origin}/api/market/spx?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    return descending(await getCloses(url, 'fetch-peer-spx-history'));
  }

  return { eodHistory, spxHistory };
}
