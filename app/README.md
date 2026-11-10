# Congress.Trade

Deno-in-Docker service that ingests US **STOCK Act** disclosures (House +
Senate + Executive / OGE 278-T), extracts structured trade events, and pushes
them to clients via webhook / SSE / REST / APNs.  Live site:
[congress.trade](https://congress.trade).

> This is the production Coolify app.  It runs as **Deno** (not Node) in
> the Coolify `congress-app` container on the production fleet box (see
> `../AGENTS.md` and `fleet-ops:ATTACK-MAP.md`; `https://host.jays.services`), not as a Cloudflare Worker.  Proof:
> `../AGENTS.md` Current Shape, `Dockerfile`, `docker-compose.yml`,
> `src/deno/main.ts`.  `wrangler.toml` is gone.  Leftover only:
> `wrangler.preview.example.toml`, `@sentry/cloudflare`,
> `@cloudflare/workers-types`.  Do not reintroduce Worker deploy as
> production.  **Deno Deploy and Turso are retired.**  Production is Coolify
> Docker, local SQLite + Litestream, Infisical secrets, paid cron
> `* * * * *`.  See `../AGENTS.md` for branch/worktree coordination
> rules before continuing work.
>
> iOS planning lives in `docs/mobile-app-roadmap.md`.  It treats the planned
> SwiftUI app as peer clients over one backend client API and
> command/status model, not as places to run scraping, provider credentials, or
> MCP orchestration.
>
> Coolify compose service names: `congress-app` (API + UI), `sqlite-web`
> (admin DB browser), `scan-cpu-worker` (Tesseract OCR helper).  Filing PDFs
> still use the R2 bucket historically named `congress-feed-raw`.  Do not
> rename that bucket without a coordinated resource migration.
---

## Architecture

```
                 ┌──────────────┐   cron (* * * * *)
                 │  scheduled() │──────────────┐
                 └──────────────┘              ▼
                                        ingestion/watcher  (shouldPollNow gate)
                                               │  poll House + Senate indexes
                                               │  insert filings(new) + ingest_log
                                               ▼  enqueue filing.new
   ┌────────────────────────── INGEST_QUEUE ───────────────────────────┐
   │ filing.new   → ingestion/fetcher    (download raw → R2, status=fetched) │
   │ filing.fetched → ingestion/classifier (detect docKind, run extractor)   │
   │ filing.extracted → (persist chain)                                      │
   │ tx.persisted  → enqueue delivery.dispatch                               │
   └─────────────────────────────────────────────────────────────────┘
                                               │
        extractor pipeline (src/extractors)    │ normalizer (validate brackets,
        senateHtml | textPdf | visionLlm  ─────┤ resolve ticker, confidence,
        (ArbitratingExtractor wraps vision)    │ low-confidence → review_queue)
                                               ▼ persist transactions(cursor_seq)
   ┌──────────────────────── DELIVERY_QUEUE ──────────────────────────┐
   │ delivery.dispatch → delivery/webhook  (sign + POST, record deliveries) │
   └─────────────────────────────────────────────────────────────────┘
                                               │
                 Deno.serve Hono app ── /health ── /api (REST, SSE) ── /api/analytics ── /api/admin
```

### Data flow (end to end)

`watcher → fetcher → classifier → extractor → normalizer → persist → deliver`

1. **watcher** (cron, self-gated by `shouldPollNow`) discovers new filings, writes
   `filings(status=new)` + `ingest_log`, enqueues `filing.new`.
2. **fetcher** downloads the raw doc into **R2** (`RAW_FILES`), sets
   `raw_object_key`, status `fetched`, enqueues `filing.fetched`.
3. **classifier** inspects the raw object → `doc_kind`
   (`senate_html|text_pdf|scanned_pdf|unknown`), selects the matching extractor.
4. **extractor** (pluggable pipeline) parses rows into `ParsedTx[]`. The vision
   extractor can be wrapped by `ArbitratingExtractor` (primary + optional
   secondary, gated by `ARBITRATION_API_KEY` + flag).
5. **normalizer** validates STOCK Act amount brackets, resolves tickers against
   `securities_master`, computes confidence, routes low-confidence to
   `review_queue`, and persists `transactions` (assigning stable `row_key` +
   monotonic `cursor_seq`).
6. **persist** enqueues `delivery.dispatch` only for newly inserted rows.
7. **deliver** fans out to matching subscriptions (webhook signed with
   `WEBHOOK_SIGNING_KEY`; SSE live stream; REST `?since=<cursor_seq>` pull).

---

## Where each module lives

| Path | Owner | Responsibility |
|------|-------|----------------|
| `src/deno/main.ts` | foundation | Production entry: Deno.serve, SQLite + KV shims, in-process cron/queues |
| `src/index.ts` | foundation | Hono app: `/health`, router mounts, scheduled/queue handlers |
| `src/shared/types.ts` | foundation | Canonical types/enums, `QueueMessage`, `Env` |
| `src/shared/config.ts` | foundation | Poll schedule, `shouldPollNow` (DST-correct ET), get/set config + last poll |
| `src/shared/brackets.ts` | foundation | STOCK Act bracket set, `matchBracket`, `isValidBracket` |
| `src/shared/db.ts` | foundation | Typed SQLite `get`/`all`/`run`/`batch` helpers |
| `src/shared/ids.ts` | foundation | `uuid`, prefixed/monotonic ids, R2 key builder |
| `src/extractors/types.ts` | foundation | `Extractor` interface, `ArbitratingExtractor`, `buildExtractorPipeline` |
| `src/ingestion/watcher.ts` | ingestion | Cron poll loop, source discovery, enqueue |
| `src/ingestion/fetcher.ts` | ingestion | Download raw disclosures → R2 |
| `src/ingestion/classifier.ts` | ingestion | docKind detection and extraction handoff |
| `src/extraction/senateHtml.ts` | extraction | Senate HTML extractor |
| `src/extraction/textPdf.ts` | extraction | Text-layer PDF extractor |
| `src/extraction/visionLlm.ts` | extraction | Vision/LLM extractor for scanned PDFs |
| `src/extraction/normalizer.ts` | extraction | Validate/normalize/persist `Transaction[]` |
| `src/delivery/webhook.ts` | delivery | Signed webhook dispatch + retry metadata |
| `src/delivery/sse.ts` | delivery | SSE streaming |
| `src/delivery/rest.ts` | delivery | Public REST/market/export API router |
| `src/delivery/subscriptions.ts` | delivery | Subscription CRUD + filter matching |
| `src/analytics/sql.ts` | analytics | Shared SQL fragments + common filter builder |
| `src/analytics/compute.ts` | analytics | Pure post-processing (bracket midpoint, lag stats) |
| `src/analytics/builders.ts` | analytics | Pure per-endpoint aggregation query builders |
| `src/analytics/routes.ts` | analytics | `/api/analytics/*` read API (KV-cached) |
| `src/admin/routes.ts` | admin | Secured admin operations, migrations, backfills, enrichment |
| `src/auth/` | auth | Google OAuth, magic-link email, KV sessions |
| `src/billing/` | billing | Stripe checkout, portal, webhook, entitlement |
| `src/enrichment/` | enrichment | SEC/FMP asset reference enrichment |
| `src/prices/` | prices | FMP EOD prices, S&P series, trade performance anchors |
| `src/backfill/` | backfill | Seed/open-data and House historical backfill |
| `src/ui/` | ui | Server-rendered dashboard/admin HTML and browser scripts |
| `../dashboard-design.html` | ui | Historical/static visual design artifact |

---

## Analytics API (`/api/analytics/*`)

Read-only trend aggregates over the transaction corpus — the data behind the
dashboard **Trends** tab. All are GET, public (no auth), and KV-cached for a few
minutes. Pure SQL builders live in `src/analytics/builders.ts` and are unit-tested
without a DB (mirroring `src/delivery/rows.ts`).

| Endpoint | What it answers |
|----------|-----------------|
| `GET /summary` | KPI strip: trades, politicians, assets, est. volume, net flow, buy pressure |
| `GET /ticker-leaderboard` | Most-traded tickers (sort `trades\|members\|volume\|netflow`) |
| `GET /member-leaderboard` | Most active politicians (sort `trades\|volume\|tickers`) |
| `GET /cluster-buys` | Consensus: ≥N distinct politicians trading the **same direction** |
| `GET /trending` | Momentum: tickers up most vs the prior equal period |
| `GET /volume-over-time` | Buys vs sells bucketed by day/week/month |
| `GET /party-split` | Buy/sell + net flow per party (D/R/Other) |
| `GET /sector-breakdown` | Volume by `asset_type` |
| `GET /filing-lag` | Disclosure timeliness distribution + slowest filers |
| `GET /ticker/:ticker` | Single-ticker deep dive (series, top buyers/sellers, recent) |

**Common query params:** `window=7d\|30d\|90d\|365d\|all` (default `30d`, by
`tx_date`), `chamber=house\|senate`, `party=D\|R\|O` (CSV; `O` = Other / No party, so D+R+O = all), `source=all\|primary\|seed_dataset`
(default `all`), `minConf=0..1`, plus per-endpoint `limit` / `sort` / `granularity`
/ `minMembers`.

> **Dollars are estimates.** STOCK Act amounts are disclosed only as *brackets*,
> so every `$` metric uses the bracket **midpoint** (the open `$50M+` tier uses
> its floor) via the single `BRACKET_MIDPOINT_SQL` expression. With `source=all`
> a trade present in both the live and seed sets can be double-counted — use
> `source=primary` for a de-duplicated dollar view.

## Delivery subscriptions

Subscription ids are identifiers, not credentials.

- `POST /api/subscriptions` creates a webhook or SSE subscription and returns
  its generated secret exactly once. Store it immediately.
- `GET /api/subscriptions` is intentionally disabled publicly. Use
  `GET /api/admin/subscriptions` from the secured admin API for operator lists.
- `GET/PATCH /api/subscriptions/:id` require the per-subscription secret via
  `Authorization: Bearer <secret>` or `X-Subscription-Secret`. Responses redact
  the secret unless the request is explicitly rotating it.
- `GET /api/stream?subscription=<id>&token=<secret>` opens an SSE stream. Native
  browser `EventSource` cannot set authorization headers, so browser clients use
  a scoped query token and must treat stream URLs as sensitive.
- Webhook delivery is at-least-once.  The app claims a unique
  `(subscription_id, tx_id)` row before POSTing, and recipients should still
  dedupe on `X-Subscription-Id` + `X-Tx-Id`.

Live normalization is also idempotent after migration `0008`: each primary row
gets a stable `row_key`, and SQLite enforces unique `(doc_id, source, row_key)`.
Retries or duplicate queue messages should not create duplicate live rows or
duplicate delivery fan-out.

## Runtime resources (Coolify / host)

There is no production `wrangler.toml`.  The Deno entrypoint in
`src/deno/main.ts` shims the old Worker binding names onto host resources:

| Name in code | Actual resource | Purpose |
|--------------|-----------------|---------|
| `DB` | Host SQLite `/data/congress-trade/db.sqlite` (libsql) | Structured store (filers, filings, transactions, …) |
| `CONFIG_KV` | Deno KV `/data/congress-trade/kv.sqlite` | Hot config cache (poll schedule, last-poll timestamps) |
| `RAW_FILES` | Cloudflare R2 via S3 shim | Raw disclosure files (PDF/HTML) |
| `INGEST_QUEUE` / `DELIVERY_QUEUE` | SQLite `deno_runtime_queue`, polled in-process | Pipeline stage hand-off and delivery fan-out |

Local development variables are documented in `.dev.vars.example`, but that
template is reference-only. From the repository root run
`bash scripts/cloud-setup.sh`; it safely maps the Congress.Trade and shared
Infisical machine identities from explicit environment variables or, on a Mac
with the CLI installed, `fleet-secrets get NAME` into the gitignored
`.dev.vars`. Cloud and CI use the environment only.
The setup also carries forward only the five documented early-init/local
selectors (`SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_TRACES_SAMPLE_RATE`,
`ADMIN_OPEN_IN_DEV`, and `USAGE_MONITOR_ENVIRONMENT`) from the explicit process
environment. Unrelated existing `.dev.vars` content is preserved verbatim.
Only missing or empty managed entries are populated; existing non-empty managed
values are not overwritten. To rotate one locally, deliberately remove or empty
its managed line before re-running setup.
Production provider/app secrets live in Infisical and are read at runtime
through the machine-identity resolver.  Coolify should hold only the Infisical
bootstrap identity credentials plus documented host overrides
(`TURSO_DATABASE_URL=file:/data/congress-trade/db.sqlite`).  Provider-key env
copies are migration fallback only.  Important groups:

| Group | Variables |
|-------|-----------|
| Infisical bootstrap | `INFISICAL_APP_PROJECT_ID`, `INFISICAL_APP_CLIENT_ID`, `INFISICAL_APP_CLIENT_SECRET`, `INFISICAL_SHARED_PROJECT_ID`, `INFISICAL_SHARED_CLIENT_ID`, `INFISICAL_SHARED_CLIENT_SECRET`, `INFISICAL_ENV`, `INFISICAL_ALLOW_ENV_FALLBACK` |
| Admin | `ADMIN_TOKEN`, `INGEST_TOKEN`, `ADMIN_EMAILS`, `ACCESS_AUD`, `ACCESS_TEAM_DOMAIN`, `ADMIN_OPEN_IN_DEV` |
| Extraction | `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `ARBITRATION_API_KEY`, `ARBITRATION_ENABLED`, `ARBITRATION_MODEL` |
| Market data | `FMP_API_KEY`, `FMP_DAILY_CALL_CAP`, `SEED_HOUSE_URL`, `SEED_SENATE_URL`, `HOUSE_LIVE_SEARCH_ENABLED` |
| Delivery | `WEBHOOK_SIGNING_KEY` |
| Public auth/email | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `RESEND_API_KEY`, `EMAIL_FROM`, `APP_BASE_URL`, `ALERT_EMAIL` |
| Billing | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_ANNUAL`, `STRIPE_TRIAL_DAYS` |
| Litestream B2 backup | `LITESTREAM_S3_BUCKET`, `LITESTREAM_S3_ENDPOINT`, `LITESTREAM_S3_REGION`, `LITESTREAM_S3_ACCESS_KEY_ID`, `LITESTREAM_S3_SECRET_ACCESS_KEY` |

The admin API fails closed unless `ADMIN_TOKEN` or Cloudflare Access is
configured. `ADMIN_OPEN_IN_DEV=true` is a local-only escape hatch.

### Continuous backup (Litestream -> Backblaze B2)

The Coolify `congress-app` container replicates
`/data/congress-trade/db.sqlite` continuously to Backblaze B2
(`jays-congress-trade-eu`) via Litestream running as a sibling process inside
the same container — the pattern already proven by Socratic.Trade
(`litestream.coolify.yml`) and Usage-Monitor (`litestream.yml`). See
`app/litestream.yml` for the replica config and
`app/scripts/start-with-litestream.sh` for the entrypoint that resolves the
`LITESTREAM_S3_*` secrets from Infisical (reusing the app's existing
`INFISICAL_APP_CLIENT_ID`/`INFISICAL_APP_CLIENT_SECRET` bootstrap identity)
and execs `litestream replicate -exec "deno run ..."` as PID 1. Deliberately
uses **separate** `LITESTREAM_S3_*` secret names rather than the app's
existing `AWS_S3_*`/`AWS_REGION`/`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`
secrets — those already point at Cloudflare R2 and back the `raw/`
filing-PDF object store consumed in-process by `src/deno/main.ts`; reusing
those names for the DB backup replica would have silently repointed PDF
storage at the B2 bucket. When `LITESTREAM_S3_*` are absent (local/preview),
the container falls straight through to the unmodified `deno run ...` with no
Litestream wrapper.

---

## Commands

```bash
npm install
npm run typecheck   # deno check src/deno/main.ts
npm run test        # vitest run
npm run migrate     # local-only leftover Wrangler D1 helper; not production
npm run dev         # local Deno server
npm run deploy      # prints that Coolify owns production; does not wrangler-deploy
```

Pushes to `main` rebuild the Coolify compose project (`app/docker-compose.yml`
→ `congress-app` on the production fleet box).  `npm run deploy` is a reminder, not
a Worker publish.  Production schema is **not** automatic: after the container
is on the new SHA, run `ADMIN_TOKEN=... bash scripts/ship.sh` or
`POST /api/admin/migrate` against `https://congress.trade`.  Secrets come from
Infisical, not `wrangler secret put`.

See `DEPLOY.md` before any schema change reaches production.
