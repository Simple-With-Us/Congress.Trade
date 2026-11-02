/**
 * src/shared/kvCache.ts
 * Read-through response cache over CONFIG_KV, shared by the analytics and public
 * data routers. Keeps expensive full-corpus D1 aggregations from re-scanning on
 * every request. Plain TTL (not stale-while-revalidate); a miss or any KV error
 * just recomputes, so it can never break a request.
 *
 * CT-2459: per-isolate memory tier + singleflight. On the Deno runtime a
 * CONFIG_KV get is a SQL SELECT on the SAME single libsql connection as every
 * other query, so a "cache hit" still queued behind ingest writes; and on TTL
 * expiry N concurrent requests all recomputed the same aggregate at once.
 * The memory tier stores the SERIALIZED payload (parsed per hit, so callers
 * still get a fresh object and cannot mutate the cached copy). Tiers are
 * keyed by the CONFIG_KV binding object: one shim per prod process, while
 * per-test fake KVs stay isolated from each other.
 */
import type { Env } from './types.ts';

/** Stable cache key from an endpoint name + the resolved params object. */
export function cacheKey(name: string, obj: Record<string, unknown>): string {
  const sorted = Object.keys(obj)
    .sort()
    .map((k) => `${k}=${obj[k] ?? ''}`)
    .join('&');
  return `analytics:${name}:${sorted}`;
}

const MEMORY_TIER_MAX_ENTRIES = 500;

interface Tier {
  memory: Map<string, { serialized: string; expiresAtMs: number }>;
  inFlight: Map<string, Promise<string>>;
}

const tiers = new WeakMap<object, Tier>();
const fallbackTier: Tier = { memory: new Map(), inFlight: new Map() };

function tierFor(env: Env): Tier {
  // CONFIG_KV first, DB second: both are per-process singletons in prod,
  // and per-test fakes in suites — either identity isolates correctly.
  const kv = (env as { CONFIG_KV?: unknown }).CONFIG_KV ?? (env as { DB?: unknown }).DB;
  if (!kv || (typeof kv !== 'object' && typeof kv !== 'function')) return fallbackTier;
  let tier = tiers.get(kv as object);
  if (!tier) {
    tier = { memory: new Map(), inFlight: new Map() };
    tiers.set(kv as object, tier);
  }
  return tier;
}

function memoryGet(tier: Tier, key: string, nowMs: number): string | null {
  const entry = tier.memory.get(key);
  if (!entry) return null;
  if (entry.expiresAtMs <= nowMs) {
    tier.memory.delete(key);
    return null;
  }
  return entry.serialized;
}

function memorySet(tier: Tier, key: string, serialized: string, ttlSec: number): void {
  if (tier.memory.size >= MEMORY_TIER_MAX_ENTRIES && !tier.memory.has(key)) {
    // Evict the oldest insertion (Map preserves insertion order).
    const oldest = tier.memory.keys().next().value;
    if (oldest !== undefined) tier.memory.delete(oldest);
  }
  tier.memory.set(key, {
    serialized,
    expiresAtMs: Date.now() + Math.max(60, ttlSec) * 1_000,
  });
}

/** Test hook: drop the fallback tier (per-binding tiers die with their KV). */
export function resetKvCacheForTests(): void {
  fallbackTier.memory.clear();
  fallbackTier.inFlight.clear();
}

/** Read-through cache over CONFIG_KV. A miss or any KV error just recomputes. */
export async function cached<T>(
  env: Env,
  key: string,
  ttlSec: number,
  fn: () => Promise<T>,
): Promise<T> {
  // No KV binding at all (some test envs): preserve the historical
  // always-recompute behavior exactly — the memory tier must not invent
  // staleness where the KV fall-through previously guaranteed freshness.
  if (typeof (env as { CONFIG_KV?: unknown }).CONFIG_KV !== 'object' || env.CONFIG_KV === null) {
    try {
      const hit = await env.CONFIG_KV.get(key);
      if (hit) return JSON.parse(hit) as T;
    } catch { /* recompute below */ }
    return fn();
  }
  const tier = tierFor(env);
  const mem = memoryGet(tier, key, Date.now());
  if (mem !== null) return JSON.parse(mem) as T;

  const pending = tier.inFlight.get(key);
  if (pending) return JSON.parse(await pending) as T;

  const compute = (async (): Promise<string> => {
    try {
      const hit = await env.CONFIG_KV.get(key);
      if (hit) {
        memorySet(tier, key, hit, ttlSec);
        return hit;
      }
    } catch {
      /* fall through to compute */
    }
    const value = await fn();
    const serialized = JSON.stringify(value);
    memorySet(tier, key, serialized, ttlSec);
    try {
      await env.CONFIG_KV.put(key, serialized, { expirationTtl: Math.max(60, ttlSec) });
    } catch {
      /* best-effort cache; ignore */
    }
    return serialized;
  })();
  tier.inFlight.set(key, compute);
  try {
    return JSON.parse(await compute) as T;
  } finally {
    if (tier.inFlight.get(key) === compute) tier.inFlight.delete(key);
  }
}
