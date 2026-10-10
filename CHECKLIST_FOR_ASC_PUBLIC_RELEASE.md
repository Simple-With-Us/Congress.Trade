# Checklist for App Store public release — Congress.Trade iOS

Living document.  Last verified against live App Store Connect and GitHub: **2026-08-26** (prices, trial, submission state and build attachment re-read from the live API).

App id `6798076688` · bundle `trade.congress.ios` · team `CC8UTF7ATG` · version `1.0.177`

Every claim below was read from the live ASC API or the repo, not assumed.  Where something is
unverified, it says so.

---

## 0.  Status right now

| Thing | State | Evidence |
|---|---|---|
| App Store version 1.0.177 | **WAITING_FOR_REVIEW** (Submitted with Guideline 2.1(a) and 2.1(b) fixes) | ASC `appStoreVersions` → `appStoreState` |
| Review submission `760c9667` | **WAITING_FOR_REVIEW** — 4 items (app version 1.0.177, Premium subscription group `22287016`, monthly subscription `6798078775`, annual subscription `6798078776`) | ASC `reviewSubmissions` |
| Build attached to v1.0.177 | **`202608262138`** (marketing 1.0.177) from GitHub `macos-latest` Tahoe GM, run 33016281432 | ASC `appStoreVersions/{id}/build` |
| Latest main TestFlight build | **`202608262138`** (marketing 1.0.177, Tahoe GM Xcode 26.6) | ASC `builds` list |
| Deletion recording | ✅ `account-deletion-physical-device.mp4` COMPLETE (39s, physical device attached to review notes) | ASC `appStoreReviewAttachments` |
| Subscriptions monthly / annual | Group `22287016` ("Premium"), `trade.congress.premium.monthly` ($8.99/mo, 1-week free trial) and `trade.congress.premium.annual` ($79.99/yr, 1-week free trial) attached in group with localized descriptions and review screenshots | ASC `subscriptions` / `subscriptionVersions` |

**Do not attach Mac-runner TestFlight IPAs directly to App Store versions.**  The local Mac runner is macOS 27.0 beta (`26A5416b`).  App Store review rejects that build host stamp as `INVALID_BINARY`.  The production GM build path is `.github/workflows/ios-appstore-gm.yml` (GitHub-hosted `macos-latest` Tahoe GM + Xcode 26.6).

### Summary of Apple Review Feedback

#### 1.  Historical Review (submission `b61e2a4a`, 2026-08-19)
- **Guideline 5.1.1(v) — Registration before purchase:** Required sign-in before purchasing non-account-based IAP items.
- **Guideline 5.1.1(v) — Account deletion:** Offered account creation without in-app account deletion, plus requested a physical device screen recording of the deletion flow.
- **Guideline 2.1(b) — IAP products:** In-App Purchase products were not attached to the review submission.

#### 2.  Latest Review (submission `b174dd86`, reviewed ~2026-08-23–25 on iPad Air 11-inch M3)
- **Guideline 2.1(a) — Performance: App Completeness (Login Responsiveness):** Login / authentication buttons and sub-sheets must give immediate loading feedback (spinners, disabled state) and show errors inline.
- **Guideline 2.1(b) — Performance: In-App Purchase Errors:** Reviewer encountered an error attempting to purchase subscriptions.  StoreKit catalog load errors and pre-charge vs post-charge failures must have distinguishable, actionable user copy and include "Restore Purchases" guidance.

---

### What is already fixed and merged on main

