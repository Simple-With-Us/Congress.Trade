# Config Registry — Infisical as the Single Source of Truth

Last updated: 2026-08-20

**Current shape:** production is Coolify Deno-in-Docker on Hetzner, local
SQLite + Litestream, Infisical secrets.  Deno Deploy and Turso are retired.
Do not set production secrets "in Deno Deploy."  Edit Infisical (and Coolify
only for the Infisical bootstrap + `TURSO_DATABASE_URL=file:…` override).

Every configuration key and knob the Coolify Deno process reads is routed
through the Infisical runtime resolver (`src/secrets/infisical.ts`) unless
listed under **Env-only** below. Resolution order per key:
1. **Infisical** — the value set in the Infisical project (env `prod` by
   default). Edits go live within the resolver cache TTL
   (`INFISICAL_CACHE_TTL_SECONDS`, default 600s) with **no redeploy**.
   The resolver merges **shared-at-ct first, then the app project**.  A
   name that exists in both is shadowed by the app row — so fleet-wide
   keys (`AGENT_SYNC_TOKEN`, `AGENT_SYNC_POST_TOKEN`) live **only** in
   shared.  Do not copy them onto the ST or CT app projects.
2. **Env fallback** — Coolify container env, or local `.dev.vars` for tests.
   Kept so keyless local dev / tests still boot and so an Infisical outage
   never leaves production unconfigured. Disable with
   `INFISICAL_ALLOW_ENV_FALLBACK="false"` to hard-require Infisical.

**Operate by editing Infisical, not Deno Deploy and not wrangler.toml.**
There is no production `wrangler.toml`.  Audit which source is live for
every key at any time: `GET /api/admin/config-sources` (admin-gated; reports
names + sources only, never values).

## Infisical-tunable (everything here is live-editable)

### Provider API keys
`FMP_API_KEY`, `TIINGO_API_KEY`, `MASSIVE_API_KEY`, `INTRINIO_API_KEY`,
`TWELVEDATA_API_KEY`, `FINNHUB_API_KEY`, `UNUSUAL_WHALES_API_KEY`,
`QUIVER_API_KEY`, `QUIVER_API_TOKEN`, `AINVEST_API_KEY`,
`LOGODEV_PUBLISHABLE_KEY` (alias accepted at runtime: `LOGO_DEV_TOKEN` — Coolify name)

### Model/LLM keys
`GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `MISTRAL_API_KEY`,
`XAI_API_KEY`, `OPENROUTER_API_KEY`, `LLAMAPARSE_API_KEY`,
`ARBITRATION_API_KEY`

`OPENROUTER_API_KEY` is the unified transport for ALL live LLM extraction
(agreement trio + benchmark candidates); its configured/health status is
surfaced in `GET /api/admin/diagnostics` (`provider:openrouter`) and
`GET /api/admin/config-sources`.

### Auth, billing, email
`ADMIN_TOKEN`¹, `INGEST_TOKEN`, `ADMIN_MAINTENANCE_TOKEN`², `ADMIN_EMAILS`, `ACCESS_AUD`,
<<<<<<< HEAD
`REVIEW_QUEUE_PUBLISHER_WEBHOOK_URL`, `REVIEW_QUEUE_PUBLISHER_WEBHOOK_URL_GB`,
=======
`REVIEW_QUEUE_PUBLISHER_WEBHOOK_URL`, `REVIEW_QUEUE_PUBLISHER_WEBHOOK_URL_GB` (optional GB Publisher fan-out; same `_SECRET`),
>>>>>>> origin/main
`REVIEW_QUEUE_PUBLISHER_WEBHOOK_SECRET`,
`ACCESS_TEAM_DOMAIN`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`,
`WEBHOOK_SIGNING_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_ANNUAL`, `STRIPE_TRIAL_DAYS`,
`STRIPE_MANAGED_PAYMENTS`, `RESEND_API_KEY`, `EMAIL_FROM`, `ALERT_EMAIL`

² Scoped like `INGEST_TOKEN`: authorizes ONLY the idempotent maintenance
endpoints (`POST /api/admin/ingest-requeue-failed`,
`POST /api/admin/ingest-retry-errored`) — never migrations, review
resolution, or config writes. Safe to hand to agent/automation sessions so
they can drain backlogs without holding `ADMIN_TOKEN`. Worst case if leaked:
someone re-runs an idempotent requeue.

