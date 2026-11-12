# 2026-08-11 — iOS App Store 1.0 submitted for review

> **CORRECTION (added on rebase, 2026-08-12):** this doc records the state of the
> submission at the moment it was made, 2026-08-11T17:31Z. It did not hold. Per
> `docs/EFFORT-LOG.md` (2026-08-11 1:05pm CT, CLAUDE), the same build
> **202608101310** was read back from the ASC API roughly half an hour later as
> `INVALID_BINARY` — a second rejection, whose reason Apple sends only by email.
> Treat "WAITING_FOR_REVIEW" below as a submission-time snapshot, not the settled
> outcome. No later entry in the effort log confirms an approval or a
> `READY_FOR_SALE` state for this build; the next agent picking up the iOS
> App Store lane should re-verify current ASC state live before assuming either
> outcome.

## Summary

Congress.Trade iOS version **1.0** was submitted and briefly reported **WAITING_FOR_REVIEW** (see correction above).

- Build **202608101310** attached (VALID, minOS 17.0)
- Export compliance: `usesNonExemptEncryption=false` (standard TLS only)
- Review submission id `dd7eecf3-8952-450a-9c76-6c5c415e4d21` submitted 2026-08-11T17:31:18Z
- Prior empty debris submission reused successfully after version item was already present

## Verification

ASC API: `appStoreVersions` state read WAITING_FOR_REVIEW immediately after submission; build relationship pointed at 202608101310. This did not persist — see correction above.

## Notes

- Subscriptions still report `MISSING_METADATA` — Apple API rejects `subscription` on `reviewSubmissionItems` (known). Clears in review / on approval.
- Keep Infisical `APPLE_IAP_ENABLED` off until approval; `APPLE_SIGNIN_ENABLED` already true.