| Apple item / Feature | Fix | PR / Commit |
|---|---|---|
| 5.1.1(v) registration before purchase | Premium is purchasable with no account; sign-in is optional and explains what it adds.  Delivery alerts and push stay legitimately account-tied. | #2087, #2120 |
| 5.1.1(v) account deletion | In-app Delete Account with confirmation; deletes session, push devices, delivery subscriptions, and user row. | #2041 |
| 5.1.1(v) deletion recording | 39-second physical-device deletion video captured, uploaded, and verified `COMPLETE` in ASC. | — |
| 2.1(a) Login responsiveness | Immediate spinner overlay on Sign In with Apple/Google, disabled button states during auth, and styled inline error notices. | #2222, #2229 |
| 2.1(b) IAP purchase error handling | StoreKit catalog load errors and pre-charge vs post-charge failures clearly distinguished; Restore Purchases guidance surfaced. | #2222 |
| 2.1(b) IAP products in submission | Monthly and Annual subscription versions and subscription group versions are properly configured and attached to review submissions. | — |
| iPad Air 11-inch responsive layout | Full-width sheets (`.iPadFullWidthSheet()`), Assets two-column grid, Delivery text measure capped, account menu on all tabs. | #2094, #2178 |
| Deep links & Universal links | Handled in Swift via `AppDeepLink` and `.onContinueUserActivity(NSUserActivityTypeBrowsingWeb)` for tickers, members, trades, filings, tabs, and auth tokens. | #2209 |
| First-launch update prompt | Checks remote version manifest and prompts users when newer TestFlight or App Store builds exist. | #2133, #2212 |
| Push notification alert preferences | Configurable filing digest push alerts, Stock Act disclosure cutoffs, and ticker watchlist alerts. | #2155, #2218 |
| UI & theme polish | Auto-hiding header disclaimer banner, dark/light theme contrast improvements, Sepia theme cleanly removed with migration. | #2122, #2170, #2176, #2218 |
| Premium activation alerts | Server sends Pushover alerts on new Stripe and StoreKit Premium activations. | #2082 |
| Web accessibility & tables | Proper table semantics, radio group roles, and ARIA labels. | #2072 |
| CI & Runner standardization | Switched iOS CI and fleet workflows to GitHub-hosted cloud runners (`macos-latest`). | #2198 |
| Test suite stability | Isolated MockURLProtocol handler across concurrent runs and hardened chamber filter assertions. | #2124, #2126 |

---

## 1.  Owner tasks — the things only you can do

### 1a.  Read Resolution Center message in App Store Connect
Check the exact message text in App Store Connect for submission `b174dd86`.  Verify if Apple provided specific reproduction steps or screenshots for the Guideline 2.1(a) / 2.1(b) notes beyond what is addressed in PR #2222.

### 1b.  Confirm product configuration in ASC — ✅ VERIFIED 2026-08-26 by agent, no action needed
Read directly from the ASC API (`scripts/asc/asc_subs.py`, `scripts/asc/asc_price_map.py` — read-only, see `scripts/asc/README.md`):
- **Free trial**: both products carry a 1-week free-trial introductory offer.  Matches the paywall copy.
- **Prices (USA territory)**: `trade.congress.premium.monthly` = **$8.99**, `trade.congress.premium.annual` = **$79.99**.  Matches the copy.
- Note for anyone re-checking: the raw `prices` endpoint also returns $19.99 / $199.99 rows.  Those are OTHER territories' price points, not the US price — map each price row to its `territory` relationship before reading it, or you will misreport the live price.

### 1c.  Approve resubmission when GM binary is ready — ✅ DONE
Version 1.0.177 with GM build `202608262138` was submitted; submission `760c9667` and both subscriptions are `WAITING_FOR_REVIEW` as of 2026-08-26.  Nothing further until Apple responds.

**Do not attach a newer build while the submission is in review.**  Builds `202608262059`, `202608261823` and `202608270037` exist and are VALID, but swapping the attached binary now would reset the submission and send it back to the end of Apple's queue.

