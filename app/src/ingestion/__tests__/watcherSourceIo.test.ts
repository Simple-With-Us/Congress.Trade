import { describe, expect, it } from 'vitest';
import { WATCHER_SOURCE_IO_BUDGET_MS, watcherSourceIoSignal } from '../watcherSourceIo.ts';

describe('watcherSourceIoSignal', () => {
  it('exposes a 7s per-source budget under the 22s watcher lane', () => {
    expect(WATCHER_SOURCE_IO_BUDGET_MS).toBe(7_000);
  });

  it('returns an AbortSignal when only the per-source budget applies', () => {
    const signal = watcherSourceIoSignal();
    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(false);
  });

  it('aborts when either the tick signal or the per-source budget fires', async () => {
    const tick = new AbortController();
    const signal = watcherSourceIoSignal(tick.signal);
    tick.abort(new Error('tick deadline'));
    expect(signal?.aborted).toBe(true);
  });
});
