# 2026-07-24 — Owner decisions: Delivery gate, Stripe live, shared pin redesign

> **Current shape (2026-08):** Turso is retired (local SQLite on Coolify /
> Hetzner).  The "Turso efficiency only" line below is the 2026-07 decision,
> not today's database.

## Summary

Jay closed open product decisions for Congress.Trade:

- Analytics stay public/free; only Delivery (webhook and/or SSE) is Premium.
- Delivery requires a signed-in Google account; the Delivery tab stays visible
  when logged out but stays deactivated with clear messaging until sign-in
  (+ Premium to create).
- Wave 4 Stripe paywall is live now for logged-in users using Infisical
  canonical live keys/prices/webhook secret.
- Deno cron owns watcher work; R2 is on the CT-specific Cloudflare account
  (verify via storage-smoke). CONGRESS-TRADE-1 / CONGRESS-TRADE-19 resolved.
- OpenRouter-only for LLM; no direct Mistral; no agent spend outside the app
  without asking first.
- No D1 ever again; #174 is Turso efficiency only (indexes already via #907/#911).
- Shared pin-check (#156): analyze first — old npm-lock comparator was deleted
  in #666; CT vendors `v2.0.0` while ST/Usage-Monitor npm-pin `#v2.0.0`. Redesign
  for vendor provenance before making required.
- #332: TestFlight likely; PWA hosting TBD; spend increases need Jay approval.
- dashboardHtml → PWA migration deferred (Jay prefers website mobile view).

## Files changed

- `app/src/ui/dashboardHtml.ts` — Delivery tab rename + gate UX
- `clients/pwa/app/ui/Dashboard.tsx` — matching Delivery gate
- `app/src/admin/routes.ts` — `executive` allowed on `/api/admin/reprocess`
- `AGENTS.md`, `docs/EFFORT-LOG.md`, `STATUS.md`
- `scripts/check-shared-package-pin.mjs` + `.github/workflows/shared-package-pin-check.yml`

## Verification

- `cd app && npm run typecheck && npm test` (165 / 1865)
- Live: `/api/health` ok; `/billing/status` `checkoutConfigured:true`
- Live: R2 `POST /api/admin/storage-smoke` green (prior session)
- Public analytics: House/Senate txs present; Executive still 0 txs with
  agreement_cascade_unresolved review backlog (spend-gated)

## Follow-ups

- Promote redesigned pin-check to a required branch-protection check after a
  green `main` run (do not restore the deleted npm-only comparator).
- Executive agreement reprocess only after Jay spend approval.
- PWA hosting / TestFlight when Jay reviews.
