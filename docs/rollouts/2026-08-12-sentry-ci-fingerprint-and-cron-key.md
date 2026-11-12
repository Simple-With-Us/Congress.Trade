# 2026-08-12 — Sentry CI reporter: drop branch from the fingerprint, repair the stale cron key

## Context & Objective

The shared `fleet-infra` Sentry project (org `jays-services`) had accumulated
200+ unresolved issues, and a prior investigation established — and
adversarially verified — that roughly **85 of them came from a single line** in
this repo's CI-failure reporter.  `scripts/sentry-ci-report.py` fingerprinted
each CI failure on `[app, workflow, branch]`.  Branch names are unbounded and
short-lived, so every feature branch that ever failed CI minted its own
brand-new, permanent Sentry issue: one per `(workflow, branch)` pair, forever,
each one pointing at a branch that was deleted days later.  The grouping the
fingerprint was supposed to provide never happened, because no two failures on
different branches could ever group.

The same file carried a second, quieter defect.  `CRON_SCHEDULES` is keyed by
workflow **display name**, and `shared-package-pin-check.yml` was renamed
`Shared package pin check` -> `Shared Package Pin Check` in `d849720c`
(2026-07-27).  The map kept the old casing, so the lookup missed, the Sentry
Crons monitor for that workflow was never upserted, and its weekly check-in has
not fired since — meaning the one alert that would tell us the pin check had
silently *stopped running* was itself silently not running.

## Changes Made

### 1. Fingerprint (the ~85-issue bug)

- `scripts/sentry-ci-report.py`
  - Fingerprint is now `["ci-failure", APP, workflow_name]` — the branch
    component is gone.  All failures of one workflow, on any branch, group into
    one Sentry issue.
  - The event message drops the branch too:
    `f"CI workflow {conclusion}: {workflow_name} [{APP}]"`.  A branch in the
    title defeats grouping even when the fingerprint is right, because Sentry
    shows the title as the issue name.
  - **The branch is moved, not deleted.**  It stays in `tags` (searchable,
    shown per-event) exactly as before, and is additionally echoed into `extra`
    alongside the run URL so it is legible without opening the tag panel.
    Unbounded-cardinality data belongs on the event, never in the fingerprint.

### 2. Stale cron key + recurrence hardening

- `scripts/sentry-ci-report.py`
  - `CRON_SCHEDULES` key corrected to `"Shared Package Pin Check": "0 13 * * 1"`,
    matching the workflow's current `name:` and its own `schedule:` block.
  - **Guard 1 — case-folded lookup.**  `_CRON_SCHEDULES_FOLDED` indexes the map
    by `casefold()`, and the schedule branch looks up
    `workflow_name.casefold()`.  A rename that changes only capitalisation can
    never detach a workflow from its monitor again.
  - **Guard 2 — startup validation against reality.**  `discover_workflow_names()`
    reads the top-level `name:` of every file under `.github/workflows/`
    (resolved from `__file__`, not the process CWD) and
    `find_cron_schedule_drift()` reports any `CRON_SCHEDULES` key that matches
    no real workflow.  On drift the reporter emits a `::error::` annotation
    **and files a Sentry issue** via the new `send_config_drift_event()`.
  - A schedule-triggered workflow with no `CRON_SCHEDULES` entry now also files
    that Sentry issue instead of only printing a `::warning::`.
- `.github/workflows/sentry-ci-report.yml`
  - Header comments corrected: the fingerprint description no longer claims
    `[app, workflow, branch]`, and the mirrored cron table now reads
    `Shared Package Pin Check`.

## Decisions & Trade-offs

- **Why a Sentry issue for config drift, and not just a louder log line?**  The
  old code already printed `::warning::` on exactly this condition, every single
  week, for two weeks — and nobody saw it, because it lived inside a reporter
  job whose logs are never opened.  A guard whose only output is an annotation
  in an unread job is indistinguishable from no guard.  Routing drift to Sentry
  puts it where the fleet actually looks.
