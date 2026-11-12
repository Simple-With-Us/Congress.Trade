# Client Mobile API Coordination

Last updated: 2026-09-03

This is the working coordination note for the phone-first SwiftUI and the
SwiftUI iPhone app. Keep it aligned with `app/docs/mobile-app-roadmap.md` and
the implementation mounted at `/api/client/v1/*`.

## Source Of Truth

- The Coolify Deno backend at congress.trade owns data access, calculations,
  entitlement, billing state, scraping, extraction, enrichment, prices,
  delivery, backfills, provider secrets, admin tokens, and MCP/tool
  orchestration.
- SwiftUI are peer clients over the same backend-owned API.
- Do not add client-only scraping, calculation, provider-secret, admin, MCP, or
  migration paths.

## Shared Contract

- Use `/api/client/v1/*` for app-facing DTOs instead of binding mobile clients
  to internal web, admin, ingestion, or provider routes.
- Keep TypeScript DTOs and Swift `Codable` models equivalent.
- Preserve one auth/session model across clients: secure HTTP-only cookies for
  Keychain refresh sessions for iOS, and backend token validation.
- Account alerts and developer delivery settings should be account-owned
  resources, not bearer-secret-only objects in mobile UI.

## Archived Filing PDF (Premium, in-app)

Jay 2026-08-20: the stored R2 copy is a Premium digital good.

- `GET /api/documents/:docId/pdf` (also mounted at `/api/client/v1/documents/:docId/pdf`)
  serves the archived bytes.  iOS must fetch it with the session Bearer and
  `Accept: application/pdf`, then present QuickLook/PDFKit or a temp file.
  Never open Safari to `congress.trade/pricing` or Stripe.
- Free or anonymous iOS: the Filing PDF control opens `PremiumSheet` (StoreKit).
- Backend: Bearer and/or `Accept: application/pdf` on a non-premium request
  returns **402 JSON** `{ upgradeRequired: true, feature: "pdf" }`, not a 302
  to `/pricing`.  Browser HTML navigations without Bearer still 302 to the
  web paywall.
- The public government **Source Filing** URL on the trade row stays ungated.

## Command And Status Model

Client mutations go through a backend command when the route supports it:

- `POST /api/client/v1/commands` with `{ type, payload, idempotencyKey }`.
- `GET /api/client/v1/commands/:id` for status, validation errors, audit trail,
  and resulting resource IDs. Note: for `create_subscription` commands, delivery credentials (`secret`, `streamUrl`) are disclosed on the **FIRST** successful poll only. Clients MUST persist the secret upon receipt; it is claimed and unrecoverable from subsequent API reads.
- `GET /api/client/v1/commands/stream` is not implemented yet; clients should
  poll `GET /api/client/v1/commands/:id`.

Use the shared statuses:

- `queued`
- `running`
- `succeeded`
- `failed`
- `canceled`

Command writes must validate account ownership and entitlement before queueing,
be idempotent by authenticated `userId + idempotencyKey`, and leave an audit
trail.
The current router implements `update_preferences`, `create_subscription`,
`update_subscription`, `delete_subscription`, `register_device`,
`unregister_device`, `redeem_apple_purchase`, and `delete_account`; `start_checkout` and
`request_export` are defined in the shared type set but still return `501`.

### Delivery `members` filter (`create_subscription` / `update_subscription`)

`filters.members` is matched against the trade's filer id, so the server stores
**filer ids** and resolves what it is given (2026-09-18, board a6058af2):

- An entry is a filer id (`filerId` from `GET /api/members`; case-insensitive, a
  merged alias maps to its canonical filer) **or a member name**.  A name must
  identify exactly one member: an exact full/display-name match wins, then a
  filer with live trades over a dormant duplicate.
- An id must exist: on the `filers` roster or on at least one transaction.  A typo
  is rejected like an unknown name rather than saved as a subscription that never
  fires.
- A name that matches nobody, or several people (`"Smith"`), fails the command
  (`failed`, `error` lists every offending entry; REST `POST/PATCH
  /api/subscriptions` answers `400` with the same `error` plus
  `unresolvedMembers: string[]`).  Nothing is saved.  Prefer sending ids — the
  iOS Delivery screen picks members from the People directory and sends `filerId`.
- `GET /api/client/v1/subscriptions` adds `memberLabels` (`{ filerId: name }`) to
  each subscription that filters by member, so clients can show names, and
  `unresolvedMembers` when the stored filter holds an entry that is not a known
  filer id.  Subscriptions created before names were resolved may hold raw text
  such as `"Nancy Pelosi"`: those never delivered anything, are not rewritten by
  the server, and are fixed by Edit → Save (which resolves or rejects them).

### Account deletion — `delete_account`

Guideline 5.1.1(v).  Signed-in only.  Permanently deletes the account:

- delivery subscriptions for `user:<id>` (and their SSE leases)
- `push_devices`, `user_preferences`, `apple_subscriptions`, other `client_commands`
- indexed sessions (`sess:*` / `sess_user:<id>`)
- the `users` row (PII)
- best-effort Stripe subscription cancel (no refund)

