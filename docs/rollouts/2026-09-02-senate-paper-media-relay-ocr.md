# 2026-09-02 Rollout: Senate Paper Media Relay OCR & DLQ Healing

## Summary

- Fixed root cause of 82 dead-lettered Senate paper PTRs (`senatePaperMedia: OpenRouter HTTP 400 {"error":{"message":"Provider returned error","code":400,"metadata":{"raw":"{\"code\":\"invalid_image\",\"error\":\"Downloaded response does not contain a valid JPG, PNG, WebP, or ICO image.\"}","provider_name":"xAI"}}`).
- Root cause: `scout/senate-relay.ts` rejected `https://efd-media-public.senate.gov` media requests with HTTP 400, and `app/src/extraction/senatePaperMedia.ts` only attempted proxy fetching without falling back to `SENATE_RELAY_URL`. When fetching failed, passing raw URLs to OpenRouter failed because Senate eFD blocks datacenter egress from OpenRouter/xAI.
- Solution:
  1. Updated `scout/senate-relay.ts` to allow `https://efd-media-public.senate.gov` on `POST /fetch-doc` and recognize image magic bytes in `isWallBytes`. Deployed to live `pm2 senate-relay` on Mac.
  2. Updated `app/src/extraction/senatePaperMedia.ts` to use `SENATE_RELAY_URL` (`POST /fetch-doc` with `SENATE_RELAY_SECRET`) and residential proxy to convert media scans into inline base64 `data:image/gif;base64,...` URLs before sending to vision LLMs.
  3. Added error guards and tests to ensure unreachable scans fail with clear telemetry instead of sending unreadable external URLs to OpenRouter.

## Files Changed

- `scout/senate-relay.ts`
- `app/src/extraction/senatePaperMedia.ts`
- `app/src/extraction/__tests__/senatePaperMedia.test.ts`
- `docs/rollouts/2026-09-02-senate-paper-media-relay-ocr.md`
- `docs/EFFORT-LOG.md`

## Verification

- `npm run typecheck` clean.
- `npm test` passed 301 files / 3,827 tests.
- Live `/fetch-doc` test on `scout.jays.services/fetch-doc` returning HTTP 200 with 244KB GIF bytes.
