# SSE live tail by default

## Context & Objective

Premium SSE (`GET /api/stream`) previously treated a missing resume cursor as `since=0`, replaying the entire `transactions` backlog before live events.  Fresh opens (including `streamUrl()` with only `subscription` + `token`) must attach at the durable high-water `cursor_seq` with no history replay, while explicit resume stays gap-free.

## Changes Made

- `app/src/delivery/sse.ts` — live-tail default (`since === undefined` → `MAX(cursor_seq)`); skip initial `drainSseBacklog` when no cursor
- `app/src/delivery/rest.ts` — route / `resolveResumeCursor` contract comments
- `app/src/delivery/__tests__/sse.test.ts` — live-tail default + explicit `?since=0` catch-up tests
- `app/src/delivery/__tests__/resolveResumeCursor.test.ts` — wording only

## Decisions & Trade-offs

A missing cursor attaches at `MAX(cursor_seq)` for live-tail-only delivery.  Explicit `?since=<cursor>` and `Last-Event-ID` resume gap-free catch-up from `transactions`.  Explicit `?since=0` preserves intentional full-history replay under the existing per-tick page cap (`MAX_DRAIN_PAGES_PER_TICK` × `PAGE_SIZE`).  Periodic `SSE_BACKLOG_DRAIN_INTERVAL_MS` safety-net drain unchanged for cross-region gaps.

## Verification State

```bash
cd app && npm run typecheck && npm test -- src/delivery/__tests__/sse.test.ts
```

Build status (Cursor Cloud, 2026-10-05, post-rebase onto `main`): `npm run typecheck` exit 0; `npm test` (full suite) exit 0 (325 files / 4297+ tests); targeted SSE suite 7/7.  `npm run build` not defined for this Deno app (N/A).  `npm run lint` not required for this delivery-only diff.

Manual: open stream URL without `since`; first `event: cursor` should match current feed HWM and no trade events should precede live traffic.

## Next Steps & Blockers

- Publisher merge order: land after #2633 then #2637 (owner).
- Document consumer SDK / delivery UI if any client assumed full replay on first connect.
- Optional: stricter per-connection cap on explicit `?since=0` catch-up (defer — existing paging is sufficient for this fix).

## Zero-Code Findings

No reusable zero-code finding was identified.
