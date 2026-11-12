# Congress.Trade Purchases Audit (Stripe + StoreKit)

**Date:** 2026-08-17  
**Agent:** CURSOR (Cursor Cloud)  
**Branch:** `cursor/purchases-audit-c503`  
**Tree:** `main` at `4f2e8353`  
**Scope:** report-only.  No product-code edits.  No Stripe Checkout or Billing Portal sessions created.  No cards charged.  No StoreKit purchases, restores, or App Store Connect writes.

This is the customer money path (web Stripe Premium and native iOS IAP).  It is not the OpenRouter files-prepaid halt lane on `#1977`.  It does not steal Monet/Claude/Grok IAP implementation already on `main` (`#1553`, `#1558`, `#1560`, `#1561`, `#1562`, `#1835`, `#1875`, `#1896`).

---

## 1. Method and keep-out

**Read.**  `app/src/billing/*`, `app/src/client/commands.ts`, `app/src/ui/dashboardHtml.ts` checkout/portal JS, `clients/ios/CongressTrade/Store/*`, `PremiumSheet.swift`, `DeliveryView.swift`, `APIClient.swift`, billing/Apple tests, App Review notes, rollouts through 2026-08-16.

**Live, read-only.**  `GET /auth/me` and `GET /billing/status` (anonymous).  Stripe MCP `list_available_accounts_or_orgs` + `GET /v1/products`, `/v1/prices`, `/v1/webhook_endpoints`, `/v1/billing_portal/configurations` on `acct_19R0bZEUQUPhZj0S` **livemode only**.  Test-mode Stripe is not attached to this session (`No account found for … livemode=false`).

**Not done.**  `POST /billing/checkout`, `POST /billing/portal`, refunds, webhook replays, Infisical value dumps, `redeem_apple_purchase` against a real JWS, StoreKit `Product.purchase()`.

**Overlap.**  Open PRs `#1973` (web/iOS parity), `#1974`/`#1979` (security/blind-spots), `#1977` (extract/halt).  Those mention billing only as keep-out or as processor inventory.  No open PR is a purchases end-to-end audit.

**Verdict key.**  Pass = code + tests (and live config where probed) support the claim.  Fail = a paying user, App Review, or test/live mix can go wrong.  Partial = path exists but a named gap remains.

---

## 2. Executive summary

Web Stripe checkout and portal are **live and configured**.  Anonymous `GET /billing/status` on 2026-08-17 returned `checkoutConfigured: true` and `portalConfigured: true`.  The live Stripe account has one active SaaS product, **Congress.Trade Premium** (`prod_Ukn8Zyrz3gC7WI`), at `$5/mo` / `$50/yr`, and one enabled webhook to `https://congress.trade/billing/webhook` for the four events the Worker handles.

Native iOS purchase is StoreKit 2: load products, `purchase()`, redeem JWS on the backend, `finish()` only after redeem, `Transaction.updates` for the app lifetime, Restore via `AppStore.sync()` + current entitlements.  Server verification is real x5c-to-Apple-root, gated by `APPLE_IAP_ENABLED`.  That path is well tested on the backend.  The iOS target only tests the HTTP redeem client, not StoreKit itself.

**Do not treat this as green for App Review.**  The submitted review notes say iOS does not take web payments.  The binary still offers **Subscribe on Congress.Trade** (Safari) from Delivery and a website fallback when StoreKit products fail to load.  That is Guideline 3.1.1 for digital goods.

Highest residuals, in order:

1. iOS steers users to web Stripe checkout for Premium (App Review).
2. Apple `REFUND` notifications are acknowledged and not applied; Stripe `charge.refunded` is not subscribed.
3. No `livemode` / Apple `environment` gate on production redeem/webhook apply.
4. No iOS XCTest for product load, purchase, restore, finish-after-redeem, or manage-subscription routing.

---

## 3. Stripe account identity (CT vs other apps)

