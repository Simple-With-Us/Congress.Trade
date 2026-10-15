# 2026-10-05 — Deploy / CI hygiene (board 9abe9098261b41cdb4b60bbfbb3d9e66)

## Summary

GB-HOUSEKEEPER slice: remove leftover tracked `.bak`, stop the self-referential
GitHub Uptime Monitor cron against `/api/health`, and document (not fix in-repo)
COOLIFY_AGENTS scope and historical ad-hoc SSH data jobs.

## Files changed

- `scripts/check-actions-runner-policy.mjs.bak` — deleted (stale runner-policy copy; not executed by CI).
- `.github/workflows/uptime-monitor.yml` — schedule removed; manual check uses `GET /health` instead of `/api/health`.

Already on `main` before this PR (not re-done here):

- `.github/workflows/debug.yml` — removed in #2394 (always failed on hosted runners: `docker logs` for box-only containers).
- `.github/workflows/deploy-oracle.yml.bak` — removed in #2198.

## Verification

```bash
node scripts/check-actions-runner-policy.mjs
ruby -e 'require "yaml"; YAML.load_file(".github/workflows/uptime-monitor.yml")'
cd app && npm run typecheck && npm test
```

Confirm GitHub Actions no longer schedules `Uptime Monitor` every five minutes
(workflow_dispatch only).

## Follow-ups

- **COOLIFY_AGENTS** — full-permission Coolify API token across fleet apps; scope down or split per-app tokens in Infisical (ops; not changed in this repo).
- **Bulk price load** — route production runs through governed admin paths instead of `scp` + host Python against `/data/congress-trade/db.sqlite` (see `analysis/massive-bulk-load/README.md`).
