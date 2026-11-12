# 2026-08-04 — Grok vision replaces kimi-cli local worker

## Summary
The macOS local vision worker (`services/vision-worker`) used `kimi -p`, which hit a hard provider billing 403 and cannot process the scanned backlog. Replaced the engine with **OpenRouter Grok vision** (`x-ai/grok-4.5` by default — same model the server bake-off / `configuredVision` path already trusts).

Also widened `GET /api/admin/scanned-filings/pending` so workers see:
- `extraction_pending_local` / `classified` scanned PDFs even after `local_wait_expires_at` (expired waits had hidden ~84 house scans)
- unresolved `needs_review` rows with `extract_empty` / `no_transactions_extracted` (executive OGE scans where server_cpu Tesseract returned 0 txs)

## Files
- `services/vision-worker/worker.py` — OpenRouter Grok PDF vision
- `services/vision-worker/run-vision-worker.sh` — loads `CT_OPENROUTER_API_KEY` + `CT_ADMIN_TOKEN`
- `services/vision-worker/README.md`, plist
- `app/src/admin/routes.ts` — pending query expansion
- `app/src/ingestion/__tests__/localVisionWaitState.test.ts` — coverage

## Verification
- `cd app && npm run typecheck && npm test -- --run src/ingestion/__tests__/localVisionWaitState.test.ts`
- Launchd heartbeat shows `engine=openrouter-grok-vision`
- Pending count > 0 for extract_empty executive + expired house waits
- Ingested docs move out of `needs_review` / `extraction_pending_local`

## Follow-ups
- OpenRouter weekly/limit budget may need a top-up if drain stalls mid-queue (~$6.88 remaining at cutover on the CT key)
- Prefer direct `XAI_API_KEY` inference key later to skip OpenRouter pass-through (management key is not inference)
