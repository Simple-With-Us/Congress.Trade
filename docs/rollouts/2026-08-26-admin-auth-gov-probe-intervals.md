# 2026-08-26 — Admin UI Session Access, Government Probe Intervals & 24h Price Snapshots

## Summary

1. **Admin & Review Queue Seamless UI**: Verified and configured session-based admin recognition without secondary login dialogs or browser token prompts. When a user authenticates with an email listed in `ADMIN_EMAILS` or `admin_allowlist`, the **Review Queue** and **Admin · Cadence** tabs are unhidden and fully operational via the `ct_session` cookie. Non-admins see a clean interface with zero admin-login chrome.
2. **Government Source Poll Interval Bracketing**: Recorded previous check timestamp ($T_{\text{prev}}$) and cadence interval ($\Delta t$) for every filing discovered on House, Senate, and Executive sources in `filings.prev_probe_at`, `filings.probe_interval_sec`, and `trade_latency_candidates.congress_window_start`.
3. **Expanded 24h Price Checkpoint Suite**: Extended `LATENCY_PRICE_EVENTS` to support `+6h`, `+12h`, and `+24h` event offsets alongside `[-30m, -15m, 0m, +5m, +15m, +30m, +1h]`. Batched resolution groups intraday requests by ticker to prevent redundant network calls.

## Files Changed

- `app/migrations/0096_gov_probe_intervals_and_24h_snapshots.sql`: Added columns `prev_probe_at` and `probe_interval_sec` to `filings`, and `congress_window_start` to `trade_latency_candidates`.
- `app/src/admin/migrations.ts`: Registered `GOV_PROBE_INTERVALS_SCHEMA_STATEMENTS` in `POST_0024_SCHEMA_STATEMENTS`.
- `app/src/ingestion/watcher.ts`: Implemented `getPreviousSuccessfulSourceAttemptAt` and passed interval brackets through `insertFilingIfNew` and `persistAndEnqueue`.
- `app/src/ingestion/detectionRoutes.ts`: Added `CT_INGEST_TOKEN` fallback in `requireIngestToken` and wired `prevProbeAt` / `probeIntervalSec` in `POST /detection`.
- `app/src/ingestion/tradeLatency.ts`: Loaded `f.prev_probe_at` in candidate context and persisted `congress_window_start` on `trade_latency_candidates`.
- `app/src/ingestion/latencyPriceSnapshots.ts`: Added `provider_plus_6h`, `provider_plus_12h`, `provider_plus_24h` to `LATENCY_PRICE_EVENTS`, `FOLLOW_EVENTS`, and `FOLLOW_MS`.

## Verification

- Ran `npm run typecheck` (`Check src/deno/main.ts` clean).
- Ran full test suite (`npm test`).
- Applied migration 0096 via idempotent migration handler (`POST /api/admin/migrate`).
