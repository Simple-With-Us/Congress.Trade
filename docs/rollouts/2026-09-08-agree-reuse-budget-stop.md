# 2026-09-08 — Agreement cascade: cheap-first, budget-stop, reuse, quality-gate

**Agent:** GROK  
**Branch:** `grok/agree-reuse-budget-stop`  
**Board:** `a1f4ff1e`  
**Extra-ship:** no (PR only; do not merge from this seat)

## Summary

H-2026-9116328 had to be published by hand (242 txs from `gpt-5.6-luna`) after haiku junk and a later batch died on the $0.25 per-doc ceiling with the good prior extract unused.

The autonomous cascade now:

1. Reuses a successful `extraction_runs` row **before** the per-doc spend gate ($0).
2. Calls models cheapest-first and skips a live call whose estimate would overshoot the remaining per-doc ceiling (`skippedUnaffordable`).
3. Quality-gates placeholder-asset and null-amount extracts so they cannot beat coherent siblings.
4. Publishes when remaining quality reads agree, including stored extracts from earlier batches.
5. Publishes a single quality survivor when the next call is unaffordable or a stored coherent extract exists. Transient 429/auth/timeout still retries.

Live ceilings stay **DOC=1 / AP=6 / DAY=10**. This change does not raise them.

## Files changed

- `app/src/extraction/bakeoff.ts` — cache-before-spend; unaffordable skip
- `app/src/extraction/agreement.ts` — cheap-first, stored reuse, quality-gated agree-to-publish
- `app/src/extraction/extractRouting.ts` — placeholder / null-amount quality reasons
- `app/src/extraction/storedRunPublish.ts` — same quality gate on stored-run publish
- `app/src/shared/llmSpend.ts` — `estimatedUsd` overshoot check
- tests under `app/src/extraction/__tests__/` and `app/src/shared/__tests__/docLlmSpend.test.ts`

## Verification

```bash
cd app && npm run typecheck && npm test
```

Targeted: agreement cascade / persist / autopublish / reuse-budget, extractRouting, bakeoff cache, docLlmSpend.

## Follow-ups

- Do not raise DOC/AP/DAY ceilings.
- Extra-ship no. Land via PR review, then the normal `main` → `bash app/scripts/ship.sh` path from a later seat if this is the chosen slice.
