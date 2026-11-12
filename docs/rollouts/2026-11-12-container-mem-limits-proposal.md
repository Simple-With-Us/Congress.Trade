# 2026-11-12 — per-container RAM and swap report, proposed limits (CT-2492)

> **Proposal only.** Nothing in this change is applied on the host, in Coolify, or in `app/docker-compose.yml`.  The report script only reads.

## Summary

The Hetzner host (the request describes 16 cores and about 17 containers under Coolify) has been sitting on about 20 GB of swap.  This change adds a read-only report of every running container's RAM, limit, reservation, swap usage, swap limit, and OOM counters for the **current container instance**, plus a proposal for the memory limit and reservation of each service this repo defines.  The host was not measured from this change, and nothing was installed there.

`docs/rollouts/2026-08-08-runners-hetzner-migration.md` recorded the same box as 8 cores and 15 GiB.  That record is older than the 16-core description in CT-2492.  These proposals do not assume a current RAM total.  They keep the hard ceilings already in compose and add reservations below those ceilings.

## What the report prints

`scripts/ops/container-mem-report.sh` lists each running container, sorted by memory usage, with a totals line.  `--json` prints one object instead of the table.

```bash
bash scripts/ops/container-mem-report.sh
bash scripts/ops/container-mem-report.sh --json
```

It calls `docker stats --no-stream` and `docker inspect` with a fixed format that asks only for id, name, image, `HostConfig.Memory`, `HostConfig.MemoryReservation`, `HostConfig.MemorySwap`, restart count, pid, and status.  Swap **usage** comes from cgroup v2 `memory.swap.current`.  Swap **limit** comes from `memory.swap.max` when present, otherwise from `HostConfig.MemorySwap` (`none` when that value is `-1`).  `oom` and `oom_kill` come from `memory.events` for the **current instance only**; Docker restart recreates the cgroup and resets both counters to zero.  Treat a non-zero `restart_count` together with MEM_USAGE near MEM_LIMIT as the signal that the last instance may have been OOM-killed, not `oom_kill` alone after a restart.  The cgroup column is `memory.current`, which includes file cache.  Reservation is `memory.low` when present, otherwise `HostConfig.MemoryReservation`.  The limit is `memory.max` when that file is a positive number; when `memory.max` is `max`, the report uses the inspect memory value; `none` only when both say there is no cap.  Top RSS is the five highest `VmRSS` values among pids in `cgroup.procs`.  Above 250 pids that scan is skipped.  smem is not used.  Any other docker subcommand is refused.

On Linux, docker stats subtracts inactive file cache, so MEM_USAGE can sit well below CGROUP.  The kernel enforces `memory.max` against `memory.current`.  SWAP `n/a` means cgroup v2 swap accounting is unavailable for that container (for example `swapaccount=0` on the host), not “zero swap in use”.  When **every** row shows SWAP `n/a`, do not use that column for swap decisions; use SWAP_LIMIT, host-level swap metrics, or `memory.swap.max` presence instead.

## Services this repo defines

The Coolify stack is `app/docker-compose.yml`.  Three long-running services are capped on 2026-08-12 after `scan-cpu-worker` ran with no limit.  The compose header says those ceilings are roughly 2–3× the working peak they were meant to bound, and that Coolify's compose deploy honours the short-form `cpus` / `mem_limit` / `pids_limit` keys.  There is no `mem_reservation` on any service.  This PR does not change those lines.

The same host also runs **repo-owned Coolify CI runners** documented in `docs/rollouts/2026-07-18-coolify-only-actions.md`: `congress-ci` and `congress-deploy`.  They are not in `app/docker-compose.yml` but they **do** show up in the report.  Read their rows in the follow-up; do not dismiss them as “out of scope” when swap on the box is high.

