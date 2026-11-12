# 2026-11-12 — OPS-1003 /tmp symdb-pids producer

## Summary

The Oct 26 host sample on fleet-hetzner-nbg1 found hundreds of thousands of zero-byte files under a `symdb-pids` name on the 16 GB `/tmp` tmpfs, growing about 0.6 entries per second.  The producer was not verified on the host.  This note records the repository search.

The only tracer this repo initializes is `npm:dd-trace@6.12.0` (`app/deno.lock`), from `tryInitDdTracer` in `app/src/shared/datadog.ts`.  That function imports the package and calls `tracer.init` with service, env, sample rate, log injection, runtime metrics, and LLM Observability.  It does not set a symbol-database, dynamic-instrumentation, or profiling option.  The published 6.12.0 tarball contains no `symdb` string.  Its defaults are dynamic instrumentation off (`DD_DYNAMIC_INSTRUMENTATION_ENABLED`), profiling off (`DD_PROFILING_ENABLED`), remote configuration on (`DD_REMOTE_CONFIGURATION_ENABLED`), and code origin for spans on.  The `/tmp` writes in that tarball are a mini-agent ready path, CI git cache, and CI visibility cache files, not a `symdb-pids` directory.

`app/docker-compose.yml` mounts `/data/congress-trade` into `congress-app` and does not mount the host `/tmp`.  A tracer inside that container would fill the container filesystem, not the host tmpfs, unless Coolify adds a mount this file does not show.  `services/scan-cpu-worker` has no Datadog dependency.

The exact token `symdb-pids` in current public Datadog code is the Python tracer, not this repo.  `dd-trace-py` `ddtrace/internal/symbol_db/remoteconfig.py` builds `SharedStringFile(f"{os.getppid()}-symdb-pids")`, and `ddtrace/internal/ipc.py` `Path.touch` creates that as a zero-byte file in the process temp directory.  Congress.Trade does not depend on `ddtrace`.  A directory literally named `symdb-pids` full of per-PID files was not found in `dd-trace` 6.12.0 or in this tree.  The Python file name is the closest match, and it is not produced here.  Host install and any live `ls` of `/tmp` stay out of scope until Jay asks.

## Recorded samples

The alert is Hetzner tmpalert 635061481.   The Datadog event id is 8871245184941397489.   The alert and host figures below are the Oct 26 2026 point-in-time samples recorded on OPS-1003.  One paragraph records a Nov 1 2026 housekeeper measurement of the same tmpfs and is not part of that sample.  This note did not re-measure either host.   Occupancy in those samples is not a rate.

The alert triggered at 10:58:05 AM CDT.   The event time is 10:57:03.   An earlier 10:38 time in that record was wrong.   The metric value 4,730,002,636.8 B is a change, the 5 minute average against the prior 10 minutes, and it is not total usage.   It recovered at 11:05 AM with a change of 3.296 GB, below the threshold.   That recovery is not a reduction in used space.

At 11:19 there was no active memory pressure or thrash on either machine.   The owner and the growth cause of `/tmp` usage are unresolved.   Causality for the alert is unproved.   The producer of the new files was not verified.   As of the Oct 26 samples there was no settled inode-exhaustion deadline and no cleanup authority.   Related records are OPS-984, the Coolify host root disk, and BF-2544, the BotFleet server on Hetzner.   Earlier versions of the issue overstated pressure and named a Congress cause.   The issue points at its correction comment for that history.

A later housekeeper note, recorded Nov 1 2026 and titled "[AFC, HH, GB-HOUSEKEEPER] Housekeeper Sprint Tmp Inodes SSH Outage Disk Monitors", measured the same host tmpfs at 3.6G of 16G used and inodes at 81 percent, 842k of about 1.05M.  OPS-984 records that tmpfs inode cap as 1,048,576.  The note projected exhaustion around Nov 4-5 at about 56k entries a day, deleted nothing, and left the cleanup waiting on the owner.  That projected date had passed by the date of this note, and this note did not re-measure the host.  The note attributes the new files to Datadog's Python tracer inside root polling loops.  This repository search did not verify that attribution.

