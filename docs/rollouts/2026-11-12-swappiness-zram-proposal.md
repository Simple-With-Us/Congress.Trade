# 2026-11-12 — swappiness and zram proposal (CT-2514)

> **Proposal only.** Nothing in this note is applied on the host.  This change does not write sysctl, install zram, or restart a service.  The report script only reads.

## Summary

CT-2514 asks for a read-only picture of swap on the Coolify host and a written proposal for swappiness and zram.  The picture is `scripts/ops/host-swap-report.sh`.  The proposal is this note.  Neither one changes the box.

The host is the Hetzner machine that runs Coolify.  `docs/rollouts/2026-07-18-coolify-only-actions.md` records a 4 GiB swapfile and swappiness 10 after a reboot on a host that had no swap.  That record is older than the Hetzner move.  Do not treat 4 GiB or swappiness 10 as the live setting.  Read the report.

## What the report prints

```bash
bash scripts/ops/host-swap-report.sh
bash scripts/ops/host-swap-report.sh --json
bash scripts/ops/host-swap-report.sh --window 60 --top 10 --out-dir /tmp/host-swap
```

The default window is 60 seconds.  `--out-dir` writes `report.md` and `report.json`.  `--json` prints one object.

Swap total, free, and used come from `/proc/meminfo`.  `vm.swappiness` and `vm.vfs_cache_pressure` come from `/proc/sys/vm`.  Swap devices, including a future zram device, come from `/proc/swaps`.  Swap-in and swap-out rates come from `pswpin` and `pswpout` in `/proc/vmstat`, sampled at the start and end of the window.  The rate is pages per second and KiB per second.  `pgpgin` and `pgpgout` are not swap and are ignored.  A counter that goes backwards is reported as a reset and that rate is omitted.

Per-process swap is `VmSwap` in `/proc/<pid>/status`, highest first.  Per-container totals sum those pages for every pid, not only the top N.  The container name comes from `docker ps --no-trunc`.  The pid is tied to a container when its cgroup path contains `docker-<id>` or `/docker/<id>`.  Swap that does not match a running container is unattributed.  The only docker subcommand is that `ps`.  The script does not write sysctl and does not restart anything.

## Proposal

Do not apply any of this until Jay says yes, and only after the report has been read on the host.  One knob at a time.  A second change in the same edit makes the next report impossible to read.

Leave `vm.swappiness` at the value the report prints, unless that report says otherwise.  Do not raise it.  A higher value swaps anonymous memory to keep file cache.  Deno ticks and SQLite then get slower while available RAM can still look fine.  Kernels since 5.8 accept values up to 200.  Those are more aggressive.  Do not use them on this box.

Do not drop swappiness to 0 in the same change as anything else.  The 2026-07-18 reboot happened on a host with no swap.  A very low swappiness makes the OOM killer more likely when the working set exceeds RAM.  That takes every Coolify app on the box down, not only Congress.Trade.

Leave `vm.vfs_cache_pressure` at the value the report prints.  Stock is 100.  0 stops reclaim of dentries and inodes and can OOM the box.  Raising it drops that cache sooner and adds disk reads.  Do not change it in the same edit as swappiness.

zram is a compressed swap device in RAM, placed in front of the disk swapfile.  The disk swapfile stays.  Removing it recreates the no-swap failure from 2026-07-18.  If Jay later says yes, the starting size is one quarter of `MemTotal` from the report, with lz4 or zstd, and a priority higher than the disk swapfile.  Ubuntu can do that with `zram-tools` or `systemd-zram-generator`.  This PR installs neither, and it does not add a unit or a sysctl file.

Do not raise swappiness because a zram guide says to use 100.  That also pushes pages onto the disk swapfile once zram fills, and it changes what the next report means.  Keep the live swappiness until a later report shows whether zram is the device that is actually used.

### How to read the report before any change

High swap used with swap-in and swap-out near zero means the pages are cold.  A swappiness edit will not bring them back.  `swapoff` would, and it can stall the host for a long time.  That is not proposed.

High swap-in and swap-out across the whole window means the box is thrashing.  zram can cut the disk latency of that paging.  The durable fix is less memory demand or more RAM.  Raising swappiness makes the thrash worse.

High swap-in while `MemAvailable` is also high means file cache is winning over anonymous pages.  That is the case where a lower swappiness is the relevant proposal.  Confirm it with the report.  Do not guess it from this note.

## Risks

- Swappiness and cache pressure are host-wide.  Every container on the box inherits them, including apps this repo does not run.
- Pages that are already in swap stay there until they fault back in.  The report's used-swap number will not fall just because swappiness changed.
- `swapoff` to rearrange devices or to install zram can stall the host.  Do not run it as part of reading this note.
- zram burns CPU while it compresses.  OCR, image builds, and deploys already compete for that CPU.
- zram is still RAM.  A poor compression ratio shrinks the working set and can increase pressure.
- A zram device plus a disk swapfile hides exhaustion until both are full.
- Setting `vfs_cache_pressure` to 0 can pin dentries and inodes until the OOM killer runs.
- Raising swappiness above the live value trades tick latency for cache.  The minute health check and a deploy overlap are the paths that feel it.

## Files changed

- `scripts/ops/host-swap-report.sh` reads the host and prints markdown or JSON
- `scripts/ops/test-host-swap-report.sh` and `scripts/ops/fixtures/host-swap/` exercise it from fixture `/proc` files
- this note

Nothing is installed under `/usr/local` or `/etc`.  No systemd unit is added.  No sysctl file is added.

## Verification

Offline, from a checkout:

```bash
bash -n scripts/ops/host-swap-report.sh
bash scripts/ops/test-host-swap-report.sh
```

On the host, later, and only as a read:

```bash
bash scripts/ops/host-swap-report.sh --window 60
bash scripts/ops/host-swap-report.sh --json
```

Confirm the process did not write sysctl and did not restart a container.  This PR does not run those commands.

## Follow-ups

- Apply a swappiness or zram change only after Jay says yes and the report has been read.
- Re-run the report after any later change and compare swap devices, not only the combined total.
- A timer is out of scope.  This script stays on demand.
