# 2026-08-08 — CT self-hosted runners now live on the Hetzner fleet box

**The Oracle host (<ORACLE_IP_RETIRED>) is DECOMMISSIONED.** Do not ssh to it, do
not diagnose "the box is down" against it, and treat any doc that names it as
historical. Owner confirmation 2026-08-08: "Oracle isn't being used anymore.
Need to ssh to the Hetzner server."

## Current truth

| Thing | Value |
|---|---|
| Host | `fleet-hetzner-nbg1` — <PROD_ORIGIN_IP> (x86_64, 8 cores, 15 GiB) |
| SSH | `ssh coolify` (alias in ~/.ssh/config; also `host.jays.services`, `fleet-hetzner-nbg1`) |
| Runners | `hetzner-ct-ci-1`, `hetzner-ct-ci-2` — classic tarball installs, NOT docker |
| Dirs | `/opt/actions-runner-ct-{1,2}`, owned by user `ghrunner` |
| systemd | `actions.runner.jaywedgeworth22-Congress.Trade.hetzner-ct-ci-{1,2}.service` |
| Guards | drop-in `limits.conf`: CPUQuota=400%, MemoryMax=5G, Nice=10 (protects Coolify apps) |
| Labels | `self-hosted, congress-ci, oracle-ci, hetzner-ci` (`oracle-ci` kept ONLY so existing `runs-on` selectors keep matching — it is a legacy label name, not a location) |
| Routing switch | repo variable `CT_CI_RUNNER` — set (`congress-ci`) = self-hosted; **cleared = instant GitHub-hosted fallback** for the six var-gated jobs (ci, security, auto-update-prs, effort-issues-sync, shared-package-pin-check, sentry-ci-report) |

## Runbook

- **Runners offline?** `ssh coolify 'systemctl restart actions.runner.jaywedgeworth22-Congress.Trade.hetzner-ct-ci-1.service actions.runner.jaywedgeworth22-Congress.Trade.hetzner-ct-ci-2.service'`
- **Box unreachable?** Clear the repo variable (`gh variable delete CT_CI_RUNNER`) → var-gated jobs run `ubuntu-latest` (private-repo minutes). Box-bound jobs (admin-maintenance, uptime-monitor, deploy-oracle, debug, runner-workerd-diagnostics) stay parked until the box returns — hosted Azure runners get Cloudflare's managed challenge on congress.trade curls, and docker/deploy steps only exist on the box. Restore with `gh variable set CT_CI_RUNNER --body congress-ci`.
- **Re-register from scratch:** mint `gh api -X POST repos/jaywedgeworth22/Congress.Trade/actions/runners/registration-token --jq .token` (expires in 1h, do NOT store), then in a fresh `/opt/actions-runner-ct-N`: `./config.sh --unattended --url https://github.com/jaywedgeworth22/Congress.Trade --token <t> --name hetzner-ct-ci-N --labels congress-ci,oracle-ci,hetzner-ci` as `ghrunner`, then `./svc.sh install ghrunner && ./svc.sh start`. Configured runners persist credentials — they do NOT need a token again on restart/reboot (this is why we use classic installs; the 2026-08-06→08 docker attempt died because an expired registration token was baked into the container env and re-ran config on every start).

## What happened 2026-08-06 → 2026-08-08

The Oracle box was retired; two docker runners (`ct-ci-temp{,-2}`,
myoung34/github-runner) were started on Hetzner as a stopgap but never
registered (expired registration token → 404 loop), so from ~2026-08-08 every
PR check sat queued for ~day. Recovery (MONET): installed the two classic
runners above, fixed the host's `/dev/null` (was chmod 600 since Aug 6 —
broke every non-root redirect on the box), deleted the stale
`oracle-congress-ci{,-2}` registrations, removed the dead containers, and
landed the CT_CI_RUNNER fallback gate + this doc (PR #1520).

## Superseded docs

- `docs/rollouts/2026-08-06-second-congress-ci-runner.md` (Oracle-era)
- `docs/rollouts/2026-07-29-github-hosted-ci-oracle-runners-off.md` (Oracle-era)
