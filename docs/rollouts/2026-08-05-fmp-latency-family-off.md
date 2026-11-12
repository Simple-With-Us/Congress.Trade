# FMP latency family: registered OFF + alternate paths

## Summary
Register the **FMP source collection** (stable host + RapidAPI alternate path)
on Congress.Trade disclosure-latency monitoring and the Mac scout. Default
operational status is **OFF** (grey — intentional disable, no API spend) until
an operator enables probes. FMP remains CT latency + Mac scout only (not
Socratic product).

## Why
Free-tier FMP keys are scarce. Having FMP always-on in the latency cron burns
quota even when the race board is not being operated. Alternate hosts (stable
vs RapidAPI) should be wired so when probes turn ON they can race each other.

## Files changed
- `app/src/ingestion/tradeLatency.ts` — FMP family registry (`fmp`,
  `fmp_rapidapi`), `operationalStatus` enum (`off|running|error|stopped|unknown`),
  `FMP_LATENCY_PROBE_ENABLED` (default off), `FMP_LATENCY_PATHS`, path base
  overrides, dual-path fetch (query auth vs RapidAPI headers)
- `app/src/admin/routes.ts` — diagnostics connections for latency FMP paths;
  status `off` (grey); config-sources keys
- `app/src/ui/dashboardHtml.ts` — grey `.diag-status.off` + scoreboard OFF badge
- `app/src/analytics/routes.ts` — public summary includes `operationalStatus`
- `app/src/shared/types.ts`, `.dev.vars.example`, `app/docs/config-registry.md`
- `scout/congress-scout.mjs` + README — FMP registry, default OFF,
  `FMP_PROBE_ENABLED` / dual paths (mirrored to Mac `Congress.Trade/scout/`)
- tests: `tradeLatency.test.ts`

## How to turn FMP ON later
1. Infisical (or env): `FMP_LATENCY_PROBE_ENABLED=true`
2. Optional: `FMP_LATENCY_PATHS=stable,rapidapi` (default both when ON)
3. Keys: `FMP_LATENCY_API_KEY` (+ `_2`); optional `FMP_RAPIDAPI_KEY` for RapidAPI path
4. Optional base overrides: `FMP_STABLE_BASE_URL`, `FMP_RAPIDAPI_BASE_URL`,
   `FMP_RAPIDAPI_HOST`
5. Mac scout: `FMP_PROBE_ENABLED=1 FMP_API_KEY=… node scout/congress-scout.mjs`
6. Confirm admin Diagnostics shows Latency · FMP Stable / RapidAPI as **ok**
   (green), not **off** (grey)

## Verification
- Unit: FMP family default `operationalStatus=off`; path filter; force probe
  with OFF does zero HTTP
- `cd app && npm run typecheck && npm test` (focused + full gate as needed)
- Admin UI: OFF badges grey, not red/green

## Follow-ups
- Rematch / backfill candidates after first ON if historical coverage needed
- Confirm RapidAPI plan path shape if host differs from default