| Service | Container | Current `mem_limit` | CPUs | What it runs |
|---|---|---|---|---|
| `congress-app` | `congress-app` | 3g | 2.0 | Deno on port 5000, minute ticks (`CT_TICK_DEADLINE_MS=120000`), Litestream beside it, and occasional `pdftoppm` / `tesseract` for a textless OGE 278-T (`app/Dockerfile`) |
| `sqlite-web` | `congress-sqlite-web` | 512m | 0.5 | Python `sqlite-web` against the same database file.  **Not started by the current Coolify deploy** (only `congress-app` and `scan-cpu-worker` are built and started).  Still defined in compose; a full `docker compose up` could bring it back |
| `scan-cpu-worker` | `congress-scan-cpu-worker` | 1g | 2.0 | Python poll plus `pdftoppm` and Tesseract.  `render_pdf_pages` writes every page at 200 DPI, then the loop reads one page with `cv2.imread` |
| `congress-ci` | (Coolify runner) | (set in Coolify) | — | GitHub Actions jobs for this repo on the shared box |
| `congress-deploy` | (Coolify runner) | (set in Coolify) | — | Deploy automation for this repo |

`docs/audits/2026-08-17-backend-durability.md` recorded the SQLite file at about 1.88 GB.  That size is historical.  Pages the container reads from the `/data/congress-trade` bind mount are charged to `memory.current`.

`scripts/ops/ct-deploy-overlap.sh` also starts a short-lived `congress-hold` with `--memory` defaulting to `1g` (`HOLD_MEMORY`).  It is a `docker run` during a deploy, outside the compose file.  This PR does not change that script.

## Proposed limits

These numbers are proposals.  They are not applied.  Apply them only after Jay says yes, and only after the report has been read on the host.

| Service | Proposed limit | Proposed reservation | Notes |
|---|---|---|---|
| `congress-app` | **3g** (unchanged) | **1g** | Deployed |
| `sqlite-web` | **512m** (unchanged) | **128m** (only if service is running) | **Not deployed today**; reservation is documentation for a future full compose up, not part of live protection totals |
| `scan-cpu-worker` | **1g** (unchanged) | **384m** | Deployed |
| `congress-hold` (not compose) | **1g** (already the default) | **none** (do not add one) | Short-lived deploy overlap |

`congress-app` keeps 3g.  The ceiling already exists to stop a runaway tick or an OCR pass from eating the box.  Raising it on a host that is already deep in swap would give this container more room to push its neighbors into swap.  The 1g reservation is the soft floor for Deno plus Litestream, below the cap, so host pressure reclaims someone else's cache before swapping this process.  If the report shows MEM_USAGE well under 1g, `oom_kill` is 0 for the current instance, and `restart_count` is stable, a later edit can lower the reservation to 512m.  Do not lower the 3g cap below `memory.current`.

`sqlite-web` keeps 512m and would get 128m **when** it is running again.  Today the Coolify start command does not launch it, so do not count 128m toward “protected RAM on the host” until a deploy actually starts the container.

`scan-cpu-worker` keeps 1g.  The 200 DPI render writes pages to disk and the loop holds one page, so RSS should not grow with the page count of a 20-page House PTR.  The spike is `pdftoppm` plus one page of Tesseract.  1g is the ceiling that replaced the unbounded worker.  The 384m reservation covers the interpreter and one page so that page is not the first thing swapped.  If the report shows MEM_USAGE within about 20% of 1g and `restart_count` increased without a deploy, treat that as pressure against the cap and consider a follow-up limit of 1536m, still waiting for Jay's yes.  Do not jump past 1536m.

`congress-hold` keeps its 1g cap and gets no reservation.  Two copies of the app exist during the overlap.  A reservation on the hold would pin a second working set for a container that is supposed to exit.

**Live deployed reservations** (congress-app 1g + scan-cpu-worker 384m) total **1408m**, not 1536m, because sqlite-web is not running.  A reservation is best-effort.  If other containers already reserve more than physical RAM, these floors will not be protected.  Read the report before adding reservations for containers this repo does not define.

