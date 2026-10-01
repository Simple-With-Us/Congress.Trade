/**
 * src/enrichment/socratic.ts
 * OWNER: enrichment
 *
 * Company profile enrichment from Socratic.Trade. Congress.Trade does not call
 * FMP (or Massive / Tiingo / Finnhub / Intrinio / Twelve Data) for profiles.
 *
 * Contract (token-gated, same bearer as /api/market/prices and /api/market/quotes):
 *   GET {APP_B_ORIGIN}/api/market/profile/{symbol}
 *   Authorization: Bearer APP_B_INGEST_TOKEN
 *   200 { "ref": SecurityRef-shaped object | null }
 *   404 { "ref": null }  — symbol unknown (keep asking other symbols)
 *   401/403              — token/plan failure; caller must not tombstone
 *
 * Socratic.Trade does not serve this route yet (live peer routes are prices,
 * spx, quotes, and intraday). A non-envelope 404 means the surface is missing:
 * this provider stops calling for the rest of the run instead of hammering ST,
 * and the enrichment chain falls through to SEC EDGAR for CIK/SIC only.
 */

import { marketCapBucket } from './compute.ts';
import type { EnrichmentProvider, SecurityRef } from './types.ts';
import { trackedFetch } from '../shared/thirdPartyTelemetry.ts';

export const SOCRATIC_PROFILE_PATH = '/api/market/profile/';

/** Berkshire-style share class as filed (`BRK/B`, `BF/B`).  Peer history is dotted (`BRK.B`). */
const SLASH_SHARE_CLASS = /^[A-Z]{1,5}\/[A-Z]$/;

/** Symbol shape the peer can be asked about.  Applied after the slash-to-dot alias. */
const TICKER_SHAPED = /^[A-Z][A-Z0-9.]{0,9}$/;

/**
 * Symbol to put on the peer profile URL.  `BRK/B` is requested as `BRK.B`
 * (dotted, not `BRK-B`).  The caller still stores the ref on the original ticker.
 */
export function peerProfileSymbol(ticker: string): string {
  const upper = ticker.trim().toUpperCase();
  if (SLASH_SHARE_CLASS.test(upper)) return upper.replace('/', '.');
  return upper;
}

/** True when the peer symbol (after the slash alias) is ticker-shaped. */
export function isTickerShapedSymbol(ticker: string): boolean {
  return TICKER_SHAPED.test(peerProfileSymbol(ticker));
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

/** Map a peer profile object onto a partial SecurityRef. Null when empty. */
export function parseSocraticProfile(json: unknown): Partial<SecurityRef> | null {
  if (!json || typeof json !== 'object') return null;
  const root = json as Record<string, unknown>;
  const raw = root.ref && typeof root.ref === 'object'
    ? root.ref as Record<string, unknown>
    : root.profile && typeof root.profile === 'object'
      ? root.profile as Record<string, unknown>
      : root;
  const ticker = str(raw.ticker) ?? str(raw.symbol);
  const companyName = str(raw.companyName) ?? str(raw.name);
  const sector = str(raw.sector);
  const industry = str(raw.industry);
  const mc = num(raw.marketCap) ?? num(raw.mktCap);
  if (!ticker && !companyName && !sector && !industry && mc == null) return null;
  const isEtf = bool(raw.isEtf);
  const isAdr = bool(raw.isAdr);
  const isFund = bool(raw.isFund);
  const assetClass = str(raw.assetClass)
    ?? (isEtf ? 'etf' : isAdr ? 'adr' : isFund ? 'fund' : companyName || sector ? 'equity' : null);
  const partial: Partial<SecurityRef> = {
    companyName,
    sector,
    industry,
    assetClass,
    country: str(raw.country),
    stateHq: str(raw.stateHq) ?? str(raw.state),
    stateOfIncorp: str(raw.stateOfIncorp),
    exchange: str(raw.exchange) ?? str(raw.exchangeFullName),
    exchangeShort: str(raw.exchangeShort) ?? str(raw.exchangeShortName),
    currency: str(raw.currency),
    marketCap: mc,
    marketCapBucket: marketCapBucket(mc),
    sharesOutstanding: num(raw.sharesOutstanding),
    ipoDate: str(raw.ipoDate),
    cik: str(raw.cik),
    sicCode: str(raw.sicCode),
    sicDescription: str(raw.sicDescription),
    source: 'socratic',
  };
  if (isEtf != null) partial.isEtf = isEtf;
  if (isAdr != null) partial.isAdr = isAdr;
  return partial;
}

function looksLikeProfileEnvelope(body: unknown): boolean {
  return !!body && typeof body === 'object' && ('ref' in (body as Record<string, unknown>) || 'profile' in (body as Record<string, unknown>));
}

export interface SocraticProviderOptions {
  /** When false, auth failures return null instead of throwing. Default true. */
  strictAuth?: boolean;
}

/**
 * Build the Socratic.Trade profile provider. `baseUrl` is APP_B_IMPORT_URL
 * (origin is used; a path on the import URL is ignored).
 */
export function buildSocraticProvider(
  baseUrl: string,
  authToken: string | undefined,
  fetchImpl: typeof fetch = fetch,
): EnrichmentProvider {
  let origin: string;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    origin = '';
  }
  let surfaceMissing = false;
  const headers: Record<string, string> = {
    'user-agent': 'congress.trade/0.1 (+https://congress.trade) SocraticProfile',
    accept: 'application/json',
  };
  if (authToken) headers.authorization = `Bearer ${authToken}`;

  return {
    name: 'socratic',
    async fetchRef(ticker: string): Promise<Partial<SecurityRef> | null> {
      const symbol = peerProfileSymbol(ticker);
      if (!origin || !symbol || surfaceMissing) return null;
      const url = `${origin}${SOCRATIC_PROFILE_PATH}${encodeURIComponent(symbol)}`;
      const res = await trackedFetch(url, { headers }, {
        service: 'security-enrichment',
        operation: 'fetch-socratic-profile',
        dynamicTarget: 'peer-app',
      }, fetchImpl);
      if (res.status === 401 || res.status === 402 || res.status === 403 || res.status === 429) {
        throw new Error(`SOCRATIC_HTTP_${res.status}`);
      }
      if (res.status === 404) {
        const body = await res.json().catch(() => null);
        if (looksLikeProfileEnvelope(body)) return parseSocraticProfile(body);
        surfaceMissing = true;
        return null;
      }
      if (!res.ok) {
        throw new Error(`SOCRATIC_HTTP_${res.status}`);
      }
      const body = await res.json().catch(() => null);
      return parseSocraticProfile(body);
    },
  };
}
