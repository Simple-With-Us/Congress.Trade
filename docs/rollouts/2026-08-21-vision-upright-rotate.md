# 2026-08-21 — Upright-rotate sideways House PTR scans before Grok CLI

## Summary

House Clerk scans of landscape PTR grids are often stored as portrait PDF
pages.  `pdftoppm` then hands Grok CLI and Qwen VL a sideways table.  The
8-turn local CLI budget burns on rotation instead of rows, and the queue
fills with `form_chrome_only` / `extract_empty` for filings that are fully
legible once stood up (LaMalfa NVIDIA, McCaul June/July schedules).

After render, portrait PNGs are rotated clockwise.  Tesseract scores 90° vs
270° on House PTR header phrases (`FULL ASSET NAME`, `HAND DELIVERED`, …).
If OCR is silent, default 270° CW — the rotation that stood up every
sideways McCaul/LaMalfa scan in this drain.  Landscape renders (already
upright, e.g. `H-2025-8220834`) are left alone.

Live Mac worker (`pm2 vision-worker`) was copied and restarted in the same
session.  Coolify does not run this process.

## Files changed

- `services/vision-worker/worker.py` — `upright_pages` after `pdftoppm`
- `services/vision-worker/test_worker.py` — four rotation unit tests
- `services/vision-worker/README.md` — render step

## Verification

```
cd services/vision-worker && python3 test_worker.py
# 17 tests OK, including UprightRotateTest
pm2 restart vision-worker
# log: upright-rotate deg=270 pages=N
```

Manual drain (same session, not this PR): confirmed complete McCaul
`H-2024-8220320` 219, `H-2025-8220834` 52, `H-2025-8221120` 32,
`H-2025-8221173` 177; LaMalfa `H-2024-8220177` 3 NVIDIA sales; Collins
`H-2025-20030466` 5; Issa `H-2025-20030181` 1.  Rejected Rogers
`H-2024-8220567` (NOTHING TO REPORT).

## Follow-ups

- Sessions `H-2025-20033330`: form tx date 2025-10-24 vs digital signature
  2025-10-22.  Confirm API refuses tx after filed date.  Do not invent a date.
- 26-page McCaul `H-2024-8220711` still exceeds `MAX_PAGES=12`.
- Remaining form-chrome empties should now be readable after rotation.
