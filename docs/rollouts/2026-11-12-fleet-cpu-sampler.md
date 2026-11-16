# 2026-11-12 — Fleet CPU steal / load history sampler (CT-2504)

## Summary

Adds a lightweight **once-per-minute** host sampler for the Coolify/Hetzner box:
load averages (1/5/15), CPU count, **steal** and **iowait** percentages from
`/proc/stat` deltas (no `sysstat`), and optional top-five Docker containers by
CPU. Samples append to `/var/log/fleet-cpu/samples.jsonl` with **in-script
retention** (7 days or 20 MiB). `cpu-history-report.sh` summarizes the last
N hours (p50/p95 load per CPU, steal, iowait) and exits **0/1/2** when sustained
high load or steal is detected.

## Files changed

| Path | Role |
|------|------|
| `scripts/ops/cpu-sampler.sh` | One-shot sample + rotation |
| `scripts/ops/cpu-history-report.sh` | Window summary + alert exit codes |
| `scripts/ops/systemd.noindex/fleet-cpu-sampler.{service,timer}` | Minute timer |
| `scripts/ops/logrotate.d.noindex/fleet-cpu` | Optional logrotate snippet |
| `scripts/ops/test-fleet-cpu-sampler.sh` | Offline harness (CI) |
| `scripts/ops/fixtures/fleet-cpu/*` | `/proc/stat` + loadavg fixtures |

## Install on host (operator, after merge)

```bash
# From a checkout at the merged SHA, on fleet-hetzner-nbg1 as root:
install -m 0755 scripts/ops/cpu-sampler.sh /usr/local/bin/
install -m 0755 scripts/ops/cpu-history-report.sh /usr/local/bin/
install -m 0644 scripts/ops/systemd.noindex/fleet-cpu-sampler.service /etc/systemd/system/
install -m 0644 scripts/ops/systemd.noindex/fleet-cpu-sampler.timer /etc/systemd/system/
install -d -m 0755 /var/log/fleet-cpu
install -d -m 0755 /var/lib/fleet-cpu-sampler
systemctl daemon-reload
systemctl enable --now fleet-cpu-sampler.timer
systemctl start fleet-cpu-sampler.service   # one sample now
```

Optional logrotate (primary retention is already inside `cpu-sampler.sh`):

```bash
install -m 0644 scripts/ops/logrotate.d.noindex/fleet-cpu /etc/logrotate.d/fleet-cpu
```

## Verification

```bash
systemctl is-active fleet-cpu-sampler.timer
systemctl list-timers fleet-cpu-sampler.timer
tail -3 /var/log/fleet-cpu/samples.jsonl
/usr/local/bin/cpu-history-report.sh 6
/usr/local/bin/cpu-history-report.sh 24 --json
journalctl -u fleet-cpu-sampler -n 20 --no-pager
```

After ~2 minutes, sample lines should include non-null `steal_pct` / `iowait_pct`
(second interval onward).

## Report exit codes

| Code | Meaning |
|------|---------|
| 0 | No sustained flags in the window |
| 1 | Load per CPU &gt; 1.5 for 15+ consecutive samples (~minutes) |
| 2 | Steal &gt; 10% for 15+ consecutive samples (dominates code 1) |

Wire into cron or a future alert helper as needed; this change does not page by itself.

## Follow-ups

- Optional Pushover/webhook when report exits non-zero (mirror `box-disk-hygiene`)
- Dashboard panel if fleet metrics UI wants host steal history
