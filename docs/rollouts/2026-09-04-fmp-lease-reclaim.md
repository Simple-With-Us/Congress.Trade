# FMP lease reclaim after Mac scout retirement

## Summary

PR #2307 deployed (`d4e5cc4a`) but FMP probes still did not run.  Live logs:

```
latency probe: server holds no lane this tick — fmp (handed_off)
```

Three successive server errors (the residential-proxy wrap) set
`needScout=true`.  The Mac latency scout is retired.  `macTenureExhausted`
returns false for a null/non-Mac lease, so the server released the lane
and never took it back.  Observations stayed 42h+ stale.

Fix: if `needScout` is true but no live Mac lease exists (expired, never
acquired, or scout gone), the server reclaims and probes.  A living Mac
inside its tenure window still gets the lane.

## Files

- `app/src/ingestion/scoutHandoff.ts`
- `app/src/ingestion/__tests__/probeLease.test.ts`
- `app/src/ingestion/__tests__/probeWiring.test.ts`

## Verification

- `cd app && npm run typecheck`
- `cd app && npx --no-install vitest run src/ingestion/__tests__/probeLease.test.ts src/ingestion/__tests__/probeWiring.test.ts` (46 passed)
- Live docker logs showed `fmp (handed_off)` on sha `d4e5cc4a`

Board: `d09acd0a`.
