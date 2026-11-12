# 2026-08-13 — Senate scout session reuse

## Context & Objective

Owner Pushover at 8:41am CT: senate failed 67 polls over 1878m with
`report/data/` HTTP 503 classified as upstream-maintenance.  Server Senate
ingest via senate-relay was live the whole time.

## Changes Made

The Mac scout re-handshaked GET /search/ + POST /search/home/ on every poll.
Akamai then served the static maintenance HTML.  senate-relay keeps a
long-lived agreement session and returns JSON.

- Cache the scout session like `scout/senate-relay.ts`.
- On report/data failure, refresh the session once and retry.
- Do not retry 503/403/429 against efdsearch.senate.gov (the breaker already backs off).

### Files

- `scout/congress-scout.mjs`
- `STATUS.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-08-13-senate-scout-session.md`

## Decisions & Trade-offs

Did not mute 6h remonitor for `upstream-maintenance`.  That label was wrong
for this incident (session miss, not Senate-wide down).  After session reuse,
a real maintenance window can still remonitor.

## Verification State

Syntax-checked the scout module.  Live Senate ingest was already green on
`/api/health/polling`.  After merge the Mac scout host must pull this file
and reset `scout/scout-state-breakers.json` senate entry (or restart the
scout) so the OPEN breaker stops remonitoring.

## Next Steps & Blockers

- Merge, then pull + restart the Mac scout process.
- Optional later: remonitor only for `blocked`/`throttled`.
