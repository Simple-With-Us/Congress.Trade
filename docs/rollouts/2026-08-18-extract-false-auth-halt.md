# 2026-08-18 — False extract auth halt (bare Unauthorized)

## Summary

Cheap-first House extract (#1985) is already on a recent prod SHA, but
extract stayed dead because autopilot latched on `error_class:auth`.  The
newest halted row is **not** a dead OpenRouter key.  `classifyProviderErrorClass`
treated the HTTP 401 statusText `Unauthorized` (source-fetch / admin / Clerk)
as a credential failure.  Ingest already classifies `fetcher: Unauthorized`
as transient DLQ.

This change does **not** raise the $2/day OpenRouter key limit, does **not**
bulk Confirm/Reject review rows, and does **not** mutate filing truth.

## Receipt (read-only `POST /api/admin/debug-sql`, 2026-08-18)

Newest halted run `b315b98d-4312-43cf-973c-aa8373898f32`:

| Field | Value |
|---|---|
| status | `halted` (unacknowledged) |
| halt_reason | `error_class:auth` |
| sample_errors | `{"auth":"Unauthorized"}` |
| started_at | `2026-08-18T00:11:00.003Z` |
| finished_at | `2026-08-18T00:11:04.821Z` |
| docs_attempted | 2 |
| docs_published | 0 |
| docs_deferred | 2 |
| spend_microusd | 0 |
| budget_microusd | 3000000 |
| error_class_counts | `{"auth":2}` |
| outcomes | `H-2024-20025111` + `H-2024-8220192`, both `Unauthorized`, $0 |

Both docs already have R2 raw bytes (`needs_review`).  No `extraction_runs`
row was written for this tick (0 attempts in 24h).

Contrast with a **real** dead-key halt (already acknowledged, 2026-07-21):
`openRouterVision: OpenRouter API 401 Unauthorized {"error":{"message":"User not found.","code":401}}`.

The Aug 10 files-prepaid 402 (`fdadd07b-…`) auto-resumed at
`2026-08-18T00:11:02.645Z` via `auto_resume:files_prepaid` (#1977).  This
auth latch is a **new** false positive from the same daily tick.

## OpenRouter key (not rotated)

Live `OPENROUTER_API_KEY` / `CT_OPENROUTER_API_KEY` is the same funded paid
key from #1977.  Safe identity only: prefix `sk-or-v`, sha256_12
`450ceab9559f`, last4 `3aa7`.  `GET https://openrouter.ai/api/v1/auth/key`
returned HTTP 200, `is_free_tier=false`, daily `limit=2`,
`limit_remaining=2`, lifetime usage ~$41.67.  Do **not** rotate.  Do **not**
raise the $2/day key limit.

## Fix

1. Narrow `isCredentialAuthFailure` so source-fetch 401/403, Clerk
   `Unauthorized`, and admin 401 classify as `other`.
2. Keep proven LLM rejections as `auth`: `invalid_api_key`,
   `User not found` + OpenRouter 401, `API key not configured`,
   provider-prefixed `401 unauthorized`.
3. Kill-switch skip + auto-resume (`auto_resume:false_source_auth`) for this
   false latch only, same pattern as files-prepaid.

## Files changed

- `app/src/extraction/providerHealth.ts` — classifier + false-source-auth detector
- `app/src/extraction/autopilot.ts` — kill-switch skip + auto-ack
- tests in `providerHealth.test.ts` and `autopilot.test.ts`
- this rollout

## Verification

```bash
cd app && npm run typecheck && npm test
```

After merge + Coolify deploy, the next cron tick auto-acks
`b315b98d-…` (`actor: auto_resume:false_source_auth`) and the cheap path can
start.  Eligible review rows (9) may drain.  Terminal 210 stay in review.

## Out of scope

- 320 ingest dead-letter rows (existing transient requeue path)
- Quiver latency-probe silence (403 plan) and Unusual Whales 401 token
- #1959 executive `scanned_pdf` OCR
- Bulk Confirm/Reject of the 219 review rows
