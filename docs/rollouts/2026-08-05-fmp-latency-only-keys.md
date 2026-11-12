# FMP free keys: latency monitoring only

## Summary
Financial Modeling Prep free-tier keys are reserved for disclosure-latency probes.
They must not be used for enrichment, price refresh, or senate recovery.

## Changes
- Latency probes read only `FMP_LATENCY_API_KEY` and the secondary key (same prefix + `_2`).
- Per-key daily budget (default 235, free plan is 250) with independent KV counters
  (`fmp-latency:calls:key{1,2}:YYYY-MM-DD`) — **not** the shared enrichment `fmp:calls:*` counter.
- House+senate latest = 2 HTTP calls/run; ET-weighted spacing spreads remaining budget across the day.
- Enrichment FMP hard-disabled (`FMP_ENRICHMENT_ENABLED` ignored).
- Price refresh never selects FMP (peer / Massive / Tiingo only).
- `fmpSenateRecovery` still requires separate `FMP_API_KEY` and refuses latency keys.

## Verification
- Unit tests: dual-key select, interval weights, enrichment hard-off, prices without FMP.
- After deploy: confirm Infisical has both latency keys; admin disclosure-latency shows FMP configured;
  probe errors should mention cap/spacing rather than shared FMP_DAILY_CALL_CAP.

## Follow-ups
- Rematch latency candidates after deploy if FMP still shows 0 timed matches (matching/hash separate from budget).
- Ensure production `PRICE_PROVIDER` is peer/massive (not fmp).
