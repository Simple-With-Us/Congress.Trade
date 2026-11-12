# 2026-08-22 — App Store resubmit from Tahoe GM + deletion recording

## What ASC showed as "has issues"

The owner-visible banner was **Invalid Binary**, not a new 5.1.1 note.

Live read after the first Mac-built resubmit:

| Field | Value |
|---|---|
| App Store version | `1.0.80` then `INVALID_BINARY` |
| Review submission | `95aaef81` then `8be3d7f4` → `UNRESOLVED_ISSUES` |
| TestFlight build `202608202100` | stayed `VALID` / `APP_STORE_ELIGIBLE` |

That is the same flip as 2026-08-11 and 2026-08-15: `WAITING_FOR_REVIEW` for about 45 seconds, then Invalid Binary.  TestFlight still accepts the IPA.

## Causes

1. **This Mac is still macOS 27.0 beta** (`sw_vers` `26A5416b`).  Xcode 26.6 (`17F113`) is GM.  The OS is not.  App Store review rejects `BuildMachineOSBuild` on the A-train.  Documented in `docs/rollouts/2026-08-15-invalid-binary-gm-host.md`.  Do not attach Mac-runner TestFlight builds to the store version.
2. **First API submit missed the IAP products.**  `reviewSubmissionItems.subscription` is not a relationship (`ENTITY_ERROR.RELATIONSHIP.UNKNOWN`).  The 2026 API wants `subscriptionVersion` plus `subscriptionGroupVersion` on the same review submission as the app version.  That is Guideline 2.1(b).

The deletion recording was not the problem.  `account-deletion-physical-device.mp4` (39s, physical device) is `COMPLETE` on the App Review Information detail.

## What we did

- Replaced leftover `IMG_1079.MP4` (ASC allows one attachment) with the owner-approved clip.
- Cancelled `b61e2a4a`, `95aaef81`, and `8be3d7f4`.
- Dispatched `.github/workflows/ios-appstore-gm.yml` on GitHub-hosted `macos-26` (Tahoe GM + Xcode 26.6).  Run [32553969173](https://github.com/jaywedgeworth22/Congress.Trade/actions/runs/32553969173) success in 4m54s.
- GM binary **1.0.81 (`202608220518`)** id `1c31e0c6-bc1a-4473-b583-4543254f3d2c` — `VALID`, `APP_STORE_ELIGIBLE`, encryption false, min iOS 17.0.
- Set the existing App Store version string to `1.0.81`, attached that build, created review submission `b174dd86-c149-41d5-a9e8-92d93eb5a653` with four items: app version, Premium group version, monthly version, annual version.  Submitted.

## Verify before calling it done

Wait at least 10 minutes.  A beta-host binary flips to `INVALID_BINARY` inside one minute.  The 2026-08-15 GM submit stayed `WAITING_FOR_REVIEW` at +10 minutes.

```text
version 1.0.81 WAITING_FOR_REVIEW
submission b174dd86 WAITING_FOR_REVIEW
4 items READY_FOR_REVIEW
monthly + annual WAITING_FOR_REVIEW
attachment account-deletion-physical-device.mp4 COMPLETE
```

Apple's Invalid Binary email (if it happens again) goes to the App Store Connect account mailbox (`johnwedgeworth@comcast.net`), not Gmail.  The public ASC API does not return the ITMS text.

## Do not

- Re-submit a Mac-runner TestFlight IPA while `sw_vers -buildVersion` matches `[0-9][a-z]$`.
- Add IAP products with relationship name `subscription`.  Use `subscriptionVersion` and `subscriptionGroupVersion`.
