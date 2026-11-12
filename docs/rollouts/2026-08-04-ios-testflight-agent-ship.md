# 2026-08-04 — iOS TestFlight agent ship (Congress.Trade)

## Context & Objective

Enable agents to push the Congress.Trade native iOS client to TestFlight without
opening Xcode. Cross-app with Socratic.Trade and Usage Monitor.

## Changes Made

- Added `scripts/ios-ship-testflight.sh` wrapper (app key `congress`).
- Added `clients/ios/ExportOptions-appstore.plist` and `ExportOptions-export-ipa.plist`.
- Documented ship path in `clients/ios/README.md`.
- Fleet registry: bundle `trade.congress.ios`, scheme `CongressTrade`, team `CC8UTF7ATG`.

## Decisions & Trade-offs

- Pure `xcodebuild` path (no Fastlane).
- No XcodeGen for this project (checked-in `.xcodeproj` is source of truth).
- Public App Store submit not automated.

## Verification State

- Dry-run of fleet ship script.
- Full upload blocked until ASC app record + API key / Xcode session.

## Next Steps & Blockers

- Owner: ASC app for `trade.congress.ios` + secrets handoff if needed.
- Owner: TestFlight install once on phone.

## Verification receipts (2026-08-04)

- `bash scripts/ios-ship-testflight.sh --export-only` produced a signed IPA via
  `xcodebuild archive` + `exportArchive` with `-allowProvisioningUpdates`.
- Upload to TestFlight still requires App Store Connect app records + ASC API key
  at `~/.secrets/appstore-connect.env` (auth was `none` on this Mac at ship time).
