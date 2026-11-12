/**
 * Production Sentry noise filters (server SDK beforeSend).
 */

function eventMessage(event: unknown): string | undefined {
  if (!event || typeof event !== 'object') return undefined;
  const row = event as {
    message?: string;
    logentry?: { message?: string };
  };
  if (typeof row.message === 'string' && row.message.length > 0) return row.message;
  if (typeof row.logentry?.message === 'string' && row.logentry.message.length > 0) {
    return row.logentry.message;
  }
  return undefined;
}

/** Drop operational signals that have a dedicated publisher / health path. */
export function sentryOperationalNoiseShouldDrop(event: unknown): boolean {
  const message = eventMessage(event);
  if (!message) return false;
  if (message.startsWith('Pipeline stall recovered:')) return true;
  return false;
}

/** Browser global-handler noise (bots parsing HTML as JSON). */
export const SENTRY_BROWSER_IGNORE_ERRORS = [
  'Unexpected end of input',
] as const;
