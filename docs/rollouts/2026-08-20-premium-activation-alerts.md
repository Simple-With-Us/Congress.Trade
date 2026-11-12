# Premium activation alerts (migration 0093) + Codex review round

## 1. Context & Objective

Notify the owner's Pushover the first time anyone becomes Premium, from either
billing path (Stripe checkout or Apple IAP).  Fires once per subscription, never
on renewals.

This note also records the eight Codex review findings raised against the
original implementation and how each was resolved, since several were real
correctness bugs rather than style.

## 2. Changes Made

- `app/src/billing/premiumActivationAlert.ts` — the notifier: claim, totals, send.
- `app/migrations/0093_premium_activation_alerts.sql` + `app/src/admin/migrations.ts`
  + `app/src/admin/__tests__/migrations.test.ts` — `premium_activation_notices`
  plus the two supporting indexes.  (Numbered 0090 originally; renumbered twice
  by collisions with `admin_allowlist` and `apple_subscriptions_nullable_user`.)
- `app/src/billing/routes.ts` — Stripe webhook + the deprecated
  `POST /billing/apple/confirm` path.
- `app/src/client/commands.ts` — `redeem_apple_purchase`.
- `app/src/billing/appleSubscriptions.ts` — newness re-checked after the upsert.
- `app/src/shared/pushover.ts` — delivery bounded by a timeout.

## 3. Review findings and resolutions

**P1 — unbounded Pushover fetch on the money path.**  `sendPushover` called
`fetch` with no abort signal.  The hazard is not a rejection but a request that
never SETTLES: this is awaited from the Stripe webhook handler and the Apple
redeem command, so a stalled connection delays the webhook response
indefinitely, and Stripe retries an event it considers timed out — turning a
notification hiccup into duplicate event processing.  Catching rejections does
nothing for a hung socket.  Now bounded by `PUSHOVER_TIMEOUT_MS` (5s) with a
distinct `timed out` reason.  Fixed in the shared helper, so every caller
benefits.

**P1 — no rollout record for the migration.**  This document.

**P2 — the claim was consumed before delivery succeeded.**  Claiming first is
what makes the notifier idempotent, but it meant any later failure — the totals
query throwing, Pushover unconfigured, an HTTP/API refusal, a timeout — left the
key permanently consumed.  Every retry then short-circuited at `!isNew`, so the
alert was lost forever rather than failing soft, the opposite of the module's
stated contract.  The claim is now RELEASED on any delivery failure, restoring
retryability.  Deleting is safe because we only reach the release on the attempt
that actually inserted the row.

**P2 — the migration window.**  CT auto-deploy ships CODE but never SCHEMA
(schema comes only from `POST /api/admin/migrate` via `ship.sh`), so on first
deploy the new HEAD serves traffic before `premium_activation_notices` exists and
the claim throws.  Same root cause as the release fix above, and now covered by
it: the claim is released, so once the table appears a retry succeeds instead of
deduping against a row that was never delivered.

**P2 — `customer.subscription.updated` excluded.**  Stripe opens a
card-confirmation subscription as `incomplete`, which is not a premium status, so
the `created` event correctly declines to notify — and the confirmation then
arrives as `updated`, which was categorically excluded.  Those customers became
Premium with no alert ever produced.  `updated` is now admitted; safe because the
idempotency guard is the ledger claim on the subscription id, not the event-type
filter.

**P2 — `plan` defaulted null to "monthly".**  When a subscription's price is not
configured, `applySubscription` persists `plan = null` and the entitlement
resolver does not grant Premium — but the alert still announced a "monthly
Premium" activation for a user the totals query excludes.  A recognised plan
(`monthly` or `annual`) is now required.

**P2 — the legacy Apple path was not wired.**  `POST /billing/apple/confirm` is
deprecated but still grants Premium for older iOS clients, so a real new
subscriber arrived silently.  Now raises the same alert with the same
`activationKey` shape, so a client that later replays through the modern path is
deduped rather than notified twice.

**P2 — Apple newness derived non-atomically.**  `isNew` came from a pre-read, so
two accounts redeeming the same previously-unseen `originalTransactionId` could
both see null and both claim newness.  The insert preserves the first writer, but
the loser would still report `isNew` — and whichever claimed the notification key
first would send an alert carrying its own email for the winner's subscription.
Newness is now re-checked against the row's persisted owner after the write.

## 4. Verification State

```
cd app
npm run typecheck   # deno check
npm test
npm run lint        # expect the repo's existing baseline, zero added
```

## 5. Next Steps & Blockers

**Run `POST /api/admin/migrate` after merge.**  Auto-deploy does not apply
schema.  The claim-release fix means an activation during the window is retried
rather than lost, but the table should exist before the path is exercised.

## 6. Zero-Code Findings

Apple's JWS payload carries no trial/introductory-offer flag this codebase
decodes, so Apple activations are always reported as "paid".  A known gap versus
Stripe, where `trialing` is exact — recorded rather than silently tolerated.
