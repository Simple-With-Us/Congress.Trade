# 2026-08-17 — iOS does not take web payments for Premium

## Summary

App Review Guideline 3.1.1: native iOS must not offer web Stripe checkout for
Congress.Trade Premium (the same digital good as IAP).  Delivery and the empty
StoreKit catalog still advertised “subscribe on the website” and opened Safari
to congress.trade.  Those CTAs are gone.  StoreKit purchase, Restore, and
Manage Subscription (App Store for Apple; billing portal for an existing Stripe
subscription) stay.  Website checkout and portal stay on the website.

## Files changed

- `clients/ios/CongressTrade/Views/Delivery/DeliveryView.swift` — IAP-only
  upgrade copy; no Safari subscribe link
- `clients/ios/CongressTrade/Views/Status/PremiumSheet.swift` — empty catalog
  keeps Restore and a non-purchase error; no website pricing link
- `clients/ios/CongressTrade/APIClient.swift` — removed `upgradeURL`;
  `DigitalGoodsCheckout.webCheckoutURL` is always `nil`
- `clients/ios/CongressTrade/Views/Components/Components.swift` — footer
  Pricing never Safari-opens `/pricing`
- `clients/ios/CongressTradeTests/CongressTradeTests.swift` — XCTest that iOS
  cannot open web checkout for digital goods
- `app/src/client/__tests__/iosNoWebCheckout.test.ts` — source-scan lock
- `docs/app-store/review-notes-1.0.txt` — matches the binary

## Verification

- `cd app && npm run typecheck && npm test` — 256 files / 3122 tests after merging `main` (#1977)
- Focused: `npx vitest run src/client/__tests__/iosNoWebCheckout.test.ts`
- No Stripe Checkout or Billing Portal sessions created
- No cards charged
- No StoreKit purchases

## Follow-ups

Left for later slices from the purchases audit (`#1981`):

- Apple `REFUND` apply + production Sandbox JWS reject
- Stripe `event.livemode` gate + refund/dispute policy
- XCTest for StoreKit product load / `finish()` ordering

Website/Stripe Manage Subscription 401 sign-out copy: fixed 2026-09-03
(`docs/rollouts/2026-09-03-ios-stripe-manage-sub.md`).
