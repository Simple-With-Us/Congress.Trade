# Docker volume report

## Summary

The Coolify host on Hetzner keeps Docker volumes and bind mounts for each app, and unused volumes stay after a deploy is replaced.  This adds an on-demand, read-only report.  It sizes every volume and bind mount, maps each one to a Coolify app or service, and compares sizes with the previous JSON.  It does not install a timer and it does not change `scripts/ops/box-disk-hygiene.sh` or `scripts/ops/docker-reclaim.sh`.

The script deletes nothing.  An orphaned volume is one that no inspected container mounts.  When `docker system df -v` prints a numeric LINKS count, that count has to match the mounts or the report stops and prints no removal line.  For each orphan, stdout is one suggested `docker volume rm` command and nothing else.  The command is not executed.

## Files changed

- `scripts/ops/docker-volume-report.sh` collects `docker system df -v`, volume labels, and container mounts, then sizes bind mounts with `du`.
- `scripts/ops/docker_volume_report.py` writes the JSON and markdown.  It never calls Docker.
- `scripts/ops/tests/test_docker_volume_report.py` and `scripts/ops/test-docker-volume-report.sh` cover the report with a fake `docker` binary.
- `.github/workflows/docker-volume-report.yml` runs those tests on Ubuntu.  `ci.yml` is unchanged so this does not collide with the other host-hygiene PRs.

## What the report records

Bytes for volumes come from `docker system df -v`.  Bytes for bind mounts come from `du -sB1` on the host path.  The inspect format asks for the container name, status, labels, and mounts.  It does not ask for env, host config, or volume options.  App mapping reads Coolify resource, service, project, and name labels, then `com.docker.compose` service and project labels.  A container with none of those labels is mapped from its container name.  Token-like labels are not copied into the report.

A volume is an orphan when no container mounts it.  `N/A` in the LINKS column does not hide that.  A numeric LINKS value that disagrees with the mounts aborts the report before any file is replaced and before any `docker volume rm` line is printed.  Bind mounts are never given a removal command.  The report refuses to size `/` or a path with a `.` or `..` segment.

The first run lists no growers, because there is no previous JSON yet.  Later runs read `latest.json` before replacing it.  A new path counts as growth from zero.  A path whose size is unknown is left out of the ranking.  The default list is the ten largest increases.

## Verification

```bash
bash scripts/ops/test-docker-volume-report.sh
```

The tests use a fake `docker` on `PATH`.  They check that the script never calls `rm` or `prune`, that orphan stdout is only `docker volume rm`, and that growth is computed from the previous JSON.  No test contacts the Hetzner host.

Coolify watch paths are `app/**` and `services/**`.  This change does not rebuild congress-app.  `bash app/scripts/ship.sh` is not part of it.

## Operator follow-up

After merge, install both files next to each other on the Coolify host.  The shell looks beside itself for the reporter.  Python 3, Bash 4.3 or newer, and GNU `du` are required.  Do not point this at a Mac.

```bash
install -m 0755 scripts/ops/docker-volume-report.sh /usr/local/sbin/docker-volume-report.sh
install -m 0644 scripts/ops/docker_volume_report.py /usr/local/sbin/docker_volume_report.py
/usr/local/sbin/docker-volume-report.sh
```

JSON is `/var/lib/docker-volume-report/latest.json`.  Markdown is `/var/lib/docker-volume-report/latest.md`.  Stdout is the suggested `docker volume rm` lines, and nothing else.  There is no timer.  `box-disk-hygiene` and `docker-reclaim` are separate jobs and are not modified here.