Web also exposes `POST /auth/account/delete` (cookie or bearer).  After a
successful delete the client must clear its local token; a follow-up logout is
unnecessary because the session is already gone.  Apple In-App Purchase
subscriptions must still be cancelled in the App Store.

### Device registration (APNs / web push)

Push tokens are **not** delivery subscriptions. They live in `push_devices` and
do not consume the SSE/webhook subscription quota.

- `POST /api/client/v1/commands` `{ type: "register_device", payload: { platform: "apns"|"webpush", token, appBundle?, env? } }`
  - Signed-in required. Not Premium-gated (store early; fan-out still Premium).
  - APNs `token` must be 64–200 hex characters.
  - Upserts on `(userId, platform, token)`; reactivates a previously deactivated row.
  - Caps at 10 active devices per user (oldest deactivated on overflow).
- `POST ...` `{ type: "unregister_device", payload: { id? } | { token, platform? } }`
- **Legacy:** older iOS builds sent `create_subscription` with `delivery: "apns"`
  and `targetUrl` = device token. The backend rewrites that to `register_device`
  so those clients stop failing with `delivery must be 'sse' or 'webhook'`.
- Product APNs fan-out (`delivery/apnsFanout.ts`) sends **one digest per new
  filing**, not one alert per trade. Copy is `{Name}, {Position}` /
  `Filed N trades (B buys, S sells, E exchanges).`
- `update_preferences.notificationSettings` shape (missing keys default to
  filing digests, never a per-trade firehose):

```json
{
  "pushMode": "off" | "filings" | "watchlist",
  "watchlistRules": {
    "NVDA": { "minAmount": 50001, "sides": "all" | "buys" | "sells" }
  }
}
```

  `minAmount` is a STOCK Act bracket floor (`1001`, `15001`, `50001`, …).
  Watchlist mode also requires `watchlist: ["NVDA", …]` on the same
  preferences row. Review-queue rows are not sent to product devices.

### Sign in with Apple (2026-08-09)

`POST /auth/apple` — native `ASAuthorizationAppleIDProvider` flow. The client
verifies nothing itself; it forwards the identity token JWS as-is and the
backend does full RS256-against-Apple's-published-JWKS verification
(`src/auth/appleIdentity.ts`, JWKS cached ~1h) before trusting any claim.
Env-gated by `APPLE_SIGNIN_ENABLED` (`503` while unset) + `APPLE_BUNDLE_ID`
(default `trade.congress.ios`).

Request:

```json
{
  "identityToken": "<ASAuthorizationAppleIDCredential.identityToken, UTF-8 decoded>",
  "nonce": "<optional, only if the client set one on the request>",
  "fullName": "<optional, ONLY present on the very first authorization — Apple never encodes it in the JWT at all>"
}
```

Response `200`:

```json
{
  "ok": true,
  "token": "<opaque session token — same shape/lifetime as the Google flow's>",
  "user": { "id": "...", "email": "...", "name": "...", "picture": null },
  "entitlement": { "premium": false, "status": null, "plan": null, "...": "see Entitlement semantics below" }
}
```

`401` on a failed/expired/malformed identity token, `503` when Apple sign-in
isn't enabled yet, `429` per-IP rate limit. A session cookie is also set (web
parity); iOS should use the `token` as a `Bearer` credential going forward,
matching the existing Google/magic-link session model — same cookie-or-bearer
resolution, same 30-day TTL, same `POST /auth/logout`.

