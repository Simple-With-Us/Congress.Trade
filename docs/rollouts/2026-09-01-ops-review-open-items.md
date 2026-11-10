# 2026-09-01 — CT August ops leftovers: newest-first order, dead-letter health, NTR, stream hint

## Summary

Closes the still-open product defects from the 2026-08-31 Congress.Trade ops review that were not already fixed on main.

## Why

- `GET /api/transactions?order=desc` (and `/api/feed.xml`) sorted by ingest `cursor_seq`, so a 2024 Khanna backfill with a high cursor occupied public page 1 (#2180).  The web Trades tab hid this behind a 3-month window; API, RSS, and Delivery snapshot consumers did not.
- `/api/health` treated any `ingestion_outbox.status='failed'` row as live degradation, so 81 parked dead-letter items kept the summary `degraded` forever and would mask a new stall (#2182).  Same failure mode as the 17-day latency-monitor page.
- NTR phrase matching was a single `/nothing to report/` regex.  Handwritten OCR variants never reached `verified_empty`.  The Hal Rogers row itself was already backfilled on main (#2269); this hardens the detector.
- `GET /api/stream` 400 `{error: missing ?subscription=}` was correct but undocumented.  Apple webhook mount was already live (`signedPayload required`, route-inventory test on main).

## Files

- `app/src/delivery/rows.ts` — `order=desc` without an explicit sort uses `COALESCE(t.first_seen_at, t.filed_date, t.tx_date, t.cursor_seq)` (columns on `transactions`, nested keyset stays cheap).  `sort=cursor` restores ingest-newest.
- `app/src/shared/pipelineHealth.ts` — only **fresh** DLQ rows (updated in 24h, not `parked:`) degrade.  Triaged count stays in the detail string.
- `app/src/extraction/extractRouting.ts` — broader NTR phrase / OCR-glitch matching.
- `app/src/delivery/rest.ts` — stream 400 hint; comment on newest-first snapshot order.

## Verification

```bash
cd app && npx vitest run src/delivery/__tests__/buildTransactionsQuery.test.ts \
  src/delivery/__tests__/newestSnapshotOrder.test.ts \
  src/delivery/__tests__/feedXml.test.ts \
  src/delivery/__tests__/freemiumGating.test.ts \
  src/shared/__tests__/pipelineHealth.test.ts \
  src/extraction/__tests__/extractRouting.test.ts \
  src/delivery/__tests__/publicCors.test.ts
cd app && npm run typecheck && npm test
```

Live after deploy: `GET /api/health` `ingestion_dead_letter` should be `ok` with a triaged count (not `degraded` at 81) unless a failure is younger than 24h.  Unwindowed `order=desc` must not lead with 2024 backfill when a later `first_seen_at` exists.

## Follow-ups

- Host-install of merged PR #1964 (`ct-deploy-overlap`) on fleet-hetzner-nbg1 — still the deploy-window 502 root cause.
- Replay or `park:`-prefix the 81 production outbox rows so they drop out of even the triaged count if desired.
- House 2025 ZIP backfill (#1607) is still the largest coverage gap.
- 34-secret history scrub (#2166) still needs a rewrite verify + rotation, not a code change.
