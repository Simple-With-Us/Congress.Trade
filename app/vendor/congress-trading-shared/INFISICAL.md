# INFISICAL.md — congress-trading-shared

Owner directive (2026-10-03): Infisical is the sole source of truth for every app — secrets, env variables, and tunable settings knobs.  "Truth" means everything an app's behavior depends on that is not code.

This repo is the **pilot** for the fleet-wide rollout, and its role is special: the `congress-trading-shared` Infisical project (ID `6a953a29-8397-4a9d-a5a5-7d1b61e4a5e7`) is **intentionally empty** — a shared library holds no secrets of its own.  Instead, this repo is the home of the reusable pattern: `src/infisicalSettings.ts`, the generic zero-dependency Infisical settings client that every TypeScript app in the fleet will import.

## The policy

- Infisical holds secrets (API keys, tokens, webhook signing secrets, DB credentials), env config (service URLs, feature flags, region/plan selectors, integration endpoints), and tunable settings knobs (thresholds, limits, intervals, retry/backoff parameters, polling cadences, alert routing — anything an admin would tweak without a code deploy).
- Per-user settings (notification prefs, per-user API keys, UI preferences) live in each app's own store (DB) and are **explicitly out of scope** — they never go in Infisical.
- Local dev overrides are documented in `.env.example`; real values are never committed.
- Secret values never appear in code, logs, PR bodies, or chat — names and metadata only.

## The runtime contract

1. **Load at startup.**  `await settings.init()` fetches the full settings set for the app's project+environment into an in-memory cache.  Startup fails fast with a clear error naming the missing key and pointing at this file if required keys are absent.
2. **Never fetch per-request.**  `get()` / `getAll()` / `has()` / `getRequired()` read memory only — they make zero network calls, so they are safe in hot request/tick paths.  A per-request (or per-tick, per-event) call to Infisical is the one forbidden pattern.
3. **Background refresh.**  The cache refreshes on an interval (default 5 minutes, tunable via `refreshIntervalMs`) and on demand via `refresh()` (wire it to SIGHUP, an admin "Reload settings" action, or `applicationDidBecomeActive` as fits the app).  Refresh failures log loudly but keep serving the last-known-good cache — settings staleness is safer than an outage.
4. **Write-through on admin save.**  `set(key, value)` writes to Infisical FIRST (PATCH, falling back to POST/create on 404), then updates the local cache.  If the Infisical write fails, the save fails with `InfisicalWriteError` — the cache and Infisical never diverge silently.

## Admin gating

The settings/secrets surface (UI pages, API routes, CLI commands) is restricted to app admins only — whatever the app already uses for its owner/admin role; do not invent a parallel auth system.  In consuming apps, wire `set()` behind that existing admin gate.  This library itself has no UI and no admin concept; it only enforces the write-through ordering.

## Key inventory for THIS repo

**None — intentionally empty.**  The `congress-trading-shared` Infisical project (`6a953a29-8397-4a9d-a5a5-7d1b61e4a5e7`, environment prod; dev and staging retired 2026-10-10) holds zero keys today and is expected to stay near-empty: this library has no runtime behavior of its own, so it has nothing to configure.  What this repo ships is the **shared client module** (`src/infisicalSettings.ts`) that consuming apps point at *their own* Infisical projects.  If a key ever needs to live here (e.g. a fleet-wide default knob), it will be inventoried in this section first.

## Consuming the client (for fleet apps)

```ts
import { createInfisicalSettings } from "@jaywedgeworth22/congress-trading-shared";

const settings = createInfisicalSettings({
  projectId: "<this app's Infisical project ID>",
  environment: "prod",                        // prod is the only fleet environment (dev and staging retired 2026-10-10)
  refreshIntervalMs: 5 * 60 * 1000,           // default; tunable
});

// At startup:
await settings.init();

// Hot paths — memory only, never network:
const flag = settings.get("FEATURE_FLAG");
const interval = settings.getRequired("POLL_INTERVAL_MS");

// Admin save — write-through to Infisical first:
await settings.set("FEATURE_FLAG", "true");

// On demand (SIGHUP, admin "Reload settings"):
await settings.refresh();

// On shutdown:
settings.stop();
```

Auth: universal auth.  Credentials come from the `clientId`/`clientSecret` options, falling back to the `INFISICAL_CLIENT_ID` / `INFISICAL_CLIENT_SECRET` environment variables.  Keep those in the machine's secret store (Infisical machine identity), never in code.

## Rotation notes

- To rotate a value, an admin edits the key in the Infisical UI (or calls `settings.set()` from an admin surface) — the change propagates to running instances on the next background refresh (≤ 5 minutes by default), no deploy needed.
- To force immediate propagation, trigger an on-demand `refresh()` (SIGHUP handler, admin "Reload settings" action) on each instance.
- Rotating the universal-auth client secret itself: update `INFISICAL_CLIENT_SECRET` in the machine's secret store, then restart instances — the client re-authenticates on next startup (and once on a 401 mid-flight).
- If a refresh fails, instances log loudly (`[infisical-settings] Refresh failed ...`) and keep serving last-known-good values; fix Infisical-side access, and the next interval recovers automatically.
