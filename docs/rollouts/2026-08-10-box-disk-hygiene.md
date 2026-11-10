# 2026-08-10 — Box disk hygiene + health-recover hardening

## Summary

Monet hit a **100% full root disk** (15MB free of 150GB) mid-deploy on the Coolify
host (`fleet-hetzner-nbg1` / `host.jays.services`). Overnight builds left ~29.7GB
builder cache + ~21.8GB unused images; deploy failed mid-image-pull. Manual prune
recovered ~51.5GB.

This change adds **scheduled disk checks + safe automated Docker prune** and hardens
`congress-health-recover` so it never starts name-matched stopped manual containers
(related Monet incident the same night).

## Files changed

| Path | Role |
|------|------|
| `scripts/ops/box-disk-hygiene.sh` | Check `df`, log SQLite/WAL + `docker system df`; light/soft/aggressive prune by thresholds |
| `scripts/ops/box-disk-hygiene.service` | systemd oneshot |
| `scripts/ops/box-disk-hygiene.timer` | every 15 min + 5 min after boot |
| `scripts/ops/congress-health-recover.sh` | label-first container match; name fallback **running only** |

## Behavior

| Level | Trigger (defaults) | Action |
|-------|--------------------|--------|
| ok | used &lt; 80% and free ≥ 15G | dangling `image prune` + builder cache older than 12h |
| warn | used ≥ 80% or free &lt; 15G | `docker builder prune -af` + `docker image prune -af` |
| crit | used ≥ 90% or free &lt; 8G | container prune + system prune -af (no volumes) + alert webhook if set |

Safety:

- Skips prune while Coolify/nixpacks/buildkit containers are running
- Aggressive path rate-limited (default 30 min cooldown)
- **Never** prunes named volumes unless `PRUNE_VOLUMES=1`
- No docker daemon restart, no host reboot

## Install on host

```bash
# from a checkout of this commit, as root on coolify:
install -m 0755 scripts/ops/box-disk-hygiene.sh /usr/local/bin/
install -m 0644 scripts/ops/box-disk-hygiene.service /etc/systemd/system/
install -m 0644 scripts/ops/box-disk-hygiene.timer /etc/systemd/system/
install -m 0755 scripts/ops/congress-health-recover.sh /usr/local/bin/
systemctl daemon-reload
systemctl enable --now box-disk-hygiene.timer
systemctl restart congress-health-recover.service
systemctl start box-disk-hygiene.service   # run once now
journalctl -u box-disk-hygiene -n 50 --no-pager
```

Optional `/etc/box-disk-hygiene.env`:

```
ALERT_WEBHOOK_URL=https://...   # Slack/ntfy JSON text webhook
WARN_USED_PCT=80
CRIT_USED_PCT=90
```

## Verification

```bash
systemctl is-active box-disk-hygiene.timer
systemctl list-timers box-disk-hygiene.timer
cat /var/lib/box-disk-hygiene/last-status
df -h /
docker system df
```

## Follow-ups

- `/data/backups` can dominate the 150G disk; separate retention policy if it grows
- Wire `ALERT_WEBHOOK_URL` to fleet Slack/ntfy once a durable webhook is chosen
- Same timer pattern can be shared to ST-only hosts if they diverge later
