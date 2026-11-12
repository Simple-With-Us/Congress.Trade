# 2026-11-12 — Filer identity alias (CT-1362, CT-1360)

Seat: CURSOR. Branch `cursor/filer-identity-alias-4a65`. Linear: CT-1362 and CT-1360.

## Summary

Competitor backfill minted `MANUAL-<LAST>` filers from a surname.  The same person then existed twice, once on a roster or `EXEC-*` id and once on that `MANUAL-*` id, so `/api/members` and every distinct-politician count split the trades.  Two of those rows were the wrong person: `MANUAL-ELVIRA` (`Maria Elvira`) belongs on `house-fl27-maria-elvira-salazar`, and `MANUAL-DELANEY` (`John Delaney`, NY-7) belongs on April McClain Delaney, `house-md06-april-mcclain-delaney` (MD-6).

New competitor rows attach to the existing roster or EXEC id.  The match uses the full name, including middle names and initials, and also first plus last, with curated diminutives and member aliases.  A surname alone never creates a filer, including when a state and district are present.  A known state or chamber conflict stays a miss.

The ten named phantoms are re-pointed by an idempotent alias.  Live trades and filings move onto the canonical id.  A live row that would collide on `(doc_id, source, row_key)` is deprecated in place with reason `phantom-filer-alias-duplicate`.  The phantom filer row stays, with `merged_into` set, and a `filer_identity_merges` row records the alias.  Chamber and party are not rewritten on either row, so a senate-labelled phantom still aliases.

Pass D of `dedupeSplitFilerIdentities` does the same alias at the end of the daily identity sync, including a non-pinned `MANUAL-*` row whose full name matches exactly one live roster or EXEC filer.  `POST /api/admin/migrate` carries the ten pinned pairs so the next ship applies them without waiting for that job.  This change does not deploy.

## Files changed

- `app/src/shared/competitorFilerMatch.ts`: prefer the existing id. Refuse a bare surname.
- `app/src/shared/phantomFilerAliases.ts`: the ten pinned pairs and the migrate statements.
- `app/migrations/0110_phantom_filer_aliases.sql`: the same statements for local schema apply.
- `app/src/admin/migrations.ts`: those statements on `POST /api/admin/migrate`.
- `app/src/admin/filerIdentityDedupe.ts`: pass D. Skips aliases already planned by passes A–C. Does not copy chamber or party.
- `app/src/admin/routes.ts`, `app/src/admin/competitorAttributionRepair.ts`, `app/scripts/inject_competitor_data.ts`, `app/scripts/backfill_holes.ts`: creation paths call `assignCompetitorFilerId`.
- `app/src/enrichment/legislators.ts`: diminutives `peter`/`pete` and `douglas`/`doug`.
- Tests: `competitorFilerMatch.test.ts`, `phantomFilerAlias.test.ts`, `filerIdentityDedupe.test.ts`, `migrations.test.ts`.

## Verification

- `cd app && npm run typecheck` passed (`deno check src/deno/main.ts`, Deno 2.9.3).
- `cd app && npm test` passed: 396 files, 5458 tests passed, 2 skipped.
- `cd app && npm run lint` exits 1 with 3248 pre-existing `deno lint` findings (the repo baseline, including `dashboard.js`). `deno lint` on `src/shared/phantomFilerAliases.ts` and `src/shared/competitorFilerMatch.ts` is clean.
- The alias test seeds every named pair, including a senate-labelled phantom, and checks that chamber, party, state, and district stay put while live trades sit on the canonical id. A second run moves nothing. A bare surname does not alias. `MANUAL-JOHN` (`John Delaney`) does not move onto April.

## Follow-ups

- Do not run `bash app/scripts/ship.sh` from this lane.  The next production ship applies the alias through `POST /api/admin/migrate`.  A missing canonical row is a no-op.
- Open PR #3062 (CT-1361, `cursor/ct-1361-manual-chamber-a59d`) also edits `app/scripts/inject_competitor_data.ts` and `app/src/admin/competitorAttributionRepair.ts`. This branch leaves chamber and party labelling to that PR. A merge of both will need the identity assignment and their chamber helpers together.
- Name-only phantoms that are not in the pinned list move only when the daily identity sync runs pass D.
