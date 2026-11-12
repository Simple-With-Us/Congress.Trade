# OpenRouter reply-routing (2026-08-19)

## Summary

#2002 is live (`e8530122` descends from `85691594`).  Eligible drain hit 0.  A garbage or Unauthorized OpenRouter *reply* was still able to classify as pipeline `auth` / `parse` and latch everyone after two docs.

This change classifies the reply.  Proven dead-key rejections (`invalid_api_key`, `User not found`) stay fail-closed.  Bare `401 Unauthorized`, HTML, letterhead, and empty / non-JSON completions are document-scoped: cheap-retry once on the text path, then skip that doc.  Autopilot does not halt the run.  The existing auth latch is not acked or cleared.

## Files changed

- `app/src/extraction/openRouterReply.ts` — reply classifier
- `app/src/extraction/providerHealth.ts` — OpenRouter `401 Unauthorized` without a proven key death is not `auth`
- `app/src/extraction/openRouterText.ts` — one cheap retry, then skip
- `app/src/extraction/openRouterVision.ts` — skip that doc (no Files retry)
- `app/src/extraction/autopilot.ts` — doc-scoped samples do not trip the kill-switch
- `app/src/extractors/types.ts` — House cheap path rethrows proven key death only

## Verification

```bash
cd app && npm run typecheck && npm test
```

After deploy: two House PTRs that get a bare OpenRouter Unauthorized / HTML completion must not halt autopilot.  `invalid_api_key` / `User not found` still latch.  Typed House forms stay off Files.

## Follow-ups

- Do not raise the $2/day cap.  Do not spendy-resume.  Do not ack/clear the current auth latch.
- Keepout: #1959 executive `scanned_pdf` OCR.  No bulk-resolve.  Web only.
