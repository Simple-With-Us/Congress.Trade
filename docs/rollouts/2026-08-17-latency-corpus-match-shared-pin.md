# Latency corpus match + shared-package pin plan

## Summary

Closes the remaining #1523 undercount and records the #1462 vendor-pin decision.

**#1523.** Mode #1 (FMP `firstName`/`lastName`) and the match-clock coverage join
were already on `main`.  The leftover hole was mode #2: congress.trade already
had the trade via seed, competitor backfill, or a historical crawl
(`isLiveRaceImport` false), so no `trade_latency_candidates` row was minted and
the provider observation stayed in `unmatchedProvider` forever.  The owner
wording was "imported by all 3 sources and us."

This change adds a **corpus-hash** coverage pass against the full `transactions`
table.  Exact `lastName_ticker_date_side` hits count as coverage.  They do
**not** mint a live race and do **not** enter Ahead/Behind timing.  Unmatched
splits into `unmatchedProviderCtMissing` (CT never saw it) vs
`unmatchedProviderCtExcluded` (CT has it, excluded from the race).  A parser
that stores empty-filer hashes can no longer publish a usable win/loss claim.

**#1462.** Vendored `@jaywedgeworth22/congress-trading-shared` is already
**v2.5.2** (PR #1769, latest upstream tag).  No vendor rewrite.  Pin plan and
local-vs-shared decisions live in
`app/vendor/congress-trading-shared/VENDOR-PROVENANCE.md`.

## Files changed

- `app/src/ingestion/tradeLatency.ts` — corpus coverage, unmatched split, parser-health gate
- `app/src/ingestion/__tests__/tradeLatency.test.ts` — corpus + parser-health cases
- `app/src/analytics/routes.ts` — public `/latency-summary` v9 fields
- `app/src/shared/companyName.ts` — keep-local note
- `app/vendor/congress-trading-shared/VENDOR-PROVENANCE.md` — pin plan
- `docs/EFFORT-LOG.md` — claim / closeout

## Verification

```bash
cd app && npm run typecheck && npm test
```

Targeted: `npx vitest run src/ingestion/__tests__/tradeLatency.test.ts src/analytics/__tests__/latencySummary.test.ts`

Corpus case: a provider row whose only CT copy is a backfill hash must show
`maturedMatched = 1`, `unmatchedProvider = 0`, `unmatchedProviderCtExcluded = 1`,
and `matched = 0` (no timed race).

## Follow-ups

- Production will pick up corpus matches on the next latency-summary cache
  refresh (5 min) after deploy.  No backfill job and no schema change.
- Next shared bump: copy upstream `src/` when a tag newer than v2.5.2 lands.
  Pin-check stays "matches claimed tag", not "must equal latest".
- Local `normalizeCompanyName` stays until a dedicated display-name fixture
  pass proves shared is a safe replacement.
