# 2026-08-23 ticker logo policy (shared vendor)

## Summary
Congress.Trade now reads A/B/C/D source order from vendored congress-trading-shared 2.6.0.  CONFIG_KV overlay and the admin jury stay in this app.  Themed files under `assets/ticker-logos/{light|dark}/` still win.

## Why
The same grades apply to Socratic.Trade.  The seed map must not live only in CT.

## Files
- `app/src/ui/tickerLogoPolicy.ts` (KV overlay + re-export)
- `app/src/ui/logoJury.ts`
- `app/src/ui/tickerLogos.ts`
- `app/vendor/congress-trading-shared/src/tickerLogoPolicy.ts`
- admin `/api/admin/logo-jury*` routes

## Verify
```
cd app && npx vitest run src/ui/__tests__/tickerLogoPolicy.test.ts
```

## Follow-ups
Owner uploads for SPCX, IBM, UBER, UNH, BLK.  Origin persist of logo.dev bytes is still open.
