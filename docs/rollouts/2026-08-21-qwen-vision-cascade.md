# Cheap Qwen VL cascade after a missed Grok CLI solo pass

## Summary

The Mac scanned-PTR worker still tries one high-quality local Grok CLI pass
first (xAI subscription, `GROK_CLI_MAX_TURNS=8`).  That pass is not enough
for some rotated House grids: the model burns the turn budget on OCR and
orientation instead of emitting JSON.

On a miss (timeout, unparseable JSON, or 0 valid rows without `noRows`) the
worker now cascades cheap OpenRouter vision models before the expensive
Grok PDF fallback:

1. `qwen/qwen3-vl-8b-instruct` — raster page JPEGs
2. `qwen/qwen3-vl-30b-a3b-instruct` — raster page JPEGs
3. `google/gemini-3.7-flash` — native PDF
4. `OPENROUTER_MODEL` (`x-ai/grok-4.5`) — native PDF

Qwen VL slugs are **not** sent a PDF `file` attachment.  OpenRouter would
otherwise run `mistral-ocr` (~$2/1k pages) because those models have image
modality only.  That helper is `prefersPageImages` in
`app/src/extraction/openRouterVision.ts`, kept in sync with
`model_uses_page_images` in the worker.

`VISION_ENGINE=local_cli` still refuses OpenRouter spend.

## Files changed

- `services/vision-worker/worker.py` — cascade loop, image parts, miss gate
- `services/vision-worker/run-vision-worker.sh` — cascade env defaults
- `services/vision-worker/README.md` — engines + env
- `services/vision-worker/test_worker.py` — cascade order, miss gate, Wagner gold rows, Qwen image parts
- `app/src/extraction/openRouterVision.ts` — `prefersPageImages`
- `app/src/extraction/__tests__/openRouterVision.test.ts`

## Verification

```bash
python3 services/vision-worker/test_worker.py
cd app && npx vitest run src/extraction/__tests__/openRouterVision.test.ts
```

Live Mac deploy is a copy to `~/vision-worker/` plus `pm2 restart vision-worker`
(the Coolify app image does not run this worker).

## Follow-ups

- Do not add `deepseek/deepseek-v4-flash-vision-exp` here (image-only experimental
  slug; 2026-08-21 eval).
- Optional later: rotate portrait House PTR pages before the Grok CLI pass.
