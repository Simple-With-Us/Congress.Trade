# 2026-08-21 — Do not add DeepSeek V4 Flash Vision Exp; keep OpenRouter

Owner asked whether OpenRouter `deepseek/deepseek-v4-flash-vision-exp`
([model card](https://openrouter.ai/deepseek/deepseek-v4-flash-vision-exp))
should enter the Congress.Trade extract cascade, whether Socratic.Trade
Green/Red teams should use it, and whether [atlascloud.ai](https://atlascloud.ai)
would be cheaper than OpenRouter for CT and ST.

**Verdict:** do not add the vision-exp slug to the live cascade, bake-off
offered list, or ST Green/Red picker.  Keep OpenRouter as the LLM gateway.
Atlas Cloud would cost more on the models we actually call and would drop
models the cascade already depends on.

This note is a decision record only.  No extract / OpenRouter wiring
changed.  Draft #1959 (executive `scanned_pdf` OCR) stays the keepout for
that path.

## What the model actually is

Live OpenRouter `/api/v1/models` on 2026-08-21 (catalog size 420):

| Field | `deepseek/deepseek-v4-flash-vision-exp` | `deepseek/deepseek-v4-flash` (already offered) |
|---|---|---|
| Released | 2026-08-21 (experimental) | GA text Flash (0423 / 0731 family) |
| Input modalities | `text`, `image` | `text` only |
| File / PDF | **no** | no |
| `$ / 1M` prompt / completion | **$0.22 / $0.66** | **$0.081 / $0.162** |
| Cache read | $0.007 / 1M | $0.016 / 1M |
| `structured_outputs` | **not listed** | listed |
| Tools | yes | yes |
| Context | 1M | 1M |
| Host | DeepSeek only (no OR fallback set) | DeepSeek |

Card extras that matter for publish autonomy:

- P50 latency 1.03s, but **P99 36.5s** and **P99 e2e 123s**.
- Tool-call error rate **0.76%**.
- Image understanding is the only new capability vs text Flash.  Text
  capability is advertised as matching Flash 0731, not beating it.

## Congress.Trade cascade — do not add

Current cheap-first path (`extractRouting.ts` + `openRouterVision.ts`):

1. Typed / electronic House PTRs (20xxxxxx, `text_pdf`) never take OpenRouter
   Files.  Local unpdf + optional cheap text chat.
2. Real scans may use Files / native vision.  `supportsNativeVision()` is
   GPT / Claude / Gemini / Grok only.  **DeepSeek is not on that list.**
3. Agreement defaults: C `x-ai/grok-4.5`, D `google/gemini-3.7-flash`,
   E `anthropic/claude-haiku-4.5`.  All three accept **file** natively.
4. Bake-off already offers `deepseek/deepseek-v4-pro` and
   `deepseek/deepseek-v4-flash` (text).  Qwen VL 8B / 30B are already the
   cheap image-capable offered models.

Would vision-exp help publish filings more accurately, cheaply, swiftly, or
autonomously?

| Goal | Result |
|---|---|
| **Cheaper** | No.  2.7× text Flash on input, 4× on output.  On scans, no native PDF means we still pay `mistral-ocr` ($2 / 1k pages) or we rasterize pages ourselves.  Qwen3 VL 8B is already cheaper ($0.117 / $0.455) for image-in.  Gemini 3.7 Flash is more $/token but reads the PDF in one native Files call and is already slot D. |
| **Faster / more autonomous** | No.  Same-day experimental, single upstream, fat P99 tail, and our adapter would still attach the paid OCR plugin because `supportsNativeVision('deepseek/…')` is false.  That is extra hops, not fewer. |
| **More accurate** | Not evidenced.  No PDF modality.  No `structured_outputs` on the live listing (our extractor prefers strict `json_schema` for DeepSeek-family slugs).  Text Flash already exists if we want a cheap DeepSeek vote. |
| **Autonomy vs review queue** | Adding an experimental, more expensive, non-PDF model as a cascade voter increases disagreement and spend on the $2/day OpenRouter ceiling.  It does not drain `scanned_pdf` any better than the #1959 OCR keepout or the Mac vision worker. |

Do not put the slug on `DEFAULT_CANDIDATES`.  Revisit only if DeepSeek ships
a **GA** Flash Vision with `file` input, `structured_outputs`, and a bake-off
win against Gemini Flash + Qwen VL on real scanned PTRs.

## Socratic.Trade Green / Red — avoid this slug

ST already catalogs DeepSeek as text models (`src/lib/llm-model-catalog.ts`,
HEAD `93bd16f`):

- Green/Red display `deepseek-flash-latest` → `deepseek/deepseek-v4-flash`
- `deepseek-pro-latest` → `deepseek/deepseek-v4-pro`
- `deepseek-r1` → `deepseek/deepseek-r1`

Recommended Green seats are Terra / Haiku / Gemini Flash.  Recommended Red
seats are Sol / Sonnet / Gemini Pro.  July 8 ST bench: text Flash was 3/3
valid JSON in both roles at ~$0.001.

Green (proposer) and Red (reviewer) consume **text** signal packs and must
return **reliable tool/JSON**.  Red fail-closes when unconfigured and must
never silently fall back to Green.

Avoid `deepseek-v4-flash-vision-exp` for both seats:

- Vision is unused.  Paying 3–4× Flash for image weights does not improve
  proposals or vetoes.
- Experimental + 0.76% tool-call error is the wrong shape for Red, which is
  the adversarial money gate.
- Missing `structured_outputs` vs text Flash, which ST already proved.
- Picker pollution: someone will select the shiny exp slug for live paper.

Keep `deepseek-flash-latest` / `deepseek-pro-latest` as the DeepSeek seats.

## Atlas Cloud vs OpenRouter (CT and ST)

Live Atlas `/v1/models` on 2026-08-21: **136** models.  OpenRouter: **420**.

Pay-as-you-go on the DeepSeek V4 family we already use:

| Model | OpenRouter $/1M in/out | Atlas $/1M in/out | Atlas vs OR |
|---|---|---|---|
| V4 Flash | $0.081 / $0.162 | $0.14 / $0.28 | **~1.7× more** |
| V4 Flash 0731 | $0.08 / $0.18 | $0.44 / $1.32 | **~5–7× more** |
| V4 Pro | $1.60 / $3.20 | $1.68 / $3.38 | slightly more |
| V4 Pro 0813 | $1.188 / $3.564 | $1.32 / $3.96 | more |
| Flash Vision Exp | $0.22 / $0.66 | **not listed** | n/a |

Atlas also does **not** list `google/gemini-3.7-flash` (CT agreement slot D
and the OR-transport default).  Their current Gemini Flash SKUs are older
or preview ids, some at $1.50 / $9.00 — several times our live OR Gemini
3.7 Flash ($0.375 / $1.875).

### Why Atlas's marketing does not apply here

Atlas sells (1) a full-modal catalog (image + video generation), (2) SOC 2
+ HIPAA on one key, (3) a Coding Plan subscription that can beat
pass-through for daily agent coding.  CT and ST production inference is
**LLM-only**: extract structured trades, propose/review trades.  We do not
generate images or video.  Public filings and paper-trading prompts are not
a HIPAA workload.  Cursor / Claude Code spend is a different bill.

OpenRouter already gives us:

- The models the cascade and ST catalog actually name.
- Native PDF file-parser, annotation reuse, `usage.include` cost capture.
- Provider fallback when an upstream dies (vision-exp has only DeepSeek).
- Existing budget circuit, $2/day ceiling, attribution headers, Infisical
  key, monitor mapping.

Atlas would add a second vendor, a second key, a smaller LLM catalog, and
**higher** DeepSeek Flash/Pro unit prices, while losing Gemini 3.7 Flash
and the PDF plugin we already rely on.

OpenRouter's 5.5% credit-purchase fee does not close a 1.7× Flash gap.

**Do not migrate CT or ST off OpenRouter to Atlas Cloud.**  A Coding Plan
for *agent* work is a separate owner decision and is not a production
extract/strategy gateway.

## Live call attempt

`CT_OPENROUTER_API_KEY` in this cloud session returned OpenRouter
`401 User not found` on both `/api/v1/auth/key` and a one-token chat
completion.  No paid probe ran.  The recommendation above is from the live
catalogs and our wiring, not from a side-by-side PTR bake-off.

A working key can rerun: text extract vs Flash, PNG table vs Qwen VL 8B,
PDF `type:file` attach (expected reject), and forced `submit_review` tool
call (ST Red shape).  That would measure dollars and JSON validity.  It
would not change the PDF-modality or Atlas-price findings.

## Files changed

- `docs/rollouts/2026-08-21-deepseek-v4-flash-vision-exp-eval.md` (this file)
- `docs/EFFORT-LOG.md` (claim / closeout)

## Verification

- `curl -s https://openrouter.ai/api/v1/models` still lists
  `deepseek/deepseek-v4-flash-vision-exp` with `input_modalities: ["text","image"]`
  and no `file`.
- `app/src/extraction/bakeoff.ts` `DEFAULT_CANDIDATES` still has text Flash /
  Pro only.
- `supportsNativeVision` still does not match `deepseek`.
- No production ingest, cascade swap, or Infisical write.

## Follow-ups

- Owner: optional working OpenRouter key for a paid 4-call probe.
- Do not steal #1959.  If scanned-PDF autonomy is the real gap, that OCR
  path plus the Mac vision worker remain the owned work.
- ST: do not add a vision-exp row to `llm-model-catalog.ts`.
- ST `gemini-flash-latest` must send `~google/gemini-flash-latest`
  (bare slug 404s; alias is currently Gemini 3.7).  See
  `docs/rollouts/2026-08-21-gemini-flash-latest-openrouter.md`.
- `supportsNativeVision` now recognizes vision-exp so a future seat does
  not attach mistral-ocr.  Still do not add it to `DEFAULT_CANDIDATES`.
