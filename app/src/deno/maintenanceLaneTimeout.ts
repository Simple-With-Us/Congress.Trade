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
  run: () => Promise<T>,
): Promise<T> {
  const budgetMs = Math.max(1, timeoutMs);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new MaintenanceLaneTimeoutError(lane, budgetMs)),
      budgetMs,
    );
  });
  try {
    return await Promise.race([run(), timeoutPromise]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
