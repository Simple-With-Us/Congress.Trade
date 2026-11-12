# 2026-09-18 — Datadog: honest RUM health + DD_HOSTNAME

## Context & Objective

Board `f03c5542`.  `/api/health` reported `datadog.rum=true` because Infisical has a client token + application id.  There is no Congress.Trade RUM application.  Tokens are not retained events.

## Changes Made

- `resolveDatadogRum` honors `DD_RUM_ENABLED` / `NEXT_PUBLIC_DD_RUM_ENABLED`.  `false`/`0`/`off`/`no` fail-closes even when tokens exist, so health reports `rum: false` and the public snippet is empty.
- APM host tag: copy `DD_HOSTNAME` onto `process.env` and patch `os.hostname()` before dd-trace init.  Agentless export uses `os.hostname()`, which is the container id.  Coolify fallback is `fleet-hetzner-nbg1`.  Do not put that value in `initOptions.hostname` (that field is the Agent address).
- Infisical prod already has `DD_HOSTNAME=fleet-hetzner-nbg1`, `DD_RUM_ENABLED=false`, `NEXT_PUBLIC_DD_RUM_ENABLED=false`.
- Files: `app/src/shared/datadogRuntime.ts`, `app/src/shared/datadog.ts`, `app/src/shared/types.ts`, `app/src/admin/routes.ts`, tests.

## Decisions & Trade-offs

Did not mint a CT RUM app.  CT Infisical holds the same application id as the existing ST RUM app.  Reusing it would still be billed RUM.  Kill-switch is the Free-plan alignment.  Tokens stay in Infisical so a later paid plan does not have to remint.

## Verification State

- `cd app && npx vitest run src/shared/__tests__/datadogRuntime.test.ts src/delivery/__tests__/healthCache.test.ts`

## Next Steps & Blockers

Live health stays `rum: true` until this image is on Coolify.  SSH from this Mac to the box timed out; restart via Coolify API after env upsert.

## Zero-Code Findings

Plan & Usage: trial expired 2026-09-07.  RUM hourly usage empty.  September `apm_host_top99p=12` from container IDs.  Do not start UM / ContactLogo / Personal-Site log shipping.
