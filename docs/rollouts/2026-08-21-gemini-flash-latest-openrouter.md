# 2026-08-21 — OpenRouter Flash stays on `~google/gemini-flash-latest`

Owner asked whether Gemini 3.7 Flash's 75% OpenRouter discount meant we
should pin `google/gemini-3.7-flash`, and whether Flash-latest already is
3.7.  It is.  Leave the Flash seat on latest.

## Live catalog (2026-08-21)

| Slug | Status | $/1M in/out | Notes |
|---|---|---|---|
| `~google/gemini-flash-latest` | listed | **$0.375 / $1.875** | "always redirects to the latest model in the Google Gemini Flash family"; file + image + video + audio; same price as 3.7 Vertex 75% off |
| `google/gemini-flash-latest` | **404** | n/a | bare slug is not a model id |
| `google/gemini-3.7-flash` | listed | $0.375 / $1.875 | pinned generation; Vertex/`Google` discount **0.75**; AI Studio 0.50 |
| `google/gemini-3.6-flash` | listed | $0.75 / $3.75 | older |
| `google/gemini-3.5-flash` | listed | $1.50 / $9 | older |

## What changed

- OpenRouter vision default and agreement slot D use
  `~google/gemini-flash-latest` (not a pinned 3.7 rewrite of latest).
- Requests for latest or pinned 3.7 send `provider.order = ['Google']` with
  `allow_fallbacks: true` so we hit the 75%-off Vertex endpoint.
- `supportsNativeVision` now matches Flash-latest (the alias has no
  `gemini-3` substring) and `deepseek/deepseek-v4-flash-vision-exp`, so a
  future vision-exp seat does not attach paid `mistral-ocr`.  Text-only
  DeepSeek Flash still uses the OCR plugin.
- Stale Infisical 3.5/3.6 slots are **not** rewritten.  Lite / image /
  preview slugs stay put.

## Files changed

- `app/src/extraction/openRouterVision.ts`
- `app/src/extraction/agreement.ts`
- `app/src/extraction/bakeoff.ts`
- `app/src/extraction/benchmarkMetrics.ts`
- `app/docs/config-registry.md`
- tests for the above

## Verification

- `curl -s https://openrouter.ai/api/v1/models` still lists
  `~google/gemini-flash-latest` at 3.7 prices and
  `deepseek/deepseek-v4-flash-vision-exp` with `input_modalities: ["text","image"]`.
- Focused: openRouterVision / bakeoff / configuredVision / agreement tests.
- No Infisical write.  No extract/OCR keepout stolen (#1959).

## Follow-ups

- ST `gemini-flash-latest` → send `~google/gemini-flash-latest`, not the
  bare 404 slug.  Not editable from this CT checkout.
- Do not add vision-exp to `DEFAULT_CANDIDATES`.