| Fact | Evidence |
|------|----------|
| MCP session has **one** Stripe account | `acct_19R0bZEUQUPhZj0S`, name **Jay Wedgeworth**, livemode only |
| Active SaaS product | `prod_Ukn8Zyrz3gC7WI` **Congress.Trade Premium**, tax code `txcd_10103000` |
| Live prices | `price_1TlHYBEUQUPhZj0SEzG2Qx68` $5/month; `price_1TlHYCEUQUPhZj0SpNVoPb3Z` $50/year.  Match `app/.prod.vars` and `docs/rollouts/2026-08-14-portal-config-r2-weekly.md` |
| Live webhook | `we_1TwcQaEUQUPhZj0SYrYN0oMP` → `https://congress.trade/billing/webhook`, status `enabled`, events `checkout.session.completed`, `customer.subscription.created|updated|deleted` |
| Live portal config | `bpc_1U4RljEUQUPhZj0SsQhzc1bc`, `is_default: true`, headline “Manage your Congress.Trade Premium subscription”, cancel at period end, **subscription update disabled** |
| Other fleet apps | **No** Socratic.Trade or Usage Monitor products on this account |

**Distinction.**  Congress.Trade customer billing is this account’s Premium product and the `congress.trade/billing/webhook` endpoint.  It is not ST/UM Stripe.  The same account still has leftover **personal** one-time prices (inactive products: Flights, Social Media Ad Optimization, Consulting Services).  Those prices are not referenced by CT code.  They are account hygiene, not a cross-app entitlement mix-up.

**Not verified here.**  Infisical `STRIPE_SECRET_KEY` prefix (`sk_live_` vs `sk_test_`) and `STRIPE_PORTAL_CONFIGURATION` length.  Checkout/portal readiness on the live site is true, which requires the secret + both prices + webhook secret to resolve.

---

## 4. Web Stripe checklist

| Check | Verdict | Evidence |
|-------|---------|----------|
| Hosted Checkout | **Pass** | `POST /billing/checkout` requires session, `checkoutConfigured`, JSON `{plan}`, and `Idempotency-Key`.  Creates/links customer, then a `mode=subscription` session with `client_reference_id` + `subscription_data.metadata.userId`.  `app/src/billing/routes.ts` 107–158, `stripe.ts` 141–178.  UI: `startCheckout()` in `dashboardHtml.ts` 11908–11930. |
| Trial | **Pass** | Default 14 days; Infisical `STRIPE_TRIAL_DAYS` override.  Live prices have `trial_period_days: null`; trial is applied at Checkout, not on the Price.  Rollout `2026-08-14-premium-trial-asc-verified.md`. |
| Customer portal | **Pass** | `POST /billing/portal` requires session, portal capability, existing `stripeCustomerId`, Idempotency-Key.  Forwards `STRIPE_PORTAL_CONFIGURATION`.  Live default config exists.  Web `manageBilling()` sends Apple users to App Store subscriptions, Stripe users to the portal (`dashboardHtml.ts` 11932–11963). |
| Webhook signature | **Pass** | Raw body + `Stripe-Signature` HMAC-SHA256, 300s skew, constant-time compare, fail-closed without secret.  `stripe.ts` 239–259.  Test: `routes.test.ts` “rejects an invalid signature with 400”. |
| Event set | **Pass** (narrow) | Handler switch matches the **live** endpoint’s four events.  Unrelated types are ignored after a successful claim.  `invoice.paid` / `invoice.payment_failed` are not required if `customer.subscription.updated` always follows; they are also not subscribed. |
| Entitlement update | **Pass** | `applySubscription` / `endSubscription` with event-order table.  Premium only for `trialing`/`active` and a known plan.  `past_due` / `unpaid` / `canceled` are not Premium.  `entitlement.ts` 18–45, `subscription.ts` 169–292. |
| Retries / idempotency | **Pass** | Checkout/portal: required client `Idempotency-Key` + `congress-trade:<op>:<userId>:<id>` on Stripe POSTs.  Webhook: `stripe_webhook_events` claim / processed / release; duplicate → `{received, duplicate}`; busy → 503 + `Retry-After: 5`.  Out-of-order subscription events fail closed.  Tests in `webhookEvents.test.ts`, `routes.test.ts`, `subscription.test.ts`. |
| Cancel (user abandons Checkout) | **Pass** | `cancel_url` `/?checkout=cancel`.  Toast: “Checkout canceled — no charge was made.”  No webhook required.  `dashboardHtml.ts` 12079. |
| Cancel at period end | **Pass** | Stored on `users.cancel_at_period_end`.  Portal cancel mode is `at_period_end`.  User stays Premium until `customer.subscription.deleted` or status leaves `active`/`trialing`. |
| Refund / dispute | **Fail** | Live webhook does **not** include `charge.refunded`, `charge.dispute.created`, or `invoice.paid`.  A refund that leaves the Stripe Subscription `active` would keep Premium until a later `updated`/`deleted`.  No test asserts refund → not Premium. |
| Failure (API/config) | **Pass** | Missing config → 503.  Stripe API errors → 502, no URL.  UI re-enables the button and keeps the same Idempotency-Key so retry cannot double-write. |
| Test vs live | **Partial** | Live endpoint is `livemode: true`.  Handler never reads `event.livemode`.  A test-mode event that verified against a mistakenly shared secret would apply.  Unit tests use `sk_test` fixtures only.  This MCP session cannot list test-mode products. |
| Tests / evidence | **Pass** | `stripe.test.ts`, `routes.test.ts`, `webhookEvents.test.ts`, `subscription.test.ts`, `entitlement.test.ts`, dashboard HTML checkout/portal strings.  Live capability probe 2026-08-17.  No live Checkout session created this audit. |

