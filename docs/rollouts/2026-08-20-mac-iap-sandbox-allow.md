# Mac / TestFlight IAP: allow Apple-signed Sandbox JWS

Thu, Aug 20, 2026

Owner screenshot on Mac (Designed-for-iPad): StoreKit returned success
("Purchase confirmed. Unlocking Premium…") then the paywall showed

> Apple took the purchase, but Congress.Trade could not confirm it yet.
> (Sandbox Apple purchases are not accepted)

## Cause

`#2030` rejected `environment === 'Sandbox'` unless Infisical
`APPLE_ALLOW_SANDBOX === 'true'`. That key was **missing** in prod Infisical
(`scripts/infisical-secrets-safe.sh has` → missing).

The iOS binary talks only to production `congress.trade`.  Designed-for-iPad
on Mac, TestFlight, Xcode, and App Review all send Apple-signed JWS with
`environment=Sandbox`.  Rejecting those leaves Apple having confirmed the
purchase and Congress.Trade refusing to write `apple_subscriptions`, so
Premium never unlocks.  `transaction.finish()` is correctly deferred, so
Restore / `Transaction.updates` retries once the server allows it.

A Sandbox JWS is still chain-verified against the pinned Apple Root CA.  Forging
Premium still requires Apple's private key (or TestFlight / Xcode access to this
bundle).  The ledger keeps `environment` so sandbox grants stay distinguishable
from Mac App Store Production receipts.

## Change

- `appleSandboxPurchasesAllowed`: allow unless the flag is explicitly
  `false` / `0` / `no`. Unset and `true` both allow.
- Same helper gates redeem, anonymous redeem, `link_apple_entitlement`,
  `/billing/apple/confirm`, and non-access-ending App Store Server
  Notifications.
- Infisical prod `APPLE_ALLOW_SANDBOX=true` so **current** production
  (still on the #2030 `=== 'true'` check) unlocks Restore Purchases
  before this deploy.

Kill switch: `APPLE_ALLOW_SANDBOX=false`.

## Verify

Tap Restore Purchases on the Mac paywall (or reopen the app).  Premium
should unlock without buying again.  No new TestFlight: iOS client
unchanged.

Issue: #2095. Board: `647f42cb`.
