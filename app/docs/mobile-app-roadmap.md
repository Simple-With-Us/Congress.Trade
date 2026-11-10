# Mobile Client Roadmap: SwiftUI + SwiftUI

Last checked: 2026-06-23

## Recommendation

Keep the backend as the source of truth and build two peer client surfaces over
the same deliberately designed backend API:

- a responsive SwiftUI experience for all phones and browsers.
- a native SwiftUI iPhone app for the best iOS experience.

Both clients should use the same API shapes, auth/session model, command
gateway, status stream, and account-owned alert resources. Do not put scraping,
calculations, provider credentials, admin tokens, Stripe keys, or MCP
orchestration in either client.

The current public backend is enough for a read-only web/iOS MVP. Production
client apps need a shared client API, auth/session layer, account-owned alerts,
push notifications, and a server-side command gateway before either surface
manages webhooks/SSE or premium features.

## Target Architecture

- **SwiftUI:** responsive phone-first app with `Dashboard`, `Feed`,
  `TickerDetail`, `MemberDetail`, `Alerts`, `Developer`, and `Account` views.
- **SwiftUI app:** native iPhone app with the same product model and API DTOs as
  using SwiftUI navigation and native push.
- **Shared API client contract:** TypeScript client generated or typed from the
  same DTO contract used by Swift `Codable` models.
- **Client persistence:** IndexedDB/Cache Storage for the web app; SwiftData or Core
  Data for iOS. Both caches should key feed progress by `cursorSeq`.
- **Session storage:** secure HTTP-only cookies for the web app; Keychain-stored
  refresh tokens and short-lived access tokens for iOS.
- **Backend client API:** purpose-built `/api/client/v1/*` endpoints that return
  stable DTOs for both clients instead of exposing every web/admin route
  directly.
- **Command gateway:** every client mutation posts a command that is validated,
  queued, audited, and tracked server-side.
- **Background work:** scraping, extraction, enrichment, price calculations,
  webhook delivery, MCP/tool calls, and command execution remain on the backend.
- **Fresh data:** cursor polling as the reliable default, SSE/WebSocket for
  foreground web live mode, `URLSession` streaming for foreground iOS live mode,
  Web Push where viable, and APNs for iOS background alerts.

## Current Backend Fit

Usable today for a read-only iOS MVP:

- `GET /api/transactions?since=&limit=&ticker=&member=&chamber=&type=&from=&to=`
- `GET /api/filings/:docId`
- `GET /api/members`
- `GET /api/analytics/*`
- `GET /api/market/bundle/:ticker`
- `GET /api/client/v1/bootstrap`
- `GET /api/client/v1/me`
- `GET /api/client/v1/feed`
- `GET /api/client/v1/preferences`
- `GET /api/client/v1/subscriptions`
- `GET /api/client/v1/commands`

Not ready as production client primitives:

- Auth is web-cookie based.
- Billing is Stripe-hosted web checkout/portal.
- Delivery subscriptions are bearer-secret objects, not account-owned alert
  resources.
- SSE browser support uses query tokens because native `EventSource` cannot set
  auth headers. The web app can use authenticated fetch polling or a WebSocket/SSE
  token exchange; iOS should use `URLSession` streaming with headers, polling,
  and APNs.

## Shared Client API

Read endpoints:

- `GET /api/client/v1/bootstrap`
  - `serverTime`, user, entitlement, capability flags, and endpoint pointers.
- `GET /api/client/v1/me`
  - user and entitlement payload for authenticated clients.
- `GET /api/client/v1/feed?since=&limit=&ticker=&member=&chamber=&type=&from=&to=&order=...`
  - phone-shaped trade cards plus cursor/count/total metadata.
- `GET /api/client/v1/trades/:id`
  - trade detail, filing, company/politician summaries, legal/educational notices.
- `GET /api/client/v1/tickers/:ticker`
  - market bundle + congressional activity.
- `GET /api/client/v1/members/:id`
  - politician profile + activity.
- `GET /api/client/v1/analytics/summary`
  - compact KPI and trend cards for phone dashboards.
- `GET /api/client/v1/preferences`
  - account preferences for the signed-in user.
