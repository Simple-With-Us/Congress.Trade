# 2026-10-05 — iOS Vitest guard: no hardcoded subscription prices

## Summary

PR #2619 keeps a repo-side regression test that forbids hardcoded US subscription
pricing and non–1-week free-trial copy in iOS Swift sources.  Product prices and
trial length must come from StoreKit (`Product.displayPrice` and introductory
offer metadata), aligned with the merged iOS implementation in PR #2620.

This slice does not change `PremiumSheet.swift` paywall UI on the branch; it
documents coordination and records the mandated verification commands for Kody
process review.

## Files changed

- `app/src/client/__tests__/iosNoHardcodedPrices.test.ts` — scans `clients/ios`
  Swift (excluding tests) for forbidden price/trial patterns; asserts
  `PremiumSheet.swift` uses `product.displayPrice` and dynamic headline helpers.
- `docs/EFFORT-LOG.md` — effort claim with pre-work coordination reference and
  verification outcomes.
- `docs/rollouts/2026-10-05-ios-no-hardcoded-prices-guard.md` — this record.

## Pre-work coordination

Per `AGENTS.md` / fleet `AGENT-SYNC.md`, substantial work should be claimed in
Slack `#agent-sync` (workspace channel `C0BEZDJDNKV`) with a first field
`repo: congress-trade`.

- **Product / implementation precedent:** merged PR #2620
  (`monitor/ct-storekit-localized-price`) — StoreKit localized pricing, no
  hardcoded amounts in iOS UI.
- **This enforcement PR:** #2619 (`antigravity/ios-remove-hardcoded-prices`).
- **Slack (#agent-sync, `C0BEZDJDNKV`):** Cursor Cloud posted 2026-10-05 —
  https://simplewithus.slack.com/archives/C0BEZDJDNKV/p1791188437791899
  (`repo: congress-trade`, `[Congress.Trade] CURSOR — PR #2619 Kody process
  closeout`).

## Verification

Commands run from `app/` on Cursor Cloud (Linux), branch
`antigravity/ios-remove-hardcoded-prices`, 2026-10-05.  Deno installed via
`scripts/cursor-cloud-setup.sh` (`~/.deno/bin` on `PATH`).

| Command | Outcome |
| --- | --- |
| `npm run lint` (`deno lint`) | **Exit 1** — 465 existing problems across 327 files (repo-wide; none in this PR's added test file). |
| `npx tsc --noEmit` | **Exit 1** — no `tsconfig.json` in `app/`; `tsc` prints usage (not a project compile). |
| `npm test` (`vitest run`) | **Exit 0** — 325 files, 4285 tests passed (includes `iosNoHardcodedPrices.test.ts`). |
| `npm run build` | **Exit 1** — script not defined in `app/package.json` (N/A for this Deno app; production build is Coolify Docker, not an npm build). |

Repo standard gate also run for receipt:

| Command | Outcome |
| --- | --- |
| `npm run typecheck` (`deno check src/deno/main.ts`) | **Exit 0** (post-setup). |

iOS compile / XCTest (`xcodebuild` on `macos-latest`) is **not runnable** in this
Linux cloud VM; unchanged iOS sources are covered indirectly by the Vitest guard
and by CI on PRs that touch `clients/ios/**`.

## Follow-ups

- None for merge/deploy on this docs+test slice (extra-ship no per owner).
- If `npm run build` is added to `package.json` later, re-run the four-command
  pipeline and update this rollout.
