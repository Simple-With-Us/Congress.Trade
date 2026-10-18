# congress-trading-shared Effort Log — cross-agent board

> **ARCHIVED Sun, Oct 11, 2026.**  Linear is the system of record: team CTS, https://linear.app/simple-with-us/team/CTS.
> This file is read-only history.  Do not edit it or add rows.  See EFFORT-LOG-PROTOCOL.md.

Protocol: /Users/jay/apps/EFFORT-LOG-PROTOCOL.md (canonical). Live board: this file
(mirror: docs/EFFORT-LOG.md in the repo). As of 2026-08-20.

## In Progress
- (none)

## Completed
- **2026-10-10 - CLAUDE - Infisical prod-only (board `11df8f1b`, P2/S).**  Branch `claude/infisical-prod-only`.  `.cursor/infisical.env` now selects `prod`, `scripts/cursor-cloud-start.sh` refuses any other value, `INFISICAL.md` example uses `"prod"`.  Landed by the PR that adds this row.  Library `src/infisicalSettings.ts` deliberately untouched.  Note `docs/rollouts/2026-10-10-infisical-prod-only.md`.
- **2026-09-18 - CURSOR - Shared package hygiene for v2.7.0 (cross-app, P3/S).** Branch
  `cursor/shared-hygiene-2-7-0`, PR #305 (`00f3cfee`, squash-merged to `main`). Appended
  a `[2.7.0]` Keep-a-Changelog section in the file's existing format, between
  `[Unreleased]` and `[2.6.0]`; bullets cover only the actual commits between the
  v2.6.0 and v2.7.0 tags, grouped Added/Changed/Fixed. Companion action
  (Socratic.Trade lockfile resync) reported back as a no-op — the consumer's
  `package.json` already pins `github:jaywedgeworth22/congress-trading-shared#v2.7.0`
  and the lockfile already resolves to the published tag's peeled commit
  `5748e53` (which is tree-identical to the local-only `af11d70`); re-tinting the
  remote `v2.7.0` tag or pinning a commit in `package.json` would have violated
  the no-bump / no-tag-recreate constraints. Local main fast-forward was
  attempted against `origin/main` (which had diverged to a docs-only commit at
  `dfd259e` after the local `af11d70` v2.7.0 bump) and could not proceed
  without forcing/merging main; the PR was cut off the local v2.7.0 mark and
  `gh pr merge --squash --auto` landed cleanly once CI cleared. Parked follow-ups
  (CT `VENDOR-PROVENANCE.md` stale-line fix; vitest 5 + CJS/ESM configLoader
  warning) untouched per the brief.
- **2026-09-16 - CLAUDE - PLANNED - congress-trading-shared v2.7.0: CT vendor provenance commit does not match the actual v2.7.0 tag (immutable release appears to have moved).** <!-- wb-agent-report:bf0dc1147a33443b9e3badb8aace2826 -->
- **Restore Congress.Trade producer conformance to full shared read contracts (cross-app, P0/M).**
  Current Congress.Trade `origin/main` omits required `sharesOutstanding` from real SecurityRef
  responses, and scoped enrichment endpoints return nullable rows without the per-row ticker that
  the shared client promises. Keep `SecurityRef` as the full read-side shape; add safe client-side
  normalization where backward-compatible and route the producer mapping fix to the Congress.Trade
  owner without editing that consumer from this repository lane.
  **PARTIALLY STALE — 2026-07-19 CLAUDE re-audit:** the `sharesOutstanding` half is already neutralised on every normalized client path — `normalizeSecurityRef` (src/client.ts:59-63) backfills it to null and src/__tests__/client.test.ts:316-320 pins it, so `getRef`/`getRefs`/`getBundle` do NOT throw against the live producer (`mapSecurityRef`, Congress.Trade app/src/delivery/rest.ts:849-875, emits all 20 other required keys). STILL OPEN: (a) the scoped-enrichment half of this item was never audited; (b) `normalizeSecurityRef` is module-private and NOT re-exported from src/index.ts, so consumers calling `SecurityRefSchema.parse` directly are still unprotected — **RESOLVED 2026-07-19 by PR #203 (`bed364f`), released in v1.11.0: `normalizeSecurityRef` is now exported (no behaviour change, purely additive) with 4 regression tests incl. one proving direct-parse fails without it and succeeds with it**; (c) unverified value-level risks: `marketCapBucket` is passed through raw against a 6-value enum, and `currentPriceDate` must be `YYYY-MM-DD` — one bad row throws an entire `getRefs` batch of up to 500.
  @AG claimed: Tue, Sep 15, 2026 ~/apps/congress-trading-shared @ ag/planned-issues — PR #301 merged.
- **Consolidate drifted transaction and client/PWA read contracts (cross-app, P2/M).**
  Shared transaction schemas omit producer fields such as confidence/source/createdAt/cursorSeq and
  route-added chamber/memberName; `ClientTransactionSchema` omits emitted `estValue`, while the
  Congress PWA duplicates the full shape locally. Expand portable read contracts without weakening
  import schemas, then route producer typing/PWA adoption to Congress.Trade.
  @AG claimed: Tue, Sep 15, 2026 ~/apps/congress-trading-shared @ ag/planned-issues — PR #301 merged.
- **Choose a supported authenticated SSE subscription-provisioning flow (cross-app, P1/M).**
  Socratic.Trade auto-subscribe calls the shared client with no auth while Congress.Trade now requires
  an end-user session and ignores the posted `clientId`, so the advertised mode always gets HTTP 401.
  Keep credentials/auth enforcement app-local; coordinate removal of auto mode or a scoped M2M
  provisioning design, then update shared client docs/signature to match the chosen contract.
  Also expose the required per-subscription stream secret in `streamUrl` for EventSource callers;
  preserve the existing bearer-header path used by Socratic.Trade.
  **PARTIALLY STALE — 2026-07-19 CLAUDE re-audit:** the shared client is NOT authless (src/client.ts:99-105 sets `authorization: Bearer` when a token is configured). Nothing to fix inside this repo for the 401 itself; the defective call site is Socratic.Trade `src/lib/congress-stream.ts:77-84`. Remaining work is the cross-app decision only (drop auto-subscribe, or design a scoped M2M provisioning credential) plus the shared doc/signature update.
  @AG claimed: Tue, Sep 15, 2026 ~/apps/congress-trading-shared @ ag/planned-issues — PR #301 merged.
- **Make exact-pin drift checks tokenless, symmetric, and fail-closed (cross-app, P1/M).**
  Current consumer workflows either compare only package specs or require the retired package token,
  then skip on missing credentials/peer fetch errors. Both repos are public exact-tag consumers.
  Route a shared reusable lock-SHA/tag check that needs no package token and fails on peer drift.
  @AG claimed: Tue, Sep 15, 2026 ~/apps/congress-trading-shared @ ag/planned-issues — PR #301 merged.
- **Remove retired GitHub Packages auth from Congress.Trade cloud bootstrap (cross-app, P2/S).**
  Congress.Trade still appends registry credentials to `$HOME/.npmrc` and warns installs need a token,
  contradicting this package's public tokenless-Git policy. Consumer owner must delete the obsolete
  auth block and verify setup from a clean home; this lane remains read-only there.
  @AG claimed: Tue, Sep 15, 2026 ~/apps/congress-trading-shared @ ag/planned-issues — PR #301 merged.
- **Align analytics endpoint schemas with production rows (CODEX, P2/M).**
  Conviction/cluster/leaderboard/conflict schemas omit current metadata and reject legitimate
  nullable names/party values; raw client casts hide the drift. Add production-shaped optional or
  normalized fields and endpoint-envelope tests without inventing app runtime logic.
  @AG claimed: Tue, Sep 15, 2026 ~/apps/congress-trading-shared @ ag/planned-issues — PR #301 merged.
