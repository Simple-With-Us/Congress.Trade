# 2026-08-20 — In-app account deletion (LEGALCOMPLIANCE-01)

## Summary

Signed-in users can delete their account in the iOS Account sheet and the
website account menu.  The backend deletes the session, push devices, delivery
subscriptions, and PII so App Review Guideline 5.1.1(v) and Privacy §6 are
honoured.

## Files changed

- `app/src/auth/deleteAccount.ts` — shared delete/anonymize helper
- `app/src/client/commands.ts` — `delete_account` command
- `app/src/auth/routes.ts` — `POST /auth/account/delete`
- `app/src/auth/session.ts` — per-user session index so all tokens revoke
- iOS Account / Settings: **Delete Account** confirm, then local sign-out
- Web account menu uses the same auth route
- `docs/app-store/review-notes-1.0.txt` — in-app path, not email-only
- Privacy §6 names the in-app Delete Account control

## Verification

- `cd app && npm test` — 262 files / 3214 tests
- `npm run typecheck` still reports pre-existing Deno `Buffer` / `cf` errors outside this slice
- Delete-path tests: command, `POST /auth/account/delete`, SQLite row removal
- iOS `testDeleteAccountCommandPayload` (hourly TestFlight; this seat does not ship TF)

## Follow-ups

- Operator DSR: identity-check the signed-in email or `support@congress.trade`
  request; 30-day SLA.  This path is the automated in-app fulfilment.
- Apple IAP remains cancelled by the user in the App Store.  Stripe is
  detached without a refund.
- Do not ship TestFlight from this change; the hourly iOS ship picks it up.
