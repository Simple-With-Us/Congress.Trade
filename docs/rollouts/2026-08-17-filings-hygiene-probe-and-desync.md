# Rollout: filings hygiene for #1576 and #1574

## Summary

Adds a reviewed, dry-run-default admin path to clean two leftover production data issues from the 2026-08-09 autonomy diagnosis:

- **#1576** — delete the manual test-probe filing `S-grok-probe-should-not-exist-zzzz`
- **#1574** — stamp `filings.ingest_status` to match already-resolved `review_queue` rows (the 547-row desync)

This change does **not** write production from the agent VM.  After merge + deploy, an operator with `ADMIN_TOKEN` runs a dry-run, reviews the preview, then applies.

The hourly `autonomy-sweeps` desync pass now uses the same mapping.  It no longer stamps the invalid ingest status `published` (the real terminal status for a confirmed/published filing is `persisted`).

## Mapping

| review_queue.resolution_kind | filings.ingest_status |
|---|---|
| `published` | `persisted` |
| `rejected` | `error` |
| `verified_empty` | `verified_empty` |
| `orphan_deleted` | `error` |

Legacy rows without `resolution_kind` fall back to the latest `ingestion_decisions.action`, then to live-transaction presence.

Probe delete is exact-doc_id only.  It refuses if any `transactions` rows exist for that id, and it never matches a real Senate/House/OGE filing.

## Files changed

- `app/src/ingestion/reviewStatusReconcile.ts` — mapping + dry-run/apply job
- `app/src/ingestion/autonomySweeps.ts` — hourly sweep uses the honest mapping
- `app/src/admin/routes.ts` — `POST /api/admin/filings-hygiene`
- tests under `app/src/ingestion/__tests__/` and `app/src/admin/__tests__/filingsHygiene.test.ts`

## How to run (after this lands on main and Coolify deploys)

Use a browser User-Agent.  Cloudflare's managed challenge blocks the default curl UA (see `AGENTS.md`).  Do not invent credentials.

```bash
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
TOK=$(grep -m1 '^CT_ADMIN_TOKEN=' ~/.secrets/global-api-keys | cut -d= -f2-)

# 1. Preview only
curl -sS -A "$UA" -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -X POST "https://congress.trade/api/admin/filings-hygiene" -d '{}'

# 2. Apply after the preview looks right
curl -sS -A "$UA" -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -X POST "https://congress.trade/api/admin/filings-hygiene" -d '{"apply":true}'
```

Expected dry-run shape:

- `dryRun: true`, `applied: false`
- `probe.found` true or false; `probe.deleted` false
- `probe.related.transactions` must be `0` or apply will refuse the delete
- `desync.sample` lists current → target status with a basis string

## Verification

```sql
SELECT COUNT(*) FROM filings WHERE doc_id = 'S-grok-probe-should-not-exist-zzzz';
-- 0 after apply

SELECT COUNT(*) FROM filings f
 JOIN review_queue rq ON rq.doc_id = f.doc_id AND rq.resolved = 1
 WHERE f.ingest_status IN (
   'new','fetched','classified','extraction_pending_local','extracted','needs_review','published'
 )
 AND f.doc_id NOT LIKE 'provider-missing-%';
-- 0 after apply (or only leftover rows the next hourly sweep will finish)
```

Re-running apply is a no-op.

## Follow-ups

- Operator apply on production after review of the dry-run payload
- Close #1576 and #1574 once the apply receipt is confirmed
