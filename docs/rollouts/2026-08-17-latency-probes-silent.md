# 2026-08-17 — Latency probes were silent for 95 hours

## Summary
Disclosure-latency probes wrote no observations from 2026-08-13 19:47Z (UW)
/ 2026-08-12 (FMP and Quiver) through 2026-08-17 18:50Z.  UptimeRobot
`congress.trade latency probes — all providers` was DOWN for 3d 11h.
`/api/health/latency` correctly returned 503.  Agents still reported the
lane as working because:

- `operationalStatus` is `running` whenever a key exists, not when
  observations refresh
- Quiver `lastSuccessAt` was minutes old with `lastFetchedRows=0`
- The public scorecard still showed stale FMP/Quiver/UW lead-lag counts
- House/Senate/Executive **polling** (a different check) was live

### What was actually broken
- **FMP:** slot-1 (`FMP_LATENCY_API_KEY`) still returned 200.  Rotation
  kept picking slot-2 (`FMP_API_KEY` / `_2`), which is FMP-bandwidth 429.
  Server recorded 12 successive `FMP_HTTP_429` and handed the lane to the
  Mac scout, which preferred slot-2 and then backed off all FMP.
- **Quiver:** live house/senate/trump endpoints return 403 "Upgrade your
  subscription plan".  `fetchQuiverRows` swallowed those with `.catch(() => [])`
  and recorded a server success.  No handoff.  Last observation 2026-08-12.
- **Unusual Whales:** HTTP 401 "token was invalid" since 2026-08-13.  Real
  key failure.  Needs a new UW token / plan.

Immediate mitigation: posted 46 FMP house+senate rows via
`POST /api/ingest/latency-payload` using slot-1.  FMP `last_observed_at`
is now 2026-08-17T18:50:29Z.  Health moved from stalled-95h to degraded
on Quiver (~132h) + UW (~95h).

## Files changed
- `app/src/ingestion/tradeLatency.ts` — do not swallow Quiver HTTP errors;
  mark a 429 FMP slot exhausted for the UTC day and retry the other key
  in the same cycle; `operationalStatus=error` when last observation is
  older than 24h
- `app/src/shared/pipelineHealth.ts` — a provider quiet past 48h stays
  degraded even after 7 days (never silently off)
- tests for the three behaviors

## Verification
- `cd app && npm run typecheck && npm test -- --run src/ingestion/__tests__/tradeLatency.test.ts src/shared/__tests__/pipelineHealth.test.ts`
- Live: `GET /api/health/latency` names Quiver + UW until those keys work
- Live: `SELECT provider, MAX(last_observed_at) FROM trade_provider_observations GROUP BY provider`

## Follow-ups
- Owner: renew Quiver plan or replace `QUIVER_API_KEY` so live house/senate
  feeds return 200
- Owner: replace `UNUSUALWHALES_API_KEY` (401 invalid token)
- Slot-2 FMP free key is bandwidth-capped; do not treat our daily ledger
  as FMP's own cap
