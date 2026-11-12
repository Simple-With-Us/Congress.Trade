# 2026-08-20 — Harden shared-dep auto-merge (no GH_PAT)

## Summary

`auto-merge-shared-dependency.yml` ran on `pull_request_target` with
`contents: write` and `pull-requests: write` and no same-repo / non-fork
guard.  A fork PR whose title or branch matched the shared-package regex
could take that write token.  Required `typecheck + test` skipped on forks,
and GitHub treats a skipped required check as satisfied, so a matching fork
PR could merge without tsc.

Jay's ruling: do not add `GH_PAT`.  `congress-trading-shared` is a public
repo and this app vendors it at `app/vendor/congress-trading-shared`, so
deploy and `npm ci` do not need a GitHub PAT.  The old workflow comments
that invited adding `GH_PAT` / `SHEPHERD_TOKEN` to re-arm auto-merge are
removed.  Auto-merge with `GITHUB_TOKEN` is still refused because that
merges as `github-actions[bot]` and suppresses every post-merge workflow
on `main`.  Same-repo shared-dep bumps land with
`gh pr merge <n> --squash --auto` under the owner's credentials, same as
today.

## Files changed

- `.github/workflows/auto-merge-shared-dependency.yml` — `pull_request`,
  same-repo guard, `contents: read`, no PAT, no auto-merge arming
- `.github/workflows/auto-merge-prs.yml` — same (it had the same PAT
  invitation and `pull_request_target`)
- `.github/workflows/ci.yml` — required Linux jobs run on fork PRs
- `scripts/check-actions-runner-policy.mjs` — forbid `pull_request_target`
  and `secrets.GH_PAT` / `secrets.SHEPHERD_TOKEN` in repo workflows

## Verification

```bash
node scripts/check-actions-runner-policy.mjs
rg -n 'pull_request_target|secrets\.GH_PAT|secrets\.SHEPHERD_TOKEN' .github/workflows
```

Policy script passes.  Uncommented workflow YAML has no `pull_request_target`
trigger and no PAT secret references.  Same-repo vendor bumps still match
the shared-dep title/branch check and are not blocked.

## Follow-ups

- `security.yml` `gitleaks` and `ios-build.yml` still skip fork PRs.  If
  those jobs are required, skipped still counts as satisfied.  Out of
  this slice (iOS keepout).
- Do not re-add `GH_PAT` to re-activate bot auto-merge.
