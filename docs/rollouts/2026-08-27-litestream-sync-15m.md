# 2026-08-27 — Litestream sync-interval 5m -> 15m (shared B2 account)

## Context & Objective

Owner confirmed (2026-08-27) that ST, CT, and UM all back up to ONE Backblaze
account, so its daily Class B/C transaction caps are fleet-wide — UM's corrupt-L0
retry storm this morning froze every app's backups at once.  Owner asked for a
backup-frequency reduction; CT is the safe app to coarsen since its data is
re-ingestable from providers.

## Changes Made

- `app/litestream.yml` — `sync-interval` 5m -> 15m, with comments recording the
  shared-account rationale and the burst caveat (heavy ingestion still produces
  L0 objects per commit regardless of interval).
- `docs/EFFORT-LOG.md`, `STATUS.md` — protocol rows.

## Decisions & Trade-offs

- 15m RPO on CT costs little (re-ingestable data) while cutting quiet-period
  object count and the downstream compaction re-reads (the actual Class B
  consumers) 3x versus 5m.
- ST deliberately stays at 300s (live trading DB — RPO is the point); UM is
  already 1h.
- Upload (Class A) frequency itself is uncharged on B2; the win here is fewer
  objects to list and re-read during compaction.

## Verification State

- Config-only change; no code paths.  Picked up on next CT deploy.
- Verify after deploy: container log line `replicating to ... sync-interval=15m0s`.

## Next Steps & Blockers

- Owner console action (recommended, not agent-actionable): raise the shared
  B2 account's daily caps to a small dollar ceiling (~$1-2/day) so drills and
  compaction cycles never silently freeze all three apps' backups again.
