# 2026-11-12 — local backup retention on the root disk (CT-2506)

## Summary

Coolify database backups under `/data/coolify/backups` and the fleet sqlite dumps under `/data/backups` stay on the Hetzner root disk (OPS-1006).  They accumulate there.  This adds a retention pass that keeps the newest 2 snapshots per app or database, plus anything newer than 48 hours.  The pass is a dry-run until `APPLY=1`.  It does not move dumps onto another disk, and it does not change `fleet-sqlite-backup.sh` or `fleet-backups.cron`.

## Files changed

- `scripts/ops/local-backup-retention.sh`
- `scripts/ops/local_backup_retention.py`
- `scripts/ops/test-local-backup-retention.sh`
- `scripts/ops/test_local_backup_retention.py`
- `scripts/ops/systemd.noindex/fleet-local-backup-retention.service`
- `scripts/ops/systemd.noindex/fleet-local-backup-retention.timer`
- `.github/workflows/ci.yml` (offline test step)
- `docs/rollouts/2026-11-12-local-backup-retention.md`

## Behavior

Discovery walks `/data/coolify/backups` and `/data/backups`.  The second path is `ROOT` in `fleet-sqlite-backup.sh`.  `BACKUP_RETENTION_ROOTS` replaces that list, and `BACKUP_RETENTION_EXTRA_ROOTS` appends to it.  Each configured path must be absolute and at least two components deep.  A root that resolves to `/` is refused.  A missing root is skipped.

Files that share an app or database name and a timestamp are one snapshot.  A `.db.zst` dump and its `.sha256` stay together, so the count is snapshots rather than individual files.  The newest file in a group is never deleted.  A file is deleted only when a newer complete file exists in the same group.  Complete means non-zero size and an mtime older than 10 minutes.  `KEEP_COUNT` defaults to 2.  `MIN_AGE_HOURS` defaults to 48, and anything newer than that age is kept even past the count.

`APPLY=1` is the only value that unlinks files.  The daily timer does not set it.  `/etc/fleet-local-backup-retention.env` can.  `REQUIRE_B2_COPY=1` deletes a snapshot only after `b2 ls` or `aws s3api list-objects-v2` shows an object with the same file name.  If the bucket, the tool, or the credentials are missing, the run deletes nothing.  Secret values are not printed.  The credential names are `B2_APPLICATION_KEY_ID` with `B2_APPLICATION_KEY`, or `AWS_ACCESS_KEY_ID` with `AWS_SECRET_ACCESS_KEY`.

## Verification

```bash
bash scripts/ops/test-local-backup-retention.sh
```

The suite uses a temp-dir fixture tree.  It covers dry-run, apply, keep count, the 48 hour floor, incomplete and zero-byte files, symlink escapes, shallow roots, the B2 hook, the lock, and the systemd units.  It does not SSH, and it does not call Backblaze.

## Operator follow-up

After merge, install the script and the timer on fleet-hetzner-nbg1.  This change does not install itself, and it was not run on the host.

```bash
install -m 0755 scripts/ops/local-backup-retention.sh /usr/local/sbin/local-backup-retention.sh
install -m 0644 scripts/ops/local_backup_retention.py /usr/local/sbin/local_backup_retention.py
install -m 0644 scripts/ops/systemd.noindex/fleet-local-backup-retention.service /etc/systemd/system/
install -m 0644 scripts/ops/systemd.noindex/fleet-local-backup-retention.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now fleet-local-backup-retention.timer
```

Read one dry-run in the journal before setting `APPLY=1`.  Socratic and Congress fleet dumps are still kept at 4 by `fleet-sqlite-backup.sh`.  Dumps newer than 48 hours are kept by this pass as well.  Set `KEEP_COUNT=4` in the env file if a dry-run would drop an older Socratic or Congress snapshot that the backup cron still intends to keep.  Coolify hourly dumps remain for 48 hours at the default age.  Lower `MIN_AGE_HOURS` in the env file if that is too much disk.  Leave the dumps on the root disk.

For the B2 check, set `B2_BUCKET` and, for the fleet objects, `B2_PREFIX=hetzner/`.  Put the key id and the key in the env file.  Do not commit them.

## Follow-ups

The timer is not enabled by this pull request.  Host install is the operator step above.