¹ Admin AUTH accepts the Infisical value (rotation works live). Keep a strong
`INFISICAL_APP_CLIENT_SECRET` set as a Coolify env regardless: the encrypted
KV cache of resolved secrets keys off the Infisical client secret (falling
back to the env `ADMIN_TOKEN`), so pulling ADMIN_TOKEN out of container env is
safe only while a strong client secret exists.

### Fleet coordination (shared-at-ct ONLY)
`AGENT_SYNC_TOKEN`, `AGENT_SYNC_POST_TOKEN` — one pair for every app.
Rotate in the shared project; never duplicate onto `socratic-trade` or
`congress-trade` app projects.  Local Mac copy: `~/.secrets/agent-sync.env`.

### Integrations
`APP_B_IMPORT_URL`, `APP_B_INGEST_TOKEN`, `USAGE_MONITOR_ENABLED`,
`USAGE_MONITOR_INGEST_URL`, `USAGE_MONITOR_INGEST_TOKEN`,
`USAGE_MONITOR_ENVIRONMENT`², `USAGE_MONITOR_READ_TOKEN` (optional; read-only
budget-status polling, see Tunables & flags below)

### Datadog (existing fleet account — no new plan)
Coolify / Infisical names only.  Values are never invented.  Missing or
partial keys fail closed (the app boots; nothing is sent).

Backend logs + APM (agentless HTTP intake from the Deno container):
`DD_API_KEY`, `DD_SITE` (required together; known sites only, e.g.
`us5.datadoghq.com`).  Optional: `DD_SERVICE` (default `congress-trade`),
`DD_ENV` (falls back to `SENTRY_ENVIRONMENT` / `USAGE_MONITOR_ENVIRONMENT`).
`DD_APP_KEY` is accepted for fleet registry completeness and is **not**
required to send logs or traces.

Public RUM (injected into `/`, legal pages, and the shared dashboard document
via `%GA_SCRIPT%` — not Admin copy).  Requires all three: a client token, an
application id, and a site.  Canonical: `DD_CLIENT_TOKEN`,
`DD_APPLICATION_ID`, `DD_SITE`.  Aliases also accepted:
`DD_RUM_CLIENT_TOKEN`, `NEXT_PUBLIC_DD_CLIENT_TOKEN`,
`NEXT_PUBLIC_DD_RUM_CLIENT_TOKEN`, `DD_RUM_APPLICATION_ID`,
`NEXT_PUBLIC_DD_APPLICATION_ID`, `NEXT_PUBLIC_DD_RUM_APPLICATION_ID`,
`NEXT_PUBLIC_DD_SITE`.  Session Replay stays off.  Do not mint a new RUM
application from this repo; reuse an existing Browser RUM app on the
current Datadog account.

### Tunables & flags
- Budgets/pacers: `FMP_DAILY_CALL_CAP`, `FMP_MAX_PER_MINUTE`,
  `EDGAR_MAX_PER_MINUTE`
- Providers/routing: `PRICE_PROVIDER`, `APP_BASE_URL`
- Anti-scrape: `SCRAPE_GUARD_ENABLED`
- Disclosure-latency race: `DISCLOSURE_LATENCY_WATCH_ENABLED`,
  `DISCLOSURE_LATENCY_PROVIDERS`, `DISCLOSURE_LATENCY_WATCH_LIMIT`,
  legacy `FMP_DISCLOSURE_WATCH_ENABLED` / `FMP_DISCLOSURE_WATCH_LIMIT`,
  **FMP family (latency probes only; default ON for CT when keys present):**
  `FMP_LATENCY_PROBE_ENABLED` (explicit false/off disables; grey OFF),
  `FMP_LATENCY_PATHS` (congress probes are **stable only**. RapidAPI
  house/senate-latest **404** as of 2026-09-04 and is not fetched even if
  listed — it does not replace stable. Dual keys
  `FMP_LATENCY_API_KEY` + `FMP_LATENCY_API_KEY_2` fail over on 429 / daily cap
  / 401 / 403),
  optional `FMP_STABLE_BASE_URL` / `FMP_RAPIDAPI_BASE_URL` / `FMP_RAPIDAPI_HOST`,
  `FMP_RAPIDAPI_KEY` **or shared `RAPIDAPI_KEY`** (ST marketplace convention —
  never free-tier `FMP_LATENCY_*` on the RapidAPI host),
  `FMP_RAPIDAPI_DAILY_CAP` is not spent on house/senate probes (those routes 404),
  `FMP_LATENCY_DAILY_CAP` (per free-tier key, default 235), dual free keys
  `FMP_LATENCY_API_KEY` + `_2` (or `FMP_API_KEY` as slot-2 fallback) **rotate and
  fail over** (429 / cap / 401 / 403) for ~2× capacity — no known per-IP limit,
  `UW_LATENCY_DAILY_CAP` (default 240 HTTP/day incl. deep-match),
  `QUIVER_LATENCY_DAILY_CAP` (default 360 HTTP/day; 3 calls per probe),
  `UW_DEEP_MATCH_DATES_PER_RUN` (UW deep-match date budget; default `8`).
  **Yield-weighted spacing (all three):** now read from the MEASURED windows in
  `src/ingestion/probeSchedule.ts` (provider profile: peak 09–10 / high 16–18 /
  mid 10–16+18–21 / low 21–09 ET), so daily budgets run densest in the hours
  filings actually arrive and sparse overnight. The previous 08–12/12–16 bands
  were **guessed, and measurement showed them wrong** — 10:00 ET was being
  probed at burst rate an hour after the burst. Set `PROBE_SCHEDULE_ENABLED=0`
  to restore the old band table. See `docs/probe-schedule.md`.
