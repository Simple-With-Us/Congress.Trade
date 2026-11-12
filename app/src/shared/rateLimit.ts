/**
 * src/shared/rateLimit.ts
 *
 * Lightweight fixed-window rate limiter backed by CONFIG_KV. This is a
 * deliberately simple per-(bucket, identifier, window) counter — NOT a precise
 * token bucket — intended to blunt abuse of the few unauthenticated, cost- or
 * reputation-bearing endpoints (magic-link email send, public subscription
 * creation, heavy exports) that previously had no throttle at all.
 *
 * Design choices:
 * - Fails OPEN: any KV error allows the request, so a KV blip never 500s a
 *   public endpoint.
 * - KV is eventually consistent, so the count is approximate within a window —
 *   good enough to stop scripted bursts, not a billing-grade limiter. For
 *   strict per-request limits, migrate to Cloudflare's native Rate Limiting
 *   binding or a Durable Object counter; this module keeps the call sites
 *   identical if you do.
 * - CT-AUD-021 (partial): the auth buckets (magic-link send) additionally keep
 *   a per-isolate in-memory counter that increments SYNCHRONOUSLY before the
 *   first await, closing the KV read-then-write race window within an isolate
 *   (a burst of N parallel requests all reading count=0 used to all pass).
 *   Cross-isolate precision still requires the Durable Object migration —
 *   deliberately out of scope here.
 */
import type { Env } from './types.ts';
import { clientIpFromOrigin, type OriginLockEnv } from '../security/originLock.ts';

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterSec: number;
}

type KvEnv = Env & { CONFIG_KV?: KVNamespace };

/**
 * Buckets guarding login/auth endpoints get the in-memory double-check. Scoped
 * to auth only (per CT-AUD-021): these endpoints send email / mint tokens, so
 * a same-isolate burst slipping through the KV race is the costliest case.
 */
const MEMORY_HARDENED_BUCKETS = new Set(['magic-ip', 'magic-email']);

/**
 * Per-isolate fixed-window counters, keyed `bucket|identifier|windowSec`.
 * Uses the RAW identifier (never hashed): hashing is async and would reopen
 * the race window this exists to close. Raw identifiers here are fine — this
 * map lives only in isolate memory and is never listed or persisted (the KV
 * PII concern hashIdentifier addresses does not apply).
 *
 * Isolate memory is best-effort by nature (isolates are recycled/evicted at
 * Cloudflare's discretion and each colo runs many), so this only TIGHTENS the
 * KV limiter; it can never be the sole enforcement.
 */
const memoryWindows = new Map<string, { windowStart: number; count: number }>();
/** Prune threshold so a long-lived isolate can't grow the map without bound. */
const MEMORY_WINDOWS_MAX = 2_000;

function pruneMemoryWindows(now: number): void {
  if (memoryWindows.size < MEMORY_WINDOWS_MAX) return;
  for (const [key, entry] of memoryWindows) {
    // The key's trailing segment is windowSec; a window is dead once its end passed.
    const windowSec = Number(key.slice(key.lastIndexOf('|') + 1));
    if (!Number.isFinite(windowSec) || entry.windowStart + windowSec <= now) {
      memoryWindows.delete(key);
    }
  }
  // Pathological case (all windows still live): drop oldest insertions.
  while (memoryWindows.size >= MEMORY_WINDOWS_MAX) {
    const oldest = memoryWindows.keys().next().value;
    if (oldest === undefined) break;
    memoryWindows.delete(oldest);
  }
}

/**
 * Synchronous in-memory admission check + count. Returns false when this
 * isolate alone has already admitted `limit` requests in the current window.
 * MUST run before any await so parallel same-isolate requests cannot
 * interleave around it.
 */
function memoryAdmit(
  bucket: string,
  identifier: string,
  limit: number,
  windowSec: number,
  now: number,
  windowStart: number,
): boolean {
  pruneMemoryWindows(now);
  const key = `${bucket}|${identifier}|${windowSec}`;
  const entry = memoryWindows.get(key);
  if (!entry || entry.windowStart !== windowStart) {
    memoryWindows.set(key, { windowStart, count: 1 });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count += 1;
  return true;
}

/**
 * Undo a single `memoryAdmit` increment for the current window. Called when the
 * KV read fails *after* the synchronous admit already counted the request: the
 * outage path must stay fully fail-open, so the in-memory counter must not
 * retain a charge for a request we are now allowing through. Without this, a
 * sustained KV read outage would latch the isolate counter at `limit` and lock
 * a user out of magic-link login for the rest of the window.
 */
function memoryRollback(
  bucket: string,
  identifier: string,
  windowSec: number,
  windowStart: number,
): void {
  const key = `${bucket}|${identifier}|${windowSec}`;
  const entry = memoryWindows.get(key);
  if (entry && entry.windowStart === windowStart && entry.count > 0) {
    entry.count -= 1;
  }
}

/** Test-only: clear the per-isolate counters between cases. */
export function resetMemoryRateLimitForTests(): void {
  memoryWindows.clear();
}

/**
 * Hash an identifier before it becomes part of a KV key name. `magic-email`
 * buckets on the raw submitted address; the magic-link endpoint is public and
 * accepts arbitrary addresses, so an unhashed key would leak victim email PII
 * into listable KV key metadata even when no login occurs. SHA-256 truncated
 * to 32 hex chars is plenty of collision resistance for a rate-limit bucket.
 */
async function hashIdentifier(identifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identifier));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

