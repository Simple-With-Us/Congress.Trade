# 2026-11-12 — OPS-1003 /tmp symdb-pids producer

## Summary

The Oct 26 host sample on fleet-hetzner-nbg1 found hundreds of thousands of zero-byte files under a `symdb-pids` name on the 16 GB `/tmp` tmpfs, growing about 0.6 entries per second.  The producer was not verified on the host.  This note records the repository search.

The only tracer this repo initializes is `npm:dd-trace@6.12.0` (`app/deno.lock`), from `tryInitDdTracer` in `app/src/shared/datadog.ts`.  That function imports the package and calls `tracer.init` with service, env, sample rate, log injection, runtime metrics, and LLM Observability.  It does not set a symbol-database, dynamic-instrumentation, or profiling option.  The published 6.12.0 tarball contains no `symdb` string.  Its defaults are dynamic instrumentation off (`DD_DYNAMIC_INSTRUMENTATION_ENABLED`), profiling off (`DD_PROFILING_ENABLED`), remote configuration on (`DD_REMOTE_CONFIGURATION_ENABLED`), and code origin for spans on.  The `/tmp` writes in that tarball are a mini-agent ready path, CI git cache, and CI visibility cache files, not a `symdb-pids` directory.

`app/docker-compose.yml` mounts `/data/congress-trade` into `congress-app` and does not mount the host `/tmp`.  A tracer inside that container would fill the container filesystem, not the host tmpfs, unless Coolify adds a mount this file does not show.  `services/scan-cpu-worker` has no Datadog dependency.

The exact token `symdb-pids` in current public Datadog code is the Python tracer, not this repo.  `dd-trace-py` `ddtrace/internal/symbol_db/remoteconfig.py` builds `SharedStringFile(f"{os.getppid()}-symdb-pids")`, and `ddtrace/internal/ipc.py` `Path.touch` creates that as a zero-byte file in the process temp directory.  Congress.Trade does not depend on `ddtrace`.  A directory literally named `symdb-pids` full of per-PID files was not found in `dd-trace` 6.12.0 or in this tree.  The Python file name is the closest match, and it is not produced here.  Host install and any live `ls` of `/tmp` stay out of scope until Jay asks.

## Files changed

- `app/src/shared/datadog.ts` and `app/src/shared/datadogRuntime.ts`.  `DD_TRACE_AGENTLESS_GUARDS=true` (also `1`, `on`, `yes`) pins `DD_DYNAMIC_INSTRUMENTATION_ENABLED`, `DD_PROFILING_ENABLED`, and `DD_REMOTE_CONFIGURATION_ENABLED` to `false` before the tracer import, only when no agent host or URL is configured and the operator has not set that switch.  Unset, the guard does nothing, so agentless APM, logs, runtime metrics, and LLM Observability stay as they are.  An explicit value, including one resolved from Infisical and absent from the process environment, is copied onto `process.env` before the tracer import and still wins.
- `scripts/ops/tmpfiles.d/fleet-tmp-hygiene.conf`.  Ages `/tmp/symdb-pids` numeric and `*-symdb-pids` names after 7 days, and `/tmp/ct-coolify-restart.out` after 1 day.  Excludes sockets, lock files, `*.pid`, X11 sockets, systemd private dirs, and `/tmp/ctdb`.  systemd-tmpfiles also skips a path that already holds a BSD flock.  It cannot see file size or a live PID, so a digit-named socket or an unlocked marker for a long-lived PID can still match a removal glob.  `scripts/ops/tmp-hygiene-policy.mjs` is the stricter zero-byte and live-PID rule the tests enforce.  This file is not installed.
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
