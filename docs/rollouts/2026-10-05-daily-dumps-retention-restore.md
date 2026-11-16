# 2026-10-05 — Daily full dumps, 7+4 retention, weekly restore alerts

## Context

Board `33bba81f` / PagerDuty #340/#355.  The shared host cron
`/etc/cron.d/fleet-backups` ran `fleet-sqlite-backup.sh` every 6 hours and
uploaded ~14 GB (ST) + CT + UM full dumps to Backblaze B2 `hetzner/` prefixes.
That duplicated Litestream continuous replication and drove the B2 spend /
request spike.  Jay approved (2026-10-05 ~10:51pm CT): keep Litestream, dump
once a day, expire old dumps only under dump prefixes, and alert on weekly
restore failure.

## Changes

| Piece | Before | After |
|---|---|---|
| Cron dump cadence | `15 */6 * * *` | `15 6 * * *` (once daily, 06:15 UTC) |
| B2 dump retention | `B2_KEEP_SETS=2` (newest 2) | `B2_KEEP_DAILY=7` + `B2_KEEP_WEEKLY=4` (Sunday UTC) |
| Local retention | keep 2 / 2 days | keep 11 / 40 days |
| Weekly verify | dump integrity + sha256, log only | dump + Litestream restore, integrity + row-count, **Pushover on FAIL** |
| Litestream prefixes | untouched | still untouched (`trading-live/`, `congress-trade/`, `api-usage-monitor/`) |

## Files

- `scripts/ops/fleet-sqlite-backup.sh`
- `scripts/ops/fleet-backup-verify-weekly.sh` (tracked)
- `scripts/ops/fleet-backups.cron` (host install source)
- `scripts/ops/test-fleet-sqlite-backup.sh` (retention tests)

## Host install (Housekeeper / Deployer)

```bash
# on fleet-hetzner-nbg1
cp -a /usr/local/sbin/fleet-sqlite-backup.sh /usr/local/sbin/fleet-sqlite-backup.sh.pre-daily-20261005
cp -a /usr/local/sbin/fleet-backup-verify-weekly.sh /usr/local/sbin/fleet-backup-verify-weekly.sh.pre-daily-20261005
# copy merged scripts into place, then:
cp scripts/ops/fleet-backups.cron /etc/cron.d/fleet-backups
chmod 644 /etc/cron.d/fleet-backups
```

Do **not** delete existing B2 dump objects by hand.  Let `prune_b2_sets` expire
them on subsequent daily runs.

## Blocked / follow-up

B2 **bucket lifecycle** is still the account-wide 14-day hide rule
(`fileNamePrefix: ""`) on all four buckets.  Scoping that to `hetzner/` only
(and leaving Litestream prefixes alone) needs the Backblaze **master** key,
which is Mac-only (`BACKBLAZE_MASTER_*` in `~/.secrets/global-api-keys`) and not
reachable from this cloud seat.  Retention-script prune is the live control
until Jay applies the lifecycle change.

## Qdrant

Already daily (`fleet-qdrant` cron).  Unchanged.  Lives under `hetzner/qdrant/`
and is not touched by the dump-set prune (top-level `--files-only`).
