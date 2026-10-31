# Trading-Proxy Watchdog

External liveness watchdog for Socratic.Trade, plus the two-leg check of its residential-egress (trading proxy) path through the Mango router.  It lives in this repo because the path serves Congress.Trade's Senate polling as well as Socratic.Trade's provider traffic.

## What it does

`public-liveness-watch.sh` runs every 2 minutes (see `crontab.example`) and:

- Probes `https://socratictrade.com/api/live` and classifies failures before acting.  A site failure (a real non-200 response) counts toward a Coolify restart at the configured threshold.  A destination-transport failure (HTTP 000 while the proxy path is healthy) is tracked separately and never triggers a restart, because a restart cannot fix an unreachable path.  A proxy-path failure is decomposed into hop 1 (the watcher cannot reach the egress proxy) and hop 2 (the proxy answered but its upstream fetch failed), and the failed hop is named in the alert.
- Checks the trading-proxy path in two legs, each with one 10-second-apart retry.  Leg 1 is watcher-to-Coolify (the Coolify API answers).  Leg 2 is Coolify-to-Mango, tested from the Coolify host through the app's `/api/proxy-use` endpoint.  A leg that misses twice is a confirmed failure and writes a one-per-incident alert file.
- On a confirmed trading-proxy failure, `zulip-trading-alert.sh` posts the alert to the Trading and Incident-Response streams, topic `trading-proxy`, tagging the owner and the two trader bots, and deletes the alert file on success.  Dispatch is the runner's step: the watcher only writes the alert file, and whatever schedules the watcher checks for it after each run and invokes the poster.

## Alert identity

Automated alerts post only as the dedicated **Watchdog** bot, a purpose-named system identity created for this watchdog.  They never post under an agent's bot identity: a post under a bot's name must be that system itself speaking.

## Instances

- **VM (primary).**  Restart threshold 5 consecutive site failures.  Probes go through the tailnet-capable egress proxy.
- **Mac (secondary).**  Restart threshold 8, so it only restarts in a longer outage.  Probes direct from the home network, where the Mango is also reachable on its LAN address.

## Setup

1. Copy `watchdog.env.example` to `watchdog.env` in the watchdog root (`scripts/ops/`, the parent of this folder) and fill in the real values.  Host addresses and credential paths live only in that file, never in the committed scripts.
2. Keep credential files mode 600.
3. Schedule `public-liveness-watch.sh` every 2 minutes.

State and logs are written under the watchdog root (`scripts/ops/state/`, `scripts/ops/logs/`) and are not committed.
