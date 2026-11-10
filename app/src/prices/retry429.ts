/**
 * src/prices/retry429.ts
 * OWNER: prices
 *
 * Bounded 429 retry for the unmetered price providers (Massive, Tiingo). Their
 * API keys are shared across several sibling apps, so per-minute
 * "maximum requests per minute" 429s are routine and self-clearing — retry with
 * exponential backoff before giving up, instead of letting the first 429 of the
 * day sink the whole price refresh.
 */

export interface Retry429Options {
  /** Sleep between attempts; injectable so tests don't wait real seconds. */
  sleep?: (ms: number) => Promise<void>;
  /** Randomness source for jitter; injectable for deterministic tests. */
  random?: () => number;
  /**
   * Caller's cancellation signal.  When supplied, the backoff wait between
   * attempts is bound to it:  an abort during the wait rejects with
   * `signal.reason` instead of sleeping through the caller's deadline.
   */
  signal?: AbortSignal;
}

/** Base waits before retries 1..3 (ms), jittered ±20% per attempt. */
const RETRY_WAITS_MS = [5_000, 15_000, 30_000];
/** Never wait longer than this, even if a Retry-After header asks for more. */
const MAX_WAIT_MS = 60_000;

function waitMs(res: Response, attempt: number, random: () => number): number {
  const retryAfterSec = Number(res.headers.get('retry-after') ?? '');
  if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
    return Math.min(retryAfterSec * 1000, MAX_WAIT_MS);
  }
  const base = RETRY_WAITS_MS[Math.min(attempt, RETRY_WAITS_MS.length - 1)];
  return Math.min(Math.round(base * (0.8 + 0.4 * random())), MAX_WAIT_MS);
}

/**
 * Sleep for `ms`, unless `signal` fires first — then reject with
 * `signal.reason`.  Without a signal this is exactly the injected sleep.
 * The listener is removed when the sleep wins the race, so an abort that
 * lands after the wait settled never touches it.
 */
async function sleepWithAbort(
  ms: number,
  signal: AbortSignal | undefined,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  if (!signal) {
    await sleep(ms);
    return;
  }
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([sleep(ms), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Run `call`, retrying HTTP 429 responses with bounded exponential backoff: the
 * initial attempt plus up to 3 retries (~5s/15s/30s, jittered; a Retry-After
 * header is honored, capped at 60s). Any other status — success or failure —
 * is returned as-is on the first attempt. The final 429 response is returned
 * once the retry budget is exhausted, for the caller to classify. When
 * `opts.signal` is supplied, a caller abort during a backoff wait rejects
 * with the abort reason instead of waiting out the sleep.
 */
export async function with429Retries(
  call: () => Promise<Response>,
  opts: Retry429Options = {},
): Promise<Response> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = opts.random ?? Math.random;
  let res = await call();
  for (let attempt = 0; attempt < RETRY_WAITS_MS.length && res.status === 429; attempt++) {
    await sleepWithAbort(waitMs(res, attempt, random), opts.signal, sleep);
    res = await call();
  }
  return res;
}
