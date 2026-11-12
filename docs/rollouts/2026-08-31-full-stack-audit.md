# 2026-08-31 — CT full-stack audit (web, iOS, backend)

## Summary

Owner asked for a team top-to-bottom audit of web (all sizes), iOS, and backend.  Seven read-only specialist agents plus live probes against `https://congress.trade`.  Report: `docs/audits/2026-08-31-full-stack-audit.md`.  No product-code changes.

Live SHA at probe time: `c2fd4ded`.  Health HTTP 200 with `pipeline.status: degraded` (81 dead-letter outbox items).  Senate relay live.  Zero open product PRs.

## Files changed

- `docs/audits/2026-08-31-full-stack-audit.md` — full findings
- `docs/audits/README.md` — index row
- `docs/EFFORT-LOG.md` — this lane
- `STATUS.md` — handoff stanza
- this rollout

## Verification

- `GET https://congress.trade/api/health` → 200, sha `c2fd4ded`, status degraded, DLQ 81
- `GET /api/health/senate-relay` → 200, scout.jays.services
- `GET /api/transactions?order=desc&limit=3` → ordered by `cursor_seq` (P0 still real)
- `GET /api/analytics/summary` → `resolvedTickerPct` 0.3687 / `resolvedEquityTickerPct` 0.9074
- `POST /api/webhooks/apple` → 400 (mounted; not 404)
- Code: `POST /api/admin/debug-sql` has no prod guard (`app/src/admin/routes.ts` ~9058)

## Follow-ups

Ranked next slices are in the audit.  First: delete or hard-gate `debug-sql`; then public feed sort contract (`#2180`); then Coolify overlap host install.
