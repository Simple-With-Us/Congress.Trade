# Resource digest: separate host and container RAM

The host metric stays at `metrics.memory` for compatibility. It is explicitly scoped to host RAM: `MemAvailable / MemTotal` from `/proc/meminfo`. Its existing low-availability defaults stay at yellow <=15% and red <=8% (`THRESH_MEM_AVAIL_PCT_YELLOW` and `_RED`). No container report replaces either value.

The separate `metrics.container_memory` consumes the native `container-mem-report.sh --json` interface introduced by CT-2492. The report must be beside the digest or in `/usr/local/bin`, or in the exclusive `HETZNER_DIGEST_SIBLING_DIR`. The former hypothetical `host-container-ram-report.sh` hook is removed because it has no established schema or implementation in this repository.

Each container's ratio is `100 * memory_usage_bytes / memory_limit_bytes`, only with a positive cap whose source is `cgroup_max` or `inspect`. There is no invented container `available_pct`, host denominator, sum of overlapping limits, or average that can hide a pressured container.

`memory_usage_source` is preserved per row. Docker stats on Linux excludes inactive file cache. The report can instead fall back to cache-inclusive cgroup current usage; that source remains explicit. The raw `memory_current_bytes` is also reported separately. High usage is a headroom warning, not an OOM diagnosis or permission to increase a limit. The source report's existing OOM/restart counters remain in the sibling payload.

The new container-specific defaults are yellow >=80% and red >=90% used. These are digest warning defaults, not previously established host policy or measured workload limits. They leave 20% and 10% headroom and can be tuned independently with `THRESH_CONTAINER_MEM_USED_PCT_YELLOW` and `_RED`. Values must satisfy `0 < yellow < red <= 100`. They do not alter container limits, reservations, swap policy, or the host availability thresholds.

The metric includes each row's value, source, cap, status and error, plus reported/evaluated/unlimited/unknown counts. The displayed value is the maximum evaluated percentage. Status is the worst row, with red above yellow above unknown above green. Unlimited or missing caps, missing usage, invalid schemas, absent collectors and failed collectors remain unknown, never 0% or healthy. An empty valid report means no running containers and is green with a null maximum. Unknown container coverage participates in overall status, so a digest cannot claim all-clear when container coverage is unavailable. No aggregate delta is shown because the highest-usage container can change between runs.

Offline checks:

```bash
bash scripts/ops/test-hetzner-resource-digest.sh
python3 scripts/ops/test_hetzner_digest_failures.py
python3 scripts/ops/test_hetzner_container_memory.py
bash scripts/ops/test-container-mem-report.sh
```

No host collection, installation, service enablement, resource-limit change or deployment is part of this repair.
