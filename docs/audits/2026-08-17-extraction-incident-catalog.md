# 2026-08-17 extraction incident audit catalog

Read-only production audit.  No review_queue Confirm/Reject.  No filing-truth mutation.  No secret values.

**As of:** 2026-08-17 ~23:40Z against live `congress.trade` (SHA `be53b3e5` at audit time).

## Coverage proof

Every unresolved human-review row and every suppressed / skipped / failed / stranded filing class was enumerated and reconciled against the official House Clerk FD ZIP (2021–2026 PTR DocIDs), Senate eFD `source_url` hosts, and OGE `source_url` hosts.

| Class | Count | Official index | Silently ignored? |
|---|---:|---|---|
| Unresolved `review_queue` (all House `scanned_pdf`) | 219 | 219/219 in Clerk FD PTR ZIP + clerk URL | No — queued with a per-doc reason |
| Review health buckets (new) | eligible 9, suppressed 0, terminal 210 | same 219 | No |
| House `not_found` now in Clerk ZIP (stale phantom stamp) | 16 | in 2026FD.ZIP | No — recorded `not_found` with probe error; re-ingest is a later controlled op |
| House `not_found` probe phantoms | 881 | absent from Clerk PTR ZIP | No — known #1577 frontier-probe class |
| Senate official eFD persisted | 501 | efdsearch.senate.gov | No |
| Senate official eFD classified (sitting) | 90 | efdsearch.senate.gov; all have raw | No — waiting hosted extract while autopilot halted |
| Senate official eFD error | 85 | efdsearch.senate.gov | No — 83 `fetcher: Unauthorized`, 1 known probe, 1 stranded ceiling |
| Executive official OGE persisted | 35 | oge.gov | No |
| Executive official OGE error | 296 | oge.gov | No — 295 autonomy-sweep empty-extract reconcile |
| `needs_review` with no open review row | 87 | none (all `provider-missing-*`) | No — provider stubs, not official docs |
| `ingestion_outbox` failed | 316 | n/a | No — all `consumer retry budget exhausted; received by ingest-dlq` |

**Silently ignored official filings: 0.**  Machine-readable rows: `docs/audits/2026-08-17-extraction-incident-catalog.json`.

## 1. Aug 10 OpenRouter Files API 402

Hypothesis that the account was unfunded is **false**.  The live production key (same identity used for Files calls) is a paid key with a **$2/day key limit**.

| Safe identity | Value |
|---|---|
| Present | yes |
| Length | 73 |
| Prefix | `sk-or-v` |
| sha256_12 | `450ceab9559f` |
| last4 | `3aa7` |
| is_free_tier | false |
| limit | 2 |
| limit_reset | daily |
| limit_remaining (audit time) | 2 |
| include_byok_in_limit | true |
| usage lifetime / month / today | ~41.67 / ~7.83 / 0 |

Halt receipt `fdadd07b-4e03-4617-816d-0e4f1d2b45df` started 2026-08-10T03:30:54Z, halted 2026-08-10T03:31:03Z, `docs_attempted=2`, `spend_microusd=0`, stored `halt_reason=error_class:quota`, **never acknowledged**.  Sample: OpenRouter HTTP 402 “This request requires at least $0.50 in balance for files”, `limit_source=openrouter_key_limit`.

