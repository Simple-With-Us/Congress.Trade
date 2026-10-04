# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.7.0] — 2026-09-15

### Added
- `scripts/cloud-setup.sh` (and `.devcontainer/devcontainer.json`) for cold Code Cloud, Codespaces, and throwaway clones — runs `npm ci --include=dev` + `npm run build` idempotently.
- `AGENTS.md` Fleet Recall pointer that requires a corpus search before re-deriving a lesson and a contribution at closeout (app slug: `congress-trading-shared`).
- `normalizeSecurityRef` (`src/client.ts`) now also coerces a producer-supplied `marketCapBucket` to `null` when the string is outside the 6-value mega/large/mid/small/micro/nano enum, and truncates a `currentPriceDate` ISO timestamp down to the `YYYY-MM-DD` segment (or `null`) so a single bad row cannot reject the rest of an enrichment batch.

### Changed
- `CongressTradeClient.createSubscription(clientId, desiredSecret)` — `clientId` is now optional and only added to the POST body when supplied; the field on the wire is left out of legacy authless callers.
- Dev dep `vitest` bumped from `^4.1.11` to `^5.0.0` (paired `@vitest/coverage-v8` `^4.1.10` → `^5.0.0`); `zod` peer/dev dep moves to `^4.6.2`; ancillary bumps for `@types/node`, `publint`, and `anthropics/claude-code-action`.

### Fixed
- `scripts/codex-coordination.sh` — `slack_call` removes its temporary auth config file inside the subshell invocation; `filter_history` now runs Python with `-c` so `sys.stdin` consumes the piped Slack JSON instead of capturing a heredoc.
- `.github/workflows/auto-merge-prs.yml` — never auto-merge public-fork PRs; the workflow stopped dispatching on `pull_request_target`, switches to a same-repo guard, and refuses to arm auto-merge against `GITHUB_TOKEN` (rollout note: `docs/rollouts/2026-09-13-automerge-fork-guard.md`).

## [2.6.0] — 2026-08-23

### Added
- `tickerLogoPolicy`: shared A/B/C/D company-logo source order (GitHub pack vs
  logo.dev, light vs dark) plus the 2026-08-23 Congress.Trade top-30 seed map.
  Apps keep their own serving, disk/KV cache, and admin jury. `sourceOrderFor`
  accepts a fallback so Socratic.Trade can keep GitHub-first for ungraded names.

## [2.5.2] — 2026-08-11

### Changed
- `TxTypeSchema`: accepts `"B"`, `"S"`, `"E"`, and legacy `"P"` (coercing `"P"` to `"B"`).
- `STOCK_ACT_BRACKETS`: includes sub-$1,001 `$0 – $1,000` (`min: 0, max: 1_000`) amount bracket tier.

### Added
- `TransactionsQueryInput` export for query parameters accepting raw letter forms.

## [2.5.1] — 2026-08-04

### Fixed
- Release tag note for dual-anchor performance on mainline.

## [2.5.0] — 2026-08-04

### Added
- `MemberDualPerformanceSchema` / `MemberDualPerformance` for App A dual-anchor
  member skill: `filingDate` (copy-trade since disclosure) + `tradeDate` (politician timing).
- `avgAnnualizedExcess` on `MemberPerformanceSchema` (filing-date leg).
- `getMemberPerformance` returns the full dual envelope (legacy `{ performance }` still accepted).

## [2.3.0] — 2026-07-24

### Added
- Pure date-time helper functions `isIsoDateTime` and `toIsoUtcString` in `src/utils.ts` to normalize Date objects, epoch timestamps, or date strings into canonical ISO 8601 UTC format (`YYYY-MM-DDTHH:mm:ss.SSSZ`).
- Exported `IsoDateTimeSchema` and type `IsoDateTime` in `src/schemas.ts` for strict ISO 8601 UTC date-time string validation.

## [2.2.0] — 2026-07-23

### Added
- Usage Monitor API route constants: `API_USAGE_MONITOR_HEALTH_PATH` (`/api/health`), `API_USAGE_MONITOR_READY_PATH` (`/api/ready`).
- Usage Monitor producer identity enum & schema (`USAGE_TELEMETRY_PRODUCERS`, `UsageTelemetryProducerSchema`, `UsageTelemetryProducer`).
- Usage Monitor known provider enum & schema (`USAGE_TELEMETRY_KNOWN_PROVIDERS`, `UsageTelemetryKnownProviderSchema`, `UsageTelemetryKnownProvider`).
- Pure helper function `createUsageTelemetryV2Event` for validating and creating strict v2 telemetry events with automatic UUID eventId fallback.

