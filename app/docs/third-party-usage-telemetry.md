# Third-party usage telemetry

Congress.Trade reports every app-owned third-party HTTP attempt to
`usage.jays.services`. Deployed Worker calls use
`src/shared/thirdPartyTelemetry.ts`; operator-side Node maintenance uses
`scripts/usage-telemetry.mjs`. Both paths include successful calls, non-2xx
responses, and thrown network errors as actual request attempts.

## Delivery and identity

- `trackedFetch` emits one actual `request` usage event after each network
  attempt. It records only the allowlisted provider, stable service/operation,
  model (when known), status, success, rate-limit flag, error class, and latency.
- Events are handed to `INGEST_QUEUE`. The queue consumer sends them with an
  explicit idempotency key through the shared Usage Monitor client. Normal queue
  retries preserve that key; the ingest DLQ continues delivery with its larger
  retry budget. If Queue hand-off fails, or receiver delivery is about to retry,
  the same event is also stored under `_ops/usage-telemetry/` in the existing R2
  bucket. A bounded scheduled drain deletes the fallback object only after the
  receiver accepts it; duplicate Queue/R2 delivery is safe because the
  idempotency key is unchanged.
- `USAGE_MONITOR_INGEST_URL` and `USAGE_MONITOR_INGEST_TOKEN` are resolved from
  Infisical/env. Credentials imply enabled; only an explicit false/off value in
  `USAGE_MONITOR_ENABLED` disables delivery. The URL may be either the service
  origin or the legacy full `/api/ingest/usage` endpoint; both are normalized to
  exactly one canonical ingest path.
- Provider-reported tokens, OCR pages, credits, and calculated costs use
  `recordMeasuredThirdPartyUsage` in addition to the request-attempt event. A
  missing provider quantity or price remains unknown; it is never converted to
  zero. Cache-read tokens, five-minute cache-write tokens, one-hour cache-write
  tokens, and the effective service tier are retained as pricing provenance;
  token quantity remains prompt plus completion exactly once, so cache subsets
  are not double counted.
- Finished Anthropic, OpenAI, and xAI batch results retain reported input,
  output, and cached tokens; Mistral results retain reported pages. OpenAI
  terminal batches decode both successful-request output files and
  errored-request files, including completed batches with only errors or no
  files. When OpenAI reports complete batch-level input/output totals,
  `/batch-status` stores them in `batch_jobs.result_summary` and emits one
  stable job-level token event instead of duplicating per-result tokens; absent,
  partial, or invalid aggregates fall back to the per-result accounting path.
  OpenAI result JSONL is parsed strictly, and every returned identifier must
  exactly match the submitted job document set before result persistence or
  measured-unit emission. Malformed terminal JSONL and invalid, duplicate, or
  unknown result identities durably fail the app job with a bounded safe
  summary; transport and HTTP retrieval failures remain retryable. Missing
  provider results still close the immutable terminal job and remain visible
  as bounded summary errors and counts. Before measured units are emitted, the
  job compare-and-swaps a durable aggregate-vs-per-result token accounting plan
  into `result_summary`; retries reuse the winning mode and aggregate totals so
  the two idempotency-key families cannot both be emitted. New submissions carry
  an accounting-protocol marker. An unversioned job may already have emitted
  either the older index-keyed events or the newer document-keyed events, and
  the database cannot prove which family won. Its measured per-result units are
  therefore not re-emitted; the safe result summary records them as
  `suppressed_unknown` instead of risking duplicate billing. Pre-protocol
  random-id rows are reused. Batch extraction-run rows otherwise use deterministic
  job/document ids with `INSERT OR IGNORE`, making terminal status replay and
  concurrent polling row-idempotent. A CAS-fenced terminal decision is stored
  before outcome-specific side effects; only that exact winner can finalize,
  and the same winner can resume after a transient failure. Trustworthy aggregate
  usage and lifecycle timestamps survive malformed/invalid document payload
  settlement, and a measured event that cannot reach either Queue or R2 leaves
  the job retryable.
  Completed result files exposed by failed, expired, cancelled, or timed-out
  OpenAI and Mistral jobs are also decoded instead of discarded. xAI batch
  results retain exact `cost_in_usd_ticks` and server-side attachment-search
  counts. Per-result units survive parse or overall-job failures, are stored in
  `extraction_runs.usage_json`, and use stable idempotency keys so a status retry
  cannot double count them.

## Covered outbound surfaces

| Surface | Providers / targets |
| --- | --- |
| Model extraction and batch APIs | Gemini, OpenAI, Anthropic, Mistral, xAI, LlamaParse |
| Filing discovery and download | House Clerk, Senate eFD, OGE, configured filing sources, seed datasets |
| Disclosure-latency feeds | FMP, Unusual Whales, Quiver Quant |
| Market data and enrichment | FMP, Massive, Finnhub, Twelve Data, Intrinio, Tiingo, SEC EDGAR |
| Authentication, billing, email, secrets, observability | Google OAuth, Cloudflare Access JWKS, Stripe, Resend, Infisical, Sentry envelopes |
| Delivery and peer integration | subscriber webhooks, Cloudflare DNS validation, peer-app import |
| UI assets | Logo.dev and the GitHub ticker-logo fallback |

Configured subscriber, peer, filing, seed, and Infisical destinations use fixed
provider categories (`webhook`, `peer-app`, `filing-source`, `seed-source`,
`infisical`). Their hostnames are never emitted. Static tests reject any new raw
deployed Worker `fetch`/`fetchImpl` call under `src/` outside the tracked
transport, and inventory operator-side `.mjs` requests under `scripts/`.

## Deliberate non-recursive boundaries

- The Usage Monitor ingest request itself is not metered; doing so would create
  an infinite telemetry loop.
- Infisical calls made *only while delivering telemetry* are suppressed. Normal
  application Infisical reads/writes are tracked. This suppression prevents an
  Infisical cache miss or outage from recursively creating more telemetry work
  across isolates.
- Sentry's SDK-owned transport is routed through its supported custom-fetch
  hook and metered as `sentry / observability / send-envelope`. Usage Monitor
  delivery failures deliberately skip Sentry capture, and Sentry telemetry
  hand-off failures do not log. Request and scheduled tracing retain the
  configured sample rate, while queue transaction tracing is always disabled;
  explicit non-telemetry queue exceptions still generate metered Sentry
  envelopes. This prevents envelope-to-queue recursion during normal delivery
  and cross-service outages.
- Host SQLite, Deno KV, in-process `deno_runtime_queue`, and R2 S3 calls are
  not third-party HTTP product APIs.  R2 usage still appears in the Cloudflare
  account metrics for that bucket.
- A simultaneous Queue-send and R2-write failure is the remaining terminal
  producer gap. It emits one structured, secret-safe `usage telemetry durability
  exhausted` error (suppressed for Sentry's own transport) and returns `false`.
  No new infrastructure binding is required for the normal fallback path.
- Browser dashboard calls are same-origin calls back to Congress.Trade, not
  third-party usage. External links are navigation, not server-side tool calls.
- Operator-side maintenance programs are not bundled into the Coolify app and
  have no in-process queue / R2 bindings.  `scripts/seed_securities.mjs`
  therefore uses the fail-closed `scripts/usage-telemetry.mjs` transport: its
  environment must receive `USAGE_MONITOR_INGEST_URL` and
  `USAGE_MONITOR_INGEST_TOKEN` (normally through the approved secret runner)
  before it makes the SEC request.

`src/shared/__tests__/thirdPartyTelemetry.test.ts` enforces the inventory,
receiver-compatible event shape, secret redaction, host classification, and
non-recursive delivery boundary.