**Why a funded account 402d:** OpenRouter Files charges a $0.50 prepaid hold against the **key limit**, not the wallet.  A $2/day key limit plus that hold is `openrouter_key_limit`, not account depletion.  Health later reclassified the stored quota halt as billing/files-prepaid (#1853), but the run still required a human ack, so extraction stayed dead after the circuit cool-down.  That is the permanent silent latch.

Token value is not recorded anywhere in this catalog.

## 2. `local_mac_1` is supplemental; exhaustion did not fall back

`WORKER_ID` default is `local_mac_1` (`services/vision-worker/README.md`).  It is the Mac vision worker, not the hosted cascade.  After 3 local attempts it POSTs `/api/admin/local-vision-park`, which stamped `local_vision_exhausted,scanned_pdf_vision_spend` and left an unresolved review row.  `GET /scanned-filings/pending` **excludes** those docs so the Mac worker stops.  Before this change the park path did **not** enqueue `filing.extracted`, so hosted LLM never ran.  Autopilot was also halted, so even a hosted enqueue would have sat behind the latch.

Live parks:

- `H-2025-20026666` status=`needs_review` reason=`agreement_cascade_unresolved` error=`local_vision_exhausted: attempts=3 last=transcription_failed worker=local_mac_1`
- `H-2025-8221302` status=`error` reason=`rejected: local_vision_exhausted,scanned_pdf_vision_spend` error=`fetcher: Unauthorized`
- `H-2025-9115662` status=`error` reason=`rejected: local_vision_exhausted,scanned_pdf_vision_spend` error=`fetcher: Unauthorized`
- `H-2024-8220567` status=`error` reason=`rejected: local_vision_exhausted,scanned_pdf_vision_spend` error=`fetcher: Unauthorized`
- `H-2024-8220203` status=`error` reason=`rejected: local_vision_exhausted,scanned_pdf_vision_spend` error=`fetcher: Unauthorized`

## 3. Unresolved review_queue (one row per document)

All 219 are House `scanned_pdf` official Clerk PTRs.  214 `ingest_status=error`, 5 `needs_review`.  New health buckets count every unresolved row.

| doc_id | bucket | suppressed_flag | ingest_status | reason | in_clerk_zip | evidence |
|---|---|---|---|---|---|---|
| `H-2025-20030634` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030634.pdf` + open review row |
| `H-2025-20030461` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030461.pdf` + open review row |
| `H-2025-20026726` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20026726.pdf` + open review row |
| `H-2025-20031001` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20031001.pdf` + open review row |
| `H-2025-20033691` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20033691.pdf` + open review row |
| `H-2025-20030632` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030632.pdf` + open review row |
| `H-2025-20030215` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030215.pdf` + open review row |
| `H-2025-20027913` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20027913.pdf` + open review row |
| `H-2025-20032276` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20032276.pdf` + open review row |
| `H-2025-20030998` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030998.pdf` + open review row |
| `H-2025-20030857` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030857.pdf` + open review row |
| `H-2025-20030635` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030635.pdf` + open review row |
| `H-2025-20030482` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030482.pdf` + open review row |
| `H-2025-20030433` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030433.pdf` + open review row |
| `H-2025-20030336` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030336.pdf` + open review row |
| `H-2025-20030312` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030312.pdf` + open review row |
| `H-2025-20030238` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030238.pdf` + open review row |
| `H-2025-20030212` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030212.pdf` + open review row |
| `H-2025-20029034` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20029034.pdf` + open review row |
| `H-2025-20027940` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20027940.pdf` + open review row |
| `H-2025-20027923` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20027923.pdf` + open review row |
| `H-2025-8220747` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/8220747.pdf` + open review row |
| `H-2025-20033579` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20033579.pdf` + open review row |
| `H-2025-20033325` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20033325.pdf` + open review row |
| `H-2025-20032200` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20032200.pdf` + open review row |
| `H-2025-20030746` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030746.pdf` + open review row |
| `H-2025-20027855` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20027855.pdf` + open review row |
| `H-2025-20033667` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20033667.pdf` + open review row |
| `H-2025-20030179` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030179.pdf` + open review row |
| `H-2025-20029062` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20029062.pdf` + open review row |
| `H-2025-20032191` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20032191.pdf` + open review row |
| `H-2025-20030735` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030735.pdf` + open review row |
| `H-2025-20029068` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20029068.pdf` + open review row |
| `H-2025-20030342` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030342.pdf` + open review row |
| `H-2025-20027903` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20027903.pdf` + open review row |
| `H-2025-20030618` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030618.pdf` + open review row |
| `H-2025-20030285` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030285.pdf` + open review row |
| `H-2025-20029088` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20029088.pdf` + open review row |
| `H-2025-20027935` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20027935.pdf` + open review row |
| `H-2025-20033320` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20033320.pdf` + open review row |
| `H-2025-20032230` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20032230.pdf` + open review row |
| `H-2025-20032087` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20032087.pdf` + open review row |
| `H-2025-20030929` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030929.pdf` + open review row |
| `H-2025-20030839` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030839.pdf` + open review row |
| `H-2025-20030600` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030600.pdf` + open review row |
| `H-2025-20030577` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030577.pdf` + open review row |
| `H-2025-20027912` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20027912.pdf` + open review row |
| `H-2025-20033403` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20033403.pdf` + open review row |
| `H-2025-8220836` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/8220836.pdf` + open review row |
| `H-2025-8220765` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/8220765.pdf` + open review row |
| `H-2025-20030930` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030930.pdf` + open review row |
| `H-2025-20030869` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030869.pdf` + open review row |
| `H-2025-20033666` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20033666.pdf` + open review row |
| `H-2025-20033590` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20033590.pdf` + open review row |
| `H-2025-20033495` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20033495.pdf` + open review row |
| `H-2025-20033395` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20033395.pdf` + open review row |
| `H-2025-20032236` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20032236.pdf` + open review row |
| `H-2025-20030567` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030567.pdf` + open review row |
| `H-2025-20033684` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20033684.pdf` + open review row |
| `H-2025-20030933` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030933.pdf` + open review row |
| `H-2025-20030311` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030311.pdf` + open review row |
| `H-2025-20027867` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20027867.pdf` + open review row |
| `H-2025-8221297` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/8221297.pdf` + open review row |
| `H-2025-8221233` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/8221233.pdf` + open review row |
| `H-2025-8221177` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/8221177.pdf` + open review row |
| `H-2025-8220903` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/8220903.pdf` + open review row |
| `H-2025-8220824` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/8220824.pdf` + open review row |
| `H-2025-8220799` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/8220799.pdf` + open review row |
| `H-2025-8220757` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/8220757.pdf` + open review row |
| `H-2025-20030886` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030886.pdf` + open review row |
| `H-2025-20027982` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20027982.pdf` + open review row |
| `H-2025-20030402` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030402.pdf` + open review row |
| `H-2025-20029060` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20029060.pdf` + open review row |
| `H-2025-20033565` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20033565.pdf` + open review row |
| `H-2025-20033394` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20033394.pdf` + open review row |
| `H-2025-20030307` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030307.pdf` + open review row |
| `H-2025-20030188` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030188.pdf` + open review row |
| `H-2025-20030673` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030673.pdf` + open review row |
| `H-2025-20024927` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20024927.pdf` + open review row |
| `H-2025-20033488` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20033488.pdf` + open review row |
| `H-2025-20026754` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20026754.pdf` + open review row |
| `H-2025-8221238` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/8221238.pdf` + open review row |
| `H-2025-9115549` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/9115549.pdf` + open review row |
| `H-2025-8220764` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/8220764.pdf` + open review row |
| `H-2025-20033699` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20033699.pdf` + open review row |
| `H-2025-20033575` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20033575.pdf` + open review row |
| `H-2025-20027879` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20027879.pdf` + open review row |
| `H-2025-20027937` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20027937.pdf` + open review row |
| `H-2025-8220780` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/8220780.pdf` + open review row |
| `H-2025-8220770` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/8220770.pdf` + open review row |
| `H-2025-8220768` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/8220768.pdf` + open review row |
| `H-2025-20030235` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030235.pdf` + open review row |
| `H-2025-20033330` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20033330.pdf` + open review row |
| `H-2025-8220731` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/8220731.pdf` + open review row |
| `H-2025-20030594` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030594.pdf` + open review row |
| `H-2025-20030591` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030591.pdf` + open review row |
| `H-2025-20027911` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20027911.pdf` + open review row |
| `H-2025-8221310` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/8221310.pdf` + open review row |
| `H-2025-8221270` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/8221270.pdf` + open review row |
| `H-2025-8221223` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/8221223.pdf` + open review row |
| `H-2025-9115689` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/9115689.pdf` + open review row |
| `H-2025-9115635` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/9115635.pdf` + open review row |
| `H-2025-9115623` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/9115623.pdf` + open review row |
| `H-2025-9115546` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/9115546.pdf` + open review row |
| `H-2025-8221123` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/8221123.pdf` + open review row |
| `H-2025-8220958` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/8220958.pdf` + open review row |
| `H-2025-8220844` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/8220844.pdf` + open review row |
| `H-2025-8220782` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/8220782.pdf` + open review row |
| `H-2025-8220755` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/8220755.pdf` + open review row |
| `H-2025-20030371` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030371.pdf` + open review row |
| `H-2025-20030237` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030237.pdf` + open review row |
| `H-2025-8220828` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/8220828.pdf` + open review row |
| `H-2025-20026756` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20026756.pdf` + open review row |
| `H-2025-20033402` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20033402.pdf` + open review row |
| `H-2025-20030492` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030492.pdf` + open review row |
| `H-2025-20030737` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030737.pdf` + open review row |
| `H-2025-20021220` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20021220.pdf` + open review row |
| `H-2025-20033588` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20033588.pdf` + open review row |
| `H-2025-20033472` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20033472.pdf` + open review row |
| `H-2025-20032054` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20032054.pdf` + open review row |
| `H-2025-20030663` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030663.pdf` + open review row |
| `H-2025-20030517` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030517.pdf` + open review row |
| `H-2025-20030340` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030340.pdf` + open review row |
| `H-2025-20029120` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20029120.pdf` + open review row |
| `H-2025-20026774` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20026774.pdf` + open review row |
| `H-2025-20026577` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20026577.pdf` + open review row |
| `H-2025-20030630` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030630.pdf` + open review row |
| `H-2025-20033318` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20033318.pdf` + open review row |
| `H-2025-20027950` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20027950.pdf` + open review row |
| `H-2025-20030894` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030894.pdf` + open review row |
| `H-2025-20030756` | terminal | yes | error | rejected: agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030756.pdf` + open review row |
| `H-2025-20030282` | terminal | yes | error | rejected: bad_asset_name,missing_tx_date,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030282.pdf` + open review row |
| `H-2025-20029079` | terminal | yes | error | rejected: bad_asset_name,missing_tx_date,invalid_amount,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20029079.pdf` + open review row |
| `H-2025-20026731` | terminal | yes | error | rejected: bad_asset_name,missing_tx_date,invalid_amount,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20026731.pdf` + open review row |
| `H-2025-20033651` | terminal | yes | error | rejected: bad_asset_name,missing_tx_date,invalid_amount,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20033651.pdf` + open review row |
| `H-2025-20033425` | terminal | yes | error | rejected: bad_asset_name,missing_tx_date,invalid_amount,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20033425.pdf` + open review row |
| `H-2025-20032061` | terminal | yes | error | rejected: bad_asset_name,missing_tx_date,invalid_amount,no_amount,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20032061.pdf` + open review row |
| `H-2025-20030893` | terminal | yes | error | rejected: bad_asset_name,missing_tx_date,invalid_amount,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030893.pdf` + open review row |
| `H-2025-20030448` | terminal | yes | error | rejected: bad_asset_name,missing_tx_date,invalid_amount,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030448.pdf` + open review row |
| `H-2025-20030313` | terminal | yes | error | rejected: bad_asset_name,missing_tx_date,invalid_amount,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030313.pdf` + open review row |
| `H-2025-20029121` | terminal | yes | error | rejected: bad_asset_name,missing_tx_date,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20029121.pdf` + open review row |
| `H-2025-20029067` | terminal | yes | error | rejected: bad_asset_name,missing_tx_date,invalid_amount,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20029067.pdf` + open review row |
| `H-2025-20027951` | terminal | yes | error | rejected: bad_asset_name,missing_tx_date,invalid_amount,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20027951.pdf` + open review row |
| `H-2025-20027907` | terminal | yes | error | rejected: bad_asset_name,missing_tx_date,invalid_amount,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20027907.pdf` + open review row |
| `H-2025-20026695` | terminal | yes | error | rejected: bad_asset_name,missing_tx_date,invalid_amount,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20026695.pdf` + open review row |
| `H-2025-20033564` | terminal | yes | error | rejected: bad_asset_name,missing_tx_date,invalid_amount,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20033564.pdf` + open review row |
| `H-2025-20033413` | terminal | yes | error | rejected: bad_asset_name,missing_tx_date,invalid_amount,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20033413.pdf` + open review row |
| `H-2025-20032256` | terminal | yes | error | rejected: bad_asset_name,missing_tx_date,invalid_amount,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20032256.pdf` + open review row |
| `H-2025-20030824` | terminal | yes | error | rejected: bad_asset_name,missing_tx_date,invalid_amount,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030824.pdf` + open review row |
| `H-2025-20027944` | terminal | yes | error | rejected: bad_asset_name,missing_tx_date,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20027944.pdf` + open review row |
| `H-2025-20026796` | terminal | yes | error | rejected: bad_asset_name,missing_tx_date,invalid_amount,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20026796.pdf` + open review row |
| `H-2025-20029100` | terminal | yes | error | rejected: bad_asset_name,missing_tx_date,invalid_amount,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20029100.pdf` + open review row |
| `H-2025-20032187` | terminal | yes | error | rejected: bad_asset_name,missing_tx_date,invalid_amount,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20032187.pdf` + open review row |
| `H-2025-20030742` | terminal | yes | error | rejected: bad_asset_name,missing_tx_date,invalid_amount,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030742.pdf` + open review row |
| `H-2025-20030401` | terminal | yes | error | rejected: bad_asset_name,missing_tx_date,invalid_amount,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030401.pdf` + open review row |
| `H-2025-20030236` | terminal | yes | error | rejected: bad_asset_name,missing_tx_date,invalid_amount,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030236.pdf` + open review row |
| `H-2025-20029035` | terminal | yes | error | rejected: bad_asset_name,missing_tx_date,invalid_amount,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20029035.pdf` + open review row |
| `H-2025-20026684` | terminal | yes | error | rejected: bad_asset_name,missing_tx_date,invalid_amount,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20026684.pdf` + open review row |
| `H-2025-20029135` | terminal | yes | error | rejected: bad_asset_name,missing_tx_date,invalid_amount,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20029135.pdf` + open review row |
| `H-2025-20030884` | terminal | yes | error | rejected: bad_asset_name,missing_tx_date,invalid_amount,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030884.pdf` + open review row |
| `H-2025-20030620` | terminal | yes | error | rejected: bad_asset_name,missing_tx_date,invalid_amount,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030620.pdf` + open review row |
| `H-2025-20030509` | terminal | yes | error | rejected: bad_asset_name,missing_tx_date,invalid_amount,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030509.pdf` + open review row |
| `H-2025-20016861` | terminal | yes | error | rejected: bad_asset_name,missing_tx_date,invalid_amount,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20016861.pdf` + open review row |
| `H-2025-20033610` | terminal | yes | error | rejected: bad_asset_name,missing_tx_date,invalid_amount,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20033610.pdf` + open review row |
| `H-2025-20032255` | terminal | yes | error | rejected: bad_asset_name,missing_tx_date,invalid_amount,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20032255.pdf` + open review row |
| `H-2025-8221302` | terminal | yes | error | rejected: local_vision_exhausted,scanned_pdf_vision_spend | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/8221302.pdf` + open review row |
| `H-2025-8221228` | terminal | yes | error | rejected: extraction_row_limit_exceeded | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/8221228.pdf` + open review row |
| `H-2025-9115684` | terminal | yes | error | rejected: invalid_amount,missing_tx_date,future_tx_date,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/9115684.pdf` + open review row |
| `H-2025-9115662` | terminal | yes | error | rejected: local_vision_exhausted,scanned_pdf_vision_spend | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/9115662.pdf` + open review row |
| `H-2025-9115677` | terminal | yes | error | rejected: extraction_row_limit_exceeded | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/9115677.pdf` + open review row |
| `H-2025-9115664` | terminal | yes | error | rejected: invalid_amount,missing_tx_date,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/9115664.pdf` + open review row |
| `H-2025-20030439` | terminal | yes | error | rejected: bad_asset_name,missing_tx_date,invalid_amount,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030439.pdf` + open review row |
| `H-2025-20027820` | terminal | yes | error | rejected: bad_asset_name,missing_tx_date,invalid_amount,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20027820.pdf` + open review row |
| `H-2025-20026696` | terminal | yes | error | rejected: bad_asset_name,missing_tx_date,invalid_amount,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20026696.pdf` + open review row |
| `H-2025-20033572` | terminal | yes | error | rejected: bad_asset_name,missing_tx_date,invalid_amount,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20033572.pdf` + open review row |
| `H-2025-20031011` | terminal | yes | error | rejected: bad_asset_name,missing_tx_date,invalid_amount,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20031011.pdf` + open review row |
| `H-2025-20028025` | terminal | yes | error | rejected: bad_asset_name,missing_tx_date,invalid_amount,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20028025.pdf` + open review row |
| `H-2025-20030692` | terminal | yes | error | rejected: bad_asset_name,missing_tx_date,invalid_amount,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030692.pdf` + open review row |
| `H-2025-8221173` | terminal | yes | error | rejected: extraction_row_limit_exceeded | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/8221173.pdf` + open review row |
| `H-2025-8220754` | terminal | yes | error | rejected: invalid_amount,missing_tx_date,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/8220754.pdf` + open review row |
| `H-2025-8221231` | terminal | yes | error | rejected: extraction_row_limit_exceeded | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/8221231.pdf` + open review row |
| `H-2025-9115671` | terminal | yes | error | rejected: extraction_row_limit_exceeded | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/9115671.pdf` + open review row |
| `H-2024-8220567` | terminal | yes | error | rejected: local_vision_exhausted,scanned_pdf_vision_spend | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2024/8220567.pdf` + open review row |
| `H-2024-8220203` | terminal | yes | error | rejected: local_vision_exhausted,scanned_pdf_vision_spend | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2024/8220203.pdf` + open review row |
| `H-2025-8220904` | terminal | yes | error | rejected: missing_tx_date,invalid_amount,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/8220904.pdf` + open review row |
| `H-2025-8221287` | terminal | yes | error | rejected: invalid_amount,missing_tx_date,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/8221287.pdf` + open review row |
| `H-2026-9116257` | terminal | yes | error | rejected: invalid_amount,missing_tx_date,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/9116257.pdf` + open review row |
| `H-2026-9116258` | terminal | yes | error | rejected: invalid_amount,missing_tx_date,no_amount,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/9116258.pdf` + open review row |
| `H-2026-9116260` | terminal | yes | error | rejected: invalid_amount,missing_tx_date,no_amount,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/9116260.pdf` + open review row |
| `H-2025-8221276` | terminal | yes | error | rejected: invalid_amount,missing_tx_date,no_amount,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/8221276.pdf` + open review row |
| `H-2025-9115679` | terminal | yes | error | rejected: extraction_row_limit_exceeded | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/9115679.pdf` + open review row |
| `H-2025-9115676` | terminal | yes | error | rejected: extraction_row_limit_exceeded | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/9115676.pdf` + open review row |
| `H-2025-8221124` | terminal | yes | error | rejected: extraction_row_limit_exceeded | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/8221124.pdf` + open review row |
| `H-2025-8220750` | terminal | yes | error | rejected: extraction_row_limit_exceeded | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/8220750.pdf` + open review row |
| `H-2025-20031014` | terminal | yes | error | rejected: missing_tx_date,invalid_amount,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20031014.pdf` + open review row |
| `H-2025-20033505` | terminal | yes | error | rejected: missing_tx_date,invalid_amount,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20033505.pdf` + open review row |
| `H-2025-20029028` | terminal | yes | error | rejected: missing_tx_date,invalid_amount,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20029028.pdf` + open review row |
| `H-2025-8220809` | terminal | yes | error | rejected: invalid_amount,missing_tx_date,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/8220809.pdf` + open review row |
| `H-2025-9115670` | terminal | yes | error | rejected: missing_tx_date,invalid_amount,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/9115670.pdf` + open review row |
| `H-2025-8220902` | terminal | yes | error | rejected: extraction_row_limit_exceeded | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/8220902.pdf` + open review row |
| `H-2025-8220753` | terminal | yes | error | rejected: extraction_row_limit_exceeded | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/8220753.pdf` + open review row |
| `H-2025-20030622` | terminal | yes | error | rejected: missing_tx_date,invalid_amount,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030622.pdf` + open review row |
| `H-2025-20030416` | terminal | yes | error | rejected: missing_tx_date,invalid_amount,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030416.pdf` + open review row |
| `H-2025-8220834` | terminal | yes | error | rejected: invalid_amount,missing_tx_date,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/8220834.pdf` + open review row |
| `H-2025-8221264` | terminal | yes | error | rejected: extraction_row_limit_exceeded | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/8221264.pdf` + open review row |
| `H-2025-20033628` | terminal | yes | error | rejected: missing_tx_date,invalid_amount,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20033628.pdf` + open review row |
| `H-2025-20030174` | terminal | yes | error | rejected: missing_tx_date,invalid_amount,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030174.pdf` + open review row |
| `H-2025-20028016` | terminal | yes | error | rejected: missing_tx_date,invalid_amount,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20028016.pdf` + open review row |
| `H-2025-8220796` | terminal | yes | error | rejected: missing_tx_date,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/8220796.pdf` + open review row |
| `H-2025-20030641` | terminal | yes | error | rejected: missing_tx_date,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030641.pdf` + open review row |
| `H-2024-8220192` | eligible | no | needs_review | agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2024/8220192.pdf` + open review row |
| `H-2025-20030181` | eligible | no | needs_review | agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030181.pdf` + open review row |
| `H-2024-8220320` | eligible | no | error | agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2024/8220320.pdf` + open review row |
| `H-2025-20026666` | eligible | no | needs_review | agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20026666.pdf` + open review row |
| `H-2025-20030466` | eligible | no | needs_review | agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030466.pdf` + open review row |
| `H-2024-20025111` | eligible | no | needs_review | invalid_amount,future_tx_date,low_confidence | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2024/20025111.pdf` + open review row |
| `H-2025-8221120` | eligible | no | error | agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/8221120.pdf` + open review row |
| `H-2024-8220177` | eligible | no | error | agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2024/8220177.pdf` + open review row |
| `H-2024-8220711` | eligible | no | error | agreement_cascade_unresolved | yes | clerk ZIP + `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2024/8220711.pdf` + open review row |

## 4. Senate official eFD classified (sitting, 90)

All 90 have `source_url` on `efdsearch.senate.gov` and stored raw.  They are official PTRs waiting for hosted extract, not dropped rows.

| doc_id | filed_date | source_url |
|---|---|---|
| `S-4430ac89-7784-4f2f-8417-2f0072874995` | 2021-08-16 | https://efdsearch.senate.gov/search/view/ptr/4430ac89-7784-4f2f-8417-2f0072874995/ |
| `S-4a7a7530-6012-4a41-8fbc-3c4842f9303e` | 2021-08-16 | https://efdsearch.senate.gov/search/view/ptr/4a7a7530-6012-4a41-8fbc-3c4842f9303e/ |
| `S-e3c66cc8-ca84-4899-b3dd-21a0a400ffc6` | 2021-08-13 | https://efdsearch.senate.gov/search/view/ptr/e3c66cc8-ca84-4899-b3dd-21a0a400ffc6/ |
| `S-1a756e7a-56c4-4406-8a4b-1f6c549bd17d` | 2021-09-15 | https://efdsearch.senate.gov/search/view/ptr/1a756e7a-56c4-4406-8a4b-1f6c549bd17d/ |
| `S-4ae9501c-7657-4472-b2f1-3a7179219dbd` | 2021-09-09 | https://efdsearch.senate.gov/search/view/ptr/4ae9501c-7657-4472-b2f1-3a7179219dbd/ |
| `S-a281e3d8-07ad-434d-a8e3-b596b997e55a` | 2021-09-08 | https://efdsearch.senate.gov/search/view/ptr/a281e3d8-07ad-434d-a8e3-b596b997e55a/ |
| `S-d6b9057a-9de9-4ec1-a210-31683309ded2` | 2021-10-28 | https://efdsearch.senate.gov/search/view/ptr/d6b9057a-9de9-4ec1-a210-31683309ded2/ |
| `S-a91110ad-2cfb-452a-99be-f49948aecc93` | 2021-10-26 | https://efdsearch.senate.gov/search/view/ptr/a91110ad-2cfb-452a-99be-f49948aecc93/ |
| `S-7c9634ee-7352-469f-b311-c3ee8b38ec8c` | 2021-11-23 | https://efdsearch.senate.gov/search/view/ptr/7c9634ee-7352-469f-b311-c3ee8b38ec8c/ |
| `S-36b58614-d07b-408b-8ff9-b5846cbe801d` | 2021-11-29 | https://efdsearch.senate.gov/search/view/ptr/36b58614-d07b-408b-8ff9-b5846cbe801d/ |
| `S-ffed6c7a-6f2d-43ef-bb8c-433704146f24` | 2021-11-25 | https://efdsearch.senate.gov/search/view/ptr/ffed6c7a-6f2d-43ef-bb8c-433704146f24/ |
| `S-16198565-5608-4bb4-837b-4b8a02e9a050` | 2021-11-19 | https://efdsearch.senate.gov/search/view/ptr/16198565-5608-4bb4-837b-4b8a02e9a050/ |
| `S-ac2ba9f8-2938-46be-a501-88910e9d2299` | 2021-12-22 | https://efdsearch.senate.gov/search/view/ptr/ac2ba9f8-2938-46be-a501-88910e9d2299/ |
| `S-1490bd57-e464-4fb8-8782-5c24eb1be1e1` | 2021-12-23 | https://efdsearch.senate.gov/search/view/ptr/1490bd57-e464-4fb8-8782-5c24eb1be1e1/ |
| `S-ef87390b-ab6c-433f-a852-838d02a1dd5a` | 2022-01-10 | https://efdsearch.senate.gov/search/view/ptr/ef87390b-ab6c-433f-a852-838d02a1dd5a/ |
| `S-69388a65-26f9-4be6-9f6f-1865fc1140f9` | 2022-01-18 | https://efdsearch.senate.gov/search/view/ptr/69388a65-26f9-4be6-9f6f-1865fc1140f9/ |
| `S-9c5c1a62-11f3-4542-887a-8012c8f35640` | 2022-01-07 | https://efdsearch.senate.gov/search/view/ptr/9c5c1a62-11f3-4542-887a-8012c8f35640/ |
| `S-c9da6bea-fa14-4a3a-9d8b-1745e834da59` | 2022-02-14 | https://efdsearch.senate.gov/search/view/ptr/c9da6bea-fa14-4a3a-9d8b-1745e834da59/ |
| `S-b21b9cd6-fd14-441c-8d7e-3f9193befb82` | 2022-03-29 | https://efdsearch.senate.gov/search/view/ptr/b21b9cd6-fd14-441c-8d7e-3f9193befb82/ |
| `S-3520c9a8-d39c-4f03-95ac-3a24e345444f` | 2022-04-13 | https://efdsearch.senate.gov/search/view/ptr/3520c9a8-d39c-4f03-95ac-3a24e345444f/ |
| `S-1d3a7fe5-fb35-4229-8ec2-f2caac84bb02` | 2022-05-16 | https://efdsearch.senate.gov/search/view/ptr/1d3a7fe5-fb35-4229-8ec2-f2caac84bb02/ |
| `S-5286dd41-6735-41b0-be8f-374d874c3ea3` | 2022-05-16 | https://efdsearch.senate.gov/search/view/ptr/5286dd41-6735-41b0-be8f-374d874c3ea3/ |
| `S-f86c5e38-2281-4197-9c09-1aa5bef13c16` | 2022-06-13 | https://efdsearch.senate.gov/search/view/ptr/f86c5e38-2281-4197-9c09-1aa5bef13c16/ |
| `S-5ecc9b5c-07c1-4ec1-bd4a-2db759eff299` | 2026-08-08 | https://efdsearch.senate.gov/search/view/ptr/5ecc9b5c-07c1-4ec1-bd4a-2db759eff299/ |
| `S-328a9b36-1205-4117-bdc4-cd7c3ccbcbbc` | 2026-08-07 | https://efdsearch.senate.gov/search/view/ptr/328a9b36-1205-4117-bdc4-cd7c3ccbcbbc/ |
| `S-64bae1ca-56a7-46cb-b6b1-19c49af27fc3` | 2022-08-19 | https://efdsearch.senate.gov/search/view/ptr/64bae1ca-56a7-46cb-b6b1-19c49af27fc3/ |
| `S-da98ff4a-4e03-4e8a-a824-c50a93e4a267` | 2022-08-18 | https://efdsearch.senate.gov/search/view/ptr/da98ff4a-4e03-4e8a-a824-c50a93e4a267/ |
| `S-ee5452a8-5c24-4044-8ffa-250971a8394c` | 2022-11-29 | https://efdsearch.senate.gov/search/view/ptr/ee5452a8-5c24-4044-8ffa-250971a8394c/ |
| `S-ebb82d27-2e1d-4c9f-baab-227c08aaf29a` | 2022-11-03 | https://efdsearch.senate.gov/search/view/ptr/ebb82d27-2e1d-4c9f-baab-227c08aaf29a/ |
| `S-0acee755-ed8e-4a93-8785-9946d8c49e03` | 2022-12-22 | https://efdsearch.senate.gov/search/view/ptr/0acee755-ed8e-4a93-8785-9946d8c49e03/ |
| `S-7c840533-d541-42ab-b8ca-361a1be272d2` | 2023-04-19 | https://efdsearch.senate.gov/search/view/ptr/7c840533-d541-42ab-b8ca-361a1be272d2/ |
| `S-4b312925-a9a6-48e1-baab-80010d8e2800` | 2023-04-13 | https://efdsearch.senate.gov/search/view/ptr/4b312925-a9a6-48e1-baab-80010d8e2800/ |
| `S-7fc6c207-7c6f-4d05-aae6-1f5b2f661252` | 2023-05-11 | https://efdsearch.senate.gov/search/view/ptr/7fc6c207-7c6f-4d05-aae6-1f5b2f661252/ |
| `S-5506edae-7d2f-4c33-a22e-7971200c6f0d` | 2023-08-14 | https://efdsearch.senate.gov/search/view/ptr/5506edae-7d2f-4c33-a22e-7971200c6f0d/ |
| `S-f9252211-a695-4c37-869a-0e223fce8d88` | 2023-09-22 | https://efdsearch.senate.gov/search/view/ptr/f9252211-a695-4c37-869a-0e223fce8d88/ |
| `S-de3cd462-f294-4333-a9b3-cccd64e711b2` | 2023-11-20 | https://efdsearch.senate.gov/search/view/ptr/de3cd462-f294-4333-a9b3-cccd64e711b2/ |
| `S-a33e00ac-46fe-4e2f-b8ed-d8be0e4ebe33` | 2024-05-10 | https://efdsearch.senate.gov/search/view/ptr/a33e00ac-46fe-4e2f-b8ed-d8be0e4ebe33/ |
| `S-d369c12b-5f90-43ad-86e0-204aae959e66` | 2024-08-19 | https://efdsearch.senate.gov/search/view/ptr/d369c12b-5f90-43ad-86e0-204aae959e66/ |
| `S-56ec1f7c-ec77-465a-a3c7-d70caf591e61` | 2024-08-19 | https://efdsearch.senate.gov/search/view/ptr/56ec1f7c-ec77-465a-a3c7-d70caf591e61/ |
| `S-9b782ca8-bf85-4256-bada-b6cca565e20f` | 2024-08-15 | https://efdsearch.senate.gov/search/view/ptr/9b782ca8-bf85-4256-bada-b6cca565e20f/ |
| `S-2596f23a-bfab-416a-8971-dab737a46efc` | 2024-08-15 | https://efdsearch.senate.gov/search/view/ptr/2596f23a-bfab-416a-8971-dab737a46efc/ |
| `S-73a99931-0e4a-4ca0-bf62-305fc0386998` | 2024-08-13 | https://efdsearch.senate.gov/search/view/ptr/73a99931-0e4a-4ca0-bf62-305fc0386998/ |
| `S-74b3fbf5-ed84-4f19-a378-9c38bedb47b7` | 2024-08-02 | https://efdsearch.senate.gov/search/view/ptr/74b3fbf5-ed84-4f19-a378-9c38bedb47b7/ |
| `S-e9bc4f11-1b55-444b-b198-78db5eb92d73` | 2024-09-16 | https://efdsearch.senate.gov/search/view/ptr/e9bc4f11-1b55-444b-b198-78db5eb92d73/ |
| `S-681ac8fb-7808-41f6-93a4-f5d792106f1b` | 2024-09-03 | https://efdsearch.senate.gov/search/view/ptr/681ac8fb-7808-41f6-93a4-f5d792106f1b/ |
| `S-b2cccee8-9ee6-4059-913b-ad68b28b6afb` | 2025-06-03 | https://efdsearch.senate.gov/search/view/ptr/b2cccee8-9ee6-4059-913b-ad68b28b6afb/ |
| `S-7605a180-48f8-45df-a715-f3ad0693bc0e` | 2025-07-16 | https://efdsearch.senate.gov/search/view/ptr/7605a180-48f8-45df-a715-f3ad0693bc0e/ |
| `S-9be0bf66-ca8a-4082-94f6-d51e1b56435d` | 2025-07-02 | https://efdsearch.senate.gov/search/view/ptr/9be0bf66-ca8a-4082-94f6-d51e1b56435d/ |
| `S-c07a01ce-c10e-4a5a-8ee9-ec9e1f366153` | 2025-07-01 | https://efdsearch.senate.gov/search/view/ptr/c07a01ce-c10e-4a5a-8ee9-ec9e1f366153/ |
| `S-218c16a3-d408-4cc0-aa89-08730d05dfc3` | 2025-08-18 | https://efdsearch.senate.gov/search/view/ptr/218c16a3-d408-4cc0-aa89-08730d05dfc3/ |
| `S-1d6d6efd-3e8b-4702-b437-20dd08c9bce0` | 2025-08-13 | https://efdsearch.senate.gov/search/view/ptr/1d6d6efd-3e8b-4702-b437-20dd08c9bce0/ |
| `S-85199603-1615-424e-ba12-801a5d8dd0f4` | 2025-08-13 | https://efdsearch.senate.gov/search/view/ptr/85199603-1615-424e-ba12-801a5d8dd0f4/ |
| `S-03e0a1db-2fe8-409f-ae3e-61ab61e14cae` | 2025-08-13 | https://efdsearch.senate.gov/search/view/ptr/03e0a1db-2fe8-409f-ae3e-61ab61e14cae/ |
| `S-f1058108-7055-4891-9a74-98eb4b670d65` | 2025-08-13 | https://efdsearch.senate.gov/search/view/ptr/f1058108-7055-4891-9a74-98eb4b670d65/ |
| `S-83d12cdb-288d-4937-91d3-31bbabbd3edb` | 2025-08-13 | https://efdsearch.senate.gov/search/view/ptr/83d12cdb-288d-4937-91d3-31bbabbd3edb/ |
| `S-000e724b-fb9a-4922-9011-ca8925a047f3` | 2025-08-13 | https://efdsearch.senate.gov/search/view/ptr/000e724b-fb9a-4922-9011-ca8925a047f3/ |
| `S-7b7c3053-b221-4d35-8538-a25c751f302c` | 2025-09-18 | https://efdsearch.senate.gov/search/view/ptr/7b7c3053-b221-4d35-8538-a25c751f302c/ |
| `S-16cc4156-6e05-4ccb-b223-7c05496a6dd8` | 2025-09-17 | https://efdsearch.senate.gov/search/view/ptr/16cc4156-6e05-4ccb-b223-7c05496a6dd8/ |
| `S-fc29dd5c-8fd0-4525-9aae-8f1e41c9337b` | 2025-09-01 | https://efdsearch.senate.gov/search/view/ptr/fc29dd5c-8fd0-4525-9aae-8f1e41c9337b/ |
| `S-c6456d94-2e65-4740-87e8-15f307c7e596` | 2025-10-30 | https://efdsearch.senate.gov/search/view/ptr/c6456d94-2e65-4740-87e8-15f307c7e596/ |
| `S-f29e80d0-cff1-4a0b-a856-635fb71b816a` | 2025-10-11 | https://efdsearch.senate.gov/search/view/ptr/f29e80d0-cff1-4a0b-a856-635fb71b816a/ |
| `S-70ec8a67-0057-40d2-b123-524323ae3c34` | 2025-10-10 | https://efdsearch.senate.gov/search/view/ptr/70ec8a67-0057-40d2-b123-524323ae3c34/ |
| `S-d1769517-09b2-4cca-8fc5-1d02e7803a45` | 2025-10-03 | https://efdsearch.senate.gov/search/view/ptr/d1769517-09b2-4cca-8fc5-1d02e7803a45/ |
| `S-b930d1b3-c58c-4b98-b28f-fc95c4a03bba` | 2025-11-07 | https://efdsearch.senate.gov/search/view/ptr/b930d1b3-c58c-4b98-b28f-fc95c4a03bba/ |
| `S-d33a714f-a45b-46f1-b155-59292b76300e` | 2025-12-12 | https://efdsearch.senate.gov/search/view/ptr/d33a714f-a45b-46f1-b155-59292b76300e/ |
| `S-a8f2bab8-0feb-49cf-b80f-9826cb4a7a4c` | 2026-01-30 | https://efdsearch.senate.gov/search/view/ptr/a8f2bab8-0feb-49cf-b80f-9826cb4a7a4c/ |
| `S-ab93dc59-4217-40a6-bee8-ba19deae027a` | 2026-02-13 | https://efdsearch.senate.gov/search/view/ptr/ab93dc59-4217-40a6-bee8-ba19deae027a/ |
| `S-e5e9e7aa-ffd0-4414-8d2e-1cb7592b9797` | 2026-04-08 | https://efdsearch.senate.gov/search/view/ptr/e5e9e7aa-ffd0-4414-8d2e-1cb7592b9797/ |
| `S-5245bd7a-a8b7-4d3e-8fb1-f563322da8f8` | 2026-05-28 | https://efdsearch.senate.gov/search/view/ptr/5245bd7a-a8b7-4d3e-8fb1-f563322da8f8/ |
| `S-3f315067-5f69-42b3-b32d-063ce735957b` | 2026-05-10 | https://efdsearch.senate.gov/search/view/ptr/3f315067-5f69-42b3-b32d-063ce735957b/ |
| `S-374c35de-6615-4f76-85b9-7f8922bdcc37` | 2026-05-06 | https://efdsearch.senate.gov/search/view/ptr/374c35de-6615-4f76-85b9-7f8922bdcc37/ |
| `S-dcea4793-9402-493b-8c92-ba4d77970c75` | 2026-05-01 | https://efdsearch.senate.gov/search/view/ptr/dcea4793-9402-493b-8c92-ba4d77970c75/ |
| `S-a9754ff5-901a-4877-b7be-a647bd361c52` | 2026-06-16 | https://efdsearch.senate.gov/search/view/ptr/a9754ff5-901a-4877-b7be-a647bd361c52/ |
| `S-115febfe-55cb-4f57-8452-71748371578b` | 2024-06-10 | https://efdsearch.senate.gov/search/view/ptr/115febfe-55cb-4f57-8452-71748371578b/ |
| `S-a7daa704-b0e4-4069-8ee4-d2dd854a4d33` | 2024-10-23 | https://efdsearch.senate.gov/search/view/ptr/a7daa704-b0e4-4069-8ee4-d2dd854a4d33/ |
| `S-c337b418-b154-457a-9fd1-147b2dbcb151` | 2024-11-21 | https://efdsearch.senate.gov/search/view/ptr/c337b418-b154-457a-9fd1-147b2dbcb151/ |
| `S-b16a2be7-815a-4451-a4a7-dce671fb5e8d` | 2024-11-20 | https://efdsearch.senate.gov/search/view/ptr/b16a2be7-815a-4451-a4a7-dce671fb5e8d/ |
| `S-4c8b14b5-10c1-4b0c-93dc-49886f76075c` | 2024-11-12 | https://efdsearch.senate.gov/search/view/ptr/4c8b14b5-10c1-4b0c-93dc-49886f76075c/ |
| `S-63d6b410-364c-479e-bc08-f51fb938c72a` | 2024-12-30 | https://efdsearch.senate.gov/search/view/ptr/63d6b410-364c-479e-bc08-f51fb938c72a/ |
| `S-d9c3a185-c62f-410b-96b7-ae662334ee39` | 2024-12-20 | https://efdsearch.senate.gov/search/view/ptr/d9c3a185-c62f-410b-96b7-ae662334ee39/ |
| `S-8d18c865-ecbd-4945-aacd-5df646910155` | 2024-12-03 | https://efdsearch.senate.gov/search/view/ptr/8d18c865-ecbd-4945-aacd-5df646910155/ |
| `S-f09fb0fe-7f70-434e-88c7-a43e96ee08a7` | 2025-01-22 | https://efdsearch.senate.gov/search/view/ptr/f09fb0fe-7f70-434e-88c7-a43e96ee08a7/ |
| `S-4ba30498-d6c3-4bc5-9a28-076d5cb7001f` | 2025-02-05 | https://efdsearch.senate.gov/search/view/ptr/4ba30498-d6c3-4bc5-9a28-076d5cb7001f/ |
| `S-684b4b5c-a37d-4465-b96a-974ef4dfd0bd` | 2025-03-17 | https://efdsearch.senate.gov/search/view/ptr/684b4b5c-a37d-4465-b96a-974ef4dfd0bd/ |
| `S-379b806a-8e3a-40ff-b363-bd95b247bc38` | 2025-03-03 | https://efdsearch.senate.gov/search/view/ptr/379b806a-8e3a-40ff-b363-bd95b247bc38/ |
| `S-ab543971-f3d5-447f-8dcf-ebe81ee1b908` | 2025-04-25 | https://efdsearch.senate.gov/search/view/ptr/ab543971-f3d5-447f-8dcf-ebe81ee1b908/ |
| `S-4481aa87-75c5-4c72-a204-431b74c56c4e` | 2025-04-24 | https://efdsearch.senate.gov/search/view/ptr/4481aa87-75c5-4c72-a204-431b74c56c4e/ |
| `S-b7c1a149-760f-4a4e-96a7-e2d689bccd2e` | 2026-03-28 | https://efdsearch.senate.gov/search/view/ptr/b7c1a149-760f-4a4e-96a7-e2d689bccd2e/ |
| `S-a27cbd70-4bc0-4e69-a444-387de64d14f8` | 2026-03-04 | https://efdsearch.senate.gov/search/view/ptr/a27cbd70-4bc0-4e69-a444-387de64d14f8/ |
| `S-12848a78-c94a-4813-9051-5b3063c718a9` | 2026-03-02 | https://efdsearch.senate.gov/search/view/ptr/12848a78-c94a-4813-9051-5b3063c718a9/ |

## 5. Official House PTRs stamped `not_found` that are now in 2026FD.ZIP (16)

Scout frontier-probe on 2026-07-30 labeled these phantom (then-max DocID 20035075).  The live Clerk ZIP now lists them.  Status is still `not_found`.  They were recorded, not ignored.  Do not mutate here.

- `H-2026-20035106`
- `H-2026-20035118`
- `H-2026-20035130`
- `H-2026-20035131`
- `H-2026-20035136`
- `H-2026-20035138`
- `H-2026-20035146`
- `H-2026-20035147`
- `H-2026-20035157`
- `H-2026-20035175`
- `H-2026-20035183`
- `H-2026-20035196`
- `H-2026-20035203`
- `H-2026-20035204`
- `H-2026-20035209`
- `H-2026-20035216`

## 6. Other accounted classes (not official silent drops)

- House probe phantoms: 881 `not_found` IDs absent from Clerk PTR ZIP (constructed clerk URLs).
- Senate errors: 85 official eFD URLs; 83 `fetcher: Unauthorized`.
- Executive errors: 296 official OGE URLs; 295 autonomy-sweep empty-extract reconcile.
- Orphan `needs_review`: 87 `provider-missing-*` stubs.
- Outbox DLQ: 316, same consumer-retry message.

Full IDs for senate errors, executive errors, and provider-missing orphans are in the JSON companion.

