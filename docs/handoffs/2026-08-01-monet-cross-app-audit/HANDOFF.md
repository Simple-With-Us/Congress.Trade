# 2026-08-01 — MONET handoff: cross-app integration audit (PAUSED by owner)

**Status: PAUSED mid-task on owner instruction ("write hand off note and pause all work").
Audit COMPLETE (49/50 agents; only the final completeness-critic pass was cut short).
NO code fixes started. Nothing was changed in any repo except this handoff package.**

## The ask (owner, 2026-08-01)

> make sure that Congress.Trade is optimally interacting with Socratic Trade and the
> Usage Monitor. One or both of the main 2 apps have 5yrs of price history via
> hoarded/downloaded Massive flat files. I think it is best if Socratic Trade handles
> the information cascade and Congress.Trade gets its data from Socratic Trade probably.

## What was done

1. Claim posted to #ag***-s**c (`[MONET->*]`, ts `1785620598.210579`).
2. A 50-agent audit workflow mapped six subsystems and adversarially verified every
   claimed gap: **39 gaps CONFIRMED, 5 refuted.** Full structured output is in this
   directory: `maps.jsonl` (6 subsystem maps) and `verdicts.jsonl` (44 verdicts).
3. Live production probes (all verified 2026-08-01, tokens from `~/.secrets/global-api-keys.env`):
   - `GET congress.trade/api/export/price-needs` (bearer `CT_INGEST_TOKEN`, browser UA):
     4,152 distinct tickers; 3,375 needing prices; **10,543 trades missing price anchor**
     (was 10,961 at the 2026-07-31 rollout); 10,068 missing SPX anchor.
   - `POST congress.trade/api/admin/backfill-market {"max":5}` (bearer `CT_ADMIN_TOKEN`):
     `ok:true`, spxUpdated, 4 tickers priced, 7 trades computed, pending `{enrich:18, prices:1440}`.
     The SocraticTrade-primary chain works end to end.
   - Enrichment live shows `hasFmpKey:false` and sources `edgar`/`tiingo` — the prod FMP key
     appears already out of the enrichment path (likely the 2026-08-01 secret purge), so the
     rollout's "283 wasted FMP calls/day" follow-up may be MOOT in prod even though the code
     still puts FMP first when a key resolves. Reconcile before fixing.
   - `GET socratictrade.com/api/market/spx` unauthenticated → 401 (peer route auth enforced).
   - `GET usage.jays.services/api/budget-status` (bearer `USAGE_READ_TOKEN`): projects
     Congress.Trade $30/mo and SocraticTrade.com $100/mo exist; market-data providers
     (massive/fmp/tiingo/finnhub/…) are registered but ALL have `monthlyBudgetUsd: null`
     ("unconfigured").
   - `GET usage.jays.services/api/export/daily-rollups` 401s with the valid read token —
     consistent with the Usage-Monitor Oracle deploy stall KIMI flagged (UM PR #871): prod
     likely predates the middleware exclusion for that route.

## Answer to the owner's architecture question

The direction is **already implemented and correct**: since the 2026-07-31 rollout
(`docs/rollouts/2026-07-31-price-pipeline-flatfiles-socratic-primary.md`), Congress.Trade's
price chain is SocraticTrade-primary with Massive fallback, and the 5y flat files
(3,334 tickers / 538MB, `Socratic.Trade/data/history-5y/`) were bulk-pushed into
Congress.Trade's D1 (2.0M closes).

**BUT the audit found "Socratic handles the cascade" is today mostly an illusion:**

1. Socratic's peer read routes serve from its live `fetchDailyOHLC` vendor cascade with a
   ~30-min in-process cache — its local imported-EOD DB tier is **default OFF**
   (`SECURITIES_IMPORT_HISTORY_TIER_ENABLED` unset), and the 5y flat files are a dev-only,
   one-shot artifact (not in git, not in the Docker image, not on the prod volume, and the
   hoard script never refreshes existing files — newest bars 2026-07-24). So on cache
   misses, "SocraticTrade-primary" is largely **a Massive proxy with an extra HTTP hop**.
2. Socratic's built nightly bulk push to Congress.Trade (up to 2,000 tickers + SPX +
   price-needs drain) is **gated OFF** (`CONGRESS_SHARE_ENABLED=off`,
   `CONGRESS_TRADE_TOKEN` unset) — so Congress polls per-symbol daily instead of receiving
   one push, violating the repo's own push-beats-poll doctrine
   (`Socratic.Trade/docs/data-architecture-push-vs-poll.md`).
3. When `CONGRESS_TRADE_READS_ENABLED` is on, Socratic's cascade tier 2 calls Congress.Trade
   **back** for the same symbol Congress just asked about (bounded 1-hop echo, pure waste).

## Confirmed gaps — top priorities (full list: `verdicts.jsonl`, 39 confirmed)

