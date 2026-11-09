/**
 * src/prices/types.ts
 * OWNER: prices
 *
 * The price-client contract every price source implements (peer, Massive,
 * Tiingo, the fallback chain).  Prices come from peers only; FMP is never a
 * price source.
 */

import type { Close } from './compute.ts';

export interface PriceClient {
  /** Daily closes for a ticker between two YYYY-MM-DD dates (descending). */
  eodHistory(symbol: string, from: string, to: string): Promise<Close[]>;
  /** S&P 500 daily closes (via SPY) between two dates (descending). */
  spxHistory(from: string, to: string): Promise<Close[]>;
}
