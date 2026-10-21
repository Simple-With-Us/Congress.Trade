# Bot-authored pull requests

## Trusted bot set (owner ruling 2026-10-20)

All `swu-*` fleet bots are trusted CI actors, alongside the review bots below.
The authoritative list is the `allowed_bots` value the autofix callers pass
(`.github/workflows/autofix.yml`, `.github/workflows/claude-code-autofix.yml`);
every trusted-bot gate must be derived from that one list so the sets cannot
diverge. `.github/workflows/security.yml` still carries the older, narrower
`case` list, so a `swu-*` bot PR (and `kody-ai[bot]`) is rejected today by the
gitleaks gate even though the same identity may drive an autofix session.
Extending that list is an owner-side workflow edit: autofix agents do not
change `.github/workflows`.

## The gate

The Security/gitleaks workflow admits same-repository PR runs triggered by
`cursor[bot]`, `dependabot[bot]`, `sentry[bot]`, `codex[bot]`, and
`chatgpt-codex-connector[bot]` (Congress.Trade also retains `github-actions[bot]`). They still run normal secret scanning and
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