- **[congress-trading-shared][CURSOR] Cross-app coordination follow-ups (2026-08-20).**  Pointer only.  Socratic.Trade audit #2802 follow-ups are in ST PR #2941, Congress.Trade #2064, Usage-Monitor #1245.  Pins still CTS v2.5.2.  Pin-check is fail-closed but not a required merge check.  DealDex stays protocol-only / Vercel.  Branch `cursor/cross-app-coordination-followups`.
- **[congress-trading-shared][CURSOR] Retire leftover Deno Deploy current-shape in usage-telemetry-v2 rollout (2026-08-20).** COMPLETED. Docs-only. `docs/rollouts/2026-07-21-usage-telemetry-v2.md` now says Congress.Trade on Coolify. Dated history stays. No package API change. PR #275. Live Mac board needs reconciliation.
- **[congress-trading-shared][AG] ISO 8601 UTC date/time formatting contract (2026-07-24).** Adding `isIsoDateTime` and `toIsoUtcString` helpers to `src/utils.ts`, exporting `IsoDateTimeSchema` in `src/schemas.ts`, and releasing `v2.3.0`. Branch `ag/iso-8601-utc-datetime-formatting`.
- **[congress-trading-shared][GROK] Fast-forward local main after Mac-storage prune — COMPLETED 2026-08-15.**  Discarded stale In-Progress row for already-merged #260/#262.  `git pull --ff-only` `c1f6787` → `88c72b3`.  0 open PRs.

## Deployed
- **[congress-trading-shared][CURSOR] tickerLogoPolicy A/B/C/D seed (v2.6.0) (2026-08-23).** Pure `sourceOrderFor` + 2026-08-23 top-30 map. KV/jury stay in Congress.Trade. Branch `cursor/ticker-logo-policy`.
- **[congress-trading-shared][CURSOR] v2.3.0 — DEPLOYED 2026-07-24.** PR #247 merged. `isIsoDateTime` and `toIsoUtcString` date-time helpers + `IsoDateTimeSchema`. 443 tests passing. Tag `v2.3.0` pushed.
- **[congress-trading-shared][AG] v2.2.0 — RELEASED 2026-07-23.** PR #242 merged into `main`. Added Usage Monitor route constants (`/api/health`, `/api/ready`), producer & provider schemas/types, and pure `createUsageTelemetryV2Event` helper; updated `publint` to `^0.3.22`. 434 tests passing. Tag `v2.2.0` pushed.
- **[congress-trading-shared][CURSOR] v2.1.0 — 2026-07-22.** PR #222 merged; tagged v2.1.0. `normalizeCompanyName()` with state-suffix stripping. Self-hosted CI re-enabled; runner has publint temp-dir issue (all code steps pass). Socratic.Trade upgraded v1.11.1→v2.1.0. 6 origin + 7 local stale branches deleted.
- **v1.8.0 — 2026-07-15 (MONET, CLAUDE→MONET handoff tail, S).** Released `v1.8.0` (annotated tag → `2b13da0`): adds `"executive"` to `ChamberSchema` for OGE 278-T presidential filers; all chamber-typed fields inherit; additive-only over v1.7.1. PR #190 (CLAUDE-authored, MONET-landed): un-drafted + squash-merged after the AGENTS.md tokenless git-install smoke passed on both branch head `95492c9` and final main `2b13da0` (dist builds via prepare, installed version 1.8.0, `ChamberSchema.safeParse("executive")` success; npm 11 emitted an advisory allowScripts warning only — non-blocking). Coordinated same-day consumer bumps: Congress.Trade PR #457 (`f1df035`; also retires the app-local `Chamber` widening) and Socratic.Trade PR #1641; cross-repo Shared-package-pin-check dispatched on CT main afterward: SUCCESS (both consumers resolve `2b13da0`).
- **Portable operation-guard rejection contract v1.5.0 (AG implementation, CODEX release coordination, owner-directed, S) — DEPLOYED 2026-07-11.**
  Shared Zod/TypeScript builders and status mapping now define stable `rate_limited` (HTTP 429)
  and `operation_in_flight` (HTTP 409) rejections while enforcement and HTTP adapters remain
  app-local. PR #144 merged as `2222baeb`; release-hygiene PR #146 merged as `7a8dca7c` with green
  main CI. Lightweight tag `v1.5.0` resolves to the contract commit `2222baeb`. Clean tokenless
  HTTPS installs from both the merge SHA and tag report package 1.5.0 and pass CJS+ESM
  builder/status smoke. The tag appeared concurrently during CODEX coordination and was preserved
  at the correct contract commit; no force-retag and no registry publish. Socratic.Trade #1409 owns
  the consumer adoption.
