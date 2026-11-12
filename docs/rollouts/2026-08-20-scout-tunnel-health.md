# 2026-08-20 — scout.jays.services liveness matches mac.jays.services

## Summary

Jay's Tunnel was already healthy.  `scout.jays.services` and
`mac.jays.services` are both proxied CNAMEs to the same named tunnel
(`6fa2a97c-b4f8-420d-94ae-bd9858aff4b6`).  Ingress already routes scout to
`127.0.0.1:8899` and mac to `127.0.0.1:8792`.  `SENATE_RELAY_URL` stays
`https://scout.jays.services`.

The live mismatch was the **origin handler**.  Measured 2026-08-20:

| Probe | mac.jays.services | scout.jays.services (before) |
|---|---|---|
| GET `/` | 200 health JSON | 404 `not found` |
| GET `/health` | 200 | 200 |
| HEAD `/health` | 501 | 404 |

Deno.serve does not map HEAD onto GET, so uptime checks that HEAD `/` or
`/health` treated scout as down while mac answered GET `/`.  `#1610`
`POST /fetch-doc` and `POST /fetch-ptr` were already 200.

Live 2026-08-20 (no Mac restart yet): a zone Transform Rule on
`jays.services` rewrites `scout.jays.services` path `/` → `/health`.
Measured after it propagated: `GET https://scout.jays.services/` is 200
`{"ok":true,"service":"senate-relay",...}` — same idea as mac GET `/`.
HEAD still 404 until `senate-relay` reloads the origin handler.  The
rewrite is hostname-scoped and can stay after the origin update; both
paths return the same JSON.

## Files changed

- `scout/liveness.ts` — GET/HEAD `/` and `/health`
- `scout/senate-relay.ts` — use that probe; fetch contracts unchanged
- `app/src/ingestion/__tests__/senateRelayLiveness.test.ts`
- `scout/README.md`

## Verification

- `GET`/`HEAD` `https://scout.jays.services/` and `/health` → 200 after the
  Mac `senate-relay` process reloads this file (`pm2 restart senate-relay`).
- `POST /fetch-doc` with a non-efdsearch URL still 400.
- `GET https://congress.trade/api/health/senate-relay` still 200 when the
  origin answers.

## Follow-ups

- Coolify auto-deploy does **not** restart Mac `senate-relay`.  After merge,
  pull on the Mac and `pm2 restart senate-relay`.
- One laptop still has to stay awake.  Durable host is Prevent sleep or a
  Pi/clamshell on the **same** named tunnel.  Do not mint a new URL.
