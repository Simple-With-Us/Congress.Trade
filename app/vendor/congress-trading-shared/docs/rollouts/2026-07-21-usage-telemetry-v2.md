# Usage telemetry contract v2

## Summary

The shared package is now the versioned cross-app authority for Usage Monitor telemetry. V2 has a
single wire envelope, stable producer/event identity, provider-account attribution, declared source
coverage, explicit persistence acknowledgement counts, and typed retry/backoff failures.

## Decisions

- Wire idempotency is SHA-256 over stable `producerId + eventId`; mutable measurement fields are not identity.
- Producers send v2 only, with explicit event IDs. `sendLegacyOutbox` may promote an existing durable
  v1 `idempotencyKey` to `eventId` while old outboxes drain, but requires its `sourceApp` to equal the
  configured producer; it never derives a fresh five-field key and does not dual-write.
- Database models, credential authorization, reconciliation, and money calculations remain owned by
  Usage Monitor and are not part of this package.
- Provider/account/key references are opaque identifiers, never credential values.

## Files

- `src/usageTelemetry.ts`
- `src/__tests__/usageTelemetry.test.ts`
- `package.json`, `package-lock.json`
- `CHANGELOG.md`, `README.md`, `docs/EFFORT-LOG.md`

## Verification

- `npm ci`
- `npm run typecheck`
- `npm test -- --run src/__tests__/usageTelemetry.test.ts` (49 passed)
- Full release gate and clean tokenless Git install remain required before tag creation.

## Follow-ups

Release immutable `v2.0.0`, then update Usage-Monitor, Congress.Trade on Coolify, and
Socratic.Trade to the exact tag and verify their durable-backlog drains.
