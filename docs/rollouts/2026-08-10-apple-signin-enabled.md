# 2026-08-10 — Sign in with Apple enabled + iOS Settings auth polish

## Summary

Owner reported Apple Sign In failing, Google button not matching Apple/ST style, and Settings
showing unnecessary clutter that had previously been cleaned up.

**Backend:** production `POST /auth/apple` was env-gated off (`APPLE_SIGNIN_ENABLED` unset →
503 `"Sign in with Apple is not enabled"`). Enabled in Infisical CT prod
(`APPLE_SIGNIN_ENABLED=true`) and restarted Coolify app `congress-trade` to clear the
Infisical secret cache. Probe after restart: `401 invalid identity token length` (feature
on; rejects garbage tokens as expected). `APPLE_BUNDLE_ID` was already `trade.congress.ios`
(len 18). **IAP remains off** (`APPLE_IAP_ENABLED` unset) until App Store subscription
approval.

**iOS Settings:** Google sign-in button restyled to ST parity (48pt height, 8pt radius,
outline fill, multicolor G mark) next to system Sign in with Apple; Apple requests
`.fullName` + `.email` scopes; friendlier error mapping for 503/401/429/offline; removed
**Recent Activity** command history section, long Account/Appearance footers, and the
separate watchlist-notice section (notices now appear as the Account footer). Google OAuth
failures also surface a short account notice.

## Files changed

- `clients/ios/CongressTrade/Views/Status/SettingsView.swift`
- `clients/ios/CongressTrade/Store/AppleSignIn.swift`
- `clients/ios/CongressTrade/Views/Components/Components.swift` (hamburger SIWA height/scopes)
- `clients/ios/CongressTrade/APIClient.swift` (timeout copy no longer references Recent Activity)
- Infisical prod: `APPLE_SIGNIN_ENABLED=true` (ops, not in git)

## Verification

- `curl -X POST https://congress.trade/auth/apple -H 'content-type: application/json' -d '{"identityToken":"x"}'` → **401** (not 503)
- `xcodebuild -scheme CongressTrade -destination 'generic/platform=iOS Simulator' build` → **BUILD SUCCEEDED**
- Device: Sign in with Apple / Google from Settings Account section

## Follow-ups

- Ship TestFlight build so TestFlight installs pick up the Settings UI polish
- Enable `APPLE_IAP_ENABLED` only after ASC subscription metadata is approved
- Optional: add Google button to the hamburger menu (today still routes to Settings)
