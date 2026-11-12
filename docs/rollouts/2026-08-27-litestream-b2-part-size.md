# 2026-08-27 — Litestream B2 multipart hardening: part-size 10MB + concurrency 2

## Context & Objective

Preventive port of a fix proven twice on Socratic.Trade (2026-08-07, 2026-08-22) and
deployed to Usage-Monitor today (UM PR #1368).  Large L1-compaction multipart uploads to
Backblaze B2 fail with `read multipart upload data failed ... checksum mismatch` on the
default 5MB part size, and every abort restarts the whole multipart.  On 2026-08-27 UM
sat in exactly that retry storm (119 failed compactions in ~2h) and burned through the
shared Backblaze daily transaction caps.  CT's `app/litestream.yml` had the same
exposure: no `part-size` override, `concurrency: 1`.

## Changes Made

- `app/litestream.yml` — replica block: added `part-size: 10MB`, raised `concurrency`
  1 → 2, comment records the failure signature and precedents.

## Decisions & Trade-offs

- Mirrors ST's `litestream.coolify.yml` values exactly; no cadence change
  (`sync-interval: 5m` stays), no retention change, no addressing change.
- Config-only; the container picks it up on the next deploy.

## Verification State

- YAML-only diff; CI (typecheck + tests) gates the merge.  No schema change — the
  auto-migrate trap does not apply.
- Post-deploy proof: container logs show clean `compaction complete` entries with no
  `checksum mismatch` lines.

## Next Steps & Blockers

- None for CT.  Fleet-wide follow-up lives with the owner: confirm whether the three
  B2 buckets share ONE Backblaze account (shared daily cap), and consider raising the
  cap — a hard daily cap trades cents of savings for silent multi-day backup gaps.
