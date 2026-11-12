# 2026-08-19 — OGE executive uses the House/Senate adaptive probe schedule

## Summary

Do not ship a flat 15-minute OGE timer.  Executive discovery now uses the
same `probeSchedule` / `decideSourcePoll` path as House and Senate:
faster only if measured arrival windows exist, slower overnight and on
weekends.

There is **no measured OGE arrival-hour sample in-repo**.  This change
does not invent peak weights.  The executive profile is one flat weekday
window at a conservative **15-minute coverage floor** (never 6 hours)
and a **60s politeness floor**.  Weekend stays hourly like House.

`pollOgeExecutive` is enablement-only.  Cadence lives in `runWatcher` via
`decideSourcePoll({ source: 'executive' })`.  Failure handling matches
House/Senate (`last_attempt` skip).  The skip wait is
`max(600, intervalSec)` so a weekday failure waits the current 15-minute
success interval, not a shorter 10-minute backoff, and never retries
every minute.

Fetch order (2026-08-20): **server-first** for OGE and House — direct
host, then Mac/scout relay if direct fails.  Senate eFD stays
**relay-first** because Imperva 403s the box datacenter IP.  The server
can fetch OGE without the Mac.

`OGE_POLL_INTERVAL_SEC` is **unused**.  Adaptive schedule is the
authority.  Leftover Infisical `OGE_POLL_INTERVAL_SEC=21600` must not
silently re-impose 6h (it is not a max-interval override — using 21600
that way would restore the old gate).

House and Senate shipped schedules are unchanged.

Supersedes the same-day flat 15-minute default in
`2026-08-19-oge-poll-15m.md` / PR #2024.

## Files changed

- `app/src/ingestion/probeSchedule.ts` — `executive` profile + per-source floors
- `app/src/ingestion/watcher.ts` — `decideSourcePoll` accepts `executive`
- `app/src/ingestion/ogeSource.ts` — no live interval gate; server-first fetch
- `app/src/ingestion/houseSource.ts` — server-first bulk index (not Mac-only)
- `app/src/ingestion/senateSource.ts` — stays relay-first (Imperva exception)
- `app/src/shared/types.ts` — `OGE_POLL_INTERVAL_SEC` marked unused
- `app/docs/probe-schedule.md`, `app/docs/config-registry.md`, `app/.dev.vars.example`

## Verification

```bash
cd app
npm run typecheck
npx vitest run src/ingestion/__tests__/ogeSource.test.ts \
  src/ingestion/__tests__/probeSchedule.test.ts \
  src/ingestion/__tests__/probeWiring.test.ts \
  src/ingestion/__tests__/watcher.test.ts \
  src/admin/__tests__/sourceHealth.test.ts
npm test
```

## Follow-ups

- Measure real OGE 278-T arrival hours before adding peak/high/mid tiers.
- Infisical `OGE_POLL_INTERVAL_SEC=21600` can be deleted; it is unused.
  Do not set it to 900 as a live gate.
