# 2026-10-05 — UM-only daily dumps (ST/CT stay 6-hourly)

## Correction

Jay clarified after #2647: the new backup setup applies **only to Usage-Monitor**.
Socratic.Trade and Congress.Trade stay on the previous 6-hourly keep-2 cadence
until he decides separately.

## Live shape

| Lane | Cron | Apps | Local keep | B2 dump retention | Weekly restore |
|---|---|---|---|---|---|
| ST+CT | `15 */6 * * *` | socratic,congress | 2 / 2d | `B2_KEEP_SETS=2` (14-day cap applies too) | no |
| UM | `45 6 * * *` | usage-monitor | 11 / 40d | `B2_KEEP_DAILY=3` + `B2_KEEP_WEEKLY=2` + `B2_MAX_AGE_DAYS=14` (was 7+4 until 2026-10-29; 14-day cap since 2026-10-30) | yes (Pushover) |

Env: `FLEET_BACKUP_APPS`, `FLEET_BACKUP_VERIFY_APPS`, `FLEET_BACKUP_DRY_RUN=1`.

Litestream prefixes are never pruned.  No existing dump objects are deleted by
hand -- only the per-lane prune on subsequent runs.
