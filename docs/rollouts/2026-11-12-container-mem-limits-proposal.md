# 2026-11-12 — per-container RAM and swap report, proposed limits (CT-2492)

> **Proposal only.** Nothing in this change is applied on the host, in Coolify, or in `app/docker-compose.yml`.  The report script only reads.

## Summary

The Hetzner host (the request describes 16 cores and about 17 containers under Coolify) has been sitting on about 20 GB of swap.  This change adds a read-only report of every running container's RAM, limit, swap, and OOM history, plus a proposal for the memory limit and reservation of each service this repo defines.  The host was not measured from this change, and nothing was installed there.

`docs/rollouts/2026-08-08-runners-hetzner-migration.md` recorded the same box as 8 cores and 15 GiB.  That record is older than the 16-core description in CT-2492.  These proposals do not assume a current RAM total.  They keep the hard ceilings already in compose and add reservations below those ceilings.

## What the report prints

`scripts/ops/container-mem-report.sh` lists each running container, sorted by memory usage, with a totals line.  `--json` prints one object instead of the table.

```bash
bash scripts/ops/container-mem-report.sh
bash scripts/ops/container-mem-report.sh --json
```

It calls `docker stats --no-stream` and `docker inspect` with a fixed format that asks only for id, name, image, `HostConfig.Memory`, restart count, pid, and status.  Swap comes from cgroup v2 `memory.swap.current`.  `oom` and `oom_kill` come from `memory.events`.  The cgroup column is `memory.current`, which includes file cache.  The limit is `memory.max` when that file is a number, otherwise the inspect memory value, and `none` when both say there is no cap.  Top RSS is the five highest `VmRSS` values among pids in `cgroup.procs`.  Above 250 pids that scan is skipped.  smem is not used.  It is an optional host binary, and spawning it sits outside this read-only cgroup scan.  The /proc read is the cheap path, and it is what the offline tests fake.  Any other docker subcommand is refused.  The script does not start, stop, update, exec into, or limit a container.  A container that disappears between stats and inspect stays in the report without inspect fields, and the other rows are still printed.

On Linux, docker stats subtracts inactive file cache, so MEM_USAGE can sit well below CGROUP.  The kernel enforces `memory.max` against `memory.current`.  A high CGROUP next to a modest MEM_USAGE is cache, not a reason to raise a cap.  JSON repeats both numbers as `memory_usage_bytes` and `memory_current_bytes`.

## Services this repo defines

The Coolify stack is `app/docker-compose.yml`.  Three services, already capped on 2026-08-12 after `scan-cpu-worker` ran with no limit.  The compose header says those ceilings are roughly 2–3× the working peak they were meant to bound, and that Coolify's compose deploy honours the short-form `cpus` / `mem_limit` / `pids_limit` keys.  There is no `mem_reservation` on any service.  This PR does not change those lines.

| Service | Container | Current `mem_limit` | CPUs | What it runs |
|---|---|---|---|---|
| `congress-app` | `congress-app` | 3g | 2.0 | Deno on port 5000, minute ticks (`CT_TICK_DEADLINE_MS=120000`), Litestream beside it, and occasional `pdftoppm` / `tesseract` for a textless OGE 278-T (`app/Dockerfile`) |
| `sqlite-web` | `congress-sqlite-web` | 512m | 0.5 | Python `sqlite-web` against the same database file.  `restart: on-failure:3`.  The compose comment marks it non-critical |
| `scan-cpu-worker` | `congress-scan-cpu-worker` | 1g | 2.0 | Python poll plus `pdftoppm` and Tesseract.  `render_pdf_pages` writes every page at 200 DPI, then the loop reads one page with `cv2.imread` |

`docs/audits/2026-08-17-backend-durability.md` recorded the SQLite file at about 1.88 GB.  That size is historical.  Pages the container reads from the `/data/congress-trade` bind mount are charged to `memory.current`.

`scripts/ops/ct-deploy-overlap.sh` also starts a short-lived `congress-hold` with `--memory` defaulting to `1g` (`HOLD_MEMORY`).  It is a `docker run` during a deploy, outside the compose file.  This PR does not change that script.

## Proposed limits

These numbers are proposals.  They are not applied.  Apply them only after Jay says yes, and only after the report has been read on the host.

| Service | Proposed limit | Proposed reservation |
|---|---|---|
| `congress-app` | **3g** (unchanged) | **1g** |
| `sqlite-web` | **512m** (unchanged) | **128m** |
| `scan-cpu-worker` | **1g** (unchanged) | **384m** |
| `congress-hold` (not compose) | **1g** (already the default) | **none** (do not add one) |

