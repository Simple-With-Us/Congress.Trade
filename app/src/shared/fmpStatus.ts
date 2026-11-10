/**
 * src/shared/fmpStatus.ts
 * Shared classification of FMP HTTP failures. Most non-200s from FMP (e.g. 404
 * for an unknown symbol) just mean "no data" and should be swallowed — but a few
 * statuses mean the *key/plan itself* is broken (invalid key, plan lapsed, or
 * rate-limited because you've effectively dropped to free). Those are surfaced
 * as tagged errors.  FMP is used only by the latency probes
 * (ingestion/tradeLatency.ts), never for prices or enrichment.
 */

/** Statuses that indicate the FMP key/plan is failing (not just "symbol not found"). */
export const FMP_TIER_FAIL_STATUSES = [401, 402, 403, 429];

/**
 * Throw a tagged error for a tier-failure status; no-op otherwise. Callers use
 * this on a non-OK FMP response, then fall back to their "no data" result for
 * any status this doesn't throw on (404, 5xx, …).
 */
export function assertFmpTierOk(status: number): void {
  if (FMP_TIER_FAIL_STATUSES.includes(status)) {
    throw new Error('FMP_HTTP_' + status);
  }
}

