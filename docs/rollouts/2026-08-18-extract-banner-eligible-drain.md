# Extraction nav badges + eligible-due drain (2026-08-18)

## Summary

Public Trends showed a red **Extraction Halted** card while `autopilot_halt` was ok, because `/api/health` review-backlog counts unhid a banner in `<main>` for everyone.  Eligible filings waited for the next UTC day tick or a 150-count threshold.

Owner ruling: the red Extraction Halted card must not show on the public site.  Prefer no incident card at all; put the same info on Admin / Review.

This change:

- Removes `#extractIncidentBanner` from `<main>`.
- Gives admins first-class Review Queue and Admin nav tabs, hidden unless `canUseAdmin()`.
- iOS-style red nav badges: Review Queue = unresolved count; Admin = a real autopilot halt / stalled extract only.  Hidden at 0.
- No halt/Ack Halt banner or button on Trends, nav, or Admin.
- Does not auto-ack or clear the current auth latch.  Does not spendy-resume.  OpenRouter reply-routing is a follow-up, not this PR.
- Starts a run when **one selector-eligible / due-now** doc exists.  Health `eligible` (unresolved + not suppressed + not terminal) is a different, looser count and is not the start gate.
- Classifies attempt-capped `agreement_cascade_unresolved` as health-terminal (honest human review).  Does not enable `AUTOPILOT_LEGACY_REPLAY_ENABLED`.  Does not bulk-confirm.  Does not add a spendy third model.
- Keeps paid `idleShortCircuit` on; the idle probe now sees eligible-due review rows.

## Files changed

- `app/src/ui/dashboardHtml.ts` — no halt/Ack Halt control; nav badges only
- `app/src/extraction/autopilot.ts` — `countEligibleDueDocs` + `eligible` trigger capped at 1 doc
- `app/src/extraction/reviewQueueHealth.ts` — attempt-capped cascade disagreements are health-terminal
- `app/src/deno/scheduledTick.ts` — `eligibleReview` on the idle probe
- Tests next to the dashboard, autopilot, and scheduled-tick suites

## Verification

```bash
cd app && npm run typecheck && npm test
```

After deploy: trial or signed-out on `/?view=trends` must not show a red extract card.  Admins see Review Queue / Admin in the top nav with badges.  No Acknowledge Halt control.  One selector-eligible / due-now House PTR claims on the next minute tick via the cheap-first path already on main (PR 1985).  Health `eligible` is not that gate.

## Follow-ups

- Do not bulk-resolve the remaining suppressed/terminal `review_queue` rows.
- Keepout: `grok/extract-halt-banner` 0.55 deterministic publish bar; extract/#1959 executive scanned_pdf OCR.
- Do not raise the OpenRouter Files daily spend cap.
