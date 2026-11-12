# Latency week focus (2026-08-06 → 2026-08-13)

**Owner intent:** Track latency probe + provider publish timestamping for a while.
For one week, catch **every** House / Senate / Executive transaction available for
any disclosure date in the last **5 years** (largely done), and
**promptly / accurately / affordably / autonomously / professionally** handle
**new filings before others**.

## North star

| Priority | Goal |
|----------|------|
| P0 | **Live win** — detect + extract + scoreboard-stamp new filings before FMP / UW / Quiver |
| P0 | **Honest timestamps** — provider publish/first-seen never null when we claim a match lead |
| P1 | **5-year completeness** — any disclosure dated ≥ today−5y present for H / S / Exec |
| P1 | **Probe health** — FMP stable + RapidAPI + UW + QQ each fetching under budget/yield bands |
| P2 | Affordable — free-tier FMP dual keys + marketplace RapidAPI; no enrichment/prices FMP spend |

## Baseline snapshot (prod, 2026-08-06 ~14:15Z)

| Signal | Value | Notes |
|--------|------:|-------|
| Health | ok / db ok | pipeline ok |
| Latest transaction age | ~17h | `data_freshness` |
| filingsImportedToday | **0** | no new docs today yet |
| House tx total | ~63.6k | public API |
| Senate tx total | ~19.3k | includes seed rows |
| Executive tx total | ~1.2k | |
| Latency candidates (7d) | 120 | 106 matched / 14 pending |
| FMP | ops running, **matched 0**, obs 185 | 59 pending; often “cap/spacing skip”; force fetch 50 still 0 matches → **hash/match gap** |
| FMP RapidAPI | ops running, **obs 0** | marketplace key likely missing in Coolify, or path never succeeds |
| Unusual Whales | matched 9 (admin list 35), **HTTP 401** on force probe | trial/key lapsed |
| Quiver | matched 97 public; admin deltas OK via `providerFirstSeenAt` | publish stamp often null (`Quiver_Upload_Time` missing) — first-seen fallback required |

## Daily tracker

Run (or let the scheduled agent run):

```bash
# Public-only (safe):
python3 scripts/latency-week-tracker.py

# With admin token from env (never print token):
ADMIN_TOKEN=… python3 scripts/latency-week-tracker.py --admin
```

Appends JSONL to `docs/latency-week/YYYY-MM-DD.jsonl` (gitignored samples ok;
repo keeps schema + latest summary in `docs/latency-week/README.md`).

**Alert if any of:**

1. `filingsImportedToday == 0` after 16:00 America/New_York on a US weekday  
2. FMP path error rate / zero fetches for >6h during peak (08–16 ET)  
3. Any provider `matched > 0` with **null** effective lead (publish and first-seen both null)  
4. UW/QQ HTTP 401/403 for >2 consecutive probes  
5. Health `data_freshness` not ok  

## Live-win checklist (this week)

- [ ] Coolify/Infisical: `RAPIDAPI_KEY` or `FMP_RAPIDAPI_KEY` present (ST marketplace key)  
- [ ] Coolify/Infisical: `FMP_LATENCY_API_KEY` + `_2` present and under daily cap mid-day  
- [ ] Refresh **UNUSUAL_WHALES_API_KEY** (prod 401)  
- [ ] Scout LaunchAgent on residential Mac healthy (`FMP_PROBE_ENABLED`, latency keys, optional RapidAPI)  
- [ ] House live search + Senate lookback + OGE watcher enabled  
- [ ] Latency probes force-run green for fmp + quiver after key fixes  
- [ ] Fix FMP trade-hash / fuzzy match so pending Capito-style races resolve  
- [ ] Public scoreboard: one FMP lane; Quiver leads use first-seen when upload time absent  
- [ ] 5y gap scan: filings by chamber × filed_date year buckets; re-backfill holes only  

## 5-year completeness (H / S / Exec)

Retention already sweeps **>5 years**. Target window: **filed_date ≥ today−5y**
(or first_seen for undated seed rows once normalized).

| Chamber | Approach |
|---------|----------|
| House | Bulk year indexes + live search + prior-year overlap in Jan; crawler for gaps |
| Senate | Submitted-date lookback + deep sweep + seed/recovery only where official HTML fails |
| Executive | OGE 278-T index watcher + vision extract; full-index re-poll if gap |

Do **not** re-burn paid extract on already-complete docs. Prefer
`INSERT OR IGNORE` discovery + agreement only for new/changed docs.

## FMP policy (standing)

All FMP spend = **latency probes + Mac scout only**. No prices, no enrichment,
no scheduled recovery on free-tier keys. Dual free keys on **stable**; marketplace
`RAPIDAPI_KEY` on **RapidAPI** path with its own daily cap.

## Closeout (2026-08-13)

- Attach week JSONL summary + final latency-summary screenshot/API dump  
- List residual match gaps + key/ops actions  
- Decide whether UW deep-match stays on after key renewal  
