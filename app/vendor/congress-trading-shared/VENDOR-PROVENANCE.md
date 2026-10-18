# congress-trading-shared provenance

- Upstream: `https://github.com/Simple-With-Us/congress-trading-shared`
- Immutable release: `v2.8.1`
- Commit: `b733bfdf639688641b9a77f1d8b78024d462b37f`
- Imported: `2026-10-18`
- Imported paths: `src/`, `package.json`, `package-lock.json`, `CHANGELOG.md`, `README.md`, and `LICENSE`
- Local source modifications: none — vendored `src/` is byte-identical to the upstream v2.8.1 tag.  Earlier drift (sub-$1,001 STOCK_ACT_BRACKETS tier, TxType B/S/E coercion, IsoDateTimeSchema, TradeEventRowSchema, AnalystRowSchema.asOfTimestamp) was upstreamed and is covered by APPROVED-DRIFT.patch as a historical record.  New in this bump (v2.7.1 → v2.8.1): the usage telemetry v2 `ai` block (`src/aiUsage.ts`, UM-1592; 2.8.0) and the `buildAiUsage` explicit-`undefined` tokens fix (2.8.1); the `zod` peer/dev range moves to `^4.6.2` (2.8.0).  The `infisicalSettings` module stays vendored for source parity only — the Deno runtime uses `app/src/secrets/infisical.ts`.

Congress.Trade's Deno import map resolves the package to `src/index.ts`.
Upstream dropped the built `dist/` and root compatibility files before v2.8.1;
this bump removes them from the vendor tree accordingly.

## Pin plan (issue #1462)

`shared-package-pin-check.yml` verifies the vendored `src/` matches the
**claimed** tag in `package.json` (`v2.5.2` today).  It does not flag "behind
latest" — a vendor bump is a deliberate act, not an automatic chase.

Current truth vs the 2026-08-06 drift report (vendored v2.0.0 vs shared v2.5.1):

| Shared change | CT status |
|---|---|
| Filing-lag `60d+` boundary (#238) | Adopted.  `analytics/compute.ts` re-exports `LAG_BUCKETS` and day 60 lands in `60d+`. |
| Strict `CongressTradeEvent` / `createCongressEvent` (2.4.0) | Adopted on the money path (`delivery/sse.ts`, `delivery/webhook.ts`). |
| Dual-anchor member performance (#258) | Product impl stays local (`aggregateMemberDualPerformance`).  Shared schema is the wire shape; CT scoring (winsorize, size-weight, Top Performers formula) is app-specific. |
| Usage telemetry v2 + Retry-After + producer/provider enums | Adopted (`shared/thirdPartyTelemetry.ts`). |
| `normalizeCompanyName` (#222) | **Keep local** `app/src/shared/companyName.ts`.  Shared is a subset; CT also strips exchange parens, "Common Stock", and uses a stricter state-suffix list.  Switching would regress display names. |
| ISO-8601 UTC helpers (#247), Apache 2.0 (#254) | In the vendored tree. |
| Shared CI / Dependabot / effort-log churn | Not CT-relevant. |

Next bump: when shared tags past v2.5.2, copy `src/` + `package.json` +
`CHANGELOG.md` + `LICENSE`, refresh this file, and keep the pin-check as
"matches claimed tag".  Do not promote pin-check to "must equal latest".
