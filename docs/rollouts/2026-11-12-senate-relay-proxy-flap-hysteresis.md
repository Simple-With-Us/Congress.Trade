# Senate residential-proxy flap hysteresis (CT-2498)

## Summary

The Mango residential proxy at `10.99.0.2:8888` can flap for short windows without blocking Senate ingest.  `health_senate_relay` used to mirror every failed tunneled probe tick, which paged on each down/recovery pair.  This change adds in-tick probe retries, consecutive-failure hysteresis before publishing a down probe, outage start/end recording, and a one-shot Senate poll catch-up after recovery.

## Files changed

- `app/src/ingestion/residentialProxyHealth.ts` — probe retries, hysteresis state, outage windows, catch-up KV flag
- `app/src/ingestion/senateSource.ts` — proxy-leg egress retries before direct fallback
- `app/src/ingestion/watcher.ts` — consume catch-up flag for prompt Senate poll
- `app/src/shared/pipelineHealth.ts` — outage-since detail on down checks
- Tests under `app/src/ingestion/__tests__/`

## Verification

```bash
cd app && npm run typecheck && npm test
```

After deploy: induce a sub-threshold proxy flap and confirm `senate_relay` stays `ok` on `/api/health`.  Induce three consecutive probe failures and confirm a single down alert, then a single recovery after the proxy answers again.

## Follow-ups

- None required.  Tune `RESIDENTIAL_PROXY_PROBE_FAILURE_THRESHOLD` in Infisical if Mango flaps need a wider margin.
