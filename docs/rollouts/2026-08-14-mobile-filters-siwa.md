# 2026-08-14 — Mobile filters match iOS + SIWA 404

## Summary

Owner: make the mobile website filter/search layout match the iOS Trades and
Trends chrome; Sign in with Apple on the mobile site preview 404'd; drop
“Past 3 Months” next to the trade count; change chip toggles to dropdowns;
glass tab bar; party menu labels Democrats / Republicans / Other / Ind.

- Branch / party / side are now iOS-style pill menus on Trades and Trends.
- Search row is the field plus the count. The timeframe is only in the
  calendar dropdown.
- Mobile tab bar is a floating glass capsule (blur + inset highlight).
- iOS tab bar uses ultra-thin material. Party filter labels are plural.
- `GET /auth/apple/start` exists. It no longer 404s. Website SIWA needs
  `APPLE_SERVICES_ID` + `APPLE_TEAM_ID` + `APPLE_KEY_ID` + `APPLE_P8` to
  finish the Apple redirect; without those it returns a configured-error
  page instead of 404.

## Files

- `app/src/auth/appleWeb.ts`, `app/src/auth/routes.ts`
- `app/src/ui/dashboardHtml.ts`
- `clients/ios/CongressTrade/Models.swift`, `App.swift`

## Verification

`npm run typecheck`. Targeted vitest: dashboardHtml + appleRoute, 271 passed.
