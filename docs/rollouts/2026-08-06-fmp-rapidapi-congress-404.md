# 2026-08-06 — FMP RapidAPI congress 404 + dual free-tier keys [GROK]

## Summary

RapidAPI FMP **auth works** (`GET /v3/profile/AAPL` → 200) but the marketplace
product **does not expose** `house-latest` / `senate-latest` (all tested paths
→ HTTP 404 with `"Endpoint … does not exist"`). Direct stable FMP returns 200
with disclosure rows.

Root cause was a **product gap**, not a bad key or wrong host header. Keeping
`rapidapi` in the default path list wasted cycles (scout logs: `fmp_rapidapi
… HTTP 404`) and alternated away from free-tier stable capacity.

Fix:

1. Default `FMP_LATENCY_PATHS` / scout `FMP_PATHS` to **`stable` only**.
2. RapidAPI remains **opt-in** (`stable,rapidapi`) if FMP adds congress
   endpoints to the marketplace product later.
3. Dual free-tier keys rotate on stable: `FMP_LATENCY_API_KEY` +
   `FMP_LATENCY_API_KEY_2`, with **`FMP_API_KEY` as slot-2 fallback** when
   distinct (owner: two free accounts, no known per-IP limit → ~2× daily
   HTTP).
4. Infisical: set `FMP_LATENCY_PATHS=stable` (dual keys already present and
   distinct).
5. Restore `scout/run-scout.sh` with dual-key mapping + stable default.

## Files changed

- `app/src/ingestion/tradeLatency.ts` — default paths, dual-key resolve
- `app/src/ingestion/__tests__/tradeLatency.test.ts`
- `scout/congress-scout.mjs`, `scout/run-scout.sh`, `scout/README.md`
- `app/docs/config-registry.md`
- this rollout note

## Verification

- Live curl: RapidAPI profile 200; congress paths 404; stable house/senate 200
- `npm test -- src/ingestion/__tests__/tradeLatency.test.ts` (36 pass)
- Infisical lengths: two distinct free keys + `FMP_LATENCY_PATHS=stable`
- Scout restart: `fmp=on … freeKeys=2`, rapidapi `status=off`

## Follow-ups

- FMP trade-hash matching still weak (0 matches) — separate slice
- Re-enable RapidAPI path only after marketplace lists house/senate-latest
