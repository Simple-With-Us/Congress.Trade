# 2026-09-03 — iOS Manage Subscription for website/Stripe Premium

## Summary

A Premium user who subscribed on the website saw iOS Account → Manage
Subscription fail with red copy telling them to sign out and back in.  That
path is wrong for Stripe/web billing.

Root cause: `POST /billing/portal` used cookie-only `getCurrentUser`.  The
iOS client already sends the session Bearer (`makeRequest` →
`AuthHeaderInterceptor`).  The portal ignored it and returned 401.

Fix:

- Server: `POST /billing/portal` uses `getCurrentUserFromRequest` (cookie or
  Bearer), matching `/api/client/v1/*`.
- iOS: Apple IAP still opens the App Store subscriptions page.  Stripe or
  `nil` still prefers the minted portal URL.  On portal failure (except
  offline), open `https://congress.trade/?billing=manage` instead of
  sign-out copy.  That query runs website `manageBilling()` after `/auth/me`.
- Copy: two ASCII spaces after periods.  Never "sign out and back in" for
  web/Stripe Manage Subscription.

Guideline 3.1.1: this is manage-existing-web-billing, not web checkout.
Native iOS still never starts `/billing/checkout`.

## Files changed

- `app/src/billing/routes.ts` — Bearer on `/portal`
- `app/src/billing/__tests__/routes.test.ts`
- `app/src/ui/dashboardHtml.ts` — `?billing=manage`
- `app/src/ui/__tests__/dashboardHtml.test.ts`
- `clients/ios/CongressTrade/Store/ManageSubscription.swift`
- `clients/ios/CongressTrade/APIClient.swift`
- `clients/ios/CongressTrade/Views/Components/Components.swift`
- `clients/ios/CongressTrade/Views/Status/PremiumSheet.swift`
- `clients/ios/CongressTradeTests/CongressTradeTests.swift`
- `app/src/client/__tests__/iosNoWebCheckout.test.ts`
- `app/docs/client-mobile-api.md`
- `app/docs/mobile-app-roadmap.md`

## Verification

- `cd app && npx vitest run src/billing/__tests__/routes.test.ts src/ui/__tests__/dashboardHtml.test.ts src/client/__tests__/iosNoWebCheckout.test.ts`
- iOS XCTest: Manage Subscription routing + `billingPortalURL` Bearer POST
- No Coolify / extra-ship from this lane (PR only)

## Follow-ups

- Production portal minting from iOS needs this SHA on Coolify (auto-deploy
  on merge to `main`).  Until then the website `/?billing=manage` fallback
  is the working path for TestFlight/App Store binaries that include the
  client change.
- Apple `REFUND` / Sandbox JWS / livemode remain on the purchases-audit list.
