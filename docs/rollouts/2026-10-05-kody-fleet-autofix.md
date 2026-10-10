# Kody Fix Proposal Caller: Disabled Setup

## Summary

Prepare this repository's caller for the shared Kody fix-proposal workflow.  It is disabled: `daily_attempt_limit: 0`, `budget_policy_id: pending`, and an explicit enable variable is also required.  No provider credential, environment, or activation setting is configured here.

The owner approved this task-specific handoff instead of historical effort-log/status updates for this setup draft.  Existing records are unchanged.

## Files and scope

- `.github/workflows/kody-fleet-autofix.yml`
- This handoff note
- Repository identity: `1275616664`
- Candidate profile: `web`; paths: `app/src/`
- Local job-definition source snapshot: [reviewed draft #336](https://github.com/Simple-With-Us/congress-trading-shared/pull/336), commit `8ef33de1953158f26b2fd872b8d1bc045032844e`
- Executable helper pin: `b9a84788524243c9ec10ba7a6604c479cd4cfffb`
- Base inspected: `fc023dce07a5fba36209fcb636bde2cecd916b36`

The shared helper applies additional extension and sensitive-path exclusions, verifies the Kody app/bot and live same-repository PR/head, scans selected content, and deduplicates attempts.  It creates separate draft child PRs against feature branches; it does not push to the original branch, merge, enable auto-merge, or resolve review threads.

## Verification

- Passed: 65 shared controller/generator tests, including fork/head rejection, explicit zero/pending gates, bounded proxy requests, and create-only publication.
- Caller YAML, immutable pin, repository identity, source scopes, and disabled defaults are checked offline before publication.
- This repository's complete application/native checks have not been run locally for this workflow-only draft.  Hosted CI and review remain prerequisites to merge; no green result is assumed.
- No live fixer run or provider request was made for validation.

## Follow-ups

The current shared pin implements the initial DeepSeek route only.  MiniMax routing and future budget integration remain pending in [Usage-Monitor #1602](https://github.com/Simple-With-Us/Usage-Monitor/issues/1602); the separate budget service is paused.  Keep this caller disabled until its replacement, secure configuration, and repository-specific validation are reviewed.

A generated child PR may not match CI filters limited to main.  Missing checks are not a pass: validate its exact proposed SHA without provider credentials before adoption.  Per-repository attempt slots do not guarantee a fleet-wide dollar ceiling or a lossless queue.

## Locally Auditable Runner Adapter

The first draft's reusable-workflow call failed the repository's unchanged runner policy.  This caller now contains the same four job definitions locally, derived from shared workflow commit `8ef33de1953158f26b2fd872b8d1bc045032844e`.  All runners are literal `ubuntu-latest`; action/helper pins, job permissions, timeouts, artifact checks, and provider isolation are preserved.  Only trusted public helper code is fully checked out.  No target-PR checkout or policy exemption is introduced.

The prepare condition explicitly requires `0 > 0` and a non-pending policy, so it remains disabled even if the enable variable is true.  The helper environment independently retains `DAILY_ATTEMPT_LIMIT: '0'` and `BUDGET_POLICY_ID: pending`.  All downstream jobs depend on prepare.  Future activation must review both copies of those values together; this adapter does not implement MiniMax routing or a fleet budget.

Verification includes the unmodified repository runner-policy script, offline YAML/job equivalence and privilege assertions, and an independent review.  Full application CI remains separately required.

## Publication Identity and Required CI

The publisher uses the repository's `GITHUB_TOKEN`, not the Kody review identity.  Current `security.yml` and `docs/CI-BOT-PR-POLICY.md` already admit same-repository runs triggered by `github-actions[bot]`; no new bot allowlist is introduced.

[GitHub's current trigger documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow) distinguishes ordinary token-authored pushes, which do not trigger workflows, from PR opened/synchronize/reopened events, which can create approval-required runs.  Therefore neither automatic validation nor permanent impossibility is assumed here.  Before activation, verify the generated child's exact SHA receives every required check, including any write-authorized human approval needed to start those runs.  Missing, skipped, cancelled, or unapproved checks do not satisfy that validation requirement.

A different publisher credential, a new bot identity, or an allowlist change requires separate owner approval and security review.  This draft adds none of them and does not request a PAT or workflow-dispatch permission.

Future updates must refresh and revalidate these local job definitions and the executable helper pin as appropriate.  Changing only the provenance comment does not update executable code.
