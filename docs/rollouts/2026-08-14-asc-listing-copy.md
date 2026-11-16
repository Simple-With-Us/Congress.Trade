# 2026-08-14 — App Store 1.0 listing copy: trial, two spaces, Executive

## Summary

Owner: two spaces after every period, everywhere, including App Store
submission fields.  The review-notes box still said a **1-month** free
trial.  Several fields also described the feed as **Congressional / House
and Senate only**, which is wrong — the live corpus is House, Senate, and
**Executive Branch** (OGE 278-T).

All human-facing ASC strings were re-read and rewritten.  The fleet rule
was strengthened so review notes are not treated as exempt.

## Live ASC after the write

| Field | What was wrong | Now |
|---|---|---|
| Description | Congress-only lede; House and Senate bullets; 2-week trial already correct; single spaces originally | House, Senate, and Executive (OGE 278-T); 2-week trial; two spaces |
| Promotional text | House & Senate only | House, Senate, and Executive Branch |
| Keywords | No Executive | Added `Executive` (80/100) |
| App Review notes | “congressional trades”; **1-month** trial; single spaces | House, Senate, and Executive (OGE 278-T); **2-week** trial; two spaces |
| Monthly / annual IAP `reviewNote` | “Congress stock”; **1-month** trial | House, Senate, and Executive; **2-week** trial; two spaces |
| IAP localization descriptions | Single space after period; 45-char cap | Two spaces; still too short to name chambers |
| Subtitle | `Ingests & Sends To Apps Sooner` | Unchanged (accurate, 30/30) |

Version 1.0 stays `PREPARE_FOR_SUBMISSION`.  Not submitted for review.

## Files changed

- `AGENTS.md` — two-space + corpus + trial accuracy
- `docs/FLEET-UI-COPY.md` — mirror of the live fleet copy file
- `docs/EFFORT-LOG.md`, `STATUS.md`, this rollout

ASC writes are live on App Store Connect (no app binary change).

## Fleet protocol

Canonical: `/Users/jay/apps/AG***-S**C.md` § Two spaces between sentences.
Copy detail: `/Users/jay/apps/FLEET-UI-COPY.md`.  Coordinator PR mirrors those
files plus onboarding / `TEMPLATE-AGENTS.md`.

## Follow-ups

- Submit version 1.0 for review when the owner wants.
- Sibling app AGENTS.md stanzas (ST, UM, DealDex, Personal-Site) should pick
  up the same two-space paragraph from `TEMPLATE-AGENTS.md`.
