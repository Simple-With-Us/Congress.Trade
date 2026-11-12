# 2026-08-21 — PDF-native cascade sees upright pages

CURSOR-BUGBOT.  Branch `cursor/upright-pdf-native-cascade`.

## Summary

#2146 rotates `pdftoppm` PNGs so local Grok CLI and Qwen see House PTR
grids upright.  Gemini / grok-4.5 still attached the original PDF.
After #2142 a 13+ page sideways packet (Khanna attached schedules, 15-34p
McCaul) is not terminal on the first-12 CLI hit: the worker throws those
upright rows away and cascades.  Gemini then reads the unrotated file,
misses later-page trades, and drain skips `scanned_pdf`.

The OpenRouter hit is labeled `openrouter_google_gemini_…`.  #2143 / #2144
only softened `no_amount` for `local_grok` / `local_mac` extractor names,
so one omitted amount box on an attached schedule parked the whole Gemini
packet (Rogers-style).

## What changed

- Vision-worker rebuilds an uncapped PDF from the already-oriented PNGs
  and attaches that file to PDF-native cascade steps.
- `normalize` treats `source=local_mac` as local vision for the omitted-
  checkbox gate, including OpenRouter cascade labels.  All-no-amount
  extracts still stay in review.

## Verification

```
cd services/vision-worker && python3 test_worker.py
cd app && npx vitest run src/extraction/__tests__/normalizer.test.ts
```

Live Mac `~/vision-worker/worker.py` still needs a hand-copy after merge.
Coolify does not run this process.

## Follow-ups

- #2147 still OPEN: score the unrotated page; do not guess 270; skip
  landscape siblings.  This PR builds the upright PDF from whatever
  `upright_pages` already did, so that change stays complementary.
- GROK `grok/khanna-attached-pages` skip-CLI-when-pages>MAX_PAGES is still
  theirs.  This only makes the existing Gemini cascade see upright pages.
