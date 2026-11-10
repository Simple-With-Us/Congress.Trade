# Review queue failure sections, Senate intake relay status, and the twice-a-day eFD canary (CT-2462)

## Summary

Owner direction (2026-11-05), worked with GB-Publisher.  The dashboard review view counted ingest failures in its totals but never rendered them, two failure stores appeared in no queue surface at all, the Senate PTR intake endpoint recorded nothing about the headless relay feeding it, and the CT-2416 eFD functional probe dialed eFD through the residential proxy every 30 minutes with its health check sitting critical on the known Akamai deny.  This change closes all four gaps.

## Files changed

- `app/src/ingestion/senateIntakeStatus.ts` (new) — one CONFIG_KV heartbeat record for the intake relay (`senate-intake:last`), written best-effort on every intake call and read back with age and staleness (45 minutes, about three missed fetcher runs).
- `app/src/admin/routes.ts` — `POST /api/admin/senate-ptr-intake` records the heartbeat on both the dry-run and ingest paths.  `GET /api/admin/review-queue` accepts `include=dead_letters` and `include=dlq_failed` alongside `ingest_failures`, carries `deadLetters` and `dlqFailed` in its totals, and returns the relay heartbeat as `senateIntake` on every response.  The durable-queue listing reads the row type from the payload JSON because the production table has no `type` column, and reports `dlqFailedAvailable: false` when the table is absent.
- `app/src/ui/client/dashboard.js` + generated `app/src/ui/dashboardClient.ts` — the pending review tab fetches the three failure includes and renders the relay status line plus classified failure sections (ingest failures grouped as download failed, ingest error, or retry-in-flight; outbox dead letters; durable-queue failures; the published-stale count as a note).  The old empty-state pointer to the raw ingest-failures endpoint is gone.
- `app/src/ingestion/residentialProxyHealth.ts` — the eFD probe interval goes from 30 minutes to 12 hours, making it a twice-a-day canary.
- `app/src/shared/pipelineHealth.ts` — the `senate_efd` check speaks in canary terms: a blocked probe and an active edge-deny backoff read degraded rather than critical, and a resting canary well past the old 20-minute freshness window still reads ok.
- Tests: `app/src/admin/__tests__/reviewQueueFailures.test.ts` and `app/src/ingestion/__tests__/senateIntakeStatus.test.ts` (new); classifier and relative-age cases in `app/src/ui/__tests__/dashboardClient.test.ts`; probe-cadence cases re-based to 12 hours in the watcher, senateEfdHealth, and pipelineHealth suites.

## Verification

- Targeted suites green: review-queue failures, senate intake status, pipeline health, senate eFD health, dashboard client and HTML, and the existing ingest-failures suite (594 + 10 tests).  `deno check src/deno/main.ts` clean; the generated dashboard client is in sync.
- Two failures are pre-existing on the base commit in this environment and unrelated: the watcher sub-threshold live-search test times out identically with and without this change, and the cron-lane / scheduled-tick suites pass standalone but flake under full-suite load.
- Production verification happens after merge and deploy: the review tab should show the relay line (stale until the Mac fetcher's next intake call writes the first heartbeat) and the failure sections against live data.

## Follow-ups

- Senate polling itself is unchanged; only the functional probe cadence and its health wording moved.
- `FilingTooLargeError` is thrown in the fetcher without a `markError` on that path; whether the queue consumer always marks the filing is still unverified and worth a separate look.
