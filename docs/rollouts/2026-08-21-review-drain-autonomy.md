# Review-queue drain autonomy (one blank row / filed-date vs trade date)

## Why items sat in review

Five unresolved House rows (eligible=0, so server extract idle 24h):

1. `H-2025-8221264` Khanna (Gemini 210 lots).  209 dated.  One spouse "Sap Ag CMN" row omitted date+amount.  `missing_tx_date` + `no_amount` on that single row held the filing (`local_vision_submitted`).  **Confirmed live 209 rows this session.**
2. `H-2025-20033330` Sessions electronic PTR.  Certified purchase 10/24/2025, Clerk filed_date 10/22/2025 (signature).  `future_tx_date` was a hard fail vs filed_date, so admin confirm also 400'd.  The date is not in the future relative to today.
3. `H-2024-8220711` / `H-2024-8220192` / `H-2025-8220750` Khanna attached-schedule scans.  `server_cpu` letterhead inventories (400+ undated chrome rows) parked as `agreement_cascade_unresolved` or `likely_garbage`.  A later Grok/Gemini read of the real lots was blocked when it had fewer total rows than the chrome flood (`storedReviewBlocksSmallerVisionSubmit`).

## Fixes

- Local vision: `missing_tx_date` no longer holds sibling trades.  Undated rows are dropped from persist.  (Same shape as the #2144 `no_amount` sibling rule.)
- `future_tx_date` hard-fails only when `txDate > today`.  A disclosed trade after Clerk's filed_date gets a soft `tx_after_filed_date` penalty and can publish.
- Admin confirm accepts that same clock rule (still refuses dates that have not happened).
- Vision ingest: a shorter submit is allowed when it has **more dated rows** than the stored payload (chrome floods vs real lots).

## Probes

House/Senate/Executive `polling_*` checks were live.  House 26m at 20:17 ET was the designed LOW-window ~30 min floor (plus a Coolify 502 blip).  After recovery: House 4m, Senate 5m, Executive 14m (15 min weekday floor).  Tightening overnight to 10 min does not fit the current 171/day House budget (gap stayed ~17 min in simulation).  Left the schedule; did not steal peak 09:00 probes.

## Verify

```bash
cd app && deno check src/deno/main.ts && npx vitest run src/extraction/__tests__/normalizer.test.ts src/extraction/__tests__/visionSubmitGuard.test.ts src/admin/__tests__/reviewQueue.test.ts
curl -sS https://congress.trade/api/health | python3 -c "import json,sys; d=json.load(sys.stdin); print([(c['id'],c['status'],c['detail'][:80]) for c in d['pipeline']['checks'] if c['id'].startswith(('poll','extract','data'))])"
```
