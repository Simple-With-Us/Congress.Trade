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
  ): Promise<Close[]> {
    try {
      const closes = await runPrimary();
      if (closes && closes.length > 0) {
        return closes;
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e ?? '');
      if (opts.rethrowFatal && FATAL_PRIMARY_ERROR.test(message)) throw e;
    }
    return runSecondary();
  }

  return {
    eodHistory: (symbol, from, to) =>
      tryPrimaryThenSecondary(
        () => primary.eodHistory(symbol, from, to),
        () => secondary.eodHistory(symbol, from, to),
      ),
    spxHistory: (from, to) =>
      tryPrimaryThenSecondary(
        () => primary.spxHistory(from, to),
        () => secondary.spxHistory(from, to),
      ),
  };
}