/**
 * Returns ok=false when `identifier` has already made `limit` requests in the
 * current `windowSec` window for `bucket`. Counting increments only when ok.
 *
 * Scope note: KV-backed buckets approximate a global cap (one counter per
 * window, fail-open on KV errors). The `pub-api` bucket is the documented
 * exception — it is enforced per-isolate only, never globally (see below).
 */
export async function rateLimit(
  env: KvEnv,
  bucket: string,
  identifier: string,
  limit: number,
  windowSec: number,
): Promise<RateLimitResult> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % windowSec);
  const retryAfterSec = windowStart + windowSec - now;

  // Fail open when KV is entirely absent — checked BEFORE the in-memory gate so
  // a missing binding can never surface as a 429. If the memory gate ran first
  // it would keep blocking per-isolate once `limit` was reached, defeating the
  // fail-open invariant these auth endpoints rely on. This check is synchronous,
  // so moving it up does not reopen the same-isolate race the memory gate closes.
  const kv = env.CONFIG_KV;
  if (!kv) return { ok: true, remaining: limit, retryAfterSec: 0 };

  // Auth buckets: synchronous same-isolate check FIRST (before any await), so
  // a parallel burst cannot all pass on the same stale KV read. Fail-open
  // semantics are preserved for everything else: memory only ever blocks when
  // this isolate itself has demonstrably admitted `limit` requests already.
  if (
    (MEMORY_HARDENED_BUCKETS.has(bucket) || bucket === 'pub-api')
    && !memoryAdmit(bucket, identifier, limit, windowSec, now, windowStart)
  ) {
    return { ok: false, remaining: 0, retryAfterSec };
  }

  // To save Deno KV write quota on highly-polled public feeds, pub-api is
  // exclusively enforced in-memory per-isolate. There is deliberately NO
  // global counter for this bucket: the effective ceiling is `limit` requests
  // per window PER ISOLATE, so the true cross-region cap is up to
  // limit × (active isolates). Callers must not document or rely on `limit`
  // as a global cap for pub-api — it is a per-isolate approximation.
  if (bucket === 'pub-api') {
    return { ok: true, remaining: limit - 1, retryAfterSec: 0 };
  }

  const key = `rl:${bucket}:${await hashIdentifier(identifier)}:${windowStart}`;

  let count = 0;
  try {
    const cur = await kv.get(key);
    count = cur ? parseInt(cur, 10) || 0 : 0;
  } catch {
    // KV read failed: fail open, and roll back the in-memory admit counted
    // above so a sustained outage cannot latch the per-isolate counter at the
    // limit and lock the user out — the outage path must stay fully fail-open.
    memoryRollback(bucket, identifier, windowSec, windowStart);
    return { ok: true, remaining: limit, retryAfterSec: 0 };
  }

  if (count >= limit) {
    return { ok: false, remaining: 0, retryAfterSec };
  }

  try {
    // Expire a little past the window so stale counters self-clean.
    await kv.put(key, String(count + 1), { expirationTtl: windowSec + 5 });
  } catch {
    // Write failed: fail open AND roll back the in-memory admit, so a KV write
    // outage (reads succeed, writes throw) cannot latch a per-isolate block for
    // the rest of the window either. Matches the read-failure path above.
    memoryRollback(bucket, identifier, windowSec, windowStart);
  }
  return { ok: true, remaining: limit - count - 1, retryAfterSec: 0 };
}

/**
 * Best-effort client IP for rate-limit keys.
 *
 * CF-Connecting-IP and X-Forwarded-For are trusted only once the socket peer
 * (or a trusted proxy's asserted peer) is Cloudflare, or the origin secret /
 * Authenticated Origin Pulls check says the edge injected the request.
 * A direct caller can no longer pick a rate-limit identity by sending those
 * headers. See src/security/originLock.ts.
 */
export function clientIp(req: Request, env?: OriginLockEnv): string {
  return clientIpFromOrigin(req, env);
}
