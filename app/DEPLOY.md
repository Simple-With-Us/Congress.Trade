# Deploy runbook — Congress.Trade

Deno-in-Docker service that ingests US STOCK Act disclosures (House + Senate +
Executive / OGE 278-T), extracts/normalizes trades, and pushes them to clients
via webhook + SSE, with a dashboard and admin panel.

**Current shape (2026-08):** production is **Coolify Docker on the production
fleet box** (`ssh coolify` / `host.jays.services`, see `../AGENTS.md` and `fleet-ops:ATTACK-MAP.md`).
The app process is Deno inside `congress-app`.  The database is a **local
SQLite file** at `/data/congress-trade/db.sqlite`, replicated by **Litestream**.
Secrets come from **Infisical**.  See `../AGENTS.md` "Current Shape".

**Deno Deploy is retired.**  Do not `deployctl`, do not open a Deno Deploy
dashboard to set env, and do not treat Deploy free-tier quotas as the live
cost model.  **Turso is retired.**  Do not point `TURSO_DATABASE_URL` at a
`libsql://…turso.io` host.  Production uses
`TURSO_DATABASE_URL=file:/data/congress-trade/db.sqlite` (the env name is a
leftover).  Cloudflare Workers / D1 / `wrangler deploy` are also not the
production path — `wrangler.toml` is local/preview leftover.

## 0. Prerequisites

- Node 18+ and npm for local typecheck/test (`cd app && npm ci`).
- A Coolify login on the fleet box, or a merge to `main` (auto-deploy).
- Infisical congress-trade project (see `fleet-ops:ATTACK-MAP.md`), env
  `prod`, plus the shared-at-ct project for fleet keys.
- Verify locally before merging: `npm run typecheck && npm test`.

## 1. How production actually deploys

Coolify owns the image.  `app/docker-compose.yml` is the compose file
(`congress-app` + Litestream entrypoint + optional `sqlite-web`).
`is_auto_deploy_enabled` is on; a merge to `main` queues a docker-compose
deploy.  `npm run deploy` only prints that fact.  It does not upload to
Deno Deploy or run `wrangler deploy`.

`bash scripts/ship.sh` does **not** build or push an image.  It waits until
`GET /api/health` reports `build.sha` = this checkout's HEAD, then applies
schema via `POST /api/admin/migrate`.  If Coolify has not landed the commit,
`ship.sh` fails instead of migrating a stale revision.

```bash
# after main is green and Coolify has (or will) rebuild
ADMIN_TOKEN=... bash scripts/ship.sh
```

Manual Coolify kick (only when the GitHub webhook did not fire): Coolify UI,
or the fleet deploy-guard POST against the `congress-trade` app uuid.  Use a
browser User-Agent — Cloudflare 403s bare curl on `host.jays.services`.

Do not run `scripts/provision.sh` or `wrangler d1` / Turso CLI against
production.  Do not recreate R2 / queues / D1 as if this were a Worker.

## 2. Apply the database schema

Local (dev only):

```bash
npx wrangler d1 migrations apply DB --local
```

Production schema is the idempotent statement list in
`POST /api/admin/migrate` (`src/admin/routes.ts`).  Mirror every new
`app/migrations/*.sql` file there.  `npm run migrate:remote` is disabled on
purpose.

```bash
ADMIN_TOKEN=... bash scripts/ship.sh
# or, after Coolify already reports the new sha:
curl -sS -A "Mozilla/5.0" -X POST https://congress.trade/api/admin/migrate \
  -H "authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" -d '{}'
```

"Duplicate column" / "already exists" is treated as already-applied.
`poll_config` row 1 still holds the adaptive House/Senate schedule.

## 3. Secrets and vars

Infisical is the source of truth.  Coolify should hold only the Infisical
machine-identity bootstrap (`INFISICAL_APP_*`, `INFISICAL_SHARED_*`) plus the
SQLite path override (`TURSO_DATABASE_URL=file:/data/congress-trade/db.sqlite`).
Edit provider/app secrets in Infisical env `prod`.  They go live inside the
resolver cache TTL (default 600s) with no rebuild.

Do **not** set production secrets in a Deno Deploy project.  Do not
`wrangler secret put` against production.  For local bootstrap, run
`bash scripts/cloud-setup.sh` from the repository root; do not copy
`.dev.vars.example`.

Admin auth fails closed unless `ADMIN_TOKEN` (Infisical) or Cloudflare Access
is configured.  `ADMIN_OPEN_IN_DEV="true"` is local-only, and
`SENTRY_ENVIRONMENT` / `USAGE_MONITOR_ENVIRONMENT` in `wrangler.toml` `[vars]`
must be overridden in `.dev.vars` or the run is treated as production.

### Tick profile

Live production always uses aggressive knobs (cron `* * * * *` on
`GET /api/health` → `costProfile.name=live`).  The old `free` / `balanced` /
`paid` names described retired Deno Deploy quotas and are ignored if still
set.  Optional Infisical overrides: `CT_CRON_SCHEDULE`, `CT_DRAIN_LIMIT`,
`CT_DRAIN_CLAIM_SIZE`, `CT_OUTBOX_LIMIT`.  Do not duplicate those in Coolify
env.

## 3a. Sentry

Production Sentry is a Coolify/Infisical `SENTRY_DSN` concern, not a
`wrangler secret put` and not a git value in `.prod.vars`.  Infisical is
canonical; Coolify runtime env is the inject copy.  `SENTRY_ENVIRONMENT=production`
is the live value.

## 3a.1 Datadog

Reuse the existing fleet Datadog account.  Do not buy a new plan.  Set these
Coolify / Infisical names (values never belong in git):

