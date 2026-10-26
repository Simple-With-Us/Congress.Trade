# iOS fleet ship tooling

This directory is the **source of truth** for the fleet-wide TestFlight ship scripts used by all three apps (Socratic.Trade, Congress.Trade, Usage Monitor).  The runtime install location is `/Users/jay/apps/ios-fleet/`, which is outside version control — twice in one week an unversioned host script there carried a defect nobody could review (a reattach cron that opened a 60s outage window every minute; a macOS `flock` bug that would have shipped an empty version string).  This directory exists so the same scripts get code review, history, and PRs before they run.

## Files

- `ship-testflight.sh` — archive + export + upload a single app to TestFlight without the Xcode UI.
- `ship-all.sh` — ship all three fleet apps sequentially.
- `apps.json` — per-app registry (bundle id, scheme, project paths, team id).  Live DealDex is `net.dealdex` / appleId `6802474288`.
- `AppUpdatePrompt.swift` — pinned first-launch update prompt.  Copy into each iOS target.  Apple IDs stay in `apps.json` / `versions.json`, not in this file.
- `asc-api.mjs` — minimal App Store Connect API client (ES256 JWT, no dependencies).  Used by `ship-testflight.sh` for export-compliance (`ensure-tf-ready`), for the version-numbering queries (`latest-marketing-patch`, `build-floor`) and for the App Store version workflow (`appstore-version-plan`, `appstore-version-prepare`).  It takes the private key from the environment only; it never reads a key file.
- `asc-key.mjs` — the App Store Connect key module (AFC-459, revision 2, Kody rule 42).  It never reads a file:  a path on disk is not an approved credential source at all.  It validates a key, writes a mode-600 staging copy for altool and Xcode, and builds the allowlisted environment a child process runs with.  The key is never an argument, never on stdout, never in a log line.
- `version-plan.mjs` — the version-numbering rules as a pure module (no I/O, no network):  `parsePatch`, `isDriftTrain`, `latestMarketingPatch`, `buildFloor`, `planVersion`.  `asc-api.mjs` imports it and the bash script implements the same rules; `version-plan.test.mjs` pins them.
- `ExportOptions-appstore.plist` — export options for `destination=upload`.
- `ExportOptions-export-ipa.plist` — export options for `destination=export` (local IPA only).
- `test-ship-seq.sh` — offline tests for the version rules (see **Tests**).  Repo-only; not installed to the runtime location.
- `version-plan.test.mjs` — offline unit tests for the version-numbering rules.  Repo-only; not installed to the runtime location.
- `test-asc-key.test.mjs` — offline tests for the key module.  Repo-only; not installed to the runtime location.
- `test-asc-credentials.sh` — offline tests for the credential resolution in `ship-testflight.sh`.  Repo-only; not installed to the runtime location.

Secrets come from the first source that is present, in this order:

1. `APPLE_API_KEY_ID` / `APPLE_API_ISSUER_ID` / `APPLE_API_KEY_P8_BASE64` in the process environment (the hosted form; the key is base64, so it is one line and can cross a CI step boundary).
2. `ASC_KEY_ID` / `ASC_ISSUER_ID` / `ASC_KEY_P8` in the process environment.
3. Infisical Fleet-OPS folder `/asc` through `fleet-secrets get` (`ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8`;  the `.p8` is written to a 0600 temp file for the run and removed on exit).

A path on disk is **not** a credential source (AFC-459, revision 2, Kody rule 42):  a named `ASC_KEY_PATH` is ignored wherever it appears.  The shell layer that owns the credential resolves it, hands it to the node client in the child's environment, and writes the only file that may exist — a short-lived, owner-only staging copy for altool and Xcode, which can only read a key from disk.  That file is written *from* the credential and is never read back as one, so `asc-api.mjs` never reads a key file.  No local secrets folder is read (AFC-359).  None of the files here contain secret values.

## Install (sync repo copy -> runtime location)

```bash
install -m 0755 scripts/ios-fleet/ship-testflight.sh /Users/jay/apps/ios-fleet/ship-testflight.sh
install -m 0755 scripts/ios-fleet/ship-all.sh /Users/jay/apps/ios-fleet/ship-all.sh
install -m 0644 scripts/ios-fleet/apps.json /Users/jay/apps/ios-fleet/apps.json
install -m 0644 scripts/ios-fleet/asc-api.mjs /Users/jay/apps/ios-fleet/asc-api.mjs
install -m 0644 scripts/ios-fleet/asc-key.mjs /Users/jay/apps/ios-fleet/asc-key.mjs
install -m 0644 scripts/ios-fleet/version-plan.mjs /Users/jay/apps/ios-fleet/version-plan.mjs
install -m 0644 scripts/ios-fleet/ExportOptions-appstore.plist /Users/jay/apps/ios-fleet/ExportOptions-appstore.plist
install -m 0644 scripts/ios-fleet/ExportOptions-export-ipa.plist /Users/jay/apps/ios-fleet/ExportOptions-export-ipa.plist
install -m 0644 scripts/ios-fleet/AppUpdatePrompt.swift /Users/jay/apps/ios-fleet/AppUpdatePrompt.swift
```

