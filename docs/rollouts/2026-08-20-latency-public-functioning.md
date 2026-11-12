# Latency comparison: public functioning lanes only

## Summary

Public Filing Latency Comparison cards now use **FinancialModelingPrep.com** as the merged FMP heading (not `FMP`).  Only currently functioning comparisons appear on Delivery, Trends, and the public `/api/analytics/latency-summary` `providers` list.  Functioning means the probe is `running` and the coverage join is not a `contradiction`.  Error, stopped, off, and unknown lanes stay off the public grid.

Admin still shows every merged lane and marks each **Shown Publicly** or **Hidden From Public** on the card and in the raw table.

## Files changed

- `app/src/ingestion/tradeLatency.ts` — `PUBLIC_FMP_LATENCY_LABEL`, `isLatencyComparisonPublic`, public totals from visible lanes
- `app/src/analytics/routes.ts` — cache `v9`; public `providers` filtered; `adminProviders` with `publiclyShown`
- `app/src/ui/dashboardHtml.ts` — public paint uses functioning lanes; admin paint adds visibility chips
- tests for the label, filter, and admin markers

## Verification

```bash
cd app && npm run typecheck && npm test
```

Public `/api/analytics/latency-summary` `providers[].label` for the FMP family is `FinancialModelingPrep.com`.  Quiver/UW in `error` appear only under `adminProviders` with `publiclyShown: false`.

## Follow-ups

- iOS reads the same public `providers` list, so it inherits the filter and heading with no client change.
- Renewed Quiver / Unusual Whales credentials will surface those lanes publicly again once `operationalStatus` returns to `running`.
