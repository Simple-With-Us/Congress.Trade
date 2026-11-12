# 2026-08-20 — Stop docs-only main merges from 502ing congress.trade [CURSOR]

## Summary

Every push to `main` rebuilt the Coolify compose stack, including effort-log
and review-doc merges that change no running image.  Compose
`deploy_docker_compose_buildpack()` still calls `stop_running_container(force:
true)` before `docker compose up`, so the only replica is gone for ~40–60s and
Cloudflare answers **502**.  UptimeRobot recorded 64 of those windows in 7
days.  Monet OPSRELIABILITY-01 / issue #2033.

Live Coolify application `<CT_COOLIFY_APP_UUID>` (read 2026-08-20):

| Field | Value | Meaning |
|---|---|---|
| `build_pack` | `dockercompose` | No `rolling_update()`.  Old container is deleted first. |
| `watch_paths` | `null` (before this change) | Webhook treats every main push as a deploy. |
| `is_auto_deploy_enabled` | `true` | GitHub push webhook fires immediately. |
| `health_check_enabled` | `true`, start_period 120s | Cosmetic on the compose path.  Does not keep the old replica. |

This change sets `watch_paths` to:

```
app/**
services/**
```

Repo-root relative, no leading slash (Coolify `parseWatchPaths` strips `/` and
matches the GitHub webhook file list).  `docs/**`, `clients/ios/**`,
`.github/**`, `scripts/ops/**`, `STATUS.md`, and `AGENTS.md` no longer rebuild
the origin.

`fleet-deploy-guard` also refuses to fire a coalesced follow-up deploy when
`/api/health` `build.sha` … `main` touches none of those paths, so a leftover
`pending` file cannot re-502 after a docs-only merge.

## Files changed

- `scripts/ops/deploy_relevance.py` — Coolify-compatible glob matcher
- `scripts/ops/test-deploy-relevance.sh` — offline table
- `scripts/ops/coolify-watch-paths.sh` — GET + PATCH `watch_paths` only
- `scripts/ops/fleet-deploy-guard.sh` — skip irrelevant HEAD
- `.github/workflows/coolify-watch-paths.yml` — keep the setting applied
- `.github/workflows/ci.yml` — run the matcher tests

## Verification

```bash
bash scripts/ops/test-deploy-relevance.sh
# must print passed=N failed=0

COOLIFY_TOKEN=… bash scripts/ops/coolify-watch-paths.sh --check
# exit 0: live watch_paths is app/** + services/**

# After a docs-only merge, Coolify webhook response is
# "Changed files do not match watch paths. Ignoring deployment."
# Public https://congress.trade/api/health stays 200 for the whole merge.
```

A later **code** merge still 502s until the overlap path in open PR #1964 is
installed on `fleet-hetzner-nbg1`, or the app is moved to a Coolify Dockerfile
build pack (the only way to reach health-gated `rolling_update()`).  Do not
remove `127.0.0.1:5000:5000` or `container_name: congress-app` from compose
without moving the watchdog off that bind.  Do not re-enable
`ct-deploy-guard.timer`.

## Follow-ups

- Host install of the updated `fleet-deploy-guard.sh` + `deploy_relevance.py`
  (`/usr/local/bin` and `/usr/local/lib/congress/`).  Watch_paths works without
  that copy; the guard skip is defense in depth.
- Land / install PR #1964 overlap for code-merge windows.
- Owner-gated: new Coolify Dockerfile application (empty host port map, health
  `/api/health`) per `docs/rollouts/2026-08-12-deploy-downtime-gap.md`.
