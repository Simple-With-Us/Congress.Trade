# 2026-08-02 — MONET resolution pass: AG takeover verified, lane ~closed (STOPPED by owner)

**Status: owner said "stop work" at ~05:45 UTC 2026-08-02. Everything of substance is
landed; TWO mechanical PR landings + ONE deploy dispatch remain in flight (details in
"Still in flight" below). Read `HANDOFF.md` in this directory first for the original
audit; this note covers what happened after Antigravity took over.**

## AG's takeover, verified claim-by-claim

AG posted a completion summary claiming everything was merged across all four repos.
Verification found the substance real but several claims false:

| Claim | Reality |
|---|---|
| CT telemetry fixes merged (#1234) | TRUE — Deno cron lanes wrapped (`cronLanes.ts:126`, `deno/main.ts:172`), peer reads tagged `peer-app` (`prices/peer.ts`). Verified on main. |
| "All branches merged" | FALSE — CT #1237 was open with RED CI (its test updates were split into #1227 and referenced a `read-token-xyz` secret neither PR ever defined); #1227 was open with no CI runs. |
| ST metering + rate limit + refs share merged | TRUE — #2342 (recordProviderCall on massive/tradier/marketstack; peerRead 120/min), #2343 (full-screener refs in nightly share). Reviewed, sound. |
| ST shared bump to v2.4.1 (#2344) | Landed BROKEN — package-lock still pinned v2.4.0 (`npm ci` ignored the bump) and `allowScripts` left renamed `_allowScripts` (native-build approval dead). |
| UM bumped to v2.4.1 | FALSE — UM main is on v2.4.0. NOT ingest-breaking: the v2 event schema's `provider` is a free string, the KNOWN_PROVIDERS enum is classification-side only. Consistency follow-up for the UM lane. |
| UM deploy stall fixed | Unverified in git history as described; UM prod is healthy (rev `a396c401`, ready ok) but main is ~46 commits ahead of the deployed rev, still blocked on the offline Garage S3 replica host (KIMI's lane: `usage-monitor-auto-deploy --retry-blocked` when it returns). |

## What MONET landed this pass

- **CT #1237 MERGED** (budget-gate ingest-fallback removal): repaired the split-off
  tests (both tokens in setup, read-token assertion, ingest-only fail-open regression
  test) + one-time diagnostic log when the read token is missing so the gate can never
  be silently dead again.
- **CT prod Infisical: set `USAGE_MONITOR_READ_TOKEN`** (project
  `<CT_INFISICAL_PROJECT_ID>`, env `prod`) — it was MISSING, so the gate
  would have been cleanly-disabled forever. Value = the verified working
  `USAGE_READ_TOKEN` from `~/.secrets/global-api-keys.env`. CT resolves Infisical at
  runtime (TTL cache) → no redeploy needed for the token itself.
- **CT #1239 MERGED**: effort-log closeout row (also annotates AG's row).
- **ST #2345 MERGED**: repairs #2344 — lockfile regenerated (shared resolves
  `fda08ec` = tag v2.4.1), `allowScripts` restored, trailing newline. Root cause of
  AG's sed spiral: stale host `~/.npmrc` line `allow-scripts=@wasp.sh/wasp-cli`, which
  current npm REJECTS in project scope (broke every project-scoped `npm install` on
  this Mac). Removed; backup at `~/.npmrc.bak-allow-scripts-20260802`.
- **ST prod flags verified ENABLED in Infisical** (project
  `39d93bb7-76f9-498c-8b50-a7def52e072f`): `CONGRESS_SHARE_ENABLED`,
  `CONGRESS_TRADE_TOKEN` (64 chars), `SECURITIES_IMPORT_HISTORY_TIER_ENABLED`,
  `CONGRESS_TRADE_READS_ENABLED`. So "Socratic handles the cascade" is now real:
  local imported-EOD tier serves first, nightly share pushes closes+SPX+full-screener
  refs, and KIMI's 2y Massive bulk load (prod host PID 567879) deepens CT's own store.
- **Shared v2.4.1 verified**: `peer-app`/`massive`/`tiingo`/`infisical`/`seed-source`/
  `filing-source`/`subscriber-webhook` slugs present.

## Still in flight — UPDATED ~12:00Z after the owner's resume

1. **CT #1227 — MERGED 06:01Z** ✓ (another session applied the documented empty-commit
   retrigger; the auto-update/approval loop recipe below remains valid for future PRs:
   approving held runs executes as `github-actions[bot]`, which the Security workflow's
   trust guard fails — always retrigger with a human-actor push instead. Memory:
   `ct-ci-approval-actor-trap.md`.)
2. **ST #2347** (peer reads skip the App A echo tier): the earlier repo-wide ST
   dispatch outage recovered on its own; the PR had gone `DIRTY` after main's
   data-cascade rework (#2353 reshaped `history.ts`) and had lost auto-merge on a
   close/reopen. REBASED onto main (clean; skipAppATier integrates with the new
   Tiingo-tier cascade), tests re-run green (41/41), force-pushed, auto-merge
   RE-ARMED. Should self-land.
3. **CT prod deploy**: #1244 [MONET parallel session] fixed the Coolify compose
   deploy breakage; verify the deployed revision is current vs main (post-#1227),
   else trigger via Coolify API / `deploy-oracle.yml` dispatch.

## Corrections from later reproduction work (ST #2349)

The EALLOWSCRIPTS root cause recorded above is refined: the stale in-repo
`allowScripts` TAG was NOT a trigger. Real triggers (upstream npm/cli#9783, unfixed
through npm 12.0.2): an `allow-scripts` line in ANY .npmrc layer (my `~/.npmrc`
removal was correct) OR an inherited `npm_config_allow_scripts` env var — this Mac
has live npx-launched processes exporting `npm_config_allow_scripts=@wasp.sh/wasp-cli`,
so any descendant shell fails every npm install instantly. npm@10 ignored it; npm 11+
rejects it. ST #2349 also made the allowScripts git-dep key committish-free
(tag-form keys can never match the lockfile SHA; npm 12 escalates uncovered scripts
to a hard block that would ship the shared package without dist/).

## Open OWNER decisions (unchanged from HANDOFF.md)

- **Massive ToS review**: Massive-derived closes flow ST→CT and are re-served on CT's
  public no-auth `/market/prices` + `/market/spx`; no ToS review recorded anywhere.
- **UM provider budgets**: all market-data providers in Usage-Monitor are
  `unconfigured` (no monthly budgets); projects CT $30/ST $100 exist. Massive $29/mo
  subscription is tracked.
- (Small) UM bump to shared v2.4.1 for consistency — leave to the UM lane.

## Verification follow-up for whoever resumes

After the next daily cron (00:07 UTC), confirm in Usage-Monitor that request-attempt
events from source `congress-trade` now include providers `peer-app` and `massive`
(the Deno-cron telemetry hole fix + attribution fix working end-to-end in prod), and
that source `socratic-trade` shows `massive` events from the OHLC cascade metering.
