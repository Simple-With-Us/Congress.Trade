/**
 * src/prices/peerMarketData.ts
 * OWNER: prices
 *
 * Realtime quotes + intraday bars for latency-snapshot capture, fetched from
 * the sibling app's token-gated /api/market/quotes and /api/market/intraday
 * routes (the same APP_B_INGEST_TOKEN bearer peer.ts already uses for EOD
 * closes).
 *
 * This is a DIFFERENT client from peer.ts on purpose. peer.ts answers "what
 * did this ticker close at on date D" — end-of-day history for enrichment.
 * This module answers two much narrower, instant-level questions the
 * latency-snapshot pipeline needs:
 *
 *   fetchPeerRealtimeQuotes — "what is it trading at right now" (live capture,
 *                              only ever valid for a due_at within a few
 *                              minutes of now).
 *   fetchPeerIntradayBars   — "what was it trading at 14:43 last Tuesday"
 *                              (backfill, for a due_at already in the past).
 *
 * Backfill is the important one. Snapshots are scheduled from already-matched
 * candidates, so due_at is very often already in the past by the time a row
 * exists — a live quote can never honestly answer that; stamping "now" onto a
 * past event fabricates the measurement. Minute bars answer it exactly.
 *
 * The peer's intraday route distinguishes a genuinely empty range (weekend,
 * halt, pre-listing — HTTP 200 with bars: []) from a provider failure
 * (credential miss, timeout, upstream error — any non-200 status). Collapsing
 * that distinction into a single "no price" outcome is the exact bug that
 * blanked the pipeline this module replaces, so PeerIntradayResult keeps the
 * two cases structurally separate and callers must branch on `kind`, never on
 * whether `bars` happens to be empty.
 */

import { trackedFetch } from '../shared/thirdPartyTelemetry.ts';

export interface PeerRealtimeQuote {
  price: number;
  source: string;
  at?: string;
}

interface RawPeerQuote {
  price?: unknown;
  source?: unknown;
  at?: unknown;
  delayed?: unknown;
}

function peerHeaders(authToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'user-agent': 'congress.trade/0.1 (+https://congress.trade) PeerMarketData',
    accept: 'application/json',
  };
  if (authToken) headers['authorization'] = `Bearer ${authToken}`;
  return headers;
}

/**
 * Batch real-time quotes for every ticker due for a LIVE capture right now.
 * Never requests delayed quotes — `allowDelayed` is intentionally omitted
 * from the request, since a ~15-minute-stale price answering "what is it
 * trading at right now" would be indistinguishable from a fresh one once
 * written down. A ticker the peer cannot price (or can only price with a
 * delayed quote) is simply absent from the returned map — never zero-filled,
 * never substituted.
 */
export async function fetchPeerRealtimeQuotes(
  baseUrl: string | undefined,
  tickers: string[],
  authToken: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, PeerRealtimeQuote>> {
  const symbols = Array.from(new Set(tickers.map((t) => t.trim().toUpperCase()).filter(Boolean)));
  if (!baseUrl || !symbols.length) return {};
  let origin: string;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    return {};
  }
  const url = `${origin}/api/market/quotes?symbols=${encodeURIComponent(symbols.join(','))}`;
  try {
    const res = await trackedFetch(
      url,
      { headers: peerHeaders(authToken) },
      { service: 'market-prices', operation: 'fetch-peer-realtime-quotes', dynamicTarget: 'peer-app' },
      fetchImpl,
    );
    if (!res.ok) return {};
    const data = (await res.json()) as { quotes?: Record<string, RawPeerQuote> };
    const out: Record<string, PeerRealtimeQuote> = {};
    for (const [symbol, q] of Object.entries(data.quotes ?? {})) {
      if (!q || q.delayed === true) continue;
      const price = typeof q.price === 'number' && Number.isFinite(q.price) && q.price > 0 ? q.price : null;
      if (price == null) continue;
      out[symbol] = {
        price,
        source: typeof q.source === 'string' && q.source ? q.source : 'peer-realtime',
        at: typeof q.at === 'string' ? q.at : undefined,
      };
    }
    return out;
  } catch {
    return {};
  }
}

export interface PeerIntradayBar {
  t: string;
  o?: number;
  h?: number;
  l?: number;
  c: number;
  v?: number;
}

export type PeerIntradayResult =
  | { kind: 'ok'; bars: PeerIntradayBar[] }
  | { kind: 'unavailable'; status: number | null };

/**
 * Historical intraday bars for one ticker/range. HTTP 200 means the peer
 * actually answered the question — `bars` may legitimately be empty (a
 * confirmed-quiet range: weekend, halt, pre-listing). Anything else (non-200,
 * network failure, malformed body) means the question was never answered and
 * MUST be retried, never recorded as "no trading happened" — see the module
 * header.
 */
export async function fetchPeerIntradayBars(
  baseUrl: string | undefined,
  ticker: string,
  startIso: string,
  endIso: string,
  authToken: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<PeerIntradayResult> {
  const symbol = ticker.trim().toUpperCase();
  if (!baseUrl || !symbol) return { kind: 'unavailable', status: null };
  let origin: string;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    return { kind: 'unavailable', status: null };
  }
  const url =
    `${origin}/api/market/intraday/${encodeURIComponent(symbol)}` +
    `?start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}&timeframe=1Min`;
  try {
    const res = await trackedFetch(
      url,
      { headers: peerHeaders(authToken) },
      { service: 'market-prices', operation: 'fetch-peer-intraday-bars', dynamicTarget: 'peer-app' },
      fetchImpl,
    );
    if (res.status !== 200) return { kind: 'unavailable', status: res.status };
    const data = (await res.json()) as { bars?: unknown };
    const bars = Array.isArray(data.bars) ? (data.bars as PeerIntradayBar[]) : [];
    return { kind: 'ok', bars };
  } catch {
    return { kind: 'unavailable', status: null };
  }
}

/**
 * Nearest bar at-or-after `atIso`, within `toleranceMin`. NEVER an earlier
 * bar, even one numerically closer in time than a valid later bar — a bar
 * from before the due instant would understate the exact latency gap this
 * pipeline exists to measure. Mirrors Socratic.Trade's
 * src/lib/market-realtime.ts `barAt()` line-for-line; keep both in sync if
 * either changes.
 */
export function nearestBarAtOrAfter(
  bars: PeerIntradayBar[],
  atIso: string,
  toleranceMin = 5,
): PeerIntradayBar | null {
  const target = Date.parse(atIso);
  if (!Number.isFinite(target)) return null;
  const limit = target + toleranceMin * 60_000;
  let best: PeerIntradayBar | null = null;
  let bestT = Infinity;
  for (const b of bars) {
    const t = Date.parse(b.t);
    if (!Number.isFinite(t) || t < target || t > limit) continue;
    // Validate the close HERE rather than trusting the peer. Socratic.Trade does currently
    // guarantee a positive finite close, but this module declares the invariant locally while
    // enforcing it remotely - and a bar with a null/absent `c` would reach writeCaptured as
    // price=null with error=null, i.e. a row marked captured that holds no price and no reason.
    // That is precisely the state this pipeline's own invariant forbids, and it would be counted
    // as a successful capture. Cheap to close; expensive to discover later.
    if (typeof b.c !== 'number' || !Number.isFinite(b.c) || b.c <= 0) continue;
    if (t < bestT) {
      bestT = t;
      best = b;
    }
  }
  return best;
}
