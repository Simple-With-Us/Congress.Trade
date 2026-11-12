# Confirm-then-chunk cannot double-count the same PTR

## Why

Drain follow-up after #2151.  Admin confirmed a truncated 209-row extract for
Ro Khanna `H-2025-8221264` (missing page 24), then the Mac vision worker
published the complete 361-row Gemini chunk as `local_mac`.  Filing detail
still showed both sets: 570 rows, 375 unique keys, 190 exact cross-source
twins.  Public `/api/transactions` twin-dedupes with `primary > local_mac`, so
the truncated confirm won for overlapping trades.

Root causes:

1. `persistNormalizedPublish` exact-set CAS counted every live pipeline source,
   so a later vision set could not retire leftover `primary` rows.  Ingest on
   an already-resolved confirm returned `published: false`.
2. Unpublish / reject / confirm only touched `primary` and `manual`.
3. `GET /filings/:docId` selected every transaction for the doc, including
   `deprecated_at` rows.

## What changed

- Vision publish (`local_mac` / `server_cpu`) deprecates other pipeline sources
  on the same `doc_id` in the same atomic batch, then exact-set CAS runs.
- A resolved truncated confirm can be replaced when the incoming vision set is
  larger and no vision rows are live yet.
- Unpublish / reject retract `local_mac` and `server_cpu` too.
- Confirm's complete-set CAS counts all four pipeline sources, so a short
  confirm cannot land beside a complete vision extract.
- Filing detail hides `deprecated_at`.
- `GET /api/admin/diagnostics/source-overlap` lists same-doc leftover pairs.
- `POST /api/admin/review/:docId/retire-superseded-sources` repairs filings
  that already have both sets live (`H-2025-8221264`).

Not in this slice: analytics-layer competitor_backfill twins (board
`77105be4`); intra-`local_mac` duplicate lines from chunk overlap (0750 13,
1231 18, 1124 37); `H-2025-8220711` / `H-2025-8220192` filing GET 500s.

## Files

- `app/src/extraction/sourceSupersede.ts`
- `app/src/extraction/normalizer.ts`
- `app/src/admin/routes.ts`
- `app/src/delivery/rest.ts`

## Verification

```bash
cd app && npm run typecheck
npx vitest run src/extraction/__tests__/sourceSupersede.test.ts \
  src/extraction/__tests__/normalizer.test.ts \
  src/delivery/__tests__/filingDetailDeprecated.test.ts \
  src/admin/__tests__/reviewQueue.test.ts \
  src/ingestion/__tests__/localVisionWaitState.test.ts
```

Ran 2026-08-21: `deno check` clean; 86/86 focused tests.

Live snapshot before deploy: queue unresolved 0.  House probe 14m, Senate 7m,
Exec 4m.  `H-2025-8221264` 209 primary + 361 local_mac.  Other recent Khanna
PTRs are local_mac-only.

After Coolify is on this SHA:

```bash
# names only — load CT_ADMIN_TOKEN from ~/.secrets, never print it
curl -sS -A "Mozilla/5.0" https://congress.trade/api/admin/diagnostics/source-overlap \
  -H "Authorization: Bearer $CT_ADMIN_TOKEN"
# then POST retire-superseded-sources for each leftover doc with its reviewRevision
curl -sS -A "Mozilla/5.0" https://congress.trade/api/filings/H-2025-8221264 \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d["transactions"]))'
```

Expect 361 live rows on 1264 after retire (or after filing GET filter if those
209 were already deprecated).

## Follow-ups

- Call retire on 1264 once this is live.
- Intra-extract duplicate lines on large attached-schedule PTRs.
- Filing GET 500 on 8220711 / 8220192.
- Overnight House 10-min probe floor still does not fit the 171/day budget.
