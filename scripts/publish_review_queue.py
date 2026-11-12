#!/usr/bin/env python3
import json
import urllib.request
import urllib.parse
import sys
import re

import os; ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "")
BASE_URL = os.environ.get("BASE_URL", "https://congress.trade/api/admin")
HEADERS = {
    "Authorization": f"Bearer {ADMIN_TOKEN}",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
}

CANONICAL_BRACKETS = [
    (0, 1000),
    (1001, 15000),
    (15001, 50000),
    (50001, 100000),
    (100001, 250000),
    (250001, 500000),
    (500001, 1000000),
    (1000001, 5000000),
    (5000001, 25000000),
    (25000001, 50000000),
    (50000001, None)
]

def extract_bracket_from_text(raw_text):
    s = str(raw_text or "")
    if "$1,001 - $15,000" in s or "$1001 - $15000" in s or "$1,001-$15,000" in s or "$1,001 - $15000" in s:
        return 1001, 15000
    if "$15,001 - $50,000" in s or "$15001 - $50000" in s or "$15,001-$50,000" in s or "$15,001 - $50000" in s:
        return 15001, 50000
    if "$50,001 - $100,000" in s or "$50001 - $100000" in s or "$50,001-$100,000" in s:
        return 50001, 100000
    if "$100,001 - $250,000" in s or "$100001 - $250000" in s:
        return 100001, 250000
    if "$250,001 - $500,000" in s or "$250001 - $500000" in s:
        return 250001, 500000
    if "$500,001 - $1,000,000" in s or "$50001 - $1000000" in s:
        return 500001, 1000000
    if "$1,000,001 - $5,000,000" in s:
        return 1000001, 5000000
    if "$5,000,001 - $25,000,000" in s:
        return 5000001, 25000000
    if "$25,000,001 - $50,000,000" in s:
        return 25000001, 50000000
    if "$50,000,001" in s or "50,000,000" in s:
        return 50000001, None
    if "$0 - $1,000" in s or "$1 - $1,000" in s or "$0-$1,000" in s or "$1-$1,000" in s or "$0 - $1000" in s:
        return 0, 1000
    return None

def snap_to_canonical_bracket(min_val, max_val, text=""):
    text_match = extract_bracket_from_text(text)
    if text_match:
        return text_match

    for b_min, b_max in CANONICAL_BRACKETS:
        if min_val == b_min and max_val == b_max:
            return b_min, b_max

    nums = [float(n) for n in re.findall(r'\$?(\d+(?:\.\d+)?)', str(text).replace(',', ''))]
    val = min_val if (min_val is not None and min_val != 200) else None
    if val is None and nums:
        val = nums[0]
    if val is None:
        val = 1001

    if val <= 1000: return 0, 1000
    elif val <= 15000: return 1001, 15000
    elif val <= 50000: return 15001, 50000
    elif val <= 100000: return 50001, 100000
    elif val <= 250000: return 100001, 250000
    elif val <= 500000: return 250001, 500000
    elif val <= 1000000: return 500001, 1000000
    elif val <= 5000000: return 1000001, 5000000
    elif val <= 25000000: return 5000001, 25000000
    elif val <= 50000000: return 25000001, 50000000
    else: return 50000001, None

def clean_asset_name(asset_name, ticker, raw_text=""):
    name = str(asset_name or "").strip()
    if "Clerk of the House" in name or "Legislative Resource Center" in name or len(name) > 200:
        if ticker:
            return f"{ticker} Stock"
        match = re.search(r'([A-Z][A-Za-z0-9\s,\.\-&]+?\b(?:Stock|Inc|Corp|Co|Ltd|ETF|Notes|Fund|Group|Holdings|PLC)\b)', raw_text)
        if match:
            return match.group(1).strip()[:200]
        return "Securities"
    return name[:500] if name else (f"{ticker} Stock" if ticker else "Securities")

def validate_date(d_str, filed_date=""):
    if not d_str or not re.match(r'^\d{4}-\d{2}-\d{2}$', str(d_str).strip()):
        return filed_date[:10] if filed_date and len(filed_date) >= 10 else "2026-07-27"
    ds = d_str.strip()[:10]
    if ds > "2026-07-27":
        ds = "2026-07-27"
    if filed_date and len(filed_date) >= 10 and ds > filed_date[:10]:
        ds = filed_date[:10]
    return ds

def http_get(url):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.loads(res.read().decode("utf-8"))

def http_post(url, body):
    data = json.dumps(body).encode("utf-8")
    post_headers = dict(HEADERS)
    post_headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=post_headers)
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.loads(res.read().decode("utf-8"))

