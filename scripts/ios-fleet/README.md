# iOS fleet ship tooling

This directory is the **source of truth** for the fleet-wide TestFlight ship scripts used by all three apps (Socratic.Trade, Congress.Trade, Usage Monitor).  The runtime install location is `/Users/jay/apps/ios-fleet/`, which is outside version control — twice in one week an unversioned host script there carried a defect nobody could review (a reattach cron that opened a 60s outage window every minute; a macOS `flock` bug that would have shipped an empty version string).  This directory exists so the same scripts get code review, history, and PRs before they run.

## Files

- `ship-testflight.sh` — archive + export + upload a single app to TestFlight without the Xcode UI.
- `ship-all.sh` — ship all three fleet apps sequentially.
- `apps.json` — per-app registry (bundle id, scheme, project paths, team id).  Live DealDex is `net.dealdex` / appleId `6802474288`.
- `AppUpdatePrompt.swift` — pinned first-launch update prompt.  Copy into each iOS target.  Apple IDs stay in `apps.json` / `versions.json`, not in this file.
- `asc-api.mjs` — minimal App Store Connect API client (ES256 JWT, no dependencies).  Used by `ship-testflight.sh` for export-compliance (`ensure-tf-ready`), for the version-numbering queries (`latest-marketing-patch`, `build-floor`) and for the App Store version workflow (`appstore-version-plan`, `appstore-version-prepare`).  It takes the private key from the environment only; it never reads a key file.
- `asc-key.mjs` — the App Store Connect key module (AFC-459, revision 2, Kody rule 42).  It never reads a file:  a path on disk is not an approved credential source at all.  It validates a key, writes a mode-600 staging copy for altool and Xcode, and builds the allowlisted environment a child process runs with.  The key is never an argument, never on stdout, never in a log line.
- `version-plan.mjs` — the AFC-356 release-numbering rules as a pure module (no I/O, no network); `asc-api.mjs` imports its published-floor validators and `version-plan.test.mjs` pins the pair selection.
- `release-platform-plan.mjs` — the cross-platform half of the same rules as a pure module: which native platforms a change releases, the number they share, and the release a platform keeps when it does not ship.
- `check-version-policy.mjs` — deterministic checked-in source enforcement. It scans tracked release scripts and does not depend on the host runtime directory.
- `ExportOptions-appstore.plist` — export options for `destination=upload`.
- `ExportOptions-export-ipa.plist` — export options for `destination=export` (local IPA only).
- `test-ship-seq.sh` — offline tests for the version rules (see **Tests**).  Repo-only; not installed to the runtime location.
- `version-plan.test.mjs` — offline unit tests for the version-numbering rules.  Repo-only; not installed to the runtime location.
- `release-platform-plan.test.mjs` — offline unit tests for the cross-platform release rules.  Repo-only; not installed to the runtime location.
- `test-release-platforms.sh` — offline cross-platform tests: two native platforms, one real ship script and one real gate.  Repo-only; not installed to the runtime location.
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

Restored protocol from AGENT-SYNC.md and AFC-356. Marketing and build use one
shared per-app release number derived from the full repository commit count.

| Field | Value | Example |
| --- | --- | --- |
| `MARKETING_VERSION` (`CFBundleShortVersionString`) | `1.0.N` | `1.0.148` |
| `CURRENT_PROJECT_VERSION` (`CFBundleVersion`) | `N` | `148` |

`N` is the full `git rev-list --count HEAD` for the app repository. A Mac-only
update gets the new pair on Mac and leaves iOS at its previously shipped pair.
If Mac and iOS both update for the same release, both use the same N. A later
companion-platform update uses the count for that later release.

Each platform advances when that platform's native files changed. The ship
workflow's path gate decides whether a platform is eligible to ship; the
version selector does not force the companion platform to rebuild.

Published App Store Connect marketing/build values and committed project
values are validation floors, not replacement allocators. Full history is
required. Unknown or conflicting floors, marketing regression, shallow or
missing history, and off-protocol `--version` / `--build` overrides fail
loudly. `148` is valid only when the full current commit count is 148; it is
not a requested target. Historical timestamp builds are not silently
converted into a higher N. Resolve platform-specific monotonicity before any
migration.

The app controls the actual submitted values. App Store Connect owns its
rendering, which may display marketing and build together. App-owned UI should
show `1.0.N` without adding a redundant `(N)` suffix.

The pure planner and actual ship script are tested. The offline ship test
stubs App Store Connect and Xcode, runs the selector and export-only path, and
inspects final generated app and widget Info.plists.

Every run prints the plan it resolved:

```
[ios-ship] version plan: published_marketing=147 project_build=147 asc_build=147 -> commit_count=148
[ios-ship] marketing=1.0.148 build=148
[ios-ship] resolved metadata: MARKETING_VERSION=1.0.148 CURRENT_PROJECT_VERSION=148
```

### Where the number comes from

App Store Connect is queried to ensure the current N does not regress the
published marketing or build values. It does not allocate N. The local
build-seq cache is retired. The project file is checked for conflicting floors;
it does not allocate a replacement value. If a published floor is unknown or
already at or above N, shipping fails instead of guessing or inflating N.

`--dry-run` only peeks at the version and does not ship it, the ship gate (rate
limit / same-HEAD) is evaluated **before** any App Store Connect query, and
`--upload-only` resolves no version at all because the IPA already carries one.

`IOS_FLEET_STATE_DIR` relocates the ship-gate state, for testing against a scratch directory.

`IOS_FLEET_APPS_JSON` points the ship script at a different apps registry. The
default is the canonical `apps.json` next to the script. The override exists so
an app that keeps its own registry, and the offline cross-platform test that
needs a two-platform fixture, can supply one without editing the shared file.

