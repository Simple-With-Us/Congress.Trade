/**
 * Persistent cron-tick failure signal.
 *
 * A deadline abort or SQLITE_BUSY lock skip used to die in the process log
 * and Sentry.  `/api/health` now reads this KV row for `cron_deadline`, and
 * the liveness-alarm sweep pages from that check.  A later tick that actually
 * finishes clears the row.  Overlap skips that are not lock errors do not
 * record, and do not clear, an open episode.
 */
import type { Env } from './types.ts';

export const CRON_TICK_OVERRUN_KV_KEY = 'cron:tick-overrun';
/** How long a recorded overrun stays loud on health. */
export const CRON_TICK_OVERRUN_LOUD_MS = 6 * 60 * 60 * 1000;
/** Collapse the hard-timeout path and a racing abort into one episode. */
const DEDUPE_MS = 60_000;
/** Repeated overruns inside the loud window escalate past a silent notify. */
export const CRON_TICK_OVERRUN_CRITICAL_COUNT = 3;

export interface CronTickOverrun {
  at: string;
  deadlineMs: number;
  reason: string;
  count: number;
}

export function tickOutcomeShouldRecord(input: {
  skippedOverlap: boolean;
  aborted: boolean;
  errors: readonly string[];
}): string | null {
  if (input.aborted) {
    return input.errors.find((entry) => /deadline|aborted|stuck/i.test(entry))
      ?? 'scheduled tick aborted';
  }
  if (input.skippedOverlap) {
    return input.errors.find((entry) =>
      /sqlite_busy|database is locked|sql statements in progress/i.test(entry)
    ) ?? null;
  }
  return null;
}

export function cronOverrunIsLoud(
  overrun: CronTickOverrun | null | undefined,
  nowMs: number,
  windowMs = CRON_TICK_OVERRUN_LOUD_MS,
): boolean {
  if (!overrun) return false;
  const at = Date.parse(overrun.at);
  if (!Number.isFinite(at)) return false;
  return nowMs >= at && nowMs - at <= windowMs;
}

function parseOverrun(raw: unknown): CronTickOverrun | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Partial<CronTickOverrun>;
  if (typeof row.at !== 'string' || typeof row.reason !== 'string') return null;
  return {
    at: row.at,
    deadlineMs: Number(row.deadlineMs) || 0,
    reason: row.reason,
    count: Number.isFinite(Number(row.count)) && Number(row.count) > 0 ? Number(row.count) : 1,
  };
}

export async function readCronTickOverrun(env: Env): Promise<CronTickOverrun | null> {
  try {
    const raw = await env.CONFIG_KV.get<unknown>(CRON_TICK_OVERRUN_KV_KEY, 'json');
    return parseOverrun(raw);
  } catch {
    return null;
  }
}

export async function recordCronTickOverrun(
  env: Env,
  input: { deadlineMs: number; reason: string; now?: Date },
): Promise<CronTickOverrun | null> {
  const now = input.now ?? new Date();
  const reason = input.reason.slice(0, 500);
  const prev = await readCronTickOverrun(env);
  const prevAt = prev ? Date.parse(prev.at) : NaN;
  const age = Number.isFinite(prevAt) ? now.getTime() - prevAt : Number.POSITIVE_INFINITY;
  const sameEpisode = prev != null && age >= 0 && age <= CRON_TICK_OVERRUN_LOUD_MS;
  const next: CronTickOverrun = {
    at: sameEpisode && age < DEDUPE_MS ? prev.at : now.toISOString(),
    deadlineMs: input.deadlineMs,
    reason,
    count: sameEpisode ? (age < DEDUPE_MS ? prev.count : prev.count + 1) : 1,
  };
  try {
    await env.CONFIG_KV.put(CRON_TICK_OVERRUN_KV_KEY, JSON.stringify(next));
  } catch {
    return null;
  }
  return next;
}

export async function clearCronTickOverrun(env: Env): Promise<void> {
  try {
    await env.CONFIG_KV.delete(CRON_TICK_OVERRUN_KV_KEY);
  } catch {
    /* a missed clear ages out via CRON_TICK_OVERRUN_LOUD_MS */
  }
}