### 1d.  After public release approval
- Set `IOS_APP_STORE_ID=6798076688` in the production environment (Infisical / Coolify).  This activates the Safari smart app banner and website download banners (PR #2077).

---

## 2.  Agent tasks — what an agent can do without you

These are safe for an agent with the ASC key and repo access.  Marked ✅ when done.

- [x] ✅ **Attached Tahoe GM build `202608262138` (1.0.177)** via GM workflow run 33016281432.
- [x] ✅ **Replaced App Review Information notes** with Guideline 2.1(a) and 2.1(b) resolutions and verified 39s physical-device deletion recording (`account-deletion-physical-device.mp4`).
- [x] ✅ **Created review submission `760c9667`** with app version 1.0.177, Premium subscription group version `3a37da1c`, monthly subscription version `efbef974`, and annual subscription version `f85b493e`.
- [x] ✅ **Submitted to App Store review.** (Status: `WAITING_FOR_REVIEW`).
- [x] ✅ **Merged PR #2222 and #2229:** Addresses 2.1(a) login busy state / spinner overlay, 2.1(b) IAP purchase failure vs redeem failure error reporting, and iPad presentation context.
- [x] ✅ **Triggered GM ship workflow:** Ran `.github/workflows/ios-appstore-gm.yml` (run 33016281432) to produce App Store eligible binary.
- [x] ✅ **Attached new GM build to App Store Connect version:** Updated version `1.0.177` and resubmitted for App Review.
- [x] ✅ **Merged web PRs:** #2072 (a11y) and #2082 (Pushover premium alerts).
- [x] ✅ **Implemented Swift universal links and deep links routing:** PR #2209.
- [x] ✅ **Applied `.iPadFullWidthSheet()` to modal sheets:** PR #2094, #2178, #2222.

---

## 3.  Pre-submit verification — run through this on the TestFlight build

Test on a physical device using the latest TestFlight build:

- [ ] Launch as a **signed-out** user.  The app is fully browsable — Trends, Trades, Directory all show data with no account required.
- [ ] Open **Premium** from the ≡ menu while signed out.  **Both plans are purchasable.**  There is no mandatory sign-in gate.
- [ ] The sign-in prompt on that screen reads as **optional** and explains what it adds (cross-device sync, Delivery alerts).
- [ ] **Restore Purchases** is reachable while signed out and provides clear feedback on status.
- [ ] Sign in with Apple / Google: UI shows immediate busy state ("Signing in…", activity indicator) and handles cancel or error cleanly.
- [ ] Sign in → ≡ menu → **Delete Account** exists, prompts for confirmation, and completes account wipe cleanly.
- [ ] On **iPad**: detail sheets use full width, Directory → Assets is a two-column grid, and the ≡ menu is reachable from every tab.
- [ ] Executive-branch filers show a real position ("President"), never the placeholder word "Executive".
- [ ] Push notification settings on the Account screen allow configuring filing digests and ticker watchlists.
- [ ] No placeholder or debug UI anywhere.

---

## 4.  The account deletion video (already recorded & attached)

The required account deletion screen recording was captured on a physical iPhone and is already attached to App Review Information (`account-deletion-physical-device.mp4`, 39s, status `COMPLETE`).

If Apple ever requests an updated recording in a future cycle:
1. Start on the **home screen**, then launch Congress.Trade.
2. Tap the **≡ menu** in the top right.
3. Tap **Sign In** and sign in with Apple (or Google).
4. Return to the ≡ menu and scroll so the whole menu is visible, including the Delete Account row.
5. Tap **Delete Account**.
6. Pause on the **confirmation prompt** so it is readable.
7. Confirm deletion.
8. Show the app returning to the signed-out state.
9. Re-open the ≡ menu once more to show you are signed out.
10. Attach to App Store Connect → App Review Information.

---

## 5.  Universal links status

- **Web configuration (Live & Verified):** `https://congress.trade/.well-known/apple-app-site-association` returns 200 `application/json`, excludes `/auth/*` and `/api/*`, and carries team/bundle `CC8UTF7ATG.trade.congress.ios`.
- **In-app routing (Merged in PR #2209):** `AppDeepLink.parse(url)` and `.onContinueUserActivity(NSUserActivityTypeBrowsingWeb)` handle incoming URLs for `ticker`, `member`, `trade`, `filing`, `delivery`, and `auth` tokens.
- **Xcode / Provisioning:** Associated Domains entitlement (`applinks:congress.trade`) is set via Xcode capabilities / Apple Developer portal.

---

## 6.  Known gaps that are deliberately not blocking release

- **Smart app banner and site banner are dark** until `IOS_APP_STORE_ID` is set — deliberate, so the website never advertises an app listing before it is live on the store (§1d).
- **Apple IAP activations report as "paid"** in the Pushover alert even on an introductory trial; Apple's server payload does not differentiate trial periods in this specific alert, while Stripe's distinction is exact (PR #2082).
- **iPhone layout verification for iPad responsive modifiers:** All iPad sheet adjustments use `horizontalSizeClass == .regular`, ensuring compact iPhone layouts remain untouched.

---

## 7.  Resubmission workflow

1. Ensure PR #2222 (or any follow-up for 2.1(a)/2.1(b)) is merged on `main`.
2. Run the GitHub-hosted Tahoe GM workflow: Actions → **iOS App Store GM ship** (`.github/workflows/ios-appstore-gm.yml`).
3. In App Store Connect:
   - Select the App Store version (1.0.81 or bumped version).
   - Attach the newly built GM binary.
   - Verify App Review notes explain the 2.1(a) and 2.1(b) resolutions.
   - Verify the physical device deletion recording is attached.
   - Add both subscription items and the subscription group to the submission.
4. Submit for review and monitor ASC state until `IN_REVIEW` → `READY_FOR_SALE`.
