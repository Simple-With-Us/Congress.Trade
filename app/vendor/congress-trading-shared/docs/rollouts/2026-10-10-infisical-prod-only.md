# 2026-10-10 — Infisical environment selection is prod-only

Board `11df8f1b`.  Branch `claude/infisical-prod-only`.

## Context & Objective

Owner 2026-10-10:  the Infisical `dev` and `staging` environments are being retired and prod is the only environment the fleet reads.  Every config default in this repo that selected `dev` now selects `prod`, and the one script that fetches secrets refuses any other value.

## Changes Made

- `.cursor/infisical.env`:  `INFISICAL_ENV=dev` became `INFISICAL_ENV=prod` (project `shared-at-ct`, `18f563a3`), with a comment saying prod is the only environment.
- `scripts/cursor-cloud-start.sh`:  header comment says prod, and a guard right after the file is sourced refuses to fetch unless `INFISICAL_ENV` is exactly `prod`.  It prints an ERROR line and exits 0 like the other short-circuits, so a stale file never fails an agent boot and never reads a retired environment.
- `INFISICAL.md`:  the consuming-the-client example uses `environment: "prod"` instead of `process.env.APP_ENV ?? "dev"`, and the key inventory no longer lists dev and staging.

## Decisions & Trade-offs

- Cursor cloud VMs that run `cursor-cloud-start.sh` now export the `shared-at-ct` prod values to `$HOME/.cursor-cloud-env/` instead of the dev values.  The copy step found 48 of the 51 dev keys already identical in prod, so for most keys nothing changes.  The three that differ keep prod's value (owner choice).
- `src/infisicalSettings.ts` is NOT given a prod-only guard.  It is a generic library that Congress.Trade vendors and the pin check watches, its tests use `"dev"` as an arbitrary slug, and a behavior change would need a semver tag.  Consuming apps enforce prod themselves (Congress.Trade `envName()`, Socratic-Trade `resolveAppEnvironment()`).
- The doc comment on `environment` in `src/infisicalSettings.ts` still says `"dev", "staging", or "prod"` as examples.  Left alone on purpose, because a comment change alters `dist/` d.ts output and would want a release.

## Verification State

```bash
bash -n scripts/cursor-cloud-start.sh
# scratch copy with INFISICAL_ENV=staging:  prints the ERROR line, exit 0, no fetch
# scratch copy with INFISICAL_ENV=prod:     proceeds to the missing-credentials short-circuit, exit 0
npm run typecheck && npm test
```

## Next Steps & Blockers

- Parent session deletes the `dev` and `staging` environments after the data-side checks in its audit note.  Nothing in this repo reads them any more.
- The `shared-at-ct` dev environment must stay until the `infisical-secrets-sync` LaunchAgent is repointed to prod (outside this repo).