- `GET /api/client/v1/subscriptions`
  - account-owned delivery subscriptions.

Command endpoints:

- `POST /api/client/v1/commands`
  - body: `{ type, payload, idempotencyKey }`
  - returns `{ command, result }` on success, `{ command, error }` on failure,
    and `{ command, replayed: true }` for idempotency replays.
- `GET /api/client/v1/commands/:id`
  - status, audit trail, validation errors, resulting resource ids.
- `GET /api/client/v1/commands/stream`
  - not implemented yet; clients should poll `GET /api/client/v1/commands/:id`.

Account-owned alert endpoints:

- `GET /api/client/v1/alerts`
- `POST /api/client/v1/alerts`
- `PATCH /api/client/v1/alerts/:id`
- `POST /api/client/v1/devices`
  - APNs and web-push device registration.

Advanced developer delivery:

- `GET/POST/PATCH /api/client/v1/delivery-subscriptions`
  - account-owned wrapper around current webhook/SSE subscriptions.
  - includes target verification, rate limits, rotate secret, pause/resume, and
    test delivery.

## Command And Status Model

Use the same command lifecycle for the SwiftUI app.

Statuses:

- `queued`
- `running`
- `succeeded`
- `failed`
- `canceled`

Minimum command fields:

- `id`
- `type`
- `status`
- `createdAt`
- `updatedAt`
- `idempotencyKey`
- `userId`
- `payload`
- `error`
- `result`
- `audit`

Initial command types:

- Implemented: `update_preferences`, `create_subscription`,
  `update_subscription`, `delete_subscription`, `delete_account`.
- Defined in shared types but not yet routed through the client API:
  `start_checkout`, `request_export`.
- Next: `alert.create`, `alert.update`, `alert.pause`,
  `deliverySubscription.rotateSecret`, `deliverySubscription.testDelivery`,
  `device.register`.

Policy:

- Clients never call admin, migration, scraping, provider, or MCP routes
  directly.
- The backend validates account ownership and entitlement before a command is
  queued.
- Commands are idempotent by authenticated `userId + idempotencyKey`.
- Long-running commands report status through polling and, where supported,
  foreground streaming.
- Current clients should poll because the command stream route is not
  implemented yet.

## web app UX Direction

Build the web app phone-first, not as a desktop dashboard squeezed down.

- Bottom tab bar: Feed, Trends, Alerts, Developer, Account.
- Card feed on phones; dense table can remain desktop/tablet only.
- Sticky filter/search affordance with a sheet-style filter editor.
- Fast ticker/politician detail sheets with filing links and educational context.
- Alert builder as a guided flow with clear delivery channel choices.
- Developer delivery screen for webhook/SSE configuration, secret rotation,
  test delivery, and delivery history.
- Installable manifest, offline shell, cached last feed, and push-ready device
  registration.
- Accessibility baseline: 44px targets, visible focus, large text support,
  reduced-motion support, and no horizontal scrolling on phone widths.

## SwiftUI UX Direction

The SwiftUI app should feel native while sharing the same product model.

- Tabs mirror the web app: Feed, Trends, Alerts, Developer, Account.
- Use `NavigationStack`, searchable feed filters, native sheets, and APNs.
- Use `URLSession` + `Codable` over the shared DTO contract.
- Cache feed progress and common details with SwiftData or Core Data.
- Use Keychain for refresh tokens; no provider secrets or admin tokens on the
  phone.
- Use foreground polling/streaming for live status and APNs for background
  alerts.

## Auth And Billing

**Backend implemented (2026-08-09, env-gated off until App Store Connect
setup lands — see `app/docs/client-mobile-api.md` for the full contract):**
`POST /auth/apple` (Sign in with Apple, RS256-against-Apple's-JWKS
verification) and the `redeem_apple_purchase` client command (StoreKit 2,
full x5c chain verification against a pinned Apple root, no network call) +
`POST /api/webhooks/apple` (App Store Server Notifications V2). Entitlement
is Stripe OR Apple — the shared `users` billing model this section describes
below is realized via an independent `apple_subscriptions` ledger OR'd into
the existing resolver, not a fork of it.

