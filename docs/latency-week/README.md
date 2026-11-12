# Latency week tracker (2026-08-06 → 2026-08-13)

See rollout: [`docs/rollouts/2026-08-06-latency-week-focus.md`](../rollouts/2026-08-06-latency-week-focus.md).

## Run

```bash
# From repo root — public endpoints only
python3 scripts/latency-week-tracker.py

# Optional admin (ADMIN_TOKEN in env; never log the token)
ADMIN_TOKEN="…" python3 scripts/latency-week-tracker.py --admin
```

## Output

- Appends one JSON object per run to `docs/latency-week/samples/YYYY-MM-DD.jsonl`
  (directory gitignored except this README).
- Prints a human summary + `ALERT` lines for week-focus anomalies.
- Exit code `0` if healthy, `2` if any alert fired (for cron / ag***-s**c).

## What we watch

| Field | Why |
|-------|-----|
| `health.ok` / `data_freshness` | App live, data not stale |
| `filingsImportedToday` | New discovery happening |
| Per-provider `matched`, `avgLeadSec`, `operationalStatus` | Race quality |
| `nullLeadMatched` | Matched races without usable timestamps (publish + first-seen) |
| Admin probe errors (if `--admin`) | 401/cap/spacing |
