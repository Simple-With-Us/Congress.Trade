# 2026-08-13 — iOS Premium: one screen, and purchases that actually confirm

## 1. Context & Objective

The owner bought Premium Monthly through TestFlight.  Apple confirmed the
purchase; the app spun for a long time and then showed a red **"Request
failed"**.  Tapping **Restore Purchases** appeared to do nothing, then landed on
**"Command is still running.  Wait a moment, then retry if needed."** — by which
point Premium *had* actually been granted.  Separately, the owner asked for the
two-step Premium flow (benefits sheet → "See Plans" → products sheet) to become
one screen, styled like the benefits sheet.

Both are fixed here.

## 2. Changes Made

### The purchase bug: interactive commands ran on the background tick

`POST /api/client/v1/commands` created the command row, pushed a
`command.execute` message onto the durable queue, and returned `202`.  Nothing
executes that queue except the scheduled tick — **every 60s on the live `paid`
profile** (`/api/health` → `costProfile.cronSchedule = "* * * * *"`), every 5
minutes on `free`, and only after whatever ingest work the tick claims first.
Meanwhile `APIClient.awaitCommandResult` polled `GET /commands/:id` for
40 attempts ≈ **18.5s** and then threw.

So `redeem_apple_purchase` could not possibly succeed in the window the phone
was willing to wait.  The customer was charged, and the app reported an error.

- `app/src/client/routes.ts` — `POST /commands` now enqueues the durable
  backstop **first**, then runs `executeQueuedCommand` inline within a
  `INLINE_COMMAND_BUDGET_MS` (9s) race.  It re-reads the row and answers `200`
  once terminal, `202` while still queued/running.  `executeQueuedCommand` is
  idempotent (no-ops unless the row is queued/running), so the later queue
  delivery of a command finished inline is a cheap read, not a re-execution.
- `app/src/client/commands.ts` — exported `INLINE_COMMAND_BUDGET_MS`, kept
  under the iOS client's 20s per-request timeout.

### The client had no safety net either

- `clients/ios/CongressTrade/Store/AppleIAP.swift` (**new**) — `Transaction.updates`
  listener, `redeemAppleTransaction`, `redeemCurrentAppleEntitlements`,
  `reconcileAppleEntitlementsQuietly`.  The app had **no `Transaction.updates`
  observer anywhere**, which StoreKit 2 requires: Ask to Buy approvals,
  renewals, interrupted purchases, and retries of a failed redeem were all
  invisible to it.  `finish()` stays *after* the server call, so a failed redeem
  is redelivered on the next launch instead of being thrown away.
- `clients/ios/CongressTrade/App.swift` — starts the listener for the app's
  lifetime and runs one quiet catch-up sweep at launch for anyone already
  stranded by the old path.
- `clients/ios/CongressTrade/APIClient.swift` — poll budget 40 attempts/~18.5s →
  60 attempts/~77s with a wider backoff, for the commands the server still hands
  back to the queue.
- Purchase/restore failures now say what is actually true — Apple took the
  money, we could not record it yet, Restore Purchases is the fix — instead of
  surfacing a raw `Request failed`/HTTP string (`PremiumPricing.redeemFailureMessage`).

### One Premium screen

- `clients/ios/CongressTrade/Views/Status/PremiumSheet.swift` (**new**, replaces
  `Views/Status/SubscribeView.swift`) — benefits list + price line + the real
  StoreKit products + Restore + Not Now, on one screen.  `PremiumInfoSheet` was
  deleted from `Components.swift` and all six call sites now present
  `PremiumSheet`.
- Trial copy realigned to **2 weeks** (`STRIPE_TRIAL_DAYS` default is 14 and the
  web has said 2 weeks since 2026-08-05): `DeliveryView.swift` ×2,
  `FeedDashboardView.swift`, and `app/src/ui/legalHtml.ts` ("30 days / 1 month"
  → "14 days / 2 weeks").  `PremiumPricing.headline` is now the single place the
  phone states price + trial.

### Touched files

