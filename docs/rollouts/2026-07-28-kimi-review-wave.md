# Rollout: KIMI full-stack review implementation wave — 2026-07-28

## Summary

Implemented the 2026-07-28 KIMI full-stack improvement analysis
(`docs/analysis/2026-07-28-full-stack-improvement-analysis.md`) across five
parallel lanes, all merged to `main` and deployed to production the same day.
Owner-approved scope was "everything feasible"; items gated on owner decisions
(CSV export policy, API keys, push-notification tiering, Sign in with Apple,
universal links, widgets/App Intents) were deliberately deferred.

## Files changed (key paths)

- PR #1050 — `app/src/deno/durableQueue.ts` (lease-assert coalescing),
  `app/src/deno/main.ts` + `app/src/deno/scheduledTick.ts` (AbortSignal,
  singleton tick lock, `runMaintenancePipeline`), `app/src/client/routes.ts` +
  `app/src/client/commands.ts` + `app/src/queueHandlers.ts` (commands → 202 async).
- PR #1051 — `app/src/delivery/sse.ts` (45 s cross-region backlog drain),
  `app/src/delivery/rows.ts` (memberName→filer_id, joins-lite COUNT),
  `app/src/delivery/rest.ts` (health 60 s cache, 401→403, Cache-Control,
  `/api/market/*` limits, public-read CORS, `GET /api/feed.xml`),
  `app/src/jobs.ts` (retention sweep orphans + NULL filed_date),
  `app/migrations/0063_filings_filed_date_index.sql` +
  `app/src/admin/migrations.ts` (`FILINGS_FILED_DATE_INDEX_SCHEMA_STATEMENTS`).
- PR #1052 — `app/docs/openapi.yaml` (new), `deno_openapi.json` →
  `docs/vendor/deno-deploy-openapi.json`, 30 scratch files deleted
  (incl. `app/src/admin/routes.ts.orig`).
- PR #1053 — `app/src/ui/dashboardHtml.ts` (833 KB → 493 KB: OG/Twitter meta,
  deep links `?trade=`/`?ticker=`/`?member=` + copy-link, delivery filter form +
  pause/resume, splash persistence, visibility-aware polling, URL-synced
  filters, a11y), `app/src/ui/assets.ts` + `app/src/ui/routes.ts` (extracted
  assets, owner-supplied eagle-moneybag icon set), `docs/brand/assets/`.
- PR #1054 — `clients/ios/**` (Info.plist URL scheme fixing sign-in, premium
  gating, ticker detail + filing PDF, watchlist editor, command history,
  SwiftData upsert, server-side search, delivery filters, live updates,
  magic link, ShareLink/deep links, new AppIcon).
- PR #1055 — effort-board closeout.

## Behavior changes to be aware of

- `POST /api/client/v1/commands` returns **202** and executes via the durable
  queue; validation/entitlement errors surface as `failed` on the polled
  command row instead of synchronous 4xx. The `create_subscription` command
  result now persists the one-time secret (polled row is the only credential
  channel under async execution).
- Lease fencing is eventually-consistent within a short freshness window
  (`max(1s, leaseMs/6)`); a lost lease still fails writes after the window.
- `/api/market/*` series reads cap at the latest 1000 rows (limit param, cap
  5000) instead of unbounded.
- `GET /api/subscriptions` returns 403 (was 401) for disabled public listing.
- iOS `xcodebuild` is broken on the owner's Mac for a pre-existing reason
  (Xcode 27.0 beta cannot resolve FirebaseCore; unmodified `origin/main`
  fails identically). Lane was verified via `swiftc -typecheck` (0 errors).

## Production incidents found and fixed during the deploy

1. **`POST /api/admin/migrate` had been silently 500-ing on every deploy since
   ~2026-07-24.** Four exact-duplicate `transactions` pairs (manual backfill of
   doc `H-2022-8219294`, source `manual`) violated the
   `idx_transactions_doc_source_rowkey` unique index, and the migrate loop
   aborts on first error — so the whole schema tail (179 statements, including
   the unique index itself and 0063) had never applied in prod. Fixed: backed
   up the 8 redundant rows to `data/ct-dedupe-backup-2026-07-28.json` (local,
   gitignored), deleted the 4 duplicate tx rows + their 4 orphaned
   `delivery_outbox` rows (owner-approved), re-ran migrate → 179 applied / 58
   skipped, `remaining_dups = 0`.
2. **Branch protection on `main` had drifted** (no required checks, no
   conversation-resolution). Restored per `AGENTS.md`: `typecheck + test` +
   `gitleaks` required, conversation resolution on, enforce_admins on.
3. Scheduled `deploy-deno.yml` cron runs have been failing (all recent runs
   red) — likely why the blocked migrate went unnoticed. Fleet notified in
   #ag***-s**c.

## Verification

- Full gates green per lane: 1884 / 1903 / 1879 vitest (queue-cron /
  delivery-api / web-ui), `npm run typecheck` clean everywhere.
- Deployed via `bash app/scripts/ship.sh` (revision `bwsrt69xar4b`).
- Live checks 2026-07-28 ~21:05 UTC: `/api/health` ok/db/schema true,
  `/api/feed.xml` serves RSS, homepage has full OG/Twitter meta,
  `/og-image.png` `/favicon.ico` `/icon-512.png` `/site.webmanifest` all 200.

## Follow-ups

- RSS is at `/api/feed.xml`; root `/feed.xml` + `<link rel="alternate">`
  advertisement not yet wired.
- iOS background `ModelActor` for cache writes (upsert is main-actor today).
- Firebase in the iOS app: unused, breaks xcodebuild on the local toolchain —
  remove or wire Crashlytics (owner decision).
- Owner decisions pending: CSV export gate vs copy, third-party API keys,
  push-notification tiering + APNs credentials, Sign in with Apple /
  universal links / widgets (Apple provisioning).
- Consider making `/api/admin/migrate` continue-and-collect per-statement
  errors instead of aborting the tail on first failure (a single bad
  statement silently blocked 4 days of schema).
