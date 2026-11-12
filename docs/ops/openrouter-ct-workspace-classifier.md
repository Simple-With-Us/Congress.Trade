# OpenRouter CT workspace classifier + call-purpose tags

Two layers work together so you can see **what each LLM call was for**
inside the Congress.Trade OpenRouter workspace.

| Layer | Where | Cost | What it tags |
|-------|--------|------|----------------|
| **App-sent purpose** (code) | every CT OpenRouter request body | free | `trace.purpose`, `trace.feature`, `trace.generation_name`, `user`=docId |
| **Workspace Custom Classifier** (OpenRouter settings) | async ML after each generation | small (cheap model tokens) | taxonomy tags on Logs / Activity rollups |

Workspace: **Congress.Trade** (`slug=congress-trade`, id `184ec6d1-9c7c-47db-9ea0-11b7e434d94b`).

---

## 1. App-sent purpose (already in code)

Helper: `app/src/shared/openRouterAttribution.ts`.

Every OpenRouter call site must use:

```ts
headers: { ...openRouterAttributionHeaders(), Authorization, Content-Type }
body: { model, messages, ..., ...buildOpenRouterClassifier(env, { purpose, service, feature, user }) }
```

### Purpose taxonomy (stable)

| `purpose` | When | Typical `feature` |
|-----------|------|-------------------|
| `vision_extract` | Primary/failover vision PDF extract | `vision-extract-house` / `vision-extract-senate` / `vision-extract-executive` |
| `doc_class` | Pre-extract doc_class model call | `doc-class` |
| `senate_paper_ocr` | Paper PTR page-image OCR | `senate-paper-ocr` |
| `agreement_read` | (reserved) multi-model re-read | `agreement-*` |
| `benchmark` | Bakeoff / admin re-read | `benchmark` |
| `other` | Expand the enum instead of abusing this | — |

Also on every request:

- `HTTP-Referer: https://congress.trade`
- `X-OpenRouter-Title: Congress.Trade`
- `trace.sourceApp: congress-trade`
- `user: <docId>` when known (Activity dimension **Custom User ID**)

### How to view app-sent tags

- [OpenRouter Logs](https://openrouter.ai/logs) → open a generation → request metadata / trace
- Activity dimensions: **App**, **Custom User ID** (`user`), **Session ID**
- Filter by purpose in Broadcast destinations that map `trace.purpose` to attributes

---

## 2. Workspace Custom Classifier (dashboard — no public create API)

OpenRouter **Custom Classifiers** are workspace-admin UI only (beta).
There is no documented management API to create them (verified 2026-08-10 against
management key + OpenAPI: only `/analytics/query` references `classifier_id` after
a classifier exists).

### Create / activate (owner or workspace admin)

1. Open [Classifiers for CT workspace](https://openrouter.ai/workspaces/congress-trade/classifiers)
   (or workspace switcher → **Congress.Trade** → Classifiers).
2. **Create classifier** → start from scratch (or closest preset, then edit).
3. Use a **cheap, large-context** model (e.g. Haiku / Flash class).
4. Sampling: start at **100%** until you trust coverage, then lower if cost bothers you.
5. **Activate** and confirm tags appear on recent [Logs](https://openrouter.ai/logs).

### Recommended taxonomy (match app-sent purposes)

Dimensions (snake_case; ≤8 total):

#### `pipeline_stage` (required)

Values:

- `vision_extract` — reading a PTR/278-T PDF into structured trades
- `doc_class` — classifying typed vs clean_scan vs hard_scan vs empty vs corrupt
- `senate_paper_ocr` — OCR of Senate paper page images
- `agreement_cascade` — multi-model agreement / re-read
- `benchmark` — bakeoff, admin re-run, experimental model reads
- `unknown` — cannot tell

#### `chamber` (optional)

Values: `house` | `senate` | `executive` | `unknown`

#### `doc_kind` (optional)

Values: `text_pdf` | `scanned_pdf` | `senate_html` | `senate_paper` | `oge` | `unknown`

### Classification prompt (paste)

```
You classify Congress.Trade (congressional / executive financial disclosure) LLM calls.

Congress.Trade ingests House PTR PDFs, Senate eFD filings, and OGE 278-T forms.
Calls fall into pipeline stages:
- vision_extract: extract purchase/sale/exchange rows from a disclosure PDF
- doc_class: choose typed / clean_scan / hard_scan / empty / corrupt for routing
- senate_paper_ocr: OCR paper PTR page images from efd-media
- agreement_cascade: second/third model re-read for agreement
- benchmark: bakeoff or admin model comparison
- unknown: anything else

Also set chamber (house/senate/executive/unknown) and doc_kind when obvious
from the prompt (House PTR headers, Senate paper viewer, OGE 278-T, etc.).

Prefer pipeline_stage=vision_extract when the user message asks for transaction
JSON from a PDF. Prefer doc_class when the output enum is typed/clean_scan/hard_scan.
Prefer senate_paper_ocr when the content is page images of Senate paper forms.
```

### Why both layers?

| Need | Use |
|------|-----|
| Exact, free, always-on purpose | App `trace.purpose` |
| Soft inference when a call site forgot tags | Workspace classifier |
| Cost by purpose in Activity rollups | Workspace classifier dimensions once active + app tags in logs |

---

## 3. CT workspace observability (already on)

As of 2026-08-10 management API:

- Workspace **Congress.Trade** has `is_observability_io_logging_enabled=true`
- `is_observability_broadcast_enabled=true`
- IO logging sampling rate = 1

Optional: [Observability destinations](https://openrouter.ai/workspaces/congress-trade/observability)
(Broadcast) for Sentry/Langfuse/etc. — not required for in-dashboard purpose tags.

---

## 4. Verification checklist

After deploy + classifier activation:

1. Trigger a small vision extract (or wait for pipeline traffic).
2. Open Logs → generation detail:
   - Request shows `trace.purpose` / `generation_name`
   - Classifications section shows `pipeline_stage` (if workspace classifier active)
3. Activity explore → group by classifier dimension `pipeline_stage` (needs active classifier_id).
