# macOS Vision Worker (`com.congress.trade.vision-worker`)

Local vision worker for paper-scanned PTR / OGE filings.

## Engines

| Engine | How | Spend |
| --- | --- | --- |
| **`local_cli` (PRIMARY)** | Local `grok -p` headless CLI, authenticated via the owner's **xAI OIDC subscription** (`~/.grok/auth.json`). Renders PDF pages with `pdftoppm` and has Grok read the PNGs via multimodal `read_file`. | Subscription pool (no OpenRouter) |
| **`openrouter` (fallback)** | OpenRouter `x-ai/grok-4.5` with native PDF attachment | `CT_OPENROUTER_API_KEY` |
| **`auto` (default)** | Try `local_cli` first. On a missed solo pass (timeout, unparseable JSON, or 0 valid rows without `noRows`), cascade cheap OpenRouter VL: Qwen3-VL 8B → Qwen3-VL 30B-A3B (page images, never PDF/`mistral-ocr`) → Gemini 3.7 Flash PDF → `OPENROUTER_MODEL` (Grok 4.5 PDF) | subscription first, then cheap VL |

Kimi CLI was retired (hard provider billing 403). Do not reintroduce it.

## Features

- Heartbeats → `POST /api/admin/local-worker/heartbeat`
- Polls → `GET /api/admin/scanned-filings/pending` (**stored-copy only**: requires `raw_object_key`)
- Downloads → `GET /api/admin/filings/:docId/raw` (R2 bytes; **never** Clerk/eFD/OGE)
- After `pdftoppm`, portrait page images of landscape House PTRs are rotated upright (tesseract header score, else 270° CW) so Grok/Qwen see the grid instead of sideways pixels
- When a PDF has more pages than `MAX_PAGES` (Khanna attached-schedule packets, 15–34 pages), skip the local Grok CLI (it would only see 12 pages) and send the full PDF to Gemini/Grok in `PDF_NATIVE_CHUNK_PAGES` slices so later-page trades land
- After `pdftoppm`, portrait page images of landscape House PTRs are rotated upright when tesseract header phrases score a 90°/270° trial above the unrotated page.  Silent OCR and already-landscape pages stay put.
- PDF-native cascade (Gemini / Grok 4.5) attaches a rebuild from those upright PNGs, including pages past `MAX_PAGES`, not the original sideways scan
- Submits → `POST /api/admin/ingest-local-vision` (`source=local_mac`)

## Env

| Var | Default | Notes |
| --- | --- | --- |
| `VISION_ENGINE` | `auto` | `local_cli` \| `openrouter` \| `auto` |
| `GROK_BIN` | `~/.grok/bin/grok` | Local Grok Build CLI |
| `GROK_CLI_TIMEOUT_SEC` | `900` | Per-doc local CLI budget |
| `GROK_CLI_MAX_TURNS` | `16` | Floor; scaled `4+2*pages` (cap 32) |
| `GROK_CLI_REASONING_EFFORT` | `medium` | Do not inherit TUI `xhigh` |
| `GROK_CWD` | `<script>/grok-cwd` | Isolated cwd so `grok -p` does not load `AGENTS.md` |
| `OPENROUTER_API_KEY` | — | Required for openrouter / auto fallback |
| `OPENROUTER_MODEL` | `x-ai/grok-4.6` | Last cascade step (native PDF) |
| `OPENROUTER_CASCADE_MODELS` | `qwen/qwen3-vl-8b-instruct,qwen/qwen3-vl-30b-a3b-instruct,google/gemini-3.8-flash` | Tried after a missed Grok CLI solo pass, before `OPENROUTER_MODEL`. Qwen VL slugs receive raster pages. |
| `OPENROUTER_CASCADE_MAX_PAGES` | `8` | Cap images sent to VL models |
| `CONGRESS_TRADE_API_URL` | `http://localhost:8787` | Use `https://congress.trade` in launchd |
| `ADMIN_TOKEN` | — | `CT_ADMIN_TOKEN` from Infisical (`fleet-secrets get CT_ADMIN_TOKEN`) |
| `WORKER_ID` | `local_mac_1` | |
| `MAX_DOCS_PER_POLL` | `2` | Log line when pending > cap |
| `MAX_PAGES` | `12` | Cap page images sent to local CLI.  Auto engine skips CLI when the PDF is longer and goes PDF-native. |
| `PDF_NATIVE_CHUNK_PAGES` | `10` | Split long PDFs for Gemini/Grok native-PDF calls |
| `MAX_ATTEMPTS` | `3` | Per-doc retries before `local_vision_exhausted` park |
| `BACKOFF_BASE_SEC` | `90` | Exponential: base × 2^(attempt−1) between tries |
| `STATE_FILE` | `~/vision-worker/attempt-state.json` | Local attempt ledger |
| `EXHAUSTED_ALERT_THRESHOLD` | `5` | Pushover when parked count crosses |
| `PUSHOVER_APP_TOKEN` / `PUSHOVER_USER_KEY` | — | Publish + exhausted alerts only |

### Retry / park (defect fix 2026-08-10)

Unbounded re-attempts of the same 0-tx docs burned xAI subscription quota and
flooded Grok Build session history. That is a **defect**, not a tuning preference.

1. Each doc gets at most `MAX_ATTEMPTS` local-vision tries (download / transcription /
   zero-row / submit failure all count).
2. Between attempts: exponential backoff; worker logs `cap: backoff skip` / `cap: attempt failed`.
3. After exhaust: `POST /api/admin/local-vision-park` with honest class
   `local_vision_exhausted,scanned_pdf_vision_spend` (unresolved review row —
   lands in the #1575 vision-spend bucket; does **not** fake-resolve as rejected).
4. Pending query excludes parked docs so the spin stops.
5. Heartbeat continues when the queue is empty (lane never silently off).

**Grok CLI sessions:** there is no `--no-history` / ephemeral flag on `grok -p`
(verified 2026-08-10). Headless runs may still appear in the Grok Build chat list;
we do not hack around that.

### Batch selection (defect fix 2026-08-20)

The worker polls `GET /api/admin/scanned-filings/pending?worker=local` and picks
the first `MAX_DOCS_PER_POLL` **processable** docs (skipping exhausted and
backoff docs), then re-asserts the server-side park for exhausted docs whose
earlier park call failed.  Previously it took the raw head of the pending list
(server sorts newest first): two exhausted docs sat at the head, every poll
skipped them, and the rest of a 48-item backlog starved for days with zero
progress.  `?worker=local` also opts into the broad reclaim set — every
unresolved scanned review item (cascade disagreement, `extraction_row_limit`
garbage, low-confidence flags) is advertised to local vision, which is free
(subscription Grok CLI) and strictly better than the `server_cpu` OCR that
created those flags.  The Coolify CPU worker stays on the conservative set.

## Installation (launchd)

```bash
mkdir -p ~/vision-worker
cp services/vision-worker/worker.py ~/vision-worker/
cp services/vision-worker/run-vision-worker.sh ~/vision-worker/
chmod +x ~/vision-worker/run-vision-worker.sh ~/vision-worker/worker.py
cp services/vision-worker/com.congress.trade.vision-worker.plist ~/Library/LaunchAgents/
launchctl bootout gui/$(id -u)/com.congress.trade.vision-worker 2>/dev/null || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.congress.trade.vision-worker.plist
```

Confirm the owner is logged into Grok CLI (subscription) once:

```bash
grok -p "Reply: OK" --max-turns 1
```

## Logs

- stdout: `~/Library/Logs/com.congress.trade.vision-worker.log`
- stderr: `~/Library/Logs/com.congress.trade.vision-worker.err.log`
