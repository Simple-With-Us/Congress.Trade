# Review-Queue Autonomy: stuck-drain forensics, box disk incident, and pipeline fixes (2026-08-20)

## Summary

The owner asked why filings in the review queue were not published autonomously and
requested fixes so future filings publish without manual review.  Forensics found four
distinct causes, three of which were blocking the queue from draining at all:

1. **Production was 10 commits behind main.**  The agreement-cascade plurality rule
   (#2101/#2102), the 200-tx publish-cap lift, and the truncated-payload guard (#2104)
   were merged but never deployed.  `GET /api/health` reported `build.sha 6ebb15eb`
   while main was `4b9694d1`.  **Cause of the missing deploy: the Coolify host disk was
   97% full (140G/150G)** — 6 deployments sat `queued` since 20:16Z because every deploy
   job died on Postgres `SQLSTATE[53100] Disk full: No space left on device` while
   recording build logs, and Docker's 49.6GB Build Cache stayed pinned "in use" by the
   dead BuildKit sessions.
2. **The Mac vision worker was stuck in a selection spin.**  `/scanned-filings/pending`
   sorts newest-first; the two newest docs were locally exhausted (`attempts=3`), and
   `worker.py` took the raw head of the list, so every poll skipped the same two docs and
   the remaining 46 queued scans never got processed — for days.
3. **The deterministic drain ping-ponged one doc forever.**  H-2024-20025111 is
   `doc_kind=scanned_pdf` but carried a stale `extractor=textPdf`.  The drain selector
   matched on the extractor string, re-extracted the scan as text every minute (garbage),
   the normalizer re-flagged it, and the agreement recovery pass
   (`recoverExpiredCappedReviews`) flipped it back to `agreement_cascade_unresolved` —
   an infinite per-minute `review_revision` / receipt loop with zero model spend
   (revision reached ~2,700).
4. **The low-confidence / ticker-mismatch bucket was stuck on old consensus rules.**
   Those resolve automatically under the deployed plurality + stored-payload drain path
   (observed live: 6 docs auto-published minutes after the deploy).

## Files changed

- `app/src/admin/routes.ts` — `/scanned-filings/pending?worker=local`: the Mac Grok-CLI
  worker now reclaims **every** unresolved scanned review item (cascade disagreements,
  row-limit garbage, low-confidence flags), not just form-chrome/empty failures; the
  Coolify CPU OCR worker keeps the conservative reason set so it cannot re-generate
  garbage on hard scans.
- `app/src/extraction/deterministicDrain.ts` — selector now requires a text/html
  `doc_kind` (extractor string alone only counts for `''`/`unknown` kinds) and the loop
  guard never re-extracts `scanned_pdf`; stops the H-2024-20025111 ping-pong.
- `services/vision-worker/worker.py` (+ README) — batch selection skips exhausted and
  backoff docs and picks the first `MAX_DOCS_PER_POLL` processable ones, re-asserting the
  server park for exhausted docs whose earlier park call failed; polls
  `?worker=local` for the broad reclaim set.  Mirrored to `~/vision-worker/worker.py`.
- `app/src/ingestion/__tests__/localVisionWaitState.test.ts` — coverage for the
  `?worker=local` broad reclaim vs conservative default.
- `app/src/extraction/__tests__/deterministicDrain.test.ts` — regression test for the
  scanned-pdf-with-textPdf-extractor loop.
- `app/src/ui/__tests__/legalHtml.test.ts` — timeout hardening (flaky 5s budget on the
  full-router dynamic import, observed during this work).

## Ops actions taken

- Coolify: marked 8 stuck `queued` deployment rows `failed` in `application_deployment_queues`
  (application `<CT_COOLIFY_APP_UUID>`), restarted dockerd to release the pinned
  BuildKit cache, pruned 14GB of cache.  Disk: 97% → 65% (51G free).  Redeployed
  congress-app to `4b9694d1`; `bash app/scripts/ship.sh` applied migrations (0 failed,
  readiness ok/db/schema) and verified the live SHA.
- Mac vision worker: reset the local attempt ledger for the 74 queued docs (the Aug 10–12
  exhaustion window was a broken Grok CLI — a live end-to-end transcription test on
  H-2024-20025111 recovered 6 real U.S. Treasury purchases), synced the fixed worker,
  restarted pm2 `vision-worker`.  The queue drained 74 → 59 within the hour and the
  worker continued through the scanned backlog (free subscription path, no OpenRouter);
  after the `?worker=local` deploy it reclaimed the cascade and row-limit-garbage docs
  too (50-doc reclaim set) and kept publishing.
- Manual review (DEEPSEEK): vision-confirmed and published H-2025-8220828 (AT&T sale,
  2024-11-13) and H-2025-8220770 (U.S. Treasury bond purchase, 2025-02-19) whose CPU
  payloads were pure OCR garbage; reclassified 5 image-only `text_pdf` scans to
  `scanned_pdf` so the worker reclaims them.  H-2025-20033330 (Pete Sessions) left in
  review for the owner: the form prints tx date 2025-10-24 while the Clerk index filed
  it 10/22/2025, and the confirm validator refuses tx date > filing date — a human
  override decision is needed (candidate follow-up: allow an explicit future-date
  override on human confirm).
## Verification

- Full gate: `npm run typecheck` + 3502/3502 tests green.
- Prod live on `13f392d1` (includes #2107; plurality + cap-lift + truncated-payload
  guard).
- 6 ticker-mismatch docs auto-published at 03:00Z via `deterministic_drain_stored_payload`
  right after the first deploy (the target behavior, live).
- H-2024-20025111 review_revision stopped climbing once the drain fix landed (frozen at
  2,850 post-deploy; was ~1/min before).
- Landed as PR #2107 (`08a22005`) + follow-up #2110 (future_tx_date churn skip); peer
  lane PRs #2108/#2109/#2111 landed alongside.
## Follow-ups

- The remaining queue is scanned paper forms draining through the Mac vision worker; any
  that re-flag in review with rows need a human confirm pass (DEEPSEEK doing this).
- `extraction_provider` health check reads "No extraction attempts in 24h while review
  backlog is N" even when the local vision worker is actively draining — the check does
  not count admin-API submissions.  Consider counting `source='local_mac'` ingestion
  decisions as extraction attempts.
- 80 dead-lettered ingestion_outbox rows (pre-existing) and Quiver/UW provider silence
  (owner renewals) remain open.
- Coolify auto-deploy queue can silently wedge on disk-full again: a disk-space monitor
  (Pushover on <15% free) is recommended.
