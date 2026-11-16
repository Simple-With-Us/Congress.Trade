# 2026-08-13 — CI and iOS ship never ran on bot-merged PRs

## 1. Context & Objective

A fleet audit on 2026-08-13 found that PRs merged by `github-actions[bot]` land
on `main` and dispatch **zero** workflow runs.  GitHub does not raise workflow
events for actions performed with `GITHUB_TOKEN` (its recursion guard), and this
repo's own `auto-merge-prs.yml` arms auto-merge with exactly that token — so the
bot becomes the merging identity and the resulting push announces nothing.  CI
never verified the post-merge squash sha, and iOS code reached `main` without
ever reaching a phone.

Objective: give this repo triggers that survive a bot merge, and stop producing
bot merges in the first place — without letting the new scheduled path spam
TestFlight.

## 2. Changes Made

Three layers, root cause first.

**Layer 1 — stop being the bot.**  `auto-merge-prs.yml` and
`auto-merge-shared-dependency.yml` now check for an elevated merge identity
(`GH_PAT` or `SHEPHERD_TOKEN`) before arming.  Neither secret exists in this
repo today (verified by name only via `gh api repos/.../actions/secrets`), so
both workflows are now a deliberate, logged no-op: they annotate the run with
the exact `gh pr merge <n> --squash --auto` command instead.  Landing then
happens under the owner's own credentials, `merged_by` becomes
`jaywedgeworth22`, and every push workflow fires again.  Adding a `GH_PAT`
secret re-activates both workflows with no code change.

**Layer 2 — a CI backstop that a bot merge cannot suppress.**  `ci.yml` gains
`schedule: - cron: '23 * * * *'` plus a `schedule-gate` job.  For every
non-schedule event the gate votes "run" immediately and CI behaves exactly as
before.  For a scheduled tick it asks the Actions API whether this workflow
already has a run (successful, queued, or in progress) for `main`'s current
HEAD and skips when one exists, so the steady-state cost is one ~10-second
hosted job per hour.  The gate is fail-closed: any API error, empty response, or
unparseable result votes RUN.  `concurrency` is now keyed on the event as well
as the ref, so the scheduled backstop and a real push to `main` cannot cancel
each other.

**Layer 3 — an iOS ship trigger that survives a bot merge, guarded against
spam.**  `ios-ship.yml` gains `schedule: - cron: '7,37 * * * *'` (offset from
Socratic.Trade's `*/30` so the three fleet repos do not start three ships on the
single Mac runner in the same minute), `fetch-depth: 0` on checkout, and a new
gate step.  A cron carries no `paths:` filter, and `ship-testflight.sh`'s own
gate only tests "is HEAD the sha I last shipped" plus a time interval — so
without the new gate a backend-only commit past the 2.5h window would ship a
TestFlight build.  `scripts/ios-fleet/scheduled-ship-gate.sh` closes that: on a
scheduled tick it ships only when `clients/ios/**` actually changed between the
app's last successful ship and HEAD.

### Review round 2 — two defects found before landing

**(a) A scheduled backstop that could subtract verification.** The first pass
gave the required `typecheck + test` job `needs: [schedule-gate]` with
`if: needs.schedule-gate.outputs.should_run == '1'`. The decide *step* always
exits 0, but the *job* can still fail, time out (`timeout-minutes: 5`), or be
cancelled by runner/API trouble — and when a `needs:` dependency fails, every
dependent job resolves to **skipped**, which GitHub reports as a **satisfied**
required check. A gate outage would therefore have let a PR merge with tsc and
tests never having run: the exact inverse of the backstop's purpose.
Fail-closed inside the step is not the same as fail-closed at the job level.

All three gated jobs now use:

```yaml
if: >-
  !cancelled() &&
  (github.event_name != 'schedule' ||
  needs.schedule-gate.outputs.should_run != '0') &&
  (github.event_name != 'pull_request' || ...)
```

