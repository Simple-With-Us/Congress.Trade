# Docker reclaim report

## Summary

The Coolify host fills with BuildKit cache, dangling images, and old deployment tags.  A wrong prune can delete the image Coolify needs to roll an app back, or a named volume that holds SQLite.  This adds an on-demand report.  It does not install a timer and it does not change `scripts/ops/box-disk-hygiene.sh`.

The default is a dry-run.  `APPLY=1` is the only switch that deletes anything.  Age windows are at least one day.  The build-cache filter accepts hours only, default `72h`.

## Files changed

- `scripts/ops/docker-reclaim.sh` collects `docker system df -v` and narrow inspect records, prints the report, and runs the action list only when `APPLY=1`.
- `scripts/ops/docker_reclaim.py` decides what is reclaimable.  It never calls Docker.
- `scripts/ops/tests/test_docker_reclaim.py` and `scripts/ops/test-docker-reclaim.sh` cover the planner with mocked CLI output.
- `.github/workflows/docker-reclaim.yml` runs those tests on Ubuntu.  `ci.yml` is unchanged so this does not collide with the other host-hygiene PRs.

## What the report counts

Bytes come from `docker system df -v`.  Exact ages and Coolify labels come from inspect, because the verbose table's relative times are not safe enough to choose a delete.  The build-cache byte count is an estimate from those relative times.  The daemon's `until` filter is what actually deletes cache.

The report lists five reclaimable groups:

- build cache whose last use is older than `BUILD_CACHE_UNTIL` (default `72h`)
- dangling images older than `IMAGE_MIN_AGE_DAYS` (default 14)
- other unused images older than that same window
- stopped containers older than `CONTAINER_MIN_AGE_DAYS` (default 14)
- dangling anonymous volumes

`before:` is `docker system df`.  `after:` is the same command again, and only after `APPLY=1`.  A dry-run prints `skipped`.

## What APPLY refuses to delete

- Named volumes.  There is no volume-wide prune.
- Anonymous volumes that carry any `coolify.*` label, or that are still linked to a container.
- Running, paused, or restarting containers.  A `docker system df -v` status of `Up` also blocks removal when inspect disagrees.
- Containers whose names are `coolify` or start with `coolify-`, including the proxy and database.
- Images whose repository is `coollabsio/coolify` or `coolify`.
- The image referenced by every container that exists at plan time, running or stopped.  An image whose only container is removed in this same run stays until a later run.
- One previous image per Coolify app, for rollback.  The app is the `coolify.applicationId` (or the other `coolify.*` id labels), expanded to images that share a Coolify uuid tag.  Previous means the newest image strictly older than the newest in-use image.  An untagged image is included when it still has a `coolify.*` label.  An untagged image with no `coolify.*` label and no uuid tag is treated as a build leftover once it is older than N days.
- Anything with a `coolify.*` label that belongs to an app with a running container, or a container that finished within `COOLIFY_RECENT_DAYS` (default 14).  Older stopped containers of an app that is still live stay.  Historical images beyond the previous one can still be removed when they are unused and older than N days.
- Build cache newer than the until filter.  The command is `docker builder prune -f --filter until=72h`.  It is not `docker builder prune -a`, `docker image prune -a`, `docker system prune`, or `docker volume prune`.

`IMAGE_MIN_AGE_DAYS=0`, `CONTAINER_MIN_AGE_DAYS=0`, `COOLIFY_RECENT_DAYS=0`, and values such as `3d` are rejected before Docker is called.  `APPLY=true` stays a dry-run.  Only `APPLY=1` deletes.

## Verification

```bash
bash scripts/ops/test-docker-reclaim.sh
```

The tests use a fake `docker` on `PATH`.  They check that a dry-run never calls `rm` or `prune`, that `APPLY=1` removes only the planned ids, and that a bad `docker system df -v` table aborts before any delete.  No test contacts the Hetzner host.

Coolify watch paths are `app/**` and `services/**`.  This change does not rebuild congress-app.  `bash app/scripts/ship.sh` is not part of it.

## Operator follow-up

After merge, install both files next to each other on the Coolify host.  The shell looks beside itself for the planner.  Python 3 and Bash 4.3 or newer are required.  Do not point this at a Mac.

```bash
install -m 0755 scripts/ops/docker-reclaim.sh /usr/local/sbin/docker-reclaim.sh
install -m 0644 scripts/ops/docker_reclaim.py /usr/local/sbin/docker_reclaim.py
/usr/local/sbin/docker-reclaim.sh
```

Read the dry-run.  Confirm each `rollback_image` line is the deployment you would roll back to, and that named volumes appear only as skips.  Then, if that report is right:

```bash
APPLY=1 /usr/local/sbin/docker-reclaim.sh
```

There is no timer.  Run it by hand.  `box-disk-hygiene` is a separate job and is not modified here.
