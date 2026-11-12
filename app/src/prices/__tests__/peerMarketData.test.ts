import { describe, expect, it } from 'vitest';
import {
  fetchPeerRealtimeQuotes,
  fetchPeerIntradayBars,
  nearestBarAtOrAfter,
  type PeerIntradayBar,
} from '../peerMarketData.ts';

const DUMMY_TOKEN = 'test-dummy-token';

function jsonFetch(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

function recordingFetch(
  calls: Array<{ url: string; init?: RequestInit }>,
  respond: (url: string) => Response,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return respond(String(input));
  }) as unknown as typeof fetch;
}

describe('fetchPeerRealtimeQuotes', () => {
  it('sends bearer auth and a comma-joined symbols param, never allowDelayed', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = recordingFetch(calls, () =>
      new Response(JSON.stringify({ quotes: { AAPL: { price: 190.5, source: 'alpaca-snapshot' } } }), { status: 200 }),
    );
    const quotes = await fetchPeerRealtimeQuotes('https://peer.example', ['aapl', 'msft'], DUMMY_TOKEN, fetchImpl);
    expect(quotes).toEqual({ AAPL: { price: 190.5, source: 'alpaca-snapshot', at: undefined } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/api/market/quotes?symbols=AAPL%2CMSFT');
    expect(calls[0]!.url).not.toContain('allowDelayed');
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers['authorization']).toBe(`Bearer ${DUMMY_TOKEN}`);
  });

  it('omits a delayed quote entirely rather than treating it as live', async () => {
    const fetchImpl = jsonFetch(200, {
      quotes: {
        AAPL: { price: 190.5, source: 'alpaca-snapshot' },
        MSFT: { price: 410, source: 'yahoo-chart', delayed: true },
      },
    });
    const quotes = await fetchPeerRealtimeQuotes('https://peer.example', ['AAPL', 'MSFT'], DUMMY_TOKEN, fetchImpl);
    expect(Object.keys(quotes)).toEqual(['AAPL']);
  });

  it('drops a non-positive or non-numeric price rather than passing it through', async () => {
    const fetchImpl = jsonFetch(200, {
      quotes: {
        A: { price: 0, source: 'x' },
        B: { price: -5, source: 'x' },
        C: { price: 'nope', source: 'x' },
        D: { price: 12.5, source: 'x' },
      },
    });
    const quotes = await fetchPeerRealtimeQuotes('https://peer.example', ['A', 'B', 'C', 'D'], DUMMY_TOKEN, fetchImpl);
    expect(Object.keys(quotes)).toEqual(['D']);
  });

  it('returns {} on a non-2xx response, network error, or empty ticker list', async () => {
    expect(await fetchPeerRealtimeQuotes('https://peer.example', ['AAPL'], DUMMY_TOKEN, jsonFetch(500, {}))).toEqual({});
    const throwing = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
    expect(await fetchPeerRealtimeQuotes('https://peer.example', ['AAPL'], DUMMY_TOKEN, throwing)).toEqual({});
    expect(await fetchPeerRealtimeQuotes('https://peer.example', [], DUMMY_TOKEN)).toEqual({});
    expect(await fetchPeerRealtimeQuotes(undefined, ['AAPL'], DUMMY_TOKEN)).toEqual({});
  });
});

describe('fetchPeerIntradayBars', () => {
  it('requests the intraday route with start/end/timeframe=1Min and bearer auth', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = recordingFetch(calls, () => new Response(JSON.stringify({ bars: [] }), { status: 200 }));
    await fetchPeerIntradayBars('https://peer.example', 'aapl', '2026-08-01T00:00:00.000Z', '2026-08-01T01:00:00.000Z', DUMMY_TOKEN, fetchImpl);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/api/market/intraday/AAPL');
    expect(calls[0]!.url).toContain('timeframe=1Min');
    expect(calls[0]!.url).toContain('start=2026-08-01T00%3A00%3A00.000Z');
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers['authorization']).toBe(`Bearer ${DUMMY_TOKEN}`);
  });

  it('HTTP 200 with an empty bars array is a CONFIRMED-empty ok result, never unavailable', async () => {
    const result = await fetchPeerIntradayBars(
      'https://peer.example', 'AAPL', '2026-08-01T00:00:00Z', '2026-08-01T01:00:00Z', DUMMY_TOKEN,
      jsonFetch(200, { bars: [] }),
    );
    expect(result).toEqual({ kind: 'ok', bars: [] });
  });

  it('HTTP 200 with bars returns them verbatim as ok', async () => {
    const bars: PeerIntradayBar[] = [{ t: '2026-08-01T00:01:00Z', c: 101.5 }];
    const result = await fetchPeerIntradayBars(
      'https://peer.example', 'AAPL', '2026-08-01T00:00:00Z', '2026-08-01T01:00:00Z', DUMMY_TOKEN,
      jsonFetch(200, { bars }),
    );
    expect(result).toEqual({ kind: 'ok', bars });
  });

  it.each([502, 500, 401, 429, 400])(
    'HTTP %d is unavailable, NOT confirmed-empty — the exact distinction this module exists to preserve',
    async (status) => {
      const result = await fetchPeerIntradayBars(
        'https://peer.example', 'AAPL', '2026-08-01T00:00:00Z', '2026-08-01T01:00:00Z', DUMMY_TOKEN,
        jsonFetch(status, { bars: [] }),
      );
      expect(result).toEqual({ kind: 'unavailable', status });
    },
  );

  it('a network error / thrown fetch is unavailable with a null status', async () => {
    const throwing = (async () => { throw new Error('timeout'); }) as unknown as typeof fetch;
    const result = await fetchPeerIntradayBars('https://peer.example', 'AAPL', '2026-08-01T00:00:00Z', '2026-08-01T01:00:00Z', DUMMY_TOKEN, throwing);
    expect(result).toEqual({ kind: 'unavailable', status: null });
  });

  it('an unconfigured peer base URL is unavailable, never fabricated as confirmed-empty', async () => {
    const result = await fetchPeerIntradayBars(undefined, 'AAPL', '2026-08-01T00:00:00Z', '2026-08-01T01:00:00Z', DUMMY_TOKEN);
    expect(result).toEqual({ kind: 'unavailable', status: null });
  });
});

