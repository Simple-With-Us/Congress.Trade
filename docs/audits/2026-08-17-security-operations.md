# Congress.Trade Security and Operations Audit

**Date:** 2026-08-17  
**Agent:** CURSOR (Cursor Cloud)  
**Branch:** `cursor/security-ops-audit-3227`  
**Scope:** report-only.  No secret values.  No live destructive operations.  No production schema, backfill, queue drain, or host mutation.

This audit reviews auth and admin boundaries, secret handling, OpenRouter / Files API use, billing and halt controls, notification and paging paths, production data mutations, audit logs, PII, dependency risk, deploy and rollback, and backups and recovery.

It is disjoint from the in-flight safety-fix claim on `cursor/prod-incident-audit-f506` (review-queue catalog, halt paging, files-prepaid resume).  This document does not implement those fixes.

---

## 1. Method and constraints

**Method.**  Static review of `main` at `be53b3e5` plus current `app/` source, migrations, ship scripts, GitHub workflows, and rollout notes.  Local `npm audit` in `app/` (307 dependencies).  Slack `#ag***-s**c` claim before work.  Overlap check against open PRs #1964, #1965, #1966, #1967, #1959.

**Constraints.**

- Never print secret values, key material, or live key fingerprints.
- Do not call production admin POST/PUT/DELETE, migrate, backfill, or debug-sql.
- Do not ssh to the Hetzner box, rotate credentials, or apply Coolify changes.
- Do not commit untracked one-off scripts.

**Evidence standard.**  Every finding cites a file and line range in this tree.  Severity uses impact × likelihood for this product (single SQLite file, bearer-equivalent admin, public filings plus paying subscribers).

| Severity | Meaning |
|----------|---------|
| Critical | Direct production data loss, full admin/SQL, or guaranteed user-facing outage path |
| High | Privilege expansion, silent money/pipeline failure, or compliance promise the code cannot keep |
| Medium | Real attack or ops gap with a mitigating control already in place |
| Low | Hardening or reconnaissance reduction |
| Info | Working control, recorded for the threat model |

---

## 2. Executive summary

Admin and delivery surfaces are **mostly fail-closed**.  Bearer `ADMIN_TOKEN`, verified Cloudflare Access JWTs, and an `ADMIN_EMAILS` session allowlist gate `/api/admin/*`.  Scoped `INGEST_TOKEN` and `ADMIN_MAINTENANCE_TOKEN` cannot migrate or run arbitrary SQL.  Stripe and Apple webhooks verify signatures.  Webhook targets are checked for SSRF and DNS rebinding.  Infisical diagnostics never return values.  Local `npm audit` reported **0** vulnerabilities.

