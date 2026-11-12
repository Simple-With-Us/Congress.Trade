# 2026-11-12 — SQLite WAL checkpoint and free-page report

## Summary

CT-2484 adds `scripts/ops/sqlite-maintenance.sh`, an operator script for a configurable list of SQLite databases.  It reports file size, WAL size, SHM size, page size, page count, freelist count, and reclaimable bytes (`freelist_count * page_size`) as human text or `--json`.  The default write is `PRAGMA wal_checkpoint(PASSIVE)`.  `RESTART` and `TRUNCATE` run only when `--checkpoint` names them, and that call sets `PRAGMA busy_timeout` first.  `--vacuum` is opt-in and fail-closed.

Plain `VACUUM` is used.  `congress-app` and Litestream keep the live file open, so `VACUUM INTO` plus a rename would leave those processes writing the old inode while the path points at the new file.  Plain `VACUUM` rewrites the same file under an exclusive lock.  On a multi-gigabyte database that lock lasts on the order of minutes, and longer while the root disk is busy.  Writers block until it finishes.  PASSIVE does not take that lock and does not shrink the main file.

VACUUM runs only when free disk is at least 2.5 times the main file size, a backup marker is fresh within a configurable number of hours, the docker deploy probe is idle, `PRAGMA integrity_check` is ok, and this process holds the lock.  A missing, stale, or not-ok marker refuses the run.  If docker cannot be asked, VACUUM is refused.  The probe matches the existing builder-name check (`nixpacks`, `coolify-builder`, `buildkit`) and the `congress-app` Created / Restarting / health-starting check.  The script does not read a Coolify token.  `DRY_RUN=1` reports and evaluates the guards, then skips the checkpoint and VACUUM.  The script never deletes a database, its `-wal`, or its `-shm`.

Host install is out of scope and waits for Jay.  This change does not SSH to the host and does not edit the CT-2471 or CT-2472 scripts.

## Files changed

- `scripts/ops/sqlite-maintenance.sh`
- `scripts/ops/test-sqlite-maintenance.sh`
- `scripts/ops/systemd.noindex/sqlite-maintenance.service`
- `scripts/ops/systemd.noindex/sqlite-maintenance.timer` (weekly report plus PASSIVE only)
- `.github/workflows/ci.yml` (runs the offline test)
- `docs/rollouts/2026-11-12-sqlite-wal-checkpoint.md`

## Verification

`bash scripts/ops/test-sqlite-maintenance.sh` builds temporary SQLite databases and does not contact the production host.  It checks the report math, PASSIVE as the default, explicit restart/truncate with `busy_timeout`, JSON, the lock, and every VACUUM guard.  A guarded VACUUM on a temp database shrinks the freelist and leaves the file and rows in place.

## Follow-ups

Install and enable the sample units only after Jay says yes.  Point `SQLITE_BACKUP_MARKER` at a stamp written after a verified Congress.Trade backup.  `fleet-backup-verify-weekly.sh` does not write that stamp, and this change does not modify it, so VACUUM stays fail-closed until an operator supplies a fresh marker.  Do not schedule VACUUM from the weekly timer.
