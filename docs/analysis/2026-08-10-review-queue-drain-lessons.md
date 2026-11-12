# Review-Queue Drain Lessons → Autonomy Improvements

**Date:** 2026-08-10  
**Agent:** GROK  
**Owner ask:** clear the review queue accurately **without OpenRouter**, then turn lessons into a list of improvements so future House / Senate / Executive filings publish more autonomously, promptly, and accurately.

## What we did (ops)

| Metric | Value |
|--------|------:|
| Baseline unresolved | ~329 |
| Published (`confirm`) | 135 filings |
| Published (`manual`, provider) | 7 filings |
| Rejected (garbage / unusable) | 182 filings |
| Transactions inserted this pass | ~4,281 |
| Chambers published | House 135 · Senate 10 · Executive 1 |
| Final unresolved | **0** |
| OpenRouter calls | **0** |
| `review_resolution_integrity` | ok |

**Method:** mechanical classification of each queue payload → admin `POST /api/admin/review/:docId` with `confirm` / `manual` / `reject`. No agreement cascade, no OpenRouter vision, no bakeoff.

**High-trust publish sources (no LLM spend):**

- `textPdf` House text-layer PDFs (deterministic parse already good)
- `senateHtml` Senate eFD HTML
- `local_grok_cli_v1` / local Mac vision rows (already extracted offline)
- Provider gap rows (`provider_discovered_missing_official`) via manual provenance

**Honest rejects:**

- `server_cpu_v1` OCR inventories dominated by PTR form chrome / unreadable line boxes (often 100–1700 invented “rows”)
- `local_vision_exhausted` (spend park; no OpenRouter fallback per this ops pass)
- Provider payloads with no usable ticker/date/amount

**Important residual:** ~183 **rejected scanned House PDFs still have `raw_object_key`**. Trades may exist on those forms; we correctly refused to publish garbage OCR, but they need a **non-OpenRouter recovery path** (local vision / improved scan-cpu), not silent permanent loss.

---

## Root causes that filled the queue

1. **Agreement cascade depends on a second paid model.** When OpenRouter is budget-halted (402 / key balance), almost every otherwise-good `textPdf` / `senateHtml` row sits forever as `agreement_cascade_unresolved` even at ~0.6 confidence with canonical brackets.
2. **False `invalid_amount` penalties.** Rows with exact STOCK Act brackets (e.g. `$1,001 – $15,000` → 1001/15000) still get `invalid_amount` when `parseAmountRange(rawText)` disagrees with the snapped bracket (callables/partials, multi-range raw text). That multiplies low-confidence and blocks autopublish.
3. **`server_cpu_v1` invents transactions from letterhead.** Coolify CPU OCR turns “Clerk of the House…”, “Member of the U.S. House…”, y-coordinate “unreadable asset” placeholders into hundreds of rows → `extraction_row_limit_exceeded` and review floods. Form-chrome filters exist but residual contamination is still large.
4. **Scanned-PDF vision has no durable free path when OR is down.** Local Mac vision + scan-cpu are partial; exhaustion parks docs (`local_vision_exhausted`) without a deterministic recovery SLA.
5. **Provider-discovered missing official** correctly surfaces third-party-only observations, but without official PDF they need either filer/date matching to a later official fetch or a clear manual/publish policy — they accumulate as `unknown` doc_kind with no raw object.
6. **Autopilot halt is global.** One OpenRouter circuit failure freezes agreement for *all* chambers, including pure-deterministic Senate HTML / House text PDFs that never needed vision.

---

## Improvement backlog (priority ordered)

### P0 — Autonomy that must not depend on OpenRouter

| ID | Improvement | Chamber | Why it matters | Suggested shape |
|----|-------------|---------|----------------|-----------------|
| A1 | **Deterministic autopublish lane** for `textPdf` + `senateHtml` when mechanical validation passes (canonical brackets, dates ≤ filed_date, non-chrome asset names, row count ≤ limit) — skip agreement cascade entirely | House text · Senate | Today 100+ good docs sat only because A/B model agreement could not run | Gate in `normalizer` / `agreement`: `doc_kind in (text_pdf, senate_html)` + conf ≥ threshold + zero hard flags → `persistTransactions` |
| A2 | **Decouple autopilot halt from non-OR paths** | All | Global halt blocked free publish paths | Split circuits: `or_vision_halt` vs `deterministic_ok`; agreement only for vision/cascade tiers |
| A3 | **Fix false `invalid_amount`** when bracket is already canonical | All | Noise → review parking | If `isValidBracket(min,max)` already true, do not flag from rawText parse mismatch; optionally only warn in audit |
| A4 | **Refuse to enqueue `server_cpu_v1` garbage into review** | House scanned | 178 of ~329 items were this class | If form-chrome ratio > 50% or usable-row ratio < 30%, mark `extract_empty_failure` / `ocr_unusable` and route to local-vision requeue — not review_queue with 200 fake rows |
| A5 | **Local-vision SLA for scanned PDFs with raw** | House · Exec scanned · Senate paper | ~183 rejected-with-raw after this drain | Prefer Mac/`local_mac` + scan-cpu; never OpenRouter-first; reprocess endpoint that only claims `source=local_mac` / `server_cpu` improved |

### P1 — Promptness (hours, not days)

