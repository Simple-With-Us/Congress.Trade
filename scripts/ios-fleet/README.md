# iOS fleet ship tooling

This directory is the **source of truth** for the fleet-wide TestFlight ship scripts used by all three apps (Socratic.Trade, Congress.Trade, Usage Monitor).  The runtime install location is `/Users/jay/apps/ios-fleet/`, which is outside version control — twice in one week an unversioned host script there carried a defect nobody could review (a reattach cron that opened a 60s outage window every minute; a macOS `flock` bug that would have shipped an empty version string).  This directory exists so the same scripts get code review, history, and PRs before they run.

## Files

- `ship-testflight.sh` — archive + export + upload a single app to TestFlight without the Xcode UI.
- `ship-all.sh` — ship all three fleet apps sequentially.
- `apps.json` — per-app registry (bundle id, scheme, project paths, team id).  Live DealDex is `net.dealdex` / appleId `6802474288`.
- `AppUpdatePrompt.swift` — pinned first-launch update prompt.  Copy into each iOS target.  Apple IDs stay in `apps.json` / `versions.json`, not in this file.
- `asc-api.mjs` — minimal App Store Connect API client (ES256 JWT, no dependencies).  Used by `ship-testflight.sh` for export-compliance (`ensure-tf-ready`) and for build-number verification (`latest-build-seq`).  It takes the private key from the environment only; it never reads a key file.
- `asc-key.mjs` — the hardened App Store Connect key reader (AFC-459, Kody rule 42).  It validates a staged key file, reads it once with `O_NOFOLLOW`, and hands the key to a child process in the child's environment as `ASC_KEY_P8`.  The key is never an argument, never on stdout, never in a log line.
- `ExportOptions-appstore.plist` — export options for `destination=upload`.
- `ExportOptions-export-ipa.plist` — export options for `destination=export` (local IPA only).
- `test-ship-seq.sh` — offline tests for the build-number rules (see **Tests**).  Repo-only; not installed to the runtime location.
- `test-asc-key.test.mjs` — offline tests for the key reader.  Repo-only; not installed to the runtime location.
- `test-asc-credentials.sh` — offline tests for the credential resolution in `ship-testflight.sh`.  Repo-only; not installed to the runtime location.

Secrets come from the first source that is present, in this order:

1. `ASC_KEY_ID` / `ASC_ISSUER_ID` / `ASC_KEY_P8` in the process environment (the client also accepts `APPLE_API_KEY_ID` / `APPLE_API_ISSUER_ID` / `APPLE_API_KEY_P8_BASE64`).
2. A key file named in `ASC_KEY_PATH` — a **file**, read through `asc-key.mjs`, never treated as a variable.
3. Infisical Fleet-OPS folder `/asc` through `fleet-secrets get` (`ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8`;  the `.p8` is written to a 0600 temp file for the run and removed on exit).

A path on disk is **not** a credential source (Kody rule 42, AFC-459):  the shell layer that owns the credential hands the key to the node client in the child's environment, so `asc-api.mjs` never reads a key file.  No local secrets folder is read (AFC-359).  None of the files here contain secret values.

## Install (sync repo copy -> runtime location)

```bash
install -m 0755 scripts/ios-fleet/ship-testflight.sh /Users/jay/apps/ios-fleet/ship-testflight.sh
install -m 0755 scripts/ios-fleet/ship-all.sh /Users/jay/apps/ios-fleet/ship-all.sh
install -m 0644 scripts/ios-fleet/apps.json /Users/jay/apps/ios-fleet/apps.json
install -m 0644 scripts/ios-fleet/asc-api.mjs /Users/jay/apps/ios-fleet/asc-api.mjs
install -m 0644 scripts/ios-fleet/asc-key.mjs /Users/jay/apps/ios-fleet/asc-key.mjs
install -m 0644 scripts/ios-fleet/ExportOptions-appstore.plist /Users/jay/apps/ios-fleet/ExportOptions-appstore.plist
install -m 0644 scripts/ios-fleet/ExportOptions-export-ipa.plist /Users/jay/apps/ios-fleet/ExportOptions-export-ipa.plist
install -m 0644 scripts/ios-fleet/AppUpdatePrompt.swift /Users/jay/apps/ios-fleet/AppUpdatePrompt.swift
```

Edit the runtime copy only through this repo: change the file here, land the PR, then re-run the `install` commands above to sync `/Users/jay/apps/ios-fleet/`.

## Versioning contract

| Field | Value | Example |
| --- | --- | --- |
| `MARKETING_VERSION` (`CFBundleShortVersionString`) | `1.0.<commit count>` (`git rev-list --count HEAD`) | `1.0.148` |
| `CURRENT_PROJECT_VERSION` (`CFBundleVersion`) | the same commit count | `148` |

App Store Connect renders these as `<marketing> (<build>)`, e.g. **`1.0.148 (148)`**.

