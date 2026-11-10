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
  /**
   * Daily closes for a ticker between two YYYY-MM-DD dates (descending).
   * The optional signal is the caller's cancellation (e.g. a cron lane's
   * deadline):  implementations that perform network I/O must thread it
   * into the request so an abort actually cancels the in-flight fetch
   * instead of leaving it running detached past the caller's deadline.
   * Every network implementation in this folder honors it — the peer
   * client, Massive, Tiingo, and the fallback chain (which also refuses
   * to start its secondary call on an already-aborted signal).  A future
   * implementation that cannot cancel in-flight I/O must say so at its
   * builder; silently dropping the signal is a contract violation,
   * because callers classify a rejection by identity against the
   * signal's reason and settle their runs on that basis.
   */
  eodHistory(symbol: string, from: string, to: string, signal?: AbortSignal): Promise<Close[]>;
  /** S&P 500 daily closes (via SPY) between two dates (descending). */
  spxHistory(from: string, to: string, signal?: AbortSignal): Promise<Close[]>;
}
