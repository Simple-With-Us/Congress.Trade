# Fleet deploy-guard: Coolify deploy endpoint is POST now

## Summary

`GET /api/v1/deploy?uuid=...` now returns HTTP 405 (`This endpoint has changed to a POST request.`).  The fleet deploy-guard still issued GET, so every webhook was cancelled (coalesce) and the replacement never queued.  Congress.Trade sat on `984af2c9` while later main commits never shipped.

## Files changed

- `scripts/ops/fleet-deploy-guard.sh` — POST the deploy endpoint; log the API message on failure
- `scripts/ops/ct-deploy-guard.sh` — same (legacy unit is disabled; keep it in lockstep)

## Verification

- Manual Coolify POST deploy `brwie53o0rubibamsglihvx9` finished; `/api/health` `build.sha` = `7634fe61`
- After host install: `fleet-deploy-guard@congress-trade.timer` active; journal no longer shows `deploy trigger FAILED` on a 405

## Follow-ups

- Confirm Socratic.Trade and Usage-Monitor guards use this same host script (they do: `ExecStart=/usr/local/bin/fleet-deploy-guard.sh %i`)
- Do not re-enable `ct-deploy-guard.timer` (superseded)
