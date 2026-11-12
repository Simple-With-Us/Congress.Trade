# 2026-11-12 — Hetzner Docker container logs + journald disk caps (CT-2483)

## Summary

Adds repo-side tooling to **measure** Docker json-file container log bytes and journald
disk use, and to **install** (on the host, with Jay's approval) Docker daemon defaults
`json-file` with `max-size=50m` / `max-file=3` plus a systemd-journald drop-in cap.
This complements `box-disk-hygiene.sh` (image/builder prune) by bounding unbounded
container and journal growth on the 150G root volume.

**This PR is code + offline tests only.**  Nothing runs on the production Hetzner host
until Jay explicitly approves host install and any Docker daemon restart.

## Files changed

| Path | Role |
|------|------|
| `scripts/ops/fleet-log-cap-report.sh` | Read-only size report (containers, journald, daemon.json, docker info) |
| `scripts/ops/fleet-log-cap-install.sh` | Idempotent installer (`APPLY=1` to write); never restarts Docker |
| `scripts/ops/journald.conf.d/fleet-journal-cap.conf` | Drop-in: `SystemMaxUse=1G`, `SystemKeepFree=8G`, `MaxRetentionSec=14day` |
| `scripts/ops/test-fleet-log-cap.sh` | Offline mocks for docker/journalctl/systemctl |

## Behavior

### Report

```bash
bash scripts/ops/fleet-log-cap-report.sh
```

Prints per-container json log path/size, total bytes, `journalctl --disk-usage`, and
configured/runtime Docker logging driver/options.

### Install (host — after merge + Jay yes)

Dry-run default (no writes):

```bash
bash scripts/ops/fleet-log-cap-install.sh
```

Apply config files only:

```bash
APPLY=1 bash scripts/ops/fleet-log-cap-install.sh
```

- Merges into `/etc/docker/daemon.json` with `jq` (preserves unrelated keys; timestamped
  backup when replacing an existing file).
- Copies journald drop-in to `/etc/systemd/journald.conf.d/fleet-journal-cap.conf`.
- On apply, reloads journald via `systemctl kill … SIGUSR2` (fallback:
  `journalctl --vacuum-size=1G`).
- **Does not** `systemctl restart docker` or reboot the host.

Daemon defaults affect **new** containers after Docker is restarted; existing container
logs are unchanged until rotation/recreate.

## Verification

Repo (CI / laptop):

```bash
bash -n scripts/ops/fleet-log-cap-report.sh
bash -n scripts/ops/fleet-log-cap-install.sh
bash scripts/ops/test-fleet-log-cap.sh
```

Host (after Jay approves install):

```bash
bash scripts/ops/fleet-log-cap-report.sh
# compare before/after APPLY=1 install
journalctl --disk-usage
jq '."log-driver", ."log-opts"' /etc/docker/daemon.json
```

## Follow-ups

- Jay-approved Docker restart window so daemon.json defaults apply fleet-wide.
- Optional timer to run `fleet-log-cap-report.sh` and ship metrics to fleet alerting.
- Coordinate with CT-2471 disk-hygiene timer so prune + log caps stay visible in one
  dashboard.
