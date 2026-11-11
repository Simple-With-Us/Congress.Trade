# Senate eFD browser fallback and fetcher-run heartbeat warning (CT-2465)

## Summary

Senate polling speaks HTTP through the residential proxy, then direct when that proxy never answers.  On 2026-11-09 the proxy gave no answer within 3000ms, the direct path got an Akamai 403, and the Chromium transport from PR #2909 never ran because its flags are off.  This change tries that browser only when `SENATE_EFD_BROWSER_FALLBACK=true`, after a proxy timeout or unreachable error, or after an Akamai edge deny.  The browser uses the proxy when the proxy returned the deny, and goes direct when the proxy never answered.  `SENATE_EFD_BROWSER_FETCH` still means the browser is the only transport.  The winning transport is stored on the senate `source_attempts` row and the polling health line names it.

Server-side Chromium is experimental and unverified against Akamai from the Hetzner IP.  The browser path that works is the Mac efd-fetcher.  Both flags stay off.  The Coolify image still needs Playwright and Chromium before a flag can succeed, and a missing browser fails closed on the original HTTP error.

The liveness signal is the CT-2462 fetcher-run heartbeat, `senate-fetcher:last-run`, written by `POST /api/admin/senate-fetcher-run` on every completed run.  Deliveries in `senate-intake:last` only exist when a run finds new rows, so a quiet day is not a missed fetcher.  Inside 6:00 AM to 10:00 PM CT a missing or stale run report is a degraded `senate_fetcher` check on `/api/health`.  Overnight a never-reported fetcher is an explicit quiet note, and a run that was already stale at 10:00 PM stays a warning overnight.  A fresh run with zero new rows stays ok.  The check is degraded rather than stalled, so the public health target stays HTTP 200 and the loud stall sweep does not page it.  The review queue already renders the run line from CT-2462.

## Files changed

- `app/src/ingestion/senateSource.ts` — opt-in experimental browser fallback and the transport receipt.
- `app/src/ingestion/watcher.ts` — writes the transport note on a successful senate attempt.
- `app/src/ingestion/senateIntakeStatus.ts` — `evaluateSenateFetcherHealth` on the existing run record.
- `app/src/shared/pipelineHealth.ts` — `senate_fetcher` check and the transport name on `polling_senate`.
- Tests for transport selection and the run-heartbeat staleness rule.

## Flags Jay would set

Leave both flags unset.  They are experimental.  If Jay still wants the server path:

- `SENATE_EFD_BROWSER_FALLBACK=true`
- `SENATE_EFD_HIDE_AUTOMATION=true`
- `SENATE_EFD_BROWSER_HEADLESS` unset (headless) or `false` (headed)
- Leave `SENATE_EFD_BROWSER_FETCH` unset unless Chromium should replace HTTP entirely.

## Verification

Targeted unit tests for senate source egress, fetcher-run health, pipeline health, the review queue, and the watcher receipt.  `deno check src/deno/main.ts` and `npm test` from `app/`.

## Follow-ups

The Mac fetcher is the browser path.  Do not treat a green server-side flag as proof that Akamai accepts Chromium from Hetzner.
