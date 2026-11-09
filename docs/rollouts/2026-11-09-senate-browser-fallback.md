# Senate eFD browser fallback and intake heartbeat warning (CT-2465)

## Summary

Senate polling speaks HTTP through the residential proxy, then direct when that proxy never answers.  On 2026-11-09 the proxy gave no answer within 3000ms, the direct path got an Akamai 403, and the Chromium transport from PR #2909 never ran because its flags are off.  This change tries that browser only when `SENATE_EFD_BROWSER_FALLBACK=true`, after a proxy timeout or unreachable error, or after an Akamai edge deny.  The browser uses the proxy when the proxy returned the deny, and goes direct when the proxy never answered.  `SENATE_EFD_BROWSER_FETCH` still means the browser is the only transport.  The winning transport is stored on the senate `source_attempts` row (`transport=http-proxy`, `http-direct`, `browser-proxy`, or `browser-direct`) and the polling health line names it.

The Mac intake heartbeat from PR #2946 (CT-2462) still lives in `senate-intake:last`.  A missing or stale heartbeat is no longer a silent null on `/api/health`.  Inside 6:00 AM to 10:00 PM CT the `senate_intake` check is degraded and says the relay never heartbeated or is stale.  Outside that window a never-seen relay is an explicit quiet note, and a relay that was already stale at 10:00 PM stays a warning overnight.  The review queue returns the same verdict as `senateIntakeHealth` and the pending review line shows it.  The check is degraded rather than stalled, so the public health target stays HTTP 200 and the loud stall sweep does not page a standing never-seen relay.

No production flag is set here.  Enabling the browser in prod stays Jay's call, and the deployment image still needs Playwright and Chromium before a flag can succeed.

## Files changed

- `app/src/ingestion/senateSource.ts` — fallback flag, transport receipt, browser route.
- `app/src/ingestion/watcher.ts` — writes the transport note on a successful senate attempt.
- `app/src/ingestion/senateIntakeStatus.ts` — `evaluateSenateIntakeHealth` on top of the CT-2462 window.
- `app/src/shared/pipelineHealth.ts` — `senate_intake` check and the transport name on `polling_senate`.
- `app/src/admin/routes.ts` and `app/src/ui/client/dashboard.js` — review queue carries and renders the verdict.
- Tests for transport selection and the staleness rule.

## Flags Jay would set

Leave `SENATE_EFD_BROWSER_FETCH` unset unless Chromium should replace HTTP entirely.  To turn the fallback on:

- `SENATE_EFD_BROWSER_FALLBACK=true`
- `SENATE_EFD_HIDE_AUTOMATION=true` (same launch flag as the Mac fetcher)
- `SENATE_EFD_BROWSER_HEADLESS` unset (headless) or `false` (headed; the passes that cleared Akamai were headed)

## Verification

Targeted unit tests for senate source egress, intake status, pipeline health, the review queue, and the watcher receipt.  `npm run typecheck` from `app/`.

## Follow-ups

Playwright and Chromium are not in the Coolify image.  A flag set before that install fails closed and keeps the original HTTP error, including the edge-deny backoff.  The Mac `efd-fetcher` still has to call `POST /api/admin/senate-ptr-intake` before the heartbeat can go fresh.
