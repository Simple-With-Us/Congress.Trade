# 2026-09-24 — Disputed agreement vision must not block unreadable 278-T

## Summary

`#2554` already closes a refused 278-T as `rejected` / `oge_text_unreadable`.  After deploy, `E-2026-donald-j-trump-09-8-2026-278t` stayed `agreement_cascade_unresolved` because `otherSuccessfulReadHasRows` and the `writeClose` extraction_runs guards treated any `ok=1` run with `row_count>0` as a successful read.  The three kind=agreement vision runs on that filing were 472 vs 66 vs 33 (0 unanimous) against an official 1156-row 278-T.  That is not a successful read.

Non-agreement (or null-kind) ok runs with rows still block an empty or unreadable close.  kind=agreement vision blocks only when at least two ok>0 runs exist and every pair has min/max row_count >= 0.8.

BF-PUBLISHER rejected the live Trump row at reviewRevision 35 (admin `reject`, 2026-09-24 09:40 AM CT).  The 30 remaining review-queue rows are historic House items and were not bulk-resolved.

## Files changed

- `app/src/extraction/executiveDisposition.ts` — shared `SUCCESSFUL_NONEMPTY_READ_SQL`
- `app/src/extraction/__tests__/executiveDisposition.test.ts` — kind column; 33/66/472 closes; 1150/1160 does not

## Verification

```
cd app && npx --no-install vitest run src/extraction/__tests__/executiveDisposition.test.ts
cd app && deno check src/extraction/executiveDisposition.ts
```

28/28 executiveDisposition tests green.  `deno check` clean.  Live `/api/health` sha `ab5c4ad5` until Deployer ships this PR.  Queue after reject: unresolved 30, all House.

## Follow-ups

Deployer owns merge and prod ship.  Do not Coolify-click.  `filing_skips` may stay critical until the 24h `extract_empty_failure` window ages out.  Historic House `agreement_cascade_unresolved` / `form_chrome_only,ocr_unusable` rows stay in queue.