### Stripe notes (not separate fails)

- Portal **cannot** switch monthly ↔ annual (`subscription_update.enabled: false`).  Cancel and payment-method update work.  Plan changes need a new Checkout or an ops change to the portal configuration.
- `start_checkout` exists as a client command type and **fails** with `start_checkout is not implemented yet` (`commands.ts` 351, `routes.test.ts` 1534–1554).  Web does not use that command; it POSTs `/billing/checkout`.  iOS does not call it.
- Checkout success toast assumes the trial is already active (`You’re in!`).  Entitlement is webhook-sourced; a slow `subscription.created` can still show free until refresh.  `#1896` already waits on `/auth/me` before painting the paywall.

---

## 5. Native iOS StoreKit / IAP checklist

| Check | Verdict | Evidence |
|-------|---------|----------|
| Product load | **Pass** (code) | `Product.products(for:)` on `trade.congress.premium.monthly` / `.annual`.  `PremiumSheet.swift` 273–283, `Models.swift` 884–886.  Empty list is a user-visible fallback (see App Review). |
| Purchase | **Pass** (code) | `product.purchase()` → StoreKit verification → `redeemAppleTransaction` → `finish()`.  User cancel clears notice.  Pending Ask to Buy is explained.  `PremiumSheet.swift` 285–311. |
| Restore | **Pass** (code) | `AppStore.sync()` then `redeemCurrentAppleEntitlements()`.  Honest empty copy.  `PremiumSheet.swift` 313–327, `AppleIAP.swift` 34–52. |
| Verify + finish | **Pass** (code) | `finish()` is **after** a successful `redeem_apple_purchase`.  Failed redeem leaves the transaction unfinished so `Transaction.updates` retries.  Signed-out updates are left unfinished.  `AppleIAP.swift` 18–73.  App-lifetime observer in `App.swift` 274–278. |
| Entitlement sync | **Pass** | Command verifies JWS, bundle, configured product id, active window, upserts `apple_subscriptions` keyed by `originalTransactionId`, 409 on owner mismatch.  Inline execute under 9s (`INLINE_COMMAND_BUDGET_MS`) after `#1835`.  `commands.ts` 293–349. |
| Subscription status | **Partial** | Webhook applies `DID_RENEW`, `EXPIRED`, `REVOKE`, `DID_CHANGE_RENEWAL_STATUS`, `DID_FAIL_TO_RENEW`, `GRACE_PERIOD_EXPIRED`.  Grace grants Premium (`appleStatusGrantsAccess`).  `REFUND`, `SUBSCRIBED`, `PRICE_INCREASE` are acknowledged and **not** applied (`appleWebhook.ts` 107–110). |
| Server verification | **Pass** | `verifyAppleSignedJws`: ES256, x5c length 3, Apple Root CA G3 pin, WWDR/leaf marker OIDs.  Legacy `POST /billing/apple/confirm` uses the same verifier + `APPLE_IAP_ENABLED` (no longer shape-only). |
| Sandbox vs Production | **Fail** | Redeem stores `transaction.environment` and does not reject `Sandbox` in production.  A valid sandbox JWS can grant live Premium if `APPLE_IAP_ENABLED` is true.  No test covers that. |
| Tests / evidence | **Partial** | Backend: `commands.test.ts` (enable gate, verify fail, bundle/product/expiry/revoke, idempotent restore, owner mismatch, renewal expiry), `appleWebhook.test.ts` (503 gate, JWS, idempotency, renew/expire/revoke/grace), `appleJws.test.ts`, `appleCrypto.test.ts`.  iOS: HTTP redeem encode + failed-command mapping only (`CongressTradeTests.swift` 817–890).  **No** XCTest for `Product.products`, `purchase()`, `AppStore.sync`, `finish()` ordering, or `resolveManageSubscriptionURL`.  Owner TestFlight receipt: `#1835` / rollout `2026-08-13-ios-paywall-one-screen-and-inline-commands.md`.  This audit did not run StoreKit. |