## Cross-platform releases

An app with more than one native platform (macOS and iOS) is two app keys in
`apps.json`, one per platform, each with its own bundle id, scheme, project
path and `platform`. The rules that connect them:

| Rule | Meaning |
| --- | --- |
| Native-path gating | A platform ships only when its own native files changed. |
| Paired release | Platforms that ship together are one release and share one N. |
| Platform-only update | A platform that does not ship keeps the release it already has. |
| Delayed companion build | The platform that ships later is a later release and gets the later N. |

`release-platform-plan.mjs` states those rules as a pure module, so they can be
asserted without a network, a credential or an Xcode:

```bash
node scripts/ios-fleet/release-platform-plan.mjs --plan plan.json
```

The document it reads names the repository commit count, the changed paths and
one entry per platform (its key, its native prefixes, and the release it has
already shipped). It prints the platforms that ship, the number they share, and
the platforms that hold their existing release. A published release that is
already at or above N fails closed there, exactly as it does in the ship
script.

`test-release-platforms.sh` proves the same rules against the real
`ship-testflight.sh` and the real `scheduled-ship-gate.sh`, with a fake Xcode
and a stubbed App Store Connect.

## Rate limit — what holds back automatic shipping

Uploads are throttled to **one successful ship per app per `DEFAULT_MIN_INTERVAL_SEC` = 3600 seconds (1 hour)**.  The constant lives near the top of `ship-testflight.sh`.  This is the main reason a merge to `main` does not become a TestFlight build: `.github/workflows/ios-ship.yml` fires on every push touching `clients/ios/**`, and most of those runs land inside the window, print `ship-gate: skip`, and exit 0.  A run whose git HEAD already shipped skips for the same reason.  Cron ticks twice an hour, so an unbuilt merge is picked up on the next eligible hour.

- **Override one run:** `IOS_TF_MIN_INTERVAL_SEC=<seconds>` in the environment, or `--force-ship`.
- **Change the standing limit:** edit `DEFAULT_MIN_INTERVAL_SEC`.  That is the owner's call — the number is a local/process-hygiene choice, not an Apple constraint.
- `--export-only` and `--dry-run` are not rate limited; neither builds a TestFlight upload.

The skip message names the value, its source, and both overrides, so the limit is discoverable from the log rather than only from this file.

## Tests

```bash
bash scripts/ios-fleet/test-ship-seq.sh
bash scripts/ios-fleet/test-release-platforms.sh
bash scripts/ios-fleet/test-asc-credentials.sh
node --test scripts/ios-fleet/version-plan.test.mjs
node --test scripts/ios-fleet/release-platform-plan.test.mjs
node --test scripts/ios-fleet/check-version-policy.test.mjs
node scripts/ios-fleet/check-version-policy.mjs
node --test scripts/ios-fleet/test-asc-key.test.mjs
```

Fully offline — no network, no real Xcode, no credentials. `test-ship-seq.sh`
runs `ship-testflight.sh` with `HOME`, `PATH` and `IOS_FLEET_STATE_DIR` pointed
at scratch state; fake `xcodebuild` writes synthetic app/widget metadata and a
fake `node` answers App Store Connect queries from the environment. It pins:

- a rate-limited run, and a same-HEAD run, exit 0 **without resolving a version** (this is the 2026-08-12 regression, and the suite fails against the pre-fix script exactly there);
- a gated run does not even make the ASC round trip;
- `--dry-run` and `--upload-only` ship nothing; `--force-ship` still bypasses the gate;
- marketing and build both equal the full-history commit count;
- canonical explicit overrides validate and noncanonical overrides fail;
- published floors below N validate, while unknown or conflicting floors fail;
- missing and shallow history fail closed;
- an offline export-only run inspects final generated app and widget metadata;
- the skip message names the 3600s default and both overrides;
- a last-ship 3000s ago is still gated (sequence untouched); at 3700s the gate proceeds.

`test-release-platforms.sh` runs the real ship script and the real gate over a
fixture with an iOS platform and a macOS platform, and pins:

- native-path gating: a backend-only change releases neither platform, an iOS change releases only iOS, and a macOS change releases only macOS;
- a paired release: both platforms shipping at the same commit resolve the same `1.0.N` / `N`;
- the generated app and widget `Info.plist` for both platforms carry that pair;
- a platform-only update: the platform that does not ship keeps its committed release record;
- a delayed companion build: the later platform gets the later number, and the partner's record is untouched;
- a published floor at or above N refuses the ship instead of minting a replacement number;
- the shared planner agrees with what the two real scripts did.

The credential suites are offline too:  `test-asc-credentials.sh` drives `load_secrets` with a fake `fleet-secrets` and throwaway keys generated at test time, and `test-asc-key.test.mjs` generates its own key pair.  Neither commits a key, and neither reaches the network.

## Drift check

`check-version-policy.mjs` scans checked-in ship/release/publish sources and
checks the canonical selector for the AFC-356 pair. CI runs it without reading
the host-local runtime directory, so a missing `/Users/jay/apps/ios-fleet/`
cannot turn enforcement into a pass. It can also be given explicit checked-in
copy paths during a coordinated app integration:

```bash
node scripts/ios-fleet/check-version-policy.mjs path/to/app/ship-script.sh
```

`check-drift.sh` remains a local repo-to-runtime hash comparison. It does not
replace the checked-in policy guard. Run it locally with:

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

`.github/workflows/ios-appstore-gm.yml` takes a `marketing_version` input and
passes it to the ship script as `--version`. The selector validates that the
input equals the canonical release value before an archive can proceed.

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

