# 2026-11-12 — Read-only B2 hetzner/ backup size and retention report (CT-2493)

## Summary

Adds a report-only operator script that inventories fleet Hetzner SQLite dump
objects under each app bucket’s `hetzner/` prefix in Backblaze B2.  It totals
bytes and counts by bucket, top-level path prefix, and age bracket; compares
against `B2_MAX_AGE_DAYS` (default 14, same as `fleet-sqlite-backup.sh`); and
exits non-zero when a bucket has no object newer than 26 hours, when objects
exceed the retention age, or when summed bytes pass `B2_REPORT_TOTAL_BYTES_CAP`.
Nothing is deleted, hidden, or uploaded.

## Files changed

- `scripts/ops/b2-backup-report.sh` — host entrypoint (python3 wrapper)
- `scripts/ops/b2_backup_report.py` — listing + aggregation (`b2` CLI or `aws s3api`)
- `scripts/ops/test-b2-backup-report.sh` — offline tests with JSON fixtures
- `.github/workflows/ci.yml` — runs offline test in PR CI

## Verification

Offline (CI and local):

```bash
bash scripts/ops/test-b2-backup-report.sh
```

After merge, on the fleet box only with Jay’s approval — credentials already
used by rclone / fleet backup, never printed:

```bash
bash scripts/ops/b2-backup-report.sh
bash scripts/ops/b2-backup-report.sh --json
```

Expect exit `0` when all three buckets have dumps within 26h and no object is
older than `B2_MAX_AGE_DAYS`.  Exit `1` warns on retention drift or byte cap;
exit `2` crit when any expected bucket is stale.

## Follow-ups

- Optional cron or PagerDuty hook after first live dry run on Hetzner.
- Wire into macOS background jobs list if scheduled on the box.
