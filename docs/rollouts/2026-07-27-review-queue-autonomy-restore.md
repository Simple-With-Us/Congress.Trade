# Review Queue autonomy restore (Deno tick + Infisical flag)

> **Current shape (2026-08):** Deno Deploy and Turso are retired.  Production
> is Coolify Deno-in-Docker + local SQLite.  This note is the 2026-07
> Deploy-era autonomy restore.

## Summary

Production review-queue autonomy had been dead since the Deno Deploy migration
and a subsequent free-tier cost cut:

1. **Infisical prod** had `AGREEMENT_AUTOPUBLISH_ENABLED=false`, so both the
   per-tick agreement backstop and backlog autopilot self-gated off.
2. **Deno `runScheduledTick`** never called `maybeRunAgreementAutopublish` or
   `maybeStartBacklogAutopilot` — those lanes lived only on the retired Workers
   `scheduled` handler in `index.ts`.
3. An **unacknowledged autopilot halt** from 2026-07-21 (OpenRouter 401
   "User not found") would have blocked new autopilot runs even after re-enable.
4. Vision extractors **cap confidence at 0.6** while `CONFIDENCE_THRESHOLD` is
   **0.95**, so nearly every vision filing lands in `review_queue`. Agreement
   cascade is the only autonomous publish path for those docs — disabling it
   parked the entire backlog.

Ops actions already applied in this incident:

- Set `AGREEMENT_AUTOPUBLISH_ENABLED=true` in Infisical prod.
- Created `AUTOPILOT_ENABLED=true` and `AUTOPILOT_LEGACY_REPLAY_ENABLED=true`.
- Acknowledged halted autopilot run `b704be2b-6370-41a2-aed8-9ecd2d000715`.

Code changes:

- Wire secrets refresh + agreement autopublish + backlog autopilot into
  `runScheduledTick` **before** the idle short-circuit / drain so newly
  enqueued `agreement.check` / `autopilot.tick` messages are drained in the
  same tick.
- Prefer those message types over `usage.telemetry` when claiming from
  `deno_runtime_queue` (free-tier drain is only 3 msgs / 5 min).

## Files changed

- `app/src/deno/scheduledTick.ts`
- `app/src/deno/durableQueue.ts`
- `app/src/deno/__tests__/scheduledTick.test.ts`
- `app/src/deno/__tests__/durableQueue.test.ts`
- `docs/EFFORT-LOG.md`

## Verification

```bash
cd app
npm run typecheck
npx vitest run src/deno/__tests__/scheduledTick.test.ts src/deno/__tests__/durableQueue.test.ts
```

After deploy:

- `GET /api/admin/autopilot/status` → `enabled: true`, no unacknowledged halt.
- `POST /api/admin/runtime-tick` → response includes `agreementAutopublish` /
  `autopilot` fields; subsequent ticks enqueue `agreement.check` rows.
- Turso: `agreement_attempted_at` advances past 2026-07-21; unresolved count
  declines as cascade publishes soft `low_confidence` filings.

## Follow-ups

- Drain / rate-limit the ~1.4k pending `usage.telemetry` ingest rows so they
  stop competing with filing work on the free drain budget.
- Delivery outbox still has tens of thousands pending — separate ops lane.
- Historical (pre-2025) review backlog can ride the restored autonomous path
  under `AGREEMENT_DAILY_LLM_BUDGET` / autopilot USD budget; prefer current-era
  docs first (already the selector default).