On fleet-hetzner-nbg1, the 11:17 to 11:19 samples showed CPU 78 to 82 percent idle, iowait 0 to 1 percent, memory PSI average 0, and 12.9 GB available.   Old swap occupancy of 20.3 GB is not active pressure.   Load was 4.3 on 16 cores.   `/tmp` is a 16 GB tmpfs.   Used space was 9,760,247,808 B and stable from 11:17 to 11:19.   Inodes were 47 percent used.   `ctdb/ct.db/db.sqlite` was 4,113,436,672 B and `db-wal` was 896,680,952 B.   Its ctime is 10:52, which fits the corrected alert window and does not prove it caused the alert.   No open handles were on the ctdb database at the 11:20 fuser/lsof check.   No container mounts ctdb.   The Congress container mounts `/data/congress-trade`, not ctdb.   A newly created `symdb-pids` root held about 144,000 and 307,000 zero-byte files in two counts.   One 10 second sample showed about 0.6 new entries per second.   The pnpm store was 2.2 GB.   The root disk was 77 percent used, with 67 GB free.   All containers were running, and all but one have healthchecks.   That is not proof of app health.

On the Mac at 11:17, load was 7.1, 10.9, and 11 on 10 cores, easing to 6.48 at 11:19.   High CPU was WindowServer, BotFleet, and MiniMax renderers, and it was not tied to the Hetzner alert.   Swap was shrinking, with no active swap-outs, minimal page-outs, and 27 percent memory pressure free.   Swap occupancy of 17.3 GB is not active pressure.   The disk was 90 percent used, with 45 GB free.

## Files changed

- `app/src/shared/datadog.ts` and `app/src/shared/datadogRuntime.ts`.  `DD_TRACE_AGENTLESS_GUARDS=true` (also `1`, `on`, `yes`) pins `DD_DYNAMIC_INSTRUMENTATION_ENABLED`, `DD_PROFILING_ENABLED`, and `DD_REMOTE_CONFIGURATION_ENABLED` to `false` before the tracer import, only when no agent host or URL is configured and the operator has not set that switch.  Unset, the guard does nothing, so agentless APM, logs, runtime metrics, and LLM Observability stay as they are.  An explicit value, including one resolved from Infisical and absent from the process environment, is copied onto `process.env` before the tracer import and still wins.
- `scripts/ops/tmpfiles.d/fleet-tmp-hygiene.conf`.  Ages `/tmp/symdb-pids` numeric and `*-symdb-pids` names after 7 days, and `/tmp/ct-coolify-restart.out` after 1 day.  Seven days is the same window as `MARKER_MAX_AGE_MS`.  systemd-tmpfiles cannot see a live PID, and a flock is its only runtime protection, so a 1-day age would remove an unlocked marker for a process that has been up for a day.  At about 0.6 entries per second that window can hold roughly 360,000 inodes, which is why this file stays uninstalled until Jay decides.  A 1-day age remains the host choice if the tmpfs is still near its inode cap.  Excludes sockets, lock files, `*.pid`, X11 sockets, systemd private dirs, and `/tmp/ctdb`.  systemd-tmpfiles also skips a path that already holds a BSD flock.  It cannot see file size or a live PID, so a digit-named socket or an unlocked marker for a long-lived PID can still match a removal glob.  `scripts/ops/tmp-hygiene-policy.mjs` is the stricter zero-byte and live-PID rule the tests enforce.  This file is not installed.
- `scripts/ops/tmp-hygiene-report.sh`.  Read-only.  Prints filesystem bytes, inodes, a regular-file walk, and the child directories with the most files.  The file count and byte total share one `find` pass.  An unreadable subtree is skipped instead of aborting the report.  The top-directory list is truncated with sed so a long listing does not end the report with a broken pipe.

## Verification

```bash
cd app && npx vitest run src/shared/__tests__/datadogRuntime.test.ts
node --test scripts/ops/tmp-hygiene-report.node-test.mjs
```

Neither command talks to the production host.

## Follow-ups

- Jay decides whether to set `DD_TRACE_AGENTLESS_GUARDS=true` in Coolify or Infisical.  The flag is not on in this change.
- Jay decides whether to install `fleet-tmp-hygiene.conf`.  Do not reinstall the Datadog host agent.
- A live producer check on fleet-hetzner-nbg1 is still required.  This repo cannot prove which process owns the host directory.
