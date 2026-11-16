#!/usr/bin/env python3
"""Read-only inventory of fleet Hetzner dump objects in Backblaze B2.

Lists objects under each configured bucket's hetzner/ prefix (dump sets only;
never deletes or hides).  Uses the ``b2`` CLI when present and authorized, else
``aws s3api`` against the B2 S3-compatible endpoint.  Credentials come from the
environment only; this module never prints secret values.

Exit codes: 0 ok, 1 warn (retention drift or over byte cap), 2 crit (stale prefix).
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Iterable

AGE_BUCKETS = (
    ("lt_1d", 0, 1),
    ("d1_7", 1, 7),
    ("d7_30", 7, 30),
    ("gt_30d", 30, None),
)

DEFAULT_S3_ENDPOINT = "https://s3.eu-central-003.backblazeb2.com"
DEFAULT_S3_REGION = "eu-central-003"
DEFAULT_OBJECT_PREFIX = "hetzner/"
DEFAULT_STALE_HOURS = 26


@dataclass(frozen=True)
class ObjectRow:
    bucket: str
    bucket_label: str
    key: str
    size: int
    mtime: datetime
    is_version: bool = False
    is_hidden: bool = False

    @property
    def top_prefix(self) -> str:
        rel = self.key
        prefix = DEFAULT_OBJECT_PREFIX.rstrip("/") + "/"
        if rel.startswith(prefix):
            rel = rel[len(prefix) :]
        elif rel.startswith("hetzner/"):
            rel = rel[len("hetzner/") :]
        rel = rel.lstrip("/")
        if not rel or "/" not in rel:
            return "(root)"
        return rel.split("/", 1)[0]


@dataclass
class ReportConfig:
    bucket_map: dict[str, str]
    object_prefix: str
    stale_hours: int
    max_age_days: int
    keep_daily: int
    keep_weekly: int
    total_bytes_cap: int | None
    now: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


def _parse_bucket_map() -> dict[str, str]:
    """Label -> bucket name.  Env B2_REPORT_BUCKETS overrides defaults."""
    raw = os.environ.get("B2_REPORT_BUCKETS", "").strip()
    if raw:
        out: dict[str, str] = {}
        for part in raw.split(","):
            part = part.strip()
            if not part:
                continue
            if "=" in part:
                label, bucket = part.split("=", 1)
                out[label.strip()] = bucket.strip()
            else:
                out[part] = part
        if out:
            return out
    congress = (
        os.environ.get("B2_BUCKET_CONGRESS")
        or os.environ.get("FLEET_B2_BUCKET_CONGRESS")
        or ("jays-" + "congress-trade-eu")
    )
    return {
        "congress": congress,
        "socratic": "jays-socratic-trade-eu",
        "usage-monitor": "jays-usage-monitor-eu",
    }


def load_config() -> ReportConfig:
    cap_raw = os.environ.get("B2_REPORT_TOTAL_BYTES_CAP", "").strip()
    cap: int | None
    if cap_raw:
        cap = int(cap_raw)
    else:
        cap = None
    stale = int(os.environ.get("B2_REPORT_STALE_HOURS", str(DEFAULT_STALE_HOURS)))
    prefix = os.environ.get("B2_REPORT_PREFIX", DEFAULT_OBJECT_PREFIX)
    if not prefix.endswith("/"):
        prefix += "/"
    return ReportConfig(
        bucket_map=_parse_bucket_map(),
        object_prefix=prefix,
        stale_hours=stale,
        max_age_days=int(os.environ.get("B2_MAX_AGE_DAYS", "14")),
        keep_daily=int(os.environ.get("B2_KEEP_DAILY", "3")),
        keep_weekly=int(os.environ.get("B2_KEEP_WEEKLY", "2")),
        total_bytes_cap=cap,
    )


def age_bucket(age_days: float) -> str:
    for name, lo, hi in AGE_BUCKETS:
        if hi is None and age_days >= lo:
            return name
        if hi is not None and lo <= age_days < hi:
            return name
    return "gt_30d"


def run_subprocess(argv: list[str], *, env: dict[str, str] | None = None) -> str:
    merged = os.environ.copy()
    if env:
        merged.update(env)
    proc = subprocess.run(
        argv,
        check=False,
        capture_output=True,
        text=True,
        env=merged,
    )
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip()
        raise RuntimeError(f"command failed ({proc.returncode}): {' '.join(argv)}: {err}")
    return proc.stdout


def list_via_b2_json(bucket: str, prefix: str) -> list[dict[str, Any]]:
    folder = prefix.rstrip("/")
    argv = ["b2", "ls", "--json", "--recursive", bucket, folder]
    if os.environ.get("B2_REPORT_INCLUDE_VERSIONS", "0") == "1":
        argv = ["b2", "ls", "--json", "--versions", "--recursive", bucket, folder]
    out = run_subprocess(argv)
    rows: list[dict[str, Any]] = []
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return rows


def list_via_aws(bucket: str, prefix: str) -> list[dict[str, Any]]:
    endpoint = os.environ.get("B2_S3_ENDPOINT", DEFAULT_S3_ENDPOINT)
    region = os.environ.get("B2_S3_REGION", DEFAULT_S3_REGION)
    rows: list[dict[str, Any]] = []
    token: str | None = None
    include_versions = os.environ.get("B2_REPORT_INCLUDE_VERSIONS", "0") == "1"
    while True:
        if include_versions:
            argv = [
                "aws",
                "s3api",
                "list-object-versions",
                "--bucket",
                bucket,
                "--prefix",
                prefix,
                "--endpoint-url",
                endpoint,
                "--region",
                region,
                "--output",
                "json",
            ]
        else:
            argv = [
                "aws",
                "s3api",
                "list-objects-v2",
                "--bucket",
                bucket,
                "--prefix",
                prefix,
                "--endpoint-url",
                endpoint,
                "--region",
                region,
                "--output",
                "json",
            ]
        if token:
            argv.extend(["--starting-token", token])
        payload = json.loads(run_subprocess(argv))
        if include_versions:
            for v in payload.get("Versions") or []:
                rows.append(
                    {
                        "fileName": v.get("Key"),
                        "size": v.get("Size", 0),
                        "uploadTimestamp": _iso_to_ms(v.get("LastModified")),
                        "action": "upload",
                    }
                )
            for m in payload.get("DeleteMarkers") or []:
                rows.append(
                    {
                        "fileName": m.get("Key"),
                        "size": 0,
                        "uploadTimestamp": _iso_to_ms(m.get("LastModified")),
                        "action": "hide",
                    }
                )
        else:
            for v in payload.get("Contents") or []:
                rows.append(
                    {
                        "fileName": v.get("Key"),
                        "size": v.get("Size", 0),
                        "uploadTimestamp": _iso_to_ms(v.get("LastModified")),
                        "action": "upload",
                    }
                )
        if not payload.get("IsTruncated"):
            break
        token = payload.get("NextToken") or payload.get("NextContinuationToken")
        if not token:
            break
    return rows


def _iso_to_ms(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return int(value)
    text = str(value).replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(text)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp() * 1000)
    except ValueError:
        return None


def b2_rows_to_objects(
    bucket: str, label: str, raw_rows: Iterable[dict[str, Any]], *, prefix: str
) -> list[ObjectRow]:
    out: list[ObjectRow] = []
    for row in raw_rows:
        key = row.get("fileName") or row.get("name") or ""
        if not key.startswith(prefix.rstrip("/")) and not key.startswith("hetzner/"):
            if prefix not in key and not key.startswith("hetzner"):
                continue
        size = int(row.get("size") or row.get("contentLength") or 0)
        ts_ms = row.get("uploadTimestamp") or row.get("contentTimestamp")
        if ts_ms is None:
            continue
        mtime = datetime.fromtimestamp(int(ts_ms) / 1000.0, tz=timezone.utc)
        action = (row.get("action") or "upload").lower()
        is_hidden = action == "hide"
        is_version = bool(row.get("fileId") or row.get("versionId"))
        out.append(
            ObjectRow(
                bucket=bucket,
                bucket_label=label,
                key=key,
                size=size,
                mtime=mtime,
                is_version=is_version,
                is_hidden=is_hidden,
            )
        )
    return out


def collapse_to_current_objects(objects: list[ObjectRow]) -> list[ObjectRow]:
    """When version listing is enabled, keep only the latest row per key (skip hidden heads)."""
    latest: dict[tuple[str, str], ObjectRow] = {}
    for obj in objects:
        key = (obj.bucket_label, obj.key)
        prev = latest.get(key)
        if prev is None or obj.mtime > prev.mtime:
            latest[key] = obj
    return [row for row in latest.values() if not row.is_hidden]


def choose_lister() -> Callable[[str, str], list[dict[str, Any]]]:
    fixture = os.environ.get("B2_REPORT_FIXTURE_DIR")
    if fixture:
        return lambda bucket, prefix: _load_fixture(fixture, bucket, prefix)

    if shutil.which("b2"):
        key_id = os.environ.get("B2_APPLICATION_KEY_ID") or os.environ.get(
            "B2_ACCOUNT_ID"
        )
        if key_id and os.environ.get("B2_APPLICATION_KEY"):
            return list_via_b2_json

    if shutil.which("aws"):
        if os.environ.get("AWS_ACCESS_KEY_ID") and os.environ.get("AWS_SECRET_ACCESS_KEY"):
            return list_via_aws

    raise RuntimeError(
        "no list backend: install b2 CLI with B2_APPLICATION_KEY_ID/B2_APPLICATION_KEY "
        "or aws CLI with AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY (and B2_S3_ENDPOINT)"
    )


def _load_fixture(fixture_dir: str, bucket: str, prefix: str) -> list[dict[str, Any]]:
    path = os.path.join(fixture_dir, f"{bucket}.json")
    if not os.path.isfile(path):
        return []
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    return data if isinstance(data, list) else data.get("objects", [])


def collect_objects(
    cfg: ReportConfig, lister: Callable[[str, str], list[dict[str, Any]]]
) -> list[ObjectRow]:
    all_rows: list[ObjectRow] = []
    for label, bucket in sorted(cfg.bucket_map.items()):
        raw = lister(bucket, cfg.object_prefix)
        all_rows.extend(b2_rows_to_objects(bucket, label, raw, prefix=cfg.object_prefix))
    if os.environ.get("B2_REPORT_INCLUDE_VERSIONS", "0") == "1":
        all_rows = collapse_to_current_objects(all_rows)
    return all_rows


def build_report(cfg: ReportConfig, objects: list[ObjectRow]) -> dict[str, Any]:
    now = cfg.now
    stale_cutoff = now.timestamp() - cfg.stale_hours * 3600
    max_age_secs = cfg.max_age_days * 86400

    total_bytes = 0
    total_count = 0
    by_age: dict[str, dict[str, int]] = {
        name: {"bytes": 0, "count": 0} for name, _, _ in AGE_BUCKETS
    }
    by_bucket: dict[str, Any] = {}
    by_prefix: dict[str, dict[str, Any]] = defaultdict(
        lambda: {"bytes": 0, "count": 0, "newest": None, "oldest": None}
    )

    over_retention: list[dict[str, Any]] = []
    flags: list[str] = []

    for obj in objects:
        if obj.is_hidden and os.environ.get("B2_REPORT_SKIP_HIDDEN", "1") == "1":
            continue
        total_bytes += obj.size
        total_count += 1
        age_days = (now - obj.mtime).total_seconds() / 86400.0
        bucket = age_bucket(age_days)
        by_age[bucket]["bytes"] += obj.size
        by_age[bucket]["count"] += 1

        b = by_bucket.setdefault(
            obj.bucket_label,
            {
                "bucket": obj.bucket,
                "bytes": 0,
                "count": 0,
                "newest": None,
                "by_top_prefix": {},
            },
        )
        b["bytes"] += obj.size
        b["count"] += 1
        newest = b["newest"]
        if newest is None or obj.mtime > datetime.fromisoformat(newest):
            b["newest"] = obj.mtime.isoformat()

        tp = obj.top_prefix
        pstats = b["by_top_prefix"].setdefault(
            tp, {"bytes": 0, "count": 0, "newest": None}
        )
        pstats["bytes"] += obj.size
        pstats["count"] += 1
        if pstats["newest"] is None or obj.mtime > datetime.fromisoformat(
            pstats["newest"]
        ):
            pstats["newest"] = obj.mtime.isoformat()

        gkey = f"{obj.bucket_label}/{tp}"
        gps = by_prefix[gkey]
        gps["bytes"] += obj.size
        gps["count"] += 1
        if gps["newest"] is None or obj.mtime > datetime.fromisoformat(gps["newest"]):
            gps["newest"] = obj.mtime.isoformat()
        if gps["oldest"] is None or obj.mtime < datetime.fromisoformat(gps["oldest"]):
            gps["oldest"] = obj.mtime.isoformat()

        if (now - obj.mtime).total_seconds() > max_age_secs:
            over_retention.append(
                {
                    "bucket": obj.bucket_label,
                    "key": obj.key,
                    "mtime": obj.mtime.isoformat(),
                    "age_days": round(age_days, 2),
                }
            )

    stale_prefixes: list[dict[str, Any]] = []
    for label in cfg.bucket_map:
        b = by_bucket.get(label)
        newest_ts = None
        if b and b.get("newest"):
            newest_ts = datetime.fromisoformat(b["newest"]).timestamp()
        if newest_ts is None or newest_ts < stale_cutoff:
            stale_prefixes.append(
                {
                    "bucket_label": label,
                    "bucket": cfg.bucket_map[label],
                    "prefix": cfg.object_prefix,
                    "newest": b.get("newest") if b else None,
                    "stale_hours": cfg.stale_hours,
                }
            )

    over_cap = False
    if cfg.total_bytes_cap is not None and total_bytes > cfg.total_bytes_cap:
        over_cap = True
        flags.append("total_bytes_over_cap")

    if stale_prefixes:
        flags.append("stale_prefix")
    if over_retention:
        flags.append("over_retention")

    if stale_prefixes:
        exit_code = 2
        status = "crit"
    elif over_retention or over_cap:
        exit_code = 1
        status = "warn"
    else:
        exit_code = 0
        status = "ok"

    return {
        "status": status,
        "exit_code": exit_code,
        "generated_at": now.isoformat(),
        "retention": {
            "max_age_days": cfg.max_age_days,
            "keep_daily": cfg.keep_daily,
            "keep_weekly": cfg.keep_weekly,
            "note": "max_age_days matches fleet-sqlite-backup.sh B2_MAX_AGE_DAYS; "
            "keep_daily/weekly are informational for operators",
        },
        "config": {
            "object_prefix": cfg.object_prefix,
            "stale_hours": cfg.stale_hours,
            "total_bytes_cap": cfg.total_bytes_cap,
            "buckets": list(cfg.bucket_map.keys()),
        },
        "totals": {"bytes": total_bytes, "count": total_count},
        "by_age": by_age,
        "by_bucket": by_bucket,
        "by_top_prefix": dict(by_prefix),
        "flags": {
            "codes": flags,
            "stale_prefixes": stale_prefixes,
            "over_retention_count": len(over_retention),
            "over_retention_sample": over_retention[:20],
            "total_bytes_over_cap": over_cap,
        },
    }


def format_text(report: dict[str, Any]) -> str:
    lines: list[str] = []
    lines.append(f"b2-backup-report status={report['status']} exit={report['exit_code']}")
    lines.append(
        f"totals: {report['totals']['count']} objects, "
        f"{report['totals']['bytes']} bytes"
    )
    lines.append(
        f"retention max_age_days={report['retention']['max_age_days']} "
        f"keep_daily={report['retention']['keep_daily']} "
        f"keep_weekly={report['retention']['keep_weekly']}"
    )
    for label, body in sorted(report.get("by_bucket", {}).items()):
        lines.append(
            f"bucket {label} ({body['bucket']}): {body['count']} objects, "
            f"{body['bytes']} bytes, newest={body.get('newest')}"
        )
        for tp, ps in sorted((body.get("by_top_prefix") or {}).items()):
            lines.append(
                f"  prefix {tp}: {ps['count']} objects, {ps['bytes']} bytes, "
                f"newest={ps.get('newest')}"
            )
    lines.append("age buckets:")
    for name, stats in report.get("by_age", {}).items():
        lines.append(f"  {name}: {stats['count']} objects, {stats['bytes']} bytes")
    flags = report.get("flags") or {}
    if flags.get("stale_prefixes"):
        lines.append("CRIT stale prefixes (no object within stale window):")
        for row in flags["stale_prefixes"]:
            lines.append(
                f"  {row['bucket_label']} newest={row.get('newest')} "
                f"(>{row['stale_hours']}h)"
            )
    if flags.get("over_retention_count"):
        lines.append(
            f"WARN {flags['over_retention_count']} object(s) older than "
            f"{report['retention']['max_age_days']}d (sample below)"
        )
        for row in flags.get("over_retention_sample") or []:
            lines.append(f"  {row['bucket']} {row['key']} age={row['age_days']}d")
    if flags.get("total_bytes_over_cap"):
        lines.append("WARN total bytes exceed B2_REPORT_TOTAL_BYTES_CAP")
    return "\n".join(lines)


def parse_fixture_objects(text: str, bucket: str, label: str, prefix: str) -> list[ObjectRow]:
    """Parse mocked b2 ls --json lines (used in offline tests)."""
    rows = []
    for line in text.strip().splitlines():
        rows.append(json.loads(line))
    return b2_rows_to_objects(bucket, label, rows, prefix=prefix)


def _fail(exc: BaseException, *, json_out: bool) -> int:
    if json_out:
        print(json.dumps({"status": "crit", "exit_code": 2, "error": str(exc)}))
    else:
        print(f"b2-backup-report FAIL: {exc}", file=sys.stderr)
    return 2


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Read-only B2 hetzner/ backup report")
    parser.add_argument("--json", action="store_true", help="Emit JSON on stdout")
    args = parser.parse_args(argv)

    try:
        cfg = load_config()
        lister = choose_lister()
        objects = collect_objects(cfg, lister)
        report = build_report(cfg, objects)
    except Exception as exc:
        return _fail(exc, json_out=args.json)

    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print(format_text(report))
    return int(report["exit_code"])


if __name__ == "__main__":
    raise SystemExit(main())
