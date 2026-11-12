# 2026-08-09 — iOS build 202608082010 shipped to TestFlight (VALID)

First CT TestFlight ship carrying Sign in with Apple + StoreKit 2 IAP client
(PRs #1558/#1561) plus the day's iOS punch-list work.

## Two STALE facts corrected

The ASC status note under the local Apple secrets folder (dated 2026-08-07)
claimed:

1. *"Install release Xcode from Mac App Store"* — **already satisfied**:
   Xcode **26.6** (iOS 26.5 SDK) is installed AND `xcode-select`ed. Only the
   side-by-side Xcode-beta 27.0 (iOS 27 beta SDK) is submission-invalid.
2. *"App Store upload FAILED"* — **uploads had in fact succeeded**: builds
   202608070935 / 202608071525 / 202608071522 are `VALID` in ASC.

Verify current truth via the ASC API rather than that note.

## Real blockers hit today + fixes

| Blocker | Fix |
|---|---|
| `Provisioning profile ... doesn't include the Sign In with Apple capability` / `com.apple.developer.applesignin entitlement` — the App ID had only IN_APP_PURCHASE + PUSH_NOTIFICATIONS | Enabled `APPLE_ID_AUTH` on bundle `trade.congress.ios` via ASC API `POST /v1/bundleIdCapabilities`. **Gotcha:** a bare capabilityType 409s with *"Please select at least one configuration"* — the payload must include `settings: [{key: APPLE_ID_AUTH_APP_CONSENT, options: [{key: PRIMARY_APP_CONSENT}]}]`. |
| `Unable to log in with account 'mail@jays.services' ... login details were rejected` — Xcode's saved session is stale, breaking automatic signing | Pass the ASC API key straight to xcodebuild: `-authenticationKeyPath` / `-authenticationKeyID` / `-authenticationKeyIssuerID` on **both** `archive` and `-exportArchive`. No Xcode UI sign-in needed. |

`/Users/jay/apps/ios-fleet/ship-testflight.sh` now builds an `ASC_AUTH_FLAGS`
array from the `ASC_KEY_PATH` / `ASC_KEY_ID` / `ASC_ISSUER_ID` env values and
passes it to every xcodebuild invocation, so the pipeline no longer depends on
the Xcode session (applies to all fleet apps: congress / socratic / usage).

## Production config set (Infisical, CT prod)

`APPLE_BUNDLE_ID=trade.congress.ios`,
`APPLE_PRODUCT_MONTHLY=trade.congress.premium.monthly`,
`APPLE_PRODUCT_ANNUAL=trade.congress.premium.annual` — matching the live ASC
products. **`APPLE_SIGNIN_ENABLED` / `APPLE_IAP_ENABLED` remain OFF** until the
app + subscriptions are approved.

## Owner-only remaining (browser)

App Privacy nutrition labels; submit the app **with** both subscriptions (this
is what clears their `MISSING_METADATA` state); accept the Paid Applications
agreement if not already accepted.
