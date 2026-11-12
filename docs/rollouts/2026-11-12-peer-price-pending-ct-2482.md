# Peer-price leftover pending backlog (CT-2482)

## Summary

After EOD rollover, ~485 tickers could plateau in `st_peer_prices` pending: common names were starved by pure oldest-trade ordering while disclosure-only instruments (mutual funds, options) recycled through negative cache. Selection prioritizes oldest `price_checked_at`; unsupported disclosure types mark stage 4 on confirmed-empty ST or a corpus-fresh disclosure sweep.

## Files changed

- `app/src/prices/service.ts` — selection order; empty-response stage 4 from disclosure
- `app/src/prices/peerInstrumentCoverage.ts` — disclosure allowlist and hints
- `app/src/prices/notCovered.ts` — `markDisclosureUnsupportedPeerPrices`
- `app/src/jobs.ts` — disclosure sweep on catch-up and daily refresh
- Tests under `app/src/prices/__tests__/`

## Verification

- `cd app && npm test`
- Pending drain: `st_peer_prices` pending count drops as catch-up runs; not-covered count rises for MF-only tickers without bloating pending

## Follow-ups

- None; stacks on CT-2469 drain-progress work (#3045)