Unified 2026-10-18 (#2801): the commit count is monotonic and names the exact commit a build came from, so the old UTC timestamp build is retired.  If the sequence floor is already at or above the commit count (a re-ship of the same commit), the build is bumped to floor + 1 so App Store Connect never sees a repeated version and build pair.

`--dry-run` only peeks at the next value and does not consume it, and the sequence file is guarded by an atomic-`mkdir` lock (not `flock(1)`, which does not exist on macOS) so concurrent ships cannot race the counter.

### Where the number comes from

The next sequence is **`max(local cache, App Store Connect, project.pbxproj) + 1`**.

`~/.cache/ios-fleet/build-seq-<app>.txt` is a *cache*, not the source of truth.  It is a single unbacked file on one machine: if it is lost, reset, or a ship runs from a second machine, a bare "+1" reuses a build number and App Store Connect rejects the upload as a duplicate.  Taking the max of every record we have is monotonic against all of them.  It can skip a number — harmless, numbers are free — but it cannot reuse one, which is fatal.

The three inputs are printed on every run, e.g. `seq sources: local=2 asc=1 project=4 -> floor=4`.

- **App Store Connect** is queried with `asc-api.mjs latest-build-seq <bundleId> 1.0`, using the same credentials already passed to `xcodebuild`.  That command reads **`preReleaseVersions[].attributes.version`** (the marketing version), *not* `builds[].attributes.version` (the build number) — the two are different fields, and the sequence tracks the marketing version.  Reading build numbers only ever worked during the window when both fields held the same string, and was already silently wrong for `socratic`, whose newest marketing version is `1.0.1` but whose build numbers are `2` / `1` / `202608120212`: none match `1.0.N`, so ASC contributed `0` and "verification" verified nothing.  Build numbers are still scanned afterwards so the floor can never come back *lower* than the old behaviour reported.

### Nothing is consumed by a run that will not ship

A build number is committed to the counter only by a run that is actually about to archive.  The ship gate (rate limit / same-HEAD) is evaluated **before** the sequence is touched, `--dry-run` peeks only, and `--upload-only` resolves no sequence at all because the IPA already carries its versions.  Before 2026-08-12 the gate ran *after* the counter had advanced, so every rate-limited attempt burned a version that shipped nowhere — observed live: a run skipped at 4392s of a 9000s interval and the sequence still went 5 → 6, leaving `1.0.6` existing in no place at all and the local counter drifting further from ASC.

`test-ship-seq.sh` pins all of this down; see **Tests** below.
- **`project.pbxproj`** participates in the max, so the project file can never be silently disagreed with.  The resolved version is passed on the `xcodebuild` command line and overrides whatever the project file says, so a run whose resolved version differs from the project file prints a `NOTICE` naming both.  `--sync-project-version` writes the resolved version back into the project file (opt-in: it dirties the worktree, and shipping requires a clean one).
- If **ASC cannot be consulted at all** and there is no local sequence and no on-train version in the project file, the script **fails** rather than guessing, and prints the three ways to resolve it.  `--allow-unverified-seq` overrides, with a warning.

`IOS_FLEET_STATE_DIR` relocates the sequence/rate-limit state, for testing against a scratch directory.

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
node --test scripts/ios-fleet/test-asc-key.test.mjs
```

47 assertions, fully offline — no network, no Xcode, no credentials.  It runs `ship-testflight.sh` with `HOME`, `PATH` and `IOS_FLEET_STATE_DIR` pointed at a scratch sandbox (a fake `xcodebuild` refuses to archive), so it cannot touch real ship state or App Store Connect.  It pins:

- a rate-limited run, and a same-HEAD run, exit 0 **without advancing the counter** (this is the 2026-08-12 regression, and the suite fails against the pre-fix script exactly there);
- a gated run does not even make the ASC round trip;
- an allowed run advances the counter by **exactly one**, three in a row give 6 → 7 → 8;
- `--dry-run` and `--upload-only` consume nothing; `--force-ship` still bypasses the gate;
- for **all four apps**: marketing and build are both `1.0.N` and equal;
- the skip message names the 3600s default and both overrides;
- a last-ship 3000s ago is still gated (sequence untouched); at 3700s the gate proceeds.

The credential suites are offline too:  `test-asc-credentials.sh` drives `load_secrets` with a fake `fleet-secrets` and throwaway keys generated at test time, and `test-asc-key.test.mjs` generates its own key pair.  Neither commits a key, and neither reaches the network.

## Drift check

`check-drift.sh` compares the sha256 of each file here against its counterpart in `/Users/jay/apps/ios-fleet/` and fails if they differ, so the repo copy cannot silently go stale relative to what actually runs.  Run it locally with:

```bash
bash scripts/ios-fleet/check-drift.sh
```

It exits 0 with a warning (not a failure) when `/Users/jay/apps/ios-fleet/` does not exist on the current machine, since that directory is host-local and won't be present in CI.

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

