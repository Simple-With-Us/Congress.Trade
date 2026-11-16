# Socratic-Trade push receipt (ST-3846)

## Context & Objective

`shareWithPeer` treated any HTTP 200 from Socratic-Trade `POST /api/admin/securities/import` as a successful push.  The body was not read.  A response with no push id and no delivered or consumed ack looked the same as a push whose rows were stored and readable.  This sends a push id and alerts when those acks are missing.

## Changes Made

- Generate a push id, send it as `x-push-id` and as `pushId` on the JSON body (added after `SharePayloadSchema` strips unknown keys).
- Parse the peer receipt.  `health: ok` requires the echoed id plus both acks.
- On a 2xx body that is missing an ack, do not mark the push sent.  Warn in Sentry and send the throttled admin email (`dedupeKey` `peer-push-missing-ack`, 12 hours).  Do not open the peer target circuit.  The HTTP call itself succeeded.

**Files touched**

- `app/src/share/peerPushReceipt.ts`
- `app/src/share/outbound.ts`
- `app/src/share/__tests__/outbound.test.ts`
- `app/src/share/__tests__/peerPushReceipt.test.ts`
- `docs/rollouts/2026-10-15-st-push-receipt.md`

## Decisions & Trade-offs

- The receiver change lives in Socratic-Trade on branch `cursor/ct-push-receipt-2155`.  Until that deploy, this app will alert on the old `{ ok: true }` body.  The email is throttled.
- A consumed ack with `ok: false` still counts as present.  The alert is for a missing ack, not for a dataset the peer acknowledges and does not store.

## Verification State

```bash
cd app && npx vitest run src/share/__tests__/outbound.test.ts src/share/__tests__/peerPushReceipt.test.ts
# 12 passed
```

## Next Steps & Blockers

- Ship together with the Socratic-Trade pull.  Linear ST-3846 stays in progress until both merge.

## Zero-Code Findings

- None.
