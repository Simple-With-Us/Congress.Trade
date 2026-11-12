# 2026-08-18 — RAW_FILES Unauthorized stalled new trades

## Summary

Public site and chamber polling were healthy.  New trades were not.  Latest transaction stayed at `2026-08-11T19:08:27Z` (~169h).  `GET /api/admin/filings/:id/raw` returned HTTP 500 `{"error":"Unauthorized"}`.  `scan-cpu-worker` tight-looped that 500 across the scanned-PDF backlog.  Autopilot was already unhalted (#1990).  The store itself was the break.

`AWS_ACCESS_KEY_ID` / `CLOUDFLARE_R2_ACCESS_KEY_ID` (same key, sha12 `eec8fb10db4a`) 401'd on `congress-trade-bucket`.  `R2_ARCHIVE_*` (sha12 `47e419f37410`) still listed, put, got, and deleted on that same bucket.  Copied the working archive pair onto `AWS_*` and `CLOUDFLARE_R2_*` in Infisical prod and `~/.secrets/global-api-keys`.  Restarted `congress-app` so the boot-time S3 client rebuilt.

After the restart: storage-smoke put/get/contents/delete 200.  Stored PDFs serve as `%PDF-1.5`.  Requeued 320 transient ingest-outbox rows (100 flushed immediately) and 272 `filing.new` durable jobs (1582 skipped as already pending).  Unauthorized filing errors 303 → 231 and falling.  Pipeline gained `fetched`/`classified` rows and hundreds of pending ingest jobs.

Quiver still 403 and Unusual Whales still 401.  Those are owner token renewals, not this store incident.

## Files changed

- `app/src/admin/routes.ts` — `/raw` maps store-auth failures to 503 without leaking provider text
- `app/src/admin/storageSmoke.ts` — report the first failure stage when cleanup also 401s
- `app/src/admin/__tests__/rawFileRoute.test.ts` — 503/500 contract
- `app/src/admin/__tests__/storageSmoke.test.ts` — put+cleanup both fail → stage put
- `services/scan-cpu-worker/worker.py` — stop the pending batch and back off 300s on store-auth 401/500/503

## Verification

- `POST /api/admin/storage-smoke` → `{ok:true, bytes:42}`
- `GET /api/admin/filings/H-2025-8221177/raw` → 200 PDF
- `POST /api/admin/ingest-requeue-failed` transient: 320 requeued, 100 flushed
- `POST /api/admin/queue-requeue-failed` `filing.new`: 272 requeued
- `npx vitest run src/admin/__tests__/storageSmoke.test.ts src/admin/__tests__/rawFileRoute.test.ts` — 9/9
- `npm run typecheck` — clean

## Follow-ups

- Owner: renew Quiver plan + Unusual Whales token.  Latency UptimeRobot stays DOWN until those 200.
- Watch `extraction_runs` and `transactions.created_at` as the requeued fetch/classify/extract drain.  Health will stay `stalled` until a new extraction_run lands.
- Mint a dedicated long-lived R2 object token later so RAW_FILES is not aliased to the weekly-archive key.  Do not use 7-day temp credentials.