The production blast radius is still concentrated.  One ~1.88GB SQLite file holds users, billing, filings, queues, and delivery secrets.  `POST /api/admin/debug-sql` is live in production despite a “Development ONLY” comment and runs any SQL the caller sends.  Autopilot halt is visible in health JSON but **does not page** and does **not** flip `/api/health` to 503.  Coolify compose deploys still stop the old container before the new one exists (PR #1964 not merged).  Privacy copy promises access and deletion by email; `request_export` is 501 and there is no account-deletion command.

**Do this first (owner / follow-up PRs, not this report):**

1. Gate or remove `POST /api/admin/debug-sql` in production.
2. Page on `autopilot_halt` (Pushover and/or `/api/health` 503).  Coordinate with `cursor/prod-incident-audit-f506` so the work is not duplicated.
3. Stop storing `ADMIN_TOKEN` in browser `localStorage`.
4. Add CSRF or bearer-only mutation for session-admin POSTs.
5. Persist admin actions (migrate, backfill, debug-sql, secrets update) to an append-only table.
6. Finish the R2 weekly backup token and a quarterly restore drill.
7. Implement or document a real account-deletion and export path that matches the privacy policy.

---

## 3. Threat model

### 3.1 Assets

| Asset | Where | Why it matters |
|-------|-------|----------------|
| Production SQLite | `/data/congress-trade/db.sqlite` on `fleet-hetzner-nbg1` | Users, Stripe/Apple IDs, webhook secrets, filings, queues, review decisions |
| Deno KV | `/data/congress-trade/kv.sqlite` | Sessions (`sess:*`, 30-day TTL), circuits, heartbeats |
| `ADMIN_TOKEN` | Infisical prod + Coolify runtime + operator browsers | Full admin, including SQL and Infisical writes |
| `INGEST_TOKEN` / `ADMIN_MAINTENANCE_TOKEN` | Infisical | Narrower write paths (import, requeue, runtime tick) |
| Subscription stream secrets | `subscriptions` table | Webhook HMAC and SSE |
| User sessions | `ct_session` cookie / native bearer | Account takeover, and admin if email is allowlisted |
| OpenRouter keys | Infisical `OPENROUTER_API_KEY` (+ backup) | Spend, halt, filing contents to a third party |
| R2 filing bytes | Cloudflare R2 | Source PDFs and cached file annotations |
| B2 replicas | Litestream LTX + 6h `hetzner/` snapshots | Recovery |
| Senate relay | `https://scout.jays.services` named tunnel | Senate coverage when Imperva blocks the box |

### 3.2 Actors

| Actor | Goal | Typical path |
|-------|------|----------------|
| External anonymous | Scrape, enumerate, abuse public APIs | `/api/transactions`, `/api/health`, `/api/health/deep` |
| Paying subscriber | Steal another user’s delivery secret or Premium | XSS, leaked SSE `?token=`, command replay |
| Stolen Google session on `ADMIN_EMAILS` | Full admin without the bearer | CSRF or XSS against the dashboard |
| Stolen `ADMIN_TOKEN` | Arbitrary SQL, migrate, secret write, backfill | `debug-sql`, `/diagnostics/secrets/update` |
| Compromised self-hosted runner | Same box as prod; CI secrets include `ADMIN_TOKEN` | `.github/workflows/admin-maintenance.yml` |
| Honest operator / agent | Accidental wipe or misclassified halt | Body-less POST, leftover halt latch, compose swap |
| Provider / OpenRouter | Process public PTR / OGE 278-T text | Files API URL or base64 upload |

### 3.3 Trust boundaries

```
Internet
  -> Cloudflare edge (managed challenge, Access optional)
    -> Traefik on Hetzner
      -> congress-app (Deno) + in-container Litestream
        -> local SQLite + KV
        -> Infisical (secret read/write)
        -> OpenRouter / Stripe / Apple / R2 / B2
        -> Senate relay (Mac origin) or direct eFD fallback
  Self-hosted GHA runners  --same box-->  Coolify + prod disk
```

Session cookies are host-only, HttpOnly, Secure, SameSite=Lax.  Admin authorization is **not** role-split: allowlisted session, Access JWT, and `ADMIN_TOKEN` are equivalent.

### 3.4 Assumptions this audit does not re-prove live

- Infisical prod `ADMIN_TOKEN` still matches `CT_ADMIN_TOKEN` (last documented 2026-08-11).
- Litestream is running inside `congress-app` after the 2026-08-12 rebuild (box check still listed as a follow-up).
- R2 weekly archive remains 401 until the owner mints a CT-scoped token (effort log 2026-08-14).

---

## 4. Findings index

| ID | Severity | Area | Finding |
|----|----------|------|---------|
| C-01 | Critical | Admin / data | `POST /api/admin/debug-sql` runs arbitrary SQL in production |
| C-02 | Critical | Availability | Coolify compose stops the live container before the replacement exists |
| H-01 | High | Halt / paging | Autopilot halt is silent to Pushover and HTTP monitors |
| H-02 | High | Auth | `ADMIN_TOKEN` persisted in `localStorage` under `script-src 'unsafe-inline'` |
| H-03 | High | Auth | Session-admin CSRF on body-less mutating POSTs |
| H-04 | High | Audit | Most production mutations have no durable actor log |
| H-05 | High | PII / compliance | Privacy policy promises export and deletion the product cannot perform |
| H-06 | High | Secrets | Historical cleartext commit; history scrub still open |
| H-07 | High | Backups | R2 weekly offsite leg still blocked (401) |
| H-08 | High | Architecture | Single SQLite file is the blast radius for C-01 and bad migrations |
| M-01 | Medium | Auth | Allowlisted Google session = full admin, no step-up |
| M-02 | Medium | Secrets | Admin API can write arbitrary Infisical keys |
| M-03 | Medium | Auth | Session tokens appear in iOS OAuth and SSE URLs |
| M-04 | Medium | Health | Public `/api/health/deep` exposes spend, breakers, autopilot |
| M-05 | Medium | Secrets | `INFISICAL_ALLOW_ENV_FALLBACK` defaults on |
| M-06 | Medium | CI | Self-hosted runners share the production box and receive `ADMIN_TOKEN` |
| M-07 | Medium | Ingest | Senate coverage still depends on a sleeping Mac when Imperva blocks the box |
| M-08 | Medium | Privacy | OpenRouter Files API processes filings; privacy policy omits the processor |
| M-09 | Medium | Billing | Every HTTP 402 is treated as an OpenRouter budget event |
| M-10 | Medium | Hygiene | Untracked workspace script holds a hardcoded production-shaped bearer |
| L-01 | Low | Health | Public `/api/health/mac` and `/api/health/senate-relay` aid reconnaissance |
| L-02 | Low | Secrets | `.prod.vars` still commits non-secret but sensitive identifiers |
| L-03 | Low | Auth | Cookie-authenticated user POSTs have no CSRF token |
| L-04 | Low | Backups | Litestream-in-container still needs a live box confirmation |
| I-01 | Info | Deps | `npm audit` in `app/`: 0 vulnerabilities |
| I-02 | Info | Controls | Fail-closed admin, scoped tokens, Stripe/Apple crypto, webhook SSRF, gitleaks |

---

## 5. Detailed findings

### C-01 — Arbitrary SQL on the production admin API

**Severity:** Critical  
**Evidence:**

```8551:8564:app/src/admin/routes.ts
  // --- POST /debug-sql -----------------------------------------------------
  // Development ONLY tool for running arbitrary sql queries to debug state
  r.post('/debug-sql', async (c) => {
    const { query, params = [] } = (await c.req.json().catch(() => ({}))) as { query?: string; params?: any[] };
    if (!query) {
      return c.json({ error: 'query is required' }, 400);
    }
    
    try {
      const results = await all(c.env.DB, query, params);
      return c.json({ ok: true, results });
```

The comment says development only.  There is no `SENTRY_ENVIRONMENT`, `USAGE_MONITOR_ENVIRONMENT`, or `ADMIN_OPEN_IN_DEV` guard.  The route sits behind the same full-admin middleware as migrate.  `all()` executes the caller’s string.  AGENTS.md documents this route as the production schema/debug path.

**Impact.**  A stolen `ADMIN_TOKEN`, stolen allowlisted session, or CSRF against an allowlisted browser can `SELECT` users and subscription secrets, `UPDATE` entitlements, or `DELETE` the corpus.  Combined with H-08 this is the whole product.

**Fix.**

1. Remove the route from production builds, or require `isExplicitOpenAdmin` (already fails closed when either env marker is `production`).
2. If operators need SQL, run `sqlite3` on a **restored copy**, never the live file.
3. Until removal, reject anything other than a single `SELECT`, cap rows, and write `admin_actions` (actor, query hash, row count).

**Runbook:** [R3](#r3-suspected-debug-sql-abuse).

---

### C-02 — Compose deploy is a hard outage

**Severity:** Critical (availability)  
**Evidence:** `docs/rollouts/2026-08-12-deploy-downtime-gap.md` proves Coolify 4.1.2 `deploy_docker_compose_buildpack()` calls `stop_running_container(force: true)` before `docker compose up`.  The old `congress-app` is gone before the new one exists.  PR #1964 (`cursor/coolify-deploy-overlap-028c`) adds a Traefik overlap clone and is **open, not installed**.

**Impact.**  Every merge to `main` is a user-facing gap (`no available server` / Cloudflare 502).  Stacked deploys extend the gap.  Watchdog restart-on-502 was a second amplifier; local health probe work in `docs/rollouts/2026-08-13-watchdog-local-health.md` reduced false restarts but does not keep the old container up.

**Fix.**  Merge and host-install #1964, or move the app to a Dockerfile build pack that uses Coolify `rolling_update()`.  Do not treat “Coolify auto-deploy” as zero-downtime until one of those is live.

**Runbook:** [R4](#r4-deploy-rollback).

---

### H-01 — Autopilot halt does not page

**Severity:** High  
**Evidence:**  Pipeline health emits `autopilot_halt` as `stalled`:

```269:276:app/src/shared/pipelineHealth.ts
  if (s.autopilotHaltReason !== null) {
    checks.push({
      id: 'autopilot_halt',
      status: 'stalled',
      detail: `Autopilot runs halted: ${s.autopilotHaltReason}`,
      value: 1,
    });
```

The hourly Pushover sweep **excludes** that check:

```410:416:app/src/ingestion/autonomySweeps.ts
const LIVENESS_ALARM_CHECK_IDS = new Set([
  'polling_house',
  'polling_senate',
  'polling_executive',
  'latency_probes',
  'senate_relay',
]);
```

`GET /api/health` returns **200** whenever readiness (`ok` + `db`) is true, even when `pipeline.status === 'stalled'`:

```499:525:app/src/delivery/rest.ts
    return c.json(
      {
        ...readiness,
        status: readiness.ok ? pipeline.status : 'down',
        pipeline,
        ...
      },
      readiness.ok ? 200 : 503,
    );
```

`GET /api/health/deep` does return 503 when `pipeline.status === 'stalled'`, but UptimeRobot and the documented public monitor target `/api/health` and the polling/latency/relay probes.

OpenRouter **budget HTTP** does Pushover before failover (`app/src/extraction/openRouterVision.ts`).  A kill-switch halt after two classified errors does not.

**Impact.**  The 2026-08-10 files-prepaid 402 left extraction at 0/24h with a stored `error_class:quota` receipt.  Classification is now corrected in display (`describeAutopilotHaltReason`), but a new halt can sit unacknowledged until a human opens admin JSON.  `POST /api/admin/autopilot/acknowledge` is the only resume gate (`app/src/admin/routes.ts` ~7006–7027).

**Fix (pick one, do not double-page if `prod-incident-audit-f506` lands first).**

- Add `autopilot_halt` (and optionally stalled `extraction_provider`) to `LIVENESS_ALARM_CHECK_IDS`, **or**
- Return 503 from `/api/health` when `pipeline.status === 'stalled'` (will page existing UptimeRobot), **or**
- Add a dedicated monitor on `/api/health/deep`.

**Runbook:** [R1](#r1-autopilot-halt).

---

### H-02 — Admin bearer in `localStorage`

**Severity:** High  
**Evidence:**  Dashboard copy and implementation persist the full admin bearer:

```7108:7117:app/src/ui/dashboardHtml.ts
var ADMIN_TOKEN_KEY = 'congresstrade.adminToken';
function getAdminToken() {
  try { return localStorage.getItem(ADMIN_TOKEN_KEY) || ''; } catch (e) { return ''; }
}
function adminHeaders(extra) {
  var h = extra || {};
  var t = getAdminToken();
  if (t) h['Authorization'] = 'Bearer ' + t;
```

CSP allows inline script:

```16:26:app/src/security/headers.ts
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  ...
  "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com",
```

**Impact.**  Any XSS on `congress.trade` (inline handlers, a future dependency, or a stored HTML injection) can read `localStorage` and call `debug-sql`, migrate, or Infisical update.  Session-admin (allowlisted Google) is the safer browser path and already works when a stale bearer is present (`sessionAuthFallthrough` tests; middleware at `app/src/admin/routes.ts` 2100–2116).

**Fix.**  Remove the token box for humans.  Prefer Cloudflare Access + `ADMIN_EMAILS` session.  If automation needs a bearer, keep it in the operator’s shell, not the browser.  Tighten CSP with nonces once the dashboard is split out of one HTML string.

---

### H-03 — CSRF against session-admin mutations

**Severity:** High (when operators use Google session admin without a bearer)  
**Evidence:**  Allowlisted `ct_session` is full admin:

```384:388:app/src/admin/routes.ts
  const sessionEmail = headers.sessionEmail?.trim().toLowerCase();
  if (sessionConfigured && sessionEmail && allow.has(sessionEmail)) {
    return true;
  }
```

Cookie flags:

```120:126:app/src/auth/session.ts
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isSecureRequest(c),
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_SEC,
  });
```

`SameSite=Lax` is sent on cross-site **top-level** POSTs.  `POST /api/admin/migrate` and `POST /api/admin/runtime-tick` do not require a JSON body.  Cross-origin `fetch` with cookies is still limited by CORS; the realistic attack is a classic form POST while the owner is signed in.

**Fix.**  Require `Authorization: Bearer` or a double-submit CSRF token for every mutating admin route.  Optionally set an admin cookie to `SameSite=Strict`.  Isolating admin on an Access-only hostname is stronger.

---

### H-04 — Audit coverage is filing-shaped only

**Severity:** High  
**Evidence:**  Review confirm/reject/unpublish writes `ingestion_decisions` with `adminActor(c)` (`app/src/admin/routes.ts` ~2644).  That table requires `doc_id` (`app/migrations/0019_ingestion_decisions.sql`).

`adminActor` records Access email **or** the strings `admin-token` / `admin`.  It does **not** record the allowlisted session email:

```328:334:app/src/admin/routes.ts
function adminActor(c: { req: { header(name: string): string | undefined } }): string {
  const accessEmail =
    c.req.header('Cf-Access-Authenticated-User-Email') ||
    c.req.header('cf-access-authenticated-user-email');
  if (accessEmail) return accessEmail;
  return c.req.header('authorization') ? 'admin-token' : 'admin';
}
```

A client can spoof the Access email header while using a bearer; auth still passes on the token, and the audit row names the forged email.

Subscription rotate/deactivate only `console.log` (`auditAdminSubscriptionAction`, lines 889–909).  `POST /migrate`, `POST /debug-sql`, backfills, `PUT /poll-config`, and `POST /diagnostics/secrets/update` have no durable actor row.

Ingestion decision writes are best-effort and must not block (`app/src/shared/ingestionDecisions.ts` ~73–76).

**Fix.**  Add append-only `admin_actions` (ts, actor from verified session/JWT/token-id, route, payload hash, outcome).  Resolve actor from the same `isAuthorized` result, not an unverified header.  Ship container logs to a retained sink as a backstop, not the only trail.

---

### H-05 — Privacy promises vs product

**Severity:** High (compliance)  
**Evidence:**  Privacy policy (`app/src/ui/legalHtml.ts` §5–6) tells users they can access, delete, and port personal information by emailing support.  Client command `request_export` is declared in `app/src/shared/types.ts` and then rejected:

```350:351:app/src/client/commands.ts
  throw new ClientInputError(`${type} is not implemented yet`, 501);
```

There is no `DELETE /auth/account`, no admin wipe-user route, and no client `delete_account` command.  Users can delete **delivery subscriptions**.  They cannot delete the `users` row, Apple ledger, push devices, or KV sessions.

Premium CSV export (`GET /api/export/transactions.csv`) is trade data, not an account package.

Processor list in §4 names Stripe, Cloudflare, Google, Resend, and FMP.  It omits **OpenRouter** (filing PDFs), **Apple** (IAP), **Sentry**, **Infisical**, **Backblaze**, and **Pushover**.

**Fix.**  Implement `request_export` (account + billing metadata, not card numbers) and an authenticated deletion command that revokes sessions, cancels Stripe/Apple where possible, and deletes or tombstones local rows.  Until then, publish an operator runbook that matches the email promise ([R6](#r6-manual-account-deletion)).  Update the processor list.

---

### H-06 — Historical secret commit still in git history

**Severity:** High (residual)  
**Evidence:** `docs/rollouts/2026-08-01-prod-vars-secret-purge.md` records `app/.prod.vars` re-committed with ~34 live secrets on 2026-07-30 while the repo was public.  File contents were emptied.  Follow-ups still listed: filter-repo history scrub (force-push window) and owner rotation of provider dashboards.  Agent-controlled tokens were rotated in that wave; provider keys were owner-owned.

**Fix.**  Treat history scrub as a scheduled, coordinated force-push (breaks open lanes).  Confirm provider rotations that were left to the owner.  Do not re-export Infisical into a tracked file.

---

### H-07 — R2 weekly backup leg

**Severity:** High (offsite diversity)  
**Evidence:** `docs/rollouts/2026-08-09-offsite-backups-b2-r2.md` designed B2 primary + Sunday R2.  Effort log 2026-08-14: Litestream and B2 restore **PASS**; R2 weekly **401**.  Owner must mint a **Congress.Trade-account** R2 Object Read & Write token and set Infisical `R2_ARCHIVE_ACCESS_KEY_ID` / `R2_ARCHIVE_SECRET_ACCESS_KEY`.  Do not copy Usage-Monitor or shared `CLOUDFLARE_R2_*`.

B2 is real offsite.  R2 is the second-vendor weekly copy.  Until the token works, a B2-account or rclone-config failure is a single offsite vendor.

**Fix.**  Owner mints the token.  Confirm `GET /api/health` → `checks.storage.r2Weekly.ok`.  Keep B2 writer scoped (no delete), as already documented.

**Runbook:** [R5](#r5-backup-restore).

---

### H-08 — Single-file blast radius

**Severity:** High (architectural)  
**Evidence:** AGENTS.md: production DB is one SQLite file (~1.88GB on 2026-08-11) plus KV beside it.  Users, billing, filings, `deno_runtime_queue`, review queue, and delivery secrets share that file.  WAL helps concurrency, not logical isolation.

**Mitigations already present:** Litestream 5m sync, 6h B2 snapshots, volume floor, migrate fail-closed in `ship.sh`, retention sweeps (`app/src/jobs.ts` `RETENTION_POLICIES`).

**Fix.**  Treat live `db.sqlite` as read-only for humans (C-01).  Keep restore drills.  Long-term split of auth/billing vs corpus is expensive and not required to close C-01.

---

### M-01 — No admin roles

**Severity:** Medium  
**Evidence:** `isAuthorized` (`app/src/admin/routes.ts` 340–402) is boolean.  Allowlisted session, Access JWT, and `ADMIN_TOKEN` all unlock migrate, secrets update, backfill, and debug-sql.  `/auth/me` only exposes `admin.allowed`.

**Fix.**  Split read-only admin (review queue, health) from break-glass (migrate, secrets, SQL).  Require bearer or Access for the second set.

---

### M-02 — Infisical write from the admin API

**Severity:** Medium  
**Evidence:**

```4493:4512:app/src/admin/routes.ts
  r.post('/diagnostics/secrets/update', async (c) => {
    if (isPreviewDeployment(c.env)) {
      return c.json({
        ok: false,
        error: 'Infisical secret updates are disabled in preview deployments',
```

Preview is blocked.  Production is not.  Any full admin can set arbitrary keys, including auth keys in the config registry.  `GET /config-sources` correctly returns names and sources only.

**Fix.**  Allowlist writable keys.  Require a second factor or `ADMIN_MAINTENANCE_TOKEN`-class break-glass.  Audit the write (H-04).

---

### M-03 — Tokens in URLs

**Severity:** Medium  
**Evidence:**  Native Google callback:

```225:227:app/src/auth/routes.ts
      if (targetOrigin.startsWith('congresstrade://')) {
        return c.redirect(`${targetOrigin}?token=${encodeURIComponent(sessionToken)}`);
      }
```

SSE documents `?token=` as a fallback (`app/src/delivery/sse.ts` header comment; `app/src/delivery/rest.ts` `/stream` with `allowQueryToken=true`).

**Impact.**  Tokens land in browser history, proxy logs, and Referer.  Session TTL is 30 days.

**Fix.**  One-time exchange code for iOS.  Header-only SSE for new clients.  Rotate any stream URL that was pasted into a ticket.

---

### M-04 — Public deep health

**Severity:** Medium  
**Evidence:** `GET /api/health/deep` (`app/src/delivery/rest.ts` 528–544) is unauthenticated and returns pipeline checks, provider breakers, and LLM spend vs ceilings.  `/api/health` already publishes Infisical **source counts and errors** (never values) plus pipeline status.

**Fix.**  Require admin for `/deep`, or strip to the public subset.  Rate-limit either way.

---

### M-05 — Env fallback on by default

**Severity:** Medium  
**Evidence:**

```77:79:app/src/secrets/infisical.ts
function envFallbackAllowed(env: Env): boolean {
  return env.INFISICAL_ALLOW_ENV_FALLBACK !== 'false';
}
```

Coolify env can shadow Infisical.  That is how `ADMIN_TOKEN` drifted on 2026-07-30 when `INFISICAL_APP_PROJECT_ID` was unset (AGENTS.md).

**Fix.**  Set `INFISICAL_ALLOW_ENV_FALLBACK=false` in production after bootstrap is verified.  Keep Infisical project IDs as Coolify **runtime** vars so the app does not fall back to image-baked secrets.

---

### M-06 — CI on the production box

**Severity:** Medium  
**Evidence:** `.github/workflows/security.yml` and `ci.yml` run on `[self-hosted, oracle-ci]` when `CT_CI_RUNNER` is set (label names the selector, not Oracle).  `admin-maintenance.yml` injects `ADMIN_TOKEN` into that job.  Fork PRs are refused.  `scripts/check-actions-runner-policy.mjs` blocks Mac runners.

**Impact.**  A malicious workflow or runner-process compromise is production-adjacent.  This is accepted self-hosted CI risk, not a bug.

**Fix.**  Keep fork PRs off self-hosted.  Prefer GitHub-hosted for untrusted events.  Do not broaden `ADMIN_TOKEN` usage in workflows.

---

### M-07 — Senate relay host dependency

**Severity:** Medium (mitigated)  
**Evidence:** `docs/rollouts/2026-08-17-senate-relay-host-dependency.md`.  `SENATE_RELAY_URL=https://scout.jays.services` is permanent.  Cloudflare 5xx on the named-tunnel origin falls back to box eFD egress.  If Imperva blocks datacenter IPs again, Senate polling fails until the Mac origin is up.

**Fix.**  Always-on residential origin (Pi or clamshell, same named tunnel).  **Never** “fix” a 502 by changing `SENATE_RELAY_URL`.

**Runbook:** [R8](#r8-senate-relay-502).

---

### M-08 — OpenRouter Files API and PII / public filings

**Severity:** Medium (compliance / subprocessors)  
**Evidence:**  Extraction sends the filing as OpenRouter `type: 'file'`, preferring `sourceUrl` else base64 (`app/src/extraction/openRouterVision.ts` 400–407).  `docId` is sent as the OpenRouter `user` field for attribution.  Annotations cache in R2 at `openrouter/annotations/{docId}.json`.

Content is **public** House/Senate/OGE disclosure data by product design.  It is still a third-party processing boundary.  Privacy policy does not name OpenRouter (H-05).

**Fix.**  Name OpenRouter (and US subprocessors) in the privacy policy and DPA set.  Prefer URL mode when the source is already public.  Keep annotation retention documented.

---

### M-09 — 402 classification is broad

**Severity:** Medium  
**Evidence:** `isOpenRouterBudgetHttp` treats **every** HTTP 402 as budget (`app/src/shared/openRouterBudgetCircuit.ts` 54–57).  `classifyProviderErrorClass` maps 402 / “balance for files” / credit language to `billing` (`app/src/extraction/providerHealth.ts` 117–133).  Display rewrite of stored `error_class:quota` is tested.

**Impact.**  Correct for the Aug 10 files-prepaid incident.  A different 402 would take the same circuit and halt class.  App LLM ceilings correctly stay `quota`, not provider billing.

**Fix.**  Optional: branch “balance for files” vs generic payment-required in pages and runbooks.  Do not auto-resume a halt without an ack.

**Runbook:** [R7](#r7-openrouter-402-vs-quota).

---

### M-10 — Untracked hardcoded bearer in this workspace

**Severity:** Medium (hygiene; not in git)  
**Evidence:**  This cloud workspace contains an **untracked** file `filed_date_week_latency.ts` that assigns a 64-hex bearer and POSTs it to `https://congress.trade/api/admin/debug-sql`.  `git ls-files` does not list the path.  This PR does not add it.

**Impact.**  If that value equals live `ADMIN_TOKEN`, any copy of the workspace is a credential leak.  If it is stale, it is still a dangerous template.

**Fix (owner, offline).**  Hash-compare the file’s token to Infisical / `CT_ADMIN_TOKEN` without printing either value.  Rotate if they match.  Delete the file.  Add a CI grep for `congress.trade/api/admin/debug-sql` plus a string literal token if this pattern recurs.

This audit does not reprint the value.

---

### L-01 — Public worker / relay probes

`GET /api/health/mac` (`app/src/index.ts` 77–114) and `GET /api/health/senate-relay` expose stall state.  Useful for UptimeRobot.  Useful for reconnaissance.  Gate if that tradeoff changes.

### L-02 — `.prod.vars` identifiers

Sentry DSN, Stripe price IDs, R2 endpoints, and SEC EDGAR UA email remain in the tracked file by design (empty secret placeholders).  Document as public-ish or move DSNs to Infisical.

### L-03 — User CSRF

`POST /auth/logout`, preferences, and commands rely on SameSite=Lax.  Acceptable for same-site fetch.  Add tokens if the app is ever embedded.

### L-04 — Litestream confirmation

`docs/rollouts/2026-08-12-litestream-b2-rebuild.md` still lists `docker top congress-app | grep litestream` as a post-merge box check.  Effort-log restore-proof later passed.  Reconfirm after any compose/entrypoint change.

---

## 6. What is working well

1. **Fail-closed admin.**  If no token, Access, or allowlist is configured, the API is closed unless `ADMIN_OPEN_IN_DEV=true` **and** neither `SENTRY_ENVIRONMENT` nor `USAGE_MONITOR_ENVIRONMENT` is `production` (`app/src/admin/routes.ts` 319–326, 353–373).
2. **Cloudflare Access is a JWT, not a header.**  `verifyAccessJwt` (RS256 + JWKS + `ACCESS_AUD` + allowlist).  Forged `Cf-Access-Authenticated-User-Email` alone does not authorize.
3. **Constant-time bearers** (`app/src/auth/tokens.ts`).
4. **Scoped tokens.**  `INGEST_TOKEN` → securities import / ingest / export.  `ADMIN_MAINTENANCE_TOKEN` → requeue, retry-errored, runtime-tick only.  Tested; cannot migrate.
5. **Stale admin bearer fallthrough.**  Wrong `localStorage` token no longer 401s an allowlisted Google session.
6. **Session cookies.**  HttpOnly, Secure (via trusted proto), host-only (CT-AUD-007), new token per login, logout evicts cookie + KV.
7. **Magic links.**  Hashed, single-use, no account enumeration.
8. **Google unverified-email rejection** (`app/src/auth/routes.ts` 216–221).
9. **Delivery.**  Public listing disabled.  Create is signed-in Premium.  Secrets shown once.  SSE re-checks entitlement.  Webhook HMAC + SSRF/DNS-rebind checks (`app/src/delivery/webhookTarget.ts`).
10. **Stripe.**  HMAC-SHA256, 300s skew, fail-closed without secret, idempotent claim ledger.
11. **Apple IAP.**  Legacy `/billing/apple/confirm` locked down 2026-08-09: real JWS + Apple root + `APPLE_IAP_ENABLED` (was shape-only grant).
12. **Secret resolver.**  No values in D1/R2/logs/diagnostics.  Health publishes source counts only.  Bearer fragments redacted in Infisical errors.
13. **Usage telemetry.**  No URLs, headers, bodies, or provider error strings (`app/src/shared/thirdPartyTelemetry.ts`).
14. **OpenRouter attribution** uses `keyRef` (secret **name**), not key material.
15. **Halt classification** peels circuit wrappers; 429 is rate-limit; transient 403 is not auth/quota; files-prepaid display rewrite is tested.
16. **LLM daily ceiling** fails closed (`LlmBudgetExceededError`), no retry storm.
17. **CI.**  Pinned gitleaks 8.24.3 with SHA256, fork refusal, `npm audit`, fail-open-default grep, runner-policy script.  Local `npm audit`: 0 vulnerabilities.
18. **Ship script.**  Browser UA (Cloudflare challenge), live SHA check, migrate fail-closed, health smoke.
19. **Backups (B2 path).**  Litestream + 6h snapshots + volume floor; B2 writer has no delete.
20. **Senate URL permanence.**  Named tunnel; documented “do not rotate the URL” rule after the 2026-08-11 TryCloudflare incident.

---

## 7. Runbooks

All commands below are **operator** steps.  This audit did not run them.  Spoof a browser User-Agent on every `congress.trade` `/api/admin/*` call (Cloudflare managed challenge).  Never print tokens; extract with `grep -m1` and redact.

### R1. Autopilot halt

**Symptoms.**  `/api/health` JSON `pipeline.status` is `stalled`; `checks` include `autopilot_halt`.  HTTP status may still be 200 (H-01).  Extraction attempts 0/24h.  Review backlog grows.

**Do not.**  Rotate `OPENROUTER_API_KEY` or `SENATE_RELAY_URL` from the halt string alone.  Do not bulk confirm/reject the review queue.

**Steps.**

1. `GET /api/admin/autopilot/status` (admin auth).  Read `haltReason`, sample errors (already truncated), spend.  Apply `describeAutopilotHaltReason` mentally: stored `quota` + “balance for files” is **billing**, not empty account quota.
2. Classify:
   - Files prepaid / 402 → OpenRouter billing dashboard (files minimum).  See R7.
   - App LLM ceiling → wait for UTC day or raise the documented ceiling.
   - Auth → key/permission, not quota.
   - Rate-limit → backoff; do not ack-and-storm.
3. Fix the cause.  Then `POST /api/admin/autopilot/acknowledge` with optional `{ "runId" }`.  Cron will not start a new run until this returns `{ acknowledged: ... }`.
4. Dry-run transient DLQ (`app/scripts/requeue-transient-dlq.mjs`) before `--apply`.  See `docs/rollouts/2026-08-14-publish-loop-halt-class.md`.
5. Confirm a new autopilot run starts and `extraction_provider` is not “ok at 0 attempts.”

**Page gap.**  Until H-01 is fixed, add a personal UptimeRobot keyword or JSON monitor on `autopilot_halt` / `/api/health/deep`.

---

### R2. Suspected `ADMIN_TOKEN` compromise

**Triggers.**  Token pasted into chat, committed, left in `localStorage` on a shared browser, or present in an untracked script (M-10).

**Steps.**

1. Rotate Infisical prod `ADMIN_TOKEN` (congress-trade project `<CT_INFISICAL_PROJECT_ID>`, env `prod`).  Do not mint a second source of truth.
2. Set Coolify runtime so the app does not keep an image-baked value (`INFISICAL_APP_PROJECT_ID` set; wait ~600s cache or `POST /api/admin/diagnostics/secrets/refresh` with the **new** token after Coolify picks it up — chicken-and-egg: prefer container restart after Infisical write).
3. Update `CT_ADMIN_TOKEN` in the owner secrets file.  Confirm hash match; do not print.
4. Ask operators to clear dashboard `localStorage` key `congresstrade.adminToken`.
5. Review `ingestion_decisions` and container logs for unexpected migrate/backfill/debug-sql.
6. If the old token was in git history, keep H-06 scrub on the board.

**Verify without leaking.**  Browser-UA `POST /api/admin/debug-sql` with `{"query":"SELECT 1"}` should 200 with the new token and 401 with a wrong token.  Prefer removing debug-sql (C-01) so this check becomes a harmless admin GET.

---

### R3. Suspected debug-sql abuse

**Steps.**

1. Treat the live DB as compromised for confidentiality.  Rotate `ADMIN_TOKEN` (R2) and delivery secrets that could have been `SELECT`ed.
2. Restore a pre-incident B2 snapshot to an **isolated path** (R5).  Diff row counts for `users`, `subscriptions`, `transactions`.
3. If integrity is wrong, restore the live file from that snapshot (maintenance window; C-02 downtime).
4. Disable the route in the next PR.

---

### R4. Deploy rollback

**App code.**

1. Revert the merge on `main` or redeploy the previous Coolify deployment.
2. Expect a compose gap (C-02) unless #1964 is installed.
3. `GET /api/health` must show `ok` + `db` and `build.sha` matching the intended commit (`ship.sh` `check_live_revision`).
4. Do not run `POST /api/admin/migrate` “in reverse.”  Migrations are forward-only.

**Schema.**  Restore SQLite from backup (R5), then start the app at a SHA compatible with that schema.

**Watchdog.**  If a deploy is in flight, remediates should skip (`scripts/ops/congress-health-recover.sh` `is_coolify_deploy_active`).  Do not stack restarts.

**Litestream entrypoint.**  Rollback of the 2026-08-12 rebuild is “Deno only” in the Dockerfile CMD; the DB file stays.  See `docs/rollouts/2026-08-12-litestream-b2-rebuild.md`.

---

### R5. Backup restore

**Layers (do not collapse them).**

| Layer | RPO (design) | Location |
|-------|----------------|----------|
| Litestream | ~5m LTX | B2 prefix `congress-trade/` |
| Fleet cron | ~6h full DB | B2 `hetzner/congress-trade-*.db` |
| Volume | ~24h | Same disk as prod (last resort) |
| R2 weekly | Sunday | **Blocked on token (H-07)** |

**Read-only drill (preferred).**

1. Copy a B2 `hetzner/` snapshot to a path **outside** `/data/congress-trade/`.
2. `sqlite3 copy.db 'PRAGMA integrity_check;'`
3. Spot-count `users`, `transactions`, `filings`.
4. Do not point the running app at the copy.

**Live restore (destructive; owner-only).**

1. Stop writes (maintenance window).
2. Snapshot the current file first (even if damaged).
3. Restore the chosen replica to `/data/congress-trade/db.sqlite`.
4. Start the app.  Confirm `/api/health` and a known recent `tx_id`.
5. Litestream will resume from the restored file; watch replica lag.

**R2.**  After the owner token is in Infisical, confirm `checks.storage.r2Weekly` on `/api/health`.  Do not copy UM/shared R2 keys.

---

### R6. Manual account deletion

Until H-05 is implemented, support email is the only path.  Operator on a **restored copy** first, then production with intent.

1. Identify `users.id` by email (admin diagnostics already return recent emails — treat that list as PII).
2. Cancel Stripe (portal / dashboard) and note Apple’s own retention.
3. Delete or deactivate `subscriptions` for `client_id` `user:<id>`; rotate is not enough if the row remains.
4. Delete `apple_subscriptions`, `push_devices`, `client_commands` for that user.
5. Delete KV `sess:*` for that user (scan or logout-all if implemented).
6. Delete or anonymize the `users` row.
7. Record the request and completion in a durable admin note (today: ticket + this runbook).

Do not run the above through `debug-sql` from a laptop script.

---

### R7. OpenRouter 402 vs quota

**Files prepaid.**  Sample contains “at least $0.50 in balance for files” or `balance for files`.  Account credits can still be fine.  Class is **billing**.  Health may still store `error_class:quota` until a new run; UI should rewrite via `describeAutopilotHaltReason`.

**Account / key budget.**  “credits are depleted”, “key budget”, weekly/monthly limit.  Also **billing**.  Backup key `OPENROUTER_BACKUP_API_KEY` may fail over before the circuit trips.

**App LLM ceiling.**  “llm daily usd budget exceeded” → **quota** (app governor).  Wait or raise the documented ceiling.  Not an OpenRouter invoice.

**429.**  Rate-limit.  Do not halt-as-quota.

**After funding or waiting:** acknowledge (R1).  Do not clear the KV circuit by hand unless you understand `openRouterBudgetCircuit` cool-down.

---

### R8. Senate relay 502

**Do not change `SENATE_RELAY_URL`.**  It is the named tunnel `Jay's Tunnel`.  The 2026-08-11 outage was four dead TryCloudflare hostnames while pm2 said “online.”

1. `GET /api/health/senate-relay` and `GET /api/health/polling` (`polling_senate`).
2. If the Mac origin is 502, production should fall back to box eFD.  If `polling_senate` stays ok, the laptop is optional for that window.
3. If Imperva 403s the box and the Mac is asleep, wake the Mac / `senate-tunnel` pm2 / launchd cloudflared.  Same hostname comes back.
4. Page path: `senate_relay` **is** in `LIVENESS_ALARM_CHECK_IDS`.

---

## 8. Dependency and supply chain

| Control | Status |
|---------|--------|
| `package-lock.json` integrity | Present |
| `npm audit` (this session, `app/`) | 0 vulnerabilities / 307 deps |
| CI `npm audit` | `.github/workflows/ci.yml` |
| Gitleaks 8.24.3 pinned + checksum | `.github/workflows/security.yml` |
| `.gitleaksignore` | Narrow (executive title FPs, APNs comment) |
| Fail-open `${TOKEN:-default}` grep | CI step |
| Runner allowlist | `scripts/check-actions-runner-policy.mjs` |
| Dependabot | `.github/dependabot.yml` |
| Caret ranges in `package.json` | Residual: lockfile pins CI; refresh discipline required |

No production `npm audit --fix` was applied (report-only).

---

## 9. Deploy, rollback, recovery (map)

| Question | Answer |
|----------|--------|
| How does code reach prod? | Merge to `main` → Coolify auto-deploy.  `bash app/scripts/ship.sh` verifies SHA + migrate. |
| Is migrate remote wrangler? | No.  `POST /api/admin/migrate` only.  `npm run migrate:remote` is disabled. |
| Zero downtime? | Not for compose (C-02).  #1964 is the overlap fix. |
| How to roll back code? | Previous Coolify deployment or revert commit (R4). |
| How to roll back schema? | Restore DB (R5), not down-migrations. |
| RPO / RTO (design) | Litestream ~5m; cron ~6h; volume ~24h.  RTO is a maintenance window plus compose boot. |
| Who can mutate prod data? | Full admin (token / Access / allowlisted session).  Maintenance token: requeue + tick only. |

---

## 10. Suggested follow-up slices (not this PR)

Keep each slice on its own `cursor/<topic>` branch.  Do not steal `cursor/prod-incident-audit-f506` if that PR is already paging halt / files-prepaid resume.

| Slice | Closes | Notes |
|-------|--------|-------|
| Remove or env-gate `debug-sql` | C-01 | Highest leverage |
| Halt paging | H-01 | Coordinate with f506 |
| Admin UI: session/Access only | H-02 | |
| CSRF or bearer-only admin POST | H-03 | |
| `admin_actions` table + migrate hook | H-04 | Needs migration + `POST /migrate` mirror |
| `request_export` + delete-account | H-05 | Product + legal |
| Privacy processor list | H-05, M-08 | Copy-only |
| Coolify overlap host install | C-02 | #1964 |
| R2 archive token | H-07 | Owner credential |
| History scrub window | H-06 | Coordinated force-push |

---

## 11. Verification performed

| Check | Result |
|-------|--------|
| `git status` / worktrees / open PRs | Clean `main` worktree; no overlapping docs/audits PR |
| Slack `#ag***-s**c` claim | Posted 2026-08-17 |
| Live admin POST / debug-sql / migrate | **Not run** |
| Host SSH / Coolify / Infisical write | **Not run** |
| Secret values printed | **None** |
| `cd app && npm audit` | 0 vulnerabilities |
| `filed_date_week_latency.ts` | Untracked leftover; not added to git |

Typecheck and the full unit suite were not required to author this markdown-only report.  CI on the PR will still run gitleaks and the default workflow.

---

## 12. Closeout

This document is the deliverable.  Production behavior is unchanged.  Highest residual risks are **live arbitrary SQL behind full admin**, **halt that does not page**, **browser-stored admin bearer**, and **compose-shaped deploy gaps**.  Controls around fail-closed auth, scoped tokens, billing crypto, and B2 backups are real and should be preserved while those gaps close.
