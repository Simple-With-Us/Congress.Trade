/**
 * Per-lane wall-clock budgets for the shared maintenance pipeline.  One hung lane
 * must not hold the global tick abort hostage until the soft deadline fires.
 */

export class MaintenanceLaneTimeoutError extends Error {
  readonly lane: string;
  readonly timeoutMs: number;

  constructor(lane: string, timeoutMs: number) {
    super(`maintenance lane ${lane} timed out after ${timeoutMs}ms`);
    this.name = 'MaintenanceLaneTimeoutError';
    this.lane = lane;
    this.timeoutMs = timeoutMs;
  }
}

export function isMaintenanceLaneTimeout(err: unknown): boolean {
  return err instanceof MaintenanceLaneTimeoutError;
}

export async function raceMaintenanceLane<T>(
  lane: string,
  timeoutMs: number,
  run: (laneSignal: AbortSignal) => Promise<T>,
): Promise<T> {
  const budgetMs = Math.max(1, timeoutMs);
  const ctrl = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      const err = new MaintenanceLaneTimeoutError(lane, budgetMs);
      ctrl.abort(err);
      reject(err);
    }, budgetMs);
  });
  let innerPromise: Promise<T> | undefined;
  const startInner = () => (innerPromise ??= Promise.resolve().then(() => run(ctrl.signal)));
  const inner = startInner();
  // A timed-out lane loses the race but keeps running; observe its
  // settlement so a late rejection is never an unhandled rejection, and
  // give it a short grace to stop at its next signal boundary before the
  // pipeline starts the next lane on the single connection (CT-2459).
  let innerSettled = false;
  const innerDone = inner.then(
    () => { innerSettled = true; },
    () => { innerSettled = true; },
  );
  try {
    return await Promise.race([inner, timeoutPromise]);
  } catch (err) {
    if (isMaintenanceLaneTimeout(err) && !innerSettled) {
      await Promise.race([
        innerDone,
        new Promise((resolve) => setTimeout(resolve, Math.min(5_000, budgetMs))),
      ]);
    }
    throw err;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
