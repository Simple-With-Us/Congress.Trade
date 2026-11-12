# 2026-10-10 — Infisical environment selection is prod-only

Board `11df8f1b`.  Branch `claude/infisical-prod-only`.

## Context & Objective

Owner 2026-10-10:  the Infisical `dev` and `staging` environments are being retired and prod is the only environment the fleet reads.  The copy step already moved the keys the apps need into prod.  This change makes every code path that picks an environment pick `prod` and refuse anything else, so nothing can read or write a retired environment.  Environment selection only:  no feature, flag or money-path logic changed.

## Changes Made

- `scripts/infisical-secrets-safe.sh`:  the `infisical` CLI defaults to `--env dev`, so a `has`, `set` or `names` call without `--env` read dev and could report a prod secret as missing.  The wrapper now adds `--env prod` when none is given and refuses any other value (`--env X`, `--env=X`, empty, trailing, or a second `--env`) before the CLI is invoked.
- `app/src/secrets/infisical.ts`:  `envName()` returns `prod` for unset, blank, `prod` or `production`, and throws for anything else (the old `development` to `dev` mapping is gone).  `deleteSecret` now resolves the environment before it authenticates, so a refused value makes no network call at all.
- `app/scripts/run_export.sh`:  refuses a non-prod `INFISICAL_ENV` and always exports `--env prod`.
- `app/scripts/start-with-litestream.sh`:  always reads Litestream credentials from prod.  A stray `INFISICAL_ENV` is logged as an ERROR-LEVEL WARNING and ignored, in keeping with the file's uptime-over-backup rule.
- `INFISICAL.md`:  states prod is the only environment.
- Tests:  `scripts/infisical-secrets-safe.test.mjs` (32 cases against a stub `infisical` first on PATH, never the real CLI) and a new block in `app/src/secrets/__tests__/infisical.test.ts`.  `.github/workflows/ci.yml` runs the wrapper test in the required `typecheck + test` job.

Files:  `scripts/infisical-secrets-safe.sh`, `scripts/infisical-secrets-safe.test.mjs`, `app/src/secrets/infisical.ts`, `app/src/secrets/__tests__/infisical.test.ts`, `app/scripts/run_export.sh`, `app/scripts/start-with-litestream.sh`, `.github/workflows/ci.yml`, `INFISICAL.md`, `docs/EFFORT-LOG.md`.

## Decisions & Trade-offs

- Live behavior does not change.  Coolify `congress-trade` already has `INFISICAL_ENV=prod` (checked 2026-10-10), `INFISICAL_SHARED_ENV` is not set, and every default was already prod.  What changes is local and Cursor runs and operator CLI calls, which used to read dev.
- The wrapper refuses `production` (not a real Infisical slug) while the app resolver accepts it as an alias for `prod`, as it did before.
- `app/Dockerfile.sqlite-web` is NOT touched.  Its CMD already defaults to `prod`, Coolify sets `prod`, and a defect in that one-line CMD once took the whole compose app to a public 502 (`docs/rollouts/2026-08-08-sqlite-web-crashloop-502.md`).
- `scripts/merge-local-dev-vars.mjs` still copies an `INFISICAL_ENV` from the operator's shell into `app/.dev.vars`;  the resolver now refuses a non-prod value at runtime, so a stale value fails loudly instead of reading dev.
- Merging `app/**` lets the Coolify webhook rebuild `congress-trade`.  No schema change, so `POST /api/admin/migrate` is not needed.

## Verification State

```bash
node --test scripts/infisical-secrets-safe.test.mjs     # 32 pass;  30 of 32 fail against the old script
bash -n scripts/infisical-secrets-safe.sh app/scripts/run_export.sh app/scripts/start-with-litestream.sh
node scripts/check-actions-runner-policy.mjs
cd app && npm ci && npm run typecheck && npm run coverage   # 335 files, 4389 tests passed
```

## Next Steps & Blockers

- Nothing is outstanding for this change.  The `dev` and `staging` environments are deleted and the eight dev-only knobs are in prod;  see "Update Sat Oct 10 (owner decision)" below.
- Four kept-prod value conflicts (`CT_DRAIN_CLAIM_SIZE`, `CT_DRAIN_LIMIT`, `RESIDENTIAL_PROXY_HOST`, `RESIDENTIAL_PROXY_URL`) mean local runs now get prod's values for those.

## Update Sat Oct 10 (owner decision)

Later on Sat Oct 10 the owner decided "ok to do all" and "if values differ defer to prod, all the rest move to prod".  That replaces the plan in the first version of this note, which was to leave the eight dev-only knobs out of prod and let them run on their code defaults.

- Copied to prod:  all 8 dev-only keys.  They are `CT_CRON_SCHEDULE`, `CT_OUTBOX_LIMIT`, `CT_TICK_DEADLINE_MS`, `CT_TICK_STUCK_MINUTES`, `CT_UI_LOGO_DISPLAY`, `INFISICAL_CACHE_TTL_SECONDS`, `R2_USAGE_DIGEST_UTC_HOUR` and `RETENTION_DELETE_RAW_OBJECTS`.  Prod now holds an explicit value for each one instead of relying on the code default.
- `CT_TICK_DEADLINE_MS`:  the code default is 45000 and compose sets 120000.
- `RETENTION_DELETE_RAW_OBJECTS` was copied with the value `0`, so raw-object deletion stays off.  `app/src/jobs.ts` treats only `1`, `true`, `yes` and `on` as enabled.
- Value conflicts, prod's value kept:  `CT_DRAIN_CLAIM_SIZE`, `CT_DRAIN_LIMIT`, `RESIDENTIAL_PROXY_HOST` and `RESIDENTIAL_PROXY_URL` differ between dev and prod, and prod's value stays.
- Environments:  the `dev` and `staging` environments of the `congress-trade` Infisical project are deleted.  Prod is the only environment.
