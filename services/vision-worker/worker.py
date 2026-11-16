#!/usr/bin/env python3
"""
macOS local vision worker for Congress.Trade
Service: com.congress.trade.vision-worker

Polls the app for pending scanned_pdf filings, transcribes them with Grok
vision, and posts ParsedTx-shaped rows to /api/admin/ingest-local-vision
(normalize pipeline, source='local_mac').

Engines (VISION_ENGINE):
  local_cli   — PRIMARY. Local `grok -p` headless CLI, authenticated via the
                owner's xAI OIDC subscription (~/.grok/auth.json). Renders PDF
                pages with pdftoppm and has Grok read the PNGs via read_file
                vision. $0 OpenRouter / API-key spend.
  openrouter  — OpenRouter x-ai/grok-4.5 with native PDF file attachment.
                Uses CT_OPENROUTER_API_KEY. Kept as fallback / secondary path.
  auto        — try local_cli first. On a missed solo pass (timeout, parse
                fail, or 0 valid rows without noRows) cascade cheap OpenRouter
                VL models (Qwen3-VL page images, then Gemini Flash PDF, then
                grok-4.5 PDF). PDF-native steps attach an upright rebuild of
                every rendered page, not the original sideways scan. Never
                send Qwen a PDF file attachment — that bills mistral-ocr.

Kimi CLI was retired (provider billing 403). Do not reintroduce it.

Env:
  CONGRESS_TRADE_API_URL   (default http://localhost:8787)
  ADMIN_TOKEN              (admin bearer for the app)
  WORKER_ID                (default local_mac_1)
  POLL_INTERVAL_SEC        (default 30)
  HEARTBEAT_INTERVAL_SEC   (default 60)
  VISION_ENGINE            (auto|local_cli|openrouter, default auto)
  GROK_BIN                 (default: which grok / ~/.grok/bin/grok)
  GROK_CLI_TIMEOUT_SEC     (per-doc local CLI budget, default 900)
  GROK_CLI_MAX_TURNS       (floor, default 16; scaled 4+2*pages, cap 32)
  GROK_CLI_REASONING_EFFORT (default medium — not the TUI xhigh default)
  GROK_CWD                 (isolated dir without AGENTS.md; default <script>/grok-cwd)
  OPENROUTER_API_KEY       (required only for openrouter / auto fallback)
  OPENROUTER_MODEL         (default x-ai/grok-4.5) — last cascade step
  OPENROUTER_CASCADE_MODELS  comma list tried AFTER a missed Grok CLI solo
                           pass, before OPENROUTER_MODEL. Default:
                           qwen/qwen3-vl-8b-instruct,qwen/qwen3-vl-30b-a3b-instruct,google/gemini-3.7-flash
  OPENROUTER_CASCADE_MAX_PAGES  cap images sent to VL models (default 8).
                           A hit that did not see every PDF page is not
                           terminal — cascade continues to Gemini/Grok.
  OPENROUTER_TIMEOUT_SEC   (default 600)
  MAX_DOCS_PER_POLL        (default 2)
  MAX_PAGES                (default 12 — cap page images sent to local CLI)
  PDF_NATIVE_CHUNK_PAGES   (default 10 — split long PDFs for Gemini/Grok)
  MAX_ATTEMPTS             (default 3 — per-doc local-vision retries before park)
  BACKOFF_BASE_SEC         (default 90 — exponential: base * 2^(attempt-1))
  STATE_FILE               (default ~/vision-worker/attempt-state.json)
  EXHAUSTED_ALERT_THRESHOLD (default 5 — Pushover when parked count crosses)
  PUSHOVER_APP_TOKEN / PUSHOVER_USER_KEY  (optional; publish + exhausted alerts)

Defect fix (2026-08-10): unbounded re-attempts of the same 0-tx docs burned
xAI subscription quota and flooded Grok Build session history. Max attempts
+ exponential backoff + honest local_vision_exhausted park are mandatory.
"""

from __future__ import annotations  # py3.9: lazy annotations (dict | None etc.)

import base64
import fcntl
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("vision-worker")

API_BASE_URL = os.getenv("CONGRESS_TRADE_API_URL", "http://localhost:8787").rstrip("/")
ADMIN_TOKEN = os.getenv("ADMIN_TOKEN", "")
WORKER_ID = os.getenv("WORKER_ID", "local_mac_1")
POLL_INTERVAL_SEC = int(os.getenv("POLL_INTERVAL_SEC", "30"))
HEARTBEAT_INTERVAL_SEC = int(os.getenv("HEARTBEAT_INTERVAL_SEC", "60"))
VISION_ENGINE = (os.getenv("VISION_ENGINE", "auto") or "auto").strip().lower()
GROK_CLI_TIMEOUT_SEC = int(os.getenv("GROK_CLI_TIMEOUT_SEC", "900"))
GROK_CLI_MAX_TURNS = int(os.getenv("GROK_CLI_MAX_TURNS", "16"))
GROK_CLI_REASONING_EFFORT = (os.getenv("GROK_CLI_REASONING_EFFORT", "medium") or "medium").strip().lower()
GROK_CWD = os.path.expanduser(
    os.getenv(
        "GROK_CWD",
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "grok-cwd"),
    )
)
GROK_CLI_SYSTEM_PROMPT = (
    "You transcribe scanned U.S. financial disclosure forms into JSON. "
    "Use the read_file tool on every listed page image. Do not use other tools, "
    "skills, MCP servers, git, Slack, or session-start. Do not write files. "
    "Reply with only the JSON object described in the user prompt."
)
GROK_TX_JSON_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["transactions"],
    "properties": {
        "noRows": {"type": "boolean"},
        "transactions": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["asset", "txType"],
                "properties": {
                    "owner": {"enum": ["self", "spouse", "joint", "dependent"]},
                    "asset": {"type": "string"},
                    "ticker": {"type": ["string", "null"]},
                    "txType": {"enum": ["P", "S", "E"]},
                    "txDate": {"type": ["string", "null"]},
                    "notifDate": {"type": ["string", "null"]},
                    "amountMin": {"type": ["integer", "null"]},
                    "amountMax": {"type": ["integer", "null"]},
                    "bracket": {"type": ["string", "null"]},
                    "note": {"type": ["string", "null"]},
                },
            },
        },
    },
}
_WORKER_LOCK_FD = None
OPENROUTER_TIMEOUT_SEC = int(os.getenv("OPENROUTER_TIMEOUT_SEC", "600"))
MAX_DOCS_PER_POLL = int(os.getenv("MAX_DOCS_PER_POLL", "2"))
MAX_PAGES = int(os.getenv("MAX_PAGES", "12"))
# Long attached-schedule PTRs (Khanna 15–34 pages) overflow one Gemini JSON
# reply.  Chunk the PDF so each native-PDF call sees a bounded page window.
PDF_NATIVE_CHUNK_PAGES = max(4, int(os.getenv("PDF_NATIVE_CHUNK_PAGES", "10")))
MAX_ATTEMPTS = max(1, int(os.getenv("MAX_ATTEMPTS", "3")))
BACKOFF_BASE_SEC = max(15, int(os.getenv("BACKOFF_BASE_SEC", "90")))
EXHAUSTED_ALERT_THRESHOLD = max(1, int(os.getenv("EXHAUSTED_ALERT_THRESHOLD", "5")))
STATE_FILE = os.path.expanduser(
    os.getenv("STATE_FILE", os.path.join(os.path.dirname(os.path.abspath(__file__)), "attempt-state.json"))
)
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
OPENROUTER_MODEL = os.getenv("OPENROUTER_MODEL", "x-ai/grok-4.6")
# Cheap VL first. Qwen slugs read raster pages, not PDF `file` (see prefersPageImages).
DEFAULT_CASCADE_MODELS = (
    "qwen/qwen3-vl-8b-instruct,"
    "qwen/qwen3-vl-30b-a3b-instruct,"
    "google/gemini-3.8-flash"
)
OPENROUTER_CASCADE_MODELS = os.getenv("OPENROUTER_CASCADE_MODELS", DEFAULT_CASCADE_MODELS)
OPENROUTER_CASCADE_MAX_PAGES = max(1, int(os.getenv("OPENROUTER_CASCADE_MAX_PAGES", "8")))
PUSHOVER_APP_TOKEN = os.getenv("PUSHOVER_APP_TOKEN", "")
PUSHOVER_USER_KEY = os.getenv("PUSHOVER_USER_KEY", "")
DOWNLOAD_UA = "congress-feed/0.1 (+https://congress.trade)"


