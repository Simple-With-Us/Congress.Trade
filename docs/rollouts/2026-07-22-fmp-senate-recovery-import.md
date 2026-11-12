# FMP Senate recovery production import — 2026-07-22

> **Current shape (2026-08):** Deno Deploy is retired.  Production is Coolify
> on Hetzner.  The Deploy revision named below was the 2026-07 host.

## Summary

Completed the post-merge production import for PR **#771** (`c17daf3`, feature head `40db88d`) after Deno Deploy revision **`yveah28gatry`** was already healthy. Ran sequential Coolify `admin-maintenance.yml` `fmp-senate-recovery` batches for FMP pages **0–100** (≤5 pages/run), verified idempotency, re-read `data-status`, ran `metadata-enrichment`, and resolved the stale PR **#757** accounting review thread (already fixed on `main` by #762/#764/#766/#769).

This is a **data import + ops closeout**, not a new code deploy.

## Preconditions (already done by prior handoff)

| Item | Value |
|------|--------|
| Merge SHA | `c17daf31eaa03f99356bd7c82e139ce0ffb21a76` |
| Deno production revision | `yveah28gatry` |
| Deploy workflow | `29959781367` success |
| Schema migrate | `llm_spend_settlements` + `autopilot_budget_settlements` via `POST /api/admin/migrate` |
| Health | `ok/db/schema=true`, `missing=[]` |

## Import receipts

Full batch TSV: `docs/receipts/2026-07-22-fmp-senate-recovery-batches.tsv`

### Totals (pages 0–100)

| Metric | Count |
|--------|------:|
| Workflow batches | 21 |
| Fetched | 10,100 |
| Inserted | 9,533 |
| Duplicates | 567 |
| Rejected | 0 |
| Filings inserted (sum) | 1,034 |
| Filers inserted (sum) | 60 |

### Run IDs (by page range)

| Pages | Run ID | Fetched | Inserted | Dups | Rej |
|------:|-------:|--------:|---------:|-----:|----:|
| 0–4 | 29967128483 | 500 | 455 | 45 | 0 |
| 5–9 | 29967177533 | 500 | 484 | 16 | 0 |
| 10–14 | 29967227143 | 500 | 465 | 35 | 0 |
| 15–19 | 29967253109 | 500 | 485 | 15 | 0 |
| 20–24 | 29967274072 | 500 | 471 | 29 | 0 |
| 25–29 | 29967339665 | 500 | 466 | 34 | 0 |
| 30–34 | 29967363611 | 500 | 461 | 39 | 0 |
| 35–39 | 29967405866 | 500 | 479 | 21 | 0 |
| 40–44 | 29967432787 | 500 | 473 | 27 | 0 |
| 45–49 | 29967463146 | 500 | 470 | 30 | 0 |
| 50–54 | 29967492462 | 500 | 414 | 86 | 0 |
| 55–59 | 29967515831 | 500 | 443 | 57 | 0 |
| 60–64 | 29967536484 | 500 | 426 | 74 | 0 |
| 65–69 | 29967557178 | 500 | 477 | 23 | 0 |
| 70–74 | 29967580741 | 500 | 489 | 11 | 0 |
| 75–79 | 29967603573 | 500 | 495 | 5 | 0 |
| 80–84 | 29967627631 | 500 | 494 | 6 | 0 |
| 85–89 | 29967649752 | 500 | 498 | 2 | 0 |
| 90–94 | 29967670494 | 500 | 491 | 9 | 0 |
| 95–99 | 29967692019 | 500 | 497 | 3 | 0 |
| 100–100 | 29967712004 | 100 | 100 | 0 | 0 |

All runs: `conclusion=success` on runner `fleet-ci-congress-ci` (`[self-hosted, congress-deploy]`). No FMP budget/pacing hard-stop.

## Post-import verification

