# 2026-09-04 — Vision Worker Efficiency Checklist (Known Steps with Delays)

- Summary: Capture the known steps + delays in the local-Mac-vision path so future optimization passes have a starting checklist.  Paired with the 2-minute wait cap landing in `app/src/ingestion/classifier.ts` (`LOCAL_VISION_WAIT_MINUTES`).  Owner 2026-09-04: "remember in a documented list of known steps with delays where efficiencies could be pursued so that if we are trying to optimize to beat other providers in the short to mid term future then we'll have list of some ideas of where to look for efficiencies."
- Why: Today the slow path is 15 minutes of local Mac wait before cloud fallback, which dominates end-to-end latency for scanned PDFs.  Most of the gain available in the short term is in the wait window itself + the cloud fallback steps; this list is the per-step budget.
- Files:
  - `app/src/ingestion/classifier.ts` (wait window constant + 2 min cap)
  - `app/src/queueHandlers.ts` (lost-wakeup re-enqueue, comment now references the cap)
  - `app/src/ingestion/__tests__/localVisionWaitState.test.ts` (assertions updated for 2 min)
  - `docs/rollouts/2026-09-04-vision-worker-efficiency-checklist.md` (this file)

## Per-step latency budget (today, scanned PDF path)

| Step | Where | Current wait / cost | Notes |
|---|---|---|---|
| 1. Ingest queue → classifyFiling | `queueHandlers.ts` | < 1 s | The queue dispatch is the only thing that keeps the filing in `fetched`. |
| 2. R2 `get(raw_object_key)` | `classifier.ts` | 100–500 ms | A second fetch of bytes already buffered at the worker; cache opportunity if extraction is on the same Worker. |
| 3. `decideDocKind` text-layer scan | `classifier.ts` | 50–200 ms (256 KB prefix) | Bounded sniff; the bound is the real cost ceiling. |
| 4. **Local Mac vision wait** | `classifier.ts` (this rollout: 2 min) | **2 min** (was 15) | Hard ceiling; expired check flips to `classified` + `filing.extracted`. |
| 5. `isLocalWorkerHeartbeatFresh` | `classifier.ts` | < 10 ms | 5 min window; not on the hot path. |
| 6. Mac vision worker (the actual OCR) | `local_mac_1` | 30–120 s when online | 0 s if heartbeat stale (skipped). |
| 7. Cloud fallback (Gemini / Voyage / Anthropic) | `extraction/extractRouting.ts` | 5–20 s | Per-provider rate limits + retries dominate tail. |
| 8. Normalize + ticker | `extraction/normalizer.ts` | 50–200 ms | Ticker renames through shared package. |
| 9. Persist to filings + agreements | `extraction/agreement.ts` | 50–300 ms | SQLite write lease; another hot spot for parallelism. |
| **End-to-end p50 (scanned)** | | **~2–3 min** | Was 15–17 min before this rollout. |
| **End-to-end p99 (scanned)** | | **~5–8 min** | Cloud retries push the tail. |

## Known efficiency ideas (in priority order)

1. **Smarter routing: only wait for Mac when vision actually helps.** Today every `scanned_pdf` waits; a fast heuristic (low-DPI flag, blurry signature, or a `decideDocKind` "low text density" branch) could send the obvious text-extractable scans straight to cloud.  This is the biggest single win for the *median* case, not the tail.
2. **Move `decideDocKind` text-layer scan inside the same Deno Worker as the queue dispatch.** The R2 read is the same object; right now we read once, then the extractor reads it again.  Sharing the buffer cuts one R2 round-trip per filing.
3. **Two-track queue: "local vision handoff" is its own durable queue, not a delay on the ingest path.** Today `filing.local_wait_check` is a delayed message on `INGEST_QUEUE`; promoting it to a dedicated `LOCAL_VISION_QUEUE` lets the dispatcher short-circuit expired waits without a queue round-trip.
4. **Cap-and-continue rather than cap-and-reschedule.** After the 2-min cap, immediately enqueue the cloud extraction (Gemini) on a parallel branch; today the path is strictly sequential.
5. **Local worker batch mode.** When the Mac is online it can drain the local queue in parallel; the heartbeat already supports multiple workers.  A "drain backlog on resume" sweep is the missing piece.
6. **Cache `isLocalWorkerHeartbeatFresh` for a 10 s window.** It runs on every scanned filing; the 5-min freshness is plenty loose for a 10 s memo.
7. **Pinecone-style embed pre-warm.** Pre-compute a Qdrant embedding on the raw scan so the post-classification search is sub-second instead of joining the per-filing 100–200 ms tax.  Already on the radar from the OpenRouter credits lane.
8. **Server-side healthcheck for `qdrant-st`.** Today the iOS UM card paints `running:unknown`; the Coolify admin fix on the ST host removes the warning and clears the path for a real health check on the server side too.
9. **Reduce the `isLocalWorkerHeartbeatFresh` 5-min window to 2 min** once step 1 is in: the wait cap is now the same as the freshness, so a stale heartbeat = a fast fallback by construction.
10. **Provider fallbacks: prefer Voyage for clean text, Gemini for scans.** Right now `extractRouting.ts` tries providers in a fixed order; making it content-aware (per step 1) saves one fallback round on scans.

## Verification

- `npm run typecheck` (no new types; existing tests updated for the 2-min constant).
- `npm test -- --run localVisionWaitState` (assertions updated; no semantic regression).
- Manual: enqueue a `filing.fetched` with a known scanned PDF, watch the wait window drop from 15 min to 2 min, and confirm the cloud fallback fires after the cap.
- Production rollout via the standard CT PR + Coolify auto-deploy; no flag needed (the wait is a hard ceiling, not a policy).

## Follow-ups

- Re-measure end-to-end p50 / p99 after the 2-min cap lands in prod and update the table above.
- When the physical device replaces the Mac, the `local_mac_1` heartbeat will go silent and the cloud fallback will be the only path; confirm the cap still works (it should, because `isLocalWorkerHeartbeatFresh` returns false on a stale heartbeat and the cap is never scheduled).
- Revisit this checklist quarterly; each item either lands or is reprioritized.
