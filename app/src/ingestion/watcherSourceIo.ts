/**
 * Per-source network budgets for the watcher maintenance lane (~22s total).
 * Without these, one slow House/Senate/OGE fetch can consume the whole lane
 * (CONGRESS-TRADE-1V) even though the tick signal is threaded through.
 */

/** Wall-clock budget for a single source poll's outbound I/O. */
export const WATCHER_SOURCE_IO_BUDGET_MS = 7_000;

/**
 * Merge the tick abort signal with a per-source I/O timeout so Senate/OGE still
 * run when House is slow, and the lane finishes inside its maintenance budget.
 */
export function watcherSourceIoSignal(tickSignal?: AbortSignal): AbortSignal | undefined {
  const budget = AbortSignal.timeout(WATCHER_SOURCE_IO_BUDGET_MS);
  if (!tickSignal) return budget;
  return AbortSignal.any([tickSignal, budget]);
}
