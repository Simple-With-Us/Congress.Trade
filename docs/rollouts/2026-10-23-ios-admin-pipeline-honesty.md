# 2026-10-23 — iOS admin pipeline honesty + ST peer price health check

## Summary

The iOS admin panel showed **Pipeline Status: Stalled** while every row it rendered looked OK because `/api/health` aggregates more checks than the UI listed (for example `senate_efd`, `polling_senate`, `price_freshness`, `ingestion_backlog`).  The `st_peer_prices` loud-alert stall detector also had no matching `/api/health` check, so webhook stalls could not appear in the panel.

This change adds an explicit `st_peer_prices` pipeline check (shared with the hourly stall sweep), downgrades expected datacenter **403** on the direct Senate eFD probe to **degraded** when the residential proxy is live, and expands the iOS admin sections so every check that can move `pipeline.status` is visible (with a catch-all section for future ids).

## Files changed

- `app/src/prices/stPeerPricesHealth.ts` — shared ST → CT price metrics + pipeline check
- `app/src/ingestion/pipelineStallConfig.ts` — stall-hour config (breaks import cycle)
- `app/src/shared/pipelineHealth.ts` — merge `st_peer_prices` check; senate_efd tier fix
- `app/src/ingestion/pipelineLoudAlerts.ts` — delegate ST price stall to shared module
- `app/src/shared/pipelineCheckLabels.ts` — admin labels
- `clients/ios/.../SettingsView.swift` — admin rows + prefer full `/api/health` for polling
- `app/src/ui/dashboardClient.ts` — owner banner for `st_peer_prices`

## Verification

- `cd app && npm run typecheck && npm test`
- `curl -sS https://congress.trade/api/health` includes `st_peer_prices` in `pipeline.checks`
- iOS Admin: stalled top-level status has at least one non-OK row in the expanded sections

## Follow-ups

- Link Linear CT issue once Agent-Sync MCP is authenticated in cloud (claim/closeout).
