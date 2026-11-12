# 2026-08-14 — Trades chrome, theme sheet, All Assets gone

## Summary

Owner: Dark→Light/System did not restyle the Account sheet.  All Assets /
Stocks-and-ETF dropdown is worthless.  Search count was inside the box.
Duplicate Sort+pager row.  Default 100/page.  Net Flow by Sector ranked by
volume, not net.  Committee table sat at half width with names wrapping.

## Files

- iOS theme: `overrideUserInterfaceStyle` on every window when Light/Dark/System
  is tapped, plus `.preferredColorScheme` on the Account sheet.
- iOS Trades: count outside a smaller search field; one pager above the list
  with reverse + Date/Amount/Ticker after `>`; default 50/page; asset-class
  menu removed.
- Web: `#qAssetClass` deleted; sector-flow sorts by signed net; market-cap
  keeps CAP_ORDER; Trends tables `width: 100%`; names ellipsize; mobile search
  + count on one row; Consensus 1-up under 421px.
- Keepout in `docs/FLEET-UI-COPY.md` + `AGENTS.md`: do not put the dropdown back.

## Verification

- `npm run typecheck`
- `npx vitest run src/ui/__tests__/dashboardHtml.test.ts` 263/263
- `xcodebuild` iPhone 17 Pro **BUILD SUCCEEDED**
