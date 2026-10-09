# Charm pricing + 1-week trial alignment (2026-10-09)

## Summary

Marketing copy on web and iOS now quotes **$8.99/mo · $79.99/yr** and a **1-week**
free trial.  This rollout aligns Stripe checkout defaults, the published Terms of
Service, and operator configuration so checkout matches what users read.

The exploratory WidgetKit extension from an earlier revision of PR #2618 was
**removed** from this branch.  A proper widget (XcodeGen `project.yml`, App Group
`group.trade.congress`, Mac Bonjour snapshot source) is deferred to a follow-up PR.

## Files changed

- `app/src/billing/routes.ts` — `DEFAULT_TRIAL_DAYS` **7** (was 14)
- `app/src/ui/legalHtml.ts` — ToS §3 subscription price + trial length
- `app/src/ui/__tests__/legalHtml.test.ts` — guards for new canonical copy
- `app/docs/wave4-auth-billing.md` — operator runbook
- `scripts/ios-ci-xctest.sh` + `.github/workflows/ios-build.yml` — post-XCTest simulator screenshot artifact

## Verification

From `app/`:

```bash
npm run typecheck
npm test
```

Confirm `legalHtml.test.ts` and `dashboardHtml.test.ts` pricing/trial assertions pass.

After deploy, spot-check:

- `GET /terms-of-service` shows $8.99 / $79.99 and 7 days / 1 week
- Dashboard pricing modal shows `$8.99` / `$79.99` (not rounded `$9` / `$80`)
- Stripe test checkout session includes `trial_period_days: 7` when `STRIPE_TRIAL_DAYS` is unset

## Follow-ups (owner / Infisical / ASC)

1. Set Infisical prod **`STRIPE_TRIAL_DAYS=7`** (was 14 per
   `docs/rollouts/2026-08-14-premium-trial-asc-verified.md`).
2. Update Stripe **Price** objects if still at $5/$50 — charm prices must match
   `STRIPE_PRICE_MONTHLY` / `STRIPE_PRICE_ANNUAL`.
3. App Store Connect: set intro offer to **`ONE_WEEK`** (and charm prices) on
   `trade.congress.premium.monthly` / `.annual` when ASC still shows `TWO_WEEKS`
   / $5/$50.
4. Revisit WidgetKit in a dedicated PR (XcodeGen-only, no hand-edited `pbxproj`).
