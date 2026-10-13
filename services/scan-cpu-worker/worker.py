#!/usr/bin/env python3
"""
Server CPU scan worker for Congress.Trade.

Linux/ARM64-friendly. Polls pending scanned_pdf filings, extracts via
Tesseract (or Surya/docTR) + deterministic checkbox ink-ratio, submits to
POST /api/admin/ingest-local-vision with source=server_cpu.

No Mac. No LLM.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional

from infisical_config import resolve_admin_token
from pipeline import extract_pdf

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("scan-cpu-worker")

API_BASE_URL = os.getenv("CONGRESS_TRADE_API_URL", "http://localhost:8787").rstrip("/")
ADMIN_TOKEN = ""
WORKER_ID = os.getenv("WORKER_ID", "server_cpu_1")
POLL_INTERVAL_SEC = int(os.getenv("POLL_INTERVAL_SEC", "30"))
STORE_AUTH_BACKOFF_SEC = int(os.getenv("STORE_AUTH_BACKOFF_SEC", "300"))
HEARTBEAT_INTERVAL_SEC = int(os.getenv("HEARTBEAT_INTERVAL_SEC", "60"))
OCR_BACKEND = os.getenv("OCR_BACKEND", "tesseract")
EXTRACTOR = os.getenv("EXTRACTOR", "server_cpu_v1")


class StoredCopyAuthError(RuntimeError):
    """Object store rejected credentials. Stop the pending batch."""


def init_admin_token() -> None:
    """Load ADMIN_TOKEN from env or Infisical; refuse to run without it."""
    global ADMIN_TOKEN
    try:
        ADMIN_TOKEN = resolve_admin_token()
    except Exception as e:
        logger.error("FATAL: cannot resolve ADMIN_TOKEN: %s", e)
        raise SystemExit(1) from e
    if not ADMIN_TOKEN:
        logger.error("FATAL: ADMIN_TOKEN is empty after resolution")
        raise SystemExit(1)


def send_request(
    url: str,
    method: str = "GET",
    payload: Optional[Dict[str, Any]] = None,
    timeout: int = 60,
) -> Dict[str, Any]:
    req = urllib.request.Request(url, method=method)
    req.add_header("Content-Type", "application/json")
    if ADMIN_TOKEN:
        req.add_header("Authorization", f"Bearer {ADMIN_TOKEN}")
    data_bytes = json.dumps(payload).encode("utf-8") if payload is not None else None
    try:
        with urllib.request.urlopen(req, data=data_bytes, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")
        logger.error("HTTP %d for %s: %s", e.code, url, err_body[:500])
        return {"ok": False, "error": f"HTTP {e.code}: {err_body[:300]}"}
    except Exception as e:
        logger.error("Request error for %s: %s", url, e)
        return {"ok": False, "error": str(e)}


def send_heartbeat() -> bool:
    url = f"{API_BASE_URL}/api/admin/local-worker/heartbeat"
    payload = {
        "workerId": WORKER_ID,
        "statusJson": {
            "engine": "server_cpu",
            "ocrBackend": OCR_BACKEND,
            "extractor": EXTRACTOR,
            "platform": sys.platform,
            "pythonVersion": sys.version.split()[0],
            "activeAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        },
    }
    res = send_request(url, method="POST", payload=payload)
    if res.get("ok"):
        logger.info("Heartbeat ok workerId=%s", WORKER_ID)
        return True
    logger.warning("Heartbeat failed: %s", res.get("error"))
    return False


def get_pending_scanned_filings() -> List[Dict[str, Any]]:
    url = f"{API_BASE_URL}/api/admin/scanned-filings/pending"
    res = send_request(url, method="GET")
    if res.get("ok") and isinstance(res.get("filings"), list):
        return res["filings"]
    return []


def stored_document_url(filing: Dict[str, Any]) -> Optional[str]:
    """Admin URL for durable R2 bytes. Never uses source_url / primary gov hosts."""
    explicit = filing.get("stored_document_url") or filing.get("storedDocumentUrl")
    if isinstance(explicit, str) and explicit.strip():
        path = explicit.strip()
        if path.startswith("http://") or path.startswith("https://"):
            return path
        return f"{API_BASE_URL}{path if path.startswith('/') else '/' + path}"
    doc_id = filing.get("doc_id")
    if not doc_id or not filing.get("raw_object_key"):
        return None
    return f"{API_BASE_URL}/api/admin/filings/{urllib.parse.quote(str(doc_id), safe='')}/raw"


def download_stored_document(filing: Dict[str, Any], dest: str) -> bool:
    url = stored_document_url(filing)
    if not url:
        logger.warning(
            "no stored copy for %s — refusing source re-download",
            filing.get("doc_id"),
        )
        return False
    try:
        req = urllib.request.Request(url)
        if ADMIN_TOKEN:
            req.add_header("Authorization", f"Bearer {ADMIN_TOKEN}")
        req.add_header("User-Agent", "congress-scan-cpu-worker/stored-raw")
        with urllib.request.urlopen(req, timeout=120) as resp, open(dest, "wb") as f:
            f.write(resp.read())
        return os.path.getsize(dest) > 100
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:200]
        logger.warning("stored download failed %s: HTTP %s %s", url, e.code, body)
        if e.code in (401, 403, 500, 503) and "unauthor" in body.lower():
            raise StoredCopyAuthError(f"HTTP {e.code}")
        return False
    except Exception as e:
        logger.warning("stored download failed %s: %s", url, e)
        return False


def process_filing(filing: Dict[str, Any]) -> bool:
    doc_id = filing.get("doc_id")
    if not doc_id:
        return False
    logger.info("Processing %s (via=stored-raw) …", doc_id)
    pdf_path = f"/tmp/{doc_id}.pdf"
    ok_dl = download_stored_document(filing, pdf_path)
    if not ok_dl or not os.path.exists(pdf_path):
        logger.error("No stored PDF for %s", doc_id)
        return False

    try:
        transactions = extract_pdf(pdf_path, ocr_backend=OCR_BACKEND)
    except Exception as e:
        logger.exception("extract_pdf failed for %s: %s", doc_id, e)
        transactions = []
    finally:
        try:
            os.remove(pdf_path)
        except OSError:
            pass

    url = f"{API_BASE_URL}/api/admin/ingest-local-vision"
    payload = {
        "docId": doc_id,
        "transactions": transactions,
        "workerId": WORKER_ID,
        "extractor": EXTRACTOR,
        "source": "server_cpu",
    }
    res = send_request(url, method="POST", payload=payload, timeout=120)
    if res.get("ok"):
        logger.info(
            "Submitted %s: txCount=%s published=%s needsReview=%s",
            doc_id, res.get("txCount"), res.get("published"), res.get("needsReview"),
        )
        return True
    logger.error("Submit failed for %s: %s", doc_id, res.get("error"))
    return False


def run_loop() -> None:
    logger.info(
        "Starting server CPU scan worker id=%s api=%s ocr=%s",
        WORKER_ID, API_BASE_URL, OCR_BACKEND,
    )
    last_hb = 0.0
    while True:
        now = time.time()
        if now - last_hb >= HEARTBEAT_INTERVAL_SEC:
            send_heartbeat()
            last_hb = now
        try:
            filings = get_pending_scanned_filings()
            if filings:
                logger.info("Pending scanned filings: %d", len(filings))
                for f in filings:
                    process_filing(f)
        except StoredCopyAuthError as e:
            logger.error(
                "stored-raw auth failed (%s); backing off %ss instead of spinning the backlog",
                e,
                STORE_AUTH_BACKOFF_SEC,
            )
            time.sleep(STORE_AUTH_BACKOFF_SEC)
            continue
        except Exception as e:
            logger.exception("Poll loop error: %s", e)
        time.sleep(POLL_INTERVAL_SEC)


def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(description="Congress.Trade server CPU scan worker")
    p.add_argument("--once", action="store_true", help="Process pending once then exit")
    p.add_argument("--pdf", help="Local PDF path for offline extract")
    p.add_argument("--doc-id", default="LOCAL-TEST", help="docId for --pdf offline mode")
    p.add_argument("--json-out", help="Write extracted txs JSON to path")
    args = p.parse_args(argv)

    if args.pdf:
        txs = extract_pdf(args.pdf, ocr_backend=OCR_BACKEND)
        print(json.dumps({"docId": args.doc_id, "txCount": len(txs), "transactions": txs}, indent=2))
        if args.json_out:
            with open(args.json_out, "w") as f:
                json.dump(txs, f, indent=2)
        return 0

    init_admin_token()

    if args.once:
        send_heartbeat()
        for f in get_pending_scanned_filings():
            process_filing(f)
        return 0

    run_loop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
