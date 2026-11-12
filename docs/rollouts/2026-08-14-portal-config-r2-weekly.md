# 2026-08-14 — Billing Portal lists Premium + R2 weekly status [GROK]

## Summary

Manage Subscription opened Stripe's hosted portal with **no live Billing Portal configuration**.  Stripe's implicit default can hide Congress.Trade Premium and show an empty subscription list.  This lane creates a live configuration for product `prod_Ukn8Zyrz3gC7WI` (monthly `price_1TlHYBEUQUPhZj0SEzG2Qx68`, annual `price_1TlHYCEUQUPhZj0SpNVoPb3Z`) and passes `STRIPE_PORTAL_CONFIGURATION` on `POST /billing/portal`.

Congress.Trade `/api/health` now publishes `checks.storage.r2Weekly` from a local receipt written by `scripts/ops/fleet-sqlite-backup.sh` after a successful Sunday R2 copy.  Usage Monitor reads that field so this app can say R2 weekly is fine the same way UM already does.

## Files changed

- `app/src/billing/stripe.ts`, `app/src/billing/routes.ts` — pass `configuration`
- `app/src/shared/r2WeeklyArchive.ts` — receipt reader (8-day window)
- `app/src/delivery/rest.ts` — `checks.storage.r2Weekly`
- `scripts/ops/fleet-sqlite-backup.sh` — write `/data/congress-trade/.r2-archive-status.json`

## Verification

- `npx vitest run src/billing/__tests__/stripe.test.ts src/billing/__tests__/routes.test.ts src/shared/__tests__/r2WeeklyArchive.test.ts`
- Live portal configurations list includes the new `bpc_…` after Infisical `STRIPE_PORTAL_CONFIGURATION` is set
- After deploy + a receipt file, `GET /api/health` includes `checks.storage.r2Weekly.ok`

## Follow-ups

- Host `scripts/ops/fleet-sqlite-backup.sh` must be updated on `fleet-hetzner-nbg1` (the cron copy, not only git)
- Infisical CT prod needs `STRIPE_PORTAL_CONFIGURATION` (length-only verify)
- Sibling ST/UM PRs publish / consume the same `r2Weekly` shape
