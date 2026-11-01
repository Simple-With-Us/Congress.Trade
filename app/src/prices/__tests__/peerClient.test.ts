import { describe, it, expect } from 'vitest';
import { buildPeerPriceClient, isPeerStaleResponseError } from '../peer.ts';

const DUMMY_TOKEN = 'test-dummy-token';

/** Fetch mock that records each (url, init) call and replies 200 with closes. */
const recordingFetch = (calls: Array<{ url: string; init?: RequestInit }>) =>
  (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ closes: [{ date: '2024-01-02', close: 10 }] }), {
      status: 200,
    });
  }) as unknown as typeof fetch;

const headersOf = (init?: RequestInit) => (init?.headers ?? {}) as Record<string, string>;

describe('buildPeerPriceClient — bearer auth', () => {
  it('sends authorization: Bearer on the prices endpoint when a token is provided', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = buildPeerPriceClient('https://peer.example', recordingFetch(calls), DUMMY_TOKEN);
    const closes = await client.eodHistory('AAPL', '2024-01-01', '2024-02-01');
    expect(closes).toEqual([{ date: '2024-01-02', close: 10 }]);
    expect(calls).toHaveLength(1);
    expect(headersOf(calls[0].init)['authorization']).toBe(`Bearer ${DUMMY_TOKEN}`);
  });

  it('sends authorization: Bearer on the spx endpoint when a token is provided', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = buildPeerPriceClient('https://peer.example', recordingFetch(calls), DUMMY_TOKEN);
    await client.spxHistory('2024-01-01', '2024-02-01');
    expect(calls).toHaveLength(1);
    expect(headersOf(calls[0].init)['authorization']).toBe(`Bearer ${DUMMY_TOKEN}`);
  });

  it('omits the authorization header when no token is provided', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = buildPeerPriceClient('https://peer.example', recordingFetch(calls));
    await client.eodHistory('AAPL', '2024-01-01', '2024-02-01');
    await client.spxHistory('2024-01-01', '2024-02-01');
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      const headers = headersOf(call.init);
      expect(headers['authorization']).toBeUndefined();
      expect(headers['user-agent']).toContain('congress.trade');
    }
  });

  it('still returns [] on error responses (soft mode / fallback preserved) with a token set', async () => {
    const unauthorized = (async () => new Response('', { status: 401 })) as unknown as typeof fetch;
    const client = buildPeerPriceClient('https://peer.example', unauthorized, DUMMY_TOKEN);
    expect(await client.eodHistory('AAPL', '2024-01-01', '2024-02-01')).toEqual([]);
  });

  it('recognizes plain errors carrying PEER_STALE_RESPONSE closes', () => {
    const err = Object.assign(new Error('PEER_STALE_RESPONSE'), {
      closes: [{ date: '2026-06-01', close: 2 }],
    });
    expect(isPeerStaleResponseError(err)).toBe(true);
  });

  it('throws PeerStaleResponseError on HTTP 502 with error stale', async () => {
    const { PeerStaleResponseError } = await import('../peer.ts');
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: false, error: 'stale', closes: [{ date: '2020-01-01', close: 1 }] }), {
        status: 502,
      })) as unknown as typeof fetch;
    const client = buildPeerPriceClient('https://peer.example', fetchImpl, DUMMY_TOKEN, { strict: true });
    await expect(client.eodHistory('AAPL', '2024-01-01', '2024-02-01')).rejects.toBeInstanceOf(PeerStaleResponseError);
  });

  it('still throws PEER_HTTP_401 in strict mode so peer-only runs fail closed on auth', async () => {
    const unauthorized = (async () => new Response('', { status: 401 })) as unknown as typeof fetch;
    const client = buildPeerPriceClient('https://peer.example', unauthorized, DUMMY_TOKEN, { strict: true });
    await expect(client.eodHistory('AAPL', '2024-01-01', '2024-02-01')).rejects.toThrow(/PEER_HTTP_401/);
  });

  it('filters out malformed or non-numeric closes from peer responses', async () => {
    const malformed = (async () =>
      new Response(
        JSON.stringify({
          closes: [
            { date: '2024-01-03', close: 15.5 },
            { date: '2024-01-02', close: 'invalid' },
            { date: '2024-01-01', close: 0 },
            { date: '2023-12-31', close: null },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const client = buildPeerPriceClient('https://peer.example', malformed, DUMMY_TOKEN);
    const closes = await client.eodHistory('aapl', '2023-12-31', '2024-01-03');
    expect(closes).toEqual([{ date: '2024-01-03', close: 15.5 }]);
  });

  it('normalizes lowercase ticker symbols and encodes query parameters', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = buildPeerPriceClient('https://peer.example', recordingFetch(calls), DUMMY_TOKEN);
    await client.eodHistory('nvda', '2024-01-01', '2024-02-01');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://peer.example/api/market/prices/NVDA?from=2024-01-01&to=2024-02-01');
    expect(headersOf(calls[0].init)['accept']).toBe('application/json');
  });
});

