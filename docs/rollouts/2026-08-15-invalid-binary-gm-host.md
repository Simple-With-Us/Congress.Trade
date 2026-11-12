# 2026-08-15 — App Store INVALID_BINARY: beta host + missing privacy manifest

## What happened

Congress.Trade iOS 1.0 flipped `WAITING_FOR_REVIEW` → `INVALID_BINARY` again
after the 1.0.14 submit (`07474276`, build `202608141034`).  The attached
build stayed TestFlight `VALID` / `APP_STORE_ELIGIBLE` / min OS 17.0.
Apple's review item is `REJECTED` with no text in the ASC API.  Usage Client
and Usage Local 1.0.0 are in the same state.

## Causes

1. **Build host is macOS 27.0 beta** (`BuildMachineOSBuild` `26A5406e`).
   TestFlight accepts that stamp.  App Store review does not.  Xcode.app
   26.6 is GM; the OS is not.  Re-submitting a binary from this Mac will
   flip again.
2. **Congress.Trade had no `PrivacyInfo.xcprivacy`.**  The app reads
   `UserDefaults` (sync cursor + APNs token cache).  A missing required-
   reason manifest is its own Invalid Binary class (ITMS-91053).

`UIBackgroundModes` is only `remote-notification`, which
`PushNotificationManager` uses.

## Fix

- Add `clients/ios/CongressTrade/PrivacyInfo.xcprivacy` (UserDefaults
  CA92.1 / 1C8F.1, FileTimestamp C617.1) and copy it into the app bundle.
- Ship App Store binaries from **GitHub-hosted `macos-26`** (Tahoe GM
  `25F84` + Xcode 26.6).  Workflow:
  `.github/workflows/ios-appstore-gm.yml` (manual).
- Regular TestFlight ships stay on the owned Mac runner.  Do not attach
  those IPAs to the store version until a GM-host build exists.

## Verify before submit

```text
sw_vers -buildVersion   # must NOT match [0-9][a-z]$  (no 26A5406e)
ipa Info.plist BuildMachineOSBuild
```

Then attach the new build to version 1.0 and submit a fresh review
submission.  Cancel `07474276` if it is still `UNRESOLVED_ISSUES`.
