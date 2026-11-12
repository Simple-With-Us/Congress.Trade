> **SUPERSEDED 2026-08-08:** the Oracle host is decommissioned. Runners now live on the Hetzner fleet box — see `docs/rollouts/2026-08-08-runners-hetzner-migration.md` for current truth + runbook.

# 2026-08-06 — Second Congress.Trade CI runner

## Summary

Added a second self-hosted GitHub Actions runner for Congress.Trade by
reassigning the idle Socratic.Trade runner on the Oracle host
(`<ORACLE_IP_RETIRED>`).

Context: there was only **one** online `socratic-ci` listener (not two). ST,
Usage-Monitor, and congress-trading-shared workflows already target
`ubuntu-latest` (GitHub-hosted free minutes for public repos), so the
repo-scoped self-hosted listeners for those apps were sitting idle while
private Congress.Trade jobs queued on a single `congress-ci` runner.

## What changed (host ops — no app code)

| Item | Before | After |
|------|--------|-------|
| `oracle-socratic-ci` | online → Socratic.Trade | removed |
| `oracle-congress-ci-2` | — | online → Congress.Trade |
| Dir | `/home/ubuntu/actions-runner-socratic` | same dir, re-registered |
| Labels | `socratic-ci`, … | `self-hosted,Linux,ARM64,congress-ci,oracle-ci` |
| systemd | `…Socratic.Trade.oracle-socratic-ci` | `…Congress.Trade.oracle-congress-ci-2` |

Congress.Trade now has:

- `oracle-congress-ci` (agentId 2016)
- `oracle-congress-ci-2` (agentId 2017)

CT workflows select `["self-hosted", "oracle-ci"]` when the repo is private, so
both runners can take jobs in parallel.

Still present (idle / low-use, public-repo runners): `oracle-usage-ci`,
`oracle-shared-ci`. Safe to repurpose later the same way if CT needs a third
lane.

## Idle resource footprint

Self-hosted Actions runners do **not** burn meaningful CPU when idle. Each
`Runner.Listener` holds roughly **60–105 MB RSS** and **~0% CPU** until a job
arrives; then a `Runner.Worker` process spikes for the job duration and exits.
On this host (23 GiB RAM, ~19 GiB available at check), four idle listeners
together are a few hundred MB — not a constant reservation of the machine’s
capacity.

## Verification

```bash
gh api repos/jaywedgeworth22/Congress.Trade/actions/runners \
  --jq '.runners[] | {name,status,busy,labels:[.labels[].name]}'
# expect both oracle-congress-ci and oracle-congress-ci-2 status=online

ssh ubuntu@<ORACLE_IP_RETIRED> \
  'systemctl is-active actions.runner.jaywedgeworth22-Congress.Trade.oracle-congress-ci{,-2}.service'
```

## Follow-ups

- Optional: repurpose `oracle-shared-ci` / `oracle-usage-ci` the same way if
  parallel CI still queues under load.
- Optional: rename host dir `actions-runner-socratic` → `actions-runner-congress-2`
  for clarity (cosmetic; service already correct).
- Socratic.Trade has no self-hosted runner now; public workflows use
  `ubuntu-latest` and are unaffected.