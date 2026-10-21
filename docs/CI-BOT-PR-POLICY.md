# Bot-authored pull requests

## Trusted bot set (owner ruling 2026-10-20)

All `swu-*` fleet bots are trusted CI actors, alongside the review bots below.
The authoritative list is the `allowed_bots` value the autofix callers pass
(`.github/workflows/autofix.yml`, `.github/workflows/claude-code-autofix.yml`);
every trusted-bot gate must be derived from that one list so the sets cannot
diverge.  `.github/workflows/security.yml` now enumerates the same set
(`kody-ai[bot]`, `claude[bot]`, and one `swu-*` entry for the whole fleet),
so the gitleaks gate and the autofix allowlists name the same trusted actors.

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
