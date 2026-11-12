# 2026-07-31 — D1 row-budget raise + R2 free-tier daily Pushover summary

> **Current shape (2026-08):** Turso stays retired.  The SQLite file is on
> Hetzner (Oracle is decommissioned).  D1/Turso per-row pricing still does
> not apply.

## Summary

Two owner-directed ops changes:

1. **D1 row budget raised to anomaly-tripwire levels.** Production has run on
   self-hosted SQLite (Oracle host block volume) since the 2026-07-30 Turso
   cutover, so Cloudflare D1 per-row pricing no longer applies — yet the
   2M rows/day write guard (a leftover D1 cost protection) kept firing
   `D1 daily rows-written budget EXCEEDED` alarms during normal operation.
   Code defaults raised: written 2M → 500M/day, read 200M → 5B/day. The guard
   stays in place purely as a runaway-scan tripwire; both dimensions remain
   Infisical-tunable. Matching Infisical prod overrides
   (`D1_DAILY_ROWS_WRITTEN_BUDGET=500000000`, `D1_DAILY_ROWS_READ_BUDGET=5000000000`)
   were set ahead of the deploy, so the raise took effect in prod within the
   10-minute secrets-cache TTL — no redeploy needed for the relief itself.

2. **Daily R2 free-tier usage summary → Pushover.** New daily-jobs cron lane
   (`runR2UsageSummary`) queries the account's Cloudflare GraphQL analytics
   (`r2StorageAdaptiveGroups` + `r2OperationsAdaptiveGroups`, current UTC
   month), computes storage / Class A / Class B usage as % of the free tier
   (10 GB / 1M / 10M per month) plus pace (projected month-end at current burn
   rate, and 7-day storage growth trend), and pushes a compact message via
   Pushover. Deliberately placed OUTSIDE the `dailyBudgetExceeded` gates (two
   HTTP calls, zero DB writes — an over-budget day is exactly when the report
   matters). Also exposed as `POST /api/admin/r2-usage-summary` for on-demand
   verification. All failure modes fail open (logged skip, never a cron
   exception).

## Files changed

- `app/src/shared/d1Budget.ts` — raised default budgets + updated rationale comments
- `app/src/shared/r2Usage.ts` — GraphQL fetch, Class A/B classification, pace math, message formatting, daily runner
- `app/src/shared/pushover.ts` — minimal Pushover client (fail-open, mirrors alerts/notify.ts semantics)
- `app/src/shared/r2Usage.test.ts`, `app/src/shared/pushover.test.ts` — 18 + 5 unit tests
- `app/src/jobs.ts` — daily lane wiring; R2/Pushover secrets folded into the single per-run `resolveSecrets` round trip
- `app/src/admin/routes.ts` — `POST /api/admin/r2-usage-summary` on-demand trigger

## Secrets / config

- `CLOUDFLARE_R2_ANALYTICS_TOKEN` (Infisical prod, set 2026-07-31): new scoped
  token `congress-trade-r2-usage-readonly` (id `95d69d7a…`), Account Analytics
  Read + Workers R2 Storage Read on account `0e9f5a0c…` only. Minted via the
  OAuth-authenticated Cloudflare MCP after the existing `CLOUDFLARE_CT_API_TOKEN`
  was found rejected by the CF API. Revocable in the CF dashboard → API Tokens.
- `CLOUDFLARE_ACCOUNT_ID` (Infisical prod, set 2026-07-31).
- `PUSHOVER_APP_TOKEN` / `PUSHOVER_USER_KEY` — **PENDING OWNER HANDOFF** (no
  Pushover credentials existed anywhere in the fleet secret stores). The job
  no-ops with reason `PUSHOVER_APP_TOKEN / PUSHOVER_USER_KEY not configured`
  until these are set; delivery starts automatically ≤10 min after they're
  added to Infisical prod.

## Verification

- `cd app && npm run typecheck` — clean
- `cd app && npm test` — 1963/1963 green
- GraphQL query shape validated live against the account (2026-07-31): storage
  ~1.82 GB (18.2% of free tier), Class A ~3.2K ops (0.3%), Class B ~17.6K ops
  (0.2%) month-to-date — well within free tier.
- Prod post-deploy: `POST /api/admin/r2-usage-summary` returns
  `{ sent: false, reason: "PUSHOVER_... not configured", summary: {...} }` until
  the Pushover creds land, then `{ sent: true }`.

## Follow-ups

- Owner: drop `PUSHOVER_APP_TOKEN` + `PUSHOVER_USER_KEY` via the secret-handoff
  file protocol so they can be set in Infisical (values never in chat).
- Owner (pre-existing, separate): the R2 S3 API token on the `admin@congress.trade`
  CF account is still deleted — mint a fresh one (Object R&W on
  `congress-trade-bucket`) and update Infisical `AWS_ACCESS_KEY_ID` /
  `AWS_SECRET_ACCESS_KEY` to restore PDF archiving.
- If the free-tier status line ever shows ⚠️ OVER 80%, the runbook is: prune old
  PDFs from `congress-trade-bucket` (storage) or move bulk reads to the daily
  R2 snapshot (Class B).
