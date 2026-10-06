# Kody Fix Proposal Caller: Disabled Setup

## Summary

Prepare this repository's caller for the shared Kody fix-proposal workflow.  It is disabled: `daily_attempt_limit: 0`, `budget_policy_id: pending`, and an explicit enable variable is also required.  No provider credential, environment, or activation setting is configured here.

The owner approved this task-specific handoff instead of historical effort-log/status updates for this setup draft.  Existing records are unchanged.

## Files and scope

- `.github/workflows/kody-fleet-autofix.yml`
- This handoff note
- Repository identity: `1275616664`
- Candidate profile: `web`; paths: `app/src/`
- Shared workflow: [reviewed draft #336](https://github.com/Simple-With-Us/congress-trading-shared/pull/336), pinned to `8ef33de1953158f26b2fd872b8d1bc045032844e`
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
