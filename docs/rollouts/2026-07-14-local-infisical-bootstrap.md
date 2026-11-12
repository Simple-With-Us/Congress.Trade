# Local Infisical bootstrap wiring

## Summary

`scripts/cloud-setup.sh` now safely translates the canonical machine-level
Congress.Trade Infisical identity names into the `INFISICAL_APP_*` and
`INFISICAL_SHARED_*` names consumed by the Worker. The helper reads only
Infisical bootstrap assignments from the optional local key file; it never
sources or evaluates that file and never prints values. Provider keys are not
copied from either the machine-level file or the process environment. The only
non-Infisical process values retained are the three synchronous Sentry init
keys plus `ADMIN_OPEN_IN_DEV` and `USAGE_MONITOR_ENVIRONMENT`, which together
are required for the documented local-admin escape hatch.

Resolution order preserves existing non-empty `.dev.vars` values, then explicit
runtime-name environment pairs, then canonical CT environment aliases, then the
owner-only machine-level file (no group/other permission bits; exact `0600` is
recommended, not required). Existing non-empty managed values are not replaced;
remove or empty one deliberately before re-running setup to rotate it locally.
Incomplete identity pairs fail before dependency installation. The known
Congress.Trade (`<CT_INFISICAL_PROJECT_ID>`)
and shared (`<SHARED_INFISICAL_PROJECT_ID>`) project IDs are defaults only
when their corresponding complete identities are present.

Existing `.dev.vars` parsing is scoped to keys the helper manages. Unrelated
Wrangler dotenv 16.3.1 lines—including colon assignments, lowercase/mixed-case
keys, inline comments, quotes with escaped backslashes, backticks, CRLF endings,
and multiline values—are preserved byte-for-byte. Imported values are written
only after an exact parse/encode/parse round trip; values with no lossless
single-line representation fail closed without creating or replacing the file.
Generic ambient path variables cannot redirect setup output: only namespaced
test inputs behind an explicit test mode exist, and `cloud-setup.sh` unsets
those controls before invoking the helper. Filesystem checks use `lstat` with
explicit `ENOENT` handling, allowing missing files while rejecting valid and
broken symlinks for both the machine key file and `.dev.vars`.

## Files changed

- `scripts/cloud-setup.sh`
- `scripts/merge-local-dev-vars.mjs`
- `app/scripts/__tests__/local-bootstrap.test.mjs`
- `app/.dev.vars.example`, `app/README.md`, `app/DEPLOY.md`
- `app/docs/config-registry.md`
- `AGENTS.md`

## Verification

- The focused test runs the helper against isolated temporary files, covering
  canonical and legacy shared names, explicit overrides, existing-value
  preservation, project defaults, incomplete-pair rejection, file permissions,
  valid/broken symlink rejection, narrow non-provider env imports, scoped
  managed-key parsing, byte-preserved unrelated dotenv content (including
  colon-delimited and backslash-sensitive multiline shields), lossless imported
  quotes/backslashes/literal escapes/tabs, unrepresentable-value rejection,
  ambient path-override rejection, and inert parsing of shell-looking text.
- A read-only local smoke against `$HOME/.secrets/global-api-keys` writes nine
  expected bootstrap names to a temporary mode-`0600` file without exposing
  their values or touching the real app worktree configuration.
- `bash -n scripts/cloud-setup.sh`, `node --check
  scripts/merge-local-dev-vars.mjs`, app typecheck, and app tests are the landing
  gates.

## Follow-ups

- No production Infisical, Cloudflare, provider, or deployment state changes in
  this lane. Production bootstrap names remain `INFISICAL_APP_*` and
  `INFISICAL_SHARED_*`.
- The dirty Antigravity checkout and its untracked Infisical utility scripts are
  intentionally outside this change.
