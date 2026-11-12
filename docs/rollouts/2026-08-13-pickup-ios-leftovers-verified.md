# Pickup: iOS settings leftovers already on main

## Context & Objective

Owner asked Grok to pick up Monet/Claude leftovers after a quota cap.  One item was CT iOS settings (Sign in with Apple, Google branding, larger settings sheet, Trade Disclosure Alerts, CSV/upgrade/legal).  Verify current `main` before rewriting.

## Changes Made

Docs only.  No iOS or server code.

- `STATUS.md`
- `docs/EFFORT-LOG.md`
- this rollout note

## Decisions & Trade-offs

Verified on `origin/main` `b649778e` (post #1832/#1835/#1837/#1839):

- Sign in with Apple lives in `SignInPanel` with name+email scopes.
- Google button uses `.buttonStyle(.plain)` plus brand colors so Form tint cannot paint it all blue.
- Account hamburger is a full-height `.large` sheet, not the old 290pt popover.
- Toggle copy is "Trade Disclosure Alerts", not "Push Notifications (APNs)".
- Hamburger includes Export CSV, Premium/upgrade, and `LegalFooterLinks`.

Stay-funded and the fourth Cloudflare account are Usage Monitor work, not CT.

## Verification State

Read-only inspection of `clients/ios/CongressTrade/Views/Components/Components.swift` and `SettingsView.swift` on `b649778e`.  No compile run (no code change).

## Next Steps & Blockers

None for CT.  UM pickup is `grok/pickup-um-cf-accounts`.

## Zero-Code Findings

Nothing left to implement on the listed iOS leftovers.  Do not redo #1835 paywall/IAP or #1837/#1839 CI ship-trigger.
