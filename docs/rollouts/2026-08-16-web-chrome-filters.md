# Desktop web chrome — filters, CSV, Delivery, Admin

## Summary

Solid white header and filter chrome so KPI cards no longer show through.  Export CSV, Delivery, Manage Subscription, and Admin/Review now work from the account menu.  Side-filter arrows are fat iOS-like SVGs (green up, blue down).

What broke:

- Sticky header/filters used translucent `color-mix` + blur, so Trends cards painted through the search row.
- Account-menu items called `showView()` but that function did not exist, so Delivery / Admin / Review clicks did nothing.
- `#exportCsvDialog` lived inside `#view-trades` (`.view { display:none }`).  `showModal()` throws when an ancestor is hidden — the usual case from Trends.
- Admin + Review were removed from the tab bar and only listed in the menu when `canUseAdmin()` was already true, so the Admin Access token box was unreachable.
- Compact side-filter arrows had no color CSS (only `.side-chip .side-up` was painted).

## Files changed

- `app/src/ui/dashboardHtml.ts`
- `app/src/ui/__tests__/dashboardHtml.test.ts`
- `docs/EFFORT-LOG.md`

## Verification

- `cd app && npm run typecheck && npx vitest run src/ui/__tests__/dashboardHtml.test.ts`
- After deploy: Trends scroll should keep a solid white band through the filter row.  Account → Delivery, Export CSV, Manage Subscription, Admin, Review Queue.

## Follow-ups

- Apple IAP subscribers go to the App Store subscriptions page.  Stripe subscribers still use `/billing/portal`.
- Push Notifications on web is a pointer to the iOS Delivery tab.  Web delivery is webhook / SSE.
