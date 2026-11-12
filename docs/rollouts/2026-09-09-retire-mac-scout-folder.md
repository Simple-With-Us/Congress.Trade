# 2026-09-09 — Retire Mac `scout/` folder

Board / PR: [#2351](https://github.com/jaywedgeworth22/Congress.Trade/pull/2351)

## Summary

Owner 2026-09-09: Mac remnants (`scout/`, latency probes, senate relay, tunnel)
are removed from the Mac; Coolify manages Senate scraping, and residential IP
bounce uses the little physical-device / WireGuard proxy.

This PR deletes the checked-in Mac stack:

- `scout/congress-scout.mjs`, `scout/senate-relay.ts`, `scout/residential-proxy.mjs`
- runners: `run-scout.sh`, `run-senate-relay.sh`, `run-senate-tunnel.sh`,
  `run-residential-proxy.sh`
- `scout/README.md`, `scout/liveness.ts`
- obsolete test `app/src/ingestion/__tests__/senateRelayLiveness.test.ts`

## Tip-fix (Codex threads)

1. **PM2 manifest** — `ecosystem.config.js` no longer registers `scout`,
   `senate-relay`, or `senate-tunnel` (scripts are gone). `vision-worker` remains.
2. **Relay consumers** — app code still accepts optional `SENATE_RELAY_URL`
   (`watcher.ts`, `senateSource.ts`, `fetcher.ts`, `delivery/rest.ts`,
   `senatePaperMedia.ts`). Preferred durable path is `RESIDENTIAL_PROXY_URL`
   (see `2026-09-02-retire-scout-relay-use-residential-proxy.md`). If the
   Coolify/tunnel origin is gone, **unset** `SENATE_RELAY_URL` in Infisical so
   probes do not stay red on a dead host.
3. **Residential proxy** — do not restore the Mac Tailscale listener
   (`100.113.106.39:3128` from `2026-08-28-tailscale-residential-proxy.md`).
   Point Infisical `RESIDENTIAL_PROXY_URL` at the physical-device / WireGuard
   proxy before relying on residential egress after this merge.
4. **Runbooks** — `AGENTS.md` and `app/DEPLOY.md` no longer send responders to
   `scout/README.md` or Mac pm2 relay/tunnel entries.

## Explicitly deferred

Server-side handoff cleanup (`scoutHandoff.ts`, `recordLatencyProbeOutcome`,
`'scout' | 'server'` source enum, Mac-endpoint health probes) remains a
follow-up, as noted in the original retire commit.

## Verification

- `node -e "require('./ecosystem.config.js')"` → apps = `[vision-worker]` only.
- After merge: confirm Infisical `RESIDENTIAL_PROXY_URL` targets the physical
  device; unset `SENATE_RELAY_URL` if `https://scout.jays.services` is offline.
- `GET /api/health` Senate path green via residential proxy / box egress.
