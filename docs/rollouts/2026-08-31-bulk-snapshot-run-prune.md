# 2026-08-31 - Bulk snapshot retention: prune superseded runs + expired dates

## Context & Objective

The owner asked why Congress.Trade's Cloudflare R2 usage keeps climbing toward
the 10 GB free tier "for no known reason", and whether moving the filing PDFs to
Backblaze B2 would be cheaper.  Investigation said no on both counts:

- The filing PDFs are not the problem.  CT's own live inventory
  (`docs/rollouts/2026-08-05-r2-freetier-class-a-survival.md:16-24`) puts `raw/`
  filings at "small"; leftover litestream LTX was pruned 2026-08-15 and
  `weekly/` is capped at one snapshot set (#1882).
- The growth is `bulk/`.  `app/src/export/snapshot.ts` writes every daily export
  under `bulk/{date}/runs/{runId}/` and **never deleted anything**.  Its own
  header called orphaned run prefixes "negligible R2 cost" - true for one rerun,
  false at ~0.28 GiB per run accumulating forever.
- A B2 move would save ~$0.97/year at 20 GB (B2 $0.00695/GB-mo vs R2
  $0.015/GB-mo, both with 10 GB free) while putting unmonitored product data on
  the shared Backblaze account whose daily caps were already tripping and whose
  2026-08-27 incident froze all three apps' backups at once.

So: fix the retention, keep the vendor.

## Changes Made

- `app/src/export/snapshot.ts`
  - New `pruneBulkSnapshots(env, {today, keepRunId, keepRunDate, now})`, called
    from `runBulkSnapshot` **after** the manifest is published (so the run it
    preserves is the one readers can actually reach) and wrapped so a prune
    failure can never fail an export that already succeeded.
  - New pure selector `selectPruneTargets()` implementing two rules: superseded
    run files on a retained date (past a grace window), and every owned key on a
    date older than the keep window.  Pure so retention is unit-testable with no
    R2 round trip - same shape as Usage-Monitor's `selectPruneTargets` /
    `isManagedArchiveKey` pair in `scripts/ops/r2-weekly-archive.mjs`.
  - Helpers `parseRunObjectKey`, `parseBulkObjectDate`, `shiftUtcDate`.
  - Corrected the stale "negligible R2 cost" header comment.
- `app/src/deno/shims.ts` - `S3BucketShim.list()`, mapping ListObjectsV2 onto the
  Workers `R2Bucket.list()` shape (`key`, `size`, `uploaded`,
  `delimitedPrefixes`).  Deno prod had **no enumeration at all**, so the prune
  could not have run outside the Workers runtime.
- `app/src/export/__tests__/snapshot.test.ts` - 17 new tests (8 -> 25).

## Safety Rails

Candidate keys come from a ListObjects response, i.e. from outside this process,
and `raw/` filing PDFs plus the `weekly/` DB archive share the bucket.  So:

- **Strict shape allowlist.**  Only `bulk/{YYYY-MM-DD}/runs/{runId}/{table}.ndjson`
  and `bulk/{YYYY-MM-DD}/manifest.json` are ever deletable.  `raw/`, `weekly/`,
  `historical-dumps/`, `_ops/`, path-traversal shapes and non-`.ndjson`
  extensions are covered by an explicit test.
- **Never the live run.**  The run id just published is excluded by id+date.
- **Never a retained date's manifest.**
- **Age gate** (`BULK_SNAPSHOT_PRUNE_GRACE_MINUTES`, default 60): a superseded
  run is only deleted once it is older than the grace window, so a consumer that
  read the previous manifest and is still streaming its files is not 404'd
  mid-transfer.  An object with no parseable upload time is never deleted.
- **Never the future.**  Dates after `today` are skipped (clock skew).
- **Bounded** (`BULK_SNAPSHOT_MAX_DELETES`, default 500, oldest-first; listing
  capped at 20 pages).  Every R2 DeleteObject and ListObjects is a Class A
  operation against the same 1M/month free allowance ingestion uses, so a first
  run against a backlog spreads over days rather than spiking the meter.
- **Best-effort.**  Listing failure, delete failure, and unexpected throws all
  return/log instead of propagating.  A build whose binding has no `list()`
  returns `skipped: 'unsupported'`.
- **Kill switch** `BULK_SNAPSHOT_PRUNE_DISABLED=1` parks it with no deploy.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `BULK_SNAPSHOT_KEEP_DAYS` | 14 | Whole snapshot dates kept, counting today |
| `BULK_SNAPSHOT_PRUNE_GRACE_MINUTES` | 60 | Age before a superseded run is deletable |
| `BULK_SNAPSHOT_MAX_DELETES` | 500 | Delete ceiling per invocation |
| `BULK_SNAPSHOT_PRUNE_DISABLED` | unset | `1` parks the prune |

14 days was chosen against the endpoint's stated purpose - "first-time
bootstrapping or catch-up after a downtime gap" (`app/src/export/routes.ts:5-8`).
Expiring a date makes `GET /api/export/bulk-snapshot?date=` return the existing
documented 404 "snapshot not available for date"; it introduces no new failure
mode, and the data is daily EOD that "self-heals on the next day's snapshot".

## Verification State

- `npx vitest run src/export/__tests__/snapshot.test.ts` - 25 passed (was 8).
- `npx vitest run` (full suite) - **299 files / 3,814 tests passed**.
- `npm run typecheck` (`deno check src/deno/main.ts`) - exit 0, so the new
  `list()` typechecks against the real Deno build, not just vitest.
- Not verified from here: the actual reclaimed byte count.  That needs a live
  ListObjectsV2 against `congress-trade-bucket`, which this seat has no
  credentials for.  Expect several GB on the first tick given ~0.28 GiB/run and
  a bucket that has never pruned `bulk/`, but treat that as an estimate.

## Next Steps & Blockers

- First real prune happens on the next daily snapshot lane run.  Watch for the
  `bulk snapshot prune: scanned=N deleted=M failed=K` log line; `(capped; more
  next run)` means the backlog needs another day or a raised
  `BULK_SNAPSHOT_MAX_DELETES`.
- Confirm CT's R2 storage drops on the Usage Monitor Platforms card over the
  following days.  September also drops the August GB-month artifact, so read
  the current-snapshot number rather than the month figure.
- Unrelated but adjacent, left out of scope deliberately: `S3BucketShim.put()`
  issues a HeadObject after every PUT (`app/src/deno/shims.ts:336-341`), doubling
  billed operations on every write path.  Worth its own change.