- Adaptive probe cadence (`src/ingestion/probeSchedule.ts`, measured windows —
  full reference in **`docs/probe-schedule.md`**): `PROBE_SCHEDULE_ENABLED`
  (default on), `PROBE_SCHEDULE_MIN_INTERVAL_SEC` (default `60`, politeness
  floor), `PROBE_SCHEDULE_MAX_INTERVAL_SEC` (default `1800` — the **coverage
  floor**: no window ever goes longer than this between probes),
  `PROBE_SCHEDULE_WEEKEND_MAX_INTERVAL_SEC` (default `3600`),
  `PROBE_SCHEDULE_PEAK_TROUGH_RATIO` (default `30`; R = 4 is measurably worse
  than today at peak — table in the doc),
  `PROBE_SCHEDULE_RETRY_HEADROOM` (default `0.1`),
  `PROBE_SCHEDULE_ALLOCATION_EXPONENT` (default `1` = proportional),
  `PROBE_SCHEDULE_HOUSE_BUDGET` / `PROBE_SCHEDULE_SENATE_BUDGET` (default `171`
  probes/weekday each — a self-imposed politeness budget, **not** a documented
  Clerk rate limit), `PROBE_SCHEDULE_PROVIDER_BUDGET` (default `240` runs),
  `PROBE_SCHEDULE_EXECUTIVE_BUDGET` (default `107` weekday probes — 96
  spendable after 10% headroom = a flat 15-minute coverage floor; there is
  **no measured OGE arrival-hour sample**, so this is not a 78% peak curve),
  and `PROBE_SCHEDULE_JSON` for a full window-table override.  Every key is
  optional and total: a malformed value degrades to the shipped default rather
  than stalling ingestion, so the windows can be retuned live when Congress
  recesses or the Clerk changes publication times — no redeploy.
  Production should keep these set in Infisical:
  `DISCLOSURE_LATENCY_WATCH_ENABLED=true`,
  `DISCLOSURE_LATENCY_PROVIDERS=fmp` (add `unusual_whales,quiver` only after paid/trial keys; add `fmp_rapidapi` only if marketplace lists house/senate/executive-latest),
  `DISCLOSURE_LATENCY_WATCH_LIMIT=100`,
  `FMP_LATENCY_PROBE_ENABLED` unset (default ON) or false to disable spend,
  `FMP_LATENCY_PATHS=stable`,
  `UW_DEEP_MATCH_DATES_PER_RUN=8`. Provider API keys
  (`FMP_LATENCY_API_KEY` + `_2` / `FMP_API_KEY` slot-2, `RAPIDAPI_KEY` /
  `FMP_RAPIDAPI_KEY`, `UNUSUAL_WHALES_API_KEY` / `UNUSUALWHALES_API_KEY`,
  `QUIVER_API_KEY`) live under Infisical (shared holds `RAPIDAPI_KEY`; CT app
  holds UW + FMP latency). FMP dual free keys rotate; RapidAPI path is optional
  (default off — congress endpoints 404 on marketplace product). Multi-avenue
  rotation (`selectRotatedAvenue`) is the multi-key/host pattern. FMP is CT
  latency + Mac scout only — not Socratic product.