`!cancelled()` (not `always()`) so a superseded run still cancels cleanly, and
`!= '0'` so an absent or unparseable output still **runs** — only an explicit
"already verified" vote skips, and only on the scheduled path. This is the same
pattern Socratic.Trade adopted in its PR #370 for the same reason.

**(b) Automatic ships that would have been silently uninstallable.** This repo
ships through `scripts/ios-ship-testflight.sh`, which resolves the **in-repo**
`scripts/ios-fleet/` copy — and that copy still carried the wrong-build
export-compliance defect verbatim: `ship-testflight.sh` called
`asc-api.mjs ensure-tf-ready "$BUNDLE_ID"` with no build number, and `asc-api.mjs`
resolved it as `filter[app]=<id>&sort=-uploadedDate&limit=1`. ASC ingestion is
asynchronous, so for the first minutes after an upload "newest" is the
**previous** ship. The parallel lane had fixed only the untracked runtime copy at
`/Users/jay/apps/ios-fleet`. Turning on a cron without porting the fix would have
meant every automatic CT ship declaring compliance on the wrong build and leaving
the new one `MISSING_EXPORT_COMPLIANCE` — the ST 1.0.1/1.0.2
"VALID but never installable" failure, now on a schedule.

Both in-repo files were byte-identical to the pre-edit runtime backup
(`diff` against `/Users/jay/apps/ios-fleet/.backup-monet-20260813/` → no output),
so the port is a clean whole-file copy of the fixed runtime versions rather than
a hand-merge. That also removes the two copies' divergence for these two files.
`ensure-tf-ready` now takes `<bundleId> <buildVersion> [marketingVersion]`, polls
`filter[version]=` until the build this run uploaded actually appears, and only
then declares compliance on **that** id. It also renders the mandatory
`AG***-S**C.md` "What to Test" note — **opt-in**, defaulting to a dry render into
the ship log (`IOS_TF_RELEASE_NOTES=1` publishes; owner's call, not an agent's).

`bash scripts/ios-fleet/test-ship-seq.sh` still passes **43/43** after the port,
so no expectation refresh was needed.

Files touched:

- `.github/workflows/auto-merge-prs.yml`
- `.github/workflows/auto-merge-shared-dependency.yml`
- `.github/workflows/ci.yml`
- `.github/workflows/ios-ship.yml`
- `scripts/ios-fleet/scheduled-ship-gate.sh` (new)
- `scripts/ios-fleet/test-scheduled-ship-gate.sh` (new)
- `scripts/ios-fleet/asc-api.mjs` (export-compliance + release-notes port)
- `scripts/ios-fleet/ship-testflight.sh` (export-compliance + release-notes port)
- `STATUS.md`, `docs/EFFORT-LOG.md`, this note

## 3. Decisions & Trade-offs

**The gate logic lives in a script, not inline YAML.**  It runs only on the one
Mac that can ship, so inline it would never be executed by CI and a defect would
surface as either TestFlight spam or a silently dead ship pipeline.  As a script
it is syntax-checked and unit-tested by the `ios-fleet-ship-logic` job on every
PR.

**Unreachable last-ship sha falls back to the recorded timestamp.**  This is not
hypothetical.  Usage-Monitor's recorded ship sha today is `27b89434`, the tip of
a `grok/*` ship worktree — not an ancestor of `main` at all.  Skipping forever
on that would be a backstop that never backstops; shipping blind would be the
spam the owner rejected.  The state file also records a unix timestamp, so the
gate falls back to "has any commit touching this app landed since the last
successful ship".  Verified against the real state files: Congress.Trade votes
ship (iOS work from PR #1835 landed via a bot merge and was never shipped —
exactly the defect), Usage-Monitor votes skip.

