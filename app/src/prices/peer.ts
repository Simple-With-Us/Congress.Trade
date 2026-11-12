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
 *
 * Every request carries a deadline (PEER_PRICE_REQUEST_TIMEOUT_MS) composed
 * with the caller's AbortSignal, so a hanging peer response is cancelled
 * in-flight instead of outliving the caller's lane deadline as a zombie.
 */

import { z } from 'zod';
import type { Close } from './compute.ts';
import type { PriceClient } from './types.ts';
import { trackedFetch } from '../shared/thirdPartyTelemetry.ts';

/** Untrusted ST 502 JSON body (strict mode stale signal). */
const peerStale502BodySchema = z.object({
  ok: z.boolean().optional(),
  error: z.string().optional(),
  closes: z.unknown().optional(),
});

/** Thrown in strict mode when ST answers `{ error: "stale" }` (usually HTTP 502). */
export class PeerStaleResponseError extends Error {
  readonly closes: Close[];
  constructor(closes: Close[]) {
    super('PEER_STALE_RESPONSE');
    this.name = 'PeerStaleResponseError';
    this.closes = closes;
  }
}

/** Plain-error stale signal (e.g. rethrown across a module boundary): closes must pass zod. */
const peerStalePlainErrorSchema = z.object({
  message: z.literal('PEER_STALE_RESPONSE'),
  closes: z.array(
    z.object({
      date: z.string(),
      close: z.number().finite().positive(),
    }),
  ),
});

/**
 * Single source of truth for the stale-response signal.  Returns the validated
 * closes for a PeerStaleResponseError (already filtered at construction) or a
 * plain error whose `closes` pass zod; null for anything else.
 */
export function readPeerStaleCloses(e: unknown): Close[] | null {
  if (e instanceof PeerStaleResponseError) return e.closes;
  if (typeof e !== 'object' || e === null) return null;
  const parsed = peerStalePlainErrorSchema.safeParse({
    message: (e as { message?: unknown }).message,
    closes: (e as { closes?: unknown }).closes,
  });
  return parsed.success ? parsed.data.closes : null;
}

export function isPeerStaleResponseError(e: unknown): e is PeerStaleResponseError {
  return readPeerStaleCloses(e) !== null;
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

/**
 * Per-request deadline for one peer price call.  A cold Socratic.Trade
 * history fetch takes ~10s and an unknown symbol ~30s, so 45s leaves margin
 * over every healthy response — but it bounds a HANGING response, which
 * previously had no bound at all:  one stuck fetch held its catch-up worker
 * forever, the lane deadline aborted around it, and the run's inner promise
 * never settled (the zombie that kept the lane's state write from landing
 * and gated later fires).  A timed-out request surfaces as PEER_HTTP_0
 * (provider-level, like a network failure), so the ticker is deferred to a
 * later run instead of wedging this one.
 */
export const PEER_PRICE_REQUEST_TIMEOUT_MS = 45_000;

export interface PeerPriceClientOptions {
  /**
   * When true, non-2xx (except 404) and network failures throw PEER_HTTP_* so a
   * peer-only price plan does not look like "no data". Soft mode (default)
   * returns [] so a secondary provider can fall through.
   */
  strict?: boolean;
  /** Per-request deadline override (tests, or a caller with a tighter budget). */
  timeoutMs?: number;
  /**
   * Client-level cancellation, combined with the per-request timeout and
   * any per-call signal:  aborting it cancels the in-flight fetch.  Callers
   * that rebuild the client per run (the price lanes) pass their lane
   * signal per call instead;  this covers long-lived clients.
   */
  signal?: AbortSignal;
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
    callSignal?: AbortSignal,
  ): Promise<Close[]> {
    // One deadline per request, composed with the caller's cancellation
    // (per-call signal first, then the client-level one).  The timer aborts
    // the underlying fetch — headers AND body — so a peer that accepts the
    // connection and then stalls cannot hold the caller past the deadline.
    const timeoutMs = opts.timeoutMs ?? PEER_PRICE_REQUEST_TIMEOUT_MS;
    const deadline = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      deadline.abort(new Error('PEER_REQUEST_TIMEOUT'));
    }, timeoutMs);
    const parts: AbortSignal[] = [deadline.signal];
    if (callSignal) parts.push(callSignal);
    if (opts.signal) parts.push(opts.signal);
    const signal = parts.length === 1 ? parts[0] : AbortSignal.any(parts);
    // The caller's own cancellation is not a peer failure:  rethrow its
    // reason untouched so lanes see the abort they issued (and walkers can
    // tell it apart from a PEER_HTTP_* outcome) instead of a wrapped error.
    const callerAbortReason = (): unknown => {
      if (timedOut) return undefined;
      if (callSignal?.aborted) return callSignal.reason;
      if (opts.signal?.aborted) return opts.signal.reason;
      return undefined;
    };
    try {
      const res = await trackedFetch(url, {
        headers,
        signal,
      }, { service: 'market-prices', operation, dynamicTarget: 'peer-app' }, fetchImpl);
      if (res.status === 404) return [];
      if (!res.ok) {
        if (strict && res.status === 502) {
          try {
            const json: unknown = await res.json();
            const parsed = peerStale502BodySchema.safeParse(json);
            if (parsed.success && parsed.data.error === 'stale') {
              throw new PeerStaleResponseError(descending(parsePeerCloses(parsed.data.closes)));
            }
          } catch (e) {
            if (isPeerStaleResponseError(e)) throw e;
            const reason = callerAbortReason();
            if (reason !== undefined) throw reason;
            if (timedOut) throw new Error(`PEER_HTTP_0:PEER_REQUEST_TIMEOUT after ${timeoutMs}ms`);
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
      const reason = callerAbortReason();
      if (reason !== undefined) throw reason;
      if (strict) {
        if (timedOut) throw new Error(`PEER_HTTP_0:PEER_REQUEST_TIMEOUT after ${timeoutMs}ms`);
        const msg = e instanceof Error ? e.message : String(e ?? 'network');
        throw new Error(`PEER_HTTP_0:${msg.slice(0, 80)}`);
      }
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  async function eodHistory(symbol: string, from: string, to: string, signal?: AbortSignal): Promise<Close[]> {
    const normalizedSymbol = symbol.trim().toUpperCase();
    const url = `${origin}/api/market/prices/${encodeURIComponent(normalizedSymbol)}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    return descending(await getCloses(url, 'fetch-peer-price-history', signal));
  }

  async function spxHistory(from: string, to: string, signal?: AbortSignal): Promise<Close[]> {
    const url = `${origin}/api/market/spx?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    return descending(await getCloses(url, 'fetch-peer-spx-history', signal));
  }

  return { eodHistory, spxHistory };
}