- `DD_API_KEY` + `DD_SITE` — required together for Deno logs + APM.  Missing
  or unknown site fails closed.
- `DD_APP_KEY` — optional; not used to send.
- `DD_CLIENT_TOKEN` + `DD_APPLICATION_ID` + `DD_SITE` — required together
  for public-web RUM.  `NEXT_PUBLIC_DD_*` aliases are accepted.

Session Replay is off.  Host agent collection on `fleet-hetzner-nbg1` is
unchanged.

## 3b. Auth + Stripe

Google OAuth, Stripe products/webhook, Resend, and Cloudflare Access for
`admin.congress.trade` live in Infisical.  Copy-paste product setup:
[`docs/wave4-auth-billing.md`](docs/wave4-auth-billing.md).  Email magic-link
sign-in is no longer offered in the UI.

## 4. Seed ticker resolution (optional)

The normalizer resolves tickers against `securities_master`.  Load rows via
admin import or a local SQLite insert — not `wrangler d1 execute` against
production.

## 5. Hybrid backfill ("instant history")

Do not run this unless Jay explicitly asks.  It mutates production queues
and the SQLite file.

```bash
curl -sS -A "Mozilla/5.0" -X POST https://congress.trade/api/admin/backfill \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"chambers":["house","senate"],"sinceYear":2014}'
```

Do not run production backfill unless Jay explicitly asks.

## 6. Dev / deploy

```bash
npm run dev      # local Deno server
npm run deploy   # reminder only — Coolify publishes on main
ADMIN_TOKEN=... bash scripts/ship.sh   # wait for live SHA + migrate
```

Confirm with `GET https://congress.trade/api/health` → `ok` / `db` true and
a `build.sha` that matches the intended commit.
## Endpoint reference

Public API (`/api`):
- `GET /api/transactions?since=<cursor>&ticker=&member=&chamber=&type=&from=&to=&order=&limit=` — cursor feed (reconciliation backstop).  `from=`/`to=` (YYYY-MM-DD) bound the trade date for rolling-window pulls; `order=asc` (default, oldest-first — page forward with the returned `cursor` as the next `since`) or `order=desc` (newest-first "latest trades" snapshot, pair with `from=`).- `GET /api/stream?subscription=&token=&since=` — SSE live push (subscription secret required)
- `GET /api/filings/:docId`, `GET /api/members`
- `POST /api/subscriptions` — create and return the subscription secret once
- `GET/PATCH /api/subscriptions/:id` — secret-scoped management
- `GET /api/subscriptions` is disabled publicly; use the admin endpoint below.

Client API (`/api/client/v1`, shared by the website and SwiftUI app):
- `GET /api/client/v1/bootstrap`, `GET /api/client/v1/me`
- `GET /api/client/v1/feed?since=&limit=&ticker=&member=&chamber=&type=&from=&to=&order=`
- `GET/PUT /api/client/v1/preferences` — signed-in users only
- `GET /api/client/v1/subscriptions` — signed-in user's webhook/SSE configs
- `POST /api/client/v1/commands`, `GET /api/client/v1/commands/:id` — command/status gateway

Admin (`/api/admin`, bearer token or Cloudflare Access; fails closed unless configured):
- `GET/PUT /api/admin/poll-config`, `GET /api/admin/poll-config/aggressive`
- `GET /api/admin/review-queue`, `POST /api/admin/review/:docId` `{decision:'confirm'|'reject', edits?}`
- `GET /api/admin/sources/health`, `GET /api/admin/subscriptions`
- `POST /api/admin/backfill`
- `POST /api/admin/migrate`

UI: `GET /` (dashboard) and `/admin`.  `GET /health` → `{ok:true}`.
`GET /api/health` is the readiness document (db, Litestream, cost profile, sha).

Admin custom domain: `admin.congress.trade` is routed to the same Coolify app.
Protect it with Cloudflare Access; see `docs/wave4-auth-billing.md`.
## Pipeline (how a filing flows)

```
Deno.cron (paid: * * * * *) → watcher (House + Senate eFD + OGE)
  → durable SQLite queue (deno_runtime_queue)
  filing.new   → fetcher    (raw → R2)
  filing.fetched → classifier (senate_html | text_pdf | scanned_pdf)
  filing.extracted → orchestrator → extractor pipeline → normalizer
        ├ confidence ≥ 0.85 → persist (source='primary') → delivery        └ below / invalid   → review_queue (held off the live feed)
  delivery.dispatch → webhook fan-out (HMAC) + SSE + APNs
```

## Notes

- **Branch protection** on `main`: PRs required, `typecheck + test` required,
  no force push/deletion.
- **Senate eFD** uses Coolify + `RESIDENTIAL_PROXY_URL` (physical-device /
  WireGuard proxy).  Mac `scout/` is retired (#2351).  `SENATE_RELAY_URL` is
  optional — unset it if the origin is gone; never mint a new URL by hand.
  Scraping still uses the agreement-gate + CSRF flow (`src/ingestion/senateSource.ts`).
- **House bulk XML** refreshes ~daily; `pollHouseLiveSearch()` overlays the
  intraday live-search result when enabled.
- **Vision model** id lives in `src/extraction/visionLlm.ts`; review that
  constant before changing extraction cost/quality.
- **Observability** is Coolify + Sentry + `/api/health`, not Workers Smart
  Placement / `wrangler.toml` dashboard toggles.
- Confirm `SEED_SOURCES` URLs in `src/backfill/seed.ts` before a backfill.
- Host / Litestream / runner history:
  `docs/rollouts/2026-08-08-runners-hetzner-migration.md`,
  `docs/rollouts/2026-08-12-litestream-b2-rebuild.md`.
