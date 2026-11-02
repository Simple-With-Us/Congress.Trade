import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cached, resetKvCacheForTests } from '../kvCache.ts';
import type { Env } from '../types.ts';

function fakeEnv(store = new Map<string, string>()) {
  const get = vi.fn(async (key: string) => store.get(key) ?? null);
  const put = vi.fn(async (key: string, value: string) => {
    store.set(key, value);
  });
  const env = { CONFIG_KV: { get, put } } as unknown as Env;
  return { env, get, put, store };
}

describe('cached() memory tier + singleflight (CT-2459)', () => {
  beforeEach(() => resetKvCacheForTests());

  it('serves repeat hits from memory without another KV get', async () => {
    const { env, get } = fakeEnv();
    const fn = vi.fn(async () => ({ n: 1 }));
    await cached(env, 'k1', 300, fn);
    const again = await cached(env, 'k1', 300, fn);
    expect(again).toEqual({ n: 1 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('singleflights concurrent misses into one compute', async () => {
    const { env } = fakeEnv();
    const fn = vi.fn(
      () => new Promise<object>((resolve) => setTimeout(() => resolve({ ok: true }), 20)),
    );
    const [a, b, cc] = await Promise.all([
      cached(env, 'k2', 300, fn),
      cached(env, 'k2', 300, fn),
      cached(env, 'k2', 300, fn),
    ]);
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    expect(cc).toEqual({ ok: true });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('returns a fresh object per hit (callers cannot mutate the cache)', async () => {
    const { env } = fakeEnv();
    const first = await cached<{ n: number }>(env, 'k3', 300, async () => ({ n: 1 }));
    first.n = 999;
    const second = await cached<{ n: number }>(env, 'k3', 300, async () => ({ n: 2 }));
    expect(second.n).toBe(1);
  });

  it('falls back to KV after the memory tier is reset', async () => {
    const store = new Map<string, string>();
    const { env } = fakeEnv(store);
    await cached(env, 'k4', 300, async () => ({ from: 'compute' }));
    resetKvCacheForTests();
    const fn = vi.fn(async () => ({ from: 'recompute' }));
    const value = await cached(env, 'k4', 300, fn);
    expect(value).toEqual({ from: 'compute' });
    expect(fn).not.toHaveBeenCalled();
  });
});
