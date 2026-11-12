# 2026-08-14 — Trial copy already matches the 2-week offer [GROK]

## 1. Context & Objective

Monet's App / Issue Audit left an owner decision: Congress.Trade store copy said
one month while the configured offer was two weeks.  Finish that leftover if it
is still true — make copy match the actual offer — or document that the owner
later changed the offer.  Do not write App Store Connect.

## 2. Changes Made

User-facing copy was already aligned to 2 weeks on `origin/main` by Claude #1835
(`c38b6787`, 2026-08-13).  This pass verified the live offer and cleaned the last
operator-facing leftover that still described a 1-month trial as current.

Touched:

- `app/docs/wave4-auth-billing.md` — runbook still said 1-month / `STRIPE_TRIAL_DAYS=30` / "defaults to 7".  Now 2 weeks / 14 / Infisical prod is 14.
- `app/src/ui/__tests__/legalHtml.test.ts` — file header still said "1-month trial".  Assertions already required 14 days / not 30 days.
- `STATUS.md`, `docs/EFFORT-LOG.md`, this note.

No App Store Connect writes.  No Stripe product/price writes.  No Infisical writes.

## 3. Decisions & Trade-offs

- **Match copy to the offer, not the other way around.**  The offer is 14 days
  everywhere that actually charges: Infisical `STRIPE_TRIAL_DAYS` classifies as
  `14` (length 2, hash-only check), code default is 14, ASC introductory offers
  on `trade.congress.premium.monthly` and `.annual` are `FREE_TRIAL` /
  `TWO_WEEKS` (started 2026-08-12, no end date).  Stripe live prices
  `price_1TlHYBEUQUPhZj0SEzG2Qx68` ($5/mo) and `price_1TlHYCEUQUPhZj0SpNVoPb3Z`
  ($50/yr) carry `trial_period_days: null` — checkout applies the env default,
  which is 14.
- **Did not change user-facing strings.**  Web dashboard, iOS `PremiumPricing.headline`,
  Delivery / CSV cues, ToS ("14 days / 2 weeks"), and the ASC en-US listing
  description already say 2-week free trial.
- Historical effort-log rows that record the 2026-08-05 1-month first-ship stay
  as history.

## 4. Verification State

```
# User-facing 1-month trial copy on this branch (none remaining)
rg -n '1-month free trial|30 days / 1 month' --glob '!docs/EFFORT-LOG.md' --glob '!**/node_modules/**'

# Configured offer
# Infisical prod STRIPE_TRIAL_DAYS classified=14 (len=2, value not printed)
# ASC GET /v1/subscriptions/6798078775/introductoryOffers  duration=TWO_WEEKS
# ASC GET /v1/subscriptions/6798078776/introductoryOffers  duration=TWO_WEEKS
# ASC listing 7824c023-… en-US description: "Pricing: 2-week free trial, then $5/month or $50/year"

# Gates (docs + one comment; no runtime code)
cd /Users/jay/apps/congress-grok-trial-copy
# land.sh runs the repo gate
```

## 5. Next Steps & Blockers

- None for trial copy.  Claude's 2026-08-13 owner follow-up ("confirm ASC intro
  offer is 2 weeks") is closed by this verification.
- Remaining Monet owner-only leftovers (TestFlight accept, Litestream Coolify
  rolling + B2 cleanup, fill ASC EULA / betaAppReviewDetails) are documented in
  Socratic.Trade `docs/rollouts/2026-08-14-monet-audit-owner-decisions.md`.  Do
  not accept TestFlight, do not flip Coolify deploy strategy, do not mint B2
  keys, do not write ASC.

## 6. Zero-Code Findings

- Monet's "store copy says one month" was true before #1835.  It is not true
  today.  The ASC public listing already quotes 2 weeks.
- ASC subscription products are still `MISSING_METADATA` (not this lane).
