# Latency scout handoff: consecutive errors, not permanent silence

## Summary
Handoff to the Mac residential scout is **not** a permanent 6-hour silence
rule. Server remains primary. Scout covers a provider only after **3 successive
server probe errors**. Budget/spacing skips and wall-clock quiet do **not**
open handoff. Scout success fills observations but does not reclaim the lane —
the **server** must succeed again to clear `needScout`.

When covering FMP, the Mac prefers the **secondary** free-tier key
(`FMP_LATENCY_API_KEY_2` / distinct `FMP_API_KEY`) so the server primary is not
double-spent.

## Why
Owner (2026-08-11): handoff after 2nd/3rd successive error; Mac may use a
different FMP key; the previous 6h silence handoff looked permanent and was
confusing.

## Behavior

| Event | consecutiveServerErrors | needScout |
|-------|-------------------------|-----------|
| Server success | 0 | false (server reclaims) |
| Server error #1, #2 | 1, 2 | false |
| Server error #3+ | ≥3 | true |
| Server budget_skip / disabled | unchanged | only if already ≥3 |
| Server not_configured | unchanged | true |
| Scout success/error | unchanged | stays true while ≥3 |

## Files
- `app/src/ingestion/scoutHandoff.ts` (v2 KV key; consecutive counter)
- `app/src/ingestion/__tests__/scoutHandoff.test.ts`
- `scout/congress-scout.mjs` (prefer secondary FMP key; no invent-needScout)

## Verification
- Unit: consecutive 1–2 no handoff; 3 opens; server success clears; silence alone no handoff
- After deploy: `GET /api/ingest/scout-plan` should not list FMP solely for quiet hours