Account linking: keyed by the stable Apple `sub` claim, constant across every
future sign-in for this app even once Apple stops returning `email`/name on
later calls. A verified email that matches an existing account (e.g. a prior
Google/magic-link signup) links to it instead of creating a duplicate; an
**unverified** email is never used to link OR to name a new account (mirrors
the Google callback's account-takeover guard) — falls back to a synthetic
placeholder address in that edge case.

### Apple In-App Purchase (StoreKit 2) — `redeem_apple_purchase` (2026-08-09)

- `POST /api/client/v1/commands` `{ type: "redeem_apple_purchase", payload: { signedTransaction: "<Transaction.jwsRepresentation>" } }`
  - Signed-in required (NOT Premium-gated — this is how you become Premium).
  - Env-gated by `APPLE_IAP_ENABLED` (command fails with `"Apple in-app
    purchases are not enabled yet"` while unset) + `APPLE_PRODUCT_MONTHLY` /
    `APPLE_PRODUCT_ANNUAL` (App Store Connect product ids; default to
    `trade.congress.premium.monthly` / `.annual` when unset).
  - Server verifies the JWS chain (leaf → intermediate → Apple Root CA - G3,
    the last pinned in `src/billing/appleRootCert.ts` — no network call) via
    `src/billing/appleJws.ts`, checks `bundleId`, maps `productId` to a plan,
    and requires the transaction to be currently active (not expired/revoked).
  - **Idempotent on `originalTransactionId`** (StoreKit's stable id across
    renewals of the same subscription) — restore-purchases works by calling
    this command again with a freshly-fetched `signedTransaction`; a repeat
    redeem for the SAME user is a no-op success, a renewal transaction
    updates the existing ledger row's expiry, and a redeem attempt for an
    `originalTransactionId` already owned by a DIFFERENT account returns a
    command `failed` status with `"this Apple subscription is already linked
    to a different account"` (`409`-equivalent) rather than reassigning it.
  - Result on success: `{ entitlement, plan, expiresAt, originalTransactionId }`.

### Anonymous Apple purchase (Guideline 5.1.1(v)) — no account required to buy (2026-08-20)

Apple rejected submission b61e2a4a: requiring account registration before an
In-App Purchase that is not itself account-based violates 5.1.1(v). PDF
download and CSV export are content, not account-specific functionality, so
they must be purchasable and usable signed OUT. Delivery (webhook/SSE) alerts
and push registration remain sign-in-gated — that is account-specific
functionality Apple's own guideline explicitly allows to require sign-in.

- `POST /api/client/v1/entitlements/apple/redeem` `{ signedTransaction }` — no
  session, no cookie, no bearer. Outside the `requireUser`-gated `/commands`
  pipeline entirely. Runs the exact same verification as
  `redeem_apple_purchase` (`billing/appleRedeem.ts`: JWS chain, bundle id,
  Sandbox policy, product mapping, active-window check), then upserts the
  `apple_subscriptions` ledger row with `user_id = NULL` instead of a session
  user. Rate-limited per IP and per `originalTransactionId`.
  - A transaction already linked to a real account returns `409` (same
    "already linked to a different account" as the authenticated path) — an
    anonymous caller can never take over an owned row.
  - Result on success: `{ entitlement: { premium: true, plan, ..., source:
    "apple_anonymous" }, plan, expiresAt, originalTransactionId,
    deviceEntitlementToken }`. `deviceEntitlementToken` is a short-lived
    (`min(subscription expiry, 24h)`), HMAC-signed, opaque token
    (`billing/deviceEntitlement.ts`) — no personal data, just the
    `originalTransactionId` + an expiry.
- The device presents that token as `X-Apple-Device-Entitlement` on two
  requests that no longer require a session: `GET
  /api/documents/:docId/pdf` and `GET /api/export/transactions.csv`. Both
  routes re-check the LIVE `apple_subscriptions` row (not just the token's own
  signature) on every request, so a refund/revoke that lands after the token
  was issued takes effect immediately rather than waiting for the token to
  expire. **A present session always wins** — the device token is only
  consulted when the request has no signed-in user at all, never OR'd with a
  session that simply isn't Premium.
- `link_apple_entitlement` — a `POST /api/client/v1/commands` command,
  authenticated, payload `{ signedTransaction }`. Identical verification and
  ledger write to `redeem_apple_purchase` (in fact the same server code path)
  — the only difference is client-side, and it changed 2026-08-21 (owner
  directive: "linked to an account, usable via website or app both" —
  Premium belongs to the ACCOUNT, and linking a purchase to one is always an
  EXPLICIT user action). iOS now calls this command from exactly two places,
  both an explicit tap: the Premium sheet's "Link to This Account" button
  (row 4 of the truth table below — an unclaimed device purchase) and
  Restore Purchases. Nothing runs it silently any more — sign-in, the
  `Transaction.updates` listener, and the launch-time quiet reconcile only
  PROBE ownership read-only (reusing the anonymous redeem route below, which
  never assigns an account) so the UI can ask before linking. `409` ("already
  linked to a different account") is always surfaced to the person, never
  swallowed.
  - iOS-side entitlement truth table (`Store/AppleIAP.swift`
    `PremiumAccessGate`): (1) signed out + a verified, unclaimed device
    purchase → Premium (Guideline 5.1.1(v)); (2) signed in + server Premium →
    Premium; (3) signed in + server free + device purchase owned by a
    DIFFERENT account → NOT Premium, conflict shown plainly, way out is
    Restore Purchases or switching accounts; (4) signed in + server free +
    device purchase unclaimed → Premium (never strand a payer), with an
    explicit "Link to this account?" ask (remembered "Not now" per account,
    Link stays available from the Premium sheet and Restore Purchases).
- App Store Server Notifications V2 land at `POST /api/webhooks/apple`
  (`{ signedPayload }`, same env gate, same JWS-chain verification — including
  the notification's OWN nested `signedTransactionInfo` /
  `signedRenewalInfo` JWS, each independently verified). Handles the minimal
  set: `DID_RENEW` (renew → active, new expiry), `EXPIRED` (→ expired),
  `REVOKE` (→ revoked, refund/family-sharing-removal), and
  `DID_CHANGE_RENEWAL_STATUS` (auto-renew toggle; does not itself change
  access). Idempotent on Apple's `notificationUUID` (claim/release/processed
  ledger, same pattern as the Stripe webhook). A notification for an
  `originalTransactionId` with no existing ledger row (i.e. the redeem
  command hasn't run for it yet) is acknowledged but ignored — a webhook
  alone never has enough information to attribute a subscription to a user.

#### Entitlement semantics (Stripe OR Apple)

`entitlement.premium` is `true` when EITHER the existing Stripe-derived state
is active/trialing OR the signed-in user has a currently-active row in the
`apple_subscriptions` ledger. Every entitlement-bearing response (`GET
/auth/me`, `GET /billing/status`, `GET /api/client/v1/bootstrap`, `GET
/api/client/v1/me`) now resolves this OR asynchronously
(`billing/entitlement.ts` `resolveEntitlementAsync`); so do every
Premium-gated write path (CSV export, alert/webhook subscription
create/activate, PDF download). The pure, synchronous `entitlementOf` (used
internally by the ALSO-still-live legacy `POST /billing/apple/confirm` route)
is unchanged — Stripe's own resolution code was not touched or restructured.

The response adds one **optional, additive** field for clients that want to
show the right "Manage subscription" surface (App Store vs. Stripe billing
portal): `entitlement.source: "stripe" | "apple" | "apple_anonymous" | null`.
Absent/`undefined` is a valid value (older code paths that haven't been
touched still omit it) and must not be treated as "not premium" — always gate
on `entitlement.premium`. `"apple_anonymous"` only ever appears in the
anonymous redeem route's own response body (above) — it is device-scoped, not
`User`-keyed, so no `resolveEntitlementAsync` response (bootstrap/me/etc.)
ever returns it.

iOS Manage Subscription: `source == "apple"` opens the App Store
subscriptions page.  `stripe` or `null` (website Premium) POSTs
`/billing/portal` with the session Bearer.  That route must accept Bearer
(`getCurrentUserFromRequest`); cookie-only auth 401s a signed-in iOS user.
On portal failure other than offline, iOS opens
`https://congress.trade/?billing=manage` (website `manageBilling()` after
`/auth/me`) instead of telling the user to sign out.  Native iOS never
starts `/billing/checkout`.

- Implemented now: bootstrap, `me`, feed, trade detail, ticker detail,
  politician detail (`member` endpoint), `preferences` GET/PUT, subscription listing, and command-backed
  preference/subscription create/update.
- `bootstrap` currently returns `serverTime`, `auth`, `capabilities`, and an
  `endpoints` map for the current client surface.
- `feed` currently accepts query params like `since`, `ticker`, `member`,
  `memberName`, `chamber`, `party`, `type`, `minAmount`, `maxAmount`, `from`,
  `to`, `sort`, `order`, `offset`, and `limit`, and returns the
  cursor/count/total metadata used by polling clients.

  **Default order (fixed 2026-08-11 — was oldest-first).** `order` defaults to
  `desc` (newest-first) whenever the request has **no forward cursor**
  (`since` absent). The underlying query builder (`buildTransactionsQuery`,
  `app/src/delivery/rows.ts`) still defaults to `cursor_seq ASC` so an
  incremental `since=`-cursor poll keeps resuming gap-free — that ASC default
  is preserved whenever `since` is present, **including the explicit
  `since=0`** (a legitimate "start of history, but I am a resumable-cursor
  client" value, distinct from omitting `since` entirely). The bug: a plain
  `GET /feed` with no params used to return the oldest ~11,820 rows first —
  bulk-imported `seed_dataset` rows with no owning `filings` row at all, so
  `filing.filedDate` / `filing.firstSeenAt` / `filing.sourceUrl` all came back
  `null` on every one of them. iOS is unaffected either way: it always sends
  its own explicit `order` and never sends `since`
  (`clients/ios/CongressTrade/Store/CongressTradeStore.swift`). An explicit
  `order=` query param always wins over this default. Pinned by
  `app/src/client/__tests__/routes.test.ts` ("client API feed: default order
  (oldest-first-seed-rows bug)").

  **`$` amount bounds (`minAmount` / `maxAmount`).** Both are parsed by
  `filtersFromQuery` (`app/src/client/utils.ts`, via `asNonNegativeNumber`) and
  land on `TxQueryParams`; `buildTxFilters` (`app/src/delivery/rows.ts`) turns
  them into `t.amount_min >= ?` and `t.amount_min <= ?`. Note that **both
  bounds compare against `transactions.amount_min` — the disclosed STOCK Act
  bracket FLOOR, not a trade value.** No true trade value is ever disclosed, so
  `maxAmount=50000` means "brackets that *start* at or below \$50,000", not
  "trades worth at most \$50,000": a `$15,001–$50,000` row matches, and so
  would a `$50,001–$100,000` row under `maxAmount=50001`. Pass ladder-aligned
  floors (`1001`, `15001`, `50001`, `100001`, `250001`, `500001`, `1000001`,
  `5000001`, `25000001`, `50000001`) rather than arbitrary dollar amounts.
  Absent/empty/negative/non-numeric values are ignored rather than rejected,
  and an inverted band (`minAmount > maxAmount`) is simply unsatisfiable
  (empty page, `total: 0`).

  Both bounds are applied by `buildTransactionsCountQuery` as well as the page
  query, so **`total` is recomputed under the filter** — the pager's "Page X of
  Y" stays truthful. This is exactly why the bounds must stay server-side: a
  client-side amount filter would hide rows while leaving `total` reporting the
  unfiltered corpus. Pinned by
  `app/src/client/__tests__/feedAmountFilter.test.ts`.

  Surface differences worth knowing: `/api/client/v1/feed` accepts **both**
  bounds, while `/api/transactions` (the website's own feed, and the
  `GET /api/export/transactions.csv` Premium export that shares its parser in
  `app/src/delivery/rest.ts`) parses **`minAmount` only** — there is no
  `maxAmount` on that path.

  **UI status: there is no `$`/size filter on ANY platform, by owner
  decision.** The web Trades tab's `$ Minimum` pill was removed in owner
  follow-up batch #21 (see `app/src/ui/dashboardHtml.ts` — "the $ Minimum
  pill/select was removed entirely — no $/size dropdown on any platform"), and
  the iOS `$`-threshold pill was removed the same way on 2026-08-09. The only
  surviving `minAmount` control anywhere is the **Delivery/webhook subscription
  form**'s `newMinAmt` "Minimum Trade Size" select, which filters an alert
  stream, not a browse list. The query params above are a supported contract
  for direct API consumers and CSV export; **do not add a `$` filter UI to iOS
  as "web parity" — the web does not have one, and re-adding it would reverse
  an explicit owner decision.**

  **`party` IS a server param** (corrected 2026-08-11; the note below saying it
  is not was stale). `filtersFromQuery` parses `party` through `asPartyBuckets`
  and it is CSV multi-select capable (`?party=D,R`), on both this endpoint and
  `/api/transactions`; it narrows `total` like every other server filter.
  Verified in production: unfiltered `total` 89,422 vs `party=D` 48,443 and
  `party=R` 39,126.  **`party=O` is "Other / No party"** (2026-09-18, board
  efd94c45): Independents, minor parties AND filers with no party on file
  (executive-branch, manual and seed filers, or a transaction with no `filers`
  row).  The bucket is total, so `party=D,R,O` equals no party filter and the
  three buckets always sum to `total`.  Row-level `partyBucket` fields stay
  `null` when no party is on file; those rows are returned by `party=O`.
  - iOS's Chamber/Party/Trade Type filter pills are multi-select (owner
    directive, 2026-08-09), matching the web's own multi-select chip
    semantics: `chamber` is genuinely CSV-capable server-side (`asChambers`),
    so iOS forwards the full multi-selection as `chamber=house,senate`
    exactly like the web. `type` accepts CSV via `asTxTypes` (`?type=B,S`).
    `party` is CSV via `asPartyBuckets` (`?party=D,R`). Trends analytics
    `party=` now accepts the same CSV list (`asPartyBuckets` in
    `app/src/analytics/sql.ts`).
  - `sort` accepts `published`, `cursor` (default), or `tx_date` (fixed
    2026-08-09 — `tx_date` was already a valid `TxQueryParams`/SQL sort key
    for `/api/transactions` but this endpoint's query parser silently dropped
    it, so `?sort=tx_date` fell back to cursor order). iOS's Trades sort
    control (owner punch list #2, item 7) sends `sort=tx_date&order=asc|desc`
    for its Date option; its Amount option re-sorts the already-loaded page
    client-side only (the backend has no `amount` sort key — same pattern as
    the web dashboard's `setSort()`, which treats non-backend columns as a
    local re-sort, never a fetch beyond the loaded page).
  - `offset` (added 2026-08-09, iOS punch list #2 item 8) pages a DESC
    snapshot (pair with `order=desc`); guarded by the same
    `MAX_PUBLIC_TX_OFFSET` (2000) public depth cap as `/api/transactions` —
    a 400 past the cap points callers at Premium CSV export instead. iOS's
    "Page X of Y" pager computes total pages from the response's `total` and
    its own page-size (`limit`), independent of the forward `since`-cursor
    poll watermark, which is unaffected.
  - `assetClass` (added 2026-08-11, owner ask: an extra Trades dropdown
    offering **"All"** or **"Public Equities, Funds, & ETFs"**) filters by
    canonical instrument class (`AssetTypeCategory`, `shared/assetTypes.ts`),
    applied **server-side** in the shared `buildTxFilters` — the page query,
    the COUNT companion behind `total`, the today-filings aggregate, and the
    CSV export set all narrow together. This is deliberate: a client-side
    filter over one already-fetched page would report a count capped at the
    page size, re-creating the "shows 100 because that's the page size" class
    of bug. Accepted values:
    - `all` (or the param simply absent) — no filter, the dropdown's default.
    - `equities_funds` — the "Public Equities, Funds, & ETFs" option; a named
      group that expands to `public_equity` (House code `ST`, incl. ADRs)
      plus `fund` (`EF`/`MF`/`ET`/`MA` — ETF, mutual fund, exchange-traded
      note, managed account). Defined in `ASSET_CLASS_GROUPS`
      (`src/delivery/rows.ts`) so a future dropdown option needs no server
      change to add another named group.
    - Any raw `AssetTypeCategory` slug (`crypto`, `option`,
      `fixed_income_government`, `fixed_income_corporate`, `real_estate`,
      `trust`, `private_equity`, `retirement_or_529`, …) or a CSV mixing a
      group with raw slugs, e.g. `assetClass=equities_funds,crypto`.
      Unrecognized tokens are dropped rather than erroring (same lenient
      fallback as `chamber`/`type`/`party`); unrecognized input across the
      board falls back to no filter.
    - `assetCategory` (singular) is accepted as an alias for the same param.
    - Same parser and param on `GET /api/client/v1/feed`, the public
      `GET /api/transactions`, the Premium `GET /api/export/transactions.csv`,
      and `/api/feed.xml`, so every surface narrows identically.
    - Every feed item's `asset.typeCategory` (machine slug) and
      `asset.typeCategoryLabel` (display string) — see below — are computed
      with the exact same canonicalizer the filter matches against, so a
      client can render the same grouping it filtered on.
- Chamber filter: `chamber` accepts a CSV multi-selection over
  `house`, `senate`, and `executive` (Presidential trades from OGE Form 278-T
  filings; `member.chamber` can now be `executive`). ABSENT `chamber` means the
  default congressional view — executive rows are EXCLUDED unless explicitly
  requested, so a single multi-thousand-row presidential filing never swamps
  default feeds, analytics, or alert deliveries. Clients that want executive
  trades must opt in (e.g. `chamber=house,senate,executive`).
- Anti-scrape guard (`SCRAPE_GUARD_ENABLED`, `src/security/botDefense.ts`):
  `feed` AND the detail reads below (`trade/:id`, `ticker/:ticker`,
  `member/:memberIdOrName`) share one per-IP daily served-row budget with
  `/api/transactions` and can return `429` with `Retry-After` when a caller
  bulk-walks the corpus. Normal client polling (`since`-cursor, mostly zero new
  rows) does not meaningfully consume the budget; clients should honor
  `Retry-After` and back off. Public data endpoints also reject known
  scraper/AI-crawler user agents with `403` — real browser, `EventSource`, and
  iOS `CFNetwork`/`URLSession` agents are unaffected.
- Zero-delta poll responses omit aggregates: when `feed` is called with a
  `since` cursor and it yields zero new rows (the client's steady state), the
  response omits `total` (and, on `/api/transactions`, `filingsImportedToday`)
  instead of recomputing them — full-corpus `COUNT(*)` scans on every idle
  poll are not worth the D1 read cost when nothing changed. This mirrors what
  both known clients already do (they gate every read of `total`/`cursor`
  behind "did I get any new rows back?" and no-op otherwise): treat an
  absent/non-numeric `total` on a `since`-poll response as "unchanged from
  your last known value," never as `0`.
- Public detail reads use the same `ClientTrade` item DTO and feed-style
  envelope metadata:
  - `GET /api/client/v1/trade/:id`
  - `GET /api/client/v1/ticker/:ticker`
  - `GET /api/client/v1/member/:memberIdOrName`

### Company drawer parity — `GET /api/client/v1/ticker/:ticker?include=analytics`

The website's company drawer shows four things the plain ticker read did not:
**Buy Pressure**, the **buys/sells over time** chart, **Top Buyers/Sellers**,
and the **"Performance After Buys"** backtest. The web builds those from two
internal routes (`GET /api/analytics/ticker/:t` plus `.../backtest`).

**Decision (2026-08-11): enrich this contract; do NOT point clients at
`/api/analytics/ticker/:t`.** Reasons, in order of weight:

1. **Contract ownership.** The repo rule is that the backend owns one
   `/api/client/v1/*` contract for clients. `/api/analytics/*` is the
   website's internal shape: it stamps a web-shaped `meta()` envelope and its
   ticker route returns `recentTrades[].rawText` — raw filing text the phone
   never renders. Binding an App-Store-frozen binary to a surface the
   analytics layer reshapes freely is how a shipped app breaks.
2. **Round trips on cellular.** The drawer would cost two extra requests, and
   iOS would decode a *second* copy of the recent-trade list it already has in
   `items`.
3. **Cost control.** The backtest leg reads this ticker's full `price_eod`
   history *and* the entire `spx_eod` table. That is fine for a drawer the
   user deliberately opened; it is not fine as unconditional work on the same
   endpoint iOS uses for a plain trade list.

So the block is **opt-in** via `?include=analytics` and is computed from the
*same* analytics builders the website uses (`buildTickerSummaryQuery`,
`buildTickerTimeSeriesQuery`, `buildTickerTopTradersQuery`,
`buildTickerBacktestCohortQuery` + `aggregateTickerBacktest`), so the phone and
the web drawer cannot drift. Implementation: `app/src/client/tickerAnalytics.ts`.

- `include` is a **CSV token list**; unknown tokens are ignored, not an error
  (`?include=asset,analytics` works).
- **Without the token the `analytics` key is absent entirely** — existing
  decoders see byte-for-byte the response they see today.
- Optional `window` and `granularity` narrow the block. `window` uses the
  analytics vocabulary — `all` (default here), `<N>d` (e.g. `90d`, `365d`),
  `this_cy`, `last_cy`. **There is no `1y` token**; an unrecognized value
  silently falls back to `all` rather than erroring, so do not invent one.
  `granularity` (`day`/`week`/`month`) defaults from the window.
- Chamber/party/source are deliberately **not** accepted: the web drawer does
  not scope by them either, and each extra dimension multiplies the cache
  keyspace for a screen opened one ticker at a time.
- The whole block is cached in `CONFIG_KV` for 600s under one key — the same
  TTL as the analytics route it mirrors — so a re-open pays for the trade list
  only.

Shape (all dollar figures are whole-dollar bracket-midpoint **estimates**;
`estimatedAmounts: true`):

- `analytics.summary` — `totalTrades`, `buyCount`, `sellCount`, `memberCount`,
  `estVolumeUsd`, `estNetFlowUsd`, `firstTrade`, `lastTrade`, and
  **`netSentiment`** = buy pressure as a `0..1` fraction (`buys / (buys +
  sells)`), computed server-side so no client re-derives it, and `null` when
  the window holds no directional trade. **This summary is windowed and is
  therefore distinct from the envelope's top-level `summary`, which stays
  all-time** so existing decoders keep their current meaning.
- `analytics.series[]` — `{ period, buys, sells, estBuyVolUsd, estSellVolUsd }`
  for the buys/sells chart.
- `analytics.topBuyers[]` / `analytics.topSellers[]` — `{ filerId, fullName,
  partyBucket (D/R/O), photoUrl, tradeCount, estVolumeUsd }`, names already run
  through `cleanFilerName`.
- `analytics.backtest` — `{ totalBuyEvents, pricedDays, minN, horizons[] }`,
  horizons at 21/63/126/252 trading days, each `{ days, tradeCount, n,
  medianReturn, avgReturn, winRate, medianExcess, avgExcess }`. **Honesty
  rules a client must respect:** `n` is how many buy events actually scored at
  that horizon (a horizon without enough forward price history reports `n: 0`),
  and every derived statistic is `null` below `minN` (5) rather than published
  on a thin sample. `totalBuyEvents` stays the full cohort at every horizon, so
  render "6 buys, 0 scored at 252d" — never "0 buys".

**Failure semantics.** The trade list is this endpoint's primary job, so an
analytics failure degrades that one section: the response is still `200` with
`analytics: null` and a full `items` array. **Clients must treat
`analytics: null` as "unavailable right now", never as "no activity"** — the
key being present-and-null is distinct from the key being absent (not
requested). Pinned by `app/src/client/__tests__/tickerAnalytics.test.ts`.

### Trends sections served directly from `/api/analytics/*`

Three Trends sections have no `/api/client/v1/*` equivalent and are read
straight from the analytics router (public, unauthenticated, `meta()`
envelope with `window`/`chamber`/`party`/`source`/`estimatedAmounts`/`asOf`).
iOS already reaches this router via `APIClient.analytics(path:)`. All three
were verified live on 2026-08-11 and pinned by
`app/src/analytics/__tests__/trendsRoutes.test.ts`:

- **`GET /api/analytics/party-split`** (+ `window`, `granularity`) — Party
  Split. Returns `overall` as a map that **always contains all three buckets
  `D`/`R`/`O`, zero-filled** (so "no independents traded" is distinguishable
  from a missing key), each `{ buys, sells, estVolumeUsd, estNetFlowUsd,
  members }`; plus `byPeriod[]`, one record per period with **flat** keys
  `{ period, D_buys, D_sells, R_buys, R_sells, O_buys, O_sells }` (the server
  pivots the per-(period,party) rows for you).
- **`GET /api/analytics/sector-breakdown`** (+ `window`, `limit`) — Sector
  Breakdown. `{ count, sectors[] }` where each entry is `{ assetType,
  assetTypeCategory, rawAssetTypes[], tradeCount, buyCount, sellCount,
  estVolumeUsd, estNetFlowUsd, uniqueMembers, uniqueTickers }`. **Key logic off
  the stable slug `assetTypeCategory` and display the label `assetType`.**
  This groups by disclosed **instrument type** (`transactions.asset_type`) and
  is a *different card* from `GET /api/analytics/sector-flow`, which groups by
  real **GICS sector** (`securities_ref.sector`) and which iOS already renders.
- **`GET /api/analytics/conflicts`** (+ `window`, `limit`, max 500, default
  100) — Committee Sector Conflicts. `{ count, conflicts[] }`, each `{ id,
  ticker, sector, txType, txDate, filerId, memberName, chamber, partyBucket,
  viaCommittees[], estAmountUsd }`. The route applies the curated
  committee→sector map (`app/src/analytics/conflicts.ts`) in the handler, so
  only genuine conflicts are published, and `limit` bounds the *published*
  count.
  - **Gap:** this envelope has **no `photoUrl`**, unlike every other
    member-bearing list the phone renders (feed rows, `/api/members`, and the
    company drawer's top buyers/sellers all carry one). Adding it needs
    `fl.photo_url` in `buildConflictCandidatesQuery`
    (`app/src/analytics/builders.ts`) plus a passthrough in the route. Until
    then a conflicts list must render monograms, not avatars.
- `GET /api/members` (public roster, origin-level — not `/api/client/v1/*`,
  same pattern as `/api/transactions`, `auth/*`, and the logo proxy that
  `APIClient.swift` already calls at `originURL`) returns
  `{ members: [{ filerId, fullName, chamber, party, state, district, txCount,
  photoUrl, title }], count }`. `photoUrl` (added 2026-08-09, iOS punch list
  #2 item 9) is a same-columns addition to the existing cached roster query
  (no new join, no perf regression) — `null` when the filer has no
  `filers.photo_url`. iOS's People directory tab renders it as a row avatar;
  the web directory table intentionally stays photo-less. `title` (added
  2026-08-10) is a curated agency/position label for executive-branch filers
  (`filerId` starting `EXEC-`) — e.g. `"Treasury Secretary"` — sourced from
  `shared/executiveTitles.ts`; `null` for House/Senate filers, and
  `"Executive Branch"` for an `EXEC-*` filer with no curated entry, and for any
  other filer filed under `chamber: "executive"` (a competitor-minted `MANUAL-*`
  official; no title is guessed). The same
  `title` field is on the `member.profile` object from `GET
  /api/client/v1/member/:memberIdOrName` and on `GET /api/analytics/member/
  :filerId`'s `profile`.
- `performance.pricesAsOf` (added 2026-09-18) on `GET /api/client/v1/member/
  :memberIdOrName`, and `pricesAsOf` on `GET /api/analytics/member-performance`,
  `GET /api/analytics/member/:filerId/performance` and `GET
  /api/analytics/performance/:txId`, is the newest price date (`YYYY-MM-DD`)
  behind any scored trade.  Every return on the same response ends on that date:
  the S&P 500 leg is the close on or before each ticker's own
  `current_price_date`, not one global latest close.  Clients should print
  "Prices as of <date>" beside performance figures; `null` when nothing was
  scored.  `GET /api/analytics/summary` `resolvedEquityTickerPct` now uses an
  equity-like denominator (`public_equity` plus still-`unknown` types); the old
  public-equity-only figure is `resolvedPublicEquityTickerPct`.
- Each feed item's `asset` object carries `name` (the disclosed asset text),
  `ticker`, raw disclosure `type`, `typeName`, canonical cross-chamber
  `typeCategory` / `typeCategoryLabel`, `sector`, and `marketCapBucket`, plus
  two enrichment fields shared with the web client so every surface renders
  identically:
  - `companyName` — the canonical company name from `securities_ref`
    (`null` until the ticker is enriched).
  - `logoUrl` — a same-origin path to the cached logo proxy, e.g.
    `/api/logos/ticker?symbol=AAPL` (`null` when no ticker resolves). Clients
    render `<img>` against this URL directly; the proxy handles the logo
    provider key and edge caching server-side and returns 204 No Content on a
    true miss (cacheable, no console error) so the client can fall back to a
    monogram.
- Each feed item's `transaction.type` (`B`/`S`/`E`) can be `null` for a filing
  row whose disclosed side didn't parse (malformed/partial source text). This
  is an honest passthrough, not a silent default to Buy: a transaction with no
  confirmed side must not be misreported as a buy. Product labels are
  **Buy / Sell / Exchange** (storage `B`/`S`/`E`). Form text "Purchase" and
  legacy letter `P` are automatically translated to `B` on every ingest and
  API read path. Ticker and member summary aggregates
  (`buyCount`/`sellCount`/`exchangeCount`, `estimatedNetFlowUsd`) already
  exclude a non-matching/`null` `tx_type` from every bucket rather than counting
  it as one; alert-subscription `sides` filters behave the same way. Clients
  should render a `null` type as "unknown"/omit the buy-sell badge rather than
  assuming Buy.
- Command idempotency is race-safe end to end: a concurrent duplicate
  `POST /api/client/v1/commands` with the same `idempotencyKey` never 500s —
  it replays the winning row (`replayed: true`, `200`) or, in the rare case the
  winner's row can't be found on re-fetch, returns `409`. A `queued`/`running`
  command whose owning request died mid-flight (crash/eviction, never reached
  a terminal status) is NOT replayed forever: once it's sat in that state
  past `STALE_IN_FLIGHT_COMMAND_TTL_MS` (2 minutes; see `state.ts`), the next
  request with the same idempotency key reclaims and re-runs the same row
  instead of returning a status that can never change.
- Next: analytics summary, alert create/update/pause commands, APNs HTTP/2
  trade fan-out (credentials), rotate secret, test delivery, delivery
  history, and foreground command streaming.

## Production Boundaries

- Mobile/web app work must not require production deploys, production schema
  migrations, queue drains, production crawlers, or backfills unless Jay
  explicitly asks.
- If a contract change needs a migration or production backfill, document that
  in the PR and keep the code path safe before the production step runs.
