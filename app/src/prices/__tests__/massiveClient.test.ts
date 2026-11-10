import { describe, it, expect } from 'vitest';
import { parseMassiveAggs, buildMassivePriceClient } from '../massive.ts';

const fetchWith = (status: number, body: unknown = '') =>
  (async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;

// Fetch mock that replays a sequence of responses and records how often it ran.
const fetchSequence = (responses: Response[], calls: { n: number }) =>
  (async () => {
    calls.n += 1;
    return responses[Math.min(calls.n - 1, responses.length - 1)];
  }) as unknown as typeof fetch;

const noSleep = async () => {};

// 2024-01-02 and 2024-01-03 at 00:00 ET (epoch ms).
const aggs = {
  ticker: 'AAPL',
  results: [
    { t: Date.parse('2024-01-02T05:00:00Z'), c: 185.64, o: 187.15, v: 1 },
    { t: Date.parse('2024-01-03T05:00:00Z'), c: 184.25, o: 184.22, v: 2 },
  ],
};

describe('parseMassiveAggs', () => {
  it('maps {t,c} to descending [{date, close}]', () => {
    const out = parseMassiveAggs(aggs);
    expect(out).toEqual([
      { date: '2024-01-03', close: 184.25 },
      { date: '2024-01-02', close: 185.64 },
    ]);
  });
  it('returns [] for an empty/error body', () => {
    expect(parseMassiveAggs({ status: 'NOT_AUTHORIZED' })).toEqual([]);
    expect(parseMassiveAggs(null)).toEqual([]);
  });
});

describe('buildMassivePriceClient', () => {
  it('parses closes on 200', async () => {
    const out = await buildMassivePriceClient('k', fetchWith(200, aggs)).eodHistory('AAPL', '2024-01-01', '2024-01-05');
    expect(out[0]).toEqual({ date: '2024-01-03', close: 184.25 });
  });
  it('returns [] on 404 (unknown symbol) but throws on transient/auth/server errors', async () => {
    // 404 = genuine "no data" so a delisted/unknown ticker can be negative-cached.
    expect(await buildMassivePriceClient('k', fetchWith(404)).eodHistory('ZZZZ', 'a', 'b')).toEqual([]);
    // Auth/rate/server failures throw so the caller skips + retries instead of
    // negative-caching priceable tickers during a transient outage.
    await expect(buildMassivePriceClient('k', fetchWith(403)).eodHistory('AAPL', 'a', 'b')).rejects.toThrow('MASSIVE_HTTP_403');
    await expect(buildMassivePriceClient('k', fetchWith(429), { sleep: noSleep }).spxHistory('a', 'b')).rejects.toThrow('MASSIVE_HTTP_429');
    await expect(buildMassivePriceClient('k', fetchWith(500)).eodHistory('AAPL', 'a', 'b')).rejects.toThrow('MASSIVE_HTTP_500');
  });
});

describe('buildMassivePriceClient — bounded 429 retry', () => {
  it('retries a 429 and succeeds once the per-minute window clears', async () => {
    const calls = { n: 0 };
    const waits: number[] = [];
    const fetchImpl = fetchSequence([
      new Response('', { status: 429 }),
      new Response('', { status: 429 }),
      new Response(JSON.stringify(aggs), { status: 200 }),
    ], calls);
    const client = buildMassivePriceClient('k', fetchImpl, {
      sleep: async (ms) => { waits.push(ms); },
      random: () => 0.5, // midpoint jitter → exactly the base waits
    });
    const out = await client.eodHistory('AAPL', '2024-01-01', '2024-01-05');
    expect(out[0]).toEqual({ date: '2024-01-03', close: 184.25 });
    expect(calls.n).toBe(3);
    expect(waits).toEqual([5000, 15000]);
  });

  it('gives up after the retry bound (initial + 3 retries) and throws MASSIVE_HTTP_429', async () => {
    const calls = { n: 0 };
    const client = buildMassivePriceClient('k', fetchSequence([new Response('', { status: 429 })], calls), {
      sleep: noSleep,
    });
    await expect(client.spxHistory('a', 'b')).rejects.toThrow('MASSIVE_HTTP_429');
    expect(calls.n).toBe(4);
  });

  it('honors a Retry-After header over the default backoff', async () => {
    const calls = { n: 0 };
    const waits: number[] = [];
    const fetchImpl = fetchSequence([
      new Response('', { status: 429, headers: { 'retry-after': '2' } }),
      new Response(JSON.stringify(aggs), { status: 200 }),
    ], calls);
    const client = buildMassivePriceClient('k', fetchImpl, {
      sleep: async (ms) => { waits.push(ms); },
    });
    await client.eodHistory('AAPL', '2024-01-01', '2024-01-05');
    expect(calls.n).toBe(2);
    expect(waits).toEqual([2000]);
  });

  it('does not retry other error statuses', async () => {
    const calls = { n: 0 };
    const client = buildMassivePriceClient('k', fetchSequence([new Response('', { status: 500 })], calls), {
      sleep: noSleep,
    });
    await expect(client.eodHistory('AAPL', 'a', 'b')).rejects.toThrow('MASSIVE_HTTP_500');
    expect(calls.n).toBe(1);
  });
});

describe('buildMassivePriceClient — caller cancellation', () => {
  it('threads the caller signal into every fetch (eod and spx)', async () => {
    const seen: Array<AbortSignal | null | undefined> = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen.push(init?.signal);
      return new Response(JSON.stringify(aggs), { status: 200 });
    }) as unknown as typeof fetch;
    const controller = new AbortController();
    const client = buildMassivePriceClient('k', fetchImpl);
    await client.eodHistory('AAPL', '2024-01-01', '2024-01-05', controller.signal);
    await client.spxHistory('2024-01-01', '2024-01-05', controller.signal);
    expect(seen).toEqual([controller.signal, controller.signal]);
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
    const client = buildMassivePriceClient('k', fetchImpl);
    const pending = client.eodHistory('AAPL', '2024-01-01', '2024-01-05', controller.signal);
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });
});
