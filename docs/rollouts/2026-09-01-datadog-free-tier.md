# 2026-09-01 — Datadog Free-tier hygiene (Grok, `grok/datadog-free-tier`)

- `dispatchWebhook: transaction not found` is `console.debug`, not `console.warn`.  That miss path was ~2.3k Datadog warn events/hour.  Console hooks only ship warn/error.
- `DD_ENV=prod` (Coolify / handoff) canonicalizes to `production` so dashboards stop splitting.
- LLM Observability on OpenRouter / vision HTTP via `trackedFetch` (`ml_app=congress-trade`, 1,200 spans/day cap, no prompt contents).
