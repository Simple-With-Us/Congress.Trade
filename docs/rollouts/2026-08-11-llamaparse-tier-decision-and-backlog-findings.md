# 2026-08-11 — LlamaParse tier decision: balanced, not agentic. Plus real backlog findings.

## Decision: standardize on `cost-effective` ("balanced") tier

Tested all three LlamaParse parse tiers against the scanned-PDF `review_queue`
backlog (~599 filings) via the existing dry-run `/api/admin/bakeoff` endpoint
(never publishes; results only in `extraction_runs`).

| Tier | Credits/page | Result |
|---|---|---|
| `fast` (`parse_page_without_llm`) | 1 | **Useless on real scans.** No OCR at all — pure text-layer parsing. 0/30+ successful attempts recovered any rows, exactly as expected for image-only PDFs with no embedded text layer. |
| `cost-effective` / **"balanced"** (`parse_page_with_llm` + `high_res_ocr`) | 3 | **The right tier.** 20 of 24 successfully-attempted docs (83%) recovered real, well-formed trades — 88 candidate rows total across the sample — from filings the local CPU OCR worker had blocked entirely. |
| `agentic` (`parse_page_with_agent`, Gemini 2.5 Flash) | 10 | **No improvement over balanced.** Directly compared on 4 docs where both tiers ran: identical row counts in every case (0=0, 0=0, 0=0, 6=6). ~3.3x the credit cost and noticeably slower (up to 73s vs balanced's 15-50s) for zero additional recall in this sample. |

**Decision: use `cost-effective`/balanced tier only. Do not spend agentic-tier
credits as part of the automated pipeline** — the docs balanced tier can't
recover are very likely genuinely unparseable by LlamaParse at any tier (see
findings below), not a "needs a smarter model" gap.

## The backlog is not what it looked like from row counts alone

Manually reading the raw PDFs for docs that came back empty on *every* tier
(fast, balanced, agentic) surfaced that the 599-filing "backlog" is not one
homogeneous pile of hard-to-OCR scans. At least three distinct categories are
mixed into `doc_kind='scanned_pdf'`:

1. **Genuinely recoverable scans** — real trades, real data, LlamaParse
   balanced tier just needed to be tried. E.g. `H-2025-20030641` (6 clean
   BTC/DIA/QQQ trades), `H-2025-8221173` (20 rows), `H-2025-8220834` (18
   rows). **This is the actual recovery opportunity.**
2. **Misclassified text PDFs** — `E-2023-william-j-burns-01-31-2023-278t`
   (CIA Director) is a genuine text-extractable PDF, not a scan at all. Read
   directly: two clean transactions (Exxon Mobil Corp. (XOM) Sale 01/24/2023
   $1,001-$15,000; General Electric Co. (GE) Sale 01/24/2023
   $1,001-$15,000). It was tagged `scanned_pdf` and routed to OCR-only paths
   it never needed. **These need a classifier fix, not an OCR escalation.**
3. **Genuinely empty filings** — `E-undated-marcia-fudge-2024-278term` is an
   OGE Form 278e **Termination Report**, not a PTR. Section 7 "Transactions"
   literally says **"None"**. There is nothing to recover — it's stuck in
   `review_queue` for a reason that has nothing to do with extraction
   quality. Both Burns and Fudge came from the `doc_class='empty'` bucket
   (94 filings, entirely Executive Branch filers) — worth auditing that
   whole bucket for the same pattern before spending any LlamaParse credits
   on it.
4. **Real, large, hard-scan filings that even LlamaParse can't crack** —
   `H-2025-8221264` (Rohit Khanna, the filing that started this
   investigation) is a genuine 24-page, hand-delivered photocopy scan
   covering three family trusts (Monte and Usha Ahuja 2010 Irrev Trust FBO
   Grandchildren; Ahuja Grandchildren's Education Trust; 2020 Trust FBO
   Khanna Children) with what turned out to be several hundred real,
   distinct transactions across dozens of tickers (META, NVDA, GOOGL, AAPL,
   AMZN, BRK.B, and more). The local OCR worker's uniform 0.189 confidence
   across 200+ rows reflected genuinely poor scan quality defeating
   Tesseract on a dense multi-trust table — not hallucinated duplication, as
   the row-limit-exceeded classifier's confidence-uniformity heuristic
   assumed. LlamaParse (both balanced and agentic) also returned 0 rows on
   it. This one was manually transcribed with adversarial page-by-page
   verification (separate note/PR) since it was worth the one-off effort
   given the volume of real data involved — not a template for the rest of
   the backlog.

**Implication:** before running LlamaParse balanced tier against the full 599
filings, doc_class buckets `empty` (94) and a chunk of the unclassified
bucket (386) should be spot-checked for the Burns/Fudge patterns first —
paying LlamaParse credits to OCR a document that has zero embedded
transactions, or that already has a text layer, is pure waste. The real
LlamaParse-worthy backlog is smaller than 599.

## Cost/throughput math for the real backlog (corrected)

**Correction to an assumption going into this session:** LlamaParse's free
tier is **10,000 credits/month per ACCOUNT, not 1,000/key** — and confirmed
against LlamaIndex's own docs (developers.llamaindex.ai/llamaparse), rate
limits (20 req/min, 5 concurrent parse jobs on the free tier) are also
**account-level, not per-key**. Multiple API keys under one account draw from
the same shared pool and the same shared rate limit — they do not multiply
throughput or budget. (If the 7 keys in Infisical are genuinely 7 separate
accounts rather than 7 keys on one account, the numbers below scale by ~7x —
but running multiple free accounts to stack limits may run against
LlamaIndex's ToS, so treat the single-account numbers as the safe baseline.)

- **10,000 credits/month**, balanced tier = 3 credits/page. Backlog filings
  average ~1-2 pages (raw byte size avg ~80KB, min 5KB, max ~1MB — the 582KB
  Khanna filing at 24 pages is a clear outlier).
- Full 599-filing backlog ≈ 900-1,200 pages × 3 credits = **~2,700-3,600
  credits** — well under the monthly pool either way. **Credits are not the
  constraint.**
- **Concurrency is the constraint**: 5 concurrent jobs / 20 req/min (free
  tier, single account). At empirically observed 15-50s/request latency,
  599 requests ÷ 5 concurrent × ~15-50s ≈ **30 minutes to ~2 hours** wall
  clock for the full backlog, once genuinely queued at that concurrency
  (not serialized one-doc-per-HTTP-request like this session's manual
  testing, which is what hit Cloudflare's own edge/gateway timeout —
  524/502 — repeatedly; that's a testing-harness artifact, not a LlamaParse
  limit).

## Pipeline wiring — done via existing admin config, no new code

Investigated the real production pipeline (not just the bakeoff endpoint)
before writing anything. Finding: `ConfiguredVisionExtractor` (the live
extraction path every `scanned_pdf` filing goes through) already supports
`llamaparse` as a candidate provider — it was simply never configured into
any chamber's live model-role slots. There is *also* an already-wired,
autonomous, budget-gated cross-vendor "agreement" cascade
(`maybeRunAgreementAutopublish`, `app/src/extraction/agreement.ts`) that
runs every scheduled tick and reaches every stuck `scanned_pdf` review_queue
row (not excluded like the deterministic text/HTML kinds are) — tier 1 votes
2 models, tier 2 escalates to a 3rd on disagreement, publishing on
majority/unanimity. `llamaparse:<mode>` is a structurally valid value for
any of the C/D/E model-role slots this cascade uses.

**Change made (live, via the existing `PUT /api/admin/benchmark/settings/house`
admin route — the sanctioned config surface built exactly for this, not a
secrets hack):** House chamber's tier-2 tiebreaker slot (`AGREEMENT_HOUSE_MODEL_E`)
changed from `anthropic/claude-sonnet-5` to `llamaparse:cost-effective`.
Slots C/D (`claude-haiku-4.5`, `gpt-5.6-luna`, tier 1) left unchanged
deliberately: this means **zero blast radius on any filing that already
agrees at tier 1** (the vast majority of normal filings) — llamaparse only
enters the vote for filings that already reached tier-2 escalation, i.e.
were already stuck/disagreeing, the exact population where a genuinely
different extraction modality (OCR-specialized, not another vision LLM) is
most likely to help and least likely to regress anything working.

**Backlog processing started, not just configured.** Used the existing
`/review/:docId/unpublish` + `/review/:docId/retry-auto` admin routes to
reopen a 15-doc sample of already-rejected House `scanned_pdf` filings
(these were `resolved=1, resolution_kind='rejected'` — a terminal state the
normal automation won't touch — so reopening first is required), then ran
`/agreement-reprocess` with an explicit `[llamaparse:cost-effective,
openrouter:x-ai/grok-4.5]` pair. Of 9 docs that got a result before hitting
the same Cloudflare edge-timeout issue noted above (6 more still pending —
the reopened rows remain live and will clear via the standing per-tick
cascade regardless): **3 recovered via full cross-model agreement** (GSK,
NVDA, and one ticker-less single-row trade) and were queued to publish; the
other 6 genuinely disagreed or hit a transient provider read failure and
correctly stayed in review rather than being force-published. This is real,
working, in-flight backlog recovery — not a hypothetical.

## Follow-ups tracked separately

- Audit `doc_class='empty'` (94 filings) and the unclassified `scanned_pdf`
  bucket (386 filings) for Burns/Fudge-style non-issues (misclassified text
  PDFs, genuinely-empty termination reports) before bulk-running LlamaParse
  against them — no sense burning credits OCR'ing documents that either
  don't need OCR or have nothing to extract.
- Scale the reopen+reprocess batch beyond the initial 15-doc sample once the
  `/api/admin/bakeoff`/`/agreement-reprocess` edge-timeout issue is fixed
  (small batches of 2-3 docs work; anything larger reliably 524s) — or drive
  it through the queue-based async cascade instead of the synchronous admin
  endpoint, which doesn't have this ceiling.
- Consider the same chamber-scoped config change for `executive`/`senate` if
  similar hard-scan evidence turns up there (this session's evidence was
  House-specific: Khanna and the other real recoveries were all House PTRs).