**HIGH:**
- **Deno cron telemetry hole (biggest single finding):** production runs the Deno container;
  its internally-scheduled cron lanes (`src/deno/main.ts`, `src/deno/cronLanes.ts`) never wrap
  execution in `withThirdPartyTelemetry`, so `trackedFetch` has no ALS env and **every
  request-attempt usage event from the daily price refresh + enrichment lanes is silently
  dropped** — Usage Monitor is blind to the app's main scheduled workload. (Measured
  token/cost events pass env explicitly and still arrive, which masks the hole.)
- **Socratic's Congress-serving cascade is unmetered:** `src/lib/history.ts` uses
  `politeFetchJson` with zero Usage-Monitor integration, so Congress-driven cache-miss reads
  burn the **shared Massive key invisibly**.
- **Licensing/ToS undetermined:** Massive-derived closes flow Socratic→Congress and are
  re-served on Congress.Trade's **public no-auth** `/market/prices` + `/market/spx`
  (`app/src/delivery/rest.ts`). Socratic's own docs say rebroadcasting raw vendor data is a
  ToS issue; no Massive ToS review is recorded anywhere. **OWNER DECISION NEEDED.**

**MEDIUM (grouped):**
- *Attribution:* Congress's peer reads to socratictrade.com are metered as `external-api`,
  not `peer-app` (`prices/peer.ts` passes no `dynamicTarget`; host not in `HOST_PROVIDERS`).
- *Resilience:* fallback accepts ANY non-empty peer payload as authoritative — a stale-but-
  dense peer series masks Massive and can wrongly negative-cache a priceable ticker for 30
  days; vendor auth errors abort the whole daily run with no alternate; no read-side circuit
  breaker on a dead peer (~budget wasted round-trips per run).
- *Freshness:* the daily lane stamps at 00:07 UTC and demands only the session before the
  just-closed one → closes land ~28h after the bell; same-day closes structurally unreachable.
- *Budget plumbing:* Congress's `monitorBudgetGate` read credential falls back to the ingest
  token, which Usage-Monitor prod DENIES for reads → the gate can be silently inert
  (fail-open). Only the extraction autopilot consults it; no market-data lane does. No
  cross-app split of the shared Massive 100/min. `MASSIVE_API_KEY_ALT` (hoard script) has no
  telemetry at all. Socratic's market-data telemetry lane is in-memory only (lossy on crash).
- *Enrichment:* Socratic's nightly share pushes closes but never company refs, though its
  keyless Nasdaq screener holds ~8,000 symbols of name/sector/industry/marketCap that
  Congress's ref-import receiver could absorb today with zero new code.
- *ST peer routes have no rate limiting;* `APP_B_IMPORT_URL` is overloaded as both push
  target and read-base origin.

## Recommended fix plan (NOT started — next agent picks up here)

1. **CT PR: telemetry fixes** — wrap Deno cron lanes in `withThirdPartyTelemetry`; add
   `dynamicTarget: 'peer-app'`/host mapping for socratictrade.com; fix `monitorBudgetGate`
   read-token fallback trap. (Highest value, small diff, pure-win.)
2. **ST PR: meter the OHLC cascade** (`history.ts` → tracked fetch) so shared-Massive burn
   is visible; add basic rate limiting to the peer read routes.
3. **ST enablement (owner/config, not code):** ingest the 5y flat files into
   `imported_price_eod` on prod (or re-push via CT's import as done 2026-07-31), enable
   `SECURITIES_IMPORT_HISTORY_TIER_ENABLED`, enable `CONGRESS_SHARE_ENABLED` +
   `CONGRESS_TRADE_TOKEN` (nightly push + price-needs drain), keep
   `CONGRESS_TRADE_READS_ENABLED` OFF (kills the echo hop). This is what actually makes
   "Socratic handles the cascade" true rather than nominal.
4. **ST PR: extend nightly share to push company refs** from the screener universe (fills
   Congress enrichment without FMP).
5. **Owner decisions:** Massive ToS review for cross-app redistribution + public `/market/*`
   exposure; set provider budgets in Usage Monitor (all market-data providers unconfigured).
6. Re-run the paused completeness critic if desired (workflow script:
   `~/.claude/projects/-Users-jay-Code-Usage-Monitor/82f74707-0302-4576-a7a5-e57cd60dc39f/workflows/scripts/cross-app-integration-audit-wf_05bdf0fd-219.js`;
   journal with all 49 cached results:
   `~/.claude/projects/-Users-jay-Code-Congress-Trade/82f74707-0302-4576-a7a5-e57cd60dc39f/subagents/workflows/wf_05bdf0fd-219/journal.jsonl`.
   Resume is same-session-only, but `maps.jsonl`/`verdicts.jsonl` here carry everything.)

## Coordination notes

- KIMI: ST PR #2331 (keyless VIX cascade) open — macro/regime files untouched by this work.
- KIMI: UM PR #871 flags the Oracle deploy stall; my daily-rollups 401 corroborates it.
- The local Socratic.Trade checkout is **42 commits behind origin/main** — the peer routes
  (PR #2314) exist only on origin/main. Fetch before working there.
- 5 refuted gap claims are preserved in `verdicts.jsonl` (`isReal:false`) — read them before
  re-reporting those as issues.