```
app/src/client/routes.ts
app/src/client/commands.ts
app/src/client/__tests__/routes.test.ts
app/src/ui/legalHtml.ts
clients/ios/CongressTrade/Store/AppleIAP.swift              (new)
clients/ios/CongressTrade/Views/Status/PremiumSheet.swift   (new)
clients/ios/CongressTrade/Views/Status/SubscribeView.swift  (deleted)
clients/ios/CongressTrade/App.swift
clients/ios/CongressTrade/APIClient.swift
clients/ios/CongressTrade/Views/Components/Components.swift
clients/ios/CongressTrade/Views/Status/SettingsView.swift
clients/ios/CongressTrade/Views/Delivery/DeliveryView.swift
clients/ios/CongressTrade/Views/Feed/FeedDashboardView.swift
clients/ios/CongressTrade/Store/ManageSubscription.swift    (comment only)
clients/ios/CongressTrade.xcodeproj/project.pbxproj
```

## 3. Decisions & Trade-offs

- **Enqueue before running inline, not instead of.** If the request dies
  mid-flight the tick still finishes the command.  The cost is one wasted queue
  read per command; the alternative is a command that silently never runs.
- **9s inline budget.** Must stay under `APIClient`'s 20s per-request timeout —
  a budget that outlives the socket buys nothing and costs the caller a
  transport error instead of a status.  On overrun the row is left `running`,
  the response is `202`, the inline promise still completes and writes the
  terminal status, and the client's (now 77s) poll picks it up.
- **The response contract changed from always-202 to 200-when-terminal.**  Both
  known clients already branch on `command.status`, not on the HTTP code
  (`APIClient.postCommand` polls only on `queued`/`running`).  11 route tests
  asserted the old code and were updated; a new test
  (`finishes a command inline so the caller never waits for the background tick`)
  pins the new contract, including that draining the backstop afterwards is a
  no-op.
- **Trial length is quoted in three places that must agree**: this copy,
  `STRIPE_TRIAL_DAYS`, and the introductory offer on each App Store Connect
  product.  **Unverified here:** whether the ASC products are configured with a
  2-week intro offer.  If they are still on 1 month, ASC is the thing to change
  — the app must not quote a trial Apple will not honor.
- Deleting `SubscribeView.swift` required renaming its three `project.pbxproj`
  entries by hand (the project is not a synchronized file group), and
  `AppleIAP.swift` needed new `PBXFileReference`/`PBXBuildFile` entries.

## 4. Verification State

```bash
cd app && npm run typecheck                       # deno check src/deno/main.ts — clean
cd app && npx vitest run src/client/__tests__/    # 6 files, 73 tests passed
cd clients/ios && xcodebuild -project CongressTrade.xcodeproj -scheme CongressTrade \
  -destination 'generic/platform=iOS Simulator' -configuration Debug build \
  CODE_SIGNING_ALLOWED=NO                          # ** BUILD SUCCEEDED **
```

Note: the first iOS build failed with `stat cache file ... not found` /
`accessing build database: disk I/O error` — corrupt shared DerivedData, not the
code.  Removing `~/Library/Developer/Xcode/DerivedData/CongressTrade-*` (or
passing `-derivedDataPath`) fixes it.

## 5. Next Steps & Blockers

1. **Confirm the App Store Connect introductory offer is 2 weeks** on both
   `trade.congress.premium.monthly` and `trade.congress.premium.annual`.  Copy
   now says 2-week everywhere; ASC is the authority.
   **Verified 2026-08-14:** both products are `FREE_TRIAL` / `TWO_WEEKS`
   (start 2026-08-12, no end); US prices $5 / $50; Infisical prod
   `STRIPE_TRIAL_DAYS=14`.  Receipt:
   `docs/rollouts/2026-08-14-premium-trial-asc-verified.md`.
2. Re-test the TestFlight purchase end to end after this ships — expect the
   redeem to confirm in one round trip.  The owner's existing Premium grant
   already landed, so testing a *fresh* purchase needs a new sandbox tester.
3. Optional follow-up: `POST /commands` still holds a request open for up to 9s
   on a slow command.  If that shows up in latency metrics, the next step is a
   short-poll drain lane for `command.execute` rather than a longer budget.

## 6. Zero-Code Findings

- Production is on the `paid` cost profile (`cronSchedule: "* * * * *"`,
  `drainLimit: 100`) — the queue latency here is ~1 minute, not the 5 minutes
  the `free` profile would give.  Either way it exceeded the old client budget.
- The two Premium sheets had already drifted: `SubscribeView` said "2-week free
  trial" while `PremiumInfoSheet` said "1-month", on the same build.  That
  drift is the concrete argument for one screen and one `PremiumPricing`
  constant.