| Step | Run ID | Result |
|------|-------:|--------|
| Idempotency `from_page=0 to_page=0` | 29967745618 | fetched 100, **inserted 0**, **duplicates 100**, rejected 0 |
| `data-status` (post-import) | 29967758289 | see snapshot below |
| `metadata-enrichment` | 29967773650 | enrich-photos `{filers:312,matched:255,unmatched:57}`; resolve-tickers `{scanned:5000,resolved:1}` |
| `data-status` (post-enrichment) | 29967789827 | filer gaps reduced |
| Health | — | `{"ok":true,"db":true,"schema":true,"missing":[]}` @ 2026-07-23T00:00:12Z |

### Production data-status snapshot (post-enrichment, asOf `2026-07-22T23:59:57.986Z`)

**Transactions**

| Chamber | Source | Count | Latest created | Recent 90d |
|---------|--------|------:|----------------|-----------:|
| house | primary | 6,077 | 2026-07-21 | 550 |
| senate | primary | 143 | 2026-07-22 | 143 |
| senate | seed_dataset | **9,533** | 2026-07-22T23:58:20Z | 42 |
| unknown | seed_dataset | 7,133 | 2026-06-21 | 0 |

**Filings (senate)**

- `provider_seeded`: **1,034**
- `persisted`: 13
- `needs_review`: 1

**Filers** (after metadata-enrichment)

- total **312** (was 252 pre-import)
- missing_party **56** (was 112 immediately post-import / 52 pre-import baseline)
- missing_state **29** (was 84 post-import)
- missing_photo **56** (was 112 post-import)

**Queues**

- ingestion outbox: 542 completed, 12 failed
- delivery outbox: 5,969 completed
- runtime ingest: pending ~120 at status time (drain in progress from import-adjacent work)

## Review thread cleanup

- **PR #757** (`app/src/extraction/bakeoff.ts:1361`) — unresolved Codex P2 about metering spend before post-response aborts. **Resolved** after verifying `main` meters via `settleLlmSpend` before `signal?.throwIfAborted()` (landed in #762/#764 + follow-ups #766/#769). Comment posted on PR.
- Open Cursor integration PRs **#774–#777** still have their own threads (not part of this import lane); left untouched.

## Worktrees / secrets

| Path | Action |
|------|--------|
| `/private/tmp/congress-deno-ci-setup` | **Removed** — clean, branch merged (#771) |
| `/private/tmp/congress-senate-crawler` | **Kept** — untracked crawler work; official eFD still Imperva-403 from Coolify IPs |
| `/private/tmp/congress-storage-smoke` | **Kept** — untracked smoke module |
| `/private/tmp/congress-coverage-latency` | **Kept** — ownership not confirmed |
| `/private/tmp/congress-deno-live-ingestion` | **Kept** — dirty vendor tree |
| `/private/tmp/congress-trade-garage-key.qNVqYF` | **Kept** — storage-smoke still present; never printed |

Owner main worktree `cursor/integrate-security-bundle` left untouched.

## Follow-ups

1. **Official Senate eFD scout (residential)** — Coolify/datacenter IPs get HTTP 403 from Imperva; residential Mac gets 200. Not a GitHub Actions runner; see `/private/tmp/congress-senate-crawler`. Primary Senate remains 143 until official path works.
2. **Legacy unknown `seed_dataset` (7,133)** — still historical/low-fidelity; separate cleanup if desired.
3. **Filer metadata gaps** — enrichment reduced but did not eliminate missing party/state/photo; may need another enrichment pass or better name matching for new FMP filers.
4. **Runtime ingest pending** — was non-zero after import; monitor drain; recovery path intentionally does not enqueue delivery for seed inserts.

## Operator notes

- FMP key resolved from Infisical by the Worker; no key was hardcoded.
- Shared FMP pacing/daily budget was respected; no budget bypass.
- Production migrations remain via authenticated `POST /api/admin/migrate` only.
- Mac self-hosted runner was **not** used.

## Agent

**GROK** — handoff from `/private/tmp/congress-trade-handoff-2026-07-22.md`