def grok_bin() -> str:
    if os.getenv("GROK_BIN"):
        return os.environ["GROK_BIN"]
    for cand in (
        os.path.expanduser("~/.grok/bin/grok"),
        "/opt/homebrew/bin/grok",
        "/usr/local/bin/grok",
        os.path.expanduser("~/.local/bin/grok"),
    ):
        if os.path.exists(cand) and os.access(cand, os.X_OK):
            return cand
    found = shutil.which("grok")
    return found or "grok"


def grok_cli_max_turns(page_count: int) -> int:
    """Rotated multipage PTRs burn one turn per page plus re-reads.

    Floor is GROK_CLI_MAX_TURNS (16).  Scale 4 + 2*pages, cap 32.
    """
    n = max(0, int(page_count or 0))
    return min(32, max(GROK_CLI_MAX_TURNS, 4 + 2 * n))


def ensure_grok_cwd(path: str | None = None) -> str:
    """Scratch cwd so grok -p does not load Congress.Trade AGENTS.md."""
    dest = os.path.abspath(path or GROK_CWD)
    os.makedirs(dest, exist_ok=True)
    grok_md = os.path.join(dest, "GROK.md")
    if not os.path.exists(grok_md):
        with open(grok_md, "w", encoding="utf-8") as fh:
            fh.write(
                "# Vision transcription only\n\n"
                "Read the listed page images with read_file and emit the JSON "
                "object. Do not load project skills, MCP, git, or Slack.\n"
            )
    return dest