describe('nearestBarAtOrAfter', () => {
  it('skips a bar whose close is missing, null, NaN or non-positive', () => {
    // The invariant "a captured row has a price OR a reason" is declared HERE but the data comes
    // from a peer. A bar with a null close would reach writeCaptured as price=null with error=null
    // - a row marked captured that holds neither - and would be counted as a successful capture.
    // Enforce locally rather than trusting the remote to keep its promise.
    const bad = [
      { t: '2026-08-01T00:01:00Z', c: null as unknown as number },
      { t: '2026-08-01T00:02:00Z', c: Number.NaN },
      { t: '2026-08-01T00:03:00Z', c: 0 },
      { t: '2026-08-01T00:04:00Z', c: -5 },
      { t: '2026-08-01T00:05:00Z', c: 101.5 },
    ];
    const bar = nearestBarAtOrAfter(bad, '2026-08-01T00:00:00Z', 10);
    expect(bar?.c).toBe(101.5);
    expect(bar?.t).toBe('2026-08-01T00:05:00Z');
  });

  it('returns null when every candidate bar has an unusable close', () => {
    const bad = [
      { t: '2026-08-01T00:01:00Z', c: null as unknown as number },
      { t: '2026-08-01T00:02:00Z', c: 0 },
    ];
    expect(nearestBarAtOrAfter(bad, '2026-08-01T00:00:00Z', 10)).toBeNull();
  });

  const bars: PeerIntradayBar[] = [
    { t: '2026-08-01T00:00:00Z', c: 100 }, // before target — must never be picked
    { t: '2026-08-01T00:02:00Z', c: 101 }, // 2 min after target, in tolerance
    { t: '2026-08-01T00:04:00Z', c: 102 }, // 4 min after target, in tolerance, later
    { t: '2026-08-01T00:10:00Z', c: 103 }, // outside a 5-min tolerance
  ];

  it('picks the earliest bar at or after the target within tolerance', () => {
    const bar = nearestBarAtOrAfter(bars, '2026-08-01T00:01:00Z', 5);
    expect(bar).toEqual({ t: '2026-08-01T00:02:00Z', c: 101 });
  });

  it('NEVER selects a bar earlier than the target, even when it is numerically closer than a valid later bar', () => {
    // The 00:00:00 bar is only 1 minute before the target and would be the
    // "closest" bar by raw distance; the correct answer is the first bar AT
    // OR AFTER the target, 00:02:00, which is 2 minutes away.
    const bar = nearestBarAtOrAfter(bars, '2026-08-01T00:01:00Z', 5);
    expect(bar?.t).not.toBe('2026-08-01T00:00:00Z');
    expect(Date.parse(bar!.t)).toBeGreaterThanOrEqual(Date.parse('2026-08-01T00:01:00Z'));
  });

  it('returns null when nothing falls within tolerance', () => {
    // Every bar in the list is strictly before this target, so none can ever
    // qualify as "at or after" it regardless of tolerance.
    expect(nearestBarAtOrAfter(bars, '2026-08-01T00:20:00Z', 5)).toBeNull();
  });

  it('returns null for an unparseable target or an empty bar list', () => {
    expect(nearestBarAtOrAfter(bars, 'not-a-date')).toBeNull();
    expect(nearestBarAtOrAfter([], '2026-08-01T00:01:00Z')).toBeNull();
  });

  it('is inclusive of the target instant itself', () => {
    const exact: PeerIntradayBar[] = [{ t: '2026-08-01T00:01:00Z', c: 55 }];
    expect(nearestBarAtOrAfter(exact, '2026-08-01T00:01:00Z', 5)).toEqual(exact[0]);
  });
});
