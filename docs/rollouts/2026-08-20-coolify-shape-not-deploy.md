# 2026-08-20 — Current-shape docs: Coolify Docker, not Deno Deploy / Turso

## Summary

Deno Deploy and Turso are retired.  Live production is Coolify Deno-in-Docker
on Hetzner, local SQLite + Litestream, Infisical secrets, paid cron
`* * * * *`.  Current-shape docs and operator comments still told a new agent
to deploy to Deno Deploy, Turso, or the older Workers/D1 path.  This sweep
fixes those live statements.  Dated 2026-07 rollout bodies stay past tense
and get a one-line current-shape pointer where they still read as if Deploy
was production.

## Files changed

- `AGENTS.md`, `app/DEPLOY.md`, `README.md`, `app/README.md`
- `app/docs/config-registry.md`, `app/docs/probe-schedule.md`
- Operator comments: `app/src/deno/costProfile.ts`, `cronLanes.ts`,
  `app/src/shared/types.ts`, `app/scripts/ship.sh` header
- Pointers on selected `docs/rollouts/2026-07-*` notes

## Verification

- A new agent reading `AGENTS.md` / `app/DEPLOY.md` is told to merge to
  `main` → Coolify docker-compose, then `bash app/scripts/ship.sh` for
  migrate.  No `deployctl`, no Turso host, no `wrangler deploy`.
- `cd app && npm run typecheck && npm test`

## Follow-ups

- `app/src/deno/main.ts` still has Deploy-era operator comments (kept out:
  Sentry seat).
- Historical reviews/analysis (`docs/reviews/2026-07-28-*`, effort-log
  2026-07 rows) remain dated corpus.