`congress-app` keeps 3g.  The ceiling already exists to stop a runaway tick or an OCR pass from eating the box.  Raising it on a host that is already deep in swap would give this container more room to push its neighbors into swap.  The 1g reservation is the soft floor for Deno plus Litestream, below the cap, so host pressure reclaims someone else's cache before swapping this process.  If the report shows MEM_USAGE well under 1g and `oom_kill` is 0, a later edit can lower the reservation to 512m.  Do not lower the 3g cap below `memory.current`.

`sqlite-web` keeps 512m and gets a 128m reservation.  The process is one Python interpreter.  A large query should hit the cap rather than pin RAM the app needs.  The service is non-critical.

`scan-cpu-worker` keeps 1g.  The 200 DPI render writes pages to disk and the loop holds one page, so RSS should not grow with the page count of a 20-page House PTR.  The spike is `pdftoppm` plus one page of Tesseract.  1g is the ceiling that replaced the unbounded worker.  The 384m reservation covers the interpreter and one page so that page is not the first thing swapped.  If the report shows `oom_kill` above 0, or a top RSS within about 20% of 1g, the follow-up limit is 1536m and still waits for Jay's yes.  Do not jump past 1536m.

`congress-hold` keeps its 1g cap and gets no reservation.  Two copies of the app exist during the overlap.  A reservation on the hold would pin a second working set for a container that is supposed to exit.

The three reservations add up to 1536m.  That is the protection proposed for these services, not a claim that the host has that much free RAM.  A reservation is best-effort.  If other containers already reserve more than physical RAM, these three will not be protected.  Read the report before adding reservations for containers this repo does not define.

### Swap cap, separate from the limit

Compose sets `mem_limit` and does not set `memswap_limit`.  Whether that leaves swap unlimited, or capped at the same amount as the memory limit, depends on the Docker version on the host.  Do not guess it.  The report's SWAP column is the ground truth.  If SWAP is non-zero for one of these services, a follow-up can set `memswap_limit` equal to `mem_limit`.  That tells Docker the memory-plus-swap total equals the memory limit, so the container gets no extra swap.  A container that is living in swap will be OOM-killed instead of slowing down once that extra swap is removed, so read the report first.  This PR does not set `memswap_limit`.

## How to apply this in Coolify later

Do not apply any of this from this PR.  The order after Jay says yes:

1. On the host, from a checkout of the merged script, run `bash scripts/ops/container-mem-report.sh`.  It needs `python3` and `docker`.  It does not need to be copied to `/usr/local`.  It only reads.
2. Compare CGROUP (`memory.current`) to the proposed limit.  Do not apply a limit below `memory.current`.  MEM_USAGE alone can understate that number because docker stats drops inactive file cache.
3. Put the reservation, and a limit change only where the report says the current ceiling is wrong, in `app/docker-compose.yml` as `mem_reservation` next to the existing `mem_limit`.  Coolify's compose deploy already honours those short-form keys.  Merge that follow-up so Coolify recreates the stack.
4. Run the report again.  MEM_LIMIT should show the configured cap for these services.

A Coolify UI resource-limit field is a second place the same numbers can be typed.  The next deploy rewrites the stack from `app/docker-compose.yml`, so a UI-only value is not the durable source of truth for this app.  This PR sets neither the file nor the UI.

Containers this repo does not define will still show up in the report.  About 20 GB of swap is likely dominated by those.  This proposal does not assign them limits.

## Files changed

- `scripts/ops/container-mem-report.sh` — read-only report
- `scripts/ops/test-container-mem-report.sh` — offline tests with a fake docker and a fake cgroup tree
- this note

`app/docker-compose.yml` is unchanged.  `scripts/ops/box-disk-hygiene.sh` (CT-2471) and the backup scripts (CT-2472) are unchanged.

## Verification

```bash
bash scripts/ops/test-container-mem-report.sh
```

The suite uses a fake `docker` and a fake cgroup v2 tree.  It checks sort order, `none` versus a real limit, swap from `memory.swap.current` rather than the right-hand side of docker stats, OOM counts, restart count, the top five RSS values, skipped RSS, totals, a stats failure, and that a path which walks out of the cgroup root is not read.  It does not start Docker and it does not touch a host.

## Follow-ups

- Run the script on `fleet-hetzner-nbg1` only after Jay says yes.
- A later PR may add `mem_reservation` (and change `mem_limit` only if the report shows `oom_kill` or RSS against the cap).  That PR is what applies the proposal.
- Leave `box-disk-hygiene` and the backup scripts out of that apply.
