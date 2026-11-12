import { describe, expect, it } from "vitest";
import {
  parseR2WeeklyArchiveStatus,
  R2_WEEKLY_MAX_AGE_SECONDS,
} from "../r2WeeklyArchive.ts";

const NOW = Date.parse("2026-08-14T18:00:00Z");

describe("parseR2WeeklyArchiveStatus", () => {
  it("is ok when the last success is inside the 8-day window", () => {
    const raw = JSON.stringify({
      ok: true,
      key: "weekly/congress-trade-20260812T040000Z.db",
      completedAt: "2026-08-12T04:00:00Z",
    });
    const status = parseR2WeeklyArchiveStatus(raw, NOW);
    expect(status.ok).toBe(true);
    expect(status.reason).toBeNull();
    expect(status.key).toBe("weekly/congress-trade-20260812T040000Z.db");
    expect(status.ageSeconds).toBe(Math.round((NOW - Date.parse("2026-08-12T04:00:00Z")) / 1000));
  });

  it("is stale after eight days", () => {
    const completedAt = new Date(NOW - (R2_WEEKLY_MAX_AGE_SECONDS + 60) * 1000).toISOString();
    const status = parseR2WeeklyArchiveStatus(
      JSON.stringify({ ok: true, key: "weekly/old.db", completedAt }),
      NOW,
    );
    expect(status).toEqual({
      ok: false,
      ageSeconds: R2_WEEKLY_MAX_AGE_SECONDS + 60,
      key: "weekly/old.db",
      reason: "archive_stale",
    });
  });

  it("treats a failed receipt as not fine without inventing a fresh age", () => {
    const status = parseR2WeeklyArchiveStatus(
      JSON.stringify({ ok: false, reason: "rclone_failed", checkedAt: "2026-08-14T17:00:00Z" }),
      NOW,
    );
    expect(status.ok).toBe(false);
    expect(status.reason).toBe("rclone_failed");
  });

  it("rejects garbage JSON", () => {
    expect(parseR2WeeklyArchiveStatus("not-json", NOW)).toEqual({
      ok: false,
      ageSeconds: null,
      key: null,
      reason: "archive_status_unreadable",
    });
  });
});
