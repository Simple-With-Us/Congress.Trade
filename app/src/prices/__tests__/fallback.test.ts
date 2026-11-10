/**
 * src/prices/__tests__/fallback.test.ts
 *
 * Peer-primary + Massive last-resort: Massive must not be called first, and
 * peer auth/plan failures must not fall through to the shared Massive key.
 */
import { describe, expect, it } from 'vitest';
import { buildFallbackPriceClient } from '../fallback.ts';
import type { PriceClient } from '../types.ts';
import type { Close } from '../compute.ts';

function recordingClient(
  name: string,
  order: string[],
  impl: {
    eod?: Close[] | Error;
    spx?: Close[] | Error;
  },
): PriceClient {
  return {
    async eodHistory(symbol: string) {
      order.push(`${name}:eod:${symbol}`);
      const v = impl.eod;
      if (v instanceof Error) throw v;
      return v ?? [];
    },
    async spxHistory() {
      order.push(`${name}:spx`);
      const v = impl.spx;
      if (v instanceof Error) throw v;
      return v ?? [];
    },
  };
}

const PEER_BAR: Close[] = [{ date: '2026-08-01', close: 100 }];
const MASSIVE_BAR: Close[] = [{ date: '2026-08-01', close: 99 }];

describe('buildFallbackPriceClient — peer-primary / Massive last-resort', () => {
  it('does not call Massive first when peer returns history', async () => {
    const order: string[] = [];
    const peer = recordingClient('peer', order, { eod: PEER_BAR, spx: PEER_BAR });
    const massive = recordingClient('massive', order, { eod: MASSIVE_BAR, spx: MASSIVE_BAR });
    const client = buildFallbackPriceClient(peer, massive, { rethrowFatal: true });

    await expect(client.eodHistory('AAPL', '2026-01-01', '2026-08-01')).resolves.toEqual(PEER_BAR);
    await expect(client.spxHistory('2026-01-01', '2026-08-01')).resolves.toEqual(PEER_BAR);
    expect(order).toEqual(['peer:eod:AAPL', 'peer:spx']);
  });

  it('calls Massive only after an empty peer series (last-resort)', async () => {
    const order: string[] = [];
    const peer = recordingClient('peer', order, { eod: [] });
    const massive = recordingClient('massive', order, { eod: MASSIVE_BAR });
    const client = buildFallbackPriceClient(peer, massive, { rethrowFatal: true });

    await expect(client.eodHistory('ZZZZ', '2026-01-01', '2026-08-01')).resolves.toEqual(MASSIVE_BAR);
    expect(order).toEqual(['peer:eod:ZZZZ', 'massive:eod:ZZZZ']);
  });

  it('rethrows peer 401/402/403 and never calls Massive', async () => {
    const order: string[] = [];
    const peer = recordingClient('peer', order, { eod: new Error('PEER_HTTP_401') });
    const massive = recordingClient('massive', order, { eod: MASSIVE_BAR });
    const client = buildFallbackPriceClient(peer, massive, { rethrowFatal: true });

    await expect(client.eodHistory('AAPL', '2026-01-01', '2026-08-01')).rejects.toThrow(/PEER_HTTP_401/);
    expect(order).toEqual(['peer:eod:AAPL']);
  });

  it('falls through to Massive on a non-auth peer failure when rethrowFatal is set', async () => {
    const order: string[] = [];
    const peer = recordingClient('peer', order, { eod: new Error('PEER_HTTP_503') });
    const massive = recordingClient('massive', order, { eod: MASSIVE_BAR });
    const client = buildFallbackPriceClient(peer, massive, { rethrowFatal: true });

    await expect(client.eodHistory('AAPL', '2026-01-01', '2026-08-01')).resolves.toEqual(MASSIVE_BAR);
    expect(order).toEqual(['peer:eod:AAPL', 'massive:eod:AAPL']);
  });
});

describe('buildFallbackPriceClient — caller cancellation', () => {
  it('rethrows the caller abort reason and never calls the secondary', async () => {
    const order: string[] = [];
    const reason = new Error('lane deadline');
    const controller = new AbortController();
    controller.abort(reason);
    // A signal-honoring primary rejects with the caller's reason itself
    // (fetch on an aborted signal does exactly this).
    const peer: PriceClient = {
      async eodHistory(_symbol: string, _from: string, _to: string, signal?: AbortSignal) {
        order.push('peer:eod');
        throw signal?.reason ?? new Error('primary called without a signal');
      },
      async spxHistory() {
        return [];
      },
    };
    const massive = recordingClient('massive', order, { eod: MASSIVE_BAR });
    const client = buildFallbackPriceClient(peer, massive, { rethrowFatal: true });

    await expect(
      client.eodHistory('AAPL', '2026-01-01', '2026-08-01', controller.signal),
    ).rejects.toBe(reason);
    expect(order).toEqual(['peer:eod']);
  });

  it('does not invoke the secondary when the abort lands while the primary resolves empty', async () => {
    const order: string[] = [];
    const reason = new Error('lane deadline');
    const controller = new AbortController();
    controller.abort(reason);
    // The primary ignores the signal and resolves empty anyway; the
    // fallback must still refuse to spend a secondary call on the dead
    // signal — a secondary that ignored it too would run detached past
    // the caller's deadline.
    const peer: PriceClient = {
      async eodHistory() {
        order.push('peer:eod');
        return [];
      },
      async spxHistory(_from: string, _to: string, signal?: AbortSignal) {
        order.push('peer:spx');
        throw signal?.reason ?? new Error('primary called without a signal');
      },
    };
    const massive = recordingClient('massive', order, { eod: MASSIVE_BAR, spx: MASSIVE_BAR });
    const client = buildFallbackPriceClient(peer, massive, { rethrowFatal: true });

    await expect(
      client.eodHistory('AAPL', '2026-01-01', '2026-08-01', controller.signal),
    ).rejects.toBe(reason);
    // Same contract on the SPX wrapper: the abort rejection is rethrown,
    // not swallowed into a secondary call.
    await expect(client.spxHistory('2026-01-01', '2026-08-01', controller.signal)).rejects.toBe(reason);
    expect(order).toEqual(['peer:eod', 'peer:spx']);
  });
});
