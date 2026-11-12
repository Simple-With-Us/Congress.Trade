# Massive bulk price-history loader

Backfills daily aggregate bars from the Massive (Polygon-style) REST API into the
app's SQLite database: `price_eod` for every ticker in `securities_master`, plus
the S&P benchmark series into `spx_eod`. Built 2026-08-01 (KIMI) for the
production bulk-load run; production execution is blocked on host SSH access
(fleet request pending) — this directory is the tested script + runbook.

## Files

- `load_prices.py` — the loader. Python 3 **stdlib only** (urllib / sqlite3 /
  json / argparse); no pip needed on the destination host.
- `resolve_massive_key.py` — local convenience: resolves `MASSIVE_API_KEY` from
  Infisical exactly the way the app does (`app/src/secrets/infisical.ts`), using
  the machine identity in `app/.dev.vars`. Prints **only** the key to stdout so
  it can be captured into an env var without landing in transcripts.

## Conventions (mirrored from the app)

- Endpoint/auth/response shape mirror `app/src/prices/massive.ts`:
  `GET https://api.massive.com/v2/aggs/ticker/{SYM}/range/1/day/{FROM}/{TO}?adjusted=true&sort=desc&limit=50000&apiKey={KEY}`,
  `t` (ms epoch) → UTC `YYYY-MM-DD`, split-adjusted closes.
- 429/5xx retry budget mirrors `app/src/prices/retry429.ts`: waits 5s/15s/30s,
  ±20% jitter, `Retry-After` honored, capped at 60s (`--retries N` extends the
  tail with 60s waits — useful for the overnight job).
- 404 → genuinely no data (negative-cache, skip). 401/403 → fatal, abort (every
  call fails identically). Network errors retry on the same budget.
- `spx_eod` is fed from **SPY** (plain equity) — the app's own convention,
  because index symbols (`I:SPX`) need an Indices entitlement the Stocks plan
  lacks.
- Inserts are `INSERT OR IGNORE`: existing rows always win, reruns are
  idempotent. `price_eod` rows carry `(ticker, date, close, volume)`;
  `spx_eod` carries `(date, close)`. Writes batch by default (`--commit-every
  50`) so Litestream does not emit one Class A PutObject per ticker; fetches
  still run outside the write lock. `busy_timeout` 60s; no schema or
  journal-mode changes — safe to run against the live DB file.

## ⚠ Plan entitlement finding (tested 2026-08-01)

The current Massive key/plan serves only **~2 years** of aggregates history:

- request `2021-08-02 → 2026-08-01` → 200, silently truncated to bars from
  `2024-08-01` (exactly 2 years back);
- request entirely older than 2 years → **HTTP 403**.

The loader therefore treats the SPY fetch as an **entitlement probe**: the
effective window start is `max(requested_start, first_SPY_bar)`, and progress
state is keyed by that *effective* window. Consequences:

- A `--years 5` run today backfills the most recent ~2 years (≈501 trading days).
- If the plan is upgraded later, just rerun the same command — the probe moves
  the boundary back, producing a new state window that re-fetches every ticker
  and `INSERT OR IGNORE` fills only the older rows.

## Local usage (tested path)

```bash
cd analysis/massive-bulk-load
export MASSIVE_API_KEY=$(python3 resolve_massive_key.py)   # Infisical → env var, never printed

# dry-run against a COPY of the replica (never point tests at app/data/app.db)
cp app/data/app.db /tmp/ct-replica-copy.db
python3 load_prices.py --db /tmp/ct-replica-copy.db \
  --tickers AAPL,MSFT,ABR-PD,ROYL,KRAQU --dry-run --verbose

# real sample load + resume check (rerun skips completed tickers)
python3 load_prices.py --db /tmp/ct-replica-copy.db \
  --tickers AAPL,MSFT,ABR-PD,ROYL,KRAQU --verbose --state /tmp/load-state.json
python3 load_prices.py --db /tmp/ct-replica-copy.db \
  --tickers AAPL,MSFT,ABR-PD,ROYL,KRAQU --verbose --state /tmp/load-state.json
```

