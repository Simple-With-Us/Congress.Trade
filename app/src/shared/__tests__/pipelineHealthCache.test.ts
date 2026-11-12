import { describe, expect, it, vi } from 'vitest';
import { createPipelineHealthCache, type PipelineHealth } from '../pipelineHealth.ts';
import type { Env } from '../types.ts';

function fakeEnv(): Env {
  return { DB: {} } as unknown as Env;
}

const RESULT = { status: 'healthy', checks: [] } as unknown as PipelineHealth;

describe('createPipelineHealthCache (CT-2459)', () => {
  it('serves the TTL window from one fetch and refetches after expiry', async () => {
    const fetcher = vi.fn(async () => RESULT);
    const cache = createPipelineHealthCache(fetcher, 60_000);
    const env = fakeEnv();
    const t0 = new Date('2026-11-01T00:00:00Z');
    await cache.get(env, t0);
    await cache.get(env, new Date(t0.getTime() + 59_000));
    expect(fetcher).toHaveBeenCalledTimes(1);
    await cache.get(env, new Date(t0.getTime() + 61_000));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('singleflights concurrent callers', async () => {
    const fetcher = vi.fn(
      () => new Promise<PipelineHealth>((resolve) => setTimeout(() => resolve(RESULT), 20)),
    );
    const cache = createPipelineHealthCache(fetcher, 60_000);
    const env = fakeEnv();
    const [a, b] = await Promise.all([cache.get(env), cache.get(env)]);
    expect(a).toBe(RESULT);
    expect(b).toBe(RESULT);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('never caches errors — the next caller retries', async () => {
    const fetcher = vi
      .fn<() => Promise<PipelineHealth>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(RESULT);
    const cache = createPipelineHealthCache(fetcher, 60_000);
    const env = fakeEnv();
    await expect(cache.get(env)).rejects.toThrow('boom');
    await expect(cache.get(env)).resolves.toBe(RESULT);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('isolates entries per DB binding', async () => {
    const fetcher = vi.fn(async () => RESULT);
    const cache = createPipelineHealthCache(fetcher, 60_000);
    await cache.get(fakeEnv());
    await cache.get(fakeEnv());
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
