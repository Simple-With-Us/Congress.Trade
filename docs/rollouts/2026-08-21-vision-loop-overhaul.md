# Vision-worker loop overhaul (Grok CLI isolation)

2026-08-21.  Grok.  Board `72852a1e`.  Branch `grok/vision-loop-overhaul`.

## Summary

The Mac vision-worker spawned 443 Grok chats in one day against about 20
PDFs.  Hal Rogers `H-2025-9115689` (17 sales) ran about 189 times.  Michael
McCaul's 93-row Nebraska filing ran about 134 times.  Fifty one-page
"Nothing to report" covers retried as `zero_transactions`.  Seventeen chats
died on `--max-turns 8` while re-reading rotated pages.  Every headless
`grok -p` inherited `cwd=/Users/jay/Code/Congress.Trade`, so AGENTS.md,
session-start, MCP plugins, and the TUI `xhigh` reasoning default loaded on
a job that asked for JSON only.

`#2143` already stamped `local_vision_submitted` when ingest returned
`needsReview` with rows.  That stamp never fired on honest empty `noRows`,
and pending still advertised `classified` / `extraction_pending_local` /
`error` docs even after a stamp.  Publish still called `clear_attempts`, so
a doc that bounced back onto pending was a new Grok session.

Containment: `pm2 stop vision-worker` (was 8 restarts, two overlapping
Python copies).

## What changed

- `grok -p` runs with `--cwd grok-cwd`, `--no-plan`, `--reasoning-effort medium`,
  `--json-schema`, `--system-prompt-override`, and turns scaled `4+2*pages`
  (floor 16, cap 32).  Process cwd is `~/vision-worker`, not the repo.
- One-worker file lock so a second copy exits 0 instead of double-polling.
- Honest empty (`noRows:true`) POSTs ingest and stamps
  `local_vision_submitted,nothing_to_report`.  It is not a failed attempt.
- Pending excludes that stamp on every ingest_status, not only `needs_review`.
- Successful publish / review / empty all `mark_doc_done` locally.  Never
  `clear_attempts` after a finished submit.
- Asset names drop a handwritten Sell/Purchase/Buy prefix; trailing `(TICKER)`
  fills `ticker`.

## Files changed

- `services/vision-worker/worker.py`
- `services/vision-worker/test_worker.py`
- `services/vision-worker/run-vision-worker.sh`
- `services/vision-worker/README.md`
- `services/vision-worker/grok-cwd/GROK.md`
- `app/src/admin/routes.ts`
- `app/src/ingestion/__tests__/localVisionWaitState.test.ts`

## Verification

```bash
python3 services/vision-worker/test_worker.py
cd app && npx vitest run src/ingestion/__tests__/localVisionWaitState.test.ts
```

After merge: copy worker files to `~/vision-worker`, `python3 -m py_compile`,
re-run `test_worker.py` there, `pm2 restart vision-worker --update-env`.
Confirm `pm2 show vision-worker` cwd is `~/vision-worker`.  Logs:
`~/.pm2/logs/vision-worker-out.log` should show `turns=` and `cwd=` grok-cwd,
and `cap: skip already-submitted` instead of re-processing Rogers/McCaul.

## Follow-ups

- Do not `pm2 start` until the live copy matches this commit.
- Hand-copy remains the Mac deploy path (see MAC-LOCAL-PROCESSES).
