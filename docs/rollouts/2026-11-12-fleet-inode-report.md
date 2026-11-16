# 2026-11-12 — Fleet inode usage report (CT-2502)

## Summary

Adds a **read-only** hourly inode pressure report for the Coolify/Hetzner Ubuntu host.  The script surfaces `df -i` for real block filesystems (skips tmpfs, overlay, squashfs) and ranks immediate child directories by file count under configurable roots.  It exits **0 / 1 / 2** for ok / warn / crit against inode IUse% thresholds (default 80% / 90%).  No pruning, no writes, no service restarts.

## Files changed

| Path | Role |
|------|------|
| `scripts/ops/inode-usage-report.sh` | Report + `--json` |
| `scripts/ops/systemd/fleet-inode-report.service` | Oneshot, journal only |
| `scripts/ops/systemd/fleet-inode-report.timer` | Hourly |
| `scripts/ops/test-inode-usage-report.sh` | Offline CI harness |
| `scripts/ops/fixtures/inode-df-*.txt` | `df -i` fixtures |

## Install on host (operator)

After merge, on `fleet-hetzner-nbg1` as root:

```bash
install -m 0755 scripts/ops/inode-usage-report.sh /usr/local/bin/
install -m 0644 scripts/ops/systemd/fleet-inode-report.service /etc/systemd/system/
install -m 0644 scripts/ops/systemd/fleet-inode-report.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now fleet-inode-report.timer
systemctl start fleet-inode-report.service
journalctl -u fleet-inode-report -n 80 --no-pager
```

Optional `/etc/fleet-inode-report.env`:

```
INODE_WARN_PCT=80
INODE_CRIT_PCT=90
INODE_TOP_N=10
INODE_SCAN_ROOTS="/var/lib/docker /var/log /tmp /data /home"
```

Manual run with JSON: `/usr/local/bin/inode-usage-report.sh --json`

## Verification

```bash
bash -n scripts/ops/inode-usage-report.sh
bash scripts/ops/test-inode-usage-report.sh
systemctl is-active fleet-inode-report.timer
systemctl list-timers fleet-inode-report.timer
```

## Follow-ups

- Wire warn/crit exits into fleet alerting (PagerDuty / Pushover) if inode pressure becomes recurring.
- Narrow scan roots if hourly `find` cost is noticeable on busy Docker hosts.
