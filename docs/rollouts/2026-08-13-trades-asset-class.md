# 2026-08-13 — Trades asset-class dropdown + CSV toolbar parity

## Summary

Leftover from the filter-bar takeover audit.  The owner-requested Trades dropdown (**All** / **Public Equities, Funds, & ETFs**) existed only as `?assetClass=` on the server.  CSV export also ignored party and rolling time windows.

## Files

- `app/src/ui/dashboardHtml.ts` — `#qAssetClass` on Trades extras; `tradesFilterParams` sends `assetClass`; `exportCsv()` uses `tradesFilterParams()`
- iOS `AssetClassFilter`, Trades-only pill, `FeedQuery.assetClass`, CSV export gets party + assetClass

## Verification

- vitest `dashboardHtml` 263
- iOS `testSetAssetClassSendsAssetClassQueryParam`
- Merged #1846 `27e9c59d`; Coolify `hxcsun3tkcaouaxgjuxwfbwv` finished; live `/api/health` sha `27e9c59d608e`
- Live Trades: `#qAssetClass` All Assets / Public Equities, Funds, & ETFs; selecting equities_funds sent `?assetClass=equities_funds` and cut 2,074 → 925 (90d)
- Live Trends: shared H/S/P + party + sides + All Time; asset-class control not shown (0×0)
- Company drawer from Directory Assets: **ACTIVITY (PAST 3 MONTHS)** — no Congressional
- Mobile 390px: no horizontal overflow; asset-class pill visible
- TestFlight 1.0.11 (202608140152) `IN_BETA_TESTING`
