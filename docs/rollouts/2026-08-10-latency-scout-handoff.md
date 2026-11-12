# Latency scout handoff (server-first + residential fallback)

## Summary
Server keeps primary ownership of disclosure-latency probes (FMP / Unusual Whales /
Quiver). When a source fails, is misconfigured, or has gone quiet (>6h), the Mac
residential scout takes over that source and posts provider payloads back to the
app. The scout also downloads filing PDF/HTML bytes and uploads them to
**Cloudflare R2** (`RAW_FILES`) when datacenter IPs are blocked (Senate Imperva,
House WAF 403s, agreement wall).

## Why
- FMP latency was silently quiet for ~87h while still showing `operationalStatus=running`.
- Mac scout already detected House/Senate filings but never fed **provider
  observations** into the scoreboard and never uploaded **raw** bytes.
- Filing storage is R2 (not Backblaze).

## Files changed
- `app/src/ingestion/scoutHandoff.ts` — health KV + scout plan + needScout rules
- `app/src/ingestion/tradeLatency.ts` — record probe outcomes; `ingestScoutLatencyPayload`
- `app/src/ingestion/detectionRoutes.ts` — `GET /scout-plan`, `POST /latency-payload`, `POST /raw`
- `scout/congress-scout.mjs` + `run-scout.sh` + `README.md` — handoff client + raw upload
- tests: `scoutHandoff.test.ts`, `detectionRoutes.test.ts`

## Verification
- `cd app && npm run typecheck && npm test -- --run src/ingestion/__tests__/scoutHandoff.test.ts src/ingestion/__tests__/detectionRoutes.test.ts src/ingestion/__tests__/tradeLatency.test.ts`
- After deploy: `GET /api/ingest/scout-plan` with `INGEST_TOKEN` shows FMP `needScout` until scout posts
- Scout log: `HANDOFF latency`, `LATENCY fmp upserted=…`, optional `RAW H-…`
- `/api/health` latency_probes should leave degraded once FMP observations refresh

## Follow-ups
- Restart pm2 `scout` after deploy so the new scout binary is live
- Optional: set `SCOUT_LATENCY_ALWAYS=1` temporarily for denser dual-path coverage