- **Probe leases (server ⇄ Mac mutual exclusion):**
  `LATENCY_LEASE_SERVER_TTL_SEC` (default `1200`, clamped 30–3600),
  `LATENCY_LEASE_MAC_TTL_SEC` (default `150`, same clamp),
  `LATENCY_MAC_TENURE_HOURS` (default `6`, clamped 0.25–48).
  Exactly one host may poll a provider at a time. The lease lives in D1
  (`latency_probe_leases`, migration 0084) because the claim must be atomic —
  KV has no compare-and-set, so two acquirers could both win. Leases
  self-expire, so a crashed holder cannot park a lane.

  The server holds every lane while healthy. On the 3rd successive server
  error (`LATENCY_SCOUT_CONSECUTIVE_ERRORS`) it **releases the lane and stops
  fetching that provider**; the Mac scout may then acquire it. After
  `LATENCY_MAC_TENURE_HOURS` the server preempts and runs a reclaim probe even
  if the Mac is succeeding — the server is always preferred when it can do the
  work. Mac grants are charged to the **same** daily counters the server
  spends from (`latency-budget:*`, `fmp-latency:calls:key*`), so
  `UW_LATENCY_DAILY_CAP` / `QUIVER_LATENCY_DAILY_CAP` / `FMP_LATENCY_DAILY_CAP`
  now bound both hosts together rather than the server alone.

  Scout side: `SCOUT_HOLDER_ID` (default `mac-<hostname>`) — keep it stable, or
  a restart resets the tenure clock. The scout acquires via
  `POST /api/ingest/probe-lease` each cycle and does **not** poll when the
  server is unreachable (it cannot tell whether the server is already polling).
  Operator view: `GET /api/ingest/probe-leases` shows current holder, expiry,
  tenure, and remaining daily budget per provider.

- Ingestion: `HOUSE_LIVE_SEARCH_ENABLED`, `SEED_HOUSE_URL`, `SEED_SENATE_URL`
- Executive (OGE 278-T) watcher: `OGE_WATCH_ENABLED`, `OGE_INDEX_URL`,
  `OGE_MAX_VISION_BYTES`.  Cadence is `probeSchedule` / `decideSourcePoll`
  (weekday 15-minute coverage floor, weekend hourly like House; politeness
  floor 60s).  `OGE_POLL_INTERVAL_SEC` is **unused** — a leftover Infisical
  `21600` must not re-impose 6h.  Fetch is **server-first**: direct
  `extapps2.oge.gov`, then Mac/scout `POST /fetch-oge` if
  `OGE_RELAY_URL` / `INGEST_RELAY_URL` is set and direct fails.  House
  bulk index is the same (direct Clerk, then `/fetch-house`).  Senate
  eFD stays **relay-first** — Imperva 403s the box.  Failure skip
  matches House/Senate `last_attempt`
  (never a shorter-than-success 10-minute backoff).
- Extraction: `VISION_PRIMARY_MODEL`, `ARBITRATION_ENABLED`,
  `ARBITRATION_MODEL`
- OpenRouter PDF pipeline: `OPENROUTER_MODEL` (default
  `~google/gemini-flash-latest`, currently Gemini 3.7), `OPENROUTER_PDF_ENGINE_TEXT` (file-parser engine
  for typed/text PDFs; default `cloudflare-ai` — free markdown conversion),
  `OPENROUTER_PDF_ENGINE_SCANNED` (engine for scans read by
  non-native-vision models; default `mistral-ocr`, $2/1k pages),
  `OPENROUTER_MAX_PRICE` (optional per-request provider price ceiling, JSON
  like `{"prompt":5,"completion":20}` in USD per million tokens — composes
  with the daily USD budget governors, it does not replace them)
- Agreement autopublish controls and per-chamber lineups:
  `AGREEMENT_AUTOPUBLISH_ENABLED`,
  `AGREEMENT_HOUSE_MODEL_A/B/C`, `AGREEMENT_SENATE_MODEL_A/B/C`, and
  `AGREEMENT_EXEC_MODEL_A/B/C`,
  `AGREEMENT_AUTOPUBLISH_LIMIT`, `AGREEMENT_MAX_ATTEMPTS`,
  `AGREEMENT_DAILY_LLM_BUDGET`, `AGREEMENT_BIG_DOC_START_TIER2`,
  `AGREEMENT_BIG_DOC_PAGE_THRESHOLD`, `AGREEMENT_BIG_DOC_BYTES_THRESHOLD`,
  `AGREEMENT_TEXT_NORMALIZATION` (default `true`; the cascade's 7 free-text
  material fields — assetName, assetType, assetTypeName, subholding,
  location, description, supplementalText — compare through a canonical
  casefold/punctuation-stripped/company-suffix-normalized form instead of
  byte equality, so cross-vendor formatting drift no longer blocks agreement;
  set `false` to restore byte-strict comparison on every cascade tier)
