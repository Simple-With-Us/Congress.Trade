# 2026-11-12 — Deploy-window 502s on iOS and the proxy alias race (CT-2476)

## Summary

Congress.Trade iOS was reporting 502s on idempotent GETs while Coolify swapped the app container (Sentry CONGRESS-TRADE-25).  The client now retries those GETs on 502/503/504 and a short list of transport errors, up to two extra times.  The host proxy script attaches the stable Traefik alias before it publishes the plain route, and it keeps the previous route when that attach fails.

## Files changed

- `clients/ios/CongressTrade/APIClient.swift` — GET retry loop, capped Retry-After, cancellation mapped to `APIError`.
- `clients/ios/CongressTrade/SentryTelemetry.swift` — drop per-attempt failed-request events that carry the retry header, and record one warning when the budget is spent.
- `clients/ios/CongressTrade/Store/CongressTradeStore.swift` and `Views/Feed/PoliticianDetailView.swift` — do not run a second retry loop over errors the client already exhausted.
- `scripts/ops/ct-reattach-proxy.sh` — alias before the route swap. A failed attach leaves a plain route unwritten.  A failed re-alias puts the container back on the network without the alias.
- `scripts/ops/test-deploy-overlap.sh` — offline coverage for that order and for a failed attach.

## Verification

`bash scripts/ops/test-deploy-overlap.sh` passes offline.  The iOS cases run in the `xcodebuild (unsigned)` check.  This cloud environment has no Xcode, so those cases were not executed here.

## Follow-ups

The live copy is `/usr/local/bin/ct-reattach-proxy.sh` on the Coolify host.  After merge, install this file there with mode 0755 and run it once.  The iOS retry reaches users on the next app release.
