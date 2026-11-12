/**
 * Weekly R2 archive status for /api/health.
 *
 * Reads a local JSON receipt written by scripts/ops/fleet-sqlite-backup.sh
 * after a successful Sunday copy to r2:<bucket>/weekly/.  No network, no
 * credentials — UM fleet backup and humans can see "R2 weekly is fine"
 * without listing the bucket on the health path.
 */

export const DEFAULT_R2_ARCHIVE_STATUS_PATH = "/data/congress-trade/.r2-archive-status.json";

/** One missed Sunday is still fine; two is not.  Matches Usage Monitor. */
export const R2_WEEKLY_MAX_AGE_SECONDS = 8 * 24 * 60 * 60;

export interface R2WeeklyArchiveStatus {
  ok: boolean;
  ageSeconds: number | null;
  key: string | null;
  reason: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function parseR2WeeklyArchiveStatus(
  raw: string,
  nowMs: number = Date.now(),
): R2WeeklyArchiveStatus {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, ageSeconds: null, key: null, reason: "archive_status_unreadable" };
  }
  if (!isRecord(parsed)) {
    return { ok: false, ageSeconds: null, key: null, reason: "archive_status_unreadable" };
  }

  const key = readText(parsed.key);
  const completedAt = readText(parsed.completedAt) || readText(parsed.checkedAt);
  const completedMs = completedAt ? Date.parse(completedAt) : Number.NaN;
  const ageSeconds = Number.isFinite(completedMs)
    ? Math.max(0, Math.round((nowMs - completedMs) / 1000))
    : null;

  if (parsed.ok !== true) {
    return {
      ok: false,
      ageSeconds,
      key,
      reason: readText(parsed.reason) && /^[a-z_]{1,40}$/.test(String(parsed.reason))
        ? String(parsed.reason)
        : "archive_failed",
    };
  }

  if (ageSeconds === null) {
    return { ok: false, ageSeconds: null, key, reason: "archive_not_run" };
  }
  if (ageSeconds > R2_WEEKLY_MAX_AGE_SECONDS) {
    return { ok: false, ageSeconds, key, reason: "archive_stale" };
  }
  return { ok: true, ageSeconds, key, reason: null };
}

export async function readR2WeeklyArchiveStatus(
  path: string = DEFAULT_R2_ARCHIVE_STATUS_PATH,
  nowMs: number = Date.now(),
): Promise<R2WeeklyArchiveStatus> {
  const readTextFile = (globalThis as {
    Deno?: { readTextFile: (p: string) => Promise<string> };
  }).Deno?.readTextFile;
  if (!readTextFile) {
    return { ok: false, ageSeconds: null, key: null, reason: "archive_not_run" };
  }
  try {
    const raw = await readTextFile(path);
    return parseR2WeeklyArchiveStatus(raw, nowMs);
  } catch {
    return { ok: false, ageSeconds: null, key: null, reason: "archive_not_run" };
  }
}
