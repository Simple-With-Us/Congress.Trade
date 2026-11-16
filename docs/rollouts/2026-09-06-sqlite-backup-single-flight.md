# 2026-09-06 — fleet-sqlite-backup.sh single-flight, complete-only retention, backup timeout

Board `e1f66898`.  Branch `grok/sqlite-backup-harden`.  Worktree
`~/apps/congress-grok-sqlite-backup`.

## Summary

Housekeeper 2026-09-06 mitigated a live incident on `fleet-hetzner-nbg1`: Coolify
had three concurrent `sqlite3 .backup` processes against Socratic.Trade live
`app.db` (orphan 18:15 tick plus overlapping 00:15 and 06:15), each ~93–97% CPU
for hours, because the product script had no flock.  `KEEP_COUNT` used
`ls -1t` mtime, so in-progress dumps (`*.db-journal`, missing `.sha256`) ranked
newer than a finished snapshot and retention deleted a good local complete.
B2 still had good sets.  Housekeeper killed the overlaps, deleted incomplete
locals, and wrapped cron with `flock -n /var/lock/fleet-sqlite-backup.lock`.
This change hardens the canonical script so it is safe even without that
wrapper.

## Files changed

- `scripts/ops/fleet-sqlite-backup.sh` — in-script flock, complete-only
  retention, `timeout` around `sqlite3 .backup`
- `scripts/ops/test-fleet-sqlite-backup.sh` — offline retention harness
- `docs/EFFORT-LOG.md`
- `STATUS.md`
- `docs/rollouts/2026-09-06-sqlite-backup-single-flight.md` (this note)

## Changes

1. **Single-flight.**  `flock -n` on
   `${FLEET_BACKUP_LOCKFILE:-/var/lock/fleet-sqlite-backup.lock}`.  If the lock
   is held, log `SKIP already running` and exit 0.  Same inode as the host cron
   wrapper; Linux `flock(2)` grants a second lock to the same process, so the
   wrapper and in-script lock compose.  Missing `flock` fails closed.
2. **Complete-only retention.**  A dump counts only when the `.db` exists, a
   matching `.sha256` exists, and no `${dump}-journal` sidecar is present.
   Incomplete files are deleted first and never occupy a `KEEP_COUNT` slot or
   win a `KEEP_DAYS` mtime race.  Integrity-failed dumps no longer get a
   `.sha256`, so retention will not treat them as keepers.
3. **Backup timeout.**  `sqlite3 .backup` runs under
   `timeout -k 30s ${FLEET_BACKUP_TIMEOUT:-30m}`.  A timeout or failure logs
   `FAIL`, removes the partial dest / journal / sha256, and continues to the
   next app instead of hanging the whole run.

## Verification

- `bash -n scripts/ops/fleet-sqlite-backup.sh`
- `bash scripts/ops/test-fleet-sqlite-backup.sh`
- `grep` for non-ASCII bytes should stay clean (ASCII-only script)

## Follow-ups (host install — Housekeeper / Deployer)

Do **not** bake Coolify images.  Do **not** extra-ship or `--force-ship`.
After merge, install the script to `/usr/local/sbin/fleet-sqlite-backup.sh`
on `fleet-hetzner-nbg1`.  The live host copy still carries UUID-pinned
volume/container greps that the public repo cannot hold (see
`docs/rollouts/2026-08-31-b2-hetzner-prune.md`).  Apply this diff on top of
the host copy; do not overwrite wholesale.  Backup the current host file
first.  Cron wrapper flock can stay; it composes with the in-script lock.

## 2026-09-13 follow-up (CLAUDE): the two flocks never composed

**Symptom.**  No app SQLite dumps landed from 2026-09-07 12:15Z until 2026-09-13 07:30Z.  Every
6-hourly tick logged `[fleet-backup] SKIP already running (lock held: /var/lock/fleet-sqlite-backup.lock)`
while `fuser` showed no holder.

**Root cause.**  The 2026-09-06 change added an in-script `exec 9>"$LOCKFILE"; flock -n 9` on the
same path the cron wrapper already locks with `flock -n /var/lock/fleet-sqlite-backup.lock -c "..."`.
A flock(2) lock belongs to an open file description, so the script's fresh open() always conflicted
with the wrapper's lock.  The comment claiming they compose was wrong.  FX's 2026-09-12 rewrite
(VACUUM INTO, non-zero on failure, alert hook; board cbed4f30 / 93c48e00) kept the bug, was installed
on the host from an uncommitted lane edit, and its forced test run never executed, so nothing caught it.

**Fix.**  (1) Interim, 2026-09-13 07:30Z: the cron line passes
`FLEET_BACKUP_LOCKFILE=/var/lock/fleet-sqlite-backup.inner.lock` inside the `flock -c` string so the
two locks target different files (backup of the cron file: `/etc/cron.d/fleet-backups.bak-claude-20260913`).
A supervised run and the 12:15Z, 18:15Z, and 2026-09-14 00:15Z ticks all completed with B2 offsite OK.
(2) This PR: the script stands down its own flock when a caller hands down `FLOCKER=$LOCKFILE` (the
flock(1) self-lock idiom; util-linux 2.41.3 on the host does not export FLOCKER by itself, so the cron
line keeps form 1), the wrong comment is replaced, and FX's VACUUM INTO script is captured into the
repo so git matches the host again.  Manual runs without the env var still take the default lock and
therefore skip while a cron run holds the wrapper lock, which is the intended single-flight.

**Host state.**  `/usr/local/sbin/fleet-sqlite-backup.sh` = this PR's script (earlier copies kept as
`.bak-fx-20260912` and `.bak-claude-20260913`).  Cron line:
`15 */6 * * * root flock -n /var/lock/fleet-sqlite-backup.lock -c "FLEET_BACKUP_LOCKFILE=/var/lock/fleet-sqlite-backup.inner.lock FLEET_BACKUP_KEEP_DAYS=2 FLEET_BACKUP_KEEP_COUNT=2 B2_KEEP_SETS=2 /usr/local/sbin/fleet-sqlite-backup.sh"`.
The "UUID-pinned greps" caveat in the follow-ups above is historical: the host copy has carried the
sanitized volume and container greps since PR #2171, and this PR's script is the host copy.

**Credit.**  GROK (single-flight, retention, timeout, 2026-09-06), FX (VACUUM INTO, failure alerting,
2026-09-12), CLAUDE (lock composition and host verification, 2026-09-13).