**iOS client implemented (2026-08-09):** native Sign in with Apple
(`SignInWithAppleButton`, `com.apple.developer.applesignin` entitlement) on
both sign-in surfaces — Settings' Account section (alongside Google) and the
header hamburger menu's `AccountQuickMenu` — storing the resulting session
token in Keychain exactly like the Google/magic-link flows
(`CongressTradeStore.saveSessionToken`; see `clients/ios/CongressTrade/Store/
AppleSignIn.swift`). StoreKit 2 purchase/restore in `SubscribeView` now calls
the `redeem_apple_purchase` command (`CongressTradeAPIClient
.redeemApplePurchase`) instead of the older `POST /billing/apple/confirm`
route, refreshing `bootstrap`'s entitlement on success; product ids are
centralized in `AppleIAPProduct` (must match `APPLE_PRODUCT_MONTHLY`/
`APPLE_PRODUCT_ANNUAL`). "Manage Subscription" deep-links to
`https://apps.apple.com/account/subscriptions` from the hamburger menu and
from `SubscribeView` once `entitlement.source == "apple"`.  Website/Stripe
Premium (`source == "stripe"` or `null`) mints `POST /billing/portal` with
the session Bearer, and on failure opens `https://congress.trade/?billing=manage`
instead of a sign-out message. Verified: iOS
Simulator build + unit tests (mocked network) for both new endpoints — NOT
verified against a real device/sandbox purchase, since that needs live App
Store Connect products (owner follow-up below).

Auth should support both clients through the backend:

- Sign in with Apple.
- Google sign-in can remain, but if it is offered in the iOS app, Apple requires
  an equivalent privacy-preserving login option. See Apple's App Review
  Guidelines section 4.8.
- Backend verifies Apple/Google identity tokens and issues app-specific access
  and refresh tokens.
- Store web app sessions in secure HTTP-only cookies.
- Store iOS refresh tokens in Keychain; never store provider secrets on-device.

Billing requires an App Store decision:

- If the iOS app unlocks premium digital functionality, plan on StoreKit 2 and
  App Store Server Notifications / App Store Server API.
- Existing web/Stripe subscribers can be recognized if Apple rules allow the
  specific flow, but avoid in-app calls to action that route around in-app
  purchase outside allowed storefront/entitlement cases.
- Keep Stripe checkout on the web until the App Store billing strategy is
  settled.

References:

- Apple App Review Guidelines:
  https://developer.apple.com/app-store/review/guidelines/
- Apple In-App Purchase:
  https://developer.apple.com/in-app-purchase/

## Webhook And SSE UX

Consumer alerts should be APNs-backed account alert rules, not raw webhooks.

Expose webhooks/SSE as an advanced developer section:

- Target URL entry and verification.
- Filter builder.
- Pause/resume.
- Rotate secret.
- One-time secret reveal and copy.
- Test delivery.
- Delivery status history and errors.

Security requirements before broad mobile exposure:

- Account ownership on every subscription.
- Rate limits on create/update/test delivery.
- Audit log for every command and delivery config change.
- Server-side validation for target URLs and filters.
- Idempotency keys on command writes.

## Phased Build

1. **Shared client contract**
   - Define `/api/client/v1/*` DTOs, command statuses, idempotency rules, and typed
     clients for TypeScript and Swift.
2. **Phone-first SwiftUI**
   - Feed, search/filter, ticker/politician details, analytics summary, offline
     shell, installable manifest, and foreground polling.
3. **SwiftUI read-only MVP**
   - Same feed/detail/analytics model, local cursor cache, Keychain-ready client
     shell, and foreground polling.
4. **Client auth**
   - Sign in with Apple, optional Google, backend token exchange, web cookies,
     iOS Keychain refresh sessions.
5. **Command gateway**
   - Server-side command queue/status/audit model used by both clients.
6. **Alerts and push**
   - Account alert filters, APNs, web push where viable, backend fanout from
     transaction persistence.
7. **Developer delivery management**
   - Account-owned webhook/SSE management with target verification, rotate/test,
     audit log, and command status.
8. **Mobile entitlements**
   - StoreKit 2 or approved existing-subscriber flow; sync entitlements into the
     existing `users` model.