- Provider-health routing + runtime overlay (`src/extraction/providerHealth.ts`;
  billing/auth failures open a per-`provider:model` circuit breaker and the
  live extractor substitutes the cheapest healthy catalog candidate at
  runtime — the configured lineup stays authoritative and resumes on
  recovery):
  - `PROVIDER_HEALTH_WINDOW_MINUTES` — rolling health window (default `15`)
  - `PROVIDER_HEALTH_CONSECUTIVE_THRESHOLD` — consecutive billing/auth
    failures that open the per-model breaker (default `5`)
  - `PROVIDER_HEALTH_FAILURE_RATE` — windowed billing/auth failure-rate trip
    (default `0.8`, needs `PROVIDER_HEALTH_MIN_SAMPLES`, default `5`)
  - `PROVIDER_OVERLAY_ENABLED` — runtime substitution for a breaker-blocked
    slot (default on; `false` restores skip-to-failover-only behavior)
  - `PROVIDER_OVERLAY_COST_RATIO_LIMIT` — substitutes costing more than this
    multiple of the configured slot's rate-card cost are flagged in the
    `ingestion_decisions` audit + diagnostics, never selected silently
    (default `3`)
  - `PROVIDER_MODEL_BAN_TTL_SECONDS` — per-model breaker TTL (default `3600`)
- Backlog autopilot (`src/extraction/autopilot.ts`; cron-gated, queue-driven
  drain of the unresolved review backlog through the SAME agreement cascade —
  status/receipts at `GET /api/admin/autopilot/status`, halted runs need
  `POST /api/admin/autopilot/acknowledge` before a new run may start):
  - `AUTOPILOT_ENABLED` — master switch; effective only where
    `AGREEMENT_AUTOPUBLISH_ENABLED=true`, and `false` disables the autopilot
    without touching the per-minute cascade (default on)
  - `AUTOPILOT_BACKLOG_THRESHOLD` — unresolved-review count that triggers an
    extra same-day run (default `150`; a run always triggers on the first
    cron tick of each UTC day, and also on any tick with claimable
    eligible-due docs — attempts under cap, next_attempt due, raw bytes,
    not suppressed/terminal)
  - `AUTOPILOT_DAILY_USD_BUDGET` — per-UTC-day USD spend meter priced via the
    shared benchmark rate card; reservations happen BEFORE model calls and
    the run halts when exhausted (default `5.00`)
  - `AUTOPILOT_MAX_DOCS_PER_RUN` — pilot-sized run cap (default `50`)
  - `AUTOPILOT_ERROR_CLASS_HALT_THRESHOLD` — same-class error count
    (billing/auth/quota/parse/timeout) that halts the whole run with a
    receipt requiring acknowledgment (default `2`)
  - `AUTOPILOT_MIN_INTERVAL_MINUTES` — spacing between backlog-triggered runs
    (default `60`)
  - `AUTOPILOT_BATCH_PRESEED` — pre-seed cascade reads through the cheaper
    direct-provider batch APIs where the chamber trio supports it (default
    off; a no-op for all-OpenRouter trios)
