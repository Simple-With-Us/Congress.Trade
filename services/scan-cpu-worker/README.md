# Server CPU scan worker (`scan-cpu-worker`)

Linux/ARM64 Coolify service that extracts **scanned House PTR checkbox forms**
with **no Mac** and **no LLM**:

| Stage | Engine | Notes |
|-------|--------|--------|
| Page render | `pdftoppm` (poppler) | PDF → PNG pages |
| Text OCR | **Tesseract** (default) | Asset names, dates; optional **Surya** / **docTR** backends |
| Checkboxes | **Deterministic CV** | Align/grid → ROI crop → binarize → **ink pixel ratio** |
| Ingest | same admin API as Mac worker | `POST /api/admin/ingest-local-vision` with `source=server_cpu` |

Why not an LLM? Paper PTR type/amount are **X marks**, not words. Probabilistic
vision models confuse borders/text for marks. A fixed template + ink-ratio
threshold is repeatable on any Coolify host.

## Chassis (shared with Mac vision-worker)

1. Heartbeat → `POST /api/admin/local-worker/heartbeat` (`workerId=server_cpu_1`)
2. Poll → `GET /api/admin/scanned-filings/pending`
3. Download stored bytes only → `GET /api/admin/filings/:docId/raw` (never source_url)
4. Extract → submit → `POST /api/admin/ingest-local-vision`

When any worker heartbeat is fresh, classifier parks scanned filings in
`extraction_pending_local` for 15 minutes before LLM fallback.

## Run (Docker, Coolify-friendly)

```bash
cd services/scan-cpu-worker
docker build -t congress-scan-cpu-worker .
docker run --rm \
  -e CONGRESS_TRADE_API_URL=https://congress.trade \
  -e ADMIN_TOKEN=… \
  -e WORKER_ID=server_cpu_1 \
  -e OCR_BACKEND=tesseract \
  -e CHECKBOX_INK_RATIO=0.10 \
  congress-scan-cpu-worker
```

### Env

| Var | Default | Meaning |
|-----|---------|---------|
| `CONGRESS_TRADE_API_URL` | `http://localhost:8787` | App base URL |
| `ADMIN_TOKEN` | (optional env) | Admin bearer; if unset, fetched at boot from Infisical (`INFISICAL_APP_*`) |
| `WORKER_ID` | `server_cpu_1` | Heartbeat id |
| `POLL_INTERVAL_SEC` | `30` | Poll loop |
| `OCR_BACKEND` | `tesseract` | `tesseract` \| `surya` \| `doctr` |
| `CHECKBOX_INK_RATIO` | `0.10` | Dark-pixel fraction → checked |
| `MIN_CONFIDENCE` | `0.75` | Below → still submit; normalizer may review |
| `DPI` | `200` | PDF render DPI |

## Local one-shot (dev)

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
# brew install tesseract poppler  # macOS; apt on Linux
python worker.py --once --pdf /path/to/sample.pdf --doc-id H-TEST
```

## OCR backends

1. **Tesseract** (default) — CPU-only, tiny RAM, weak on handwriting/dense grids
   but fine for typed asset columns after upright rotation.
2. **Surya** (optional extra) — stronger layout/line detection; still CPU-capable.
3. **docTR** (optional extra) — PyTorch CPU; better than Tesseract on noisy type.

Install extras only if needed: `pip install -r requirements-optional.txt`.

## Deterministic checkbox algorithm

1. Deskew / pick upright rotation (OCR keyword score or EXIF).
2. Detect row lattice + vertical column lines (projection profiles).
3. For each data row × type/amount column cell:
   - Crop cell, inset border (mask printed box lines).
   - Otsu (or fixed) threshold → binary.
   - Morphological open to kill speckles.
   - `ink_ratio = dark_pixels / interior_pixels`.
   - Checked if `ink_ratio >= CHECKBOX_INK_RATIO` (default 10%).
4. Map type columns → `P|S|E`, amount columns → brackets A–J/K with printed ranges.
5. Pair with OCR text in the asset/date ROIs of the same row.

## Relation to Mac vision-worker

| | Mac `vision-worker` | Server `scan-cpu-worker` |
|--|---------------------|-------------------------|
| Host | macOS launchd | Coolify Docker (Oracle ARM64) |
| OCR | Vision.framework / kimi-cli | Tesseract / Surya / docTR |
| Checkboxes | local vision / kimi | **pixel ink ratio only** |
| Cost | $0 API | $0 API |
| Goal | best local quality | **always-on server path** |

Both post to the same ingest route. Prefer Mac when heartbeat fresh; server
worker can run in parallel as a second heartbeat (or as the only worker in prod).

## Limitations (honest)

- Handwritten asset names remain hard for Tesseract — flag low OCR confidence.
- Form variants (digital FD HTML-to-PDF vs paper grid) need separate templates.
- Dense multi-trust pages may need human review when confidence low.
- This is **not** a full replacement for the swarm quality bar on day-1; ship as
  primary server path with mechanical validation + review queue, same as Mac lane.