### fleet-coding-memory owns `memory.low` today

`fleet-coding-memory.service` on `fleet-hetzner-nbg1` already writes cgroup v2 `memory.low` for production containers with finite hard limits.  Docker `mem_reservation` maps to the same control.  An outside edit while the controller is active is refused and counted as a control write failure (Fleet-OPS `docs/CODING-MEMORY.md`).  **Do not** add compose `mem_reservation` in parallel with the controller.  Set soft floors in Infisical Fleet-OPS prod `/coding-memory` (`CODING_RAM_POLICY`), or suspend the controller deliberately before a compose-led reservation deploy.  This proposal documents target floors for Jay's review; it does not choose between those two apply paths.

### Swap cap, separate from the limit

Compose sets `mem_limit` and does not set `memswap_limit`.  Whether that leaves swap unlimited, or capped at the same amount as the memory limit, depends on the Docker version on the host.  Use the report's **SWAP_LIMIT** column (and `memory.swap.max` / inspect), not SWAP usage alone.  SWAP shows current swap-in for the cgroup when accounting works; zero swap with a finite SWAP_LIMIT still means headroom exists.  If SWAP usage is non-zero for a deployed service, a follow-up can set `memswap_limit` equal to `mem_limit`.  That tells Docker the memory-plus-swap total equals the memory limit, so the container gets no extra swap.  A container that is living in swap will be OOM-killed instead of slowing down once that extra swap is removed, so read the report first.  This PR does not set `memswap_limit`.

## How to apply this in Coolify later

Do not apply any of this from this PR.  The order after Jay says yes:

1. On the host, from a checkout of the merged script, run `bash scripts/ops/container-mem-report.sh`.  It needs `python3` and `docker`.  It does not need to be copied to `/usr/local`.  It only reads.
2. Compare CGROUP (`memory.current`) to the proposed limit.  Do not apply a limit below `memory.current`.  MEM_USAGE alone can understate that number because docker stats drops inactive file cache.
3. Coordinate `memory.low` with `fleet-coding-memory` (policy in Infisical, or controller suspended) before typing compose `mem_reservation`.  Put reservation, and a limit change only where the report says the current ceiling is wrong, in `app/docker-compose.yml` as `mem_reservation` next to the existing `mem_limit`.  Coolify's compose deploy already honours those short-form keys.  Merge that follow-up so Coolify recreates the stack.
4. Run the report again.  MEM_RESERV should match the applied reservation for deployed services.  MEM_LIMIT should still show the configured cap (unchanged in this proposal).

A Coolify UI resource-limit field is a second place the same numbers can be typed.  The next deploy rewrites the stack from `app/docker-compose.yml`, so a UI-only value is not the durable source of truth for this app.  This PR sets neither the file nor the UI.

## Files changed

- `scripts/ops/container-mem-report.sh` — read-only report
- `scripts/ops/test-container-mem-report.sh` — offline tests with a fake docker and a fake cgroup tree
- this note

`app/docker-compose.yml` is unchanged.  `scripts/ops/box-disk-hygiene.sh` (CT-2471) and the backup scripts (CT-2472) are unchanged.

## Verification

```bash
bash scripts/ops/test-container-mem-report.sh
```

The suite uses a fake `docker` and a fake cgroup v2 tree.  It checks sort order, `none` versus a real limit, inspect fallback when `memory.max` is `max`, reservation and swap limit columns, swap from `memory.swap.current`, OOM counts, restart count, the top five RSS values, skipped RSS, totals, a stats failure, and that a path which walks out of the cgroup root is not read.  It does not start Docker and it does not touch a host.

## Follow-ups

- Run the script on `fleet-hetzner-nbg1` only after Jay says yes.
- A later PR may add reservations through `fleet-coding-memory` policy and/or compose (and change `mem_limit` only if the report shows pressure against the cap).  That PR is what applies the proposal.
- Leave `box-disk-hygiene` and the backup scripts out of that apply.
