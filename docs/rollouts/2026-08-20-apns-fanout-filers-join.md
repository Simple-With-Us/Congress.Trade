# 2026-08-20 — APNs fan-out filers join

Claim: `apns-fanout-filers-join`.  Expert review DELIVERYALERTS-02 / finding #3 (P0).  Slice of stale #1046 (that issue still describes a missing APNs path; the path exists and was throwing).

## Summary

`fanOutApnsProductEvents` joined `filers f ON f.id = t.filer_id`.  `filers` has no `id` column (PK is `bioguide_id`).  Every other delivery join already uses `bioguide_id = t.filer_id`.  The instant the query ran against real SQLite it threw `no such column: f.id`, the `apns_fanout` lane never advanced, and no official-trade or review push was sent.

Existing `apnsFanout.test.ts` stubbed `env.DB.prepare`, so CI stayed green.

## Files changed

- `app/src/delivery/apnsFanout.ts` — join is `f.bioguide_id = t.filer_id`; COALESCE(display_name, full_name) unchanged.  Lane errors persist to CONFIG_KV.  Diagnostics inspector probes the real SQL.  Default config comes from `resolveApnsConfig` (Infisical cache, same as the card).  Idle ticks cheap-probe `delivery_outbox` / `review_queue` and skip `APNS_FANOUT_TRADE_SQL` unless events are pending or a lane error is still inside 24h.
- `app/src/delivery/__tests__/apnsFanout.test.ts` — real-SQL test against migrated in-memory SQLite (fails on `f.id`, passes on `bioguide_id`) plus an end-to-end send through the real query.
- `app/src/admin/routes.ts` — `GET /api/admin/diagnostics` connection `delivery:apns` plus `errors[]` rows for query/lane failures.  Card uses `resolveApnsConfig`.  Stored lane errors older than 24h do not set `errorsLast24h` / `error`.
- `app/src/deno/scheduledTick.ts` — `apns_fanout` still runs when the idle outbox probe skips flush; the expensive trade scan is gated inside fan-out.

## Verification

```bash
cd app && npm run typecheck && npm test
```

Focused proof: `apnsFanout.test.ts` "throws on f.id and returns COALESCE(display_name, full_name) on bioguide_id".

After deploy, `GET /api/admin/diagnostics` should show `delivery:apns` with `trade query ok` (not `no such column: f.id`).  A throw is visible on that card and in `errors[]` as `subject: apns_fanout`.

## Remaining send blockers (not this PR)

- APNs env missing in prod is an Infisical/runtime issue, not a code fix.  Diagnostics reports whether credentials are present (never values).
- Zero registered `push_devices` → lane returns `skipped: no_devices`.
- Member-name filters (DELIVERYALERTS-06) apply to webhook/SSE `matchesFilters` only.  APNs fans out to every active device and does not use that matcher, so it does not empty product pushes after the join fix.  Follow-up: resolve names to bioguide ids on subscription create.
- Premium entitlement gating (DELIVERYALERTS-04 / BILLING-05) is deliberately not added here; it would hide whether fan-out works.
- Out of scope: webhook/SSE secret display (DELIVERYALERTS-01), quarantine drops, iOS deep-link keys, #1046 rules UI.

No Coolify or TestFlight from this PR.  Server-side only.
