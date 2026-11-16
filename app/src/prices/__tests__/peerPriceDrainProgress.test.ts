import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../shared/types.ts';
import {
  PRICE_DRAIN_LAST_PROGRESS_KEY,
  peerPriceDrainMadeProgress,
  readPeerPriceDrainLastProgressAt,
  recordPeerPriceDrainProgress,
} from '../peerPriceDrainProgress.ts';

function kvEnv(): Env {
  const store = new Map<string, string>();
  return {
    CONFIG_KV: {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => {
        store.set(key, value);
      },
      delete: async (key: string) => {
        store.delete(key);
      },
    },
  } as Env;
}

describe('peerPriceDrainProgress', () => {
  it('records and reads last progress at', async () => {
    const env = kvEnv();
    const at = '2026-11-10T18:00:00.000Z';
    await recordPeerPriceDrainProgress(env, at);
    expect(await readPeerPriceDrainLastProgressAt(env)).toBe(at);
  });

  it('treats priced tickers as progress even when pending count is flat', () => {
    expect(
      peerPriceDrainMadeProgress({ pendingBefore: 950, pendingAfter: 950, tickersPriced: 40 }),
    ).toBe(true);
    expect(
      peerPriceDrainMadeProgress({ pendingBefore: 950, pendingAfter: 950, tickersPriced: 0 }),
    ).toBe(false);
    expect(
      peerPriceDrainMadeProgress({ pendingBefore: 100, pendingAfter: 80, tickersPriced: 0 }),
    ).toBe(true);
  });

  it('no-ops when CONFIG_KV is missing', async () => {
    const env = {} as Env;
    await recordPeerPriceDrainProgress(env, new Date());
    expect(await readPeerPriceDrainLastProgressAt(env)).toBeNull();
  });

  it('ignores invalid stored timestamps', async () => {
    const env = kvEnv();
    await (env.CONFIG_KV as { put: (k: string, v: string) => Promise<void> }).put(
      PRICE_DRAIN_LAST_PROGRESS_KEY,
      'not-a-date',
    );
    expect(await readPeerPriceDrainLastProgressAt(env)).toBeNull();
  });
});
