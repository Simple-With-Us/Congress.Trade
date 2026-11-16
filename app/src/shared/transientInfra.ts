/**
 * Lock and cron-deadline failures are infrastructure, not a dead provider.
 *
 * SQLITE_BUSY / cron overruns must auto-retry and must not latch autopilot.
 * They are not a reason to change the file-SQLite concurrency or WAL settings
 * owned by the CONGRESS-TRADE-1J / 1M fix.
 */

export function isTransientInfrastructureError(message: string | null | undefined): boolean {
  const m = (message ?? '').toLowerCase();
  if (!m) return false;
  return (
    m.includes('sqlite_busy')
    || m.includes('database is locked')
    || m.includes('sql statements in progress')
    || m.includes('deno cron tick exceeded')
    || m.includes('deno cron tick nearing')
    || m.includes('deno cron tick stuck')
    || m.includes('scheduled tick aborted')
  );
}
