# Rollout — Git History Secret Scrub + Repo Goes Public (Apache 2.0) — 2026-07-29 (KIMI)

## Summary
Owner-directed (all secrets already rotated): full git-history scrub of committed
secrets, then the repo flipped public under Apache 2.0.

## What was done
- **Scan**: gitleaks full-history scan (1,736 commits, ~147 MB) found 79 findings /
  27 unique secrets — incl. previously unknown committed env file `app/.prod.vars`,
  a Stripe access token, a JWT, and tokens embedded in old scripts
  (`delete_revisions*.py`, `app/scripts/run_export.sh`, `app/delete_workers.sh`,
  `app/scripts/test-fmp.mjs`, hoard scripts).
- **Scrub**: git filter-repo `--replace-text` (27 literals → `***REMOVED***`) plus
  `--invert-paths` removal of `app/.env.prod`, `app/.prod.vars`, `app/prod.env`
  across **all refs** (10 branches). Verified: gitleaks re-scan of rewritten
  history → **0 leaks**.
- **Push**: branch protection backed up → deleted → `push --force` all heads →
  protection restored byte-identical (checks `typecheck + test` + `gitleaks`,
  enforce_admins, no force-push).
- **License/public**: Apache 2.0 LICENSE added (PR #1138, canonical text from
  GitHub license API); repo visibility flipped to **public**; GitHub detects
  `Apache-2.0`.
- **Local purge**: pre-scrub mirror backup + scan reports (contained secret
  values) deleted; reflogs expired + `git gc --prune=now` in active worktrees.

## Verification
- `gitleaks git` on rewritten history: no leaks found.
- Remote `main` = scrubbed history (same content, new SHAs); CI green on the
  LICENSE PR post-rewrite.
- `gh api repos/...` → `visibility: public`, `license: Apache-2.0`.

## Known remnants / follow-ups
- **GitHub server-side**: PR diffs and `refs/pull/*` still contain pre-scrub
  content (e.g. #1126's diff shows the old `.env.prod`). All affected secrets are
  ROTATED, so exposure is inert. For physical removal, owner must file a GitHub
  Support sensitive-data purge (account-bound; agents cannot).
- **Local machine**: ~300 stale local branches in the shared object store
  (all agents') still pin old-history objects. Fleet was told to re-clone fresh;
  old clones should be deleted as agents cycle. Secrets there are rotated.
- Pre-scrub safety backup was held at /tmp during the operation and deleted
  after verification.

## Fleet impact
- History rewrite diverged every local branch/clone — #ag***-s**c freeze notice
  posted before, all-clear + re-clone instructions after. Open PR #1129 (AG)
  needs recreation from a fresh clone.
