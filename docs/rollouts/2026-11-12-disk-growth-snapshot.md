# 2026-11-12 — Daily disk-growth snapshot + diff report (CT-2486)

## Summary

Adds read-only tooling to record a small JSON snapshot each UTC day of host disk
usage: mounted filesystem free/used/inode stats, top-N `du -x` directory totals
under the main data roots and backup paths, and a parsed `docker system df -v`
breakdown.  A companion report script diffs today vs 1-day and 7-day baselines to
surface the largest growers and shrinkers.  No pruning, alerts, or host changes in
this PR — install on the Hetzner Coolify box waits for Jay after merge.

## Files changed

| Path | Role |
|------|------|
| `scripts/ops/disk-growth-lib.sh` | Shared collectors, JSON builder, retention |
| `scripts/ops/disk-growth-snapshot.sh` | Daily oneshot writer |
| `scripts/ops/disk-growth-report.sh` | Human or `--json` diff report |
| `scripts/ops/test-disk-growth.sh` | Offline tests with fixtures + mock docker |
| `scripts/ops/fixtures/disk-growth/*` | Test doubles and sample `docker system df -v` output |
| `scripts/ops/systemd.noindex/disk-growth-snapshot.{service,timer}` | Sample units (daily, idle IO, randomized delay) |

## Verification

```bash
bash scripts/ops/test-disk-growth.sh
```

On the host (after Jay approves install):

```bash
install -m 0755 scripts/ops/disk-growth-*.sh /usr/local/bin/
install -m 0644 scripts/ops/systemd.noindex/disk-growth-snapshot.* /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now disk-growth-snapshot.timer
/usr/local/bin/disk-growth-snapshot.sh
/usr/local/bin/disk-growth-report.sh
ls -la /var/lib/fleet-disk-growth/
```

## Follow-ups

- Host install + timer enable on `fleet-hetzner-nbg1` (Jay)
- Optional FleetLink/dashboard charting if week-over-week views are wanted in UI
- CT-2471 remains the owner for disk alert thresholds and hygiene prunes
