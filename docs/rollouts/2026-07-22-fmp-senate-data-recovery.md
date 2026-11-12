# FMP Senate historical recovery

> **Current shape (2026-08):** Deno Deploy and Turso are retired.  Production
> is Coolify + local SQLite.  The Deno/Turso copy described below is 2026-07
> history.

## Summary

The Deno/Turso migration copied the legacy community seed (7,133 Senate rows
ending in 2020) and the live official pipeline had only a small recent Senate
set because Senate eFD blocks datacenter egress. This rollout adds a bounded,
operator-triggered import from Financial Modeling Prep's `senate-latest` feed.

Imported rows remain `source='seed_dataset'`: they improve historical coverage
without claiming first-party extraction provenance. Unlike the old sentinel
document, every row is attached to its canonical `S-{reportId}` filing and a
stable row key that includes side, owner, comment, and duplicate occurrence.
The import refuses to add seed rows when primary/manual rows already exist.

When the official Senate source later discovers a provider-seeded report, the
watcher reopens only the narrowly tagged placeholder and sends it through the
normal fetch/extract pipeline. A successful primary publication deprecates the
FMP seed rows atomically so analytics never retain both visible copies.

## Files changed

- `app/src/backfill/fmpSenateRecovery.ts` — bounded FMP fetch, identity mapping,
  budget/pacing integration, and idempotent persistence.
- `app/src/admin/routes.ts` — authenticated
  `POST /api/admin/fmp-senate-recovery` endpoint (maximum five pages/run).
- `app/src/ingestion/watcher.ts` — official-source upgrade of tagged provider
  seeds.
- `app/src/extraction/normalizer.ts` — retire same-report seed rows only after a
  complete primary publication succeeds.
- `.github/workflows/admin-maintenance.yml` — confirmed owner-triggered Coolify
  runner operation with validated page bounds.
- Focused tests cover report/row identity, bounded writes, provider-seed
  upgrades, duplicate behavior, and primary replacement.

## Verification

From `app/`:

```bash
deno check src/deno/main.ts
npm test -- src/backfill/__tests__ src/ingestion/__tests__/senateFilerId.test.ts src/ingestion/__tests__/watcher.test.ts src/ingestion/__tests__/providerSeedUpgrade.test.ts src/extraction/__tests__/normalizer.test.ts
```

The Actions runner policy must also pass from the repository root:

```bash
node scripts/check-actions-runner-policy.mjs
```

Production recovery runs only through the `Admin Maintenance` workflow with
`task=fmp-senate-recovery`, `confirm=run-production-maintenance`, and a page
range of at most five pages. After each batch, compare the authenticated
`/api/admin/data-recovery/status` receipt and public analytics counts. Re-run a
completed page range to prove `inserted=0`/duplicates-only idempotency.

## Follow-ups

- Keep the residential Senate scout as the official current-filing path while
  eFD continues to reject datacenter IPs.
- Once official coverage catches up, verify matching primary rows caused the
  corresponding FMP seed rows to be deprecated.
- Re-run metadata enrichment after the historical import so newly referenced
  filers and tickers receive the best available free metadata.