def acquire_worker_lock() -> None:
    """One live worker.  A second copy exits 0 so pm2 does not crash-loop."""
    global _WORKER_LOCK_FD
    lock_path = STATE_FILE + ".lock"
    os.makedirs(os.path.dirname(os.path.abspath(lock_path)) or ".", exist_ok=True)
    _WORKER_LOCK_FD = open(lock_path, "a", encoding="utf-8")
    try:
        fcntl.flock(_WORKER_LOCK_FD.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        logger.error("another vision-worker holds %s — exiting", lock_path)
        sys.exit(0)


ASSET_VERB_RE = re.compile(
    r"^(?:sell(?:ing)?|sale|purchase(?:d)?|buy(?:ing)?|bought|sold)\s+",
    re.I,
)
ASSET_TYPE_LETTER_RE = re.compile(r"^[PSE]\s+")
TICKER_PARENS_RE = re.compile(r"\(([A-Z][A-Z0-9.]{0,6})\)\s*$")


def clean_asset_name(asset: str) -> tuple[str, str | None]:
    """Drop handwritten P/S/E verbs; pull a trailing (TICKER)."""
    s = (asset or "").strip()
    ticker = None
    m = TICKER_PARENS_RE.search(s)
    if m:
        ticker = m.group(1)
        s = TICKER_PARENS_RE.sub("", s).strip()
    s = ASSET_VERB_RE.sub("", s).strip()
    s = ASSET_TYPE_LETTER_RE.sub("", s).strip()
    return s, ticker


def build_local_cli_cmd(pages: list, filing: dict) -> list[str]:
    """Headless grok -p argv. Isolated cwd, medium effort, JSON schema."""
    core = PROMPT_CORE.format(
        form_hint=form_hint_for(filing),
        filed_date=filing.get("filed_date") or "unknown",
    )
    image_list = "\n".join(f"- {p}" for p in pages)
    prompt = LOCAL_CLI_PROMPT.format(core=core, image_list=image_list)
    cwd = ensure_grok_cwd()
    return [
        grok_bin(),
        "-p", prompt,
        "--cwd", cwd,
        "--output-format", "plain",
        "--max-turns", str(grok_cli_max_turns(len(pages))),
        "--tools", "read_file",
        "--always-approve",
        "--no-memory",
        "--no-subagents",
        "--no-plan",
        "--disable-web-search",
        "--reasoning-effort", GROK_CLI_REASONING_EFFORT,
        "--system-prompt-override", GROK_CLI_SYSTEM_PROMPT,
        "--json-schema", json.dumps(GROK_TX_JSON_SCHEMA, separators=(",", ":")),
    ]


def active_engine_label() -> str:
    if VISION_ENGINE == "openrouter":
        return "openrouter-grok-vision"
    if VISION_ENGINE == "local_cli":
        return "local-grok-cli-vision"
    return "auto-local-cli+openrouter-fallback"


def send_request(url: str, method: str = "GET", payload: dict | None = None, timeout: int = 60) -> dict:
    req = urllib.request.Request(url, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("User-Agent", "congress-vision-worker/3.0-local-grok")
    if ADMIN_TOKEN:
        req.add_header("Authorization", f"Bearer {ADMIN_TOKEN}")
    data_bytes = json.dumps(payload).encode("utf-8") if payload is not None else None
    try:
        with urllib.request.urlopen(req, data=data_bytes, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", "replace")[:400]
        logger.error("HTTP %d for %s: %s", e.code, url, err_body)
        return {"ok": False, "error": f"HTTP {e.code}: {err_body}"}
    except Exception as e:
        logger.error("Request error for %s: %s", url, str(e))
        return {"ok": False, "error": str(e)}


def load_attempt_state() -> dict:
    """Per-doc attempt ledger: {docs: {doc_id: {attempts, next_eligible_at, last_error, exhausted, parked}}}."""
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and isinstance(data.get("docs"), dict):
            return data
    except FileNotFoundError:
        pass
    except Exception as e:
        logger.warning("attempt state load failed (%s); starting empty", str(e)[:120])
    return {"docs": {}, "exhausted_alert_sent_at": None, "exhausted_alert_count": 0}


def save_attempt_state(state: dict) -> None:
    try:
        parent = os.path.dirname(STATE_FILE)
        if parent:
            os.makedirs(parent, exist_ok=True)
        tmp = STATE_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2, sort_keys=True)
        os.replace(tmp, STATE_FILE)
    except Exception as e:
        logger.error("attempt state save failed: %s", str(e)[:200])


def doc_entry(state: dict, doc_id: str) -> dict:
    docs = state.setdefault("docs", {})
    entry = docs.get(doc_id)
    if not isinstance(entry, dict):
        entry = {
            "attempts": 0,
            "next_eligible_at": 0.0,
            "last_error": None,
            "exhausted": False,
            "parked": False,
        }
        docs[doc_id] = entry
    return entry


def send_pushover(title: str, message: str, priority: int = 0) -> bool:
    """Optional publish/exhausted alerts. No-op when keys missing; never throws."""
    if not PUSHOVER_APP_TOKEN or not PUSHOVER_USER_KEY:
        return False
    try:
        body = urllib.parse.urlencode({
            "token": PUSHOVER_APP_TOKEN,
            "user": PUSHOVER_USER_KEY,
            "title": title[:250],
            "message": message[:1024],
            "priority": str(priority),
        }).encode("utf-8")
        req = urllib.request.Request(
            "https://api.pushover.net/1/messages.json",
            data=body,
            method="POST",
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            return 200 <= resp.status < 300
    except Exception as e:
        logger.warning("pushover failed: %s", str(e)[:160])
        return False


def count_exhausted(state: dict) -> int:
    docs = state.get("docs") or {}
    return sum(1 for e in docs.values() if isinstance(e, dict) and e.get("exhausted"))


def maybe_alert_exhausted(state: dict) -> None:
    n = count_exhausted(state)
    if n < EXHAUSTED_ALERT_THRESHOLD:
        return
    # Renotify only when count rises past a previous alert level.
    prev = int(state.get("exhausted_alert_count") or 0)
    if n <= prev:
        return
    sent = send_pushover(
        "CT local vision: docs exhausted",
        f"{n} scanned filing(s) parked as local_vision_exhausted "
        f"(threshold {EXHAUSTED_ALERT_THRESHOLD}). Needs #1575 vision spend decision.",
        priority=0,
    )
    if sent:
        state["exhausted_alert_count"] = n
        state["exhausted_alert_sent_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        save_attempt_state(state)
        logger.info("exhausted-threshold pushover sent (count=%d)", n)


def send_heartbeat(state: dict | None = None) -> bool:
    exhausted = count_exhausted(state) if state is not None else None
    res = send_request(
        f"{API_BASE_URL}/api/admin/local-worker/heartbeat",
        method="POST",
        payload={
            "workerId": WORKER_ID,
            "statusJson": {
                "engine": active_engine_label(),
                "visionEngine": VISION_ENGINE,
                "grokBin": grok_bin(),
                "openrouterModel": OPENROUTER_MODEL,
                "openrouterCascade": cascade_model_list(),
                "openrouterKeyConfigured": bool(OPENROUTER_API_KEY),
                "maxAttempts": MAX_ATTEMPTS,
                "maxDocsPerPoll": MAX_DOCS_PER_POLL,
                "exhaustedDocs": exhausted,
                "activeAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            },
        },
    )
    ok = bool(res.get("ok"))
    if not ok:
        logger.warning("Heartbeat failed: %s", res.get("error"))
    return ok


def get_pending_scanned_filings() -> list:
    # ?worker=local opts into the broad reclaim set: the server advertises
    # EVERY unresolved scanned review item (cascade disagreements, row-limit
    # garbage, low-confidence flags), not just form-chrome/empty failures.
    # The Coolify CPU OCR worker stays on the conservative set.
    res = send_request(f"{API_BASE_URL}/api/admin/scanned-filings/pending?worker=local")
    if res.get("ok") and isinstance(res.get("filings"), list):
        return res["filings"]
    return []


def park_local_vision(
    doc_id: str,
    attempts: int,
    last_error: str,
    extractor: str | None = None,
) -> bool:
    """Honest terminal park via admin API. Falls back to local exhausted flag if API missing."""
    res = send_request(
        f"{API_BASE_URL}/api/admin/local-vision-park",
        method="POST",
        payload={
            "docId": doc_id,
            "workerId": WORKER_ID,
            "attempts": attempts,
            "lastError": last_error[:500],
            "extractor": extractor or active_engine_label(),
        },
        timeout=60,
    )
    if res.get("ok"):
        logger.info(
            "parked %s as local_vision_exhausted attempts=%d last=%s",
            doc_id, attempts, last_error[:120],
        )
        return True
    err = res.get("error") or "unknown"
    # Pre-deploy: API may 404 — still stop local re-attempts.
    logger.warning("local-vision-park API failed for %s: %s (local exhaust still holds)", doc_id, err)
    return False


# Shared extraction instructions. Local CLI path lists page image paths;
# OpenRouter path attaches the PDF.
PROMPT_CORE = """You are transcribing a scanned U.S. {form_hint} disclosure
form into structured JSON.

Read EVERY page. Forms may be rotated. Prefer the literal printed text over
guesses. Checkbox X-marks determine transaction type and amount brackets.

Each transaction is a grid/table row with fields like:
- Owner: JT=joint, SP=spouse, DC=dependent; unmarked = self.
  A leading TRUST/account-name column may exist — identical
  (asset,date,type,amount) rows under different trusts/owners are REAL distinct
  rows; transcribe all of them, never dedupe.
- FULL ASSET NAME (ticker may be in parentheses). Put the security name
  only in "asset". Do not copy PURCHASE/SALE/EXCHANGE/Sell/Buy into asset.
  If a ticker is in parentheses, also set "ticker".
- TYPE OF TRANSACTION: PURCHASE / SALE / EXCHANGE (or P/S/E checkboxes).
  That belongs in txType (P/S/E), never in the asset string.
- DATE OF TRANSACTION and DATE NOTIFIED (M/D/YY style; assume 20xx).
- AMOUNT: checkbox ranges, usually:
  A=$1,001-$15,000 (some forms print A=$1,000-$15,000: then use 1000),
  B=$15,001-$50,000, C=$50,001-$100,000, D=$100,001-$250,000,
  E=$250,001-$500,000, F=$500,001-$1,000,000, G=$1,000,001-$5,000,000,
  H=$5,000,001-$25,000,000, I=$25,000,001-$50,000,000, J=Over $50,000,000
  (min 50000000, max null), and some forms print K="Spouse/DC Over $1,000,000"
  (min 1000000, max null). Use the PRINTED range of the CHECKED box.
  If no box is checked, set both amounts null and add a note.
- Executive OGE 278-T: asset / transaction type / date / amount category may
  appear as free text rather than checkboxes — still emit the same schema.
- Amendments: transcribe normally, add note "amendment".

Rules: tx_date must be on/before the filing's filed date ({filed_date}).
Never invent rows. Put uncertainty in each row's "note".
Do not run session-start, Slack, git, or any skill. Read the page images
and emit JSON.

Reply with ONLY a JSON object (no prose, no markdown fences):
{{"transactions":[{{"owner":"self|spouse|joint|dependent","asset":"...","ticker":"ABC"|null,
  "txType":"P|S|E","txDate":"YYYY-MM-DD"|null,"notifDate":"YYYY-MM-DD"|null,
  "amountMin":1001,"amountMax":15000,"bracket":"A"|null,"note":null}}]}}
If the document truly has no transactions (e.g. states "Nothing to report"),
reply with exactly: {{"transactions":[],"noRows":true}}
"""

LOCAL_CLI_PROMPT = """{core}

Page images (absolute paths, in order). Use your read_file / image-reading
tool on EACH path before answering — do not invent rows without reading:
{image_list}
"""

OPENROUTER_PROMPT = """{core}

A PDF of the filing is attached — read every page.
"""


def stored_document_url(filing: dict) -> str | None:
    """Build admin URL for the durable stored copy. Never uses source_url."""
    explicit = filing.get("stored_document_url") or filing.get("storedDocumentUrl")
    if isinstance(explicit, str) and explicit.strip():
        path = explicit.strip()
        if path.startswith("http://") or path.startswith("https://"):
            return path
        return f"{API_BASE_URL}{path if path.startswith('/') else '/' + path}"
    doc_id = filing.get("doc_id")
    raw_key = filing.get("raw_object_key")
    if not doc_id or not raw_key:
        return None
    return f"{API_BASE_URL}/api/admin/filings/{urllib.parse.quote(str(doc_id), safe='')}/raw"


def download_stored_document(filing: dict, dest: str) -> bool:
    """
    Fetch the durable R2 copy via admin API. NEVER hits Clerk/eFD/OGE.
    Accepts PDF (primary for scanned_pdf) and HTML (senate/electronic, saved too).
    """
    url = stored_document_url(filing)
    if not url:
        logger.warning(
            "no stored copy for %s (raw_object_key missing) — refusing source re-download",
            filing.get("doc_id"),
        )
        return False
    if not ADMIN_TOKEN:
        logger.error("ADMIN_TOKEN required to fetch stored document")
        return False
    # No -L follow to foreign hosts: the admin endpoint must return bytes inline.
    rc = subprocess.run(
        [
            "curl", "-sS", "-o", dest, "-w", "%{http_code}",
            "--max-time", "90",
            "--max-redirs", "0",
            "-A", DOWNLOAD_UA,
            "-H", f"Authorization: Bearer {ADMIN_TOKEN}",
            url,
        ],
        capture_output=True, text=True,
    )
    code = (rc.stdout or "").strip()[-3:]
    if code != "200" or not os.path.exists(dest):
        logger.warning(
            "stored download HTTP %s for %s url=%s",
            code, filing.get("doc_id"), url[:160],
        )
        return False
    with open(dest, "rb") as f:
        head = f.read(16)
    if head.startswith(b"%PDF") or head.lstrip().startswith(b"<") or head.lstrip().lower().startswith(b"<!doctype"):
        return True
    # Some HTML is served with a BOM / whitespace; accept non-empty bodies ≥ 100B
    # that the admin endpoint already validated as our stored object.
    size = os.path.getsize(dest)
    if size >= 100:
        logger.info(
            "stored download ok (non-pdf magic) doc=%s bytes=%d head=%r",
            filing.get("doc_id"), size, head[:8],
        )
        return True
    logger.warning("stored download too small/unrecognized for %s", filing.get("doc_id"))
    return False


PTR_UPRIGHT_HINTS = (
    "full asset name",
    "hand delivered",
    "periodic transaction",
    "date of transaction",
    "amount of transaction",
    "united states house",
)


def _png_size(path: str) -> tuple[int, int]:
    from PIL import Image
    with Image.open(path) as im:
        return im.size


def rotate_png_cw(path: str, degrees: int) -> None:
    """Rotate a PNG in place clockwise.  90 and 270 are the House PTR scan cases."""
    from PIL import Image
    degrees = int(degrees) % 360
    if degrees == 0:
        return
    # PIL rotate() is counter-clockwise; convert CW to CCW.
    ccw = (360 - degrees) % 360
    with Image.open(path) as im:
        im.rotate(ccw, expand=True).save(path)


def tesseract_upright_score(path: str) -> int:
    """Count House PTR header phrases in a cheap OCR pass.  0 if tesseract misses."""
    try:
        rc = subprocess.run(
            ["tesseract", path, "stdout", "--psm", "6"],
            capture_output=True, text=True, timeout=45,
        )
    except (OSError, subprocess.TimeoutExpired):
        return 0
    text = (rc.stdout or "").lower()
    return sum(1 for hint in PTR_UPRIGHT_HINTS if hint in text)


def choose_upright_cw_degrees(sample_path: str, score_fn=tesseract_upright_score) -> int:
    """Portrait page images of landscape House PTRs need a 90 or 270 CW spin.

    Landscape renders (already upright, e.g. 8220834) stay at 0.  Score the
    unrotated page too — an already-upright portrait (OGE 278, Senate FD,
    House cover) must beat a silent 90/270.  When every score is 0, leave
    the page alone.  Guessing 270 CW on silence stood up one drain and
    would invert every already-readable portrait.
    """
    try:
        width, height = _png_size(sample_path)
    except Exception:
        return 0
    if width >= height:
        return 0
    scores: dict[int, int] = {0: 0, 90: 0, 270: 0}
    try:
        scores[0] = int(score_fn(sample_path) or 0)
    except Exception:
        scores[0] = 0
    for deg in (90, 270):
        trial = f"{sample_path}.rot{deg}.png"
        try:
            shutil.copy(sample_path, trial)
            rotate_png_cw(trial, deg)
            scores[deg] = int(score_fn(trial) or 0)
        except Exception:
            scores[deg] = 0
        finally:
            try:
                os.remove(trial)
            except OSError:
                pass
    best = max(scores, key=lambda d: (scores[d], 1 if d == 0 else 0))
    if scores[best] <= 0:
        return 0
    return best


def upright_pages(pages: list[str], score_fn=tesseract_upright_score) -> list[str]:
    """Rotate portrait pages of a doc the same way so Grok/Qwen see upright grids.

    Landscape pages stay put even when a portrait cover chose a spin — mixed
    House PTRs (letter cover + landscape grid) would otherwise go sideways.
    """
    if not pages:
        return pages
    degrees = choose_upright_cw_degrees(pages[0], score_fn=score_fn)
    if not degrees:
        return pages
    logger.info("upright-rotate deg=%s pages=%s sample=%s", degrees, len(pages), pages[0])
    for path in pages:
        try:
            width, height = _png_size(path)
            if width >= height:
                continue
            rotate_png_cw(path, degrees)
        except Exception as err:
            logger.warning("upright-rotate failed %s: %s", path, err)
    return pages


def write_upright_pdf(pages: list[str], dest: str) -> str | None:
    """Rebuild a PDF from already-oriented page PNGs for PDF-native cascade.

    #2146 only rotates the raster files.  Gemini / grok-4.5 attach pdf_path,
    so a 13+ page sideways PTR would discard the upright CLI extract (#2142)
    and send the original sideways file.  Building from the PNGs keeps
    PDF-native aligned with whatever upright_pages did, including mixed
    portrait covers plus landscape attached schedules, and includes pages
    past MAX_PAGES that CLI never saw.
    """
    if not pages:
        return None
    try:
        from PIL import Image
    except Exception as err:
        logger.warning("upright-pdf: PIL missing: %s", err)
        return None
    opened: list = []
    rgb: list = []
    try:
        for path in pages:
            im = Image.open(path)
            opened.append(im)
            rgb.append(im.convert("RGB"))
        if len(rgb) == 1:
            rgb[0].save(dest, format="PDF", resolution=150)
        else:
            rgb[0].save(
                dest,
                format="PDF",
                save_all=True,
                append_images=rgb[1:],
                resolution=150,
            )
    except Exception as err:
        logger.warning("upright-pdf failed: %s", err)
        return None
    finally:
        for im in opened + rgb:
            try:
                im.close()
            except Exception:
                pass
    if not os.path.isfile(dest) or os.path.getsize(dest) < 8:
        return None
    logger.info(
        "upright-pdf pages=%s dest=%s bytes=%s",
        len(pages), dest, os.path.getsize(dest),
    )
    return dest


def native_cascade_pdf(original_pdf: str, upright_pdf: str | None) -> str:
    """Prefer the upright rebuild so Gemini sees the same pages as CLI/Qwen."""
    if upright_pdf and os.path.isfile(upright_pdf) and os.path.getsize(upright_pdf) >= 8:
        return upright_pdf
    return original_pdf


def render_pages(pdf_path: str, out_dir: str) -> tuple[list, int, str | None]:
    """Render PDF pages to PNG via pdftoppm.

    Returns (pages_for_cli, total_rendered, upright_pdf).  pages_for_cli is
    capped at MAX_PAGES so the local Grok CLI stays bounded.  total_rendered
    is the uncapped pdftoppm count so a cheap VL hit that only saw
    OPENROUTER_CASCADE_MAX_PAGES images is not treated as a complete extract
    when later PDF-native cascade steps can still read the full file.
    upright_pdf is a rebuild from every rotated PNG (uncapped) so Gemini
    does not attach the original sideways scan.
    """
    prefix = os.path.join(out_dir, "page")
    rc = subprocess.run(
        ["pdftoppm", "-png", "-r", "150", pdf_path, prefix],
        capture_output=True, text=True,
    )
    if rc.returncode != 0:
        logger.error("pdftoppm failed: %s", (rc.stderr or "")[:200])
        return [], 0, None
    pages = sorted(
        os.path.join(out_dir, f) for f in os.listdir(out_dir)
        if f.startswith("page-") and f.endswith(".png")
    )
    pages = upright_pages(pages)
    total = len(pages)
    upright_pdf = write_upright_pdf(pages, os.path.join(out_dir, "upright.pdf"))
    if MAX_PAGES > 0 and total > MAX_PAGES:
        logger.warning("capping pages %d -> %d", total, MAX_PAGES)
        return pages[:MAX_PAGES], total, upright_pdf
    return pages, total, upright_pdf


def pdfinfo_pages(pdf_path: str) -> int:
    """Page count from poppler pdfinfo.  0 if the tool misses."""
    try:
        rc = subprocess.run(
            ["pdfinfo", pdf_path],
            capture_output=True, text=True, timeout=20,
        )
    except (OSError, subprocess.TimeoutExpired):
        return 0
    for line in (rc.stdout or "").splitlines():
        if line.lower().startswith("pages:"):
            try:
                return int(line.split(":", 1)[1].strip())
            except ValueError:
                return 0
    return 0


def split_pdf_chunks(pdf_path: str, work_dir: str, chunk_pages: int) -> list[str]:
    """Split a PDF into sequential chunk files via pdfseparate/pdfunite.

    Returns [original] when the file is already within chunk_pages or
    poppler is missing — the caller then sends the whole PDF once.
    """
    total = pdfinfo_pages(pdf_path)
    if total <= 0 or total <= chunk_pages:
        return [pdf_path]
    if not shutil.which("pdfseparate") or not shutil.which("pdfunite"):
        logger.warning("pdfseparate/pdfunite missing — sending whole PDF (%d pages)", total)
        return [pdf_path]
    pages_dir = os.path.join(work_dir, "pdf-pages")
    os.makedirs(pages_dir, exist_ok=True)
    prefix = os.path.join(pages_dir, "p")
    rc = subprocess.run(
        ["pdfseparate", pdf_path, prefix + "-%d.pdf"],
        capture_output=True, text=True, timeout=60,
    )
    if rc.returncode != 0:
        logger.warning("pdfseparate failed: %s", (rc.stderr or "")[:200])
        return [pdf_path]
    singles = []
    for name in os.listdir(pages_dir):
        if not name.startswith("p-") or not name.endswith(".pdf"):
            continue
        try:
            n = int(name[2:-4])
        except ValueError:
            continue
        singles.append((n, os.path.join(pages_dir, name)))
    singles.sort()
    if not singles:
        return [pdf_path]
    chunks: list[str] = []
    for i in range(0, len(singles), chunk_pages):
        group = [p for _, p in singles[i:i + chunk_pages]]
        out = os.path.join(work_dir, f"chunk-{i // chunk_pages:02d}.pdf")
        un = subprocess.run(
            ["pdfunite", *group, out],
            capture_output=True, text=True, timeout=60,
        )
        if un.returncode != 0 or not os.path.exists(out):
            logger.warning("pdfunite failed chunk %s: %s", i, (un.stderr or "")[:200])
            return [pdf_path]
        chunks.append(out)
    logger.info("split %s into %d PDF chunks of <=%d pages", pdf_path, len(chunks), chunk_pages)
    return chunks


def cascade_hit_is_terminal(model: str, total_pages: int, image_pages_available: int) -> bool:
    """False when a page-image model did not see every PDF page.

    Gemini / grok-4.5 attach the original PDF, so they can still recover
    trades on pages past OPENROUTER_CASCADE_MAX_PAGES (and past MAX_PAGES).
    Accepting a truncated Qwen hit publishes at 0.97 and locks the filing
    — drain then skips scanned_pdf, so the unseen pages never land.
    """
    if not model_uses_page_images(model):
        return True
    sent = min(max(0, image_pages_available), OPENROUTER_CASCADE_MAX_PAGES)
    return total_pages <= sent


def parse_model_json(text: str):
    """Extract JSON payload (array, {transactions}, or {noRows})."""
    text = (text or "").strip()
    text = re.sub(r"^```(?:json)?|```$", "", text, flags=re.M).strip()
    start = min([i for i in (text.find("["), text.find("{")) if i >= 0], default=-1)
    if start < 0:
        return None
    for end in range(len(text), start, -1):
        chunk = text[start:end].strip()
        if not chunk:
            break
        try:
            return json.loads(chunk)
        except Exception:
            nxt = max(chunk.rfind("]"), chunk.rfind("}"))
            if nxt <= 0:
                return None
            end = start + nxt + 1
            try:
                return json.loads(text[start:end])
            except Exception:
                return None
    return None


def validate_rows(rows) -> list:
    """Mechanical validation; returns list of ParsedTx-shaped dicts."""
    out = []
    if not isinstance(rows, list):
        return out
    for o in rows:
        if not isinstance(o, dict):
            continue
        tx_type = o.get("txType") or o.get("tx_type")
        if isinstance(tx_type, str):
            t = tx_type.strip().upper()
            if t in ("P", "PURCHASE", "BUY", "BOUGHT"):
                tx_type = "P"
            elif t in ("S", "SALE", "SELL", "SOLD", "SALE_FULL", "SALE_PARTIAL", "PARTIAL SALE"):
                tx_type = "S"
            elif t in ("E", "EXCHANGE"):
                tx_type = "E"
        if tx_type not in ("P", "S", "E"):
            continue
        raw_asset = (o.get("asset") or o.get("assetName") or o.get("asset_name") or "").strip()
        parsed_ticker = None
        asset, parsed_ticker = clean_asset_name(raw_asset)
        raw_ticker = o.get("ticker")
        if isinstance(raw_ticker, str):
            raw_ticker = raw_ticker.strip() or None
        else:
            raw_ticker = None
        ticker = raw_ticker or parsed_ticker
        if len(asset) < 3:
            # "Sell BA" / "Buy F" / "S GE" collapse to a 1–2 char ticker.
            # Dropping that lot publishes the rest of the PTR at 0.97 and
            # locks the short-ticker rows out (drain skips scanned_pdf).
            remnant = (asset or "").strip().upper()
            if remnant and re.fullmatch(r"[A-Z]{1,2}", remnant):
                ticker = ticker or remnant
                asset = remnant
            elif ticker:
                asset = str(ticker)
            elif len(raw_asset) >= 3:
                asset = raw_asset
            else:
                continue
        amin, amax = o.get("amountMin", o.get("amount_min")), o.get("amountMax", o.get("amount_max"))
        if amin is not None and amax is not None and isinstance(amin, (int, float)) and isinstance(amax, (int, float)) and amin > amax:
            continue
        note = o.get("note") or o.get("description")
        amin_i = int(amin) if isinstance(amin, (int, float)) else None
        amax_i = int(amax) if isinstance(amax, (int, float)) else None
        # rawText is fed to normalizer parseAmountRange(). Hyphenated dates and
        # bare "1001-15000" digits get misread as amount ranges → invalid_amount.
        # Keep audit text to asset prose only.
        raw = asset[:500]
        out.append({
            "txDate": o.get("txDate") or o.get("tx_date"),
            "owner": o.get("owner") if o.get("owner") in ("self", "spouse", "joint", "dependent") else None,
            "assetName": asset[:500],
            "ticker": ticker,
            "assetType": None,
            "txType": tx_type,
            "amountMin": amin_i,
            "amountMax": amax_i,
            "isOption": bool(o.get("isOption") or re.search(r"\b(put|call|option)\b", asset, re.I)),
            "capGainsOver200": bool(o.get("capGainsOver200") or o.get("cap_gains_over_200")),
            "confidence": 0.97,
            "rawText": raw[:800],
            "description": note,
        })
    return out


def form_hint_for(filing: dict) -> str:
    chamber = (filing.get("chamber") or "").lower()
    if chamber == "executive":
        return "executive branch OGE 278-T / 278"
    if chamber == "senate":
        return "Senate"
    return "House"


def rows_from_parsed(parsed) -> list | None:
    if parsed is None:
        return None
    if isinstance(parsed, dict):
        if parsed.get("noRows") and not parsed.get("transactions"):
            return []
        rows = parsed.get("transactions")
        if rows is None and isinstance(parsed.get("rows"), list):
            rows = parsed["rows"]
        if rows is None:
            logger.error("JSON missing transactions: keys=%s", list(parsed.keys())[:12])
            return None
        return validate_rows(rows)
    if isinstance(parsed, list):
        return validate_rows(parsed)
    return None


def cascade_model_list() -> list[str]:
    """Cheap VL models, then OPENROUTER_MODEL last. Deduped, order preserved."""
    raw = (OPENROUTER_CASCADE_MODELS or "").split(",")
    models: list[str] = []
    seen: set[str] = set()
    for item in raw:
        model = item.strip()
        if not model or model in seen:
            continue
        models.append(model)
        seen.add(model)
    tail = (OPENROUTER_MODEL or "").strip()
    if tail and tail not in seen:
        models.append(tail)
    return models


def model_uses_page_images(model: str) -> bool:
    """Qwen VL / GLM-V read image_url. PDF file-parser would bill mistral-ocr."""
    m = (model or "").strip().lower()
    if "qwen" in m and "vl" in m:
        return True
    if "glm-4" in m and "v" in m:
        return True
    return False


def extractor_label_for_model(model: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", (model or "openrouter").lower()).strip("_")
    return f"openrouter_{slug[:56]}"


def parsed_is_genuine_empty(parsed) -> bool:
    return isinstance(parsed, dict) and bool(parsed.get("noRows"))


def rows_or_miss(parsed, label: str) -> list | None:
    """None means 'try the next cascade step'. [] is a claimed empty filing."""
    rows = rows_from_parsed(parsed)
    if rows is None:
        return None
    if len(rows) == 0 and not parsed_is_genuine_empty(parsed):
        logger.warning("%s returned 0 valid rows without noRows — treating as miss", label)
        return None
    return rows


def encode_page_image(path: str, work_dir: str) -> str | None:
    """JPEG data-URI, downscaled for cheap VL context. Falls back to PNG bytes."""
    dest = os.path.join(work_dir, os.path.basename(path) + ".jpg")
    try:
        rc = subprocess.run(
            [
                "sips",
                "-s", "format", "jpeg",
                "-s", "formatOptions", "70",
                "--resampleHeightWidthMax", "1800",
                path,
                "--out", dest,
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        use = dest if rc.returncode == 0 and os.path.exists(dest) and os.path.getsize(dest) > 32 else path
    except Exception:
        use = path
    try:
        with open(use, "rb") as f:
            raw = f.read()
    except OSError:
        return None
    if not raw:
        return None
    mime = "image/jpeg" if use.endswith(".jpg") else "image/png"
    return f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"


def openrouter_user_content(prompt: str, pdf_path: str, pages: list, model: str, work_dir: str) -> list | None:
    """Image parts for VL slugs; PDF file part for native-PDF models."""
    if model_uses_page_images(model):
        capped = pages[:OPENROUTER_CASCADE_MAX_PAGES]
        if not capped:
            logger.warning("skip %s: needs page images, none rendered", model)
            return None
        parts: list = []
        for page in capped:
            uri = encode_page_image(page, work_dir)
            if not uri:
                continue
            parts.append({"type": "image_url", "image_url": {"url": uri}})
        if not parts:
            logger.warning("skip %s: no encodable page images", model)
            return None
        parts.append({"type": "text", "text": prompt})
        return parts
    with open(pdf_path, "rb") as f:
        pdf_b64 = base64.b64encode(f.read()).decode("ascii")
    file_data = f"data:application/pdf;base64,{pdf_b64}"
    return [
        {
            "type": "file",
            "file": {"filename": "filing.pdf", "file_data": file_data},
        },
        {"type": "text", "text": prompt},
    ]


def transcribe_with_local_cli(pages: list, filing: dict) -> list | None:
    """Grok Build CLI (`grok -p`) via owner OIDC subscription — primary path."""
    bin_path = grok_bin()
    if not shutil.which(bin_path) and not os.path.exists(bin_path):
        logger.error("local grok CLI not found at %s", bin_path)
        return None
    if not pages:
        logger.error("no page images for local CLI vision")
        return None

    cmd = build_local_cli_cmd(pages, filing)
    grok_cwd = ensure_grok_cwd()
    logger.info(
        "local grok CLI: %s pages=%d turns=%s effort=%s cwd=%s timeout=%ss",
        bin_path, len(pages), grok_cli_max_turns(len(pages)),
        GROK_CLI_REASONING_EFFORT, grok_cwd, GROK_CLI_TIMEOUT_SEC,
    )
    try:
        rc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=GROK_CLI_TIMEOUT_SEC,
            cwd=grok_cwd,
            env=dict(os.environ),
        )
    except subprocess.TimeoutExpired:
        logger.error("local grok CLI timed out (%ss)", GROK_CLI_TIMEOUT_SEC)
        return None
    except Exception as e:
        logger.error("local grok CLI failed to start: %s", str(e)[:300])
        return None

    if rc.returncode != 0:
        logger.error(
            "local grok CLI exit %d: %s",
            rc.returncode,
            ((rc.stderr or "") + "\n" + (rc.stdout or ""))[:400],
        )
        return None

    content = rc.stdout or ""
    if not content.strip():
        # Some builds put the answer on stderr when stdout is noisy.
        content = rc.stderr or ""
    parsed = parse_model_json(content)
    if parsed is None:
        logger.error("could not parse local grok CLI output: %s", content[:300])
        return None
    rows = rows_or_miss(parsed, "local grok CLI")
    logger.info("local grok CLI rows=%s", None if rows is None else len(rows))
    return rows


def transcribe_with_openrouter(
    pdf_path: str,
    pages: list,
    filing: dict,
    model: str,
    work_dir: str,
) -> list | None:
    """One OpenRouter model. VL slugs get page images; native-PDF models get the file."""
    if not OPENROUTER_API_KEY:
        logger.error("OPENROUTER_API_KEY is not set — cannot run OpenRouter fallback")
        return None

    if not model_uses_page_images(model):
        n_pages = pdfinfo_pages(pdf_path)
        if n_pages > PDF_NATIVE_CHUNK_PAGES:
            return transcribe_pdf_native_chunked(pdf_path, filing, model, work_dir, n_pages)

    return transcribe_openrouter_one(pdf_path, pages, filing, model, work_dir)


def transcribe_pdf_native_chunked(
    pdf_path: str,
    filing: dict,
    model: str,
    work_dir: str,
    n_pages: int,
) -> list | None:
    """Gemini/Grok PDF-native over page chunks so a 34-page Khanna packet is complete."""
    chunks = split_pdf_chunks(pdf_path, work_dir, PDF_NATIVE_CHUNK_PAGES)
    if len(chunks) <= 1:
        return transcribe_openrouter_one(pdf_path, [], filing, model, work_dir)
    merged: list = []
    any_hit = False
    offset = 1
    for chunk_pdf in chunks:
        chunk_n = pdfinfo_pages(chunk_pdf) or PDF_NATIVE_CHUNK_PAGES
        end = min(offset + chunk_n - 1, n_pages)
        logger.info(
            "PDF-native chunk model=%s pages=%d-%d/%d file=%s",
            model, offset, end, n_pages, os.path.basename(chunk_pdf),
        )
        extra = (
            f"\nThis attachment is pages {offset}-{end} of a {n_pages}-page filing. "
            "Extract every transaction row on THESE pages only. "
            "A cover that only says 'Please see the attached' has no rows.\n"
        )
        rows = transcribe_openrouter_one(
            chunk_pdf, [], filing, model, work_dir, prompt_extra=extra,
        )
        if rows is None:
            # HTTP/parse miss on one window.  Sibling chunks must not publish
            # as a complete 0.97 extract — drain then skips scanned_pdf and
            # the missed schedule pages never land.  Empty [] is a real
            # cover-only window and is fine.
            logger.warning("PDF-native chunk miss pages=%d-%d model=%s", offset, end, model)
            return None
        if rows:
            any_hit = True
            merged.extend(rows)
        offset = end + 1
    if any_hit:
        logger.info("PDF-native chunked rows=%d model=%s pages=%d", len(merged), model, n_pages)
        return merged
    return None


def transcribe_openrouter_one(
    pdf_path: str,
    pages: list,
    filing: dict,
    model: str,
    work_dir: str,
    prompt_extra: str = "",
) -> list | None:
    """Single OpenRouter completion for one PDF or one page-image set."""
    core = PROMPT_CORE.format(
        form_hint=form_hint_for(filing),
        filed_date=filing.get("filed_date") or "unknown",
    )
    if model_uses_page_images(model):
        n = min(len(pages), OPENROUTER_CASCADE_MAX_PAGES)
        prompt = LOCAL_CLI_PROMPT.format(
            core=core,
            image_list="\n".join(f"- page {i + 1}" for i in range(n)),
        ) + "\nPage images are attached in order. Forms may be rotated.\n"
    else:
        prompt = OPENROUTER_PROMPT.format(core=core)
    if prompt_extra:
        prompt = prompt + prompt_extra

    content_parts = openrouter_user_content(prompt, pdf_path, pages, model, work_dir)
    if not content_parts:
        return None

    body = {
        "model": model,
        "max_tokens": 32000,
        "temperature": 0,
        "response_format": {"type": "json_object"},
        "usage": {"include": True},
        "plugins": [{"id": "response-healing"}],
        "messages": [
            {
                "role": "user",
                "content": content_parts,
            }
        ],
        "user": f"vision-worker:{filing.get('doc_id') or 'unknown'}",
    }

    req = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        method="POST",
        headers={
            "Authorization": f"Bearer {OPENROUTER_API_KEY}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://congress.trade",
            "X-Title": "Congress.Trade vision-worker",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=OPENROUTER_TIMEOUT_SEC) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", "replace")[:500]
        logger.error("OpenRouter HTTP %d model=%s: %s", e.code, model, err_body)
        if e.code in (402, 403):
            logger.error("OpenRouter budget/auth halt — backing off 15m")
            time.sleep(900)
        return None
    except Exception as e:
        logger.error("OpenRouter request failed model=%s: %s", model, str(e)[:300])
        return None

    usage = payload.get("usage") or {}
    logger.info(
        "OpenRouter reply requested=%s served=%s tokens_in=%s tokens_out=%s cost=%s",
        model,
        payload.get("model") or model,
        usage.get("prompt_tokens"),
        usage.get("completion_tokens"),
        usage.get("cost"),
    )

    try:
        content = payload["choices"][0]["message"]["content"] or ""
    except Exception:
        logger.error("unexpected OpenRouter shape: %s", json.dumps(payload)[:300])
        return None

    parsed = parse_model_json(content)
    if parsed is None:
        logger.error("could not parse OpenRouter output (%s): %s", model, content[:240])
        return None
    return rows_or_miss(parsed, f"openrouter:{model}")


def transcribe(
    pdf_path: str,
    pages: list,
    filing: dict,
    work_dir: str,
    total_pages: int | None = None,
) -> tuple:
    """Returns (rows|None, engine_used). Local Grok CLI solo pass, then cheap VL cascade."""
    engine = VISION_ENGINE
    if engine not in ("auto", "local_cli", "openrouter"):
        logger.warning("unknown VISION_ENGINE=%s; using auto", engine)
        engine = "auto"

    skip_page_image_models = False
    page_total = len(pages) if total_pages is None else total_pages
    # Khanna-style attached schedules are 15–34 pages.  Local CLI is capped
    # at MAX_PAGES (12), so starting it burns up to GROK_CLI_TIMEOUT_SEC on
    # a truncated read we will discard.  Skip straight to PDF-native.
    skip_local_cli = (
        engine == "auto"
        and bool(OPENROUTER_API_KEY)
        and MAX_PAGES > 0
        and page_total > MAX_PAGES
    )
    if skip_local_cli:
        logger.warning(
            "skipping local CLI: %d pages exceeds MAX_PAGES=%d — PDF-native cascade",
            page_total, MAX_PAGES,
        )
        skip_page_image_models = True
    elif engine in ("auto", "local_cli"):
        rows = transcribe_with_local_cli(pages, filing)
        if rows is not None:
            # Same lock as a truncated Qwen hit (#2141): MAX_PAGES (12) is
            # short of a 13+ page scan, ingest publishes at 0.97, drain
            # skips scanned_pdf, later-page trades never land.  PDF-native
            # cascade steps still attach the full file.
            truncated_cli = page_total > len(pages)
            if engine == "auto" and truncated_cli and OPENROUTER_API_KEY:
                logger.warning(
                    "local CLI returned %s row(s) from %d/%d pages — not terminal, cascading to PDF-native",
                    len(rows),
                    len(pages),
                    page_total,
                )
                skip_page_image_models = True
            else:
                return rows, "local_grok_cli_v1"
        elif engine == "local_cli":
            return None, "local_grok_cli_v1"
        else:
            logger.warning("local CLI solo pass missed; cascading cheap OpenRouter VL")

    if not OPENROUTER_API_KEY:
        logger.error("no OpenRouter key — cannot cascade after solo-pass miss")
        return None, "openrouter_cascade_skipped"

    page_total = len(pages) if total_pages is None else total_pages
    last_label = "openrouter_cascade"
    for model in cascade_model_list():
        if skip_page_image_models and model_uses_page_images(model):
            logger.info(
                "cascade skip model=%s: page-image cap already short versus PDF",
                model,
            )
            continue
        logger.info("cascade try model=%s images=%s", model, model_uses_page_images(model))
        rows = transcribe_with_openrouter(pdf_path, pages, filing, model, work_dir)
        last_label = extractor_label_for_model(model)
        if rows is None:
            logger.warning("cascade miss model=%s", model)
            continue
        if not cascade_hit_is_terminal(model, page_total, len(pages)):
            sent = min(len(pages), OPENROUTER_CASCADE_MAX_PAGES)
            logger.warning(
                "cascade %s returned %s row(s) from %d/%d pages — not terminal, continuing to PDF-native",
                model,
                len(rows),
                sent,
                page_total,
            )
            continue
        return rows, last_label
    return None, last_label


def record_failure(state: dict, doc_id: str, reason: str, extractor: str | None = None) -> None:
    """Increment attempt, schedule backoff, or park after MAX_ATTEMPTS."""
    entry = doc_entry(state, doc_id)
    entry["attempts"] = int(entry.get("attempts") or 0) + 1
    entry["last_error"] = reason
    entry["last_attempt_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    attempts = entry["attempts"]
    if attempts >= MAX_ATTEMPTS:
        entry["exhausted"] = True
        entry["next_eligible_at"] = time.time() + 365 * 24 * 3600  # never re-pick locally
        parked = park_local_vision(doc_id, attempts, reason, extractor)
        entry["parked"] = bool(parked)
        logger.warning(
            "cap: max attempts reached doc=%s attempts=%d/%d last=%s parked_api=%s",
            doc_id, attempts, MAX_ATTEMPTS, reason[:120], parked,
        )
        save_attempt_state(state)
        maybe_alert_exhausted(state)
        return
    backoff = BACKOFF_BASE_SEC * (2 ** max(0, attempts - 1))
    entry["next_eligible_at"] = time.time() + backoff
    logger.warning(
        "cap: attempt failed doc=%s attempts=%d/%d backoff=%ds reason=%s",
        doc_id, attempts, MAX_ATTEMPTS, backoff, reason[:120],
    )
    save_attempt_state(state)


def clear_attempts(state: dict, doc_id: str) -> None:
    docs = state.get("docs") or {}
    if doc_id in docs:
        del docs[doc_id]
        save_attempt_state(state)


def mark_doc_done(state: dict, doc_id: str, last_error: str) -> None:
    """Keep the doc out of the next poll.  Never forget a successful submit.

    clear_attempts on publish used to drop the local skip, so pending?worker=local
    re-advertised the same 17/93-row extracts (443 Grok chats on 2026-08-21).
    """
    entry = doc_entry(state, doc_id)
    entry["review_submitted"] = True
    entry["completed"] = True
    entry["last_error"] = last_error
    save_attempt_state(state)


def process_filing(filing: dict, state: dict) -> str:
    """
    Process one filing. Returns outcome tag:
      published | needs_review_with_rows | skipped_backoff | skipped_exhausted | failed
    """
    doc_id = filing.get("doc_id")
    if not doc_id:
        return "failed"
    if not filing.get("raw_object_key") and not (
        filing.get("stored_document_url") or filing.get("storedDocumentUrl")
    ):
        logger.warning(
            "skip %s: no stored copy (raw_object_key) — never re-download from source",
            doc_id,
        )
        record_failure(state, doc_id, "no_stored_copy", active_engine_label())
        return "failed"

    entry = doc_entry(state, doc_id)
    now = time.time()
    if entry.get("review_submitted") or entry.get("completed"):
        logger.info("cap: skip already-submitted-to-review doc=%s", doc_id)
        return "skipped_review_submitted"
    if entry.get("exhausted"):
        logger.info(
            "cap: skip exhausted doc=%s attempts=%s last=%s",
            doc_id, entry.get("attempts"), (entry.get("last_error") or "")[:80],
        )
        # Re-assert park if API was down earlier.
        if not entry.get("parked"):
            parked = park_local_vision(
                doc_id,
                int(entry.get("attempts") or MAX_ATTEMPTS),
                str(entry.get("last_error") or "exhausted"),
            )
            entry["parked"] = bool(parked)
            save_attempt_state(state)
        return "skipped_exhausted"

    next_eligible = float(entry.get("next_eligible_at") or 0)
    if next_eligible > now:
        wait = int(next_eligible - now)
        logger.info(
            "cap: backoff skip doc=%s attempts=%s next_in=%ds last=%s",
            doc_id, entry.get("attempts"), wait, (entry.get("last_error") or "")[:80],
        )
        return "skipped_backoff"

    logger.info(
        "Processing %s (chamber=%s, engine=%s, prior_attempts=%s, via=stored-raw) ...",
        doc_id, filing.get("chamber"), VISION_ENGINE, entry.get("attempts") or 0,
    )
    extractor = active_engine_label()
    with tempfile.TemporaryDirectory(prefix="vw-") as td:
        pdf_path = os.path.join(td, "filing.pdf")
        if not download_stored_document(filing, pdf_path):
            record_failure(state, doc_id, "stored_download_failed", extractor)
            return "failed"
        pages, total_pages, upright_pdf = render_pages(pdf_path, td)
        if not pages:
            logger.warning(
                "page render failed for %s; PDF-native cascade steps can still run",
                doc_id,
            )
        native_pdf = native_cascade_pdf(pdf_path, upright_pdf)
        rows, extractor = transcribe(native_pdf, pages, filing, td, total_pages)
    if rows is None:
        record_failure(state, doc_id, "transcription_failed", extractor)
        return "failed"

    # Honest empty (noRows:true) is a finished read — "Nothing to report",
    # cover-only page, etc.  Submitting stamps local_vision_submitted so
    # pending will not re-advertise the doc.  Treating [] as zero_transactions
    # retried the same 50 one-pagers all afternoon on 2026-08-21.
    empty = len(rows) == 0
    res = send_request(
        f"{API_BASE_URL}/api/admin/ingest-local-vision",
        method="POST",
        payload={
            "docId": doc_id,
            "transactions": rows,
            "noRows": empty,
            "workerId": WORKER_ID,
            "extractor": extractor,
            "source": "local_mac",
        },
        timeout=120,
    )
    if res.get("ok"):
        published = bool(res.get("published"))
        needs_review = bool(res.get("needsReview"))
        logger.info(
            "%s submitted via %s: %d txs, published=%s needsReview=%s noRows=%s",
            doc_id, extractor, len(rows), published, needs_review, empty,
        )
        if published:
            mark_doc_done(state, doc_id, "published")
            send_pushover(
                "CT local vision: published",
                f"{doc_id}: {len(rows)} tx via {extractor}",
            )
            return "published"
        mark_doc_done(state, doc_id, "empty_norows" if empty else "review_submitted")
        return "empty_submitted" if empty else "needs_review_with_rows"
    logger.error("Submission failed for %s: %s", doc_id, res.get("error"))
    record_failure(state, doc_id, f"submit_failed:{res.get('error')}", extractor)
    return "failed"


def main():
    acquire_worker_lock()
    ensure_grok_cwd()
    if VISION_ENGINE in ("openrouter", "auto") and not OPENROUTER_API_KEY and VISION_ENGINE == "openrouter":
        logger.error("OPENROUTER_API_KEY required when VISION_ENGINE=openrouter")
        sys.exit(2)
    if VISION_ENGINE in ("local_cli", "auto"):
        gb = grok_bin()
        if not os.path.exists(gb) and not shutil.which(gb):
            logger.error("local grok CLI not found (set GROK_BIN). tried %s", gb)
            if VISION_ENGINE == "local_cli":
                sys.exit(2)
            logger.warning("continuing in auto with OpenRouter-only fallback")
    logger.info(
        "Starting vision worker [ID=%s, API=%s, engine=%s, grokBin=%s, orKey=%s, "
        "maxAttempts=%d, maxDocsPerPoll=%d, state=%s]",
        WORKER_ID, API_BASE_URL, active_engine_label(), grok_bin(), bool(OPENROUTER_API_KEY),
        MAX_ATTEMPTS, MAX_DOCS_PER_POLL, STATE_FILE,
    )
    # Grok CLI has no --no-history / ephemeral flag (checked 2026-08-10) —
    # headless -p sessions still appear in Grok Build history. Do not hack around it.
    logger.info(
        "note: grok CLI has no no-history/ephemeral flag; headless sessions may appear in Grok Build UI",
    )
    state = load_attempt_state()
    last_heartbeat = 0.0
    while True:
        now = time.time()
        if now - last_heartbeat >= HEARTBEAT_INTERVAL_SEC:
            # Heartbeat always fires — even when the pending queue is empty —
            # so the app can keep extraction_pending_local wait windows honest.
            send_heartbeat(state)
            last_heartbeat = now
        try:
            filings = get_pending_scanned_filings()
            if filings:
                if len(filings) > MAX_DOCS_PER_POLL:
                    logger.info(
                        "cap: poll backlog capped pending=%d processing=%d (MAX_DOCS_PER_POLL)",
                        len(filings), MAX_DOCS_PER_POLL,
                    )
                # Select the first MAX_DOCS_PER_POLL *processable* docs.
                # Exhausted / backoff docs can sit at the head of the pending
                # list (server sorts newest first); taking the raw head used
                # to starve the whole queue — the worker polled forever,
                # skipping the same two exhausted docs while 46 others waited
                # (observed 2026-08-20, 48-item backlog, zero progress).
                batch = []
                skipped = 0
                now = time.time()
                for f in filings:
                    if len(batch) >= MAX_DOCS_PER_POLL:
                        break
                    doc_id = f.get("doc_id")
                    entry = state.get("docs", {}).get(doc_id) if doc_id else None
                    if entry:
                        if entry.get("review_submitted") or entry.get("completed"):
                            skipped += 1
                            continue
                        if entry.get("exhausted"):
                            skipped += 1
                            # Re-assert the server-side park when the API was
                            # down earlier, so the doc leaves the pending list.
                            if not entry.get("parked") and doc_id:
                                parked = park_local_vision(
                                    doc_id,
                                    int(entry.get("attempts") or MAX_ATTEMPTS),
                                    str(entry.get("last_error") or "exhausted"),
                                )
                                entry["parked"] = bool(parked)
                                save_attempt_state(state)
                            continue
                        next_eligible = float(entry.get("next_eligible_at") or 0)
                        if next_eligible > now:
                            skipped += 1
                            continue
                    batch.append(f)
                if skipped:
                    logger.info(
                        "cap: skipped %d not-yet-processable doc(s) (exhausted/backoff/review); processing %d",
                        skipped, len(batch),
                    )
                logger.info(
                    "Found %d pending scanned filings; processing %d",
                    len(filings), len(batch),
                )
                for f in batch:
                    process_filing(f, state)
            # else: quiet poll; heartbeat above still ran on schedule
        except Exception as e:
            logger.error("Worker poll loop exception: %s", str(e))
        time.sleep(POLL_INTERVAL_SEC)


if __name__ == "__main__":
    main()
