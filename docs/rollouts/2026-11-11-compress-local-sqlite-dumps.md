# 2026-11-11 — compress local sqlite backup dumps on root (CT-2472)

## Summary

Jay kept the local sqlite backup dumps on the root disk (OPS-1006).  Those dumps, about 48.6G including the large Socratic copies, drive root's 6-hourly swing through the 80% hygiene warn line.  Complete dumps are now zstd-compressed in place so the same keep counts use less disk.  Keep counts stay Socratic 4 / 2 days, Congress 4 / 2 days, and Usage-Monitor 2 / 2 days.  The files stay on root.  Nothing is moved to `/mnt/fleet-extra`.

## What changed

After a dump is complete (`.sha256` present, no rollback journal), zstd replaces the plain `.db` with `<name>-<STAMP>.db.zst` next to that raw-db `.sha256`.  The compress step never compresses or deletes an incomplete dump.  Retention still removes incomplete files so they cannot occupy a `KEEP_COUNT` slot.  `/data/backups` is a symlink chain onto `/backups`.  Measure and delete use `readlink -f`, and a path that resolves outside that root is left alone.

Weekly verify accepts `.db` and `.db.zst`.  A compressed dump is decompressed in scratch, then checked with `PRAGMA integrity_check`, a schema row count, and the raw-db sha256.

B2 and R2 keep policy is unchanged.  When the local file is already `.db.zst`, that object is uploaded and the local file is kept.  Qdrant snapshots are untouched.

## Files changed

- `scripts/ops/fleet-sqlite-backup.sh`
- `scripts/ops/test-fleet-sqlite-backup.sh`
- `scripts/ops/fleet-backup-verify-weekly.sh`
- `scripts/ops/fleet-backups.cron` (comments only; schedule and keep numbers unchanged)

## Verification

```bash
bash scripts/ops/test-fleet-sqlite-backup.sh
```

The suite covers keep-count, incomplete-dump protection, symlink-resolved paths, and verify of compressed dumps.  It does not install anything on the host.

## Follow-ups

This change does not install the scripts on the host.  After merge, `/usr/local/sbin/fleet-sqlite-backup.sh`, `/usr/local/sbin/fleet-backup-verify-weekly.sh`, and `/etc/cron.d/fleet-backups` on fleet-hetzner-nbg1 still need the repo copies.  Do not lower the keep counts and do not move the dumps off root.  `scripts/ops/box-disk-hygiene.sh` is CT-2471 and is not part of this change.
