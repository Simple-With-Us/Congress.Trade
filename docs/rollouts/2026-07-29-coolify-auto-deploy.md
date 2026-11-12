# 2026-07-29 — Coolify auto-deploy for Congress.Trade

> **Current shape (2026-08):** Coolify auto-deploy is still the production
> path, now on Hetzner `fleet-hetzner-nbg1` (Oracle is decommissioned).
> Deno Deploy is retired.  See `app/DEPLOY.md`.

## Context
Retire SSH Actions deploy. Prod deploys via Coolify on Oracle like Socratic.Trade.

## Coolify (host DB / config)
- App uuid: `congress-trade`
- `is_auto_deploy_enabled = true`
- `git_repository` / `git_full_url` = `https://github.com/jaywedgeworth22/Congress.Trade.git`
- `build_pack` = `dockercompose`
- `docker_compose_location` = `/app/docker-compose.yml`
- GitHub push webhook → `https://host.jays.services/webhooks/source/github/events/manual`
  (secret stored on Coolify app + GitHub hook; local copy path for ops: `~/.secrets/coolify-ct-github-webhook-secret`)

## Repo
- `deploy-oracle.yml` no longer SSHs; optional `workflow_dispatch` queues Coolify deploy via API (`COOLIFY_API_TOKEN` secret).

## Watch paths (2026-08-20)

Docs-only / iOS / effort-log pushes must not rebuild the origin.  Live
`watch_paths` is `app/**` + `services/**` (repo-root, no leading slash).
See `docs/rollouts/2026-08-20-docs-only-deploy-skip.md`.  Leave
`is_auto_deploy_enabled=true` — the webhook is what watch_paths filters.

## Rollback
- Disable auto-deploy: Coolify UI or `application_settings.is_auto_deploy_enabled=false`
- Delete GitHub webhook id (listed in repo Settings → Webhooks)
