# CI Autofix Usage Report

Posts one Usage Monitor v2 usage event for a finished CI autofix run (UM-1593).  It reads the tool's own result file, never the model's text, and is best-effort:  every failure is a workflow notice or warning and the step always exits 0.

## What it sends

`POST https://usage.jays.services/api/ingest/usage` with `schemaVersion: 2` and `producerId: ci-autofix`.  One event per served model, `metricType: usage`, `unit: token`, `quantity` the token total.  The event id is `<repo>:<run id>:<run attempt>:<step>:<model>`, so a re-run of the same attempt cannot double count.

The UM-1592 canonical `ai` block had not landed when this was written, so the keys are flat metadata that mirror its proposed shape:  `ai.harness`, `ai.model.requested`, `ai.model.served`, `ai.tokens.{input,output,cacheRead,cacheWrite,cacheWrite5m,cacheWrite1h,reasoning}`, `ai.durationMs`, `ai.billingMode` (`payg`), and `ai.costSource`.  CI context rides as `repo`, `prNumber`, `runId`, `runAttempt`, `step`, `workflow`, `outcome` and `runUrl`.  Rename these in `report.mjs` when UM-1592 settles.

`harness` is `claude-code-ci`, `kody` or `codex-ci`.  `codex-autofix-reusable.yml` runs claude-code-action, so it reports `claude-code-ci` and says which workflow it was in `workflow`.

## Where the numbers come from

| Harness | Source | Notes |
| --- | --- | --- |
| `claude-code-ci` | the `result` message of `claude --output-format stream-json` (or the claude-code-action SDK array) | `usage`, `modelUsage`, `duration_ms`, `num_turns`.  `input` excludes cache reads and writes. |
| `kody` | `usage.json` written by `fleet.mjs generate` next to `answer.json` | The chat completion `usage` block.  Cached tokens are split out of `prompt_tokens`. |

Claude Code prices a model it does not know at a default Anthropic rate, so for MiniMax its `total_cost_usd` would overstate the bill.  The reporter therefore sends `costUsd` only when the served model id starts with `claude-`, and records any other figure as the metadata key `ai.cliReportedCostUsd`.  Usage Monitor can derive the cost from tokens.

## Credential

The `token` input is the organization secret `USAGE_INGEST_TOKEN`, which must hold a token scoped to the `ci-autofix` producer (an entry `ci-autofix:<token>` in the monitor's `USAGE_INGEST_PRODUCER_TOKENS`).  Reusable workflows declare it as an optional secret and callers forward it.  An empty token makes the step a quiet no-op, so shipping the workflow before the secret exists is safe.  The step masks the token and the reporter never prints it.

## Tests

```sh
node --test .github/actions/ci-usage-report/test/report.node-test.mjs
```