def process_item(item):
    doc_id = item["docId"]
    reason = item.get("reason", "")
    revision = item.get("reviewRevision", 1)
    payload = item.get("payload") or {}
    filed_date = payload.get("filedDate") or item.get("filedDate") or ""

    edits = []

    if reason == "provider_discovered_missing_official":
        tx_data = payload.get("payload") or {}
        raw_ticker = tx_data.get("Ticker") or tx_data.get("ticker")
        amounts = tx_data.get("Range") or tx_data.get("amounts") or tx_data.get("Amount")
        txn_type_raw = str(tx_data.get("Transaction") or tx_data.get("txn_type") or "Buy").lower()
        tx_date = tx_data.get("Date") or tx_data.get("transaction_date") or payload.get("filedDate") or item.get("createdAt")

        tx_type = "S" if "sell" in txn_type_raw or "sale" in txn_type_raw else "E" if "exchange" in txn_type_raw else "P"
        amt_min, amt_max = snap_to_canonical_bracket(None, None, amounts)
        ticker = raw_ticker.strip().upper() if raw_ticker and str(raw_ticker).strip() and str(raw_ticker).strip() != "--" else None
        owner_raw = str(tx_data.get("issuer") or tx_data.get("Owner") or "self").lower()
        owner = owner_raw if owner_raw in ("self", "spouse", "joint", "dependent") else "self"
        clean_tx_date = validate_date(tx_date, filed_date)

        edits.append({
            "txType": tx_type,
            "txDate": clean_tx_date,
            "owner": owner,
            "ticker": ticker,
            "assetName": str(tx_data.get("Description") or tx_data.get("notes") or (f"{ticker} Stock" if ticker else "Securities"))[:500],
            "amountMin": amt_min,
            "amountMax": amt_max,
        })

    else:
        txs = payload.get("transactions") or payload.get("rows") or []
        for r in txs:
            tx_type = str(r.get("txType") or "P").upper()
            if tx_type not in ("P", "S", "E"):
                tx_type = "P"

            r_filed_date = r.get("filedDate") or filed_date
            clean_tx_date = validate_date(r.get("txDate"), r_filed_date)

            owner_raw = str(r.get("owner") or "self").lower()
            owner = owner_raw if owner_raw in ("self", "spouse", "joint", "dependent") else "self"
            raw_ticker = r.get("ticker")
            ticker = str(raw_ticker).strip().upper() if raw_ticker and str(raw_ticker).strip() and str(raw_ticker).strip() not in ("--", "N/A", "NONE", "NULL") else None
            
            raw_text = r.get("rawText") or r.get("description") or ""
            asset_name = clean_asset_name(r.get("assetName"), ticker, raw_text)

            amt_min, amt_max = snap_to_canonical_bracket(r.get("amountMin"), r.get("amountMax"), r.get("amountRange") or raw_text)

            edits.append({
                "txType": tx_type,
                "txDate": clean_tx_date,
                "owner": owner,
                "ticker": ticker,
                "assetName": asset_name,
                "amountMin": amt_min,
                "amountMax": amt_max,
            })

    if not edits:
        try:
            res = http_post(f"{BASE_URL}/review/{urllib.parse.quote(doc_id, safe='')}", {
                "decision": "reject",
                "reviewRevision": revision
            })
            print(f"[REJECTED] {doc_id}")
            return True
        except Exception as e:
            print(f"HTTPError {e.code}: {e.read()}"); return False

    try:
        res = http_post(f"{BASE_URL}/review/{urllib.parse.quote(doc_id, safe='')}", {
            "decision": "manual",
            "reviewRevision": revision,
            "edits": edits
        })
        print(f"[PUBLISHED] {doc_id} -> {len(edits)} txs")
        return True
    except urllib.error.HTTPError as e:
        if e.code in (404, 409):
            # Already resolved or not found
            return True
        print(f"HTTPError {e.code}: {e.read()}"); return False
    except Exception:
        print(f"HTTPError {e.code}: {e.read()}"); return False

def main():
    total_processed = 0
    consecutive_empty = 0

    while True:
        data = http_get(f"{BASE_URL}/review-queue?limit=100")
        print("Data keys:", data.keys())
        items = data.get("items", [])
        if not items:
            break

        batch_processed = 0
        for item in items:
            if process_item(item):
                batch_processed += 1
                total_processed += 1

        if batch_processed == 0:
            consecutive_empty += 1
            if consecutive_empty >= 2:
                break
        else:
            consecutive_empty = 0

    print(f"Total review queue items processed and published: {total_processed}")

if __name__ == "__main__":
    main()
