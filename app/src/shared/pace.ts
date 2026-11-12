/**
 * src/shared/pace.ts
 * OWNER: shared
 *
 * Tiny per-minute rate pacer for outbound API calls. On a paid FMP tier the
 * limit is per-MINUTE (e.g. ~300/min), so a fast backfill can trip 429s if it
 * fires calls back-to-back. `createPacer(maxPerMinute)` returns an async gate to
 * `await` immediately before each call; it sleeps only as much as needed to keep
 * the average rate at or below the cap. With no cap (undefined / <= 0) it is a
 * no-op, so existing callers and tests are unaffected.
 */
export function createPacer(maxPerMinute?: number): () => Promise<void> {
  if (!maxPerMinute || maxPerMinute <= 0) return async () => {};
  const minGapMs = Math.ceil(60000 / maxPerMinute);
  // `next` is the earliest timestamp the NEXT call may fire. Each invocation
  // claims its slot synchronously — advancing `next` BEFORE it awaits — so
  // callers that enter concurrently (house+senate via Promise.all, or an
  // enrichment run overlapping the probe in the same isolate) are handed
  // distinct, staggered slots instead of all reading one stale timestamp and
  // firing together. Reads/writes of `next` never straddle an await, so the
  // single-threaded event loop makes this reservation race-free.
  let next = 0;
  return async () => {
    const now = Date.now();
    const scheduled = Math.max(now, next);
    next = scheduled + minGapMs;
    const wait = scheduled - now;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  };
}

/**
 * Ceiling for every Socratic.Trade (ST) peer read this app paces:  profile
 * enrichment, EOD price refresh, the price catch-up and the not-covered
 * re-check.  ST's `peerRead` limiter allows 120 requests a minute for ALL of
 * this app's peer reads together, so a configured value above this is clamped,
 * and an unset value paces at this ceiling instead of not at all.
 */
export const ST_PEER_SAFE_MAX_PER_MINUTE = 100;

/**
 * The configured ST peer pace from ST_PEER_MAX_PER_MINUTE, as resolved through
 * the Infisical-backed settings path (resolveSecrets).  Undefined when it is not
 * a positive integer.  getSharedStPeerPacer applies the ceiling.
 */
export function stPeerMaxPerMinute(vars: { ST_PEER_MAX_PER_MINUTE?: string }): number | undefined {
  const n = parseInt(vars.ST_PEER_MAX_PER_MINUTE || '', 10);
  return n > 0 ? n : undefined;
}

/** The setting name to resolve for stPeerMaxPerMinute. */
export const ST_PEER_PACE_SECRET_NAMES = ['ST_PEER_MAX_PER_MINUTE'] as const;

/** A requested pace clamped to (0, ST_PEER_SAFE_MAX_PER_MINUTE];  unset means the ceiling. */
export function clampStPeerMaxPerMinute(maxPerMinute?: number): number {
  if (!maxPerMinute || !(maxPerMinute > 0)) return ST_PEER_SAFE_MAX_PER_MINUTE;
  return Math.min(Math.floor(maxPerMinute), ST_PEER_SAFE_MAX_PER_MINUTE) || 1;
}

/**
 * Process-wide pacer shared by every ST peer-read consumer (enrichment, price
 * refresh, catch-up, not-covered re-check). Each of those used to build its
 * OWN `createPacer(...)` per invocation, so two runs firing concurrently in the
 * same isolate would each see only their own calls and could jointly exceed the
 * per-minute cap. Drawing them all from this single closure serializes their
 * calls against one shared minute-rate gate.  The disclosure-latency probe has
 * its own FMP pacer and does not use this one.
 *
 * One module-scope clock for the lifetime of the isolate.  Each (clamped) cap
 * gets its own gap width on that clock, so an Infisical-live change to the
 * setting takes effect on the next call without resetting the clock.
 *
 * NOTE: this coordinates only calls made within the SAME isolate. Multiple
 * concurrent isolates do not share this closure, so this is NOT a global
 * cross-instance rate limit.
 */
// One clock for every ST consumer.  A caller asking for a slower pace (the
// catch-up's 60/min) gets a wider gap on the SAME clock, so the combined rate
// never exceeds the fastest requested cap, which is itself clamped.  The old
// "rebuild when the cap changes" design gave each cap its own clock (Kody on
// #2859), so two consumers could jointly exceed ST's limit.
let stPeerNext = 0;
const stPeerPacers = new Map<number, () => Promise<void>>();
export function getSharedStPeerPacer(maxPerMinute?: number): () => Promise<void> {
  const cap = clampStPeerMaxPerMinute(maxPerMinute);
  let pacer = stPeerPacers.get(cap);
  if (!pacer) {
    const minGapMs = Math.ceil(60000 / cap);
    // Same synchronous slot reservation as createPacer, against the shared clock.
    pacer = async () => {
      const now = Date.now();
      const scheduled = Math.max(now, stPeerNext);
      stPeerNext = scheduled + minGapMs;
      const wait = scheduled - now;
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    };
    stPeerPacers.set(cap, pacer);
  }
  return pacer;
}

/** Test-only: drop the shared clock so each test starts from a clean gate. */
export function __resetSharedStPeerPacerForTests(): void {
  stPeerNext = 0;
  stPeerPacers.clear();
}

/**
 * Process-wide SEC EDGAR pacer. SEPARATE from the FMP pacer above and NOT
 * drawn from the same budget: EDGAR is a different provider with its own
 * fair-access limit (SEC documents an approx 10 req/s ceiling), independent of
 * FMP's per-minute plan cap. Same lazily-created, memoized-at-module-scope
 * singleton shape as `getSharedStPeerPacer` — see that doc comment for the
 * per-isolate-only caveat and the ceiling-change rebuild logic,
 * both of which apply here too.
 */
let sharedEdgarPacer: { pacer: () => Promise<void>; cap?: number } | null = null;
export function getSharedEdgarPacer(maxPerMinute?: number): () => Promise<void> {
  if (!sharedEdgarPacer || sharedEdgarPacer.cap !== maxPerMinute) {
    sharedEdgarPacer = { pacer: createPacer(maxPerMinute), cap: maxPerMinute };
  }
  return sharedEdgarPacer.pacer;
}

/** Test-only: drop the memoized singleton so each test starts from a clean gate. */
export function __resetSharedEdgarPacerForTests(): void {
  sharedEdgarPacer = null;
}