### iOS notes

- Webhook cannot create a ledger row.  A notification before the first successful redeem is 200 + ignore (`appleWebhook.ts` 159–167).  `Transaction.updates` is the intended repair.
- Legacy confirm writes Apple state onto `users.stripe_subscription_id` as `apple:…`.  Current redeem writes `apple_subscriptions`.  `resolveEntitlementAsync` ORs both.  Dual columns are compatible; confirm is a leftover, not the iOS path.
- `APPLE_IAP_ENABLED` is not on public `/auth/me`.  Live value was not printed.  Historical rollouts said it stayed off until ASC approval; `#1835` required it on for the owner’s TestFlight charge to redeem.

---

## 6. App Review compliance

Review notes (`docs/app-store/review-notes-1.0.txt` line 29):

> Apple In-App Purchase / StoreKit 2 for iOS Premium (web Premium uses Stripe at Congress.Trade; **iOS does not take web payments**)

| Surface | Verdict | Evidence |
|---------|---------|----------|
| Primary paywall | **Pass** | Signed-in + products loaded → StoreKit buttons only.  Accessibility hint says “Starts an App Store purchase”.  `PremiumSheet.swift` 160–166, 215–243. |
| Empty StoreKit catalog | **Fail** | Copy: “You can still subscribe on the website.”  `Link("Open Congress.Trade pricing")` → `upgradeURL` (`/` on congress.trade).  `PremiumSheet.swift` 148–157. |
| Delivery upgrade | **Fail** | “Upgrade with In-App Purchase **or on the website**”.  Button “Subscribe with Apple” plus `Link` “Or subscribe on Congress.Trade” (Safari).  `DeliveryView.swift` 76–96. |
| `POST /billing/checkout` from iOS | **Pass** | No iOS caller.  `upgradeURL` comment says checkout is cookie-session and the app must not replay it (`APIClient.swift` 155–162). |
| Manage existing Stripe sub | **Pass** (account management) | `entitlement.source == "apple"` → App Store subscriptions URL.  Stripe / nil → `POST /billing/portal` (bearer).  No App Store fallback for Stripe payers.  `ManageSubscription.swift` 31–40.  Guideline 3.1.3(b)-style management of a subscription bought on the web, not a new digital-goods checkout. |
| Review-notes vs binary | **Fail** | Notes deny web payments inside iOS.  Delivery + empty-IAP fallback still offer them. |

Apple’s 3.1.1 bar: unlocking Premium (PDFs, CSV, webhook/SSE, push) from a website checkout **inside the iOS app** is the problem.  Linking to Terms/Privacy is fine.  Opening the Stripe portal for someone who already bought on the web is the intended multi-platform manage path (`#1561`, `#1862`).

---

## 7. What is already solid

