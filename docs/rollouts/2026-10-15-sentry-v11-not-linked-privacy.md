# Sentry v11 not-linked privacy controls (CT-2405)

## Summary

Congress.Trade production Sentry now uses explicit v11 `dataCollection` opt-outs (not only `sendDefaultPii: false`), span/metric scrub hooks, and shared identifier redaction for logs/metrics/events.  Apple webhook and delivery console warnings no longer embed subscription or StoreKit transaction ids.

## Files changed

- `app/src/shared/sentryDataCollection.ts` — not-linked `dataCollection` defaults
- `app/src/shared/sentryScrub.ts` — credential + identity scrubbing
- `app/src/shared/sentryRuntime.ts` — init hooks + logger/metric attribute scrub
- `app/src/shared/sentryBrowser.ts` — browser `dataCollection` + scrub callbacks
- `app/src/billing/appleWebhook.ts`, `app/src/delivery/webhook.ts` — operational log text
- `app/src/shared/__tests__/sentryPrivacy.test.ts` — regression fixtures

## Verification

```bash
cd app && npm run typecheck && npm test
```

After deploy, sample a fresh error/log/span in the Sentry project and confirm no email, IP, user/subscription/purchase ids, or request bodies appear.

## Follow-ups

- Live project-side Sentry settings audit before any App Store / privacy-label "not linked" declaration change.
- Browser scrubber is a compact inline twin; consider sharing more logic if the server scrubber grows.
