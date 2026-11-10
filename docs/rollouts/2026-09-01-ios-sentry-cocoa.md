# CT iOS Cocoa Sentry (2026-09-01)

Board: `514c6531` — CT iOS Cocoa Sentry.  
Branch: `grok/sentry-ios-cocoa`.  
Worktree: `~/apps/congress-grok-sentry-ios`.

## What landed

- Adopted XcodeGen for `clients/ios` (`project.yml` + `xcodegen-post.py` for objectVersion 100).
- Added `SentryTelemetry.swift` (plist-only `SENTRY_DSN`, no hardcoded fallback).
- Scope: errors + native crashes + app hangs. `sendDefaultPii = false`, `attachScreenshot = false`, no view hierarchy, no Session Replay.
- `CongressTradeApp.init()` calls `SentryTelemetry.start()` early.
- Entitlements (`aps-environment`, Sign in with Apple) live in `project.yml` properties so regen does not wipe them.

## Follow-up (separate fleet lane)

- ios-ship dSYM / `sentry-cli` upload — do not invent a new LaunchAgent; use the existing ios-ship path.
- Pass `SENTRY_DSN` on release archives (Infisical / ship env). Empty skips init.

## Verify

- `cd clients/ios && xcodegen generate`
- `xcodebuild -project clients/ios/CongressTrade.xcodeproj -scheme CongressTrade -sdk iphonesimulator CODE_SIGNING_ALLOWED=NO build` (needs iOS Simulator runtime).