Edit the runtime copy only through this repo: change the file here, land the PR, then re-run the `install` commands above to sync `/Users/jay/apps/ios-fleet/`.

## Versioning contract

Owner directive 2026-10-24 (AFC-517 / CT-2444).  It replaces the
`1.0.<commit count>` scheme unified in #2801 (2026-10-18), which made App Store
Connect show `1.0.2358 (2358)`.

| Field | Value | Example |
| --- | --- | --- |
| `MARKETING_VERSION` (`CFBundleShortVersionString`) | `<prefix>.<P+1>` — the next patch on the app's train | `1.0.237` |
| `CURRENT_PROJECT_VERSION` (`CFBundleVersion`) | the repo commit count, raised above the App Store Connect floor | `2360` |

App Store Connect renders these as `<marketing> (<build>)`, e.g. **`1.0.237 (2360)`**.

- **The marketing version** is the next patch on the train named by
  `marketingVersionDefault` (`1.0`).  `P` is the highest patch App Store Connect
  already holds on that train, counting **both** the App Store versions
  (`appStoreVersions.versionString`) **and** the TestFlight trains
  (`preReleaseVersions.version`) for the app's platform.
  A TestFlight train that holds a build named after its own patch — a
  **drift train**, e.g. `1.0.2358` holding build `2358` — is **ignored**, so
  the uploads of the retired scheme no longer push the version forward.  App
  Store versions are never ignored.
- **The build number** is independent of the marketing version:  it is the
  repo commit count (`git rev-list --count HEAD`), raised when needed so that
  it is strictly greater than
  - every build already in the **target** marketing train — any value,
    including the old 12-digit UTC stamps, because Apple requires build
    numbers to increase inside one version train — and
  - the highest plain-integer build below `1000000000` the app has on that
    platform (this keeps the number monotonic on a shallow checkout).  On
    macOS **every** build counts, because macOS build numbers must increase
    across all trains.
- **A ship never reads `1.0.N (N)`.**  If the resolved build number happens to
  equal the patch number of the marketing version, the build moves one up.
- `--version X.Y.Z` is an exact marketing override; `--build N` is an exact
  build override.  With `--version` only, the build is still automatic (the
  commit count, floored against *that* train); with `--build` only, the
  marketing version is still the automatic next patch.

The rules live in `version-plan.mjs` (pure, unit-tested); the bash script
implements the same rules and `scripts/ios-fleet/version-plan.test.mjs` pins
them, with the live Congress.Trade App Store Connect state as the fixture.

Every run prints the plan it resolved:

```
[ios-ship] version plan: asc_patch=236 -> marketing=1.0.237; build floors: train=0 app=2358 commit_count=2360 -> build=2360
[ios-ship] marketing=1.0.237 build=2360
[ios-ship] App Store Connect will show this as: 1.0.237 (2360)
```

### Where the number comes from

App Store Connect is the only record that shipping advances, so it is the only
record that can answer "which patches does this train hold?" and "which build
numbers are taken?".

- The **patch** comes from `asc-api.mjs latest-marketing-patch <bundleId> <prefix> <platform>`.
- The **floor** comes from `asc-api.mjs build-floor <bundleId> <version> <platform>`:
  the builds of the target train plus the app's own builds on that platform.

The local build-seq cache (`~/.cache/ios-fleet/build-seq-<app>.txt`) is
**retired**:  nothing writes it and nothing reads it.  `project.pbxproj` is not
a sequencing input either — it is only read to print the agreement `NOTICE`.
If **App Store Connect cannot be consulted**, the script **fails** rather than
guessing, and prints the ways out.  `--allow-unverified-seq` overrides, with a
loud warning:  the patch falls back to `0` and the floor to `0`.

`--dry-run` only peeks at the version and does not ship it, the ship gate (rate
limit / same-HEAD) is evaluated **before** any App Store Connect query, and
`--upload-only` resolves no version at all because the IPA already carries one.

`IOS_FLEET_STATE_DIR` relocates the ship-gate state, for testing against a scratch directory.

### Changing the train needs a dispatch

`ios-ship.yml` runs on a push only when `clients/ios/**` or the workflow file changes.  A change that touches only release config (for example `marketingVersionDefault` in `apps.json`, which every app shares, or the ship scripts) does not start a ship, and the cron backstop only ships when `clients/ios/**` changed since the last recorded ship.  This is deliberate: a path trigger on shared config or tooling would ship a TestFlight build on unrelated edits.  After a train change merges, ship it on purpose with **Run workflow** (`workflow_dispatch`) on `main`, then confirm `marketing=<train>.N build=<n>` in the "version plan" log line.  A train move ships only when someone dispatches the workflow; do not rely on the merge.

## Rate limit — what holds back automatic shipping

