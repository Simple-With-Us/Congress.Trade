# 2026-10-21 — iOS widget build verification and compile fix

Seat: MM.  Branch `codex/widget-redesign` (pull request #2810, taken over from the CODEX seat at the owner's request while CODEX was at cap).  No Linear row: the work is the owner's take-over of an existing pull request, and the board rows covering the model-id convergence are separate.

## Summary

The widget rewrite in #2810 had never been compiled.  Its rollout note says so plainly: the change was authored on a Linux host where Swift, Xcode, Simulator, and the Apple signing tools were all unavailable, so no compile, XCTest, screenshot, or signed-device verification was claimed.  The required `xcodebuild-mac` check then failed on the `CongressTradeWidget` target, and the pull request could not merge.

The failure was one line of Swift, not a design problem.  `Calendar.timeZone` is a non-optional `TimeZone`, while `TimeZone(secondsFromGMT:)` returns an optional, so assigning the latter to the former does not compile:

```
clients/ios/CongressTradeWidget/CongressTradeWidget.swift:265:29: error: value of optional type 'TimeZone?' must be unwrapped to a value of type 'TimeZone'
```

The fix unwraps the value, matching the force-unwrap the app's own date helpers already use in `clients/ios/CongressTrade/Models.swift`, so the widget matches the codebase it ships in rather than inventing a second convention.  Nothing else in the file changed, and no other file in the pull request needed a change for the build.

## Files changed

- `clients/ios/CongressTradeWidget/CongressTradeWidget.swift`: unwrap the `TimeZone` assigned to `Calendar.timeZone` in `WidgetDate.displayCalendar`.
- `docs/rollouts/2026-10-21-ios-widget-build-verification.md`: this record.

## Verification

Run on a Mac with Xcode 27.1 (build `27A9275`), from the pull request head `4cb8a413`, after the one-line fix:

- `bash scripts/ios-assert-stable-xcode.sh` — passes; the toolchain is a stable Xcode, not a beta.
- `cd clients/ios && xcodegen generate && git diff --exit-code CongressTrade.xcodeproj` — no drift; the committed project matches the generated one.
- `xcodebuild build -project clients/ios/CongressTrade.xcodeproj -scheme CongressTrade -destination 'generic/platform=iOS' -derivedDataPath /tmp/ct-dd-2810 CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO` — **BUILD SUCCEEDED**; the `CongressTradeWidget` target compiles for arm64 and the app target that embeds it compiles with it.
- `xcodebuild build-for-testing -project clients/ios/CongressTrade.xcodeproj -scheme CongressTrade -destination 'generic/platform=iOS Simulator' -derivedDataPath /tmp/ct-dd-sim` — **TEST BUILD SUCCEEDED**; `CongressTradeTests` compiles for the simulator SDK.

Before the fix the same device build failed with exit code 65 and the `CongressTradeWidget` `SwiftCompile` and `SwiftEmitModule` failures, which is the failure the `xcodebuild-mac` job reported.

What is **not** verified by this record: the XCTest cases did not run on that machine, because it has no iOS simulator runtime installed, and the simulator screenshot and signed-device checks were not performed.  The CI `xcodebuild-mac` job runs the XCTest step on its own hosted macOS runner, and that job is the authority for the test result.

## Follow-ups

- The `xcodebuild-mac` job on #2810 re-runs on the pushed commit; it now compiles the widget, so it reaches the XCTest step that the compile error had been hiding.
- `docs/rollouts/2026-10-19-home-screen-widgets.md` is left untouched.  It is the chronological record of what was true on 2026-10-19, on a Linux host, and this note supersedes its compile-verification gap without rewriting it.
- The widget still ships through the normal iOS archive, TestFlight, and App Store path.  Merging this pull request does not install the redesign on an iPhone, and the public feed it reads needs no backend change, migration, or ingestion job.
