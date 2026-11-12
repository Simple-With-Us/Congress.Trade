# Rollout — Review Fix Batch 1 (2026-07-29, KIMI)

> **Current shape (2026-08):** Deno Deploy and Turso stay retired.  Production
> is Coolify on Hetzner (not the Oracle Docker monolith named in the doc-drift
> follow-up).  See `app/DEPLOY.md`.

## Summary
First landing batch from the six-lane review (`docs/reviews/2026-07-28-full-app-review.md`).
Merged via PR #1126; deployed by the Deploy Oracle Monolith workflow (Docker on
oracle-ci — Deno Deploy and Turso are retired; ship.sh / deploy-deno.yml are legacy).

## Files changed
- `app/scripts/hoard_{unusual_whales,quiver_quant}.ts` — hardcoded provider keys removed; resolved via Infisical (`UNUSUAL_WHALES_API_KEY` / `QUIVER_QUANT_API_KEY`). **Provider-side rotation still required** (keys remain in git history).
- `app/.env.prod` untracked (full prod Infisical export incl. `ADMIN_TOKEN`, committed in `f34d824`) — **recommend rotating its contents**. `app/prod.env` deleted; `.gitignore` covers `*.env` / `.env.prod` / `prod.env`.
- `app/src/deno/scheduledTick.ts` — Deno cron now runs `parked_deliveries`, `usage_telemetry`, `disclosure_latency` (missed-filing watchdog) lanes.
- `app/src/queueHandlers.ts` — single source of truth for queue handlers (`index.ts` re-exports). Delivery DLQs reconnect the outbox (bounded backoff) instead of abandoning webhooks; ingest DLQs reconnect instead of throwing.
- `app/src/deno/durableQueue.ts` + `app/migrations/0064_*.sql` — `DURABLE_QUEUE_MAX_DEAD_LETTER_CYCLES=8` cap on DLQ recovery loops; new `dead_letter_cycles` column, mirrored in the admin migrate list.
- `app/src/ui/dashboardHtml.ts` — filing PDF links fixed (`/api/client/v1/documents/...` → `/api/documents/...`; 404 since Jul 24).
- `.github/workflows/deploy-deno.yml` — honors `vars.CT_COST_PROFILE` (legacy path; repo var set to `paid`). `sentry-ci-report.yml` watches real workflow names.

## Verification
- Gates: `deno check` + 1910 vitest tests green; PR checks (typecheck+test, gitleaks) green.
- Deploy: Oracle Monolith run 30484319980 success; `POST /api/admin/migrate` applied 0064 (second run shows it skipped as already-applied); `/api/health` ok/db/schema true, costProfile `paid`.
- Live check: congress.trade dashboard HTML has 0 occurrences of the bad `client/v1/documents` path, 3 of the corrected `/api/documents/` path.

## Follow-ups
- Rotate the two provider keys + the `.env.prod` contents (owner action at providers/Infisical).
- Doc drift: AGENTS.md still describes Deno Deploy + Turso as the current shape and `ship.sh` as the deploy path — update to the Oracle Docker monolith in batch 2.
- Batch 2 candidates: LLM temperature fixes, watcher write amplification, iOS async-command polling (Premium delivery secret), `ingest_status` short-circuits, drain priority.
