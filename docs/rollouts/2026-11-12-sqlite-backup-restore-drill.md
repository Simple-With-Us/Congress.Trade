# 2026-11-12 — weekly sqlite backup restore drill (CT-2491)

## Summary

CT-2491 adds an offline-tested restore drill for the newest local sqlite dump written by `scripts/ops/fleet-sqlite-backup.sh`.  The drill copies that dump into its own temp directory, runs `PRAGMA integrity_check` and `PRAGMA quick_check`, opens the key tables, and prints PASS or FAIL with a duration.  CT-1685 remains the host-loss runbook (new host, Litestream from B2, Coolify, DNS, and a measured RTO).  This drill is the local proof that the newest dump opens.

## What it does

The script reads `/data/backups/<app>/`, the same root `fleet-sqlite-backup.sh` uses.  `/data/backups` is a symlink chain onto `/backups`.  Dump names are `<name>-<YYYYMMDDTHHMMSSZ>.db`, or `<name>-<YYYYMMDDTHHMMSSZ>.db.zst` once the local zstd step from CT-2472 is on the box.  The `.sha256` sidecar is the raw database hash.  The default app is `congress`.  `FLEET_BACKUP_DRILL_APPS` can add `socratic` and `usage-monitor`.

`FLEET_BACKUP_DRILL_WORKDIR` (default `/var/tmp/fleet-backup-restore-drill`) chooses the filesystem for the temp copy.  Free space under 1.5 times the restored size fails closed.  A plain dump uses its byte size.  A compressed dump uses the zstd frame content size, and an unknown size fails closed before any write.  `nice` and `ionice` wrap the process.  The lock file `/var/lock/fleet-backup-restore-drill.lock` stops a second drill, and a held lock is a failure.  Live databases and existing dumps are never opened for write and are never deleted.  The exit trap removes only the `drill.*` directory this run created.  The sqlite3 CLI is opened read-only, and `-nofollow` is added only when that build accepts it.

`--json` prints one JSON object after the PASS or FAIL line.  Key tables default to `filers`, `filings`, and `transactions`.  Schema version is `PRAGMA user_version` when that value is non-zero, and otherwise `MAX(version)` from `schema_migrations` when that column exists.

The sample timer is Sunday 09:15 in the host timezone, America/Chicago, away from the dump slots.

## Files changed

- `scripts/ops/fleet-backup-restore-drill.sh`
- `scripts/ops/test-fleet-backup-restore-drill.sh`
- `scripts/ops/systemd.noindex/fleet-backup-restore-drill.service`
- `scripts/ops/systemd.noindex/fleet-backup-restore-drill.timer`
- `.github/workflows/ci.yml` (offline test step on the required `typecheck + test` job)
- `docs/rollouts/2026-11-12-sqlite-backup-restore-drill.md`

## Verification

```bash
bash scripts/ops/test-fleet-backup-restore-drill.sh
```

The suite builds temp databases and fake dumps, both plain `.db` and `.db.zst`.  It checks the 1.5x free-space gate, the sha256 sidecar, a held lock, and that live database paths are refused.  It does not SSH to the host and it does not read a live database.

## Follow-ups

Host install waits for Jay.  Nothing here copies the script to `/usr/local/sbin` or enables the timer.  After a yes, install `fleet-backup-restore-drill.sh` and the sample unit on fleet-hetzner-nbg1 and start the timer there.  Keep the workdir off `/data/backups` and off the live sqlite files.  CT-1685 stays open until a scratch-host restore records RTO and RPO.
