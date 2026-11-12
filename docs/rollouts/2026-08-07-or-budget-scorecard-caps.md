# 2026-08-07 — OpenRouter budget circuit + per-doc spend + coverage scorecard

## Summary

Owner-directed spend trust and completeness reporting:

1. **OpenRouter key-budget circuit** — after 3 consecutive budget failures (402 / budget-class 403), cool down for 1 hour. Queue retries honor `delaySeconds` via `IngestRetryError`. No million useless retries when the weekly key fuse is spent. Delaying spend is not a product strategy; this only stops burn.
2. **Per-doc LLM cap** — default `$3` lifetime (`LLM_DOC_USD_CEILING`); skip paid extract when transactions already exist unless explicit reprocess.
3. **Purpose + doc_id metering** — settlements record `purpose` (e.g. `extraction`) and index `doc_id` (migration 0077).
4. **Coverage scorecard** — `GET /api/admin/coverage-scorecard` computes filings vs transactions, status mix, ranges, and a strict `complete` flag (never claimed without math).
5. **327 house “first-seen” burst** — explained by empty SQLite after Hetzner cutover then bulk rediscovery; not a true same-day PTR flood. R2 LTX restore already recovered history.

## Files changed

- `app/src/shared/openRouterBudgetCircuit.ts` (new)
- `app/src/shared/llmSpend.ts` — purpose, per-doc gates
- `app/src/extraction/openRouterVision.ts` — circuit preflight + trip on budget HTTP
- `app/src/extraction/bakeoff.ts` / `orchestrator.ts` — gates + purpose
- `app/src/extraction/providerHealth.ts` / `providerFailure.ts` — budget ≠ auth
- `app/src/admin/coverageScorecard.ts` + route
- `app/migrations/0077_llm_spend_purpose_doc.sql` + admin migrate mirror

## Verification

```bash
cd app && npm run typecheck && npm test -- openRouterBudgetCircuit docLlmSpend coverageScorecard
# after deploy:
# POST /api/admin/migrate
# GET  /api/admin/coverage-scorecard
```

## Follow-ups

- Surface scorecard on admin UI dashboard strip.
- Optional House Clerk ZIP universe hash vs filings (external feed).
- Keep Hetzner temp CI runner until Oracle `oracle-ci` runners return.
