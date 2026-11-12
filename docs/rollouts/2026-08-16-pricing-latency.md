# Pricing checkout race + average later color

## Summary

Stripe checkout was already live (`/auth/me` reports `checkoutConfigured: true`).  The iOS and web Pricing links open `/?pricing=1`, which painted the Premium modal before `/auth/me` returned and left it stuck on **Billing Unavailable**.

iOS footer Pricing also opened Safari instead of the in-app StoreKit sheet.

Average `#h later` stayed gray because only the word “later” was tinted, not the magnitude.

Lead/Lag already required median and average to agree on the card badge (#1893).  The Trends “we are ahead” gate still used win counts; it now uses the same median+average verdict.

Long delays from the Aug 11 House reimport were already dropped from live races (`LATENCY_LIVE_FILING_MAX_LAG_DAYS = 7` in #1893).  Live FMP median and average are both earlier.

## Files changed

- `app/src/ui/dashboardHtml.ts` — wait for `/auth/me` before saying checkout is down; color the whole `#h later` figure; Trends gate uses `leadVerdict`.
- `clients/ios/CongressTrade/Views/Components/Components.swift` — footer Pricing opens Premium / IAP.
- `clients/ios/CongressTrade/App.swift` — `openPremium` environment.
- `clients/ios/CongressTrade/Views/TrendsView.swift` — color the whole average/headline phrase.
- `clients/ios/CongressTrade/Views/Status/PremiumSheet.swift` — no Pricing loop on the sheet itself.

## Verification

- Live `/auth/me` `checkoutConfigured: true` reproduced the stuck modal at `/?pricing=1`.
- `npx vitest run src/ui/__tests__/dashboardHtml.test.ts src/ui/__tests__/legalHtml.test.ts` — 274 passed.
- After deploy: open `https://congress.trade/pricing` and confirm monthly/annual + Start Free Trial after a beat.

## Follow-ups

- TestFlight hourly ship picks up the iOS footer / color change.
- Website SIWA still needs Infisical `APPLE_SERVICES_ID` (unrelated).
