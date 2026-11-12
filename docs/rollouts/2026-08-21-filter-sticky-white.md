# Web filter chips in the white header, sticky on scroll

## Summary

Owner screenshots (2026-08-21): on the website the filter pills sat on the
cool-grey page (`#eff3f8`) too far under CONGRESS TRADE, and on scroll
pinned on the header/content divider instead of staying in the light
chrome.

`main` padding-top is 0 so Trends/Trades filters sit in the white header
band.  Directory / Delivery / Admin / Review keep their own top pad.
`overflow-x: clip` is no longer on `main` (it computed overflow-y to clip
and ate the white strip).  Sticky `top` is still `--ct-header-h`.
Horizontal inset is `--ct-main-pad` from padding-left.

iOS chrome for the same screenshots landed separately as #2170
(`FeedStickyBar`).  This lane is web only.

## Files

- `app/src/ui/dashboardHtml.ts`
- `app/src/ui/__tests__/dashboardHtml.test.ts`

## Verification

- `cd app && npm run typecheck`
- `cd app && npx vitest run src/ui/__tests__/dashboardHtml.test.ts` (342 passed)
- Full `npm test`: 288 files passed; 3 unrelated files failed once on hook
  timeout under load and passed on rerun

## Follow-ups

- Coolify auto-deploys on merge.  After deploy: scroll Trends on a phone;
  chips stay in the white band under the wordmark.
- Fourth chip still clips on 320px phones (board `f6c39ace`) — not this lane

Board: `ee0a55b3`.
