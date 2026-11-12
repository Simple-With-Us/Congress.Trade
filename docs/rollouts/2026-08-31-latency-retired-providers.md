# 2026-08-31 — latency_probes stops paging config-retired providers

**Board:** `c3fb117a` (P0, filed 2026-08-23 by CURSOR).  **Branch:** `claude/latency-health-retired-providers`.

## Symptom

UptimeRobot monitor `congress.trade latency probes — all providers`
(`GET /api/health/latency`, id 803702911) paged DOWN continuously for 17 days.
The endpoint returned 503 with:

```
Latency provider(s) gone quiet: quiver (457h), unusual_whales (420h) (silence threshold 48h)
```

## Root cause

`pipelineHealth.ts` built the `latency_probes` check from
`SELECT provider, MAX(last_observed_at) FROM trade_provider_observations GROUP BY provider`
— every provider EVER observed, with no notion of current config.  The owner
dropped the Quiver and Unusual Whales subscriptions in mid-August (planned:
re-subscribe later for a one-month latency comparison), so those providers
stopped producing observations while their historical rows kept aging past the
48h silence threshold.  FMP itself stayed healthy the whole time (dual-key
stable-path rotation, `operationalStatus: running`).  The check's own comment
said "turn the source off if it is intentionally decommissioned", but no off
switch actually influenced the check.

## Fix

- `tradeLatency.ts` exports `expectedLatencyProviderIds(env)`: the requested
  set (`DISCLOSURE_LATENCY_PROVIDERS`, default all four direct providers)
  gated by the watch switch, FMP switches (`FMP_LATENCY_PROBE_ENABLED`,
  `FMP_LATENCY_PATHS`), and — for membership providers UW/Quiver — key
  presence.  FMP is deliberately NOT key-gated: switch on + key missing is a
  misconfiguration that must page.
- `pipelineHealth.ts` marks each observed provider row `expected` /
  `expected=false`; retired rows are named in the detail
  (`retired in config (not paged): …`) but never page.  An expected provider
  with no observation at all pages as `degraded` (`never observed`).  All
  providers retired → `stalled` (turning latency monitoring off entirely stays
  loud).  If the expectation resolver throws, the collector fails open to the
  old always-page behavior.
- Admin `providerStatuses` now shows `off` ("not in
  DISCLOSURE_LATENCY_PROVIDERS") for filtered-out providers instead of
  `error`-by-age.

## Ops

- Infisical (congress-trade prod): set `DISCLOSURE_LATENCY_PROVIDERS=fmp`.
  This also stops the server and Mac scout from burning probe calls against
  the lapsed UW/Quiver keys (the lease planner honors the same variable).
- **Re-enable runbook (when the owner re-subscribes UW + Quiver):** set
  `DISCLOSURE_LATENCY_PROVIDERS=fmp,unusual_whales,quiver` — or delete the
  variable for the default-all set.  Paging coverage resumes automatically;
  expect a short `degraded` window until each provider's first observation
  lands.

## Verification

- `npm run typecheck` clean; 299 test files / 3793 tests pass (5 new
  `latency_probes` cases).
- Post-deploy: `GET https://congress.trade/api/health/latency` returns 200 with
  `retired in config (not paged): quiver, unusual_whales` in the detail, and
  monitor 803702911 flips UP.
