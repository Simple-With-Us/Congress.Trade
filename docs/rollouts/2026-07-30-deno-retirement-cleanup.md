# 2026-07-30 — Deno Deploy retirement cleanup (staging preview + Sentry watchlist)

> **Current shape (2026-08):** Deno Deploy stays retired.  Production is
> Coolify Deno-in-Docker on Hetzner.  `app/DEPLOY.md` and `AGENTS.md` are the
> live deploy path (the follow-up below about stale `ship.sh` is itself stale).

## Summary

Owner directive (2026-07-29 23:05): "we aren't using deno-deploy anymore only
oracle". The heavy lifting landed in #1172 (AG): required checks restored on
the self-hosted `oracle-congress-ci` runner via a private-repo dynamic
`runs-on` expression, `deploy-deno.yml` deleted, runner-policy script updated.
This PR sweeps the remaining Deno artifacts:

- Deleted `.github/workflows/deploy-staging.yml` ("Deploy Preview") — the
  Deno Deploy preview pipeline for the `staging` branch; preview deploys would
  need an Oracle/Coolify-based design if the fleet wants them back.
- `sentry-ci-report.yml` — dropped stale `Deploy Deno` / `Deploy Preview`
  watchlist entries (alerting on deleted workflows silently never fires) and
  corrected `Deploy Oracle Monolith` → `Deploy Coolify (Congress.Trade)` to
  match `deploy-oracle.yml`'s actual `name:`.

## Context: why PRs were not merging (2026-07-29 → 2026-07-30)

GitHub-hosted `ubuntu-latest` provisioned zero jobs for this repo for 24h+ —
every workflow failed in ~3s with no runner assigned, so the required
`typecheck + test` / `gitleaks` checks could never go green and merges relied
on manually-posted synthetic statuses. Account-level hosted-runner
unavailability (billing API needs the `user` scope to confirm), not repo code.
Resolved by #1172 routing all workflows to the online, busy Coolify
self-hosted runner `oracle-congress-ci`; main CI green at 2026-07-30 04:24Z.

## Files changed

- `.github/workflows/deploy-staging.yml` (deleted)
- `.github/workflows/sentry-ci-report.yml` (watchlist + comments)

## Verification

- `node scripts/check-actions-runner-policy.mjs` → OK (11 workflows).
- `deploy-oracle.yml` `name:` confirmed = `Deploy Coolify (Congress.Trade)`.

## Follow-ups

- `app/package.json` `deploy` / `deploy:full` and `app/scripts/ship.sh` still
  target Deno Deploy; AGENTS.md "Migrations & deploy" section is stale
  (#1174 is already updating AGENTS.md for the Coolify path).
- Migrations 0065/0066 (STOCK Act status, filer bioguide resolution) are in
  main's idempotent migrate list and apply on the next prod
  `POST /api/admin/migrate` against the Coolify-deployed app.
