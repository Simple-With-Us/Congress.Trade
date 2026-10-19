# Congress.Trade iOS

**Bundle ID:** `trade.congress.ios`
**Project:** `clients/ios/CongressTrade.xcodeproj` (no dot in the container name)
**Scheme / targets:** `CongressTrade` / `CongressTradeTests`
**Display name:** Congress.Trade
**Team:** `CC8UTF7ATG`
**XcodeGen:** `clients/ios/project.yml` is the source of truth. After adding/removing sources or changing packages/settings: `cd clients/ios && xcodegen generate` (runs `xcodegen-post.py` for objectVersion 100). Do not hand-edit `project.pbxproj`.
**Sentry Cocoa:** `SentryTelemetry.swift` reads plist-only `SENTRY_DSN` (no hardcoded fallback). Pass `SENTRY_DSN=...` on xcodebuild/CI for release archives. Errors + crashes + hangs only — no Replay, screenshots, view hierarchy, or default PII. dSYM upload is the existing ios-ship lane.
**Ship:** `bash scripts/ios-ship-testflight.sh` — fleet: `/Users/jay/apps/ios-fleet/README.md`

Binding fleet rule: `/Users/jay/apps/AGENT-SYNC.md` § iOS agent build loop. `xcodebuild` / `xcrun simctl` via bash are pre-approved. Do not ask. Do not stand up or narrate Xcode MCP.

## Build & test

```bash
xcodebuild -project clients/ios/CongressTrade.xcodeproj -scheme CongressTrade \
  -destination 'generic/platform=iOS Simulator' build

xcodebuild -project clients/ios/CongressTrade.xcodeproj -scheme CongressTrade \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' test
```

Use `/Applications/Xcode.app` only (never `Xcode-beta`). Discover simulators with `xcrun simctl list devices available`. After a user-visible change:

```bash
xcrun simctl io booted screenshot /tmp/ct-ios-verify.png
```

`BUILD SUCCEEDED` is not visual QA.

## File structure

```
clients/ios/
├── CongressTrade.xcodeproj/            # do not hand-edit
├── CongressTrade/
│   ├── App.swift                       # App entry
│   ├── AppUpdatePrompt.swift           # Copied pin from scripts/ios-fleet/
│   ├── AppDelegate.swift               # APNs / launch
│   ├── APIClient.swift                 # /api/client/v1 HTTP
│   ├── Models.swift                    # Decodable types (fail-soft optionals)
│   ├── KeychainTokenStore.swift        # Session token
│   ├── MemberDirectorySearch.swift     # People search
│   ├── Store/
│   │   ├── CongressTradeStore.swift    # @Observable client store
│   │   ├── AppleSignIn.swift           # Sign in with Apple
│   │   ├── AppleIAP.swift              # StoreKit 2 + Transaction.updates
│   │   ├── ManageSubscription.swift    # Restore / manage
│   │   └── PushNotificationManager.swift
│   └── Views/
│       ├── Feed/                       # Dashboard, trade / ticker / politician detail
│       ├── People/                     # Directory
│       ├── Delivery/                   # Delivery settings
│       ├── Status/                     # Settings + Premium sheet
│       ├── TrendsView.swift            # Trends (decode must fail-soft)
│       └── Components/                 # Shared chrome, eagle splash
└── CongressTradeTests/
```

## Rules

- `@Observable` + `@MainActor` on stores. Never `ObservableObject`.
- `NavigationStack` + value-based `NavigationLink`. Never `NavigationView`.
- Light is the product default. Do not ship dark-first chrome.
- Two spaces between sentences in user-visible copy.
- Never hand-edit `.pbxproj`, `.entitlements`, `.xib`, `.storyboard`.
- Do not take down a whole screen because one JSON field is null.
- Secrets stay in Infisical (`fleet-secrets get`); nothing reads `~/.secrets`. Never print them.
