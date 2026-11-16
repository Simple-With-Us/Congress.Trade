# 2026-09-18 — MANUAL-* chamber authority, EXEC/MANUAL twins, phantom filers (board rows 85f2170a, 591011b9, 2c0b428c)

## Summary

The Directory labelled cabinet officials as Senators, House members as Senators, and split the same person across `EXEC-*` and `MANUAL-*` (or `house-*` and `MANUAL-*`) filers.  Root causes, all reproduced against live data on 2026-09-18:

- `enrichment/identitySync.ts` overwrote party/state/district but **never wrote `filers.chamber`**, so competitor-minted `MANUAL-*` filers kept the injector's guess (mostly `senate`), and every dedupe pass (which keys on chamber) failed closed on them.
- Name-only roster matches took the first-listed legislator with no check that the person could have filed: `William Long` matched Gillis Long (d. 1985) through his *middle* name (`middle last` key), `Mark Green` matched the 2003-07 WI-8 member, `John Delaney` matched a 1930s Representative.
- `scripts/inject_competitor_data.ts` and the repair minted `MANUAL-<LASTNAME>`, so one id fused different people (`MANUAL-DELANEY` holds April McClain Delaney's ~300 rows and a separately-named "John Delaney" payload) and duplicated real filers.  Quiver's `House: "Representatives"` never equalled `'House'`, so every Representative defaulted to `senate`.

## Files changed

`app/src/enrichment/identitySync.ts`, `legislators.ts`; `app/src/admin/filerIdentityDedupe.ts`, `competitorAttributionRepair.ts`; `app/src/shared/competitorAttribution.ts`, `competitorFilerMatch.ts` (new), `executiveTitles.ts`; `app/src/delivery/rest.ts`, `client/utils.ts`, `jobs.ts`; `app/scripts/inject_competitor_data.ts`.

## How existing published rows are affected

Automatic, on the next daily filer lane (`maybeRunDailyFilerJobs`, which runs `runIdentitySync` and then the existing post-sync `dedupeSplitFilerIdentities`):

1. `filers.chamber` is corrected for `MANUAL-*` filers only, from evidence (competitor payload `member_type`, curated executive data, the resolved legislator's latest term).  A `house-*`, `senate-*` or `EXEC-*` id is never re-chambered.  No evidence means no change.
2. A filer whose stored roster match is impossible (last term before 2012, or more than a year before its latest trade; executives exempt) is re-resolved or, with no plausible candidate, has `resolved_bioguide_id`, party, state and district cleared.  Executive `MANUAL-*` filers drop the party/state/district of a former legislative career; every executive filer drops its district.
3. The dedupe then tombstones `MANUAL-*` aliases into the real filer (`merged_into`, plus a `filer_identity_merges` row).  Every read (`/api/members`, analytics) already folds tombstoned aliases into the canonical id, so counts move to the canonical row and the phantom leaves the Directory.  Nothing is deleted.

**Predicted change set** from a dry plan against the live `/api/members` roster (383 filers, 81 `MANUAL-*`) and the live congress-legislators JSON.  This is a conservative lower bound: the public transactions API rate-limited the payload sampling, so only 19 of 81 filers had payload evidence in the run; the rest fell back to the roster and the executive photo pack.

- 58 filer rows change, 44 of them chamber corrections and 5 impossible resolutions fixed.
- `MANUAL-*` after: 51 house with a party, 25 executive with no party, 4 still senate (Banks and Husted are real Senators; Sullivan merges away; one unresolved).
- 21 alias tombstones: `MANUAL-BUCK`, `-COSTA`, `-ELVIRA`, `-FLEISHMANN`, `-GRIJALVA`, `-JORDAN`, `-KEAN`, `-LANGEVIN`, `-LOWENTHAL`, `-NICOLAS`, `-SCHRIER` into their `house-*` filers, `-SULLIVAN` into `senate-dan-sullivan`, `-CAWTHORN` and `-HOLLINGSWORTH` into their `house-*` filers, and `-BAILEY`, `-BISIGNANO`, `-BURGUM`, `-KRATSIOS`, `-KUPOR`, `-MCMAHON`, `-MCMASTER` into their `EXEC-*` twins (the `EXEC-*` id is canonical: it carries the curated title).
- `MANUAL-WRIGHT` and `MANUAL-DUFFY` are absent from that list only because the sampling run had no payload evidence for them.  Their live payloads say `member_type: executive`, so on the real run they are labelled executive and merge into `EXEC-CWRIGHT` (through the curated alias, since "Christopher A Wright" and "Chris Wright" differ as name keys) and `EXEC-SEAN-DUFFY`.  `MANUAL-DELANEY` is left to the repair route: it fuses two people and can only be split row by row.

Manual, after deploy (needs an admin token; nothing here is scheduled):

1. `POST /api/admin/repair-competitor-attribution?dryRun=1`, read `details`, `rekeyed`, `unmatchedMinted`, `tombstoned`; then without `dryRun`.  This re-keys rows on `MANUAL-<LAST>` filers onto the existing real filer their payload's reporter names, row by row, and tombstones only phantoms it emptied.
2. `POST /api/admin/dedupe-filer-identities?dryRun=1` to preview; the daily lane runs it for real.

Rollback: every alias is recorded in `filer_identity_merges`; clear `filers.merged_into` for the alias and re-point its rows by hand.  The row moves of the repair are recorded per cluster in the route's `details`.

## Verification

- Local: full `vitest run` green; `identityChamber.test.ts` runs `runIdentitySync` plus the trailing dedupe end to end on an in-memory D1; the real committed photo-pack manifest is used as a data test (every executive `MANUAL-*` face is corrected).
- After deploy: `/api/members` should list no filer with party null labelled senate, no `MANUAL-*` twin beside `EXEC-*`, and `MANUAL-ELVIRA` / `MANUAL-DELANEY` should be gone or shrunk.

## Follow-ups

- `MANUAL-DELANEY` keeps 34 "John Delaney" payload rows (a former member cannot have filed in 2025-26) and 29 non-JSON FMP rows.  They are reported by the repair (`unmatchedMinted`), not moved; deprecating them is an owner decision.
- Executive titles for filers without a curated `EXECUTIVE_TITLES` entry show `Executive Branch`; no title is guessed.
- The ingest guard lives in the injector script (which runs from a workstation) and in the repair; there is no server-side competitor ingest path to guard.
