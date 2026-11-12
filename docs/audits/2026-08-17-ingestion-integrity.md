# 2026-08-17 — Ingestion Integrity Audit

Read-only forensic audit of House, Senate, and OGE (Executive) discovery,
source-index fidelity, backfill, document fetch, OCR/text extraction, review
queues, dedupe, filed/traded dates, ownership, transaction normalization,
suppressed/skipped/failed/stranded states, provenance, and completeness by
chamber/year.

**This document does not mutate production.**  No queue drains, no review
Confirm/Reject, no halt acknowledge, no filings-hygiene apply, no backfill
POST, no schema write.  Live numbers are `SELECT` aggregates plus a public
Clerk ZIP GET.  Safety fixes for the OpenRouter 402 / review-catalog incident
belong on `cursor/prod-incident-audit-f506`; this report coordinates with that
work and does not duplicate it.

| Field | Value |
|---|---|
| Auditor | CURSOR (Cloud) |
| Branch | `cursor/ingestion-integrity-audit-bf95` |
| Live app sha | `be53b3e57109ef43812aec474cea6378dcf15887` |
| Evidence window | 2026-08-17 ~23:43–23:50Z |
| Public health | `GET /api/health` → `ok:true`, `db:true`, **`status:stalled`** |
| Clerk ZIP | `2026FD.ZIP` HTTP 200, 55,996 bytes, Last-Modified Mon 17 Aug 2026 13:00:12 GMT |

---

## 1. Executive summary

Discovery polling is live on all three chambers.  Senate relay is answering.
Review-resolution integrity and the 10-day stranded sweep are green.  The
pipeline is still **stalled** because extraction has not run since
2026-08-11T19:08Z and autopilot remains halted on a stored OpenRouter
files-endpoint 402 (prepaid minimum, not account quota).  That halt class is
the incident-audit lane; this report treats it as a **coverage freeze**, not a
new RCA.

The new integrity finding is **House DocID occupancy**:

The 2026-07-30 scout frontier probe inserted 897 `H-2026-20035076` …
`H-2026-20035975` rows and later stamped them `not_found`.  The Clerk has
since issued **real** periodic transaction reports (PTRs) that reuse sixteen
of those DocIDs (Beyer, Delaney, Guest, McClain, Doggett, Salazar, Taylor,
Rulli, Menefee, DelBene, Tran, Hern, Kelly ×2, McCormick, Bresnahan; filed
2026-08-01 … 2026-08-14).  `insertFilingIfNew` uses `INSERT OR IGNORE` and
upgrades only `provider_seeded` FMP placeholders.  A `not_found` hit returns
`duplicate`, so the official PDF is never fetched.  The watcher still
COALESCE-backfills `filed_date` and `filer_id` onto the phantom row, which
made #1577's "NULL not_found vs ZIP" check look clean.  Today's Clerk index
has **353** 2026 PTRs; official non-`not_found` rows are **337**.  Extra in
DB vs ZIP: **0**.  Missing official coverage: **16/353 (4.5%)**, all blocked
by `not_found`.

Secondary completeness picture (official rows only, excluding
`provider-missing-*` and House `not_found` unless named):

| Chamber | Discovery vs official index | Extraction / publish |
|---|---|---|
| House 2022–2025 | **100%** of Clerk PTR counts (624 / 460 / 451 / 515) | 2024–2025 extraction hole: 333 official `error`, almost all `scanned_pdf` with R2 raw |
| House 2021 | 271 rows; 5-year retention, not an index miss | 268 persisted |
| House 2026 | **337/353** Clerk PTRs; 16 occupied by `not_found` | 327 persisted / 10 error |
| Senate | No bulk archive.  833 official filings.  90 `classified` with raw since 2026-08-09 (under the 10-day stranded ceiling).  96 `filed_date` NULL (95 already persisted).  Historical 2021 count is far below Monet's 2026-08-10 eFD snapshot | 613 persisted / 129 error |
| Executive | Index discovery exists (331).  PAS scarcity is real; most rows are `scanned_pdf` | **35 persisted / 296 error** |

Public health reports review backlog **9**.  The table has **219**
`review_queue.resolved=0` rows; **210** are agreement-suppressed (mostly
House `error` + leftover `rejected:` reason text).  That eligible-vs-all
split is in scope for the incident audit.  This report records it as an
observability honesty gap.

---

## 2. Scope, keepouts, and coordination

### In scope

- House Clerk yearly FD ZIP + live search + scout frontier
- Senate eFD DataTables PTR search, 2,500-row cap, named-tunnel relay
- OGE President/VP + PAS 278-T indexes
- Seed / official / FMP-recovery backfills
- `fetcher.ts`, R2 `raw/{docId}`, outbox / DLQ
- Classifier, deterministic extractors, vision/OCR lanes, normalizer
- Review queue, resolution integrity, autonomy sweeps
- `row_key` dedupe, dates, owner, provenance
- Completeness by chamber × year against each source's own index

### Keepouts (do not steal)