### Changed
- Updated `publint` dependency to `^0.3.22`.

## [2.1.0] — 2026-07-22

### Added
- Added `normalizeCompanyName()` utility with state-suffix stripping.

## [2.0.0] — 2026-07-21

### Changed
- Usage telemetry now sends a versioned v2 envelope with explicit `producerId`, optional
  `producerInstanceId`, and required stable `eventId` values. The canonical persistence identity is
  SHA-256 over `usage-telemetry-v2 + producerId + eventId`; mutable measurement fields never rekey an
  event.
- Successful ingest acknowledgement counts are explicit: `received`, `persisted`, `duplicates`,
  `pruned`, and `rejected`. HTTP failures use a typed error code, retryability flag, and optional
  `retryAfterSeconds`; the client also honors the HTTP `Retry-After` header.
- The wire event adds opaque `producerKeyRef`, `providerConnectionRef`, and `billingAccountRef`
  attribution plus declared coverage scope/mode/overlap/report-through metadata. Secrets remain out
  of the contract.
- `createUsageTelemetryClient.send` accepts only strict v2 events with an explicit `eventId` and no
  legacy `sourceApp`. Existing durable v1 outbox entries may drain only through
  `sendLegacyOutbox`, which requires a stable `idempotencyKey`, verifies `sourceApp` equals the
  configured `producerId`, and promotes that key to v2 `eventId`; there is no dual-write or
  five-field fallback for fresh events.

### Added
- `UsageTelemetryV2BatchSchema`, `UsageTelemetryV2EventSchema`,
  `UsageTelemetryV2IngestAckSchema`, `UsageTelemetryV2ErrorResponseSchema`,
  `deriveUsageTelemetryV2IdempotencyKey`, and `UsageTelemetryApiError`.

## [1.11.1] — 2026-07-20

### Changed
- Moved `zod` from a bundled runtime dependency to a `^4.4.3` peer dependency (and retained it as a
  development dependency), preventing nested/duplicate Zod runtimes at consumer schema boundaries.
- Bumped the package version to 1.11.1 for the immutable release tag.

## [1.11.0] — 2026-07-19

### Added
- `client.ts`: `normalizeSecurityRef(value: unknown): unknown` is now **exported**. It backfills
  producer-omitted `sharesOutstanding` (as `null`) on a raw security-ref payload so it satisfies
  `SecurityRefSchema`. `SecurityRefSchema.sharesOutstanding` is `.nullable()` but **not**
  `.optional()`, so the key must be *present* — `null` is accepted, absent is not — while the live
  Congress.Trade REST producer (`mapSecurityRef`) never emits the field. `CongressTradeClient`
  already applied this internally on every read path (`getRef`/`getRefs`/`getBundle`), but the
  helper was module-private, so consumers calling `SecurityRefSchema.parse(...)` **directly** hit
  `Invalid market ref response` on well-formed producer payloads with no supported workaround.
  No behaviour change to the client — same implementation, same call sites; this is purely
  additive to the public surface. Non-object input (null, arrays, primitives) passes through
  unchanged, and an explicit `sharesOutstanding` value is never overwritten.

### Changed
- `@types/node` re-pinned to `^20.19.9` to match `engines.node` (`>=20.0.0`). The package had been
  compiling against `@types/node` 26.x, type-checking the public surface against APIs absent from
  the oldest supported runtime. A Dependabot `ignore` for `@types/node`
  `version-update:semver-major` now prevents the floor from silently drifting again.
  Development-only; no runtime or consumer-facing effect.

## [1.10.0] — 2026-07-18