**The runtime-drift check is now advisory, not a gate.**  This job ships through
`scripts/ios-ship-testflight.sh`, which resolves the **in-repo** fleet copy, so
runtime drift cannot change what this run builds; it only misleads the owner's
manual "ship now" button.  Two things make failing the job wrong now: the drift
is real and **not repairable from inside this repo** (as of today the runtime
`ship-all.sh` is BEHIND the repo copy — it still skips `usage-local` — while the
runtime `apps.json` is AHEAD, carrying a `dealdex` entry the repo lacks;
reconciling needs a write to `/Users/jay/apps/ios-fleet`, which no repo PR can
perform), and this workflow now runs on a cron, so a blocking check would paint
the repo red every half hour while shipping nothing.  It stays loud — a warning
annotation plus a job-summary block on every ship.  Restore `exit 1` once the
runtime copy is reinstalled from the repo.

**Layer 1 trades a silent failure for a loud one.**  With auto-merge unarmed, a
PR whose author forgets to arm it sits open.  That is visible on the PR list and
recovered with one command, which is strictly better than today's silent
unverified merge — and Layer 2 covers `main` in the meantime.

**Not done here, deliberately:** no credential was created.  The permanent fix
is an owner-supplied `GH_PAT`; the code already waits for it.

## 4. Verification State

No application code changed — the diff is CI YAML plus two new bash scripts.

```
python3 -c "import yaml; ..."   # all four workflow files parse
node scripts/check-actions-runner-policy.mjs
    -> Actions policy OK: 15 workflows use owned runners only.
bash -n scripts/ios-fleet/scheduled-ship-gate.sh
bash scripts/ios-fleet/test-scheduled-ship-gate.sh
    -> passed=13 failed=0
bash scripts/ios-fleet/test-ship-seq.sh
    -> passed: 43   failed: 0   (unchanged, no regression)
grep -nP '[^\x00-\x7F]' scripts/ios-fleet/scheduled-ship-gate.sh ...
    -> ASCII clean (Apple bash 3.2 safe)
```

The gate was also exercised read-only against the real repo and the real
`~/.cache/ios-fleet/` state, with no ship script executed and no workflow
dispatched.

## 5. Next Steps & Blockers

1. **Owner decision — add a `GH_PAT` secret** (fine-grained PAT or GitHub App
   installation token, `contents` + `pull_requests` write).  Both auto-merge
   workflows self-activate; no code change needed.  Until then, agents must land
   PRs themselves with `gh pr merge <n> --squash --auto`.
2. **Reconcile the runtime ios-fleet copy** at `/Users/jay/apps/ios-fleet`:
   land the runtime-only `dealdex` entry into `scripts/ios-fleet/apps.json`,
   then reinstall repo -> runtime so `ship-all.sh` stops skipping `usage-local`.
   Then restore the drift step to a hard failure.
3. Once the first scheduled ship records a `main`-based sha in
   `~/.cache/ios-fleet/last-ship-congress.txt`, the gate's timestamp fallback
   stops being exercised and the exact-diff path takes over.

## 6. Zero-Code Findings

- Confirmed empirically, not from the audit text: merge sha `c38b6787`
  (PR #1835, `merged_by=github-actions[bot]`) produced `total_count: 0` runs,
  while `ceaca097` (PR #1836, `merged_by=jaywedgeworth22`) produced 10, five of
  them `event: push`.
- `GH_PAT` and `SHEPHERD_TOKEN` exist in neither this repo nor Usage-Monitor nor
  Socratic.Trade, so Socratic.Trade's `secrets.GH_PAT || secrets.SHEPHERD_TOKEN
  || secrets.GITHUB_TOKEN` chain silently resolves to `GITHUB_TOKEN` and that
  repo has the identical defect.  Its `ios-ship.yml` cron is why it looks
  healthy.
- `bash scripts/ios-fleet/check-drift.sh` currently exits 1 (`ship-all.sh` and
  `apps.json`), so this repo's `ios-ship` job would have failed at that step on
  every run even once a trigger reached it.
