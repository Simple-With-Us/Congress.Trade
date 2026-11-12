# 2026-08-25 — Auto-close provider-missing review stubs (#2221)

## Intent

FMP / Unusual Whales / Quiver can surface a House or Senate trade before
Clerk or eFD discovery persists the official filing.  The July 22 safety net
opens a synthetic `provider-missing-*` review row so the observation is not
lost.  Lesson B6 asked for a later auto-attach.  #2221 implements the live
observation half only: when the official `S-` / `H-` filing is already
`persisted`, the next provider pass **rejects the stub as a duplicate**.  It
does not confirm the stub, attach its txs to the official row, or sweep the
historic queue.

Creation path: `docs/rollouts/2026-07-22-provider-gap-review-routing.md`.

## When a stub closes

Trigger is `routeProviderOnlyObservationsToReview` in
`app/src/ingestion/tradeLatency.ts`.  House and Senate rows only.  Executive
observations are skipped.

On each unmatched provider row:

1. Build stub id `provider-missing-{provider}-{chamber}-{sanitizedKey}`
   (`providerKey` stripped to `[a-z0-9_-]`, max 80 chars).
2. Look for a **persisted** official counterpart.  If found, reject any
   **open** review row for that stub and skip creating a new one.
3. If any non-stub official filing exists (any `ingest_status`), skip
   creating a new stub.  An in-pipeline official (`classified`,
   `extracted`, …) leaves an existing stub **pending**.
4. If the stub filing already exists, or a `trade_latency_candidates` row is
   already `matched` for that provider key, skip.

Official match order (`app/src/ingestion/providerMissingStubClose.ts`):

| Order | Match | Example |
|---|---|---|
| 1 | Exact `filings.source_url` on a non-stub row | Senate PTR view URL |
| 2 | Senate `doc_id = S-{providerKey.lower}` | `S-51455bcd-4966-4e77-b481-09897ada81ae` |
| 3 | House `doc_id = H-{key}` or `H-%-{key}` | `H-2025-8221264` |

`providerKey` is lowercased before the `S-` / `H-` lookup.

## What reject writes

Only an **unresolved** `review_queue` row is mutated (`resolved = 0` and
matching `review_revision`).  Already-resolved stubs are left alone.

| Table | Effect |
|---|---|
| `review_queue` | `resolved=1`, `resolution_kind='rejected'`, reason `rejected: duplicate — official filing {officialDocId} already persisted` |
| `filings` | stub `ingest_status='error'` |
| `transactions` | pipeline-source stub txs get `deprecated_at` + the same reason |
| `ingestion_decisions` | `action=rejected`, `actor=pipeline:provider-missing-stub-close` |

A failed audit insert is logged (`provider-missing-stub-close: audit receipt failed`) and does not roll back the reject.

## Constraints operators hit

- **No historic sweep.**  A stub that never sees another provider
  observation stays pending until a human resolves it.
- **Persisted-only close.**  Official in `needs_review` / `extracted` /
  `classified` does not auto-reject.  The stub waits.
- **No publish / merge.**  Stub txs are not copied onto the official
  filing.  Official txs already on the persisted row stay.
- **No filed_date invention.**  Quiver / frontier stubs remain honest
  NULLs on Clerk-absent ids (`docs/rollouts/2026-08-17-house-fd-zip-1577.md`).
- **Idempotent.**  A later pass that finds the same persisted official
  skips create (`closeResult.officialDocId` is set even when the review
  row was already resolved).

## Operator checks

Open stubs that should have closed after the official published usually
mean the provider key / URL did not match, or the official is not
`persisted` yet.

```sql
-- Open provider-missing reviews
SELECT rq.doc_id, rq.reason, rq.created_at, f.ingest_status, f.source_url
  FROM review_queue rq
  JOIN filings f ON f.doc_id = rq.doc_id
 WHERE rq.resolved = 0
   AND rq.doc_id LIKE 'provider-missing-%';

-- Recent auto-closes
SELECT doc_id, reason, created_at
  FROM ingestion_decisions
 WHERE actor = 'pipeline:provider-missing-stub-close'
 ORDER BY created_at DESC
 LIMIT 20;
```

Do **not** bulk-confirm leftover `provider-missing-*` rows.  Confirm
publishes a synthetic filing.  Reject as duplicate, or wait for the
official persist + next provider pass.

## Tests

`app/src/ingestion/__tests__/providerMissingStubClose.test.ts`

- Senate official found by `S-{providerKey}`.
- In-pipeline official (`classified`) is not a persisted counterpart.
- Open stub rejects; official txs stay; stub gets no txs.
- Stub stays pending when official is only `extracted`.

## Files (product, #2221)

- `app/src/ingestion/providerMissingStubClose.ts`
- `app/src/ingestion/tradeLatency.ts` (`routeProviderOnlyObservationsToReview`)
- `app/src/ingestion/__tests__/providerMissingStubClose.test.ts`

## Follow-ups (still open)

- Historic backlog sweep for stubs whose provider feed went quiet.
- Auto-merge / attach provider payload onto the official filing (B6
  remainder).  Live path only drops the stub.
- Executive chamber is out of scope.
