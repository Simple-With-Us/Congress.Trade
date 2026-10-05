# SSE live tail by default

## Summary

Premium SSE (`GET /api/stream`) used to treat a missing resume cursor as `since=0`, replaying the entire `transactions` backlog before the live tail.  Fresh opens (including `streamUrl()` with only `subscription` + `token`) now start at the durable high-water `cursor_seq` with no history replay.  Gap-free catch-up is unchanged when the client sends `?since=<cursor>` or `Last-Event-ID` (EventSource reconnect).

## Files changed

- `app/src/delivery/sse.ts` — live-tail default, skip initial `drainSseBacklog` when no cursor
- `app/src/delivery/rest.ts` — route / `resolveResumeCursor` contract comments
- `app/src/delivery/__tests__/sse.test.ts` — live-tail + explicit `since=0` tests

## Verification

```bash
cd app && npm run typecheck && npm test -- src/delivery/__tests__/sse.test.ts
```

Manual: open stream URL without `since`; first `event: cursor` should match current feed HWM and no trade events should precede live traffic.

## Follow-ups

- Document in consumer SDK / delivery UI if any client assumed full replay on first connect.
- Optional: cap explicit `since=0` catch-up per connection if operators need a stricter bound (today: `MAX_DRAIN_PAGES_PER_TICK` × page size per drain tick).
