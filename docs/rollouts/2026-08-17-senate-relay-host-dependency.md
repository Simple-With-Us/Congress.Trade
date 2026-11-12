# 2026-08-17 — Senate relay: named tunnel stays; Mac origin no longer fail-closes

Closes the durable-path half of [#1604](https://github.com/jaywedgeworth22/Congress.Trade/issues/1604).
Does not change the [#1610](https://github.com/jaywedgeworth22/Congress.Trade/pull/1610) `/fetch-doc` contract when the relay answers.

## Summary

Issue #1604 asked for two things: stop using an ephemeral TryCloudflare hostname, and stop depending on one laptop staying awake.

The ephemeral hostname is already gone.  PR #1779 moved the origin onto the named tunnel `Jay's Tunnel` (`6fa2a97c-b4f8-420d-94ae-bd9858aff4b6`) at the permanent address:

```
SENATE_RELAY_URL=https://scout.jays.services
```

That value must never be hand-edited.  Restarts reconnect to the same hostname.

The Mac origin is still required for a *preferred* residential path.  It is no longer required for Senate search or document fetch to *function* when Imperva allows the box's own egress:

- `POST /fetch-ptr` and `POST /fetch-doc` still go to the relay first (#1610 preserved).
- Cloudflare origin-down statuses (502/503/504/521–524) or a connect error fall back to the existing direct eFD session on the production box.
- Mirrored upstream statuses (404/403/400) stay on the relay path so retry semantics do not change.

Measured 2026-08-17 while writing this:

| Probe | Result |
|---|---|
| `GET https://scout.jays.services/health` | Cloudflare `error code: 502` (origin down from this vantage) |
| `POST https://scout.jays.services/fetch-ptr` | same 502 |
| `POST https://scout.jays.services/fetch-doc` | same 502 |
| `GET https://efdsearch.senate.gov/search/` from AWS `34.210.205.116` | **302** → `/search/home/`, CSRF token present (not the 2026-08-09 Imperva 403) |
| `GET https://congress.trade/api/health/polling` | `polling_senate` **ok**, last success 1m |

So a dead laptop no longer silently zeros Senate coverage when the WAF is not blocking the box.  When the WAF *does* block datacenter egress again, the remaining host dependency returns.

## Remaining host dependency

`senate-relay.ts` still runs on the owner's residential Mac, exposed by Jay's Tunnel (launchd system service) and watched by the `senate-tunnel` pm2 entry.  A sleeping Mac produces a stable 502 at the permanent hostname.  That is better than a rotating `*.trycloudflare.com` URL, but it is still one machine.

**Concrete durable fix** (owner / Mac-local; this cloud session cannot provision it):

1. **Keep the current Mac always-on.**  Energy Saver → Prevent sleep.  launchd already owns `com.cloudflare.cloudflared`.  pm2 already owns `senate-relay` and `senate-tunnel`.  No new hostname.
2. **Or move the origin** to a Raspberry Pi / old Mac in clamshell that never sleeps, still ingressing `scout.jays.services` → `127.0.0.1:8899` on the same named tunnel.  Do not mint a second tunnel or change `SENATE_RELAY_URL`.
3. **Do not** try to "fix" a 502 by pasting a new TryCloudflare URL into Coolify.  That is the 2026-08-11 failure mode.

A paid residential proxy (`SENATE_PROXY_URL` is typed but unused) is a later option if Imperva re-blocks the box and no always-on residential host is available.  It needs owner credentials and is not wired here.

## Files changed

- `app/src/ingestion/senateRelayHealth.ts` — probe, KV cache, unreachable helper
- `app/src/ingestion/senateSource.ts` — `/fetch-ptr` falls back to direct eFD on relay-down
- `app/src/ingestion/fetcher.ts` — `/fetch-doc` falls back to direct eFD on relay-down; 404/403 stay on the relay
- `app/src/shared/pipelineHealth.ts` — `senate_relay` check (KV probe, no live hop on `/api/health`)
- `app/src/delivery/rest.ts` — `GET /api/health/senate-relay`
- `app/src/ingestion/watcher.ts` — fail-soft probe each tick
- `app/src/ingestion/autonomySweeps.ts` — Pushover on `senate_relay`
- `scout/README.md`, `AGENTS.md` — remaining-host note
- Tests for fallback, unreachable classification, health endpoint, pipeline check

`scout/senate-relay.ts` `/fetch-doc` is **not** modified.

## Verification

```bash
cd app
npm run typecheck
npm test -- --run \
  src/ingestion/__tests__/senateRelayHealth.test.ts \
  src/ingestion/__tests__/senateSource.test.ts \
  src/ingestion/__tests__/fetcherRetry.test.ts \
  src/shared/__tests__/pipelineHealth.test.ts \
  src/delivery/__tests__/healthMonitorEndpoints.test.ts
```

After deploy:

- `GET /api/health/senate-relay` — 200 when the Mac origin answers `/health`; 503 on Cloudflare 502
- Senate poll + a known PTR fetch still succeed while the tunnel 502s, via the direct fallback
- A working relay still receives every senate document POST at `/fetch-doc` (no direct efdsearch hop)

Optional UptimeRobot target: `https://congress.trade/api/health/senate-relay` (free plan is at 9/10 monitors as of 2026-08-10; add only if a slot is free).  The hourly liveness sweep already Pushovers `senate_relay`.

## Follow-ups

- Owner: confirm the Mac is set to Prevent sleep, or stand up the Pi / clamshell origin on the same named tunnel.
- If Imperva 403s the Hetzner box again, the fallback will start failing and `polling_senate` will go FAILING — that is the signal to finish the always-on residential host, not to rotate `SENATE_RELAY_URL`.
