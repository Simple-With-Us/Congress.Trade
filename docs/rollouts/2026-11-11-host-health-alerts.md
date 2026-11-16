# 2026-11-11 — Host health on the box-disk-hygiene timer

## Summary

CT-2471 extends the existing 15-minute `box-disk-hygiene` timer so it can replace INSTINCT Datadog monitors 23168882 through 23168886.  Jay left the Datadog agent off `fleet-hetzner-nbg1` on 2026-11-10.  This change does not reinstall Datadog and does not add a second systemd timer.  CT-1875 stays deployed and is not reopened.

Host install is out of scope.  The unit already on the box keeps running the previous script until Housekeeper installs this copy after merge, and only with Jay's yes where a host change needs it.

## Files changed

| Path | Role |
|------|------|
| `scripts/ops/box-disk-hygiene.sh` | Same oneshot: root prune plus RAM, swap-out, inodes, load, and per-mount disk |
| `scripts/ops/systemd.noindex/box-disk-hygiene.service` | Description only.  Exec path unchanged |
| `scripts/ops/systemd.noindex/box-disk-hygiene.timer` | Comment only.  Cadence stays 15 minutes |
| `scripts/ops/test-box-disk-hygiene.sh` | Offline fixtures.  No host, Docker daemon, or network |
| `.github/workflows/ci.yml` | Runs that test in the existing Linux job |

## Behavior

Root disk thresholds are unchanged and still pick the prune path.  Warn at 80% used or under 15G free.  Crit at 90% used or under 8G.

| Check | Warn | Crit | Notes |
|-------|------|------|-------|
| `/` | 80% or free under 15G | 90% or free under 8G | Prune driver.  Unchanged |
| `/tmp`, `/dev/shm` | 80% or free under 3.2G | 90% or free under 1.6G | Matches monitors 23168885 and 23168886.  A filesystem smaller than the free floor uses percent only |
| `/mnt/fleet-extra` | same as `/` | same as `/` | UNKNOWN when unmounted.  That does not fail the run |
| inodes | 80% | 90% | Each mounted path above |
| memory | MemAvailable below 15% | MemAvailable below 5% | Available memory, not used percent |
| swap | swap-out at 256 KB/s | swap-out at 2048 KB/s, or the warn rate while memory is already critical | Swap percent alone does not page.  The first sample is a baseline |
| load | load5 / ncpu at 2 | load5 / ncpu at 4 | |
| root growth | used space up 25G inside the trailing hour | none | Monitor 23168882.  Samples inside the hour are kept, so the 15-minute tick can see the hour |
| `/tmp` growth | used space up 4G inside 20 minutes | none | Monitor 23168883.  A spike that comes and goes between ticks can still be missed |

A path that is not its own mount, such as `/tmp` on a host that has no separate tmpfs, is UNKNOWN.  Files on the root filesystem stay covered by the `/` check.

Prune safety is the same shape as CT-1875, with two tightenings:

- The run still skips prune while a Coolify, nixpacks, or buildkit container is active.  Health alerts still fire.
- `docker builder prune -af` runs only when Build Cache ACTIVE is 0.  The light path (`docker builder prune -f --filter until=12h` and dangling `image prune`) is unchanged.
- Named volumes are never pruned.  `PRUNE_VOLUMES=1` is ignored.  `docker system prune` is never passed `--volumes`.
- Docker is not restarted and the host is not rebooted.
- `DRY_RUN=1` logs the commands and does not execute them.

Alerts go to Pushover when `PUSHOVER_USAGE_API_TOKEN` or `PUSHOVER_APP_TOKEN` is set, plus `PUSHOVER_USER_KEY`.  The script still sources `/etc/box-disk-hygiene.env` and then `/etc/congress-health-recover.env`.  Tokens are not committed.  Warn is priority 0, crit is priority 1, and a recovery note is sent when a signal returns to ok.

Dedupe is per signal.  A page goes out on a level change, then a reminder every 4 hours (`ALERT_REMINDER_SEC`, default 14400).  A root disk that sits above 80% from the backup swing does not page every 15 minutes.

## Verification

```bash
bash scripts/ops/test-box-disk-hygiene.sh
```

The test covers fixture metric collection, threshold evaluation, and alert dedupe, including the case where the same warn level does not page again on the next tick.  It also covers the light, soft, and aggressive prune paths, the build-cache ACTIVE gate, deploy-active skip, cooldown, and `DRY_RUN`.

This PR does not SSH to `fleet-hetzner-nbg1` and does not install the unit.

## Follow-ups

- Housekeeper installs `/usr/local/bin/box-disk-hygiene.sh` and the matching unit files on the host after merge.
- OPS-1060 mutes the dead Datadog monitors.  This PR does not touch Datadog.
- `/tmp` growth shorter than the 15-minute cadence can still be missed.  The free-space check on `/tmp` remains.