- Monitor-informed budget throttle (`src/shared/monitorBudgetGate.ts`; a
  read-side self-throttle feedback loop — polls the API Usage Monitor's
  cross-app `GET /api/budget-status` so the backlog autopilot backs off a
  provider the monitor already reports at/over budget. Advisory ONLY: it
  composes under the autopilot's own `AUTOPILOT_DAILY_USD_BUDGET` above and
  never touches the essential real-time per-filing ingestion path. FAILS OPEN
  on any error/timeout/misconfiguration — never throttles when it can't get a
  clean answer):
  - `USAGE_MONITOR_READ_TOKEN` — dedicated read token for `GET
    /api/budget-status`; falls back to `USAGE_MONITOR_INGEST_TOKEN` when unset
    (mirrors the monitor's own `USAGE_READ_TOKEN`\|\|`USAGE_INGEST_TOKEN`
    convention)
  - `USAGE_MONITOR_BUDGET_THROTTLE_ENABLED` — master on/off switch (default
    on whenever `USAGE_MONITOR_INGEST_URL`/token are configured)
  - `USAGE_MONITOR_BUDGET_THROTTLE_THRESHOLD` — fraction of monthly budget
    (0-1) at/above which a provider counts as throttled (default `1.0`, i.e.
    the monitor's own `exceeded` status; lower to back off earlier, e.g.
    `0.9`)
  - `USAGE_MONITOR_BUDGET_STATUS_CACHE_TTL_MS` — in-isolate cache TTL for the
    polled response (default `120000` = 2min)
  - `USAGE_MONITOR_BUDGET_STATUS_TIMEOUT_MS` — bounded request deadline for
    the poll itself (default `5000`, hard cap `15000`)
- Document classifier (`src/extraction/docClassifier.ts`; assigns
  `filings.doc_class` ∈ typed | clean_scan | hard_scan | empty | corrupt —
  deterministic signals first, ONE ~free enum-constrained OpenRouter call
  only for ambiguous scans. Consumers: autopilot ordering (typed/clean
  first), cascade start tier (hard_scan → full trio), empty auto-resolve +
  corrupt quarantine, receipt attribution):
  - `DOC_CLASSIFIER_ENABLED` — model tier for ambiguous docs (default on;
    `false` = deterministic signals only, ambiguity defaults to hard_scan)
  - `DOC_CLASSIFIER_MODEL` — bottom-tier OpenRouter model for the one
    classification call (default `google/gemini-3.5-flash-lite`)
  - `DOC_CLASSIFIER_PARSE_ENGINE` — OpenRouter file-parser engine for the
    classification call (default `cloudflare-ai`, the free parse)
  - `DOC_CLASS_EMPTY_SPOTCHECK_RATE` — fraction of doc_class=empty docs left
    in review for a human spot-check instead of auto-resolving (default
    `0.1`)
- Import guardrails (all seven): `IMPORT_MAX_BYTES`, `IMPORT_MAX_REFS`,
  `IMPORT_MAX_SPX`, `IMPORT_MAX_PRICES`, `IMPORT_MAX_CLOSES_PER_TICKER`,
  `IMPORT_MAX_INSIDER`, `IMPORT_MAX_SHORT_VOLUME`
- Local-dev escape hatch: `ADMIN_OPEN_IN_DEV` (still requires a
  non-production environment to take effect)
- **Resource governor — LLM USD ceilings** (`shared/llmSpend.ts`; owner
  mandate 2026-07-18 "no more spend spikes ever"): `LLM_DAILY_USD_CEILING`
  (global daily LLM spend ceiling in USD, default `10`; enforced fail-closed
  inside the provider-call choke point — `runCandidateOnDoc` +
  `fetchWithRetry` — with error-class `budget`, terminal for the attempt,
  never a failover trigger) and optional per-provider sub-ceilings
  `LLM_DAILY_USD_CEILING_OPENROUTER`, `LLM_DAILY_USD_CEILING_GEMINI`,
  `LLM_DAILY_USD_CEILING_OPENAI`, `LLM_DAILY_USD_CEILING_ANTHROPIC`,
  `LLM_DAILY_USD_CEILING_MISTRAL`, `LLM_DAILY_USD_CEILING_XAI`,
  `LLM_DAILY_USD_CEILING_LLAMAPARSE` (unset = governed by the global only).
  Metered dollars persist per day/provider in the D1 `llm_spend` table
  (migration 0049) and surface in `GET /diagnostics` under
  `resourceGovernors.llmSpend`.

² `USAGE_MONITOR_ENVIRONMENT` is Infisical-tunable on its async read paths
(admin-open check, usage telemetry); the sync local-webhook-target gate in
`delivery/webhookTarget.ts` still reads env directly (local-dev-only code
path, never active in production).

## Env-only (cannot move to Infisical)