1. Checkout and portal are split-ready: portal can work without both prices; checkout cannot.
2. Stripe webhook claim/release matches Apple’s notificationUUID ledger.
3. Subscription event order table prevents stale `updated` from clobbering `deleted`.
4. Premium is not granted for `past_due` (Stripe smart retries stay `active` until they fail).
5. Apple JWS is pinned cryptography, not a shape check (`#1560`, `#1562`).
6. Redeem is idempotent on `originalTransactionId` and will not move a subscription to another user.
7. Finish-after-redeem plus `Transaction.updates` is the correct StoreKit 2 retry story (`#1835`).
8. Web and iOS both route **manage** by `entitlement.source`.
9. Live Stripe catalog for CT is one product and two recurring prices; ST/UM are not on this account.
10. Unit tests cover the Stripe HTTP router and Apple redeem/webhook state machine without charging anyone.

---

## 8. Fix PRs (exact slices; not this report)

Report-only.  Each row is a later implementation PR.  Do not fold these into `#1977` or `#1973`.

### P0 — App Review (ship before the next binary if 1.0 is still in review)

**PR A — `cursor/ios-no-web-checkout`**  
Remove in-app CTAs that start or advertise **new** web Stripe checkout for digital goods.

- Delete Delivery “Or subscribe on Congress.Trade” and the “or on the website” sentence (`DeliveryView.swift` 76–96).
- Delete Premium empty-catalog website link and “subscribe on the website” (`PremiumSheet.swift` 148–157).  Keep Restore + a non-purchase error (“In-app purchase isn’t available.  Try again later.”).
- Keep StoreKit purchase buttons and Restore.
- Keep Manage Subscription → App Store (Apple) or Billing Portal (existing Stripe).
- Add an XCTest or fixture assert that Delivery/Premium copy does not contain `congress.trade` purchase links.
- Align `docs/app-store/review-notes-1.0.txt` with the binary.

### P1 — Money-path correctness

**PR B — `cursor/apple-refund-and-sandbox`**

- Apply `REFUND` like `REVOKE` (or expire + `revokedAt`) on `apple_subscriptions`.
- Reject `environment === "Sandbox"` in production redeem + webhook apply unless an explicit `APPLE_IAP_ALLOW_SANDBOX=true` (local/TestFlight only).
- Tests: REFUND drops Premium; Sandbox JWS 400/403 when the allow flag is off.

**PR C — `cursor/stripe-livemode-and-refunds`**

- Require `event.livemode` to match the resolved `STRIPE_SECRET_KEY` prefix (`sk_live_` vs `sk_test_`).  Mismatch → 400, no apply.
- Decide and implement: subscribe `charge.refunded` / `charge.dispute.created` **or** document that only `customer.subscription.updated|deleted` revoke access (and add a test for “refunded charge, subscription still active → still Premium” if that is the product rule).
- Tests for livemode reject + the chosen refund rule.

### P2 — Evidence and leftovers

**PR D — `cursor/ios-storekit-tests`**

- XCTest: `resolveManageSubscriptionURL` Apple vs Stripe vs 400/401/503 copy.
- XCTest: redeem client still sends `redeem_apple_purchase` (exists) plus a store-level test that a failed redeem does not call `finish()` (extract the ordering if needed).
- Do not add a StoreKit Configuration file unless Jay asks (rollout `2026-08-14-premium-trial-asc-verified.md`).

**PR E — optional hygiene (ops + small code)**

- Archive leftover personal prices on `acct_19R0bZEUQUPhZj0S` (Flights / ads / consulting) so CT is the only active catalog.
- Confirm Infisical `STRIPE_PORTAL_CONFIGURATION=bpc_1U4RljEUQUPhZj0SsQhzc1bc` (length-only).
- Either implement `start_checkout` as a documented 501 forever or remove it from `ClientCommandType` so iOS cannot grow a Stripe checkout command.
- Point legacy `/billing/apple/confirm` at `apple_subscriptions` instead of `users.stripe_*` so the two ledgers cannot diverge.

---

## 9. Explicit non-findings

- Did not create a Checkout Session, Portal Session, PaymentIntent, or refund.
- Did not call StoreKit `purchase()` or `AppStore.sync()` on a device.
- Did not print Infisical or Stripe secret values.
- Did not treat OpenRouter files-prepaid / `#1977` as customer billing.
- Did not re-implement `#1835` inline redeem or `#1875` Apple grace.
- Test-mode Stripe catalog is **unknown** in this session (MCP has live only).
- Live `APPLE_IAP_ENABLED` was not read (would be an Infisical get).  Public `/auth/me` does not expose it.