Key flags: `--years 5` (default window), `--from/--to` overrides,
`--tickers`/`--tickers-file` subsets, `--limit/--offset`, `--rpm 60`,
`--retries 3`, `--skip-spx`, `--spx-only`, `--max-consec-errors 25`,
`--commit-every 50` (batched SQLite commits; Litestream Class A hygiene),
`--dry-run`, `--state massive_load_state.json`.

Prefer `load_prices_st.py` for production CT loads (ST peer market endpoints;
same `--commit-every` default).

## Resume semantics

- Every finished ticker is recorded in the JSON state file (per effective
  window) with status `ok` / `empty` / `not_found`, row counts, and date range;
  reruns skip those tickers.
- Tickers that **error** (429 budget exhausted, persistent 5xx/network) are
  *not* recorded — they are retried on the next run. To finish a contended run:
  **rerun the same command until the log says `0 to process this run`.**
- Even with the state file deleted, `INSERT OR IGNORE` + PK `(ticker, date)`
  makes reruns duplicate-free (verified: rerun without state inserted 0 rows).

## Tested results (2026-08-01, replica copy, 10,433 master tickers)

- Sample: SPX(SPY) 501 bars → 5 new `spx_eod` rows; AAPL/MSFT 501 bars each
  (10/9 new — replica already held the overlap); ROYL 398 new rows (delisted
  2026-07-30); KRAQU 106 new rows (listed 2026-01-28); ABR-PD confirmed empty
  (preferred-share dash symbol not served).
- Spot-check vs raw API: AAPL 2026-07-30 close 333.43 / vol 74,817,792 and
  2026-07-31 close 308.91 / vol 132,489,137 — byte-identical to DB rows.
- 429 handling observed live: waits 4–6s / 12–18s / 25–34s then success;
  `--retries 5` converted all would-be errors into successes on a contended pass.
- Throughput: uncontended at `--rpm 60` ≈ 1 ticker/s (~3 h for 10,433);
  observed under heavy shared-key contention ≈ 5–7 tickers/min (~25–35 h).
  The key is shared with sibling apps, so plan for the slow bound and run
  overnight with `--retries 5`; rerun to mop up errored tickers.

## Production runbook (requires host SSH access — pending fleet request)

Prod DB lives on the production Coolify host (see `fleet-ops:ATTACK-MAP.md`) at
`/data/congress-trade/db.sqlite` (local SQLite file; the Deno app reads/writes
it live). The loader is write-safe alongside the app (per-ticker transactions,
`INSERT OR IGNORE`, busy-timeout 60s), but run it in a `tmux`/`nohup` session —
it takes hours.

```bash
# 1. copy the script to the host (stdlib only — no pip needed)
scp analysis/massive-bulk-load/load_prices.py HOST:/data/congress-trade/

# 2. on the host: provide the key (from the Coolify env / Infisical — never echo it)
export MASSIVE_API_KEY=...        # same key the app uses (PRICE_PROVIDER=massive)

# 3. dry-run smoke test against the live DB (writes nothing)
cd /data/congress-trade
python3 load_prices.py --db /data/congress-trade/db.sqlite \
  --tickers AAPL,MSFT --dry-run --verbose --state /tmp/massive-probe.json

# 4. full run (tmux/nohup; ~3h uncontended, up to ~35h under key contention)
nohup python3 load_prices.py --db /data/congress-trade/db.sqlite \
  --rpm 60 --retries 5 --state /data/congress-trade/massive_load_state.json \
  > /data/congress-trade/massive_load.log 2>&1 &

# 5. until done: rerun the identical command — it resumes and retries errors.
#    Finished when the log says "0 to process this run".

# 6. verify (read-only)
sqlite3 /data/congress-trade/db.sqlite \
  "SELECT COUNT(DISTINCT ticker), COUNT(*), MIN(date), MAX(date) FROM price_eod;" \
  "SELECT COUNT(*), MIN(date), MAX(date) FROM spx_eod;"
```

Expected steady state after the run: every servable master ticker has daily bars
from ~2024-08-01 (plan boundary — 2y) to the latest trading day; `spx_eod` has
the SPY series over the same window. For the full 5 years, upgrade the Massive
plan and rerun the same command (see the entitlement section above).

Safety: never point `--db` at `app/data/app.db` for tests (use a copy); never
print the API key; do not run against prod from a laptop — run it on the host so
the SQLite file is local.
