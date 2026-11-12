#!/usr/bin/env python3
"""Report-only root filesystem disk usage finder for the Coolify/Hetzner host.

Read-only: never deletes or modifies files.  Uses nice/ionice, stays on one
filesystem (du/find -x / -xdev), and honors an overall timeout.

Outputs JSON and a short markdown summary.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


SCHEMA_VERSION = 1


def _utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _human_bytes(n: int) -> str:
    if n < 0:
        n = 0
    units = ["B", "KiB", "MiB", "GiB", "TiB"]
    value = float(n)
    for unit in units:
        if value < 1024.0 or unit == units[-1]:
            if unit == "B":
                return f"{int(value)} B"
            return f"{value:.1f} {unit}"
        value /= 1024.0
    return f"{n} B"


@dataclass
class Runner:
    nice_cmd: list[str] = field(default_factory=lambda: ["nice", "-n", "19"])
    ionice_cmd: list[str] = field(default_factory=lambda: ["ionice", "-c3"])
    du_cmd: str = "du"
    find_cmd: str = "find"
    df_cmd: str = "df"
    docker_cmd: str = "docker"
    deadline: float | None = None
    timed_out: bool = False

    def _check_deadline(self) -> None:
        if self.deadline is not None and time.monotonic() >= self.deadline:
            self.timed_out = True
            raise TimeoutError("overall report timeout")

    def run(
        self,
        argv: list[str],
        *,
        timeout: float | None = None,
        text: bool = True,
    ) -> subprocess.CompletedProcess[str]:
        self._check_deadline()
        prefix = [*self.nice_cmd, *self.ionice_cmd, *argv]
        remaining: float | None = None
        if self.deadline is not None:
            remaining = max(0.1, self.deadline - time.monotonic())
            if timeout is not None:
                remaining = min(remaining, timeout)
        elif timeout is not None:
            remaining = timeout
        return subprocess.run(
            prefix,
            check=False,
            capture_output=True,
            text=text,
            timeout=remaining,
        )

    def du_top_directories(
        self, root: Path, depth: int, top_n: int
    ) -> list[dict[str, Any]]:
        self._check_deadline()
        if not root.is_dir():
            return []
        argv = [
            self.du_cmd,
            "-x",
            f"--max-depth={depth}",
            "-B1",
            str(root),
        ]
        proc = self.run(argv)
        if proc.returncode not in (0, 124):
            return []
        entries: list[tuple[int, str]] = []
        for line in (proc.stdout or "").splitlines():
            parts = line.split(maxsplit=1)
            if len(parts) != 2:
                continue
            try:
                size = int(parts[0])
            except ValueError:
                continue
            path = parts[1].strip()
            if path == str(root) and size <= 0:
                continue
            entries.append((size, path))
        entries.sort(key=lambda item: item[0], reverse=True)
        return [
            {"path": path, "size_bytes": size}
            for size, path in entries[:top_n]
        ]

    def find_files(
        self,
        root: Path,
        *,
        min_bytes: int = 0,
        min_mtime_days: int | None = None,
    ) -> list[tuple[int, float, str]]:
        """Return (size_bytes, mtime_epoch, path) for each matching file."""
        self._check_deadline()
        if not root.is_dir():
            return []
        expr = [self.find_cmd, str(root), "-xdev", "-type", "f"]
        if min_bytes > 0:
            expr.extend(["-size", f"+{min_bytes - 1}c"])
        if min_mtime_days is not None and min_mtime_days > 0:
            expr.extend(["-mtime", f"+{min_mtime_days}"])
        # GNU find -printf; tests override FIND_CMD to a mock.
        expr.extend(["-printf", "%s\\t%T@\\t%p\\0"])
        proc = self.run(expr)
        if proc.returncode not in (0, 124):
            return []
        out = proc.stdout or ""
        if "\0" in out:
            blobs = out.split("\0")
        else:
            blobs = out.splitlines()
        results: list[tuple[int, float, str]] = []
        for blob in blobs:
            if not blob.strip():
                continue
            parts = blob.split("\t", 2)
            if len(parts) != 3:
                continue
            try:
                size = int(parts[0])
                mtime = float(parts[1])
            except ValueError:
                continue
            results.append((size, mtime, parts[2]))
        return results

    def df_root(self, root: Path) -> dict[str, Any] | None:
        proc = self.run([self.df_cmd, "-Pk", str(root)])
        lines = (proc.stdout or "").strip().splitlines()
        if len(lines) < 2:
            return None
        parts = lines[1].split()
        if len(parts) < 6:
            return None
        return {
            "filesystem": parts[0],
            "size_kb": int(parts[1]),
            "used_kb": int(parts[2]),
            "avail_kb": int(parts[3]),
            "use_pct": parts[4].rstrip("%"),
            "mount": parts[5],
        }

    def docker_grouped_usage(self) -> dict[str, Any]:
        self._check_deadline()
        base: dict[str, Any] = {
            "available": False,
            "by_container": [],
            "by_volume": [],
            "error": None,
        }
        ps = self.run([self.docker_cmd, "ps", "-aq"])
        if ps.returncode != 0:
            base["error"] = (ps.stderr or ps.stdout or "docker ps failed").strip()
            return base
        ids = [line.strip() for line in (ps.stdout or "").splitlines() if line.strip()]
        by_container: list[dict[str, Any]] = []
        for cid in ids:
            self._check_deadline()
            name_proc = self.run(
                [self.docker_cmd, "inspect", "-f", "{{.Name}}", cid]
            )
            name = (name_proc.stdout or "").strip().lstrip("/") or cid
            upper_proc = self.run(
                [
                    self.docker_cmd,
                    "inspect",
                    "-f",
                    "{{.GraphDriver.Data.UpperDir}}",
                    cid,
                ]
            )
            upper = (upper_proc.stdout or "").strip()
            work_proc = self.run(
                [
                    self.docker_cmd,
                    "inspect",
                    "-f",
                    "{{.GraphDriver.Data.WorkDir}}",
                    cid,
                ]
            )
            work = (work_proc.stdout or "").strip()
            paths = [p for p in (upper, work) if p and os.path.isdir(p)]
            total = 0
            for path in paths:
                du = self.run([self.du_cmd, "-x", "-s", "-B1", path])
                line = (du.stdout or "").split(maxsplit=1)
                if line:
                    try:
                        total += int(line[0])
                    except ValueError:
                        pass
            by_container.append(
                {
                    "container_id": cid,
                    "name": name,
                    "overlay_bytes": total,
                    "paths": paths,
                }
            )
        by_container.sort(key=lambda row: row["overlay_bytes"], reverse=True)

        vol_ps = self.run([self.docker_cmd, "volume", "ls", "-q"])
        if vol_ps.returncode != 0:
            base["error"] = (vol_ps.stderr or vol_ps.stdout or "docker volume ls").strip()
            return base
        vol_ids = [
            line.strip() for line in (vol_ps.stdout or "").splitlines() if line.strip()
        ]
        by_volume: list[dict[str, Any]] = []
        for vid in vol_ids:
            self._check_deadline()
            name_proc = self.run(
                [self.docker_cmd, "volume", "inspect", "-f", "{{.Name}}", vid]
            )
            vname = (name_proc.stdout or "").strip() or vid
            mp_proc = self.run(
                [
                    self.docker_cmd,
                    "volume",
                    "inspect",
                    "-f",
                    "{{.Mountpoint}}",
                    vid,
                ]
            )
            mountpoint = (mp_proc.stdout or "").strip()
            size = 0
            if mountpoint and os.path.isdir(mountpoint):
                du = self.run([self.du_cmd, "-x", "-s", "-B1", mountpoint])
                line = (du.stdout or "").split(maxsplit=1)
                if line:
                    try:
                        size = int(line[0])
                    except ValueError:
                        size = 0
            by_volume.append(
                {"volume_name": vname, "mountpoint": mountpoint, "size_bytes": size}
            )
        by_volume.sort(key=lambda row: row["size_bytes"], reverse=True)
        base["available"] = True
        base["by_container"] = by_container
        base["by_volume"] = by_volume
        return base


def build_markdown(report: dict[str, Any]) -> str:
    lines = [
        f"# Root Disk Usage Report",
        "",
        f"- Captured: `{report.get('captured_at', '')}`",
        f"- Host: `{report.get('host', '')}`",
        f"- Scan root: `{report.get('scan_root', '')}`",
        f"- Timed out: `{report.get('timed_out', False)}`",
        "",
    ]
    fs = report.get("filesystem") or {}
    if fs:
        lines.extend(
            [
                "## Filesystem",
                "",
                f"- Mount `{fs.get('mount', '?')}`: {fs.get('use_pct', '?')}% used "
                f"({fs.get('used_kb', 0)} / {fs.get('size_kb', 0)} KiB)",
                "",
            ]
        )
    lines.append("## Top Directories")
    lines.append("")
    for row in report.get("top_directories") or []:
        lines.append(
            f"- `{row['path']}` — {_human_bytes(int(row['size_bytes']))}"
        )
    lines.extend(["", "## Largest Files", ""])
    for row in report.get("largest_files") or []:
        lines.append(
            f"- `{row['path']}` — {_human_bytes(int(row['size_bytes']))}"
        )
    lines.extend(["", "## Stale Large Files", ""])
    stale = report.get("stale_large_files") or []
    if not stale:
        lines.append("- (none matched threshold)")
    else:
        for row in stale:
            lines.append(
                f"- `{row['path']}` — {_human_bytes(int(row['size_bytes']))}, "
                f"mtime `{row.get('mtime_utc', '')}`"
            )
    docker = report.get("docker") or {}
    lines.extend(["", "## Docker Usage", ""])
    if not docker.get("available"):
        lines.append(f"- Docker unavailable: `{docker.get('error', 'unknown')}`")
    else:
        lines.append("### By container (overlay/work)")
        for row in docker.get("by_container") or []:
            lines.append(
                f"- `{row.get('name', '?')}` — "
                f"{_human_bytes(int(row.get('overlay_bytes', 0)))}"
            )
        lines.append("")
        lines.append("### By volume")
        for row in docker.get("by_volume") or []:
            lines.append(
                f"- `{row.get('volume_name', '?')}` — "
                f"{_human_bytes(int(row.get('size_bytes', 0)))}"
            )
    lines.append("")
    return "\n".join(lines)


def run_report(opts: argparse.Namespace) -> dict[str, Any]:
    root = Path(opts.scan_root).resolve()
    runner = Runner(
        nice_cmd=shlex.split(opts.nice_cmd),
        ionice_cmd=shlex.split(opts.ionice_cmd),
        du_cmd=opts.du_cmd,
        find_cmd=opts.find_cmd,
        df_cmd=opts.df_cmd,
        docker_cmd=opts.docker_cmd,
    )
    if opts.timeout_sec > 0:
        runner.deadline = time.monotonic() + float(opts.timeout_sec)

    report: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "report_kind": "root_disk_usage",
        "captured_at": _utc_now(),
        "host": opts.host or (os.uname().nodename if hasattr(os, "uname") else "unknown"),
        "scan_root": str(root),
        "timeout_sec": opts.timeout_sec,
        "timed_out": False,
        "options": {
            "dir_depth": opts.dir_depth,
            "top_directories": opts.top_directories,
            "largest_files": opts.largest_files,
            "stale_min_bytes": opts.stale_min_bytes,
            "stale_min_days": opts.stale_min_days,
        },
    }

    def safe_step(name: str, fn: Callable[[], Any], default: Any) -> Any:
        try:
            return fn()
        except TimeoutError:
            runner.timed_out = True
            report["timed_out"] = True
            report.setdefault("partial_errors", []).append(f"{name}: timeout")
            return default
        except Exception as exc:  # noqa: BLE001 — report must complete
            report.setdefault("partial_errors", []).append(f"{name}: {exc}")
            return default

    report["filesystem"] = safe_step(
        "filesystem", lambda: runner.df_root(root), None
    )
    report["top_directories"] = safe_step(
        "top_directories",
        lambda: runner.du_top_directories(root, opts.dir_depth, opts.top_directories),
        [],
    )

    def collect_largest() -> list[dict[str, Any]]:
        files = runner.find_files(root)
        files.sort(key=lambda item: item[0], reverse=True)
        out: list[dict[str, Any]] = []
        for size, mtime, path in files[: opts.largest_files]:
            out.append(
                {
                    "path": path,
                    "size_bytes": size,
                    "mtime_utc": datetime.fromtimestamp(
                        mtime, tz=timezone.utc
                    ).strftime("%Y-%m-%dT%H:%M:%SZ"),
                }
            )
        return out

    report["largest_files"] = safe_step("largest_files", collect_largest, [])

    def collect_stale() -> list[dict[str, Any]]:
        files = runner.find_files(
            root,
            min_bytes=opts.stale_min_bytes,
            min_mtime_days=opts.stale_min_days,
        )
        files.sort(key=lambda item: item[0], reverse=True)
        out: list[dict[str, Any]] = []
        for size, mtime, path in files[: opts.stale_limit]:
            out.append(
                {
                    "path": path,
                    "size_bytes": size,
                    "mtime_utc": datetime.fromtimestamp(
                        mtime, tz=timezone.utc
                    ).strftime("%Y-%m-%dT%H:%M:%SZ"),
                }
            )
        return out

    report["stale_large_files"] = safe_step("stale_large_files", collect_stale, [])
    report["docker"] = safe_step("docker", runner.docker_grouped_usage, {})
    report["timed_out"] = runner.timed_out
    return report


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--scan-root", default=os.environ.get("ROOT_DISK_SCAN_ROOT", "/"))
    p.add_argument("--dir-depth", type=int, default=int(os.environ.get("ROOT_DISK_DIR_DEPTH", "2")))
    p.add_argument(
        "--top-directories",
        type=int,
        default=int(os.environ.get("ROOT_DISK_TOP_DIRS", "20")),
    )
    p.add_argument(
        "--largest-files",
        type=int,
        default=int(os.environ.get("ROOT_DISK_LARGEST_FILES", "30")),
    )
    p.add_argument(
        "--stale-min-bytes",
        type=int,
        default=int(os.environ.get("ROOT_DISK_STALE_MIN_BYTES", str(500 * 1024 * 1024))),
    )
    p.add_argument(
        "--stale-min-days",
        type=int,
        default=int(os.environ.get("ROOT_DISK_STALE_MIN_DAYS", "30")),
    )
    p.add_argument(
        "--stale-limit",
        type=int,
        default=int(os.environ.get("ROOT_DISK_STALE_LIMIT", "50")),
    )
    p.add_argument(
        "--timeout-sec",
        type=int,
        default=int(os.environ.get("ROOT_DISK_TIMEOUT_SEC", "3600")),
    )
    p.add_argument("--host", default=os.environ.get("ROOT_DISK_HOST", ""))
    p.add_argument("--json-out", default="-", help="JSON path or - for stdout")
    p.add_argument("--md-out", default="", help="Markdown path (optional)")
    p.add_argument("--nice-cmd", default=os.environ.get("ROOT_DISK_NICE", "nice -n 19"))
    p.add_argument("--ionice-cmd", default=os.environ.get("ROOT_DISK_IONICE", "ionice -c3"))
    p.add_argument("--du-cmd", default=os.environ.get("ROOT_DISK_DU", "du"))
    p.add_argument("--find-cmd", default=os.environ.get("ROOT_DISK_FIND", "find"))
    p.add_argument("--df-cmd", default=os.environ.get("ROOT_DISK_DF", "df"))
    p.add_argument("--docker-cmd", default=os.environ.get("ROOT_DISK_DOCKER", "docker"))
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    opts = parse_args(argv)
    report = run_report(opts)
    payload = json.dumps(report, indent=2, sort_keys=True)
    payload += "\n"
    md = build_markdown(report)
    if opts.json_out == "-":
        sys.stdout.write(payload)
    else:
        Path(opts.json_out).write_text(payload, encoding="utf-8")
    if opts.md_out:
        Path(opts.md_out).write_text(md, encoding="utf-8")
    elif opts.json_out != "-":
        md_path = re.sub(r"\.json$", ".md", opts.json_out)
        if md_path != opts.json_out:
            Path(md_path).write_text(md, encoding="utf-8")
    return 1 if report.get("timed_out") else 0


if __name__ == "__main__":
    raise SystemExit(main())