| ID | Improvement | Chamber | Suggested shape |
|----|-------------|---------|-----------------|
| B1 | **Per-chamber discovery SLOs + loud fail** | H/S/E | Already partly in pipelineHealth (#1641); extend so “no new official doc in window while source index advanced” alarms |
| B2 | **Senate relay durability** | Senate | Ephemeral quick-tunnel still breaks fetch; durable tunnel or dual-path fetch so document GET never stalls extraction |
| B3 | **House Clerk discovery continuity** | House | Avoid 500-cap crawl stops mid-year; checkpoint index position; continuous frontier without scout phantom doc_ids |
| B4 | **Executive OGE poll never silently off** | Executive | `OGE_WATCH_ENABLED` must default-on in prod config with health “not running” (not just stalled) |
| B5 | **Priority drain order** | All | Scheduled tick: publish-ready deterministic reviews → local vision → only then paid vision; never reverse |
| B6 | **Provider gap auto-attach** | H/S | **Partial (2026-08-25 #2221):** live provider observation pass rejects open `provider-missing-*` stubs when official `S-{key}` / `H-*-{key}` / matching `source_url` is `persisted`.  Does not auto-merge or confirm stub txs.  No historic sweep.  Receipt: `docs/rollouts/2026-08-25-provider-missing-stub-close.md`. |

### P2 — Accuracy

| ID | Improvement | Chamber | Suggested shape |
|----|-------------|---------|-----------------|
| C1 | **Strengthen form-chrome filter** (server + normalizer + worker) | House | Shared rule pack: letterhead, member/office lines, y-box unreadable placeholders, row-limit as quality signal not publish path |
| C2 | **Tx type B/S/E everywhere** | All | Residual `P`/purchase confusion; single `canonicalizeTxType` on every write (partially done) |
| C3 | **Owner / trust / subholding from raw** | House text | Deterministic extract already has ICA/trust lines; do not drop on confirm |
| C4 | **Duplicate-lot multiplicity** | House | Agreement must compare counts of identical lots (historical under-count bugs) |
| C5 | **Executive 278-T / OGE text path first** | Executive | Prefer `ogeText` deterministic; vision only for true scans |
| C6 | **Senate paper media OCR without OR** | Senate | Keep local/relay OCR; paper PTRs must not require OpenRouter files API ($0.50 balance trap) |
| C7 | **Amount bracket single source of truth** | All | `STOCK_ACT_BRACKETS` only; ban ad-hoc 1–1000 vs 0–1000 drift in agent scripts |
| C8 | **Re-extraction after reject with better engine** | House scanned | Rejected `error` + raw_object_key → automatic local requeue once, with attempt budget; do not leave orphaned forever |

### P3 — Ops / observability

| ID | Improvement | Suggested shape |
|----|-------------|-----------------|
| D1 | **Review-queue reason taxonomy dashboard** | Counts by reason × extractor × chamber on admin health |
| D2 | **One-click “deterministic drain” admin action** | Codifies this ops script: dry-run plan → apply, no LLM |
| D3 | **Integrity: needs_review with resolved queue** | ~62 leftover (mostly provider `verified_empty`); hourly sweep already — ensure status flips to terminal |
| D4 | **Receipt every bulk resolve** | `ingestion_decisions` with actor `agent:grok` / `ops:drain` (admin path does this) |
| D5 | **Never store secrets in review scripts** | Drain tooling must load `ADMIN_TOKEN` from env/container only (this pass did) |

---

## Chamber-specific checklist

### House
- Text-layer PTRs: autopublish after mechanical gates (A1/A3).
- Scanned PTRs: local vision first; kill server_cpu form-chrome publish path (A4/A5/C1/C8).
- Discovery: continuous Clerk crawl + no phantom frontier IDs (B3).

### Senate
- HTML eFD: same deterministic autopublish as House text (A1).
- Document fetch via durable relay (B2).
- Paper PDFs: local OCR, not OpenRouter files (C6).

### Executive
- Keep OGE poll on + instrumented (B4).
- 278-T text parser first (C5); scanned cabinet forms share local vision lane (A5).

---

## What *not* to do

- Do **not** bulk-confirm `server_cpu_v1` multi-hundred-row payloads — accuracy requirement forbids inventing trades.
- Do **not** wait for OpenRouter top-up to clear deterministic backlog.
- Do **not** resolve review rows without setting `filings.ingest_status` (integrity bug class already fixed in Monet #1573; keep tests).

---

## Immediate follow-ups from this drain

1. **Reprocess ~183 rejected scanned House filings with raw** via local vision / improved scan-cpu (no OpenRouter). Track as a recovery batch.
2. Land code for **A1 + A3 + A4** (highest leverage autonomy).
3. Keep admin drain script pattern (env token, dry-run, confirm/manual/reject) for future incidents — without hardcoding secrets.

## Evidence pointers

- Prod `review_queue` unresolved → 0 after 2026-08-10T19:51Z ops.
- Live txs ~95.1k after insert.
- Pipeline health: `review_resolution_integrity=ok`; autopilot still stalled on OR (expected; non-goal of this pass).

---

*Living companion to `docs/analysis/2026-08-02-ingestion-pipeline-improvements.md` and prior review-queue rollouts.*
