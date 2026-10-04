# INFISICAL.md — Infisical as Sole Source of Truth (Congress.Trade)

Fleet-wide directive (2026-10-03): **Infisical is the sole source of truth** for this app.  "Truth" means secrets AND env vars AND tunable settings knobs — everything the app's behavior depends on that is not code.  Per-user settings stay in the app's own store and never go in Infisical.

Two spaces between sentences in this file per the owner's prose style.

## Infisical project

- Project: **`congress-trade`** (`f61a79de-8d77-4f0b-9361-4b7208598290`), org `jays-services`.
- Plus imports from the shared project **`shared-at-ct`** (fleet-wide keys like `AGENT_SYNC_TOKEN` — they MUST live only there; duplicating them on this project shadows the shared row and makes rotation a multi-project chore).
- Environments: `dev` / `staging` / `prod`.  Production reads `prod`.
- Bootstrap identity is the org machine identity (universal-auth client id/secret); only these bootstrap vars stay in process env — they are the chicken-and-egg: `INFISICAL_APP_CLIENT_ID`, `INFISICAL_APP_CLIENT_SECRET`, `INFISICAL_SHARED_CLIENT_ID`, `INFISICAL_SHARED_CLIENT_SECRET`, `INFISICAL_APP_PROJECT_ID`, `INFISICAL_SHARED_PROJECT_ID`, `INFISICAL_ENV`, `INFISICAL_BASE_URL`.

## Runtime contract

1. **Load at startup.** `app/src/deno/main.ts` calls `refreshSecrets()` then `initSettings()` at boot, which fetches the full knob set (`APP_SETTINGS` in `app/src/settings/settingsService.ts`) into an in-memory snapshot.  All later reads are synchronous and memory-only.
2. **Never fetch per-request.** `appSettings().get*()` never touches the network.  A per-request Infisical call anywhere in the request/tick path is the one forbidden pattern.
3. **Background refresh.** `startSettingsRefresh()` re-reads on an interval (default 5 minutes, itself the `INFISICAL_CACHE_TTL_SECONDS` knob), plus the scheduled-tick `secrets_refresh` lane and the SIGHUP handler in `main.ts` (on-demand reload).  Refresh failures log loudly and keep serving the **last-known-good** snapshot — staleness is safer than an outage.
4. **Write-through on admin save.** `settings.set(key, value)` writes to Infisical FIRST via `updateSecret`, then updates the snapshot.  A failed Infisical write fails the save — the cache and Infisical never diverge silently.  Admin surface: `PUT /api/admin/settings` (and the existing `POST /api/admin/diagnostics/secrets/update`).

## What lives in Infisical (key inventory — names only, never values)

- **Secrets:** `FMP_API_KEY`, `MASSIVE_API_KEY`, `OPENROUTER_API_KEY`, `OPENROUTER_BACKUP_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `CT_GEMINI_API_KEY`, `MISTRAL_API_KEY`, `XAI_API_KEY`, `LLAMAPARSE_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESIDENTIAL_PROXY_URL`, `HOUSE_PROXY_URL`, `SENATE_PROXY_URL`, proxy username/password keys, `TURSO_AUTH_TOKEN`, `TURSO_DATABASE_URL` (legacy names now pointing at the local SQLite file), `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `CLOUDFLARE_R2_ANALYTICS_TOKEN`, `WEBHOOK_SIGNING_KEY`, `REVIEW_QUEUE_PUBLISHER_WEBHOOK_SECRET`, `GOOGLE_OAUTH_CLIENT_ID`, `X_OAUTH_CLIENT_ID`, `APPLE_DEVICE_ENTITLEMENT_SECRET`, Sentry/Datadog/Pushover/usage-monitor tokens.
- **Env config:** `APP_BASE_URL`, `SENTRY_ENVIRONMENT`, `OGE_INDEX_URL(S)`, `SEED_HOUSE_URL`, `SEED_SENATE_URL`, `FMP_*_BASE_URL`, provider enable flags (`*_ENABLED`).
- **Tunable knobs (this is the governed set, `APP_SETTINGS`):** `CT_CRON_SCHEDULE`, `CT_DRAIN_LIMIT`, `CT_DRAIN_CLAIM_SIZE`, `CT_OUTBOX_LIMIT`, `CT_DISABLE_INTERNAL_CRON`, `CT_TICK_DEADLINE_MS`, `CT_TICK_STUCK_MINUTES`, `INFISICAL_CACHE_TTL_SECONDS`, `R2_USAGE_DIGEST_UTC_HOUR`, `RETENTION_DELETE_RAW_OBJECTS`, `CT_UI_LOGO_DISPLAY`.
- Secret keys that exist in code but are **not yet created in the project** are documented in PR bodies as "to be filled by admin" — never invent, guess, or copy values.

## Explicitly NOT in Infisical

- **Per-user settings:** per-user notification prefs (`users.notification_settings`), per-user session/token rows, UI preferences in browsers — these live in SQLite (`/data/congress-trade/db.sqlite`) and never enter Infisical.
- **Benchmark lineup settings:** `benchmark_settings_*` DB tables with leases — operational app state with ownership semantics, kept in the app's own store.
- **Boot-only bindings:** `PORT`, `DENO_KV_PATH`, and the `INFISICAL_*` bootstrap identity — process env by design (Coolify/Docker), listed in `.env.example` without values.
- **Admin bootstrap tokens:** `ADMIN_TOKEN` / `ADMIN_MAINTENANCE_TOKEN` / `ADMIN_EMAILS` — required to authenticate the very admin surface that edits settings; they stay in process env.

## Cache / refresh / write-through summary

- In-memory snapshot per settings key; optional encrypted KV copy (`infisical_secrets_cache:*`, AES-GCM, TTL-bounded) survives restarts without re-auth.
- Refresh interval: `INFISICAL_CACHE_TTL_SECONDS` (default 300s), set in Infisical itself.
- Failed refresh: keep last-known-good, log loudly (`settings.refresh failed ... keeping last-known-good snapshot`).
- Admin write: `updateSecret` (PATCH, fallback POST create) → `refreshSnapshot` → response.  Preview deployments reject writes with `403 preview_write_protected`.

## Admin gating

The whole `/api/admin/*` surface sits behind `buildAdminRouter()`'s auth gate: full admin (Bearer `ADMIN_TOKEN` or Cloudflare Access allowlist email, incl. Google sessions / iOS `ct_session`), or scoped tokens (`INGEST_TOKEN`, `ADMIN_MAINTENANCE_TOKEN`) on their narrow paths only.  Non-admins get **401** (the app's existing convention; preview writes get 403).  The admin UI hides admin tabs for non-admins.  The settings surface has no parallel auth system — it reuses this gate.

## Rotation

1. Rotate the value in Infisical (prod env, `congress-trade` or `shared-at-ct`).
2. The next background refresh (≤5 min) or `POST /api/admin/diagnostics/secrets/refresh` picks it up; or SIGHUP the container.
3. No deploy needed.  Never commit the value anywhere.

## Lint

`grep -rn "Deno\.env\.get('CT_" app/src` should return no tunable-knob reads outside the settings service (bootstrap reads in `main.ts` for `PORT`/`DENO_KV_PATH` and the Infisical bootstrap block are intentional and exempt).
