import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../shared/types.ts';
import { lookupExactMinutePrice } from '../exactPrice.ts';

vi.mock('../../secrets/infisical', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../secrets/infisical')>()),
  resolveSecrets: vi.fn(async () => ({})),
}));

afterEach(() => {
  vi.clearAllMocks();
});

const env = {
  APP_B_IMPORT_URL: 'https://peer.example',
  APP_B_INGEST_TOKEN: 'test-token',
} as unknown as Env;

function jsonFetch(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe('lookupExactMinutePrice', () => {
  it('returns the nearest at-or-after 1-minute bar for an equity ticker', async () => {
    const fetchImpl = jsonFetch(200, {
      bars: [
        { t: '2026-08-16T15:01:00.000Z', c: 190.25 },
        { t: '2026-08-16T15:02:00.000Z', c: 190.4 },
      ],
    });
    const result = await lookupExactMinutePrice(
      env,
      { ticker: 'aapl', atIso: '2026-08-16T15:00:30.000Z' },
      fetchImpl,
    );
    expect(result).toMatchObject({
      ok: true,
      ticker: 'AAPL',
      price: 190.25,
      barAt: '2026-08-16T15:01:00.000Z',
      source: 'peer-intraday',
      instrumentClass: 'equities_long',
    });
  });

  it('refuses options and Kalshi event contracts instead of substituting an equity print', async () => {
    const fetchImpl = jsonFetch(200, { bars: [{ t: '2026-08-16T15:01:00.000Z', c: 190 }] });
    const option = await lookupExactMinutePrice(
      env,
      { ticker: 'AAPL', atIso: '2026-08-16T15:00:00.000Z', isOption: true },
      fetchImpl,
    );
    expect(option).toMatchObject({ ok: false, reason: 'unsupported_instrument', instrumentClass: 'option' });

    const event = await lookupExactMinutePrice(
      env,
      { ticker: 'FED', atIso: '2026-08-16T15:00:00.000Z', assetName: 'Kalshi Fed decision' },
      fetchImpl,
    );
    expect(event).toMatchObject({
      ok: false,
      reason: 'unsupported_instrument',
      instrumentClass: 'event_contract',
    });
  });

  it('does not fabricate a price when the peer is down or the range is empty', async () => {
    const down = await lookupExactMinutePrice(
      env,
      { ticker: 'AAPL', atIso: '2026-08-16T15:00:00.000Z' },
      jsonFetch(502, { error: 'down' }),
    );
    expect(down).toMatchObject({ ok: false, reason: 'peer_unavailable' });

    const empty = await lookupExactMinutePrice(
      env,
      { ticker: 'AAPL', atIso: '2026-08-16T15:00:00.000Z' },
      jsonFetch(200, { bars: [] }),
    );
    expect(empty).toMatchObject({ ok: false, reason: 'no_bars' });
  });

  it('rejects a missing ticker or unparseable timestamp without calling the peer', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ bars: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await lookupExactMinutePrice(env, { ticker: '', atIso: '2026-08-16T15:00:00.000Z' }, fetchImpl)).toMatchObject({
      ok: false,
      reason: 'bad_ticker',
    });
    expect(await lookupExactMinutePrice(env, { ticker: 'AAPL', atIso: 'not-a-date' }, fetchImpl)).toMatchObject({
      ok: false,
      reason: 'bad_time',
    });
    expect(calls).toEqual([]);
  });
});
