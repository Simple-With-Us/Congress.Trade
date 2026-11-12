# 2026-11-12 — Request-level Cloudflare origin lock (CT-1337)

Seat: CURSOR. Branch `cursor/ct-1337-origin-lock-4ae3`. Linear: CT-1337.

## Summary

The origin can still be reached without Cloudflare, and `clientIp()` trusted `CF-Connecting-IP` and `X-Forwarded-For` from any caller.  This change adds a request gate that accepts traffic only when the socket peer, or a trusted proxy's asserted peer, is in Cloudflare's published IPv4 and IPv6 ranges, or when a shared origin secret matches, or when a trusted proxy asserts Authenticated Origin Pulls.  `GET` and `HEAD` `/health` and `/api/health` from loopback or a private docker-network peer stay open so the in-container wget probe and Traefik's probe keep working.  The gate reads `ORIGIN_LOCK_ENABLED` and stays off unless that value is `true`, `1`, `yes`, or `on`.  Merging does not change live traffic.

`CF-Connecting-IP` and `X-Forwarded-For` are used for the client address only after that same check says the request came through Cloudflare.  A direct caller can no longer choose a rate-limit identity by sending those headers.  `X-Real-IP` is used only when the socket peer is a trusted proxy and the request did not come through Cloudflare.

The host firewall that limits ports 80 and 443 to Cloudflare ranges is out of scope.  It was applied on the box in `docs/rollouts/2026-08-24-bot-scraper-origin-lock.md` and is not changed here.  Re-check those `DOCKER-USER` rules after any Docker, host-network, or Cloudflare range change.  This pull request does not ssh, change Coolify, or deploy.

## How to enable

1. Leave `ORIGIN_LOCK_ENABLED` unset until the proof below is in place.  The default is off.
2. Prefer a shared secret.  Set `ORIGIN_LOCK_SECRET` in the container environment (Infisical is the source of truth; the resolver reads it).  Add a Cloudflare Transform Rule on the zone that sets request header `X-CT-Origin-Secret` to that value for origin requests.  Do not log the value.
3. The IP check is the other proof.  It passes when Deno's TCP peer is a Cloudflare address, or when the peer is loopback, RFC1918, or an `ORIGIN_LOCK_TRUSTED_PROXIES` CIDR and that proxy's `X-Real-IP` (else the rightmost `X-Forwarded-For` hop) is a Cloudflare address.  Confirm a real request's `X-Real-IP` is an edge address before relying on this alone.  If the proxy copies the visitor address into `X-Real-IP`, use the secret or Authenticated Origin Pulls instead.
4. Optional Authenticated Origin Pulls.  Turn the feature on at Cloudflare, verify the client certificate on the proxy, strip any client-supplied copy of the signal, and set `ORIGIN_LOCK_AOP_HEADER` to the header the proxy adds only after verification.  `ORIGIN_LOCK_AOP_VALUE` defaults to `SUCCESS`.  The header is ignored unless the socket peer is a trusted proxy or Cloudflare.
5. Set `ORIGIN_LOCK_ENABLED=true`.  `GET /health` from `127.0.0.1` inside the container and Traefik's `GET /health` from the docker network must stay HTTP 200.  A direct request that is not Cloudflare, and that lacks the secret, must be HTTP 403 with `direct origin access is not allowed`.
6. Refresh the ranges by replacing the two text blocks in `app/src/security/cloudflareRanges.ts` with https://www.cloudflare.com/ips-v4 and https://www.cloudflare.com/ips-v6.  The lists were fetched 2026-11-12.

## Files changed

- `app/src/security/cloudflareRanges.ts` — paste-to-refresh Cloudflare CIDRs.
- `app/src/security/ip.ts` — IPv4 and IPv6 parse and CIDR match.
- `app/src/security/originLock.ts` — gate, secret, origin-pull header, health exemption, client address.
- `app/src/security/__tests__/originLock.test.ts` — gate and address tests.
- `app/src/deno/main.ts` — stamps the socket peer before the app sees the request.
- `app/src/index.ts` — mounts the middleware and strips a client-supplied peer on the retired worker entry.
- `app/src/shared/rateLimit.ts` — client address delegates to the gate.
- `app/src/shared/types.ts`, `app/.dev.vars.example`, admin config-source names.

## Verification

From `app/`: `npm test`, `npm run typecheck`, and `deno lint` on the new security modules.  No production request was sent.  No host firewall or Coolify change was made.

## Follow-ups

- Enable the flag only after the secret or the proxy-asserted Cloudflare address is confirmed.
- Keep the host firewall on ports 80 and 443 aligned with the published ranges.  That step is not in this repository.
- The IP check is only as strong as the proxy overwriting `X-Real-IP` from the connection it accepted.  The secret and Authenticated Origin Pulls do not depend on that.
