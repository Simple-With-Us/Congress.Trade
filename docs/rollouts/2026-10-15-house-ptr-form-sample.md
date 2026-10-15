# House PTR form-sample rows stay off the live feed

## Summary

Scanned House PTRs print an example row (Mega / Meg / Mfg Corp).  Local vision OCR publishes that row under several spellings.  `looksLikeHousePrintedExampleAsset` now squashes the name to letters and requires the whole string to be the example signature, so "Exempl Mfg Corp.", "Ex Mpi Meg Corp.", "Mega Corp.", and "Example Meg Corp." drop before normalize and agreement publish.  A longer real name such as "Mega Corp Holdings Inc" or "Exxon Mobil Corp." is kept.

`looksLikePtrFormSampleDate` used to return true for every day in 2012 and 2020.  That year match is gone.  Only the printed example dates remain (2012-08-14, 2020-02-05, 2020-05-02, and the slash forms).  A date never drops a row by itself.  CT-2407.

## Files changed

- `app/src/extraction/extractRouting.ts` — squash-and-anchor House sample signature, narrow sample dates, publish-path Sentry log `ptr.form_sample_dropped`
- `app/src/extraction/normalizer.ts` — drop samples through the publish helper
- `app/src/extraction/agreement.ts` — same drop on agreement finalize
- `app/src/extraction/__tests__/extractRouting.test.ts` — live OCR strings, real-name negatives, date-only negatives

## Verification

```bash
cd app && npm run typecheck && npm test
```

Corpus check is a read of the public feed, not a production write.  No unpublish.  No deploy.  2012 served 6 rows and the only signature hit was the known chrome row `Example Mega Corp.` on `H-2022-8219320`.  2020 served 219 rows and none matched.  A cursor walk of 19,437 live rows matched none before the public feed returned 429.  `ExxonMobil Corp.` on 2012-04-12 stayed off the signature.

## Follow-ups

- Already-published manual chrome (H-2022-8219320, Example Mega Corp., source manual) does not pass through extraction again.  Unpublish stays with the owner.  Admin confirm of a new sample row is still a separate path in `app/src/admin/routes.ts`, which another open PR is editing.
- A security whose entire squashed name is exactly the example signature (no extra word) would be dropped.  The public-feed sweep in the PR records how many live rows match.
