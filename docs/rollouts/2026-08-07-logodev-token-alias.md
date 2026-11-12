# 2026-08-07 — Logo.dev token alias + local ticker pack

## Summary
Prod Coolify injects `LOGO_DEV_TOKEN`, but the ticker logo proxy only read
`LOGODEV_PUBLISHABLE_KEY`, so every logo fell through to GitHub (and private
names like SPCX/HONAV 404'd). Accept either env name. Add owner gap-fill pack
under `app/public/assets/ticker-logos/`. Resolve order: logo.dev → local → GitHub.

Also restored Hetzner self-hosted CI runners (`hetzner-ct-ci-1/2`) after
registration tokens expired (containers crash-looped; Oracle runners remain offline
post-cutover).

## Files changed
- `app/src/ui/tickerLogos.ts` — logo.dev-first + local gap-fill
- `app/src/delivery/rest.ts` / `app/src/shared/types.ts` / admin diagnostics — dual key names
- `app/public/assets/ticker-logos/*` — TSCO, SPCX, HONAV, BRK variants, etc.

## Verification
```bash
curl -sI 'https://congress.trade/api/logos/ticker?symbol=AAPL' | grep -i x-logo-source
# logo.dev
curl -sI 'https://congress.trade/api/logos/ticker?symbol=HONAV' | grep -i x-logo-source
# local:ticker-logos/HONAV.png
curl -s 'https://congress.trade/api/health' | jq .build.sha
# 1539a7e1e79f...
```

## Follow-ups
- Optional: remove stale offline Oracle runner registrations from GitHub.
- iOS PRs #1500–#1504 still open (min iOS 17 / App Store assets).
