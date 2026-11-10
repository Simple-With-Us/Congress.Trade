import { describe, it, expect } from 'vitest';
import { parseTiingoPrices, buildTiingoPriceClient } from '../tiingo.ts';

const fetchWith = (status: number, body: unknown = '') =>
  (async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;

const prices = [
  { date: '2024-01-02T00:00:00.000Z', close: 187.15, adjClose: 185.64, volume: 1 },
  { date: '2024-01-03T00:00:00.000Z', close: 184.22, adjClose: 184.25, volume: 2 },
];

describe('parseTiingoPrices', () => {
  it('maps {date, adjClose} to descending [{date, close}], preferring adjClose', () => {
    const out = parseTiingoPrices(prices);
    expect(out).toEqual([
      { date: '2024-01-03', close: 184.25 },
      { date: '2024-01-02', close: 185.64 },
    ]);
  });
  it('falls back to close when adjClose is missing', () => {
    const out = parseTiingoPrices([{ date: '2024-01-02T00:00:00.000Z', close: 187.15 }]);
    expect(out).toEqual([{ date: '2024-01-02', close: 187.15 }]);
  });
  it('returns [] for an empty/error body', () => {
    expect(parseTiingoPrices({ detail: 'Not Found.' })).toEqual([]);
    expect(parseTiingoPrices(null)).toEqual([]);
    expect(parseTiingoPrices([])).toEqual([]);
  });
});

describe('buildTiingoPriceClient', () => {
  it('parses closes on 200 (successful fetch)', async () => {
    const out = await buildTiingoPriceClient('k', fetchWith(200, prices)).eodHistory('AAPL', '2024-01-01', '2024-01-05');
    expect(out[0]).toEqual({ date: '2024-01-03', close: 184.25 });
  });
  it('spxHistory fetches SPY as the S&P proxy', async () => {
    let calledUrl = '';
    const fetchImpl = (async (url: string) => {
      calledUrl = String(url);
      return new Response(JSON.stringify(prices), { status: 200 });
    }) as unknown as typeof fetch;
    await buildTiingoPriceClient('k', fetchImpl).spxHistory('2024-01-01', '2024-01-05');
    expect(calledUrl).toContain('/tiingo/daily/SPY/prices');
  });
  it('returns [] on 404 (unknown symbol) but throws on transient/auth/server errors', async () => {
    // 404 = genuine "no data" so a delisted/unknown ticker can be negative-cached.
    expect(await buildTiingoPriceClient('k', fetchWith(404, { detail: 'Not Found.' })).eodHistory('ZZZZ', 'a', 'b')).toEqual([]);
    // Auth/rate/server failures throw so the caller skips + retries instead of
    // negative-caching priceable tickers during a transient outage.
    await expect(buildTiingoPriceClient('k', fetchWith(403)).eodHistory('AAPL', 'a', 'b')).rejects.toThrow('TIINGO_HTTP_403');
    // 429s retry with backoff first (./retry429.ts); the injected no-op sleep
    // keeps the test fast while the retries exhaust and it still throws.
    await expect(
      buildTiingoPriceClient('k', fetchWith(429), { sleep: async () => {} }).spxHistory('a', 'b'),
    ).rejects.toThrow('TIINGO_HTTP_429');
    await expect(buildTiingoPriceClient('k', fetchWith(500)).eodHistory('AAPL', 'a', 'b')).rejects.toThrow('TIINGO_HTTP_500');
  });
});

describe('buildTiingoPriceClient — caller cancellation', () => {
  it('threads the caller signal into every fetch (eod and spx)', async () => {
    const seen: Array<AbortSignal | null | undefined> = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen.push(init?.signal);
      return new Response(JSON.stringify(prices), { status: 200 });
    }) as unknown as typeof fetch;
    const controller = new AbortController();
    const client = buildTiingoPriceClient('k', fetchImpl);
    await client.eodHistory('AAPL', '2024-01-01', '2024-01-05', controller.signal);
    await client.spxHistory('2024-01-01', '2024-01-05', controller.signal);
    expect(seen).toEqual([controller.signal, controller.signal]);
  });

  it('an abort during the 429 backoff wait rejects promptly with the abort reason', async () => {
    const calls = { n: 0 };
    let enteredWait: () => void = () => {};
    const waitEntered = new Promise<void>((resolve) => { enteredWait = resolve; });
    const fetchImpl = (async () => {
      calls.n += 1;
      return new Response('', { status: 429 });
    }) as unknown as typeof fetch;
    const client = buildTiingoPriceClient('k', fetchImpl, {
      // Stand-in for the multi-second backoff wait:  long enough that only
      // the abort can settle the call promptly.
      sleep: async () => {
        enteredWait();
        await new Promise((resolve) => setTimeout(resolve, 250));
      },
      random: () => 0.5,
    });
    const controller = new AbortController();
    const reason = new Error('lane deadline');
    const pending = client.eodHistory('AAPL', '2024-01-01', '2024-01-05', controller.signal);
    await waitEntered; // first attempt 429'd; the backoff wait is in progress
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(calls.n).toBe(1); // no retry attempt was spent after the abort
  });

  it('an abort mid-flight rejects the call with the abort reason instead of hanging detached', async () => {
    // A fetch double with real fetch semantics: it settles only when the
    // signal fires, rejecting with the signal's reason.  If the client
    // dropped the signal, this promise would never settle.
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return; // no signal threaded: hangs forever, failing the test by timeout
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      })) as unknown as typeof fetch;
    const controller = new AbortController();
    const reason = new Error('lane deadline');
    const client = buildTiingoPriceClient('k', fetchImpl);
    const pending = client.eodHistory('AAPL', '2024-01-01', '2024-01-05', controller.signal);
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });
});
