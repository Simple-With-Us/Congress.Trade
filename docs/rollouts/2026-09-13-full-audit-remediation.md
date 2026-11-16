# Rollout Note: 2026-09-13 Full Audit Remediation

## Summary
Remediation and production deployment for the September 2026 codebase and operations audit issues (#2364–#2368). Four of the five issues are fully remediated; the remaining Autopilot per-document spend ceiling from #2364 is tracked under Follow-ups.
1. **Issue #2364 (PR #2374):** House PTR live search pagination and `FilingType=P` filter, consensus voting placeholder exclusion (`effectiveTotal`), unblocking phantom collisions on `failed` and `not_found` status, and relaxing OGE 278-T OCR regex.
2. **Issue #2365 (PR #2371):** Standardizing on `getCurrentUserFromRequest` across `/billing/*` endpoints to support iOS Bearer tokens, and passing `live.customer` object to resolve disconnected Stripe accounts in the admin premium roster.
3. **Issue #2366 (PR #2372):** Added SQLite WAL mode and foreign keys pragmas in Deno init (`main.ts`), wired R2 weekly backup failure receipt writing in `fleet-sqlite-backup.sh`, removed the obsolete `CT_COST_PROFILE` tier from `docker-compose.yml` (the runtime now always reports the `live` profile), and resolved duplicate price snapshot ticks.
4. **Issue #2367 (PR #2376):** Implemented `window.history.pushState` and global `popstate` listener for browser history navigation, removed unsupported column sorting controls (Amount, Type, Politician, Asset) to eliminate misleading in-memory single-page sorts, preserved checkout intent across OAuth sign-in, harmonized responsive breakpoints at 768px, and fixed directory table header accessibility.
5. **Issue #2368 (PR #2370):** Added Universal Links Associated Domains entitlement (`applinks:congress.trade`) in XcodeGen `project.yml`, verified StoreKit Guideline 3.1.1 compliance in `ManageSubscription.swift` (already routed Apple subscribers directly to App Store subscription management URL), updated push alerts copy, displayed committee regulatory conflict tags in politician profile, refined iPad sheet sizing, and added CI drift detection for `CongressTrade.xcodeproj`.

## Files Changed
- `app/src/deno/main.ts` (WAL mode & foreign key pragmas)
- `app/src/ingestion/houseSource.ts` (`FilingType=P`, DataTables pagination offset)
- `app/src/extraction/consensus.ts` (consensus voting placeholder exclusion & `effectiveTotal`)
- `app/src/ingestion/watcher.ts` (unblock failed/not_found collisions)
- `app/src/extraction/ogeText.ts` (relaxed OCR punctuation regex)
- `app/src/billing/routes.ts` (Bearer auth on `/billing/*`)
- `app/src/admin/premiumRoster.ts` (`customerEmail(live.customer)`)
- `app/src/ui/dashboardHtml.ts` (pushState/popstate, OAuth checkout intent, 768px breakpoint, remove unsupported sorts)
- `clients/ios/project.yml` (Associated Domains entitlement)
- `clients/ios/CongressTrade/CongressTrade.entitlements` (Associated Domains entitlement)
- `clients/ios/CongressTrade/Views/Components/Components.swift` (Push alerts copy)
- `clients/ios/CongressTrade/Views/Feed/PoliticianDetailView.swift` (Conflict tags)
- `clients/ios/CongressTrade/Views/Feed/TickerDetailView.swift` (iPad sheet sizing)
- `clients/ios/CongressTrade/Views/TrendsView.swift` (iPad sheet sizing)
- `clients/ios/CongressTrade/MemberDirectorySearch.swift` (iPad sheet sizing)
- `.github/workflows/ios-build.yml` (XcodeGen drift check)
- `scripts/ops/fleet-sqlite-backup.sh` (R2 failure receipt logging)
- `app/docker-compose.yml` (removed obsolete `CT_COST_PROFILE` tier)

## Verification
- **Test Suite:** All 305 test files passing (3,903 tests) locally and in GitHub Actions CI.
- **Backend Deployment:** Live revision at `https://congress.trade/api/health` confirmed running HEAD SHA `011b8ed1` on Coolify with:
  - `ok: true`, `db: true`, `schema: true`
  - `costProfile: "live"`
  - `litestreamStatus: "replicating"` (~5s sync latency)
  - All 13 pipeline health checks reporting `ok`
- **Native iOS Verification:** PR #2370 merged to `main`; Xcode unsigned build and XcodeGen project drift gates passing in CI. TestFlight distribution is pending the next native release cycle (scheduled workflow disabled per `docs/rollouts/2026-09-03-ios-ship-schedule-skip.md`).
- **GitHub Issues:** #2365, #2366, #2367, #2368 closed. #2364 remains open for the Autopilot per-document spend ceiling (see Follow-ups).

## Follow-ups
- **Issue #2364 (open):** the `DEFAULT_LLM_DOC_USD_CEILING = 0.25` guard in `app/src/shared/llmSpend.ts` still caps multi-model Autopilot runs below their authorized $1 budget. Remediate and verify that path before closing #2364.
- Native iOS client ship to TestFlight for PR #2370 changes (Universal Links entitlement, push copy, conflict tags, iPad sheet sizing).
- Weekly R2 backup snapshot will refresh receipt on the next scheduled Sunday backup run.
