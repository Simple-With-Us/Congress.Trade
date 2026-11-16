/**
 * src/prices/fallback.ts
 * OWNER: prices
 *
 * A fallback price client that tries a primary client first, and if it fails or
 * returns no data, falls back to a secondary client.  When PRICE_PROVIDER=peer,
 * Massive is the last-resort secondary — never a parallel primary.
 */

import type { Close } from './compute.ts';
import type { PriceClient } from './types.ts';

/**
 * Auth/plan failures on the primary (peer 401/402/403) must stay fail-closed.
 * Swallowing them would silently spend the shared Massive key.  Transient
 * empties / 5xx / network still fall through to last-resort.
 */
const FATAL_PRIMARY_ERROR = /_HTTP_(401|402|403)$/;

export interface FallbackPriceClientOptions {
  /**
   * When true, rethrow primary 401/402/403 instead of calling the secondary.
   * Used for peer-primary + Massive last-resort.
   */
  rethrowFatal?: boolean;
}

export function buildFallbackPriceClient(
  primary: PriceClient,
  secondary: PriceClient,
  opts: FallbackPriceClientOptions = {},
): PriceClient {
  async function tryPrimaryThenSecondary(
    runPrimary: () => Promise<Close[]>,
    runSecondary: () => Promise<Close[]>,
    signal?: AbortSignal,
  ): Promise<Close[]> {
    try {
      const closes = await runPrimary();
      if (closes && closes.length > 0) {
        return closes;
      }
    } catch (e) {
      // The caller's own cancellation is not a primary failure:  when the
      // rejection IS the caller's abort — identity against signal.reason,
      // the same test service.ts classifies with — rethrow it untouched
      // instead of swallowing it and falling through.  A genuine primary
      // failure that merely RACES the abort keeps its own error:  a blanket
      // throwIfAborted() here would replace a fatal 401/402/403 with the
      // abort reason, and service.ts would then classify the outage as a
      // quiet cancellation — no error entry, no fatal handling.
      if (signal?.aborted && e === signal.reason) throw e;
      const message = e instanceof Error ? e.message : String(e ?? '');
      if (opts.rethrowFatal && FATAL_PRIMARY_ERROR.test(message)) throw e;
    }
    // Never invoke the secondary on a dead signal:  the call cannot succeed,
    // and a secondary that ignores the signal would run detached past the
    // caller's deadline.  An abort that landed while the primary was
    // resolving (empty series, no rejection) surfaces here the same way.
    signal?.throwIfAborted();
    return runSecondary();
  }

  return {
    eodHistory: (symbol, from, to, signal) =>
      tryPrimaryThenSecondary(
        () => primary.eodHistory(symbol, from, to, signal),
        () => secondary.eodHistory(symbol, from, to, signal),
        signal,
      ),
    spxHistory: (from, to, signal) =>
      tryPrimaryThenSecondary(
        () => primary.spxHistory(from, to, signal),
        () => secondary.spxHistory(from, to, signal),
        signal,
      ),
  };
}