### Added
- `callClassifier.ts`: shared call-classifier metadata contract for cross-provider request
  enrichment and telemetry attribution. `CallClassifierContextSchema`/`CallClassifierContext`
  describe a single outbound-call context (`sourceApp`, `environment?`, `service?`, `feature?`,
  `keyRef?`, `gitSha?`, `user?`, `sessionId?`). Two pure builders project it into the shapes
  producers need: `openrouterRequestEnrichment(ctx)` returns fields to merge into an OpenRouter
  completions request body — top-level `user`/`session_id` plus a **flat** `trace` object
  carrying the classifier keys directly (`trace: { sourceApp, environment?, service?, feature?,
  keyRef?, gitSha? }`; per OpenRouter's Broadcast docs `trace` itself is the arbitrary-metadata
  object, so there is no `metadata` sub-object and never a bare top-level `metadata` field) —
  and `telemetryEventClassifier(ctx)` returns the same classifier keys as a flat string map for
  a pushed `UsageTelemetryEvent`'s `metadata` field. `buildCallClassifier(ctx)` returns both
  shapes at once. All three omit undefined optional keys. Static classifier fields (`sourceApp`,
  `environment`, `service`, `feature`, `keyRef`, `gitSha`) throw on an invalid/blank value
  (deploy-time constants — fail fast); the runtime-dynamic `user`/`sessionId` (max 128 chars,
  OpenRouter's documented limit) are instead omitted when blank/whitespace-only so a per-call
  dynamic value can never break a paid LLM request.
- `UsageTelemetryEventSchema`: optional `providerRequestId` (string, max 200) for the
  provider-side call/generation id (e.g. OpenRouter's `id`), enabling monitor-side spend
  verification against the provider's own record.

### Changed
- **Consumer note:** `deriveUsageTelemetryIdempotencyKey`'s basis is unchanged —
  `providerRequestId` is deliberately excluded, matching the existing `project` field's
  precedent. Idempotency keys for existing/replayed events are byte-identical before and after
  this release.

## [1.8.0] — 2026-07-15

### Added
- `executive` value on `ChamberSchema` (and the derived `Chamber` type) for OGE Form 278-T
  presidential/VP filers — the executive-branch analogue of congressional STOCK Act disclosures.
  Every schema that references `ChamberSchema` (`TransactionsQuerySchema`, `ClientMemberSchema`,
  `MemberLeaderSchema`, and the transaction read shapes) now accepts `"executive"`.

### Changed
- **Consumer note:** code with exhaustive `switch`/mapping logic over `Chamber` values must now
  handle `"executive"` in addition to `"house"` and `"senate"`, and API consumers should expect
  `chamber: "executive"` on read-side payloads.

## [1.6.0] — 2026-07-11

### Added
- Runtime validation for every `CongressTradeClient` response, including transactions, market data,
  subscriptions, and analytics endpoints.
- Ticker-scoped insider and short-volume client methods with read-side nullable schemas.
- Input types for telemetry events whose defaulted fields remain optional to callers, plus an opt-in
  guard requiring a caller-supplied idempotency key.

### Changed
- `TransactionsQuery.since` now accepts only the live non-negative cursor contract; calendar bounds
  remain available through `from` and `to`.
- Market, enrichment, analytics, transaction, and telemetry schemas now reflect observed producer
  nullability and additive fields without weakening `SecurityRef` or import/upsert schemas.
- Exported alias maps, bracket definitions, and other readonly constants are frozen at runtime.
- Conditional package exports now pair ESM with `.d.mts` declarations and CJS with `.d.ts`
  declarations; CI validates the packaged surface with `publint` and NodeNext/Bundler fixtures.
- Telemetry accepts `quota_sync` and `credit_balance`, trims bounded identity fields and metadata,
  and parses the server's optional `ignoredPruned` response count.

### Fixed
- Reject inverted, negative, and non-finite STOCK Act ranges instead of snapping them to an unrelated
  canonical bracket.
- Preserve SSE last-event IDs across events; handle BOM and CR/CRLF framing; ignore NUL-containing
  event IDs; bound line/event sizes; and prevent callers from erasing generated event timestamps
  with `undefined`.
- Return `null` for a normal market-ref 404 and reject malformed success payloads instead of exposing
  unchecked values under trusted TypeScript types.
- Restore released-package metadata consistency with version 1.6.0 and the MIT license.

### Security
- Pin third-party GitHub Actions to immutable commit SHAs, remove an unused OIDC permission, verify
  dependency signatures, and make an exact tokenless Git install part of the required CI context.
- Mark the source-only Git package private against accidental registry publication and document its
  required `prepare` lifecycle.

## [1.5.0] — 2026-07-11

### Added
- **Portable operation-guard rejection contract.** Added Zod schemas and pure builder functions (`buildRateLimitedRejection`, `buildOperationInFlightRejection`, `getOperationGuardHttpStatus`) for Socratic.Trade admin abuse controls and future consumers, yielding stable HTTP 429 (`rate_limited`) and HTTP 409 (`operation_in_flight`) responses.

## [1.4.2] — 2026-07-09

> Historical note: 1.4.2 was committed but never tagged. These changes first shipped in `v1.5.0`.

### Added
- Optional `project` field on `UsageTelemetryEventSchema` for per-project attribution
  (excluded from the idempotency basis by design).
- `subscription` value on `UsageTelemetryMetricTypeSchema` so producers can validate
  recurring fixed-cost events the API Usage Monitor already accepts.

## [1.4.1] — 2026-07-06

### Changed
- Upgraded the package's public schema runtime from Zod 3 to Zod 4 and TypeScript from 5.9 to 6.0.
- Renamed remaining Agentic Trading references to Socratic Trade and expanded schema/client tests.
- Upgraded the checkout, setup-node, and setup-python actions.

> Compatibility note: the Zod-major change shipped under a patch version. Consumers may install
> Zod 3 at their root while this package retains its direct Zod 4 dependency; schemas from different
> Zod majors must not be composed or treated as assignable.

## [1.4.0] — 2026-07-06

### Added
- **STOCK Act amount brackets & matching helpers.** Moved `AmountBracket`, `STOCK_ACT_BRACKETS`, `isValidBracket`, and `nearestBracket` from App A into the shared package.
- **Unified ticker normalize regex & helpers.** Moved preferred share ticker spelling normalizers, share-class punctuation variants, placeholders, and issuer-based preferred normalizers into the shared package.
- **CI Test Suite & Coverage Thresholds.** Integrated Vitest into GitHub Actions CI pipeline, enforcing strict code coverage minimum thresholds.
- **CI package smoke job.** Added automated local-tarball verification of CJS and ESM imports. Exact
  tokenless Git-ref installation was added later in 1.6.0.
- **Client Zod schema alignment.** Extended `ClientAssetSchema` to validate optional metadata fields (`companyName`, `logoUrl`, `typeName`, `typeCategory`, `typeCategoryLabel`) and support `manual` source enum value in `ClientTradeSchema`.

## [1.3.3] — 2026-07-06

### Added
- Portable `createCongressEvent` event builder and centralized event types.
- `balance` and `limit` usage-telemetry metric types.

## [1.3.2] — 2026-07-06

### Added
- Scheduled dependency-vulnerability CI and Dependabot configuration.

## [1.3.1] — 2026-07-06

### Added
- `CongressTradeClient`, subscription API path, SSE parser, and ticker normalization helpers.

## [1.3.0] — 2026-07-05

### Added
- **Rename-vs-acquisition classification for ticker aliases.** Split the flat
  `TICKER_ALIASES` map into two semantically distinct classes so consumers can
  distinguish a continuous rename (same listed entity, price series continues)
  from a delisting acquisition (source ticker ceased trading in a takeover):
  - `TICKER_RENAMES` — `FB→META`, `SQ→XYZ`, `GEHCV→GEHC`.
  - `TICKER_ACQUISITIONS` — `BRCM→AVGO`, `TWX→WBD`, `ATVI→MSFT`, `RHT→IBM`.
  - `classifyTickerAlias(ticker, opts?)` → `{ from, to, class } | null`
    (`TickerAliasClass = "rename" | "acquisition"`).
  - `resolveContinuousTicker(ticker, renames?)` — PIT-safe resolution that folds
    only renames and leaves acquisition sources intact, so point-in-time return
    attribution does not roll a delisted position into the acquirer's later
    price series.
- Tests for the two new maps (disjointness + union invariants) and both new
  helpers, including the identity-vs-PIT behavioral contrast.

### Changed
- `TICKER_ALIASES` is now derived as the union of `TICKER_RENAMES` and
  `TICKER_ACQUISITIONS`. **Fully backward compatible** — same 7 entries, same
  mappings, same shape; `resolveTickerAlias` still folds every alias for
  identity/display resolution. No consumer change is required to upgrade.

### Removed
- Dormant `publishConfig.registry` (retired private GitHub Packages registry)
  from `package.json`, and stale `npm run publish:dry` references from
  `README.md` / `AGENTS.md` — the package is tokenless git-install only, and the
  `publish:dry` script was already decommissioned.

## [1.2.0] — 2026-07-04

### Added
- Vitest test suite with 34 tests covering idempotency-key contract vectors,
  determinism, uniqueness, edge cases, and Zod schema validation.
- Zod schemas for 16 previously schema-free types (`TransactionsQuery`,
  `BundleResponse`, `TickerLeader`, `ClusterBuy`, `MemberLeader`,
  `MemberPerformance`, `BacktestHorizon`, `TickerBacktest`, `CommitteeConflict`,
  `SnapshotTableInfo`, `SnapshotManifest`, `ClientMember`, `ClientAsset`,
  `ClientTransaction`, `ClientFiling`, `ClientTrade`).

### Changed
- All types in `types.ts` now derive from Zod schemas via `z.infer`, replacing
  standalone hand-written interfaces that could silently diverge.
- `CongressTransactionSchema.filedDate` is now `.nullable().optional()` to
  match the hand-written type signature (ground truth for consumers).
- Removed duplicated `isIsoDate` implementation in `schemas.ts` — now imports
  from `utils.ts`.
- Consolidated duplicated `APP_B_ORIGIN`/`APP_B_ORIGIN_TAG` constants.
- **Publish policy:** repo is now public and consumed as a tokenless git
  dependency (`github:jaywedgeworth22/congress-trading-shared#semver:^1.2.x`).
  The private GitHub Packages registry is retired.

## [1.1.1] — 2026-07-03

### Fixed
- Idempotency-key hash collision via length-prefixed field encoding in the
  deterministic key derivation.

## [1.1.0] — 2026-07-03

### Added
- Usage telemetry client (`usageTelemetry.ts`) with Zod-based event schemas.
- Deterministic idempotency key attached to outgoing usage telemetry events.
- Idempotency-key basis-string contract documented for server-side consumers.

## [1.0.0] — 2026-06-29

### Added
- Shared TypeScript types, Zod schemas, constants, and pure utilities for
  Congress.Trade ↔ Socratic Trade cross-app integration.
- Package prepared for install via `prepare` build script and CI.
- GitHub Actions CI pipeline (typecheck, build, audit).

[Unreleased]: https://github.com/jaywedgeworth22/congress-trading-shared/compare/v2.6.0...HEAD
[2.6.0]: https://github.com/jaywedgeworth22/congress-trading-shared/compare/v2.5.2...v2.6.0
[2.5.2]: https://github.com/jaywedgeworth22/congress-trading-shared/compare/v2.5.1...v2.5.2
[2.0.0]: https://github.com/jaywedgeworth22/congress-trading-shared/compare/v1.11.1...v2.0.0
[1.11.1]: https://github.com/jaywedgeworth22/congress-trading-shared/compare/v1.11.0...v1.11.1
[1.11.0]: https://github.com/jaywedgeworth22/congress-trading-shared/compare/v1.10.0...v1.11.0
[1.10.0]: https://github.com/jaywedgeworth22/congress-trading-shared/compare/v1.9.0...v1.10.0
[1.8.0]: https://github.com/jaywedgeworth22/congress-trading-shared/compare/v1.7.1...v1.8.0
[1.6.0]: https://github.com/jaywedgeworth22/congress-trading-shared/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/jaywedgeworth22/congress-trading-shared/compare/v1.4.1...v1.5.0
[1.4.2]: https://github.com/jaywedgeworth22/congress-trading-shared/commit/030d87e
[1.4.1]: https://github.com/jaywedgeworth22/congress-trading-shared/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/jaywedgeworth22/congress-trading-shared/compare/v1.3.0...v1.4.0
[1.3.3]: https://github.com/jaywedgeworth22/congress-trading-shared/compare/v1.3.2...v1.3.3
[1.3.2]: https://github.com/jaywedgeworth22/congress-trading-shared/compare/v1.3.1...v1.3.2
[1.3.1]: https://github.com/jaywedgeworth22/congress-trading-shared/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/jaywedgeworth22/congress-trading-shared/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/jaywedgeworth22/congress-trading-shared/releases/tag/v1.2.0
[1.1.1]: https://github.com/jaywedgeworth22/congress-trading-shared/compare/c954921...5b2a6fa
[1.1.0]: https://github.com/jaywedgeworth22/congress-trading-shared/commit/c954921
[1.0.0]: https://github.com/jaywedgeworth22/congress-trading-shared/commit/c34cfae