| Key | Why |
|---|---|
| `INFISICAL_BASE_URL`, `INFISICAL_ENV`, `INFISICAL_CACHE_TTL_SECONDS`, `INFISICAL_ALLOW_ENV_FALLBACK`, `INFISICAL_APP_*`, `INFISICAL_SHARED_*` | Resolver bootstrap — cannot resolve themselves |
| `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_TRACES_SAMPLE_RATE` | Read synchronously in the `Sentry.withSentry` init factory before any `await` is possible. Live `SENTRY_DSN` is owned by Infisical (canonical) and Coolify runtime env — never a git value |
| `USAGE_TELEMETRY_CIRCUIT_*`, `USAGE_TELEMETRY_FALLBACK_*`, `USAGE_TELEMETRY_D1_DRAIN_LIMIT`, `USAGE_TELEMETRY_DELIVERY_TIMEOUT_MS` | Operational safety limits read synchronously on the telemetry hot path; must stay available while KV/D1/Infisical are the thing degraded |
| `D1_WRITE_OPS_PER_INVOCATION_CAP` (default 2000), `D1_WRITE_BATCH_CAP` (default 200) | Resource governor 2 (`shared/d1Budget.ts` write governor): gate the hot D1 write path synchronously — per-invocation soft cap with batch truncation + `d1_write_quarantine` markers at the known storm writers (ingestion discovery, DLQ receipts, delivery-outbox flush, extraction_runs) |
| `DELIVERY_TARGET_FAILURE_THRESHOLD` (default 5), `DELIVERY_TARGET_DAILY_ATTEMPT_CAP` (default 50 failed attempts/target/day), `DELIVERY_TARGET_BASE_BACKOFF_SEC` (default 60, doubling, capped at 1 probe/hour), `DELIVERY_TARGET_PARKED_CAP` (default 500 parked/subscription before quarantine + alert) | Resource governor 3 (`delivery/targetCircuit.ts`): per-target outbound circuit breaker for webhook + peer-app deliveries; must stay readable mid-incident |

For local development, `scripts/cloud-setup.sh` maps the canonical
`INFISICAL_CT_CLIENT_ID` / `INFISICAL_CT_CLIENT_SECRET` inputs to the runtime
`INFISICAL_APP_*` names. It accepts both `INFISICAL_CT_SHARED_*` and the existing
`INFISICAL_SHARED_*` shared-identity names. Existing complete, non-empty
`.dev.vars` pairs have preservation priority. For a missing or empty managed
target, explicit runtime-name environment pairs precede canonical CT environment
aliases and then the corresponding machine-file aliases. Existing non-empty
managed values are never rotated implicitly; deliberately remove or empty a
managed line before re-running setup. An incomplete client-id/client-secret pair
aborts before install. Known nonsecret project IDs are supplied only when the
corresponding complete identity exists. The optional machine-level file must be
a regular owner-only file with no group/other permission bits; exact mode `0600`
is recommended but not required. It is parsed without shell evaluation;
provider keys are never copied from it or the process environment. The only
non-Infisical values imported explicitly for local setup are `SENTRY_DSN`,
`SENTRY_ENVIRONMENT`,
`SENTRY_TRACES_SAMPLE_RATE`, `ADMIN_OPEN_IN_DEV`, and
`USAGE_MONITOR_ENVIRONMENT`. Existing `.dev.vars` parsing is limited to managed
keys using the dotenv 16.3.1 grammar bundled by Wrangler, so colon assignments,
comments, quotes, backslashes, backticks, and multiline values cannot expose a
managed-looking line nested in unrelated content. Unrelated records remain
byte-for-byte unchanged. Imported managed values are emitted only when that
same parser proves an exact single-line round trip; otherwise setup fails
closed. Missing files are allowed; symlinks, including broken symlinks, are
rejected.

## Not env at all (already hot-configurable elsewhere)

- **Poll cadence / Aggressive Mode** — stored in SQLite `poll_config` + Deno KV,
  edited live from the Admin · Cadence tab.
- **Site logo style** — admin UI setting (Deno KV).
- **Runtime paths** — SQLite file, Deno KV file, R2/S3 shim, and the
  `deno_runtime_queue` table are Coolify/compose infrastructure
  (`app/docker-compose.yml`, `src/deno/main.ts`), not Infisical knobs.
  `TURSO_DATABASE_URL` is the leftover env name for the local file.

## Conventions

- New config keys MUST be read via `resolveSecret`/`resolveSecrets` (env
  fallback comes free) and added to the `GET /api/admin/config-sources`
  registry + this file. Only add an env-only key when the read is genuinely
  sync-at-init or resolver-circular.
- Values must never be logged or echoed by diagnostics — sources and
  configured-booleans only.
