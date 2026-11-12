# Fleet deploy-guard: Coolify deploy list is a numeric-key object

## Summary

Coolify `/api/v1/deployments` returns `{"0": row, "1": row, ...}` rather than a JSON array.  The guard parsed that as `.get("data", [])` and saw an empty queue, so it never cancelled duplicates.  Every GitHub webhook plus every API trigger stayed queued; `concurrent_builds=1` only serializes execution.

## Files

- `scripts/ops/fleet-deploy-guard.sh`
- `scripts/ops/ct-deploy-guard.sh`

## Verification

Host tick after the install: `coalescing 2 queued` (congress-trade) and `coalescing 3 queued` (usage-monitor).  Socratic correctly reported `deploy in progress (1)`.
