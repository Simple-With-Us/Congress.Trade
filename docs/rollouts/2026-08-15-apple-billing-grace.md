# 2026-08-15 — Apple Billing Grace Period: 3 days, paid-to-paid

## Summary

Owner turned on App Store Billing Grace Period.  Live ASC for
`trade.congress.ios`:

- Duration: **3 days** (`THREE_DAYS`)
- Eligible: **Only Paid-to-Paid Renewals** (`PAID_TO_PAID_ONLY`)
- Environments: **Production and Sandbox** (`optIn` + `sandboxOptIn`)

A failed *paid* renewal keeps Premium for 3 days while Apple retries the
card.  A free-trial → first paid failure does **not** get the window.

The ledger already treated `grace_period` as Premium.  The webhook did not
apply `DID_FAIL_TO_RENEW` / `GRACE_PERIOD_EXPIRED`, so access would have
dropped at the original expiry.  Those events now update the row:

- `DID_FAIL_TO_RENEW` + grace → `grace_period`, `expires_date` = Apple's
  `gracePeriodExpiresDate`
- `DID_FAIL_TO_RENEW` with retry only → `billing_retry` (no access)
- `GRACE_PERIOD_EXPIRED` → `billing_retry` or `expired`

## Files changed

- `app/src/billing/appleWebhook.ts`
- `app/src/billing/__tests__/appleWebhook.test.ts`

ASC write: `PATCH /v1/subscriptionGracePeriods/6798076688` (already live).

## Verification

```
npx vitest run src/billing/__tests__/appleWebhook.test.ts \
  src/billing/__tests__/entitlement.test.ts
# 28 passed
```

Live ASC re-read: `optIn=true`, `sandboxOptIn=true`, `duration=THREE_DAYS`,
`renewalType=PAID_TO_PAID_ONLY`.

## Follow-ups

- `redeem_apple_purchase` still rejects a signed transaction whose
  `expiresDate` is in the past.  During grace, StoreKit may send that.
  The webhook is the path that keeps Premium; restore during grace may
  400 until DID_RENEW.  Fix if a tester hits it.
