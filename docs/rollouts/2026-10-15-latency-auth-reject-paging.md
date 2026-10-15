# 2026-10-15 — latency_probes stops paging on lapsed UW/Quiver keys

**Board:** `ac9fc804ddb64d529cead06bbce98f42` (P2).  **Branch:** `cursor/latency-auth-reject-paging-6835`.

## Symptom

UptimeRobot monitor `congress.trade latency probes — all providers`
(`GET /api/health/latency`, id 803702911) sat DOWN for ~5 days while FMP
stayed healthy.  `/api/health` reported `latency_probes degraded` on Quiver
(~181h) and Unusual Whales (~144h) with live scout logs showing persistent
`HTTP 401` / `HTTP 403` — lapsed or invalid membership keys, not probe
silence.

## Root cause

August's config-retire fix (`expected=false` when filtered out of
`DISCLOSURE_LATENCY_PROVIDERS`) only helps when ops removes a provider from
the probe set or deletes its key.  Production still had UW/Quiver keys present
and configured, so they remained **expected** while auth failures prevented
new observations.  Silence past 48h kept paging `degraded` indefinitely, so
the monitor could not fire again if FMP later went quiet.

## Fix

- `scoutHandoff.ts` — `latencyProvidersWithRejectedCredentials()`: after
  `LATENCY_SCOUT_CONSECUTIVE_ERRORS` (3) successive auth errors (`HTTP_401` /
  `HTTP_403`, including scout log shapes), membership providers are treated as
  credential-latched.
- `tradeLatency.ts` — latched providers are skipped for HTTP probes; FMP
  family unchanged (misconfigured FMP key must still page).
- `pipelineHealth.ts` — latched providers are excluded from paging with detail
  `credentials rejected (not paged): …` (distinct from config retire).

## Ops

- Still recommended: Infisical `DISCLOSURE_LATENCY_PROVIDERS=fmp` when UW/Quiver
  subscriptions are intentionally dropped (stops Mac scout wasted calls too).
- When renewing keys: replace `UNUSUAL_WHALES_API_KEY` / `QUIVER_QUANT_API_KEY`
  in Infisical; one successful probe clears the latch automatically.

## Verification

- `cd app && npm run typecheck && npm test`
- Post-deploy: `GET https://congress.trade/api/health/latency` → 200 with FMP
  live and `credentials rejected (not paged): quiver, unusual_whales` when
  keys are still invalid; monitor 803702911 UP.
