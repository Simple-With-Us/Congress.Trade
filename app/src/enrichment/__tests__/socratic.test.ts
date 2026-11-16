/**
 * Socratic.Trade profile client. FMP is not on this path.
 */
import { describe, expect, it } from 'vitest';
import { buildSocraticProvider, parseSocraticProfile, SOCRATIC_PROFILE_PATH } from '../socratic.ts';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('parseSocraticProfile', () => {
  it('reads a ref envelope into a partial security ref', () => {
    const ref = parseSocraticProfile({
      ref: {
        symbol: 'aapl',
        name: 'Apple Inc.',
        sector: 'Technology',
        industry: 'Consumer Electronics',
        marketCap: 3.2e12,
        country: 'US',
        exchangeShortName: 'NASDAQ',
        isEtf: false,
      },
    });
    expect(ref).toMatchObject({
      companyName: 'Apple Inc.',
      sector: 'Technology',
      industry: 'Consumer Electronics',
      marketCap: 3.2e12,
      marketCapBucket: 'mega',
      country: 'US',
      exchangeShort: 'NASDAQ',
      assetClass: 'equity',
      source: 'socratic',
    });
  });

  it('returns null for an empty envelope', () => {
    expect(parseSocraticProfile({ ref: null })).toBeNull();
    expect(parseSocraticProfile({})).toBeNull();
  });
});

describe('buildSocraticProvider', () => {
  it('GETs /api/market/profile/{symbol} with the ingest bearer', async () => {
    const urls: string[] = [];
    const headersSeen: HeadersInit[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(input));
      headersSeen.push(init?.headers ?? {});
      return jsonResponse(200, {
        ref: { ticker: 'MSFT', companyName: 'Microsoft', sector: 'Technology', marketCap: 3e12 },
      });
    }) as typeof fetch;
    const provider = buildSocraticProvider('https://socratic.trade/api/admin/securities/import', 'peer-token', fetchImpl);
    const ref = await provider.fetchRef('msft');
    expect(urls).toEqual([`https://socratic.trade${SOCRATIC_PROFILE_PATH}MSFT`]);
    expect(headersSeen[0]).toMatchObject({ authorization: 'Bearer peer-token' });
    expect(ref?.companyName).toBe('Microsoft');
    expect(ref?.source).toBe('socratic');
  });

  it('treats an envelope 404 as an unknown symbol and keeps calling', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return jsonResponse(404, { ref: null });
    }) as typeof fetch;
    const provider = buildSocraticProvider('https://socratic.trade', 't', fetchImpl);
    expect(await provider.fetchRef('NOPE')).toBeNull();
    expect(await provider.fetchRef('ALSO')).toBeNull();
    expect(calls).toBe(2);
  });

  it('stops for the rest of the run when the profile surface is missing', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response('Cannot GET /api/market/profile/AAPL', { status: 404 });
    }) as typeof fetch;
    const provider = buildSocraticProvider('https://socratic.trade', 't', fetchImpl);
    expect(await provider.fetchRef('AAPL')).toBeNull();
    expect(await provider.fetchRef('MSFT')).toBeNull();
    expect(calls).toBe(1);
  });

  it('throws on auth and plan failures so the caller does not tombstone', async () => {
    const fetchImpl = (async () => jsonResponse(401, { ok: false })) as typeof fetch;
    const provider = buildSocraticProvider('https://socratic.trade', 't', fetchImpl);
    await expect(provider.fetchRef('AAPL')).rejects.toThrow('SOCRATIC_HTTP_401');
  });
});
