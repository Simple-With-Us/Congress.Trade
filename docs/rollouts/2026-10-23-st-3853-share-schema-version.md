# 2026-10-23 — Share payload `schemaVersion` (ST-3853)

Seat: GB-COMPILER.  Branch `gb-compiler/st-3853-share-schema-version`.  Linear: ST-3853 (Socratic-Trade origin `app-b`).

## Summary

The vendored `congress-trading-shared` package was bumped to `v2.9.0` (upstream commit `72febd0475f16de125f1cba93cda9bc09d686862`), which adds an optional `schemaVersion` to `SharePayloadSchema` and exports `SharePayloadSchemaVersionSchema`, `SHARE_PAYLOAD_SCHEMA_VERSION` (= 1), `SHARE_PAYLOAD_LEGACY_SCHEMA_VERSION`, `resolveSharePayloadSchemaVersion` and `isSupportedSharePayloadSchemaVersion`.

Socratic-Trade already stamps `schemaVersion: 1` on its POST to our inbound route, but CT was reading the payload without ever looking at the field, so a peer that moved ahead of us was invisible.  The inbound route `POST /api/admin/securities/import` now resolves the payload's contract version, warns when the version is unsupported or malformed, and echoes the resolved version back in the response body.

The version is never a rejection reason.  Mixed deploys have to keep importing, so an unknown or malformed version is reported and logged, and the batch is still processed.  Status codes, error paths, and the persisted receipt shape are unchanged; the only response change is the added `schemaVersion` field.

## Files changed

- `app/src/share/importReceipt.ts`: added the exported helper `resolvePeerImportSchemaVersion(raw, ctx)`, next to `warnPeerImportSchemaDrops`.  It resolves an absent field to the legacy version, validates a present field with `SharePayloadSchemaVersionSchema`, and warns via `sentryLoggerWarn` with `peer.import.unsupported_schema_version` or `peer.import.malformed_schema_version`.  It never throws and never logs the raw value, only its type.
- `app/src/admin/routes.ts`: the `/securities/import` route calls the helper right after `originTag` is computed and adds `schemaVersion` to the success JSON response.
- `app/src/share/__tests__/importSchemaVersion.test.ts`: new unit tests for the helper, covering absent, supported, unsupported, and malformed versions.
- `app/src/admin/__tests__/securitiesImportReceipt.test.ts`: new route tests proving an unsupported `schemaVersion: 99` still returns HTTP 200 and that a payload without the field resolves to version 1.
- `app/vendor/congress-trading-shared/VENDOR-PROVENANCE.md`: release, commit, and import date moved to `v2.9.0`, with the drift-patch regeneration and the `schemaVersion` addition recorded.
- `docs/rollouts/2026-10-23-st-3853-share-schema-version.md`: this record.

## Verification

- `cd app && npm run typecheck` — passes (`deno check src/deno/main.ts`).
- `cd app && npm test` — the full vitest suite passes, including the new helper tests and the route tests.
- `cd app && npx vitest run src/share/__tests__/importSchemaVersion.test.ts src/admin/__tests__/securitiesImportReceipt.test.ts` — 2 files, 14 tests, all passing.
- `node scripts/check-shared-package-pin.mjs` from the repo root — passes: the provenance file parses, the vendored `package.json` version matches the claimed release, and the Deno import maps still point at the vendored `src/index.ts`.

There is no `npm run build` script in `app/package.json`, so the rollout does not list one.

## Follow-ups

- Hard-reject unsupported versions only after both apps run `v2.9.0`+; until then the route warns and imports.
- Usage-Monitor still pins `v2.8.1`.
- CT's own outbound peer push in `app/src/share/outbound.ts` does not stamp `schemaVersion` yet.
