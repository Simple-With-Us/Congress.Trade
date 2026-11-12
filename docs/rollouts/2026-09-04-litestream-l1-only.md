# 2026-09-04 — Litestream L1-only levels (disable L2/L3)

## Context

Socratic.Trade and Usage-Monitor already pin `levels: [{interval: 30s}]` so Litestream 0.5 MaxLevel()=1 (L2/L3 off).  Congress.Trade `app/litestream.yml` had no `levels:` block, so DefaultConfig still ran L1@30s / L2@5m / L3@1h.

Shared Backblaze Class B download caps were burned by L2 mega-compaction GetObject retry storms (ST peak ~8/29–9/1; fleet-wide).  Raising the daily download cap is a symptom fix.  Removing L2/L3 is the backoff.

## Change

- `app/litestream.yml`: add top-level `levels: [{interval: 30s}]` before `dbs:` (mirror ST/UM).
- Keep `sync-interval: 15m`, `part-size: 10MB`, `concurrency: 2`, snapshot 24h/168h.
- Do **not** add `verify-compaction: true`.

## Ops

- Housekeeper may apply the same levels live via host overlay before this image bakes.
- No Coolify mutate from this PR; normal image rebuild picks it up.
- No B2 deletes in this change.
