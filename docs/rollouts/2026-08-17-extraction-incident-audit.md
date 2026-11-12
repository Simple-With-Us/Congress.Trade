# 2026-08-17 — Extraction incident audit + safety semantics

## Summary

Jay asked for one production incident audit and the safety fixes in a single branch.  Live `/api/health` was `stalled` on SHA `be53b3e5` with autopilot halted since 2026-08-10T03:31:03Z (`fdadd07b-…`, stored `error_class:quota`, never acknowledged).  Extraction was 0/24h.  Health still said “Review backlog normal (9 items)” because it counted only the autopilot-eligible slice.

This change does **not** bulk Confirm/Reject extracts and does **not** mutate filing truth.

## Root causes (verified)

1. **Aug 10 OpenRouter Files 402** — funded paid key (`is_free_tier=false`, lifetime usage ~$41.67) with a **$2/day key limit**.  Files API requires a $0.50 prepaid hold billed against that key limit (`limit_source=openrouter_key_limit`).  Safe identity only: prefix `sk-or-v`, sha256_12 `450ceab9559f`, last4 `3aa7`.  The 402 was stored as quota, halted autopilot, and the halt required a human ack — a permanent silent latch after the circuit cool-down.
2. **`local_mac_1` is supplemental** — Mac vision worker (`WORKER_ID` default).  After 3 attempts it parked `local_vision_exhausted` and pending excluded the doc.  Hosted `filing.extracted` was not enqueued, so there was no fallback to the normal LLM path.  Autopilot was halted anyway.
3. **Health under-counted** — `countEligibleBacklog` hid 210 suppressed/terminal rows.

Per-document catalog: `docs/audits/2026-08-17-extraction-incident-catalog.md` (JSON companion alongside).  Official Clerk FD ZIP 2021–2026: **219/219** unresolved review docs are live PTR DocIDs.  Silently ignored official filings: **0**.

## Files changed

- `app/src/extraction/reviewQueueHealth.ts` — disjoint eligible / suppressed / terminal counts
- `app/src/shared/pipelineHealth.ts` — any unresolved review row is `extraction_backlog` stalled
- `app/src/extraction/providerHealth.ts` — transient files-prepaid detector (not bare circuit / not depleted credits)
- `app/src/shared/openRouterBudgetCircuit.ts` — bound transient opens (`MAX_TRANSIENT_CIRCUIT_OPENS=6`); do not extend forever
- `app/src/extraction/autopilot.ts` — skip kill-switch latch for files-prepaid; auto-ack only those halts; Pushover on halt
- `app/src/ingestion/autonomySweeps.ts` — hosted fallback sweep; liveness alarms include `autopilot_halt` / `extraction_provider` / `extraction_backlog`
- `app/src/admin/routes.ts` — park enqueues hosted `filing.extracted`
- `app/src/ui/dashboardHtml.ts` — red Extraction Halted banner + Acknowledge Halt
- tests for the above
- audit catalog + this rollout

## Verification

```bash
cd app && npm run typecheck && npm test
```

After deploy, next cron tick should auto-ack the stale files-prepaid halt (`actor: auto_resume:files_prepaid`) and start a new run.  Do **not** bulk-resolve the 219 review rows.

## Follow-ups (separate controlled ops)

- Manual filing review of the 219 House scanned PDFs
- Re-ingest the 16 House PTRs that were stamped phantom on 2026-07-30 and now appear in 2026FD.ZIP
- Senate 90 classified eFD docs once extraction is running
- 316 ingest-dlq outbox rows (already have a transient requeue path)
- Consider raising the OpenRouter **key** daily limit above the Files $0.50 hold (owner billing decision)
