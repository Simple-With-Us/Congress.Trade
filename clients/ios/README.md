# Congress.Trade SwiftUI App

Native iPhone prototype for the same backend-owned `/api/client/v1` API used by
the PWA. The backend remains the source of truth; the phone is a control surface.

See [IMPROVEMENT-PLAN.md](IMPROVEMENT-PLAN.md) for the current release, product,
performance, accessibility, and verification roadmap.

![iOS dashboard sample](Design/ios-dashboard-sample.svg)

## Current Surface

- Feed dashboard using `GET /api/client/v1/bootstrap` and
  `GET /api/client/v1/feed?order=desc`.
- Trade detail sheet with source-filing deep link when `filing.sourceUrl` is
  present.
- Watchlist preferences through `POST /api/client/v1/commands` with
  `update_preferences`.
- SSE/webhook creation through `create_subscription`.
- Subscription pause/resume through `update_subscription`.
- Command status list through `GET /api/client/v1/commands`.
- Session token support through Keychain and `Authorization: Bearer <token>`.

## Open In Xcode

The project container is `clients/ios/CongressTrade.xcodeproj` (no period in the
basename — that tripped up tooling).  The dotted leftover
`Congress.Trade.xcodeproj` is retired; do not recreate it.  Display name,
bundle id, scheme, and targets are unchanged (`Congress.Trade` /
`trade.congress.ios` / `CongressTrade`).

`project.yml` is the XcodeGen source of truth. After changing sources, packages,
or build settings:

```bash
cd clients/ios && xcodegen generate
```

Do not hand-edit `project.pbxproj`. Native Sentry is wired through
`SentryTelemetry.swift` and plist key `SENTRY_DSN` (empty by default; pass the
build setting for release archives).

```bash
open clients/ios/CongressTrade.xcodeproj
```

Use the `CongressTrade` scheme and an iPhone simulator. The target is iOS 17+.

CLI build check:

```bash
xcodebuild \
  -project clients/ios/CongressTrade.xcodeproj \
  -scheme CongressTrade \
  -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build
```

Unit tests cover ticker normalization, server preference loading, active-only
subscription patches, bearer/idempotency headers, and stream URL resolution.
Run them against an installed simulator device:

```bash
xcodebuild \
  -project clients/ios/CongressTrade.xcodeproj \
  -scheme CongressTrade \
  -destination 'platform=iOS Simulator,name=iPhone 16' \
  test
```

## Auth

The prototype can read the public feed without sign-in. Signed-in actions need an
opaque backend session token saved with:

```swift
try KeychainTokenStore().save("<session-token>")
```

The next production auth step is Sign in with Apple or a web-auth handoff that
returns the backend session token. Do not store provider keys, admin tokens,
scraper logic, calculations, or MCP orchestration in the app.

## API Override

By default the app uses:

```text
https://congress.trade/api/client/v1
```

For local Worker testing, set the `CONGRESS_TRADE_API_BASE_URL` environment
variable in the Xcode scheme, for example:

```text
http://127.0.0.1:8787/api/client/v1
```

The app keeps at most 500 recent trades on-device for offline viewing. The
current client API supports fetching newer rows with `since`; it does not yet
expose an older-page cursor, so historical paging remains a backend follow-up.

## TestFlight ship (no Xcode UI)

```bash
# From repo root (agent worktree)
bash scripts/ios-ship-testflight.sh

# IPA only
bash scripts/ios-ship-testflight.sh --export-only
```

Fleet driver (all three apps): `/Users/jay/apps/ios-fleet/README.md`.

Bundle ID: `trade.congress.ios`. Team: `CC8UTF7ATG`. Requires App Store Connect
app record + Xcode session or ASC credentials (env, else Infisical `/asc` via `fleet-secrets`).