- **Why this cannot repeat the issue explosion it is fixing.**  Drift
  fingerprints are bounded by *workflow count* (~15), not branch count
  (unbounded).  `stale-cron-key` collapses to one issue regardless of how many
  keys are stale; `unmapped-schedule` is per workflow name.  Worst case is a
  handful of issues that each represent a real, fixable misconfiguration.
- **Why a line scan instead of parsing YAML.**  The whole design premise of this
  script is zero dependencies — no `sentry-sdk`, no marketplace action, raw
  envelope HTTP.  Adding PyYAML to validate a comment-level invariant would
  trade that away.  A GitHub workflow's top-level `name:` is always an
  unindented plain scalar, so `^name:\s*(.+)$` on the first match is exact.
- **Fails open, in both directions.**  `discover_workflow_names()` returns
  `None` when `.github/workflows/` is absent (script run outside a checkout) and
  `find_cron_schedule_drift()` treats `None`/empty as "cannot tell" rather than
  "everything is stale" — so a missing checkout can never fabricate drift
  alerts.  The reporter still returns 0 on every path.
- **Existing Sentry issues are not touched by this change.**  The ~85 stale
  per-branch issues already in `fleet-infra` remain; they need a bulk resolve in
  the Sentry UI/API.  This PR stops the bleeding, it does not clean the wound.

## Verification State

Commands run from the worktree `/private/tmp/fx-ct-ci`:

```
python3 -m py_compile scripts/sentry-ci-report.py     # COMPILE OK
node scripts/check-actions-runner-policy.mjs          # Actions policy OK: 15 workflows use owned runners only.
cd app && npm ci                                      # 263 packages
cd app && npm run typecheck                           # deno check src/deno/main.ts — clean
cd app && npm run coverage                            # 245 files / 3000 tests passed; coverage thresholds met
```

Behavioural verification of the reporter itself, run in-process with the
`urlopen` transport stubbed so the real envelope payloads could be inspected:

| Case | Result |
| --- | --- |
| `CI` failure on `claude/feature-a` | `fingerprint: ["ci-failure","congress-trade","CI"]`, `tags.branch = claude/feature-a` |
| `CI` failure on `grok/other` | **same fingerprint** — the two now group (this was the bug) |
| `Security` failure | `["ci-failure","congress-trade","Security"]` — distinct workflows still separate |
| Scheduled `Shared Package Pin Check` success | check-in sent, slug `ci-congress-trade-shared-package-pin-check`, schedule `0 13 * * 1` (previously: skipped entirely) |
| Scheduled workflow with no mapping | `["ci-report-config-drift","congress-trade","unmapped-schedule",<name>]` |
| Simulated stale `CRON_SCHEDULES` key | `::error::` annotation + `["ci-report-config-drift","congress-trade","stale-cron-key"]` |
| `CI` success | zero envelopes sent — unchanged |
| Empty / malformed DSN | exit 0, no network call — unchanged |

Every path returned exit code 0, preserving the reporter's "never red-X the
observed workflow" invariant.

`npm run lint` (`deno lint`) reports 395 pre-existing problems across 261 files.
That gate is **not** part of the CI `verify` job (CI runs typecheck + coverage +
audit), and this change touches no TypeScript — the count is unchanged by it.

## Next Steps & Blockers

- **Bulk-resolve the ~85 stale per-branch `ci-failure` issues in `fleet-infra`.**
  They will not recur after this merge, but they will also not clear themselves.
  Filter the project on `app:congress-trade` + the `ci-failure` culprit and
  resolve in bulk.
- **Apply the same fingerprint fix to the Socratic.Trade copy of this script.**
  That repo carries the ancestor of this file (without the `app` component) and
  is the likely source of the remaining branch-fingerprinted issues in the
  shared project.
- **Watch for the first `Shared Package Pin Check` check-in** on the Monday
  following this merge (`0 13 * * 1` UTC).  The monitor
  `ci-congress-trade-shared-package-pin-check` is upserted by the first
  successful scheduled run; if it does not appear, the workflow itself is not
  running, which is exactly the condition this repair restores visibility into.
