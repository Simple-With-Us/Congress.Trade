# Deno live-ingestion scheduler

> **Current shape (2026-08):** Deno Deploy and Turso are retired.  Production
> is Coolify Deno-in-Docker on Hetzner with local SQLite + Litestream.  This
> note is the 2026-07 Deploy-era ingestion fix.

## Summary

Deno Deploy served the API and ran daily jobs, but its `Deno.cron` handler did not invoke the existing `runWatcher` discovery loop. New House, Senate, and OGE filings therefore were not discovered by the production scheduler. The handler now runs the watcher every minute and flushes the durable ingestion and delivery outboxes on each tick.

Live logs then exposed a second migration break: Deno KV Connect does not implement `enqueue` or `listenQueue`, so every filing stopped after discovery. Queue handoffs now persist in Turso with leased claims, retry backoff, stale-lease recovery, fencing tokens, and retained terminal failures. The Deno libSQL compatibility shim also maps `rowsAffected` to D1's `meta.changes`; without that mapping, successful inserts and compare-and-swap updates were incorrectly treated as misses throughout the app.

Cloudflare's account API returned `10042` (`Please enable R2 through the Cloudflare Dashboard`) for the production account. The Coolify-hosted Garage service is therefore the active S3-compatible `RAW_FILES` store. A dedicated `congress-trade-raw` bucket/key passed an external put/get/content/delete round trip, and the non-printing credentials were installed as secret Deno v2 app environment variables.

## Files changed

- `app/src/deno/main.ts` — invoke `runWatcher`, `flushIngestionOutbox`, and `flushDeliveryOutbox` from the Deno cron handler; isolate failures so daily maintenance still runs.
- `app/src/deno/durableQueue.ts`, `app/migrations/0052_deno_runtime_queue.sql` — replace unsupported Deno KV queues with a Turso-backed runtime queue and fenced leases.
- `app/src/deno/shims.ts` — fail database errors closed and expose D1-compatible write metadata from libSQL.
- `app/src/backfill/senateCrawler.ts` — search the official Senate eFD source in bounded monthly windows, recursively split saturated ranges, and preserve the canonical ingestion outbox handoff.
- `app/src/admin/storageSmoke.ts`, `app/src/admin/routes.ts` — add authenticated storage proof, Senate/OGE recovery controls, and secret-safe live data-recovery counts.
- `.github/workflows/admin-maintenance.yml` — expose bounded recovery, status, storage, metadata, and market-data jobs exclusively on the Coolify production runner.
- `app/src/shared/types.ts` — declare the S3-compatible Deno runtime secret keys so `resolveSecret` remains type-safe under real Deno checking.
- `.github/workflows/ci.yml`, `.github/workflows/deploy-deno.yml` — install pinned Deno 2.9.3 from npm on the Coolify runners before typecheck/deploy. The runner images provide neither Deno nor `unzip`, which the official setup action requires.
- `deno.json` — provide the repository-root Deno Git integration with an app-relative entrypoint while inheriting the runnable app's import map; the Coolify deployment continues to publish from `app/`.
- `app/deno.json`, `app/deno.lock`, `deno.json` — align the Google GenAI requirement and lock at 2.13.0, retaining Deno 2.9's 24-hour dependency-age gate while narrowly exempting this reviewed package so the production runner can install the just-published locked release.
- `app/package.json` — restore the `coverage` script consumed by the hosted backend CI gate.
- `clients/pwa/package.json`, `clients/pwa/package-lock.json` — override Next's transitive `sharp` dependency to the patched 0.35.x line so the hosted high-severity audit gate is clean.
- `docs/EFFORT-LOG.md` — mirror the in-progress remediation state.

## Verification

- `npm exec --yes -- deno check src/deno/main.ts` — passed with Deno 2.9.3.
- `npm run coverage` — 155 files / 1,768 tests passed; configured coverage thresholds passed.
- `npx vitest run src/ingestion/__tests__/watcher.test.ts src/backfill/__tests__/houseCrawler.test.ts` — 2 files / 33 tests passed.
- `cd clients/pwa && npm audit --audit-level=high` — 0 vulnerabilities; PWA typecheck and 7 files / 31 tests passed.
- Full `npm test` — 155 files / 1,768 tests total; 1,767 passed and one pre-existing `src/shared/monitorBudgetGate.test.ts` timeout failed under the concurrent multi-agent host.
- Coolify-hosted PR checks passed for backend typecheck/tests/coverage, PWA typecheck/tests/build, and gitleaks.
- Deno Deploy app config remains `src/deno/main.ts` for Coolify's `app/` upload root; the repository-root Git integration receives `app/src/deno/main.ts` from source-controlled deploy config. No admin backfill or remote migration had been run at this stage.
- `deno install --frozen --reload` passed against the updated lock with the targeted dependency-age exemption.
- Garage `congress-trade-raw` put/get/exact-content/delete smoke — passed before Deno configuration.
- Deno Deploy v2 `PATCH /v2/apps/congress-trade` — installed the endpoint, bucket, region, and masked access credentials.
- `npm run typecheck` — passed after durable-queue, Senate, storage, and route integration.
- Focused Vitest: durable queue, Senate crawler, storage smoke, migrations, and watcher — 5 files / 64 tests passed.

## Follow-ups

- Merge and deploy the recovery revision, apply the idempotent production schema, and prove the runtime queue drains without KV queue errors.
- Run bounded official House, Senate, and OGE recovery batches until each requested range is idempotent or an upstream source limit is documented.
- Run member/ticker metadata and governed price enrichment, then record final chamber/source/recency/metadata/price coverage receipts.
