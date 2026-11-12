# 2026-09-13 — Stop auto-merge on public-fork PRs

Boards `8bff5ca2` `417fe5e2`.  Branch `fx/automerge-fork-guard`.

`auto-merge-prs.yml` ran on `pull_request_target` with `contents: write` and armed squash auto-merge on every non-draft PR, including forks, with no required review.

Now: `pull_request` plus same-repo guard.  The job does not arm auto-merge (GITHUB_TOKEN merge would suppress post-merge workflows).  Land with `gh pr merge <n> --squash --auto`.