| Lane | Why |
|---|---|
| `cursor/prod-incident-audit-f506` | Per-document review catalog, 402 key-identity RCA, halt paging, bounded files-prepaid resume, acknowledge UI.  No bulk Confirm/Reject. |
| PR #1959 `cursor/scanned-pdf-ocr-1575-691a` | Executive `OgePdfExtractor` / fail-soft OpenRouter vision for true scans |
| PR #1967 UX polish | Unrelated product chrome |
| Live `POST /api/admin/filings-hygiene` apply | Operator-owned after dry-run (#1574 / #1576) |
| `POST /api/admin/autopilot/acknowledge` | Incident-audit / owner |
| Deleting the 897 `not_found` rows | Production-intent; this report only names the 16 that must be **resurrected**, not mass-deleted |

### Method

1. Code and rollout review (`app/src/ingestion`, `extraction`, `extractors`,
   `backfill`, `admin/coverageScorecard.ts`, `shared/pipelineHealth.ts`,
   `docs/analysis/*`, `docs/rollouts/2026-08-17-*`).
2. Public `GET /api/health`, `/api/health/polling`, `/api/health/senate-relay`.
3. Read-only `POST /api/admin/debug-sql` aggregates (browser UA; token never
   logged).
4. Direct GET of `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/2026FD.ZIP`
   with production UA `congress-feed/0.1`, parse `{YEAR}FD.xml`, set-diff
   against official `H-2026-%` rows.

Coverage is **source-relative**: a chamber/year is complete only when every
document in that source's current index has a non-terminal-blocking filing
row and a honest terminal outcome (persisted trades, verified empty, or
error with raw + reason).  `GET /api/admin/coverage-scorecard` is **not**
that test.  It only checks internal mid-stage backlog and "docs with ≥1
transaction."  It will never see the 16 occupied House DocIDs.

---

## 3. Live evidence snapshot

### 3.1 Pipeline health (`GET /api/health`, 2026-08-17T23:43Z)

| Check | Status | Detail |
|---|---|---|
| `ingestion_backlog` | ok | Outbox pending 0 |
| `ingestion_dead_letter` | degraded | **316** failed outbox items |
| `extraction_provider` | stalled | 0 attempts / 24h; halt `error_class:billing` (OpenRouter files prepaid minimum; stored as quota) |
| `extraction_backlog` | ok | Review backlog **9** (eligible only) |
| `autopilot_halt` | stalled | Same billing/402 receipt; last extraction run 2026-08-11T19:08:27Z |
| `data_freshness` | degraded | Latest transaction created_at **149h** old (threshold 96h) |
| `review_resolution_integrity` | ok | Dishonest resolutions 0; orphaned `needs_review` 0 |
| `stranded_filings` | ok | 0 past the 10-day mid-pipeline ceiling |
| `polling_house` | ok | Last success 2m |
| `polling_senate` | ok | Last success 1m |
| `polling_executive` | ok | Last success 15m |
| `latency_probes` | degraded | Quiver 137h / Unusual Whales 100h quiet (vendor tokens; not this audit) |
| `senate_relay` | ok | `scout.jays.services` probed 35s ago |
| Litestream | replicating | Age 10.7s |
| Review desync (#1574 class) | **0** | `resolved=1` still mid-pipeline, excluding `provider-missing-%` |

### 3.2 Filing status mix (all rows)

| Chamber | persisted | error | needs_review | classified | not_found | provider_seeded |
|---|---:|---:|---:|---:|---:|---:|
| House | 2,473 | 429 | 91 | 0 | **897** | 0 |
| Senate | 613 | 129 | 1 | **90** | 0 | 52 |
| Executive | 35 | 296 | 0 | 0 | 0 | 0 |

House 2,473 persisted includes **175** `provider-missing-quiver-*` stubs.
Official House persisted is **2,298**.

### 3.3 Review queue

| Class | n |
|---|---:|
| `resolved=0` | 219 |
| of which `agreement_suppressed_at` IS NULL (eligible) | **9** |
| `resolved=1` published | 2,024 |
| `resolved=1` verified_empty | 975 |
| `resolved=1` rejected | 803 |
| `filings.ingest_status='needs_review'` | 92 (86 are `provider-missing-%`) |

Open-queue reasons (top): `rejected: agreement_cascade_unresolved` 131;
low-confidence / missing date / invalid amount clusters; `extraction_row_limit_exceeded` 12;
`local_vision_exhausted,scanned_pdf_vision_spend` 4.  The `rejected:` prefix
on **unresolved** rows is leftover reason text, not `resolution_kind`.

214 of 219 open rows sit on House filings already stamped `error`.  They are
not mid-pipeline stranded; they are a suppressed residual from the 2026-08-10
drain and later parks.

---

## 4. Discovery and source indexes

There is **no persisted source-index table**.  Completeness is "live fetch →
parse → `INSERT OR IGNORE` into `filings`."  `ingest_log` records successful
poll yield only.  `source_attempts` records success/failure.  Nightly
`runHouseReconciler` diffs current-ET-year Clerk XML vs DB and notifies; it
does **not** enqueue misses, and it treats `not_found` rows as present.

### 4.1 House

**Authoritative index:** `{YEAR}FD.ZIP` → `{YEAR}FD.xml` `<Member>` rows.
Only `FilingType === 'P'` is a PTR.  Doc id is `H-{year}-{DocID}`.

**Overlays:** intraday live search (FilingDate often omitted); scout frontier
HEAD probes; January prior-year ZIP overlap (`HOUSE_PRIOR_YEAR_OVERLAP_DAYS`,
default 14).

**Live watcher** (`pollHouse` in `app/src/ingestion/watcher.ts`) polls the
current ET year every successful cycle.  That is why 2024/2025 holes could
not self-heal after the 2026-07-24 capped crawl — the watcher never looks
back except in early January.

**#1577 (same day, different question):** Clerk ZIP is healthy.  Official
*persisted* House `filed_date` NULL is 0.  Remaining NULL dates are 881
`not_found` (still absent from the ZIP) + 90 Quiver stubs.  That diagnosis
stands.  It did **not** ask "does every ZIP PTR have a fetchable official
row?"  The 16 colliding ids already had `filed_date` backfilled, so they
fell out of the NULL set.

**P0 defect — `not_found` occupies the Clerk primary key.**

```269:325:app/src/ingestion/watcher.ts
export async function insertFilingIfNew(/* ... */) {
  // ...
  `INSERT OR IGNORE INTO filings
   (doc_id, chamber, filer_id, filing_type, filed_date, source_url,
    raw_object_key, ingest_status, doc_kind, /* ... */ )
   VALUES (?, ?, ?, 'P', ?, ?, NULL, 'new', ?, /* ... */)`
```

Upgrade exists only for `ingest_status='provider_seeded'` +
`extractor='fmp-senate-latest'`.  Duplicate `not_found` still receives
`filed_date` / `filer_id` COALESCE (lines 369–407) and returns `'duplicate'`.
No `filing.new` enqueue.  No raw.  House reconciler sees the id in both
maps → not `missed`, not `orphaned`.

Measured collision (ZIP 2026-08-17 13:00Z vs DB ~23:50Z):

| doc_id | Clerk FilingDate | Filer on row | Status | Raw |
|---|---|---|---|---|
| H-2026-20035106 | 2026-08-01 | house-va08-donald-sternoff-beyer | not_found | 0 |
| H-2026-20035118 | 2026-08-03 | house-md06-april-mcclain-delaney | not_found | 0 |
| H-2026-20035130 | 2026-08-14 | house-ms03-michael-patrick-guest | not_found | 0 |
| H-2026-20035131 | 2026-08-05 | house-mi09-lisa-mcclain | not_found | 0 |
| H-2026-20035136 | 2026-08-05 | house-tx37-lloyd-doggett | not_found | 0 |
| H-2026-20035138 | 2026-08-07 | house-fl27-maria-elvira-salazar | not_found | 0 |
| H-2026-20035146 | 2026-08-06 | MANUAL-TAYLOR | not_found | 0 |
| H-2026-20035147 | 2026-08-07 | house-oh06-michael-rulli | not_found | 0 |
| H-2026-20035157 | 2026-08-07 | MANUAL-MENEFEE | not_found | 0 |
| H-2026-20035175 | 2026-08-11 | house-wa01-suzan-k-delbene | not_found | 0 |
| H-2026-20035183 | 2026-08-13 | house-ca45-derek-tran | not_found | 0 |
| H-2026-20035196 | 2026-08-12 | house-ok01-kevin-hern | not_found | 0 |
| H-2026-20035203 | 2026-08-12 | house-pa16-mike-kelly | not_found | 0 |
| H-2026-20035204 | 2026-08-14 | house-ga06-richard-dean-dr-mccormick | not_found | 0 |
| H-2026-20035209 | 2026-08-12 | house-pa16-mike-kelly | not_found | 0 |
| H-2026-20035216 | 2026-08-12 | house-pa08-rob-bresnahan | not_found | 0 |

`first_seen_at` on every row is 2026-07-30T15:31–15:35Z (the probe burst).
Clerk dates are later.  The Clerk is still allocating DocIDs inside
`20035076…20035975`.  More collisions are likely as 2026 continues.

`sweepFiledDateBackfill` now skips `not_found` so the hourly job stops
re-fetching the ZIP for 881 true phantoms.  That is correct for date
invention.  It also means the sweep will never notice a phantom that
became real.

### 4.2 Senate

No bulk archive.  Discovery is CSRF + agreement + DataTables
`report_types=[11]`, 100 × 25 pages = **2,500-row cap**.  Live lookback
default 7d / max 30d plus a daily deep sweep.  Historical
`senateCrawler.ts` bisects saturated months.

`SENATE_RELAY_URL=https://scout.jays.services` is permanent.  Search and
`/fetch-doc` fall back to box eFD on Cloudflare 502–524.  Live probe at
audit time: relay **200**.  Residual risk: Imperva re-blocks datacenter
egress while the Mac origin is down → `polling_senate` fails.  Do not
"fix" that by rotating the URL.

Senate official totals: **833** filings (613 persisted, 129 error, 90
classified, 1 needs_review).  Plus 52 `provider_seeded` FMP placeholders
(upgrade path exists; good).

**90 `classified` Senate HTML rows** all have R2 raw, all first-seen
2026-08-09T22:56–23:08Z.  They are **not** stranded yet (10-day sweep).
They are frozen because extraction/autopilot is halted.  When the incident
lane resumes deterministic drain, these are the first free Senate publishes.

**96 Senate `filed_date` NULL**, 95 of them already `persisted`.  Official
eFD submitted date was not captured (or was lost) and nothing backfills it.
STOCK Act lag is NULL on those rows.

Year attribution (official, by `filed_date`; 95 persisted + 1 error have
NULL year and sit in 2026 `first_seen`):

| filed year | persisted | error | classified | vs Monet 2026-08-10 eFD snapshot |
|---|---:|---:|---:|---|
| 2021 | 22 | 7 | 14 | eFD ~145; Monet DB 143.  Now 43.  Likely 5-year retention + some NULL-date rows, not a new crawl hole |
| 2022 | 86 | 18 | 14 | Monet 136; now 118 official + 18 seeded |
| 2023 | 90 | 15 | 6 | Monet 130; now 111 + 19 seeded |
| 2024 | 96 | 13 | 17 | Monet 134; now 126 + 8 seeded |
| 2025 | 116 | 21 | 26 | Monet 168; now 163 + 5 seeded |
| 2026 | 108 | 54 | 13 | Monet 172 vs eFD 110 at the time; now 176 + 2 seeded + 95 NULL-date persisted |

Senate completeness **cannot** be proven from this VM against live eFD
without a session crawl (that would be a source fetch, not a mutation, but
it is the same path as backfill).  Use the next operator
`senate-backfill` dry-run / reconciler-equivalent to close the 2021–2025
index gap.  Do not treat seed_dataset rows as official coverage.

### 4.3 OGE / Executive

Two Domino views (President/VP + PAS).  `is278T` keeps 278-T and drops
annual 278s.  Cadence ~6h (`OGE_POLL_INTERVAL_SEC`).  Fail-soft; never
blocks House/Senate.  `OGE_WATCH_ENABLED` was off in prod through 2026-08-04
(#1607); polling is live now.

331 executive filings: **35 persisted, 296 error**.  272 of the errors are
`scanned_pdf`.  That is #1575, not a discovery miss.  Monet's 2026-08-10
note still holds: published PAS volume is small; the "dip" is mostly
extraction, not a missing index.

---

## 5. Backfills

| Path | What it is | Integrity notes |
|---|---|---|
| `POST /api/admin/backfill` | Community JSON → `transactions.source='seed_dataset'` | Archives R2 `seed/{chamber}/{ts}.json`.  Upsert cannot clobber `primary`.  House S3 seed URL 403s; do not use it as Clerk coverage |
| `POST /api/admin/house-backfill` | Official ZIP → live pipeline | Default `maxFilings=500`.  #1607: four 500-cap runs on 2026-07-24 stopped at 2024 index position 236; 2025 never started.  Later 800-cap run healed 2024/2025 **discovery**.  Caps without a checkpoint still truncate a year |
| `POST /api/admin/senate-backfill` | eFD windows + bisection | Same 2,500 cap; `maxFilings` default 500 / hard 5,000; `maxSourceQueries` default 50.  Continuation via `nextFromDate` |
| `POST /api/admin/oge-backfill` | Force OGE poll | `maxFilings` default 100 / cap 500 |
| `POST /api/admin/fmp-senate-recovery` | FMP → `provider_seeded` | Upgrade-on-official-discover is the only occupancy escape hatch today |

**Rule:** seed and competitor rows are provenance, not completeness.

---

## 6. Document fetch

`fetcher.ts`: skip if `review_queue.resolved=1`; Senate prefers
`/fetch-doc`; Cloudflare 502–524 → direct eFD; mirrored 404/403 stay on
relay.  HEAD 404 younger than 7 days retries (Clerk index leads PDF).
Stale 404 → terminal `error`.  Body cap 25 MiB.  R2 key `raw/{docId}`
before parse.

Outbox: 4,842 completed / **316 failed**, every failure
`consumer retry budget exhausted; received by ingest-dlq`.  Same class as
the 2026-08-14 publish-loop note (then 309).  Transient requeue is
scripted (`requeue-transient-dlq.mjs`) and is an **operator apply**, not
this PR.  Poison `filing.local_wait_check` stays failed by design.

House official `error` with raw: **349/355**.  Those PDFs are recoverable
without re-discovery.  Senate `classified` 90/90 have raw.  Executive
errors are mostly scans that never produced rows.

---

## 7. OCR / text extraction

Pipeline order (`buildExtractorPipeline`): Senate HTML → House PDF
(text first, vision if zero rows) → OGE text (`text_pdf` only) → generic
text PDF → vision/arbitration.

| Lane | When | Integrity risk |
|---|---|---|
| `SenateHtmlExtractor` | `doc_kind=senate_html` | Deterministic.  Frozen behind global halt (A2) |
| `HousePdfExtractor` + `TextPdfExtractor` | House text/scanned | Text-first is correct.  House `tx_date` is the **first** MM/DD/YYYY in the block (trade vs notification) |
| `OgeTextExtractor` | Executive `text_pdf` only | Scanned cabinet 278-Ts skip this.  #1959 adds fail-soft vision; do not duplicate here |
| `ConfiguredVisionExtractor` / OpenRouter files | Scans after local wait | 402 "≥ $0.50 balance for files" → `billing`.  Autopilot halt is global |
| `local_mac` | `extraction_pending_local` + heartbeat | Additive; exactLiveSet.  Mac offline → fallback |
| `server_cpu` Tesseract | Same pending API | Form-chrome invention.  A4 parks high garbage ratio; residual still exists |

Last `extraction_runs` row: 2026-08-11T19:08:27Z (8,326 historical runs).
Zero in the last 24h is why health is stalled, not because sources are down.

Classifier: `/Font` → `text_pdf`; image-only → `scanned_pdf`; local wait
15 minutes when heartbeat is fresh.

---

## 8. Review queues and stranded states

Typed `IngestStatus`: `new | fetched | classified | extraction_pending_local |
extracted | persisted | needs_review | verified_empty | error`.

Operational extras **not in the TypeScript union**: `not_found`,
`provider_seeded`.  Coverage scorecard's `complete` math also mentions
`rejected` / `empty` / `pending`, which are not live ingest statuses.
That union drift is a maintainability defect.

| State | Class | Live note |
|---|---|---|
| `persisted` | Terminal success | Official House 2,298; Senate 613; Exec 35 |
| `verified_empty` | Terminal empty | Review kind only; filings use the same stamp after reconcile |
| `error` | Terminal failure | Includes honest rejects **and** occupied `not_found` is a *different* terminal |
| `not_found` | Operational terminal | Must not be treated as "absent from universe" once the Clerk index contains the id |
| `provider_seeded` | Placeholder | Senate FMP; upgrade path works |
| `classified` | Mid | 90 Senate HTML with raw, age 8d |
| `extraction_pending_local` | Parked | 0 (desync class healed) |
| `needs_review` | Parked | 5 official House + 86 Quiver stubs + 1 Senate |
| `agreement_suppressed_at` | Parked cascade | 210 of 219 open queue rows |
| `local_vision_exhausted` | Parked spend | 4 open reasons |
| Outbox `failed` | DLQ | 316 transient-class |

#1574 desync (547 rows) is **0** on the hygiene query.  Hourly
`reconcileResolvedReviewStatus` mapping is `published→persisted`,
`rejected→error`, `verified_empty→verified_empty`.  Operator apply of
`POST /api/admin/filings-hygiene` is still the closeout for the probe id
and any leftover the sweep has not touched.  This audit did not apply it.

`review_resolution_integrity` is ok.  Health `extraction_backlog` uses
`countEligibleBacklog` (9), not `resolved=0` (219).  Incident audit owns
the catalog/UI honesty fix.  Integrity implication: operators can believe
the queue is quiet while 210 suppressed House errors still have raw and
may contain unpublished trades.

---

## 9. Dedupe

Live identity: `transactionRowKey` → `v1:{source}:{rowIndex}:{fnv1a32}` over
17 fields including owner, subholding, location, description, rawText
(`app/src/extraction/normalizer.ts`).  Unique live index
`(doc_id, source, row_key)` where not deprecated.

`INSERT OR IGNORE`; delivery outbox only for actually inserted keys.
`persistNormalizedPublish` CAS on the exact live set
(`primary|manual|local_mac|server_cpu`).

| Risk | Verdict |
|---|---|
| Trust-account splits (Harshbarger CHEGG lesson) | Mitigated: owner/subholding in the hash |
| Re-extract same index, changed fields | New hash → second live row unless amendment deprecates |
| Seed vs primary | Primary publish deprecates `seed_dataset` with `upgraded_by_primary`.  **7,797 live seed** and **47,941 competitor_backfill orphans** (no `filings` row) remain.  Feed must keep filtering deprecated + decide whether orphan competitor rows are product-visible |
| Arbitration merge key `ticker|txDate|txType` | Coarser than persistence; extract-time only |
| Occupied `not_found` | Discovery-level dedupe false positive: official DocID treated as already ingested |

---

## 10. Filed / traded dates

| Field | House | Senate | Executive |
|---|---|---|---|
| `filings.filed_date` | ZIP FilingDate.  Live search NULL until ZIP COALESCE.  Official persisted NULL **0**.  16 colliding `not_found` rows **have** Clerk dates and still will not fetch | eFD metadata.  **96 NULL** (95 persisted) | OGE poll; 74 error + 5 persisted NULL |
| `transactions.tx_date` | First date in House text block | Transaction Date column | 278-T DATE group |
| STOCK Act | `disclosure_lag_days` NULL if either date missing | Same | Same |

Do **not** invent `filed_date` from `tx_date` or `first_seen_at`.  #1577
already forbade that for phantoms and Quiver stubs.  The 16 colliding rows
already have honest Clerk dates; they need status resurrection + fetch, not
a date write.

House `tx_date` = first date is a known accuracy risk (notification date
can precede or follow the trade date on the same PTR line).

---

## 11. Ownership

Canonical enum: `self | spouse | joint | dependent`.  Normalizer drops
anything else to NULL.

Live official (`primary|manual|local_mac|server_cpu`, not deprecated):

| Chamber | self | spouse | joint | dependent | NULL |
|---|---:|---:|---:|---:|---:|
| House | 3,827 | 12,580 | 6,164 | 9,206 | 565 |
| Senate | 1,062 | 1,626 | 2,144 | 132 | 0 |
| Executive | 1,192 | 1 | 0 | 0 | 5 |

House text maps `SP/DC/JT/SELF` and defaults unmarked to `self`.  Senate
reads the Owner column.  OGE 278-T has no per-row owner (implicit filer).
The large NULL/unknown pile in the unfiltered owner mix is
**competitor_backfill orphans**, not official PTR loss.

565 House official NULL owners are a residual accuracy class (OCR / seed
upgrade / missing prefix), not a discovery miss.

---

## 12. Normalization

Gates: vision confidence 0.95; deterministic (`textPdf`, `senateHtml`,
`ogeText`) 0.55 (P0 A1).  Hard flags: `missing_tx_date`, `future_tx_date`,
true `invalid_amount` (A3 skips false mismatch when the structured bracket
is already canonical).  Form-chrome filter drops Clerk letterhead before
scoring (A4).  `>200` rows or mostly-garbage OCR → review / empty failure,
not publish.

`canonicalizeTxType` coerces P/purchase → B.

Needs-review if zero rows, low min confidence, hard failures, or row-limit
garbage.  Agreement cascade still requires a second paid model for
non-deterministic docs; global halt blocks that path (A2, incident lane).

---

## 13. Provenance

| Artifact | Contract |
|---|---|
| R2 `raw/{docId}` | Written before parse.  16 colliding House PTRs have **no** raw |
| R2 `seed/{chamber}/{ts}.json` | Seed verbatim archive |
| `transactions.source` | `primary \| seed_dataset \| manual \| competitor_backfill \| local_mac \| server_cpu` |
| `filings.extractor` / `model_version` | Last successful engine |
| `extraction_runs` | Per-model bakeoff/production/agreement |
| `ingestion_decisions` | auto_published / review_opened / admin resolve |
| Agreement publishes | Stay `source='primary'` |

House official publish mix is **manual-heavy** (22,859 manual vs 9,204
primary vs 279 local_mac).  That is the 2026-08-10 no-OpenRouter drain
showing up in provenance: correct trades, not deterministic autopublish.
Senate is primary-dominated (4,764 primary / 200 manual / 664 live seed).
Executive is almost entirely `manual` + `local_mac` (1,140 + 53 vs 5
primary).

---

## 14. Completeness by chamber / year

### Methodology (this audit)

1. **House:** parse live `{YEAR}FD.xml` PTRs (`FilingType=P`) → set-diff
   `H-{year}-{DocID}` against `filings` where `ingest_status <> 'not_found'`.
   `not_found` in both maps is a **miss**, not a hit.  2022–2025 compared to
   Monet's 2026-08-10 Clerk counts (ZIP not re-pulled for those years in this
   pass; watcher does not poll them).  2026 compared to today's ZIP.
2. **Senate:** no public bulk file.  Report official row counts by
   `filed_date` year and flag NULL-date persisted rows.  Index parity needs
   an eFD dry-run (operator).
3. **Executive:** count discovered 278-T rows vs persisted.  Do not treat
   low PAS volume as an app gap.
4. **Scorecard:** `complete` is internal consistency only.  Do not quote it
   as world coverage.

### House official (exclude `not_found` and `provider-missing-*`)

| Year | Official rows | persisted | error | needs_review | Clerk PTR index | Discovery |
|---|---:|---:|---:|---:|---:|---|
| 2021 | 271 | 268 | 3 | 0 | Retention window (not full-year) | Designed |
| 2022 | 624 | 621 | 3 | 0 | 624 | **Complete** |
| 2023 | 460 | 454 | 6 | 0 | 460 | **Complete** |
| 2024 | 451 | 340 | 109 | 2 | 451 | **Complete**; extract 75% persisted |
| 2025 | 515 | 288 | 224 | 3 | 515 | **Complete**; extract 56% persisted |
| 2026 | 337 | 327 | 10 | 0 | **353** (today) | **16 blocked (4.5%)** |

House official `error` by kind: 2024 scanned 105 + text 4; 2025 scanned 214
+ text 10; 2026 scanned 4 + text 6.  **349/355 have R2 raw.**  This is the
#1575 / A5 recovery corpus, not a ZIP problem.

### Senate official (exclude `provider_seeded`)

833 filings.  613 persisted (73.6%).  90 classified-with-raw waiting on
halt lift.  129 error.  96 missing `filed_date`.  Index-complete claim:
**not proven** without a bounded eFD census.

### Executive

| Year | persisted | error | Dominant error kind |
|---|---:|---:|---|
| 2020 | 0 | 19 | text_pdf |
| 2021 | 1 | 49 | mixed scan/text |
| 2022 | 3 | 32 | scanned_pdf |
| 2023 | 3 | 35 | scanned_pdf |
| 2024 | 1 | 18 | scanned_pdf |
| 2025 | 10 | 48 | scanned_pdf |
| 2026 | 17 | 95 | scanned_pdf |

Publish coverage **10.6%** of discovered executive filings.  Discovery is
not the bottleneck.

### Transaction corpus (live, not deprecated)

| Chamber | Rows (approx) | Notes |
|---|---|---|
| House official sources | 32,342 | manual-heavy |
| Senate official + seed | 5,628 | primary-heavy |
| Executive | 1,198 | manual/local |
| Orphan competitor_backfill | 47,941 | no filings row |
| Orphan / unattached seed | 7,133 | `docs=1` join artifact + leftover seed ids |

Latest official `tx_date` 2026-08-05; latest `filed_date` on a live tx
2026-08-10; latest `created_at` 2026-08-11.  Matches the 149h freshness
check.  Polling is live; **publication is not**.

---

## 15. Per-class failure risks

Severity: **P0** blocks official documents from entering the fetch/extract
path now.  **P1** loses trades or dates on documents we already hold, or
will lose the next Clerk collision.  **P2** is honesty/ops.  **P3** is
hygiene.

| ID | Class | Sev | Failure mode | Evidence |
|---|---|---|---|---|
| H1 | Discovery occupancy | **P0** | `not_found` PK blocks later official House PTRs | 16/353 2026 ZIP ids; no raw; INSERT OR IGNORE + no upgrade |
| H2 | Reconciler blind spot | **P0** | Nightly House diff treats occupied ids as present | `houseReconciler.ts` loads all `H-{year}-%` including `not_found` |
| H3 | Date-sweep skip | P1 | Skipping `not_found` is right for phantoms, wrong for resurrected Clerk ids | `autonomySweeps.ts` `ingest_status != 'not_found'` |
| H4 | Frontier probe | P1 | Sequential DocID speculation will collide again | Range `20035076–20035975` still receiving Clerk PTRs |
| H5 | Historical crawl cap | P2 | `maxFilings=500` without year checkpoint | #1607 2024/2025 miss; healed for those years |
| S1 | No bulk index | P1 | Completeness depends on lookback + 2,500 cap + relay | 833 official; 2021 << historical eFD |
| S2 | Halt freeze | P1 | 90 Senate HTML `classified`+raw idle | first_seen 2026-08-09; extraction 0/24h |
| S3 | NULL filed_date | P1 | 95 persisted Senate rows have no STOCK Act clock | SQL `filed_date` NULL |
| S4 | Host dependency | P2 | Sleeping Mac + Imperva = Senate fail | Rollout 2026-08-17; relay was 200 at audit time |
| E1 | Scanned 278-T | P1 | 296/331 executive error, 272 scans | #1575 / PR #1959 |
| E2 | OGE enable gate | P2 | Polling can be silently off | Fixed 2026-08-10; health now loud |
| X1 | Global autopilot halt | P1 | Deterministic lanes wait on OR files 402 | Health `billing` rewrite; still halted |
| X2 | Outbox DLQ | P1 | 316 retry-exhausted `filing.*` | Same class as 2026-08-14 (309) |
| X3 | Review eligible vs all | P2 | Health 9 vs table 219 | `countEligibleBacklog`; incident audit |
| X4 | server_cpu chrome | P1 | Invented letterhead rows | Drain lessons; A4 partial |
| X5 | House first-date | P2 | Trade vs notification | `textPdf.ts` `dates[0]` |
| X6 | Status union drift | P3 | `not_found` / `provider_seeded` not in `IngestStatus` | `types.ts` vs prod SQL |
| X7 | Scorecard honesty | P2 | `complete` ≠ official-index complete | `coverageScorecard.ts` notes |
| X8 | Orphan competitor/seed | P2 | 55k txs without a filing | Join counts |
| X9 | Provider-missing stubs | P3 | 335 House Quiver placeholders; 90 persisted NULL dates | Honest; do not ZIP-backfill |
| X10 | Manual provenance share | P2 | House publish is mostly admin confirm | 22.8k manual vs 9.2k primary |

---

## 16. Fixes and upgrades (do not apply from this PR)

Ordered for a **separate** implementation branch after the incident lane
unblocks halt/billing.  Prefer small PRs.  Production-intent for any
`UPDATE filings` / enqueue.

### P0 — Unblock official House DocIDs

1. **Upgrade `not_found` when the official index rediscovers the id**
   (mirror the `provider_seeded` block in `insertFilingIfNew`):
   if `ingest_status='not_found'` and the discovery has a Clerk
   `source_url` + `filed_date`, set `ingest_status='new'`, clear `error`,
   keep or refresh `filer_id` / `filed_date`, enqueue `filing.new`.
   Do not upgrade ids that are still absent from the ZIP.
2. **House reconciler:** treat `not_found` as **absent** for the `missed`
   set.  Optionally auto-enqueue those misses instead of notify-only.
3. **One-time resurrection (operator):** the 16 ids in §4.1.  Dry-run
   list → apply upgrade → fetch → extract.  Do **not** `DELETE` the other
   881 phantoms in the same transaction.  #1576-class delete remains
   exact-doc_id and refuse-if-transactions.
4. **Stop sequential frontier inserts** from ever taking a Clerk-shaped
   PK without a 200 PDF (already partly gated in `detectionRoutes.ts`).
   Add a server-side "id reserved as not_found" reopen test.

### P1 — Extraction completeness on documents we already have

5. After incident-audit halt resume: **deterministic drain** of 90 Senate
   `classified` HTML and any House `text_pdf` still in review/error with
   raw (A1/A2).  No OpenRouter required.
6. **Local-vision / improved scan-cpu SLA** for 349 House official errors
   with raw + executive scanned corpus (#1575 / A5).  Leave #1959 as the
   executive vision PR.
7. **Senate `filed_date` backfill** from eFD metadata on rediscovery
   (COALESCE only; never from `tx_date`).
8. Dry-run **transient outbox requeue** for the 316 DLQ rows (existing
   script).  Poison `local_wait_check` stays failed.
9. Operator **filings-hygiene apply** after dry-run (#1574/#1576) — already
   coded; this audit only confirms desync count is 0.

### P2 — Honesty and completeness instrumentation

10. Extend `coverage-scorecard` (or a sibling `index-parity` report) with
    House ZIP set-diff that **excludes** `not_found` from the "we have it"
    side and lists `missed_official` ids.
11. Health: expose `review_unresolved_all` next to eligible (incident
    audit may already be doing this).
12. Add `not_found` and `provider_seeded` to `IngestStatus` (or map them
    in one place) so typecheck and scorecard agree with prod.
13. Senate year census: admin dry-run that pages eFD by submitted-date
    month and reports missing `pipelineDocId`s without inserting.
14. House backfill: persist a per-year cursor so `maxFilings` cannot
    silently stop mid-index again.
15. Decide product visibility of 47,941 orphan `competitor_backfill` rows.

### P3 — Hygiene

16. Quiver `provider-missing-*` matching (B6) — attach or drop; do not
    invent Clerk dates.
17. Optional delete of **true** phantom `not_found` ids still absent from
    2024–2026 ZIPs, after the upgrade path is live so a late Clerk reuse
    cannot be lost.
18. Form-chrome shared rule pack (C1) on any remaining `server_cpu` path.

---

## 17. What this audit did not do

- No production writes, acknowledges, or backfills.
- No 2024/2025 ZIP re-download (used Monet's verified Clerk PTR counts plus
  today's 2026 ZIP).
- No live eFD session census (would exercise the Senate relay path).
- No R2 HEAD of every `raw_object_key` (sampled via SQL nullness only).
- No per-document review of the 16 blocked PTRs' PDF contents.
- No change to halt/billing knobs or review Confirm/Reject.

---

## 18. Suggested next owner actions

1. Incident lane: keep halt/402/review-catalog work on
   `cursor/prod-incident-audit-f506`.  When extraction resumes, drain the
   90 Senate HTML classified rows first (free, official, already fetched).
2. New slice (not this PR): `not_found` → official upgrade + reconciler
   miss semantics + dry-run resurrection of the 16 ids in §4.1.
3. Owner/operator: dry-run filings-hygiene and transient DLQ requeue when
   ready; do not batch-delete 897 `not_found` rows.
4. Close or update #1577 / #1607 with the occupancy finding: ZIP is
   healthy; 2024/2025 discovery is complete; **2026 official coverage is
   not**, for a PK reason those issues did not ask.

---

## Appendix A — Evidence queries (read-only)

Admin `debug-sql` used browser UA.  Representative statements:

```sql
-- House official year mix
SELECT substr(doc_id,3,4) AS yr, COUNT(*) AS n,
       SUM(ingest_status='persisted'), SUM(ingest_status='error')
FROM filings
WHERE chamber='house' AND doc_id LIKE 'H-____-%' AND ingest_status <> 'not_found'
GROUP BY 1;

-- Occupied official ids (after ZIP set-diff)
SELECT doc_id, ingest_status, filed_date, filer_id, raw_object_key
FROM filings WHERE doc_id IN (/* 16 H-2026-20035… */);

-- Review eligible vs all
SELECT
  (SELECT COUNT(*) FROM review_queue WHERE resolved=0) AS unresolved,
  (SELECT COUNT(*) FROM review_queue
    WHERE resolved=0 AND agreement_suppressed_at IS NULL) AS eligible;

-- #1574 desync
SELECT COUNT(*) FROM filings f
JOIN review_queue rq ON rq.doc_id=f.doc_id AND rq.resolved=1
WHERE f.ingest_status IN
  ('new','fetched','classified','extraction_pending_local','extracted','needs_review','published')
  AND f.doc_id NOT LIKE 'provider-missing-%';
```

Clerk: `GET 2026FD.ZIP` → 1,553 members / 353 PTRs / 0 empty PTR FilingDate /
date range 1/1/2026–8/7/2026 in the XML `FilingDate` field (US `M/D/YYYY`).
Note: several of the 16 misses carry FilingDate after 8/7/2026 in the same
file (8/11–8/14); the XML date field is not strictly sorted.  All 16 are
`FilingType=P` with DocIDs.

## Appendix B — Related artifacts

- `docs/rollouts/2026-08-17-house-fd-zip-1577.md`
- `docs/rollouts/2026-08-17-filings-hygiene-probe-and-desync.md`
- `docs/rollouts/2026-08-17-senate-relay-host-dependency.md`
- `docs/rollouts/2026-08-14-publish-loop-halt-class.md`
- `docs/rollouts/2026-08-10-review-queue-drain-no-openrouter.md`
- `docs/analysis/2026-08-10-review-queue-drain-lessons.md`
- `docs/analysis/2026-08-02-ingestion-pipeline-improvements.md`
- Issues #1574, #1575, #1576, #1577, #1604, #1607
