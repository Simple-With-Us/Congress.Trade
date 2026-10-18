# Sanitized Autofix Diagnostics

Run this composite action after the pinned Claude Code action.  It reads only
`$RUNNER_TEMP/claude-execution-output.json` and writes
`$RUNNER_TEMP/claude-autofix-diagnostics/diagnostics.json`.  Invoke the action
with `if: always()`; its reducer step also uses `always()` so the original
Claude failure remains the caller's step conclusion.

The transcript must be a regular, non-symlink file directly inside the
canonical `RUNNER_TEMP`, and must be at most 16 MiB.  Output goes into a new
mode-0700 directory with a mode-0600 file, and is capped at 256 KiB.  Missing,
unsafe, malformed, oversized, and write-failure cases produce fixed
availability codes.  No prompts, text, inputs, outputs, paths, tool IDs,
model strings, or raw exceptions are emitted.

Each assistant SDK message receives a zero-based `assistant_message_index`.  This is a transcript message index, not an SDK turn index.  Tool result events
have a null assistant message index because their SDK message is a user
message.  Event indexes are zero-based across tool-use and tool-result events.  Repeated call groups are assigned in first-seen order using the original tool
name, sanitized category, and bounded serialized input, only in memory;
signatures and original tool names are never written.  Opaque or large inputs
each form their own group.  Only a fixed builtin tool allowlist is retained;
all named MCP tools collapse to `mcp`, and unknown names to `other`.

The version-2 output contract is a JSON object with `schema_version`, fixed
`availability`, bounded `counts`, sanitized aggregate `result`, and at most
500 `events`.  Every tool event has a fixed `operation_category`, copied from
the tool use to its paired result.  `counts.operation_uses` and
`counts.operation_errors` contain bounded counts for every fixed category,
including `other` for unpaired results.  Builtin Read, Write, Edit, Glob, and
Grep tools receive fixed categories; every Bash call is `shell_other` without
inspecting its command.  Other fixed category keys remain in the schema for
compatibility, but do not imply that shell purposes or file mutations are
known.  Repeated calls can be useful and do not prove semantic duplication.  No command text, arguments, paths, custom scripts, prompts, or results are
emitted.  Result subtype is allowlisted;  `result.is_error` preserves a boolean
failure flag independently of subtype, or null when absent/invalid.  Error classification reads at most 8,192 characters from a string or the first
128 array text blocks, then emits only a fixed category.  Duration accepts nonnegative
safe integers capped at one day, and turn counts accept nonnegative safe
integers capped at 1,000,000.  Per-tool timing is not available.  Action outputs are the
sanitized `summary-path` and fixed `status`.  The caller must upload only the
summary file; it must never upload the source transcript as an artifact.

If the runner kills the job at its hard timeout, the always-run reducer and
artifact upload may not finish.  This helper cannot guarantee an artifact
after a runner shutdown.

Run focused tests with:

```sh
node --test .github/actions/autofix-diagnostics/test/reduce.node-test.mjs
```
