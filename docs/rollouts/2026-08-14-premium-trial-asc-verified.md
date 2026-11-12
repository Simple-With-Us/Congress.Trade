# 2026-08-14 — Premium trial length verified against App Store Connect + Stripe

## 1. Context & Objective

Monet's Premium-features chat left two items unverified after #1835 shipped
2-week trial copy everywhere: whether App Store Connect actually honors a
2-week introductory offer, and whether `STRIPE_TRIAL_DAYS` in production is 14.
The app must not quote a trial Apple or Stripe will refuse.

## 2. Changes Made

Verification only.  No product, price, or trial-length change.  A receipt
comment was added on `PremiumPricing` so the next agent does not re-guess.

- `clients/ios/CongressTrade/Views/Status/PremiumSheet.swift` — comment only
- `docs/rollouts/2026-08-13-ios-paywall-one-screen-and-inline-commands.md` —
  next-steps marked verified
- `docs/rollouts/2026-08-14-premium-trial-asc-verified.md` — this note
- `docs/EFFORT-LOG.md`, `STATUS.md`

## 3. Decisions & Trade-offs

- **ASC is the authority for Apple trials.**  Queried live via
  `scripts/ios-fleet/asc-api.mjs` against app `6798076688` (bundle
  `trade.congress.ios`), subscription group `22287016` (Premium).
- **Did not change ASC or Stripe.**  Both already match the 2-week copy.
- **Did not ship a new TestFlight for this.**  Build `202608141034`
  (TestFlight 1.0.14, uploaded 2026-08-14, `VALID`) is after #1835
  (`c38b6787`, 2026-08-13).  The one-screen Premium sheet is already on the
  phone.  Sign in there to see the real StoreKit plan buttons.
- **Did not add a StoreKit Configuration file.**  That would need a shared
  scheme / pbxproj edit for the simulator to load products.  Monet's
  signed-out screenshot was also the code path: `PremiumSheet` hides purchase
  buttons until `store.signedIn` because the redeem must attach to an
  account.  That is intentional, not a StoreKit failure.

## 4. Verification State

Live App Store Connect (`GET /v1/subscriptionGroups/22287016/subscriptions?include=introductoryOffers`
and `GET /v1/subscriptions/{id}/prices?include=subscriptionPricePoint,territory`):

| Product | Period | US price | Intro offer |
|---|---|---|---|
| `trade.congress.premium.monthly` (`6798078775`) | `ONE_MONTH` | **$5.00** USD | `FREE_TRIAL` / **`TWO_WEEKS`** / 1 period / start 2026-08-12 / no end |
| `trade.congress.premium.annual` (`6798078776`) | `ONE_YEAR` | **$50.00** USD | `FREE_TRIAL` / **`TWO_WEEKS`** / 1 period / start 2026-08-12 / no end |

Both subscriptions still report `MISSING_METADATA`.  That is Apple's
chicken-and-egg state until the version is submitted; it does **not** mean
the intro offer is missing.

Production Stripe: Infisical CT prod `STRIPE_TRIAL_DAYS=14` (integer get,
names-only listing of sibling Stripe/Apple keys).  Code default when unset
is also 14 (`app/src/billing/routes.ts`).

App copy already matches: `PremiumPricing.headline`, Delivery, CSV export
empty-state, and the Terms page ("14 days / 2 weeks").

## 5. Next Steps & Blockers

1. No trial-length owner call is required.  Apple, Stripe, and the app agree
   on 2 weeks.
2. To see the actual Monthly / Annual purchase buttons, open TestFlight
   1.0.14 (or newer), sign in, then open Premium.  A bare simulator will
   still hide them when signed out and will not load StoreKit products
   without an ASC sandbox or a StoreKit Configuration.
3. A fresh end-to-end purchase still needs a new sandbox tester — the
   owner's existing Premium grant already landed.

## 6. Zero-Code Findings

- Monet's "plan buttons render signed-out" screenshot is explained by
  `PremiumSheet.actionSection`: `!store.signedIn` short-circuits before
  products are shown.  StoreKit sandbox is a second, real constraint for
  a signed-in simulator, but it was not why that screenshot was empty.
