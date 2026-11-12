> **SUPERSEDED 2026-08-08:** the Oracle host is decommissioned. Runners now live on the Hetzner fleet box — see `docs/rollouts/2026-08-08-runners-hetzner-migration.md` for current truth + runbook.

# 2026-07-29 — GitHub-hosted CI; Oracle Actions runners off

Owner: retire self-hosted Oracle Actions runners; all workflows use `ubuntu-latest`.

- `ci.yml` / `security.yml` → `ubuntu-latest`
- `deploy-oracle.yml` → SSH deploy from hosted runner (`ORACLE_SSH_PRIVATE_KEY` required)
- `check-actions-runner-policy.mjs` allows only `ubuntu-latest`