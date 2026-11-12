# 2026-08-13 — Skip empty `/data/prod.db` in the 6h fleet dump

## Summary

`fleet-sqlite-backup.sh` dumped `/data/prod.db` (a 0-byte leftover) as
`usage-monitor-YYYY.db` (4 KB empty SQLite) every 6h, then also dumped the real
Coolify volume as `usage-monitor-vol-*.db` (251 MB).  The empty file is not a
usable restore.  Host script now skips empty sources.  The volume dump + B2
offsite copy were already the real UM backup.

## Files changed

- Host: `/usr/local/sbin/fleet-sqlite-backup.sh` (backup
  `fleet-sqlite-backup.sh.bak-20260813T2300Z`).
- Repo: `scripts/ops/fleet-sqlite-backup.sh` (first tracked copy of the live
  host script, with the empty-file skip).

## Verification

- Host script contains `SKIP $name (empty $src)`.
- Next cron at :15 past 00/06/12/18 UTC should log skip for
  `usage-monitor` and still write `usage-monitor-vol-*`.
- Live UM `/api/ready` backup layers stay ok (B2 Litestream ~minutes, weekly
  R2 archive, volume dump ~6h).

## Follow-ups

- `/data/prod.db` 0-byte leftover can be removed in a later hygiene pass.
  Do not delete it from this change.
