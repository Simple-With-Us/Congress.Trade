/**
 * CT-2443:  the daily not-covered re-check keeps its own lane stamp, written
 * only when the re-check finished without aborting, so an abort (fatal ST
 * error or shutdown) retries on the next tick instead of the next UTC day.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../shared/types.ts';

const mocks = vi.hoisted(() => ({
  buildPriceRefreshClient: vi.fn(),
  recheckNotCoveredPeerPrices: vi.fn(),
}));

vi.mock('../prices/service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../prices/service.ts')>()),
  buildPriceRefreshClient: mocks.buildPriceRefreshClient,
}));
vi.mock('../prices/notCovered', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../prices/notCovered.ts')>()),
  recheckNotCoveredPeerPrices: mocks.recheckNotCoveredPeerPrices,
}));

import { maybeRunDailyMarketDataJobs, maybeRunNotCoveredRecheck } from '../jobs.ts';

function kvEnv(kv = new Map<string, string>()): Env {
  return {
    CONFIG_KV: {
      async get(key: string) {
        return kv.get(key) ?? null;
      },
      async put(key: string, value: string) {
        kv.set(key, value);
      },
    },
  } as unknown as Env;
}

const NOW = new Date('2026-10-23T15:00:00.000Z');
const DAY = '2026-10-23';
const result = (aborted: boolean) => ({ checked: 1, repriced: 0, restamped: 1, aborted, errors: [] });

describe('maybeRunNotCoveredRecheck lane stamp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildPriceRefreshClient.mockResolvedValue({
      client: {},
      fmpBudgeted: false,
      pace: async () => {},
    });
  });

  it('leaves the lane unstamped after an abort, so the next tick retries the same day', async () => {
    const env = kvEnv();
    mocks.recheckNotCoveredPeerPrices.mockResolvedValueOnce(result(true));
    expect(await maybeRunNotCoveredRecheck(env, NOW, DAY)).toBe('aborted');

    mocks.recheckNotCoveredPeerPrices.mockResolvedValueOnce(result(false));
    expect(await maybeRunNotCoveredRecheck(env, NOW, DAY)).toBe('ran');
    expect(mocks.recheckNotCoveredPeerPrices).toHaveBeenCalledTimes(2);
  });

  it('runs at most once per UTC day after a clean finish', async () => {
    const env = kvEnv();
    mocks.recheckNotCoveredPeerPrices.mockResolvedValue(result(false));
    expect(await maybeRunNotCoveredRecheck(env, NOW, DAY)).toBe('ran');
    expect(await maybeRunNotCoveredRecheck(env, NOW, DAY)).toBe('stamped');
    expect(mocks.recheckNotCoveredPeerPrices).toHaveBeenCalledTimes(1);
  });

  it('does not stamp when the re-check throws', async () => {
    const env = kvEnv();
    mocks.recheckNotCoveredPeerPrices.mockRejectedValueOnce(new Error('boom'));
    expect(await maybeRunNotCoveredRecheck(env, NOW, DAY)).toBe('error');
    mocks.recheckNotCoveredPeerPrices.mockResolvedValueOnce(result(false));
    expect(await maybeRunNotCoveredRecheck(env, NOW, DAY)).toBe('ran');
  });

  it('retries an aborted re-check from the stamped market-data fast path (Kody: no wait for the next UTC day)', async () => {
    const kv = new Map<string, string>([
      ['jobs:daily:lastok:market-data', DAY],
      ['jobs:daily:lastok:market-data-price-catchup', DAY],
    ]);
    const env = kvEnv(kv);
    mocks.recheckNotCoveredPeerPrices.mockResolvedValueOnce(result(false));
    expect(await maybeRunDailyMarketDataJobs(env, NOW)).toBe('stamped');
    expect(mocks.recheckNotCoveredPeerPrices).toHaveBeenCalledTimes(1);
    expect(kv.get('jobs:daily:lastok:market-data-not-covered-recheck')).toBe(DAY);
    // Once stamped, later ticks the same day do not re-run it.
    expect(await maybeRunDailyMarketDataJobs(env, NOW)).toBe('stamped');
    expect(mocks.recheckNotCoveredPeerPrices).toHaveBeenCalledTimes(1);
  });
});