Uploads are throttled to **one successful ship per app per `DEFAULT_MIN_INTERVAL_SEC` = 3600 seconds (1 hour)**.  The constant lives near the top of `ship-testflight.sh`.  This is the main reason a merge to `main` does not become a TestFlight build: `.github/workflows/ios-ship.yml` fires on every push touching `clients/ios/**`, and most of those runs land inside the window, print `ship-gate: skip`, and exit 0.  A run whose git HEAD already shipped skips for the same reason.  Cron ticks twice an hour, so an unbuilt merge is picked up on the next eligible hour.

- **Override one run:** `IOS_TF_MIN_INTERVAL_SEC=<seconds>` in the environment, or `--force-ship`.
- **Change the standing limit:** edit `DEFAULT_MIN_INTERVAL_SEC`.  That is the owner's call — the number is a local/process-hygiene choice, not an Apple constraint.
- `--export-only` and `--dry-run` are not rate limited; neither builds a TestFlight upload.

The skip message names the value, its source, and both overrides, so the limit is discoverable from the log rather than only from this file.

## Tests

```bash
bash scripts/ios-fleet/test-ship-seq.sh
bash scripts/ios-fleet/test-asc-credentials.sh
node --test scripts/ios-fleet/version-plan.test.mjs
node --test scripts/ios-fleet/test-asc-key.test.mjs
```

Fully offline — no network, no Xcode, no credentials.  `test-ship-seq.sh` runs `ship-testflight.sh` with `HOME`, `PATH` and `IOS_FLEET_STATE_DIR` pointed at a scratch sandbox (a fake `xcodebuild` refuses to archive, and a fake `node` answers the two App Store Connect version queries from the environment), so it cannot touch real ship state or App Store Connect.  It pins:

- a rate-limited run, and a same-HEAD run, exit 0 **without resolving a version** (this is the 2026-08-12 regression, and the suite fails against the pre-fix script exactly there);
- a gated run does not even make the ASC round trip;
- `--dry-run` and `--upload-only` ship nothing; `--force-ship` still bypasses the gate;
- for **all four apps**: the marketing version is the next patch on the train, the build number is the repo commit count, and the pair never reads `1.0.N (N)`;
- a floor above the commit count raises the build to floor + 1 and leaves the marketing version alone;
- `--version 1.0.236` is honoured exactly and floors the build against *that* train; `--build 999` is honoured exactly and does not move the marketing version;
- an unreachable App Store Connect fails the run unless `--allow-unverified-seq` is passed;
- the skip message names the 3600s default and both overrides;
- a last-ship 3000s ago is still gated (sequence untouched); at 3700s the gate proceeds.

The credential suites are offline too:  `test-asc-credentials.sh` drives `load_secrets` with a fake `fleet-secrets` and throwaway keys generated at test time, and `test-asc-key.test.mjs` generates its own key pair.  Neither commits a key, and neither reaches the network.

## Drift check

`check-drift.sh` compares the sha256 of each file here against its counterpart in `/Users/jay/apps/ios-fleet/` and fails if they differ, so the repo copy cannot silently go stale relative to what actually runs.  Run it locally with:

```bash
bash scripts/ios-fleet/check-drift.sh
```

It exits 0 with a warning (not a failure) when `/Users/jay/apps/ios-fleet/` does not exist on the current machine, since that directory is host-local and won't be present in CI.

## App Store version (prepare, never submits)

`.github/workflows/ios-appstore-version.yml` is a manual workflow that prepares the
App Store version for Congress.Trade:

- `mode: plan` (read only) prints the App Store versions, the newest builds and
  the next marketing version as JSON — `asc-api.mjs appstore-version-plan`.
- `mode: prepare` creates the version (or reuses it when it is already
  editable), attaches the build to it, and prints a metadata comparison against
  the newest released version — `asc-api.mjs appstore-version-prepare`.  It
  refuses to touch a version that is already in review, and it never renames or
  deletes another version.

It **never submits for review**:  no `appStoreVersionSubmission`, no
`reviewSubmission`, no `reviewSubmissionItem`, and no localization is ever
written.  A human submits the version in App Store Connect.

`.github/workflows/ios-appstore-gm.yml` takes a `marketing_version` input, so
one run can ship an exact version (`1.0.236`) instead of the automatic next
patch.  The input is validated and passed to the ship script as `--version`.

## In-app update prompt

Every fleet iOS app copies `AppUpdatePrompt.swift` from this directory (canonical
runtime: `/Users/jay/apps/ios-fleet/AppUpdatePrompt.swift`) into the app target
as a real Swift file and calls `.appUpdatePrompt()` on the root view.  Do not
inline the type in `App.swift`.  Do not make a Swift package.  Congress.Trade
keeps its copy at `clients/ios/CongressTrade/AppUpdatePrompt.swift`.

Numeric Apple IDs live in `apps.json` and
https://raw.githubusercontent.com/jaywedgeworth22/ai-fleet-coordinator/main/site/ios-versions.json
— not in the Swift pin.  Live DealDex is `net.dealdex` (appleId 6802474288).
`online.dealdex` is a stale leftover, not live.  Do not upload `me.grok.dealdex`.
TestFlight versions are published to that manifest by `publish-ios-versions.sh`
after a successful ship.

