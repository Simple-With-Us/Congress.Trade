# 2026-09-08 — sqlite-web sidecar now sources its password from Infisical

## Summary
`sqlite-web` (the loopback-only SQLite admin browser sidecar, reached via SSH
tunnel on `127.0.0.1:18080`) got `SQLITE_WEB_PASSWORD` from Coolify's raw env
via compose interpolation (`SQLITE_WEB_PASSWORD=${SQLITE_WEB_PASSWORD}` in
`app/docker-compose.yml`), bypassing Infisical entirely — the only piece of
CT config that still worked this way. **Production impact:** at the time of
this change, Coolify's copy of `SQLITE_WEB_PASSWORD` was empty while
Infisical's `prod` copy held a real value, so the container sat
`Exited (1)` and Coolify showed CT as `degraded:unhealthy` even though
`congress-app` and `scan-cpu-worker` were both healthy.

## Fix
- `app/Dockerfile.sqlite-web` installs the Infisical CLI (apk, pinned to the
  fleet's `0.43.x` line via `infisical~0.43`) and its `CMD` now: mints a
  short-lived token from the `INFISICAL_APP_*` bootstrap identity, fetches
  `SQLITE_WEB_PASSWORD` from CT's Infisical `prod` env via `infisical run` +
  command substitution, and `exec`s `sqlite_web --password` with it. Pattern
  matches `app/scripts/start-with-litestream.sh`'s handling of the
  `LITESTREAM_S3_*` keys.
- **Fails closed** at every step — missing bootstrap identity, failed
  universal-auth login, or an empty/unresolved password from Infisical all
  `exit 1` with a clear `FATAL:` message. The container never falls through
  to sqlite_web's interactive-`getpass()` path (the original cause of the
  2026-08-08 crash-loop — see
  `docs/rollouts/2026-08-08-sqlite-web-crashloop-502.md`) and never starts
  with a blank password. `restart: on-failure:3` bounds this to 3 clean,
  loud failures.
- `app/docker-compose.yml`: removed `SQLITE_WEB_PASSWORD=${SQLITE_WEB_PASSWORD}`
  and, since this sidecar has no functional need for the rest of
  congress-app's secrets, dropped its `env_file: - .env` entirely in favor
  of four explicit `environment:` entries: `INFISICAL_APP_CLIENT_ID`,
  `INFISICAL_APP_CLIENT_SECRET`, `INFISICAL_APP_PROJECT_ID`, `INFISICAL_ENV`.
- No `build.args` block was added (forbidden — see the comment above the
  `services:` block; Coolify rewrites this file at deploy time and a
  `build.args` block there broke deployment `w2q7lrln9zv8fnia5xqmiotk` on
  2026-08-02).

## Owner action required (after this deploys)
Delete `SQLITE_WEB_PASSWORD` from Coolify's env for the `congress-trade` app
— Infisical is now the sole source. **Do not delete it before this PR is
live in production**: until the new image is deployed, the running
container still expects the old compose interpolation, and removing the
Coolify variable early would leave the sidecar with no password source at
all (it would still fail closed rather than serve unauthenticated, but it
would stay down for longer than necessary).

## Verification
- `python3 -c "import yaml; yaml.safe_load(open('app/docker-compose.yml'))"` —
  parses cleanly (no `docker`/`docker compose` binary available on this Mac
  to run `docker compose config` or build the image; say so plainly rather
  than claiming either ran).
- New `CMD` entrypoint logic dry-run tested locally (outside Docker) against
  mocked `infisical`/`sqlite_web` binaries: fails closed on missing
  bootstrap creds, fails closed on login failure, fails closed on an empty
  resolved password, and on success exports `SQLITE_WEB_PASSWORD` into the
  child env and execs `sqlite_web -x --password -H 0.0.0.0
  /data/congress-trade/db.sqlite` correctly. Verified with both `sh -n` and
  `dash -n` syntax checks.
