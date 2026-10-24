/**
 * CT-2443:  the daily not-covered re-check keeps its own lane stamp, written
 * only when the re-check finished without aborting, so an abort (fatal ST
 * error or shutdown) retries on the next tick instead of the next UTC day.
 *
 * The lane policy is tested through `runNotCoveredRecheckLane` with a typed
 * in-memory stamp store (no partial-Env cast).  The wiring into the stamped
 * market-data fast path is covered in jobs.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { type LaneStampEnv, runNotCoveredRecheckLane } from '../jobs.ts';

const RECHECK_KEY = 'jobs:daily:lastok:market-data-not-covered-recheck';
const DAY = '2026-10-23';

function memoryLaneStamps(kv = new Map<string, string>()): LaneStampEnv & { kv: Map<string, string> } {
  return {
    kv,
    CONFIG_KV: {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string) => {
        kv.set(key, value);
      },
    },
  };
}

describe('runNotCoveredRecheckLane stamp policy', () => {
  it('leaves the lane unstamped after an abort, so the next tick retries the same day', async () => {
    const env = memoryLaneStamps();
    const recheck = vi.fn<() => Promise<{ aborted: boolean }>>()
      .mockResolvedValueOnce({ aborted: true })
      .mockResolvedValueOnce({ aborted: false });

    expect(await runNotCoveredRecheckLane(env, DAY, recheck)).toBe('aborted');
    expect(env.kv.has(RECHECK_KEY)).toBe(false);
    expect(await runNotCoveredRecheckLane(env, DAY, recheck)).toBe('ran');
    expect(env.kv.get(RECHECK_KEY)).toBe(DAY);
    expect(recheck).toHaveBeenCalledTimes(2);
  });

  it('runs at most once per UTC day after a clean finish', async () => {
    const env = memoryLaneStamps();
    const recheck = vi.fn(async () => ({ aborted: false }));

    expect(await runNotCoveredRecheckLane(env, DAY, recheck)).toBe('ran');
    expect(await runNotCoveredRecheckLane(env, DAY, recheck)).toBe('stamped');
    expect(recheck).toHaveBeenCalledTimes(1);
    // A new UTC day runs again.
    expect(await runNotCoveredRecheckLane(env, '2026-10-24', recheck)).toBe('ran');
    expect(recheck).toHaveBeenCalledTimes(2);
  });

  it('does not stamp when the re-check throws', async () => {
    const env = memoryLaneStamps();
    const recheck = vi.fn<() => Promise<{ aborted: boolean }>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ aborted: false });

    expect(await runNotCoveredRecheckLane(env, DAY, recheck)).toBe('error');
    expect(env.kv.has(RECHECK_KEY)).toBe(false);
    expect(await runNotCoveredRecheckLane(env, DAY, recheck)).toBe('ran');
  });
});
