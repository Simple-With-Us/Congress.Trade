# 2026-08-14 — Publish-loop halt is not OpenRouter quota

## Live cause (`congress-app-c11c5`, `/data/congress-trade/db.sqlite`)

Owner: OpenRouter quota is fine.  Health still said `autopilot_halt
error_class:quota` and ~309 failed outbox items.

**Real halt:** autopilot run `fdadd07b-…` halted at 2026-08-10T03:31:03Z after
2 docs, `spend_microusd=0`, `error_class_counts={"quota":2}`.  The sample
error is the budget-circuit wrapper around OpenRouter **HTTP 402** “This
request requires at least $0.50 in balance for files”
(`limit_source=openrouter_key_limit`).  That is a **files-endpoint prepaid
minimum**, not an account quota.  The run was never acknowledged, so health
kept repeating a four-day-old receipt.

Extraction 0/24h (last row 2026-08-11).  Review backlog 220.  Health marked
`extraction_provider` **ok** because attempts=0.

**309 `ingestion_outbox` failed** are all `consumer retry budget exhausted;
received by ingest-dlq` (retryable).  Separate durable-queue poison
(`invalid ingest queue message type: filing.local_wait_check`) is left
failed.

## Code

1. `classifyProviderErrorClass`: rate-limit / stale circuit / transient 403
   are not quota.  Circuit wrappers peel `last:` (402 files-balance →
   billing).
2. Health rewrites the stored halt via `describeAutopilotHaltReason`.
   `extraction_provider` is not ok when attempts=0 and (halted or review
   backlog > 0).
3. Bounded transient requeue: `requeueTransientFailedIngestionOutbox` /
   `requeueTransientFailedDurableJobs`, admin `transientOnly: true`, script
   `app/scripts/requeue-transient-dlq.mjs`.

## Operator

After deploy, acknowledge the stale halt
(`POST /api/admin/autopilot/acknowledge`) so a new run can start.  Dry-run
the 309 outbox rows with the script before `--apply`.
