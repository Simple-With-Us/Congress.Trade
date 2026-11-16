#!/usr/bin/env python3
"""Latency week tracker — public (+ optional admin) health for CT live-win focus.

See docs/rollouts/2026-08-06-latency-week-focus.md.

Usage:
  python3 scripts/latency-week-tracker.py
  ADMIN_TOKEN=… python3 scripts/latency-week-tracker.py --admin

Never prints secrets. Exit 2 if any alert fires.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

BASE = os.environ.get("CT_BASE_URL", "https://congress.trade").rstrip("/")
ROOT = Path(__file__).resolve().parents[1]
SAMPLES = ROOT / "docs" / "latency-week" / "samples"


def http_json(url: str, *, token: str | None = None, method: str = "GET", body: bytes | None = None) -> Any:
    headers = {"Accept": "application/json", "User-Agent": "congress.trade-latency-week-tracker/1"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=45) as res:
        return json.loads(res.read().decode("utf-8"))


def et_hour_now() -> int:
    # America/New_York hour without zoneinfo dependency quirks on older Python.
    parts = datetime.now(timezone.utc).astimezone().timetuple()  # local fallback
    try:
        from zoneinfo import ZoneInfo

        return datetime.now(ZoneInfo("America/New_York")).hour
    except Exception:
        return parts.tm_hour


def weekday_et() -> int:
    try:
        from zoneinfo import ZoneInfo

        return datetime.now(ZoneInfo("America/New_York")).weekday()  # Mon=0
    except Exception:
        return datetime.now(timezone.utc).weekday()


def collect(public_only: bool = True) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    out: dict[str, Any] = {
        "ts": now.isoformat().replace("+00:00", "Z"),
        "base": BASE,
        "alerts": [],
        "health": None,
        "latency": None,
        "txByChamber": {},
        "admin": None,
    }

    try:
        out["health"] = http_json(f"{BASE}/api/health")
    except Exception as e:
        out["alerts"].append(f"health_fetch_failed:{type(e).__name__}")

    try:
        out["latency"] = http_json(f"{BASE}/api/analytics/latency-summary")
    except Exception as e:
        out["alerts"].append(f"latency_fetch_failed:{type(e).__name__}")

    for chamber in ("house", "senate", "executive"):
        try:
            d = http_json(f"{BASE}/api/transactions?chamber={chamber}&limit=1")
            out["txByChamber"][chamber] = {
                "total": d.get("total"),
                "filingsImportedToday": d.get("filingsImportedToday"),
            }
        except Exception as e:
            out["alerts"].append(f"tx_{chamber}_failed:{type(e).__name__}")

    token = (os.environ.get("ADMIN_TOKEN") or os.environ.get("CT_ADMIN_TOKEN") or "").strip()
    if token and not public_only:
        admin: dict[str, Any] = {}
        try:
            admin["summary"] = http_json(f"{BASE}/api/admin/disclosure-latency/summary", token=token)
        except Exception as e:
            admin["summaryError"] = type(e).__name__
            out["alerts"].append(f"admin_summary_failed:{type(e).__name__}")
        try:
            # Force probe is expensive; only list latest candidates slice.
            admin["candidates"] = http_json(
                f"{BASE}/api/admin/disclosure-latency?limit=50", token=token
            )
        except Exception as e:
            admin["candidatesError"] = type(e).__name__
        out["admin"] = admin

    # --- alert rules (week focus) ---
    h = out.get("health") or {}
    if h and not h.get("ok"):
        out["alerts"].append("health_not_ok")
    for check in (h.get("pipeline") or {}).get("checks") or []:
        if check.get("id") == "data_freshness" and check.get("status") not in ("ok", "pass", None):
            if check.get("status") not in ("ok",):
                out["alerts"].append(f"data_freshness:{check.get('status')}")

    imported = [c.get("filingsImportedToday") for c in out["txByChamber"].values() if isinstance(c, dict)]
    if imported and all(v == 0 for v in imported if v is not None):
        # Weekday after 16:00 ET → expect some discovery on busy days; still flag for review.
        if weekday_et() < 5 and et_hour_now() >= 16:
            out["alerts"].append("filingsImportedToday_all_zero_after_16et_weekday")

    lat = out.get("latency") or {}
    for p in lat.get("providers") or []:
        pid = p.get("id") or p.get("provider") or "?"
        matched = p.get("matched") or 0
        avg = p.get("avgLeadSec")
        med = p.get("medianLeadSec")
        ops = p.get("operationalStatus")
        if ops == "error":
            out["alerts"].append(f"provider_error:{pid}")
        if matched and avg is None and med is None:
            out["alerts"].append(f"null_lead_with_matches:{pid}:matched={matched}")
        if pid in ("fmp", "fmp_rapidapi") and matched == 0 and (p.get("providerObserved") or 0) > 50:
            out["alerts"].append(f"fmp_obs_without_matches:{pid}:obs={p.get('providerObserved')}")
        if pid == "fmp_rapidapi" and (p.get("providerObserved") or 0) == 0:
            out["alerts"].append("fmp_rapidapi_zero_observations")

    # Admin candidate null-timestamp check
    admin = out.get("admin") or {}
    items = (admin.get("candidates") or {}).get("items") or []
    null_lead = 0
    for i in items:
        if i.get("status") != "matched":
            continue
        if i.get("providerDeltaSec") is None and i.get("providerPublishedDeltaSec") is None:
            if not i.get("providerFirstSeenAt") and not i.get("providerPublishedAt"):
                null_lead += 1
    if null_lead:
        out["alerts"].append(f"admin_matched_null_timestamps:{null_lead}")

    return out


def summarize(rec: dict[str, Any]) -> str:
    lines = [f"latency-week {rec['ts']} base={rec['base']}"]
    h = rec.get("health") or {}
    lines.append(f"  health ok={h.get('ok')} status={h.get('status')}")
    is_weekend = False
    try:
        is_weekend = weekday_et() >= 5
    except Exception:
        pass
    for ch, v in (rec.get("txByChamber") or {}).items():
        imp = v.get('filingsImportedToday')
        note = " (weekend pause)" if is_weekend and imp == 0 else ""
        lines.append(f"  tx {ch}: total={v.get('total')} importedToday={imp}{note}")
    for p in (rec.get("latency") or {}).get("providers") or []:
        lines.append(
            f"  {p.get('id')}: ops={p.get('operationalStatus')} matched={p.get('matched')} "
            f"avg={p.get('avgLeadSec')} med={p.get('medianLeadSec')} obs={p.get('providerObserved')}"
        )
    t = (rec.get("latency") or {}).get("totals") or {}
    if t:
        lines.append(f"  totals raced={t.get('racedDisclosures')} matched={t.get('matched')} pending={t.get('pending')}")
    for a in rec.get("alerts") or []:
        lines.append(f"  ALERT {a}")
    if not rec.get("alerts"):
        lines.append("  OK no alerts")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--admin", action="store_true", help="Also hit admin APIs if ADMIN_TOKEN set")
    ap.add_argument("--no-write", action="store_true", help="Do not append JSONL sample")
    args = ap.parse_args()

    rec = collect(public_only=not args.admin)
    print(summarize(rec))

    if not args.no_write:
        SAMPLES.mkdir(parents=True, exist_ok=True)
        day = rec["ts"][:10]
        path = SAMPLES / f"{day}.jsonl"
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec, separators=(",", ":")) + "\n")
        print(f"  wrote {path}")

    return 2 if rec.get("alerts") else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except urllib.error.HTTPError as e:
        print(f"HTTPError {e.code} {e.reason}", file=sys.stderr)
        raise SystemExit(1)
