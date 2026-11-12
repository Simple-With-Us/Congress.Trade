# Datadog logs + APM + public RUM (existing account)

## Summary

Congress.Trade had no application Datadog instrumentation.  The Hetzner host
already runs Datadog Agent 7 for infra/container metrics.  This change adds
fail-closed app telemetry on the **existing** Datadog account:

- Deno backend logs + APM via agentless HTTP intake (`DD_API_KEY` + `DD_SITE`)
- Public-web RUM via the official browser snippet when a client token,
  application id, and site are all present
- Missing, blank, partial, or unknown site values no-op.  The app still boots.
- No invented keys, no new Datadog plan, no synthetics, no Session Replay

## Files changed

- `app/src/shared/datadogRuntime.ts` — resolve/validate fleet env names
- `app/src/shared/datadogTransport.ts` — logs v2 + traces v0.2 HTTP intake
- `app/src/shared/datadog.ts` — boot, console warn/error hook, request spans
- `app/src/shared/datadogRum.ts` — public snippet (never includes `DD_API_KEY`)
- `app/src/deno/main.ts` — Infisical/env init after Sentry
- `app/src/index.ts` — request middleware
- `app/src/ui/routes.ts` — `%GA_SCRIPT%` injection (no Admin copy edits)
- `app/src/security/headers.ts` — RUM CSP origins only when RUM is enabled
- `app/src/delivery/rest.ts` — public `checks.datadog` booleans
- `app/src/admin/routes.ts` — config-sources registry names only
- `app/docs/config-registry.md`, `app/DEPLOY.md`, `app/.dev.vars.example`

## Coolify / Infisical secret names

Required together for logs + APM:

- `DD_API_KEY`
- `DD_SITE` (known site only; example `us5.datadoghq.com`)

Optional:

- `DD_APP_KEY` (not used to send)
- `DD_SERVICE` (default `congress-trade`)
- `DD_ENV`

Required together for RUM (reuse an existing Browser RUM app; do not mint one
from this repo):

- `DD_CLIENT_TOKEN` (aliases: `DD_RUM_CLIENT_TOKEN`, `NEXT_PUBLIC_DD_CLIENT_TOKEN`)
- `DD_APPLICATION_ID` (aliases: `DD_RUM_APPLICATION_ID`, `NEXT_PUBLIC_DD_APPLICATION_ID`)
- `DD_SITE` / `NEXT_PUBLIC_DD_SITE`

## Verification

- `cd app && npm run typecheck && npm test`
- Missing keys: no intake POSTs, no `DD_RUM` in `/` or legal HTML, CSP unchanged
- Complete backend keys: warn/error logs + sampled APM spans to that site
- Complete RUM keys: snippet present, API key absent from HTML, CSP allows
  `datadoghq-browser-agent.com` + the site intake host

## Follow-ups

- Operator sets Infisical / Coolify values on the existing account
- Do not enable Session Replay or provision new synthetics from this slice
- Host agent on `fleet-hetzner-nbg1` stays as-is
