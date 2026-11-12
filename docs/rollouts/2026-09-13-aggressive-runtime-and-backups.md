# 2026-09-13 — Aggressive runtime, Infisical-only knobs, VACUUM INTO backups

Branch `fx/aggressive-runtime-backups`.  Worktree `~/apps/congress-fx-runtime`.

## Why

Live `/api/health` showed `costProfile.name=free` (15-minute cron) because the code default was the retired Deno Deploy survival profile.  Owner: those names are misleading and production should always be aggressive.  Secrets belong in Infisical, not Coolify duplicates of `CT_COST_PROFILE`.

Host 6-hourly dumps used `sqlite3 .backup`, which never converges on the ~11 GB ST database.  Weekly R2 for CT was still `archive_stale` on 2026-08-30.

## What changed

- `app/src/deno/costProfile.ts` always starts from live knobs.  `CT_COST_PROFILE` / `DENO_COST_PROFILE` are ignored.  Optional Infisical overrides remain `CT_CRON_SCHEDULE`, `CT_DRAIN_*`, `CT_OUTBOX_LIMIT`.
- `scripts/ops/fleet-sqlite-backup.sh`: `VACUUM INTO`, alert on failure, non-zero exit.  Installed to `/usr/local/sbin/fleet-sqlite-backup.sh` on the box (backup `fleet-sqlite-backup.sh.bak-fx-20260912`).
- Stripe webhook handles `charge.refunded` and `charge.dispute.created`.
- Filing PDF for non-premium is 402 JSON (no browser 302 to `/pricing`).

## Verification

```bash
bash -n scripts/ops/fleet-sqlite-backup.sh
bash scripts/ops/test-fleet-sqlite-backup.sh
cd app && npx vitest run src/deno/__tests__/costProfile.test.ts
```

After deploy, `GET https://congress.trade/api/health` should show `costProfile.name=live` and cron `* * * * *`.

## Follow-ups

- Force a weekly R2 copy (`FLEET_BACKUP_FORCE_WEEKLY=1`) if the Sunday cron has not yet advanced the receipt past 2026-08-30.
- Do not add `CT_COST_PROFILE` to Coolify env.