- **v1.4.1 — 2026-07-06 (AG).** Released `v1.4.1` (tag `v1.4.1` pushed) containing:
  - Renamed remaining "Agentic Trading" references to "Socratic Trade" (PR #119).
  - Added Zod schemas for AmountBracket, Subscription, and SseMessage (PR #119).
  - Expanded client.ts and SseParser test coverage to 337 tests (PR #119).
  - Refined AmountBracketSchema to reject inverted bounds (PR #119).
  - Fixed TypeScript 6.0.3 and Zod v4 compatibility issues in tsup/schemas (PR #119).
- **v1.4.0 — 2026-07-06 (AG).** Released `v1.4.0` (tag `v1.4.0` pushed) containing:
  - Unified ticker normalizer regex & preferred/depositary helper functions (PR #97).
  - Relocated STOCK Act AmountBracket definitions & snapping/matching helpers (PR #97).
  - Aligned Zod schemas for ClientAsset and ClientTrade with production API outputs (PR #98).
  - Vitest CI test suite execution with strict code coverage minimum thresholds (PR #96).
  - Tokenless smoke-install verification job in CI (PR #96).
  - Corrected docs/RELEASE.md consumer notification list (PR #96).
- **v1.3.3 — 2026-07-06 (AG).** Released `v1.3.3` (tag `v1.3.3` pushed) containing the merged release stack:
  - CongressTradeClient + SUBSCRIPTIONS API path (PR #55)
  - balance/limit metricTypes (PR #56)
  - createCongressEvent helper and type dedup (PR #57)
  - Dependabot + weekly CI audit (PR #54)
- **v1.3.0 — 2026-07-05 (MONET).** `TICKER_ALIASES` rename-vs-acquisition split DEPLOYED: PR #53
  merged to `main` (`4c35df2`) + tag `v1.3.0` pushed. Coordinated release train — MONET split +
  CURSOR's stranded stack (237 tests, CHANGELOG/RELEASE, engines.node, publish.yml decommission,
  authorship intact) + release-hygiene commit (dropped dormant `publishConfig.registry` + stale
  `publish:dry`). Verified: CI green, 3-lens release-readiness workflow, tokenless git-install from
  `#v1.3.0` builds `dist/` via prepare + imports (CJS+ESM). Mirror recorded via PR #58. Follow-ups
  (cross-repo/owner-gated): consumer pin bumps + AG consumer migration. The stale In-Progress
  cursor "DONE-local-unpushed" rows all landed in PR #53 — for the next-wave board-owner to
  reconcile against issue keys (#17/#18/#21/#22/#23/#39).
- (n/a for pre-1.3.0 — library package; "deployed" = version published/consumed by apps)

## Completed
- **[congress-trading-shared][GROK] Land open PR queue — COMPLETED 2026-08-12.** Squash-merged #262 (`976e73e`, claude-code-action 1.0.183→1.0.187) after update-branch; prior verify fail was the pre-existing nanoid audit, already fixed on main (3.3.18). Squash-merged #260 (`ebe1f95`, Codex Cloud coordination) after update-branch + review fixes (`d5d923d`: Slack `ok:true` check, `[Congress-Trading-Shared]` post tag, project-filtered reads). No open PRs remain.
- **[congress-trading-shared][CODEX] Codex Cloud protocol bootstrap — COMPLETED 2026-08-12 GROK land.** PR #260 merged as `ebe1f95`. Repo-local `.codex/setup.sh` / `.codex/maintenance.sh`, `scripts/codex-coordination.sh`, and Apple Notes cloud handoff. Review threads resolved before merge.
- **[congress-trading-shared][CURSOR] Cross-app deploy — all issues closed 2026-07-27.** All 9 remaining open issues (#163, #164, #165, #166, #168, #171, #237, #248, #40) closed. Congress.Trade PR #974 merged (shared dep consumer updates). Socratic.Trade PR #2234 auto-merged (SSE auth fix). Shared repo fast-forwarded to latest main (v2.3.0). Usage-Monitor already current. All effort logs synced across live boards and mirrors.
- **Align TypeScript map settings with the published artifact (CODEX, P3/S) — RESOLVED 2026-07-23 CURSOR.**
  `tsconfig.json` does NOT enable `sourceMap` or `declarationMap`, and tsup emits no `.map` files.
  The issue is moot — the compiler settings and artifact are already aligned. GitHub issues #180/#240 closed.
- **Correct the filing-lag overflow bucket boundary (CODEX, P2/S) — RESOLVED 2026-07-23 CURSOR.**
  `LAG_BUCKETS` `{label:"46-60d", max:60}` changed to `{label:"46-59d", max:59}` in PR #238 so day 60 correctly lands in `60d+`. GitHub issues #181/#241 closed. Consumer note: Congress.Trade has vendored references to `46-60d` in analytics tests.
- **[congress-trading-shared][CODEX] Usage telemetry contract v2 authority — 2026-07-21.** PR #219 merged as `19a77a`; tagged `v2.0.0`. V2-only producer/event envelope with explicit provider-account identity and canonical SHA-256 idempotency.
- **[congress-trading-shared][CLAUDE] Self-hosted CI activation — 2026-07-23 CURSOR triage.** CI is live on Hetzner shared-ci runner (PRs #222/#224). Runner has minor `/var/tmp/gh-runner/` temp-dir issue (publint step fails; all code steps pass).
- **[congress-trading-shared][CLAUDE] Call-classifier contract — 2026-07-19.** PR #197 MERGED to main as `904ea96`, tagged `v1.10.0`.
- **[congress-trading-shared][CODEX] Reusable Autofix owned-runner input — 2026-07-18.** Superseded / no code. Adversarial review found unsafe to route onto production-adjacent CI runner; Congress.Trade disables Autofix until a dedicated ephemeral runner exists.
- **[congress-trading-shared][CODEX/CURSOR] Fleet PR/branch/worktree reconciliation — 2026-07-22 CURSOR triage.** Completed as part of comprehensive repo audit. Deleted 6 stale origin branches + 7 local branches, pruned Claude worktree.
- **[congress-trading-shared][CODEX] Whole-package shared dependency audit — 2026-07-23 CURSOR triage.** Superseded by multiple subsequent audits (CLAUDE 2026-07-19 adversarial multi-agent audit, CURSOR 2026-07-22 comprehensive repo audit).
- **[congress-trading-shared][CODEX/CLAUDE] Conditional declarations + Node type floor — 2026-07-19.** RESOLVED by CLAUDE — PR #200 merged, `@types/node` re-pinned to ^20.19.9.
- **[congress-trading-shared][CURSOR] Cross-app shared-dep proper-usage audit — 2026-07-23 CURSOR triage.** Subsumed by v2.0.0/v2.1.0 releases. All consumers now on v2.0.0+.
- **[congress-trading-shared][CURSOR] Effort state reconciliation — 2026-07-23 CURSOR triage.** Completed as part of this triage pass. Live board and mirror reconciled, stale issues closed.
- **[congress-trading-shared][CURSOR] Comprehensive repo audit + agent work incorporation — 2026-07-22.** PR #222 merged; v2.1.0 tagged. Landed `normalizeCompanyName()` + state-suffix stripping (197 lines, 6 tests, 853 total). Self-hosted CI re-enabled. Socratic.Trade upgraded v1.11.1→v2.1.0. 6 origin + 7 local stale branches deleted.
- **Resolve the dual-Zod public-schema boundary (AG, S) — COMPLETED 2026-07-20.**
  Moved `zod` to `peerDependencies` (and added to `devDependencies`) to prevent future runtime
  nesting/duplicate instances at consumer boundaries. Verified by running local verification
  suite passing cleanly.
- **[congress-trading-shared][CLAUDE] Release v1.11.0 — 2026-07-19 — SHIPPED.** Tag `v1.11.0` = `7d463c3` (PR #204). SemVer MINOR (adds a public export). Contents: PR #203 `bed364f` exports `normalizeSecurityRef` for direct-parse consumers (closes the direct-parse half of the P0 producer-conformance item); PR #200 `6a9d05f` re-pins `@types/node` to the Node 20 floor matching `engines.node` + adds a Dependabot semver-major ignore guard (dev-only, no consumer impact). All three PRs merged with 5/5 checks green; gate on each = typecheck + build (d.ts & d.mts) + publint `All good!` + full vitest (423/423 at #203). CHANGELOG link-reference drift also repaired: `[Unreleased]` had been comparing from v1.8.0 and 1.10.0 had a section with no link ref. STILL OUTSTANDING (routed, not invented): tags `v1.9.0`, `v1.8.3`, `v1.8.2`, `v1.8.1` exist with **no CHANGELOG section and no link ref** — contents deliberately NOT reconstructed since this lane cannot verify them; belongs to the "Repair released-package metadata drift" item.
- **Read-only clean-install artifact regression audit across v1.6.0/v1.7.0/v1.7.1 (CODEX, P1/S) — completed 2026-07-14.**
  Node 24.18.0/npm 11.16.0 disposable installs proved exact `v1.6.0`/`c4fcfb4`,
  `v1.7.0`/`c383673`, and `v1.7.1`/`0bc26ab` each run `prepare` and install
  `index.js`, `index.mjs`, `index.d.ts`, and `index.d.mts`; CJS and ESM imports passed. A fresh
  clone of Socratic.Trade `main` (`acd67a5`) also completed `npm ci` and loaded 103 exports from
  v1.6.0. Exact-commit hosted verify runs `29172352544`, `29187935917`, and `29356284507` passed
  tests, build, publint, audit/signatures, pack dry-run, and tokenless Git-install smoke. The
  declarations-only tree was interrupted/local install state, not a broken release object; a
  fresh disposable cache repaired it. Consumer follow-up: adopt immutable `v1.7.1`, regenerate
  lockfiles to `0bc26ab`, and align `allowScripts` to that SHA. Congress `app/package.json`
  currently has a stale `c383673` allow entry while installing `c4fcfb4`; no repos were edited.
- **Protect immutable release tags and enable repository-native security controls (CODEX, P1/M).**
  Active no-bypass tag ruleset `18817304` forbids updates/deletions of `refs/tags/v*` while allowing
  new releases. Enabled Dependabot alerts/security updates, provider secret scanning and push
  protection, plus CodeQL default setup for TypeScript/JavaScript and Python; initial CodeQL run
  `29171961494` completed successfully. Advanced non-provider/validity scanning remains unavailable.
- **Correct stale GitHub repository identity metadata (CODEX, S) — completed 2026-07-11.**
  Repository description still named Agentic Trading after the product rename. Updated the live
  GitHub description to Congress.Trade ↔ Socratic Trade through the repository API.
- **LICENSE decision for the now-public repo (AG, S) — COMPLETED 2026-07-11.**
  Added MIT License and updated `package.json` license field.
- **Enable a required-status-check ruleset on main gating on the CI verify job (AG, S) — COMPLETED 2026-07-11.**
  Created a `main-protection` ruleset via GitHub API mirroring the Socratic.Trade pattern.
  Blocked deletion and non-fast-forward pushes.
  Required Pull Requests for `main`.
  Required the `verify` status check to pass.
  2026-07-11 hardening: require the branch to be current before `verify`, require review-thread
  resolution, enforce the same strict check in classic branch protection, and retain zero bypasses.
- **Codex autofix reusable workflow: migrate from Anthropic to DeepSeek (MONET, S)** —
  COMPLETED 2026-07-10. Merged PR
  [#140](https://github.com/jaywedgeworth22/congress-trading-shared/pull/140) (`f01bae3`) +
  docs follow-up [#142](https://github.com/jaywedgeworth22/congress-trading-shared/pull/142).
  The Anthropic key funding the shared Codex autofix workflow was deleted, breaking the loop for
  every caller repo. Renamed the required `workflow_call` secret `ANTHROPIC_API_KEY` →
  `DEEPSEEK_API_KEY` (`GH_PAT` stays optional) and pointed `anthropics/claude-code-action@v1` at
  DeepSeek's Anthropic-compatible endpoint via `env.ANTHROPIC_BASE_URL` / `_AUTH_TOKEN` /
  `_MODEL=deepseek-v4-flash` / `_SMALL_FAST_MODEL`. Codex review caught a real regression: the
  action's buffered-inline-comment classifier hardcodes `https://api.anthropic.com`, ignoring
  `ANTHROPIC_BASE_URL` — with a DeepSeek key it would 401 and fall back to posting every
  buffered comment unfiltered. Verified against the action's actual source before fixing;
  resolved via `classify_inline_comments: "false"` rather than trusting a classifier that can't
  authenticate. Companion caller-side PR
  [Congress.Trade#258](https://github.com/jaywedgeworth22/Congress.Trade/pull/258) merged and
  deployed to prod (health-checked OK). If DeepSeek returns "model not found", swap
  `deepseek-v4-flash` → `deepseek-chat`.
- **Resolve shared Copilot review findings from PR #125 (CODEX, S) — started 2026-07-08.**
  PR #137 merged to `main`, resolving the four still-active Copilot review threads from merged
  PR #125. Patched `scripts/slack-sync.sh`, `.codex/maintenance.sh`, and
  `.github/workflows/codex-autofix-reusable.yml`. Verified shell syntax, workflow YAML,
  no-token maintenance/helper behavior, `npm ci`, `npm run typecheck`, `npm test` (337 passed),
  `npm run build`, and `git diff --check`.

### Historical state reconciliation — 2026-07-11

The following first lines are repeated unchanged so legacy issue keys resolve to a terminal section.
Original rows remain in place for provenance; the mirror de-duplicates by key and uses this earlier
Completed occurrence.

- **Consolidate usage telemetry clients in both consumer apps (CURSOR, M) — started 2026-07-06, completed 2026-07-06.**
  Reconciled from stale In Progress; consumer receipts remain on the original row.
- **Retire duplicate API client fetchers and stream parser in Socratic.Trade (CURSOR, M) — started 2026-07-06.**
  Reconciled from stale In Progress; completed receipt already exists above.
- **Import snapshot/export types in Congress.Trade (CURSOR, S) — started 2026-07-06.**
  Reconciled from stale In Progress; completed receipt already exists above.
- **✅ DEPLOYED 2026-07-05 as v1.3.0 (PR #53 merged `4c35df2` + tag `v1.3.0`) — see the Deployed
  section at top.**
  Reconciled from stale In Progress; the canonical release receipt remains in Deployed.
- **Split `TICKER_ALIASES` into rename-vs-acquisition classes — SHARED-LIBRARY PORTION (MONET,
  shared-package lane).**
  Reconciled from stale In Progress; shared portion shipped in v1.3.0.
- Codex global coordination + fleet monitoring setup (Codex, shared `/Users/jay/apps`
  infra) — landed in the standardized fleet bootstrap.
  Reconciled from stale In Progress; landed in commit `2a754b5`.
- ~~**Repair the stale Mac clone `main` (CLAUDE, S)** — local `main` diverged (7 dead WIP commits,
  then was salvage-checked and fast-forwarded.**~~
  Reconciled from stale Planned; the completed repair receipt remains above.
- ~~**Add npm test to the CI verify job in ci.yml (CURSOR, S)**~~ — _Moved to Completed 2026-07-06._
- **Run the v1.3.0 release train: land cursor stack, land monet split, tag, bump consumers
  (OWNER, M) — completed.**
  Reconciled from stale Planned; v1.3.0 was tagged and adopted.
- ~~**Add a tokenless git-install smoke job to CI (pack + install + CJS/ESM import) (CODEX, S)**~~ — _Moved to Completed 2026-07-06._
- ~~**Add vitest coverage reporting with a minimum-threshold gate (CURSOR, S)**~~ — _Moved to Completed 2026-07-06._
- ~~**Prune merged claude/* branches on origin (CURSOR, S)**~~ — _Moved to Completed 2026-07-06._
- ~~**Delete origin/cursor after confirming ahead=0 (merged via v1.3.0, no PR) (CURSOR, S)**~~ — _Moved to Completed 2026-07-06._
- ~~**Correct docs/RELEASE.md consumer list (api-usage-monitor is not a consumer) (CURSOR, S)**~~ — _Moved to Completed 2026-07-06._
- ~~**Unify ticker normalization regex and preferred/depositary symbol helpers (unassigned, S)**~~ — _Moved to Completed 2026-07-06._
- ~~**Move STOCK Act amount bracket array and snapping/validation helpers to shared (unassigned, S)**~~ — _Moved to Completed 2026-07-06._
- **Consolidate usage telemetry clients in both consumer apps (unassigned, M)** —
  Reconciled from stale Planned; the completed implementation receipt remains above.
- **Retire duplicate API client fetchers and stream parser in Socratic.Trade (unassigned, M)** —
  Reconciled from stale Planned; the completed implementation receipt remains above.
- **Import snapshot/export types in Congress.Trade (unassigned, S)** —
  Reconciled from stale Planned; the completed implementation receipt remains above.
- ~~**Rebase the 4 open AG PRs onto current main to clear the docs/EFFORT-LOG.md-only conflict and land them (AG, S)**~~ — _Moved to Completed 2026-07-06._
- ~~**Fix misleading commit message on ag/client-and-ticker 81b2fd3 (ticker work came from v1.3.0 base, not this branch) (AG, S)**~~ — _Moved to Completed 2026-07-06._

- **Retire duplicate API client + stream parser in Socratic.Trade (CURSOR, M) — 2026-07-06.**
  Replaced local `getJson` wrapper + manual URL construction in `congress-trade-client.ts` and
  local `SseParser` class in `congress-stream.ts` with `CongressTradeClient` and `SseParser` from
  shared package. Preserved all business logic (feature gates, health logging, timeouts, symbol
  normalization, stream management). Bumped shared dep v1.3.3 → v1.4.1. 62 tests, tsc clean.
  Branch: `cursor/retire-client-dups`.
- **Codex autofix storm guard (CODEX/AG) — 2026-07-06.** Landed trigger guard instructions inside `.github/workflows/codex-autofix-reusable.yml` instructing calling workflows to only run on pull_request_review:submitted and workflow_dispatch to avoid comment fanning. Branch: `main` (commit `2a754b5`).
- **Codex Cloud Slack + effort-log readiness across all four apps (CODEX/AG) — 2026-07-06.** Landed setup and maintenance configuration (`.codex/setup.sh`, `.codex/maintenance.sh`), Slack synchronization helper (`scripts/slack-sync.sh`), and updated `AGENTS.md` instructions. Branch: `main` (commit `2a754b5`).
- **Import snapshot/export types in Congress.Trade from shared package (CURSOR, S) — 2026-07-06.**
  Replaced local `SnapshotTableInfo` and `SnapshotManifest` interfaces in `app/src/export/snapshot.ts`
  and `app/src/export/routes.ts` with imports from `@jaywedgeworth22/congress-trading-shared`.
  Branch: `cursor/snapshot-types` (commit `5e58ea9`). Verified: typecheck clean, 672 tests pass.
- **Rename remaining 7 "Agentic Trading" references → "Socratic Trade" (CURSOR, S) — 2026-07-06.**
  Updated package.json, AGENTS.md, README.md, CHANGELOG.md, docs/RELEASE.md, and
  .github/workflows/codex-autofix-reusable.yml. All references now say "Socratic Trade"
  or "Socratic.Trade". Branch: `main` (commit `836b935`).
- **Add Zod schemas for AmountBracket, Subscription, SseMessage (CURSOR, S) — 2026-07-06.**
  Added `AmountBracketSchema`, `SubscriptionSchema`, `SseMessageSchema` to schemas.ts.
  Matches the established pattern of providing runtime validation alongside types.
  Exported via barrel. Branch: `main` (commit `836b935`).
- **Expand client.ts test coverage from 17 to 113 tests (CURSOR, M) — 2026-07-06.**
  Added comprehensive tests for createSubscription (POST, secret handling, errors),
  getBundle/prices/spx/fundamentals/analyst (with opts, null handling), all analytics
  endpoints (ticker leaderboard, cluster buys, member leaderboard, member performance,
  conviction, backtest, conflicts), error paths, empty array/null guards. SseParser
  expanded from 3 to 11 tests (multi-line data, partial chunks, CRLF, field ordering,
  multi-event dispatch, comments). Total: 332 tests passing. Branch: `main` (commit
  `836b935`).
- **Unify ticker normalization regex and preferred/depositary symbol helpers (AG, S) — 2026-07-06.** Unified WELL_FORMED_TICKER pattern with caret support and moved helpers to shared package. Merged via PR #97 (`27d253b`).
- **Move STOCK Act amount bracket array and snapping/validation helpers to shared (AG, S) — 2026-07-06.** Migrated STOCK_ACT_BRACKETS array and matchBracket/isValidBracket/nearestBracket helpers to shared. Merged via PR #97 (`27d253b`).
- **Align ClientAsset and ClientTrade schemas with actual production API outputs (AG, S) — 2026-07-06.** Added missing API fields to ClientAssetSchema and extended source validation in ClientTradeSchema. Merged via PR #98 (`f24b0e6`).
- **Add npm test and vitest coverage threshold gates to CI (AG, S) — 2026-07-06.** Configured coverage gates and added automated verify step to GHA. Merged via PR #96 (`2dcee40`).
- **Add a tokenless smoke install verify job to CI (AG, S) — 2026-07-06.** Added smoke-install job to GHA to test clean build-on-install capability. Merged via PR #96 (`2dcee40`).
- **Correct docs/RELEASE.md consumer list & document pin split (AG, S) — 2026-07-06.** Cleaned up notification targets and added tag-vs-semver note. Merged via PR #96 (`2dcee40`).
- **Centralize Event Building (AG, S) — 2026-07-06.** Created/exported a `createCongressEvent` helper and deduplicated types in `constants.ts`. Merged via PR #57 (`b722e89`).
- **PR #55 `ag/client-and-ticker` — CongressTradeClient + SUBSCRIPTIONS API path (AG, S) — 2026-07-06.** Merged to `main` (`1a6cea4`).
- **PR #56 `ag/update-metric-types` — add balance/limit UsageTelemetry metric types (AG, S) — 2026-07-06.** Merged to `main` (`cbd2078`).
- **PR #54 `ag/dependency-vulnerability-automation` — Dependabot + weekly CI cron (AG, S) — 2026-07-06.** Merged to `main` (`2d5a35c`).
- **Re-verify the Socratic.Trade guard site cited by the consumer-migration row (AG, S) — 2026-07-05.** Located the unlanded `ACQUISITION_SOURCES = new Set(["ATVI", "TWX", "RHT"])` and `canonicalMarketDataSymbol` helper on Socratic.Trade's remote branch `origin/claude/elastic-rosalind-a2a48a` (commit `ded312c9fbd78627ee14047128730658fdde76ba`). Confirmed they do not exist on `main` yet, which is why grep failed. Verified the migration plan to use the new shared `classifyTickerAlias` and `resolveContinuousTicker` utilities once the release train lands. Branch `ag/reverify-socratic-guard`.
- **Repair the stale Mac clone `main` (CLAUDE) — 2026-07-05.** Salvage-check verified all 7
  local-only commits SUBSUMED by `origin/main` before the move (2 independent lenses + adversarial
  verify, 4-agent workflow): all 5 non-merge commits patch-equivalent upstream (`git cherry`/
  `range-diff` all `=`), both PR merges byte-identical trees (`git diff a33dfd3 0dcd258` and
  `115fdff ab31ea7` empty), and main's tip TREE OBJECT (`6d02ff65…`) identical to origin-ancestor
  `5b2a6fa` — i.e. local main's entire tree already exists inside origin/main's history; v1.2.0
  strictly supersedes the 1.1.1 line. Applied `git branch -f main origin/main` (main was not
  checked out in any worktree); now 0/0 divergence, tracking origin/main. Nothing salvaged because
  nothing was unique; pre-move tip `f06fd71` recoverable via reflog.
  _2026-07-05 (CLAUDE next-wave): re-verified independently this cycle — `git rev-parse main` and
  `git rev-parse origin/main` are identical (`071a17d`) and `main` is still not checked out in any
  worktree. Confirms this row is correctly Completed; no further action needed here._
- **CI standard adoption blocker check (CLAUDE) — 2026-07-05.** Verdict: blocker NOT cleared, and
  it MOVED: `claude/ci-actions-efficiency` DID land in the Socratic.Trade hub but produced only an
  in-repo docs-only fast path — no reusable `workflow_call` verify gate exists for consumers to
  call. Real dependency now: Socratic.Trade PR #372 (`claude/ci-hybrid-runner-verify`, open) +
  a not-yet-scoped follow-on to build the reusable entry point once #372 proves itself. Reserved
  caller-workflow row below updated accordingly; stays blocked.
  _2026-07-05 (CLAUDE next-wave): re-verified this cycle — the blocker check is now definitively
  answerable and this In Progress row can be CLOSED. Confirmed `claude/ci-hybrid-runner-verify`
  does not exist on Socratic.Trade's origin and no reusable verify-gate workflow is on its `main`
  (only the #370 docs-fast-path efficiency change landed there). Result: 'still blocked' — see the
  Planned/Reserved row below, corrected with this verified status and date._
- **Shared agent-sync WebSocket relay verification (CODEX, shared `/Users/jay/apps` infra) —
  2026-07-05.** Verified PM2 `agent-sync-push` is online, connected to Slack Socket Mode using
  `SLACK_SYNC_WEBSOCKET`, and fanning out to local consumers on `ws://127.0.0.1:8787`; verified
  PM2 `agent-sync-codex` is attached as this seat's private-cursor consumer. Stopped the temporary
  direct Socket Mode watcher and corrected the canonical protocol entrypoint from stale `run.sh`
  to installed `start.sh`. No package code changed.
- ~~**Test coverage for `schemas.ts` / `utils.ts` / `constants.ts` + SecurityRef subset-consistency guardrail (CURSOR) — 2026-07-05.** 237 tests across 5 files (4 new + 1 existing `usageTelemetry`), zero failures. Covers all 37 exported Zod schemas, 7 utility functions (`normalizeTicker`, `resolveTickerAlias`, `marketCapBucket`, `bracketMidpoint`, `isIsoDate`, `daysBetween`, `mergeRefs`), all constants (`TICKER_ALIASES`, `MKT_CAP_THRESHOLDS`, `API_PATHS`, `WINDOW_PRESETS`, `LAG_BUCKETS`), and `parseArray`/`parseSafe` helpers. SecurityRef guardrail verifies `SecurityRefInputSchema` keys are a true subset of `SecurityRefSchema`. Branch: `cursor`. Mid-tier subagent.~~
  _2026-07-05 (CLAUDE next-wave): stale — this is NOT Completed per protocol (Completed = merged
  to main). Commit `6300b89` exists only on the local `cursor` branch; `origin/cursor` is 5 commits
  behind and no PR is open, so `origin/main` has none of it. Moved to In Progress as
  DONE-local-unpushed below; needs push of the `cursor` branch + PR + merge. Issues #17/#18 stay
  open until it lands._
- **Global agent policy alignment and workspace sync (AG) — 2026-07-05.** Verified global config files (Gemini/Antigravity, Claude, Codex, and Cursor rules) are fully aligned with the latest efforts log, Slack WebSocket collab, and v4-pro model tiering protocols. Reset the local workspace `cursor` branch to `origin/main` to sync the latest `docs/EFFORT-LOG.md` and inter-agent coordination stanza.
- ~~**Mechanical repo maintenance batch (CURSOR, S) — 2026-07-05.** Completed on `cursor` branch:
  deleted stale origin branches (`codex/package-git-prepare-20260629`, `codex/package-prepare-and-ci`),
  decommissioned `.github/workflows/publish.yml` and `publish:dry` script, added `engines.node >=20.0.0`
  to `package.json`, created `CHANGELOG.md` and `docs/RELEASE.md`.~~
  _2026-07-05 (CLAUDE next-wave): stale/split — only the stale-branch deletion actually happened on
  origin (both `codex/*` branches are confirmed gone); that part stays Completed. The other four
  changes (publish.yml decommission `eaea090`, engines.node `4aad70f`, CHANGELOG.md + docs/RELEASE.md
  `13137be`) are local-only on `cursor` — `publish.yml` still exists on `origin/main` today. Moved
  those four to In Progress as DONE-local-unpushed, same landing train as the test-coverage row
  above. Issues #21/#22/#23 stay open until merge._
- **PR #27 - Effort-issues sync secondary-rate-limit hardening (CLAUDE).** Merged to `main`
  2026-07-05. Verbatim propagation of the fleet-standard `scripts/sync-effort-issues.py`
  hardening from Socratic.Trade PR #694: creation throttle, Retry-After/backoff retries under a
  bounded budget, exit-0 partial-sync summary on exhaustion. Review refinements from
  Congress.Trade #162 re-propagated via PR #29 (merged 2026-07-05): issue listing inside
  partial handling, server Retry-After honored uncapped, 1s update throttle.
- (seeded empty — see repo git history for pre-protocol work)
- PR #3 (claude/agent-sync-stanza, CLAUDE) — AGENTS.md inter-agent coordination stanza; MERGED 2026-07-04.
- PR #4 (claude/effort-issues-mirror, CLAUDE) — GitHub Issues mirror of this board; MERGED 2026-07-04.
- PR #7 (claude/tokenless-git-dep-prep, CLAUDE) — tokenless git dependency policy: README/AGENTS.md
  publish-policy flip (owner made this repo public), tag `v1.2.0` pushed as the first stable consumer
  ref, and the `codex/package-git-prepare-20260629` / `codex/package-prepare-and-ci` stale-branch
  evaluation (both superseded/dead, both predate `usageTelemetry.ts`/vitest/CI on `main` — recommended
  for deletion but not deleted here; resolves backlog t167). MERGED 2026-07-04. Consumer-side follow-up:
  Socratic.Trade PR #439 and Congress.Trade PR #139 (both switch their `package.json` to
  `github:jaywedgeworth22/congress-trading-shared#semver:^1.2.x`).
  _2026-07-05 (CLAUDE next-wave): CORRECTED — Socratic.Trade `main` actually pins the EXACT tag
  `git+https://...#v1.2.0`, not a semver range; only Congress.Trade uses `#semver:^1.2.x`. So:
  Socratic.Trade = exact `#v1.2.0` pin (requires an explicit pin-string bump each release);
  Congress.Trade = semver range (lockfile refresh only, no package.json edit needed). This changes
  the v1.3.0 release-train checklist — see new Planned row below._
- **Reject inverted STOCK Act ranges before canonical bracket snapping (CODEX, P0/S).**
  `nearestBracket(16_000, 14_000)` currently returns the `$1,001-$15,000` bracket because it
  checks the guessed maximum against a tier ceiling without checking that the minimum is below
  that ceiling or that `max >= min`. Congress.Trade extraction calls this helper, so reversed OCR
  ranges can be marked exact and persisted as the wrong disclosure amount. Add invalid/non-finite
  guards and adversarial regression cases.
  
  **VERIFIED ALREADY FIXED — 2026-07-19, CLAUDE** (adversarial multi-agent re-audit of HEAD `1b0865d`, v1.10.0; each claim independently read + refute-checked). src/brackets.ts now guards `max >= min` and non-finite input before snapping; adversarial regression cases present.
- **Align shared query and telemetry schemas with the live producer contracts (CODEX, P1/M).**
  `TransactionsQuerySchema.since` validates an ISO date even though Congress.Trade defines it as a
  monotonic numeric cursor; shared telemetry also rejects server-supported status metric types.
  Audit current-origin nullability for market/enrichment payloads, correct the portable schemas,
  and add direct client/schema tests before widening exported types.
  
  **VERIFIED ALREADY FIXED — 2026-07-19, CLAUDE** (adversarial multi-agent re-audit of HEAD `1b0865d`, v1.10.0; each claim independently read + refute-checked). src/schemas.ts:170-183 — `since` is a union accepting the numeric cursor; server-supported metric types accepted.
- **Make CongressTradeClient runtime results match its exported types (CODEX, P1/L).**
  The client casts arbitrary JSON and shallow-checks only a few arrays, so malformed refs, prices,
  transactions, subscriptions, and analytics rows are returned under trusted types; `getRef` also
  throws on a normal 404 despite returning `SecurityRef | null`. After producer/read schemas align,
  parse every endpoint envelope, normalize scoped rows, add missing insider/short-volume methods,
  and cover malformed/404/nullable responses directly.
  
  **VERIFIED ALREADY FIXED — 2026-07-19, CLAUDE** (adversarial multi-agent re-audit of HEAD `1b0865d`, v1.10.0; each claim independently read + refute-checked). src/client.ts:51-57 `parseResponse()` zod-validates every endpoint envelope; `getRef` returns null on 404.
- **Require stable telemetry identities for multi-lane same-timestamp events (cross-app, P1/M).**
  The five-field fallback intentionally ignores service/label/project/quantity/unit and returns no
  client key without `occurredAt`; the monitor then assigns a random UUID. Congress prompt and
  completion telemetry currently lacks both stable inputs. Preserve the byte-compatible basis,
  add an opt-in explicit-key guard/helper and collision documentation, and route producer-specific
  stable keys to Congress.Trade.
  
  **VERIFIED ALREADY FIXED — 2026-07-19, CLAUDE** (adversarial multi-agent re-audit of HEAD `1b0865d`, v1.10.0; each claim independently read + refute-checked). src/usageTelemetry.ts:175 returns `undefined` (never a random UUID) when `occurredAt` is absent.
- **Preserve SSE resume IDs and non-erasable event timestamps (CODEX, P1/S).**
  `SseParser` resets the last event ID after every frame even though SSE IDs persist until replaced,
  and `createCongressEvent(..., { emittedAt: undefined })` erases its automatic timestamp. Fix both
  pure utilities with focused compatibility tests.
  
  **VERIFIED ALREADY FIXED — 2026-07-19, CLAUDE** (adversarial multi-agent re-audit of HEAD `1b0865d`, v1.10.0; each claim independently read + refute-checked). SseParser retains last event ID across frames; `createCongressEvent` no longer erases its auto timestamp (PR #156 / c4fcfb4).
- **Validate event envelopes and freeze exported readonly constants at runtime (CODEX, P2/S).**
  `CongressEventSchema` accepts blank types/IDs, fractional or negative sequences, and invalid
  timestamps. Exported alias maps/bracket arrays are TypeScript-readonly but mutable at runtime,
  allowing one consumer mutation to change later resolution globally. Tighten portable validation,
  preserve unknown nonblank event types, deep-freeze shared constants, and add mutation tests.
  
  **VERIFIED ALREADY FIXED — 2026-07-19, CLAUDE** (adversarial multi-agent re-audit of HEAD `1b0865d`, v1.10.0; each claim independently read + refute-checked). src/constants.ts alias maps and bracket arrays are deep-frozen at runtime; CongressEventSchema validation tightened.
- **Disambiguate open-ended STOCK Act ranges from unknown single values (CODEX/cross-app, P1/S).**
  `AmountBracket.max === null` means an unbounded top tier, but `nearestBracket(1_001, null)`
  collapsed it into a finite tier. Reject non-top open ranges in the portable helper. Congress.Trade
  also has a pre-helper `snapToBracket` loop that repeats the false snap; route that consumer-owned
  correction without editing its repository from this lane.
  
  **VERIFIED ALREADY FIXED — 2026-07-19, CLAUDE** (adversarial multi-agent re-audit of HEAD `1b0865d`, v1.10.0; each claim independently read + refute-checked). src/brackets.ts:53-60 short-circuits the `max === null` open-ended case before the containment loop.
- **Make security-ref ticker limits round-trip between import and read contracts (CODEX, P1/S).**
  `SecurityRefInputSchema` accepted 20-character tickers that `SecurityRefSchema` later rejected at
  10, so a valid import could make strict ref/bundle reads fail. Preserve the full-vs-partial shape
  distinction while aligning both ticker limits at 20 and add a round-trip regression test.
  
  **VERIFIED ALREADY FIXED — 2026-07-19, CLAUDE** (adversarial multi-agent re-audit of HEAD `1b0865d`, v1.10.0; each claim independently read + refute-checked). src/schemas.ts:69 and :97 — both read and input ticker caps are max(20).
- **Require transaction read provenance and preserve live additive fields (CODEX, P1/S).**
  The REST producer always supplies `confidence`, `source`, `createdAt`, and resume-critical
  `cursorSeq`, but the shared page accepted rows without them and stripped top-level `estValue`.
  Add a full `CongressTransactionReadSchema` for pages while keeping the general event shape
  backward-compatible; test missing cursor provenance and a non-empty client response.
  
  **VERIFIED ALREADY FIXED — 2026-07-19, CLAUDE** (adversarial multi-agent re-audit of HEAD `1b0865d`, v1.10.0; each claim independently read + refute-checked). src/schemas.ts:150-157 — `CongressTransactionReadSchema` exists and requires confidence/source/createdAt/cursorSeq.
- **Bound incremental SSE parser memory on malformed streams (CODEX, P2/S).**
  An unterminated line or event could grow the parser buffer/data array indefinitely. Add validated,
  configurable line/event limits that reset and throw, with recovery and oversized-frame tests.
  
  **VERIFIED ALREADY FIXED — 2026-07-19, CLAUDE** (adversarial multi-agent re-audit of HEAD `1b0865d`, v1.10.0; each claim independently read + refute-checked). SseParser (src/client.ts:413-508) enforces configurable line/event limits and throws RangeError, then self-resets.
- **Make install/release CI exercise the supported tokenless Git path and block merges (CODEX, P1/M).**
  The separate `smoke-install` job tests a local tarball, not `npm install` from the public Git ref,
  and only `verify` is required by branch protection. Also pin secret-bearing third-party action
  references to immutable full SHAs. Preserve the required `verify` context while making Git
  `prepare`/CJS/ESM/type resolution failures merge-blocking. Raise the low 60/40/50/65 coverage
  floors toward the current 92/84/91/95 baseline and add currently absent client HTTP tests.
  
  **VERIFIED ALREADY FIXED — 2026-07-19, CLAUDE** (adversarial multi-agent re-audit of HEAD `1b0865d`, v1.10.0; each claim independently read + refute-checked). .github/workflows/ci.yml:62-73 installs from the public Git ref; coverage floors raised to 85/70/80/85.
- **Prevent accidental registry publication and document the prepare-script requirement (CODEX, P2/S).**
  
  **NEW EMPIRICAL RISK — 2026-07-19 CLAUDE, confirmed on a real clean install of `v1.11.0`.** The publish-guard half is fine (`package.json` `"private": true`). But the *prepare-script* half is now an ACTIVE consumer hazard, not just a docs gap: modern npm (observed on the Node 26 / npm 11 toolchain) gates lifecycle scripts behind an approval prompt and emitted `npm warn allow-scripts  @jaywedgeworth22/congress-trading-shared@1.11.0 (prepare: npm run build)` / `Run npm approve-scripts --allow-scripts-pending to review`. Because `dist/` is produced ONLY by `prepare`, a consumer whose npm blocks or defers that script installs a package with **no runtime files at all** — the failure looks like a broken/empty module, not a blocked script. This affects the documented tokenless path `github:jaywedgeworth22/congress-trading-shared#semver:^1.11.x`. Verified working when scripts ARE allowed: tsup ran, `dist/index.js` + `index.mjs` + `index.d.ts` + `index.d.mts` all emitted, and both CJS `require()` and ESM `import` resolved the new `normalizeSecurityRef` export. ACTION: document the `allow-scripts`/`approve-scripts` requirement in README + consumer bootstrap, and consider whether committing `dist/` or shipping a prebuilt tag is warranted given both consumers install straight from Git.
  Policy forbids npm publishing but package metadata has no `private`/prepublish guard. Git installs
  also produce no runtime files when lifecycle scripts are disabled because `dist/` is generated by
  `prepare`. Add a tested publish guard and make the lifecycle requirement/scratch verification
  explicit rather than telling operators to delete a consumer lockfile in place.
  
  **VERIFIED ALREADY FIXED — 2026-07-19, CLAUDE** (adversarial multi-agent re-audit of HEAD `1b0865d`, v1.10.0; each claim independently read + refute-checked). package.json:4 `"private": true` machine-enforces the publish guard.
- **Repair released-package metadata drift and cut an immutable SemVer-minor release (CODEX, P1/M).**
  Both consumers resolve `v1.5.0` at `2222baeb`, where `package.json` still says `UNLICENSED` and
  no LICENSE file exists; `main` now contains MIT metadata while still reporting version 1.5.0.
  The root lock still says `UNLICENSED`, v1.4.2 is documented/versioned but was never tagged, and
  several real release sections/links are missing. Do not move existing tags: sync metadata, record
  historical truth, bump after fixes, clean-install the exact ref without registry tokens, and
  publish a new immutable tag at the matching package version.
  
  **VERIFIED ALREADY FIXED — 2026-07-19, CLAUDE** (adversarial multi-agent re-audit of HEAD `1b0865d`, v1.10.0; each claim independently read + refute-checked). package.json is version 1.10.0 + MIT; tag v1.10.0 = 904ea96. No metadata/tag drift remains.
- **[congress-trading-shared][CLAUDE] Stale-board reconciliation + self-hosted CI truth pass (2026-07-19) — COMPLETED.** Adversarial multi-agent audit (23 agents) re-verified 16 open P0/P1/P2 claims against HEAD `1b0865d` (v1.10.0, NOT 1.9.0 as the board and the AG handoff both stated). Result: **13 already fixed** (moved to Completed above with per-item file:line receipts), 3 genuinely open (SSE auth flow = cross-app remainder only; Node type floor = `@types/node` still on 26 vs `engines.node >=20`; filing-lag `60d+` boundary), 1 partially open (dual-Zod: no dual instance exists today, but `zod` should move to `peerDependencies` to make future majors fail loudly). ALSO: PR #198 is **merged** as `1b0865d` (board said 'open, blocked on Coolify auth' — wrong). Coolify auth was never a token-validity problem: `COOLIFY_API_TOKEN` in `/Users/jay/.secrets/global-api-keys` was wrapped in double-THEN-single quotes, so sourcing yielded a value with literal `'` characters → HTTP 401. Repaired in place; API verified 200. ALSO: another seat added `shared-ci-runner`+`usage-ci-runner` and set `SHARED_CI_RUNNER=shared-ci` at 19:45Z **without a green proof run**; two runs then failed identically (`actions/setup-node` download timed out 3×, runner went offline). Variable deleted → repo returned to the dormant vars-off state PR #198 was merged in; hosted CI re-proved green (`29704710512`). Runner containers left in place, untouched. Capacity finding for the fleet owner: `host.jays.services` is a cx33 (4 vCPU / 8 GB) now carrying **14 GB** of runner `mem_limit` ceilings across 6 containers.

## In Progress
- (none)

## Archived provenance — terminal rows reconciled above

- **Consolidate usage telemetry clients in both consumer apps (CURSOR, M) — started 2026-07-06, completed 2026-07-06.**
  Refactored Socratic.Trade (`usage-monitor-push.ts`) and Congress.Trade (`telemetry/usage.ts`)
  to retire local telemetry definitions and import the shared `createUsageTelemetryClient` and
  types. Branches: `cursor/telemetry-consolidation` on both repos.
  - **Socratic.Trade:** replaced local `UsageMonitorEvent` and type aliases with imports from shared.
    Bumped shared dep from v1.3.3 → v1.4.1. Preserved buffering/flush/health-logging infrastructure.
    Consumers (`llm-usage.ts`, `rag-metering.ts`, `alpaca.ts`, `robinhood.ts`, `data-providers.ts`,
    `usage-budget.ts`) continue to import re-exported aliases — zero API breakage.
    Verified: no telemetry-related tsc errors, 2843 tests pass.
  - **Congress.Trade:** replaced local `UsageTelemetryEvent` interface and HTTP client with
    `createUsageTelemetryClient({ baseUrl, token }).send()`. Kept CF-specific secrets resolution
    (`resolveSecrets`) and `normalizeEvent` wrapper. Test mock updated to match shared response
    schema (`{ ok, accepted }`). Verified: typecheck clean, 672 tests pass.
- **Retire duplicate API client fetchers and stream parser in Socratic.Trade (CURSOR, M) — started 2026-07-06.**
  Replaced local `getJson` wrapper + manual URL construction in `congress-trade-client.ts` and
  local `SseParser` class in `congress-stream.ts` with `CongressTradeClient` and `SseParser` from
  shared package. Preserved all business logic (feature gates, health logging, timeouts, symbol
  normalization, stream management). Bumped shared dep v1.3.3 → v1.4.1. 62 tests, tsc clean.
  Branch: `cursor/retire-client-dups`.
  _2026-07-06 (CURSOR): completed — see Completed section._
- **Import snapshot/export types in Congress.Trade (CURSOR, S) — started 2026-07-06.**
  Replace locally defined `SnapshotTableInfo` and `SnapshotManifest` in `export/snapshot.ts` with
  shared-package imports. Branch: `cursor/snapshot-types`.
  _2026-07-06 (CURSOR): completed — see Completed section._

- **✅ DEPLOYED 2026-07-05 as v1.3.0 (PR #53 merged `4c35df2` + tag `v1.3.0`) — see the Deployed
  section at top. This In-Progress row is superseded; left for the next-wave board-owner to move.**
- **Split `TICKER_ALIASES` into rename-vs-acquisition classes — SHARED-LIBRARY PORTION (MONET,
  `monet/sad-hermann-671f4d`) — DONE-local 2026-07-05 (committed `03d33bd`; owner push/PR/tag
  pending).** _2026-07-05 (MONET): attribution RE-CORRECTED CLAUDE→MONET. A concurrent session
  flipped this row to CLAUDE and renamed the branch on the premise "this account IS the CLAUDE
  seat" — but the account's branch-prefix setting is `monet` (⇒ MONET per the fleet rule) and the
  owner directed this session as Monet from the first message. Branch renamed back
  `claude/sad-hermann-671f4d` → `monet/sad-hermann-671f4d`; work content unchanged (03d33bd)._
  Owner-directed pickup of the shared-package half of the AG-reserved cross-app row
  below (reservations, not locks — yield offer to AG in #agent-sync). Additive, backward-compatible
  API in THIS package only: `TICKER_RENAMES` (FB→META, SQ→XYZ, GEHCV→GEHC continuous entities) +
  `TICKER_ACQUISITIONS` (BRCM→AVGO, TWX→WBD, ATVI→MSFT, RHT→IBM delisted/successor); `TICKER_ALIASES`
  kept as their union (still 7 entries); `classifyTickerAlias()`/`TickerAliasClass`/`TickerAliasResolution`
  + PIT-safe `resolveContinuousTicker()`; +26 tests; design doc; v1.3.0 bump. Verified: tsc clean,
  **263 tests pass**, build green (6 new symbols in dist .d.ts), npm audit 0 vulns, tokenless
  CJS+ESM install smoke, 3-lens adversarial review (no blockers). Consumer migration
  (Congress.Trade `normalizer.ts:492` + `tickerNormalize.ts:201` fold sites → renames-only,
  `pitScores.ts` delisting metadata; Socratic.Trade `ACQUISITION_SOURCES` guard) stays OWNER-GATED
  per AGENTS.md — remains AG's follow-up. Frontier tier (money-path-subtle PIT attribution). Doc:
  `docs/rollouts/2026-07-05-ticker-alias-rename-vs-acquisition.md`.
  _2026-07-05 (CLAUDE next-wave): annotation — the row is accurate about being owner-gated but
  omits that `03d33bd` is stacked on the unpushed CURSOR tip (`6300b89`); it cannot be pushed/PR'd
  independently — a PR opened from this branch today would silently carry all 6 CURSOR commits
  too. Sequencing: `v1.3.0` landing is sequenced AFTER the cursor branch lands (or this commit is
  rebased onto `origin/main`); treat cursor-land -> monet-land -> tag v1.3.0 -> consumer bumps as
  one coordinated train (see new Planned row below)._
- Codex global coordination + fleet monitoring setup (Codex, shared `/Users/jay/apps`
  infra) — include this package in the standardized Codex bootstrap/audit path;
  no package code changes in this repo.

## Planned / Reserved

## Changelog of this log
- 2026-09-12 — AG: board hygiene. Moved tickerLogoPolicy to Deployed and Cross-app coordination follow-ups to Completed.

- 2026-08-17 — GROK: board hygiene. Second In Progress emptied; ISO 8601 already Deployed v2.3.0; remaining cross-app rows parked Planned.
- 2026-07-06 — CURSOR: completed Agentic Trading → Socratic Trade rename (7 files), added
  Zod schemas for AmountBracket/Subscription/SseMessage, expanded client tests from 17 to
  113 (332 total). Commit `836b935` on `main`.
- 2026-07-05 — CLAUDE: completed both reserved lanes: stale-main repair (salvage-verified
  SUBSUMED via 2-lens + adversarial-verify workflow, then `git branch -f main origin/main`,
  now 0/0) and CI-adoption blocker check (blocker not cleared — moved to Socratic.Trade
  PR #372 + unbuilt reusable gate; Planned row updated). Mirror reconciliation PR #31
  MERGED to main (071a17d, verify green) — docs/EFFORT-LOG.md now current, issues mirror fed.
- 2026-07-05 — CLAUDE: seat-correction pass (owner-directed). Corrected the sad-hermann row
  attribution MONET→CLAUDE (this account is the CLAUDE seat; monet-* branding was a
  WorktreeCreate-hook artifact, hook now removed) and renamed the branch to
  `claude/sad-hermann-671f4d`. Reserved two CLAUDE lanes: stale-main repair (moved from
  Planned) + CI-adoption blocker check.
- 2026-07-05 — MONET: RE-CORRECTION of the seat flip-flop above. This account's branch-prefix
  setting is `monet` (⇒ MONET seat, per the fleet rule and confirmed by the owner), and the owner
  directed this session as Monet from the first message. The concurrent "seat-correction" that
  relabeled this work CLAUDE and renamed the branch was itself the error; restored to MONET /
  `monet/sad-hermann-671f4d`. Work content unchanged (03d33bd). Not touching the concurrent
  session's own reserved CLAUDE lanes — owner to adjudicate.
- 2026-07-05 — MONET: DONE-local the shared-library portion of the TICKER_ALIASES
  rename-vs-acquisition split (`monet/sad-hermann-671f4d`, commit `03d33bd`, additive v1.3.0).
  Reserved Planned→In Progress under owner direction with a yield offer to AG; consumer migration
  remains AG's owner-gated follow-up. Verified (263 tests, build, audit, install smoke, 3-lens
  adversarial review). Owner push/PR/tag pending.
- 2026-07-05 — CURSOR: completed mechanical repo maintenance batch (stale branch deletion,
  publish.yml decommission, engines.node, CHANGELOG.md + docs/RELEASE.md). Moved from
  In Progress to Completed.
- 2026-07-05 — CURSOR: moved 6 CURSOR-assigned tasks from Planned to In Progress. Split into
  two subagent lanes: tests (mid-tier, `cursor/tests`) + mechanical cleanup (mid-tier,
  `cursor`).
- 2026-07-04 — bootstrapped by CLAUDE (effort-log standardization).
- 2026-07-05 — CODEX: reserved "Codex Cloud Slack + effort-log readiness across all four apps"
  (shared fleet-infra) in In Progress; scope is Codex Cloud repo-visibility/Slack config audit, no
  package code.
- 2026-07-05 — CLAUDE (next-wave, cycle 2): applied stale-row corrections — split the CURSOR test-
  coverage row and mechanical-maintenance row back to In Progress as DONE-local-unpushed (only
  `codex/*` branch deletion actually reached origin; test suite + publish.yml decommission +
  engines.node + CHANGELOG.md/RELEASE.md are still local-only on `cursor`, 5 commits behind
  `origin/cursor`, no PR open); annotated the MONET `sad-hermann` row with the cursor-stacking
  dependency; corrected the PR #7 row's pin-style claim (Socratic.Trade = exact `#v1.2.0` tag,
  Congress.Trade = `#semver:^1.2.x` range — not both semver); re-verified and re-confirmed both
  the CI-adoption blocker (still blocked on Socratic.Trade PR #372 not existing) and the stale-
  main-clone repair (already correctly Completed, `main`/`origin/main` confirmed identical at
  `071a17d`). Added 7 new Planned rows under "2026-07-05 next-wave (cycle 2)": CI verify-job npm
  test step, the v1.3.0 release-train sequencing row, a required-status-check ruleset, a tokenless
  install-smoke CI job, vitest coverage-threshold gating, pruning 8 merged `claude/*` branches, and
  two scoping fixes (Socratic.Trade `ACQUISITION_SOURCES` re-verify, docs/RELEASE.md consumer-list
  correction). No package code touched from this seat.
- 2026-07-05 (CLAUDE audit-c3) - Audit cycle-3 pass: added rows + ABANDONED/HANGING annotations for
  PRs #55/#56/#57/#54 (all OPEN, CI green, blocked only by a docs/EFFORT-LOG.md-only conflict;
  corrected the misleading 81b2fd3 commit message claim on #55) and origin/cursor (ahead=0, merged
  via v1.3.0, safe to delete). Corrected the "prune merged claude/* branches" row's undercount (8 ->
  9 branches + origin/cursor, added claude/board-nextwave-c2 to the deletion list). Added 3 new
  Planned rows under "2026-07-05 audit cycle-3": rebase+land the 4 AG PRs in stack order, fix the
  misleading commit message during rebase, delete origin/cursor.
- 2026-07-20 — AG: resolved the dual-Zod public-schema boundary by moving `zod` to `peerDependencies` (+ devDependency) in package.json.
- 2026-08-12 — GROK: landed open PR queue. #262 merged `976e73e` (verify fail was pre-existing nanoid; main already on 3.3.18). #260 merged `ebe1f95` after Slack `.ok` / project-tag / read-filter review fixes. No open PRs remain.

- **[fleet][AUTOMATED WATCH] HETZNER UPGRADE AVAILABLE: cx43 (8 vCPU / 16 GB, EUR 18.49/mo) -- owner pre-approved cx43 rescale of host.jays.services (id 149429403, upgrade_disk:false to stay reversible; needs power-off, brief socratic-trade-prod downtime).** (detected 2026-08-05 09:41:00 by check-hetzner-cx43.sh)
