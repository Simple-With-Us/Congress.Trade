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

## Review repairs

Both entrypoints source the sibling library first, so the documented install of
all `disk-growth-*.sh` files works outside a checkout. The sample oneshot does
not impose the 90-second systemd default on multi-minute directory scans.
Nothing is installed or enabled by these source changes.

Overlapping requested roots on the same device are grouped under one ancestor
walk, with enough depth to retain the requested child breakdowns. Symlink roots
are resolved to their target tree; duplicate targets are scanned once. Roots on
a different device remain independent because `du -x` cannot cross to them.
The defaults explicitly include `/tmp` and `/mnt/fleet-extra`. The collector
consumes the complete du stream but retains only bounded top-N rows per root,
without rescans, an early-closing `head` pipeline, or a potentially large du
staging file. Timeout or other du failure preserves any partial readings and
marks all affected roots incomplete.

Snapshot inputs and report baselines are passed as private temporary-file paths
or existing snapshot paths, not environment-sized JSON/Docker blobs. Temporary
collector input files are cleaned up on exit. A partial current or baseline
directory scan makes that directory comparison unavailable, never a fabricated
shrink to zero. Docker comparisons likewise remain unavailable when either
collection failed. Human output names these unavailable comparisons.

The existing offline suite now runs thirteen additional offline regressions,
including installed layouts, oversized snapshots/Docker inventories, overlapping
and symlink roots, du failure/timeout flags and current/baseline unavailable
comparisons. CI runs this suite alongside the other ops tests.

Directory deltas compare paths observed in both top-N lists. An omitted path
can have fallen below the sampling cutoff rather than disappeared, so unmatched
path counts are reported instead of inventing a zero-size grower or shrinker.
