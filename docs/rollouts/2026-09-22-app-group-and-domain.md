# 2026-09-22 — Congress.Trade iOS: App Group + Associated Domain additions (additive; bundle ID unchanged)

Issue raised on the macOS signing-cert change window, where the owner approved a fleet-wide bundle-ID migration so every app uses a domain Jay owns as its base.  This document covers **Congress.Trade only**; the rest of the fleet (BotFleet, Autorotate, ContactLogo, HogHunter, Socratic.Trade, Usage-Monitor, the MiniMax-ios companion) is on separate lanes owned by other seats.  The fleet-wide context lives in `/Users/jay/.minimax/sessions/mvs_0bdfe8c73c1046a986df888aa99dcb2e/workspace/fleet-bundle-id-plan.md`.

Congress.Trade is the **additive** lane of the fleet migration: the iOS bundle ID `trade.congress.ios` (and the tests bundle `trade.congress.ios.tests`) were already correct under the fleet `<trade>.<name>.<platform>` convention before the rename was approved, so this PR does not rename anything.  Two new capabilities are added in lockstep with the rest of the fleet: a new App Group `group.trade.congress` (for shared-container `UserDefaults` with any future extension that ships under this app) and a fresh Associated Domain entry `webcredentials:congress.trade` (the matching `applinks:congress.trade` was already live from PR #2370 on 2026-09-13, so only `webcredentials` is new today).  Both ride alongside the existing `aps-environment: production` + `com.apple.developer.applesignin: [Default]` entitlements, which are preserved verbatim.

## Previous → New

| Surface | Previous | New |
|---|---|---|
| iOS app (`CongressTrade` target) | `trade.congress.ios` | `trade.congress.ios` (unchanged — already on the fleet convention) |
| iOS unit tests (`CongressTradeTests`) | `trade.congress.ios.tests` | `trade.congress.ios.tests` (unchanged) |
| App Group (new) | — | `group.trade.congress` |
| Associated Domain — applinks (existing, preserved from PR #2370) | `applinks:congress.trade` | `applinks:congress.trade` (unchanged) |
| Associated Domain — webcredentials (new) | — | `webcredentials:congress.trade` |
| Sign in with Apple native audience | `[Default]` (no audience configured today) | `[Default]` (unchanged — Congress.Trade does not pin an explicit audience in the entitlements; the iOS bundle ID is the implicit one) |
| APNs topic (`apns-topic` header) | `trade.congress.ios` | `trade.congress.ios` (unchanged) |
| URL scheme (`congresstrade://`) | `congresstrade` | `congresstrade` (unchanged — internal scheme, not a bundle ID) |
| `CFBundleURLTypes[0].CFBundleURLName` | `trade.congress.ios` | `trade.congress.ios` (unchanged) |
| Team prefix | `CC8UTF7ATG` | `CC8UTF7ATG` (unchanged) |
| Keychain service strings (`trade.congress.session`, `trade.congress.appleDeviceEntitlement`) | unchanged | unchanged (internal namespaces — do not rename) |
| Internal sync cursor prefix (`trade.congress.sync.cursor.`) | unchanged | unchanged (internal namespace, NOT a bundle ID) |
| StoreKit product IDs (`trade.congress.premium.monthly`, `trade.congress.premium.annual`) | unchanged | unchanged (product IDs, NOT bundle IDs) |
| Log subsystem (`Logger(subsystem: "trade.congress.ios", …)`) | unchanged | unchanged (subsystem, NOT a bundle ID) |

## What changed in the repo

### iOS side

- `clients/ios/project.yml`:
  - Top-of-file migration callout `2026-09-22 bundle-ID migration (additive only — the iOS bundle ID is unchanged)` added to the file header, naming the new App Group + Associated Domain and the owner action items.
  - The existing comment `xcodegen REWRITES CongressTrade.entitlements from this block on every `xcodegen generate` … Keep both in sync.` is followed by a `2026-09-22 bundle-ID migration — added:` block describing what is new and why.
  - `options.bundleIdPrefix`: `trade.congress` (unchanged).
  - `CongressTrade` app target `PRODUCT_BUNDLE_IDENTIFIER`: `trade.congress.ios` (unchanged).
  - `CongressTradeTests` target `PRODUCT_BUNDLE_IDENTIFIER`: `trade.congress.ios.tests` (unchanged).
  - `CFBundleURLTypes[0].CFBundleURLName`: `trade.congress.ios` (unchanged).
  - `entitlements.properties.com.apple.developer.associated-domains`: existing `applinks:congress.trade` PRESERVED, plus added `webcredentials:congress.trade`.
  - `entitlements.properties.com.apple.security.application-groups`: added `group.trade.congress` (App Group — must be registered per App ID in the Apple Developer Portal before any shared-container `UserDefaults` writes work).
  - The existing `aps-environment: production` + `com.apple.developer.applesignin: [Default]` entitlements are PRESERVED verbatim.
- `clients/ios/CongressTrade.xcodeproj/project.pbxproj`:
  - **No change.**  `git diff origin/main -- clients/ios/CongressTrade.xcodeproj/project.pbxproj` returns empty for every `PRODUCT_BUNDLE_IDENTIFIER` line — the iOS bundle IDs are unchanged, so the project file is byte-identical (modulo the auto-regenerated `objectVersion = 100` rewrite `xcodegen-post.py` applies after `xcodegen generate`; that rewrite is a no-op when the file already has the post-fix value, which it does after the prior PR #2370 land).
- `clients/ios/CongressTrade/CongressTrade.entitlements`:
  - Existing `aps-environment: production` + `com.apple.developer.applesignin: [Default]` PRESERVED.
  - `com.apple.developer.associated-domains`: existing `applinks:congress.trade` PRESERVED, plus added `webcredentials:congress.trade`.
  - `com.apple.security.application-groups`: added `group.trade.congress`.
  - The file was regenerated by `xcodegen generate` from the updated `clients/ios/project.yml` source of truth (the entitlements file's own top-of-file comment says XcodeGen rewrites it on every regen, so keeping the source-of-truth and the file in lockstep is mandatory).

### Ship scripts (vendored `scripts/ios-fleet/`)

- `scripts/ios-fleet/apps.json`: Socratic entry `bundleId` updated.  The `worktreeHint`, `appleId`, `scheme`, and `projectRel` are unchanged; the lane keeps shipping from the same `~/apps/congress-trade-mm-bundle-rename` worktree the previous bundle ID used.

### Docs (active)

- `AGENTS.md`:
  - New top-of-file `> [!IMPORTANT]` callout dated 2026-09-22 pointing to this rollout doc and listing the new App Group + Associated Domain additions.
  - The pre-existing `Bundle ID` lines (line 420 and line 494) still read `trade.congress.ios`; no edit needed because the bundle ID is unchanged.
  - **New `Bundle identifiers (canonical table — 2026-09-22)` section** added between the iOS TestFlight ship section and the Fleet UI copy section, listing every renamed/un-renamed surface in one place (iOS app + tests bundle IDs, App Group, Associated Domain values, URL scheme, APNs topic, Keychain service strings, sync cursor prefix, StoreKit product IDs).
- `docs/EFFORT-LOG.md`: new dated `2026-09-22 — MM — IN PR — Add group.trade.congress App Group + webcredentials:congress.trade Associated Domain…` stanza at the top describing this rollout (branch, worktree, touched files, archaeology carve-out, owner action items, rollout doc pointer).  Pre-existing rows are preserved as historical record; none of them referenced the bundle ID in the `Work` column anyway — they describe PR-shaped work.

### Historical records preserved (no archaeology note needed)

- `docs/EFFORT-LOG.md` rows from prior sessions (`2026-09-05 — CLAUDE —`, `2026-09-08 — CLAUDE —`, `2026-09-18 — CLAUDE —`, `2026-09-21 — MM — IN PR #2536 —`, etc.) are preserved verbatim — the effort log is a chronological historical record and rewriting past entries to reflect present-day IDs would defeat its purpose.  The same pattern was used by the five prior fleet workers (BotFleet, HogHunter, Autorotate, ContactLogo, Socratic.Trade).
- `STATUS.md` and `CLAUDE.md` mention `trade.congress.ios` as the bundle ID in the iOS section — both are unchanged because the iOS bundle ID is unchanged.  `clients/ios/CLAUDE.md` `**Bundle ID:** \`trade.congress.ios\`` line stays as-is.

## Cross-repo files touched (not in this PR's diff)

- `~/Code/congress-trading-shared/` — separate lane, NOT touched.  Searched for `trade.congress.ios` in the shared library: only matches are the iOS-side bundle ID reference, not the consumer-facing surface (the shared library exposes TypeScript types and Deno server helpers, not Swift code).  No build break is expected from this additive entitlement change.
- `/Users/jay/Code/Congress.Trade/` — the human integration tree.  No edits; the worktree stays on `minimax/bundle-rename` and the owner merges through the PR.

## Owner action items

1. **Apple Developer Portal** — register the new App Group `group.trade.congress` on the existing explicit App ID `trade.congress.ios` (it must be registered per-App-ID for `UserDefaults` sharing + shared-container participation; do NOT add it on the test-bundle App ID `trade.congress.ios.tests` — tests run as a separate process and do not share a container with the app).  The Associated Domain capability `congress.trade` is **already** registered on this App ID — PR #2370 added `applinks:congress.trade` on 2026-09-13 and the Capability list in the Portal already covers the `webcredentials` service once the entitlement array lists `webcredentials:congress.trade`.  Verify the Portal shows the `webcredentials` checkbox enabled on the App ID; if not, enable it.  This PR does not have the credentials to do any of this.
2. **`congress.trade` DNS + AASA** — Jay already owns `congress.trade` (verified during the fleet plan; the domain resolves to the same Coolify/Cloudflare edge that hosts `https://congress.trade`).  Host the Apple App Site Association at `https://congress.trade/.well-known/apple-app-site-association`.  The AASA payload is already published by `app/.well-known/apple-app-site-association/route.ts` on the same domain for the `applinks:congress.trade` entitlement; the `webcredentials:congress.trade` entitlement validates against the same AASA `appIDs: ["CC8UTF7ATG.trade.congress.ios"]` claim.  Once the App Group is registered on the App ID and the AASA is reachable, both new entitlement entries will validate without a fresh cert, code-signing, or build cycle.
3. **Code-signing** — vendor-driven (the ship workflow imports the distribution cert on `macos-latest`; `scripts/ios-fleet/` doesn't touch certs).  After the cert swap, the build picks up the new entitlements via `xcodegen generate` → `clients/ios/CongressTrade.xcodeproj` without any further source change.  The `entitlements.properties` block in `project.yml` flows into the regenerated `.entitlements` file automatically, and `CODE_SIGN_ENTITLEMENTS: CongressTrade/CongressTrade.entitlements` wires it into the build settings.
4. **TestFlight re-upload** — vendor (hosted `ios-ship.yml` + `scripts/ios-ship-testflight.sh`).  No source change beyond this PR.  The ship script reads the bundle ID from `scripts/ios-fleet/apps.json`, which already lists `trade.congress.ios` — so the next upload lands on the same App Store Connect record the previous bundle ID used.  The App Group + Associated Domain changes ride along in the new archive without any ASC-side registration beyond owner step 1.
5. **No data migration needed** — user data lives under `~/Library/Containers/Group/...` only if the App Group is in use, and the App Group is brand new in this PR.  Existing `trade.congress.ios` sandbox containers under `~/Library/Containers/Data/Application/<UUID>/` are owned by the OS, not the bundle ID, so they persist regardless.
6. **Keychain service strings** — `trade.congress.session` and `trade.congress.appleDeviceEntitlement` are internal namespaces, NOT bundle IDs; they do not need to change.  Any future Keychain Sharing Group (added when the App Group becomes load-bearing) would mirror the App Group's prefix to keep `kSecAttrAccessGroup` clean.

## Verification

- `git grep -nE 'trade\.congress\.ios'` returns only the same set of hits `main` had before this PR (the iOS bundle ID is unchanged, so the same `scripts/ios-fleet/apps.json`, `clients/ios/project.yml`, `clients/ios/Info.plist`, `clients/ios/CLAUDE.md`, `AGENTS.md`, and `docs/EFFORT-LOG.md` mentions that already existed on `main` are still there — nothing was renamed).  New additions from this PR: `clients/ios/CongressTrade/CongressTrade.entitlements` (the `webcredentials:congress.trade` + `group.trade.congress` entries), `AGENTS.md` (the new `> [!IMPORTANT]` callout at the top + the new `Bundle identifiers (canonical table — 2026-09-22)` section), `docs/EFFORT-LOG.md` (the new dated stanza at the top), `docs/rollouts/2026-09-22-app-group-and-domain.md` (this file), and `clients/ios/project.yml` (the header migration callout + the new `entitlements.properties` entries).
- `git grep -nE 'group\.trade\.congress|webcredentials:congress\.trade'` returns: `clients/ios/project.yml` (×2), `clients/ios/CongressTrade/CongressTrade.entitlements` (×2), `AGENTS.md` (×4: dated callout + canonical table), `docs/EFFORT-LOG.md` (×3: the new dated stanza), and `docs/rollouts/2026-09-22-app-group-and-domain.md` (this file).  No accidental hits in any server / web / TypeScript file.
- `git diff origin/main..HEAD -- clients/ios/CongressTrade.xcodeproj/project.pbxproj` shows **no changes to PRODUCT_BUNDLE_IDENTIFIER values** — the four bundle ID entries (app + tests × Debug + Release) are byte-identical to `main`.  Acceptance criterion 1 met.
- `plutil -lint clients/ios/CongressTrade/CongressTrade.entitlements` clean — XML is well-formed; added a new `com.apple.security.application-groups` array and one `webcredentials:` entry under the existing `com.apple.developer.associated-domains` array; preserved the existing `applinks:congress.trade`.
- `xcodebuild -list -project 'clients/ios/CongressTrade.xcodeproj'` (after `xcodegen generate`) lists both targets (`CongressTrade` + `CongressTradeTests`) cleanly with both Debug + Release build configurations and the `CongressTrade` scheme.  The Sentry SPM package resolves cleanly (`Sentry: https://github.com/getsentry/sentry-cocoa.git @ 8.58.4`); CI runs the equivalent `ios-build` job on `macos-latest` and is the source of truth for the unsigned compile + 71-test suite.
- `clients/ios/CongressTrade/CongressTrade.entitlements` carries:
  - `aps-environment: production` (preserved)
  - `com.apple.developer.applesignin: [Default]` (preserved)
  - `com.apple.developer.associated-domains: [applinks:congress.trade, webcredentials:congress.trade]`
  - `com.apple.security.application-groups: [group.trade.congress]`
- `clients/ios/project.yml` entitlements block (which `xcodegen` rewrites the file from) carries the same four keys — verified by reading the regenerated `.entitlements` file post-`xcodegen generate`.
- `AGENTS.md` gains the new `Bundle identifiers (canonical table — 2026-09-22)` section and the top-of-file `> [!IMPORTANT]` callout pointing to this rollout doc.  Dated 2026-09-22.
- `docs/EFFORT-LOG.md` gains the new dated `2026-09-22 — MM — IN PR — Add group.trade.congress App Group + webcredentials:congress.trade Associated Domain…` row at the top of the table; prior rows are preserved as historical record.

## Out of scope

- Apple Developer Portal App ID + App Group + Associated Domain registration on `trade.congress.ios` (owner — see Owner Action Items §1).
- `congress.trade` AASA hosting on `https://congress.trade/.well-known/apple-app-site-association` (owner — see Owner Action Items §2).
- Code-signing cert refresh (vendor).
- TestFlight re-upload (vendor — see Owner Action Items §4).
- Keychain service strings (`trade.congress.session`, `trade.congress.appleDeviceEntitlement`) — internal namespaces, NOT bundle IDs (see Owner Action Items §6).
- Internal sync cursor prefix (`trade.congress.sync.cursor.`) and log subsystem (`com.congress.trade.ios`) — internal namespaces, NOT bundle IDs.
- StoreKit product IDs (`trade.congress.premium.monthly`, `trade.congress.premium.annual`) — product IDs, NOT bundle IDs.
- The iOS bundle ID itself (`trade.congress.ios`) — already correct, NOT renamed (this entire PR is additive).
- Renaming pre-rename prose in `docs/audits/*`, `docs/reviews/*`, and pre-rename `docs/rollouts/*` — historical record, preserved verbatim.
- Renaming prior `docs/EFFORT-LOG.md` rows — same rationale (chronological historical record).
- The `congress-trading-shared` library lane — separate task, zero references to `group.trade.congress` or `webcredentials:congress.trade`, no build break expected.
- Other fleet apps' bundle renames (BotFleet PR #524, Autorotate PR #245, ContactLogo PR #104, HogHunter PR #16, Socratic.Trade PR #3451 — already merged/armed, separate per-app PRs, separate seats).
