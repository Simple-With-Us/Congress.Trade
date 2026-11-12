# Bot-authored pull requests

## Trusted bot set (owner ruling 2026-10-20)

All `swu-*` fleet bots are trusted CI actors, alongside the review bots below.
The authoritative list is the `allowed_bots` value the autofix callers pass
(`.github/workflows/autofix.yml`, `.github/workflows/claude-code-autofix.yml`).
The two gates are related but NOT the same set (Kody on #2823):
`.github/workflows/security.yml` matches an unbounded `swu-*` glob and
additionally admits `dependabot[bot]`, `renovate[bot]`, `codex[bot]`, and
`github-actions[bot]`, which the autofix callers do not; the autofix
`allowed_bots` enumerates the specific installed `swu-*` bots and adds
`sentry` (no `[bot]` suffix), which the glob does not match.  The gitleaks
gate trusts broadly to avoid blocking security scans; the autofix callers
trust narrowly because they run code on the fleet.

The `swu-*` entry has to keep its glob unquoted and its suffix quoted
(`swu-*'[bot]'`): quoting the whole pattern makes bash match it literally, so
the glob never fires and every `swu-*` bot PR is rejected by the gitleaks
gate.  That is an owner-side workflow edit, so autofix agents do not change
`.github/workflows` — they record the invariant here instead.

The claude-code autofix path runs on its own budget: the pinned reusable has
no trusted-policy loader and no iteration cap, so the caller passes
`claude_args: "--max-turns 60"` and the session budget matches the
`max_turns: 60` recorded in `.github/pr-autofix-trusted.yml` instead of the
reusable's 120-turn default.

The trust-boundary fix for the PR-branch `.autofix.yml` override landed
upstream in `AI-Fleet-Coordinator` #776 (`2f7d5b1`): the trusted list is read
from the default branch, and a PR branch's `.autofix.yml` may only narrow it.
This repository still pins the pre-fix reusable (`b634b511`), so the branch
file can still replace the list here and the root-`.autofix.yml` ban in
`scripts/check-actions-runner-policy.mjs` remains the protection until the pin
moves.  The pin bump is owner-side (a `.github/workflows` edit, which autofix
agents do not make) and comes with a second lockstep requirement: the
post-#776 reusable records each bot's one run per PR in a marker comment on
the PR, so the caller has to grant `issues: write` — a called workflow's
permissions can only narrow the caller's, so without that grant the marker
write is refused and the autofix lane fails.  The policy script already
allowlists the new pin and fails a caller that forgets the grant.

## The gate

The Security/gitleaks workflow admits same-repository PR runs triggered by the
trusted bot set: `cursor[bot]`, `dependabot[bot]`, `renovate[bot]`,
`sentry[bot]`, `codex[bot]`, `chatgpt-codex-connector[bot]`, `kody-ai[bot]`,
`claude[bot]`, and `github-actions[bot]`, plus the `swu-*` fleet entry.  They
still run normal secret scanning and
all other required checks and reviews; admitting a bot is not approving its
code or its merge. The admission gate checks the event `github.actor`, not an
immutable PR-author field. Unknown `[bot]` actors need an owner-approved
allowlist change. Fork PRs remain rejected before checkout.

Keep `.github/workflows/security.yml` aligned with this policy. This note does
not claim other workflows use the same gate or that any deploy-key secret is
present; verify each workflow's current credentials before widening its access.

`chatgpt-codex-connector[bot]` is the observed Codex GitHub reviewer account;
`codex[bot]` remains for compatibility with the earlier requested name.
GitHub uses the event initiator as `github.actor`, so review authorship by itself
does not prove that every Codex-generated PR run uses this actor.
