# Congress → Socratic Trade webhook consumption receipt (ST-3846)

## Context & Objective

Webhook dispatch marked deliveries `delivered` on HTTP 2xx without validating App B's JSON body.  Socratic Trade now returns `receiptVersion: 1` with `consumed`; this change parses that receipt and retries when consumption fails.

## Changes Made

- `app/src/delivery/pushReceipt.ts` — parse/validate receipt (legacy `ok`/`applied` tolerated).
- `app/src/delivery/webhook.ts` — when the response is a recognized v1 or legacy ok/applied receipt, fail delivery when `consumed=false`; generic third-party 2xx bodies unchanged.
- Tests updated in `deliveryEntitlement`, `queueRetry`, new `pushReceipt.test.ts`.

## Verification State

```bash
npm test -- src/delivery/__tests__/pushReceipt.test.ts src/delivery/__tests__/queueRetry.test.ts src/delivery/__tests__/deliveryEntitlement.test.ts
```

23 passed.

## Next Steps

Deploy after the matching Socratic Trade webhook receipt PR is live.
