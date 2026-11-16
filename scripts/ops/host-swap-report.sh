#!/usr/bin/env bash
# Read-only swap and swappiness report for the Coolify/Hetzner host.
#
# Prints swap total and used, vm.swappiness, vm.vfs_cache_pressure, swap-in
# and swap-out rates over a sample window, the top processes by VmSwap, and
# per-container swap totals. Container names come from `docker ps`. Process
# swap and the cgroup path that ties a pid to a container come from /proc.
#
#   bash scripts/ops/host-swap-report.sh
#   bash scripts/ops/host-swap-report.sh --json
#   bash scripts/ops/host-swap-report.sh --window 60 --top 10
#   bash scripts/ops/host-swap-report.sh --out-dir /tmp/host-swap
#
# The default window is 60 seconds. --out-dir writes report.md and report.json.
# The script does not write sysctl and does not restart a service or a
# container. The only docker subcommand is `ps --no-trunc` with a fixed format.
#
# Offline tests point HOST_SWAP_PROC at a fake /proc tree and HOST_SWAP_DOCKER
# at a fake docker. HOST_SWAP_SKIP_SLEEP=1 and HOST_SWAP_BEFORE_SECOND_SAMPLE
# are refused when HOST_SWAP_PROC resolves to the live /proc.

set -euo pipefail

HOST_SWAP_PROC="${HOST_SWAP_PROC:-/proc}"
HOST_SWAP_DOCKER="${HOST_SWAP_DOCKER:-docker}"
HOST_SWAP_PAGE_SIZE="${HOST_SWAP_PAGE_SIZE:-}"

PS_FMT='{{.ID}}{{"\t"}}{{.Names}}'

usage() {
  cat <<'EOF'
Usage: host-swap-report.sh [--json] [--window SEC] [--top N] [--out-dir DIR]

Read-only host swap report.
Prints swap total and used, vm.swappiness, vm.vfs_cache_pressure,
swap-in and swap-out rates, top processes by VmSwap, and per-container swap.
Default window is 60 seconds. Default top N is 10.
--json prints one JSON object. --out-dir writes report.md and report.json.
Does not write sysctl and does not restart anything.
EOF
}

JSON=0
WINDOW=""
TOP=""
OUT_DIR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --json) JSON=1; shift ;;
    --window)
      if [[ $# -lt 2 ]]; then
        echo "host-swap-report: --window needs a value" >&2
        exit 2
      fi
      WINDOW="$2"
      shift 2
      ;;
    --top)
      if [[ $# -lt 2 ]]; then
        echo "host-swap-report: --top needs a value" >&2
        exit 2
      fi
      TOP="$2"
      shift 2
      ;;
    --out-dir)
      if [[ $# -lt 2 ]]; then
        echo "host-swap-report: --out-dir needs a value" >&2
        exit 2
      fi
      OUT_DIR="$2"
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "host-swap-report: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

WINDOW="${WINDOW:-${HOST_SWAP_WINDOW_SEC:-60}}"
TOP="${TOP:-${HOST_SWAP_TOP_N:-10}}"

# 10# forces base 10. A leading zero is otherwise octal, so 08 and 09
# error and 010 compares as eight.
decimal_int() {
  local raw="$1"
  local value
  if [[ ! "$raw" =~ ^[0-9]+$ ]]; then
    return 1
  fi
  if ! value="$((10#$raw))" 2>/dev/null; then
    return 1
  fi
  printf '%s\n' "$value"
}

if ! WINDOW="$(decimal_int "$WINDOW")"; then
  echo "host-swap-report: window must be an integer from 0 to 3600" >&2
  exit 2
fi
if [[ "$WINDOW" -gt 3600 ]]; then
  echo "host-swap-report: window must be an integer from 0 to 3600" >&2
  exit 2
fi
if ! TOP="$(decimal_int "$TOP")"; then
  echo "host-swap-report: top N must be an integer from 1 to 1000" >&2
  exit 2
fi
if [[ "$TOP" -lt 1 || "$TOP" -gt 1000 ]]; then
  echo "host-swap-report: top N must be an integer from 1 to 1000" >&2
  exit 2
fi
if [[ -n "$HOST_SWAP_PAGE_SIZE" ]]; then
  if ! HOST_SWAP_PAGE_SIZE="$(decimal_int "$HOST_SWAP_PAGE_SIZE")"; then
    echo "host-swap-report: HOST_SWAP_PAGE_SIZE must be a positive integer" >&2
    exit 2
  fi
  if [[ "$HOST_SWAP_PAGE_SIZE" -lt 1 ]]; then
    echo "host-swap-report: HOST_SWAP_PAGE_SIZE must be a positive integer" >&2
    exit 2
  fi
fi
if [[ -n "$OUT_DIR" && ! -d "$OUT_DIR" ]]; then
  echo "host-swap-report: --out-dir is not a directory" >&2
  exit 2
fi
if [[ ! -d "$HOST_SWAP_PROC" ]]; then
  echo "host-swap-report: proc root is not a directory" >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "host-swap-report: python3 is required" >&2
  exit 1
fi

test_mode="$(python3 - "$HOST_SWAP_PROC" <<'PY'
import os
import sys
proc = os.path.realpath(sys.argv[1])
live = os.path.realpath("/proc")
print("0" if proc == live else "1")
PY
)"

if [[ "${HOST_SWAP_SKIP_SLEEP:-0}" == 1 || -n "${HOST_SWAP_BEFORE_SECOND_SAMPLE:-}" ]]; then
  if [[ "$test_mode" != 1 ]]; then
    echo "host-swap-report: test hooks are refused when HOST_SWAP_PROC is the live /proc" >&2
    exit 2
  fi
fi
if [[ "${HOST_SWAP_SKIP_SLEEP:-0}" == 1 ]]; then
  case "${HOST_SWAP_ELAPSED_SEC:-}" in
    ''|*[!0-9.]*|*.*.*)
      echo "host-swap-report: HOST_SWAP_ELAPSED_SEC must be a positive number when sleep is skipped" >&2
      exit 2
      ;;
  esac
fi

docker_ps() {
  if [[ "${1:-}" != "ps" || "${2:-}" != "--no-trunc" || "${3:-}" != "--format" || "${4:-}" != "$PS_FMT" || -n "${5:-}" ]]; then
    echo "host-swap-report: docker is only invoked as ps --no-trunc" >&2
    return 1
  fi
  "$HOST_SWAP_DOCKER" "$@"
}

docker_file="$(mktemp)"
trap 'rm -f "$docker_file"' EXIT
if ! docker_ps ps --no-trunc --format "$PS_FMT" >"$docker_file"; then
  echo "host-swap-report: docker ps failed; container names are omitted" >&2
  : >"$docker_file"
fi

python3 - \
  "$HOST_SWAP_PROC" \
  "$docker_file" \
  "$JSON" \
  "$WINDOW" \
  "$TOP" \
  "$HOST_SWAP_PAGE_SIZE" \
  "${HOST_SWAP_SKIP_SLEEP:-0}" \
  "${HOST_SWAP_ELAPSED_SEC:-}" \
  "${HOST_SWAP_BEFORE_SECOND_SAMPLE:-}" \
  "$OUT_DIR" <<'PY'
import json
import os
import re
import subprocess
import sys
import time

(
    proc_root,
    docker_path,
    json_flag,
    window_s,
    top_s,
    page_raw,
    skip_flag,
    elapsed_raw,
    hook,
    out_dir,
) = sys.argv[1:11]

window = int(window_s)
top_n = int(top_s)
skip = skip_flag == "1"
GAP = "\u00a0 "
DOCKER_ID = re.compile(r"docker[-/]([0-9a-fA-F]{12,64})(?:\.scope\b)?")
HEX_ID = re.compile(r"^[0-9a-fA-F]{12,64}$")
PID_CAP = 100


def die(message, code):
    sys.stderr.write("host-swap-report: %s\n" % message)
    raise SystemExit(code)


def page_size(raw):
    if raw:
        if not raw.isdigit() or int(raw) < 1:
            die("HOST_SWAP_PAGE_SIZE must be a positive integer", 2)
        return int(raw)
    try:
        value = os.sysconf("SC_PAGE_SIZE")
    except (OSError, ValueError, AttributeError):
        return 4096
    if not isinstance(value, int) or value < 1:
        return 4096
    return value


def root_real(path):
    if not os.path.isdir(path):
        return None
    return os.path.realpath(path)


def confined(root, rel_parts):
    if root is None:
        return None
    path = root
    for part in rel_parts:
        if part in ("", ".", "..") or "/" in part or "\x00" in part:
            return None
        path = os.path.join(path, part)
    real = os.path.realpath(path)
    if real != root and not real.startswith(root + os.sep):
        return None
    if not os.path.isfile(real):
        return None
    return real


def read_text(root, rel_parts, limit=65536):
    real = confined(root, rel_parts)
    if real is None:
        return None
    try:
        with open(real, encoding="utf-8", errors="replace") as handle:
            return handle.read(limit)
    except OSError:
        return None


def parse_kb_field(text, key):
    prefix = key + ":"
    for line in text.splitlines():
        if not line.startswith(prefix):
            continue
        parts = line.split()
        if len(parts) >= 2 and parts[1].isdigit():
            return int(parts[1])
    return None


def kb_to_bytes(value):
    if value is None:
        return None
    return value * 1024


def read_int_file(root, rel_parts):
    text = read_text(root, rel_parts)
    if text is None:
        return None
    token = text.strip().split()
    if not token or not token[0].isdigit():
        return None
    return int(token[0])


def read_vmstat(root):
    text = read_text(root, ["vmstat"])
    if text is None:
        return None
    values = {}
    for line in text.splitlines():
        parts = line.split()
        if len(parts) != 2 or not parts[1].isdigit():
            continue
        values[parts[0]] = int(parts[1])
    if "pswpin" not in values or "pswpout" not in values:
        return None
    return {"pswpin": values["pswpin"], "pswpout": values["pswpout"]}


def read_swaps(root):
    text = read_text(root, ["swaps"])
    if text is None:
        return None
    devices = []
    for line in text.splitlines()[1:]:
        parts = line.split()
        if len(parts) < 5:
            continue
        filename, kind, size, used, priority = parts[0], parts[1], parts[2], parts[3], parts[4]
        if not size.isdigit() or not used.isdigit():
            continue
        if priority[0] == "-" and priority[1:].isdigit():
            priority_n = -int(priority[1:])
        elif priority.isdigit():
            priority_n = int(priority)
        else:
            continue
        devices.append({
            "filename": filename,
            "type": kind,
            "size_bytes": int(size) * 1024,
            "used_bytes": int(used) * 1024,
            "priority": priority_n,
        })
    return devices


def parse_status(text):
    name = None
    swap_kb = None
    saw_swap = False
    for line in text.splitlines():
        if line.startswith("Name:"):
            name = line.split(":", 1)[1].strip().replace("\n", "").replace("\r", "")
        elif line.startswith("VmSwap:"):
            saw_swap = True
            parts = line.split()
            if len(parts) >= 2 and parts[1].isdigit():
                unit = parts[2] if len(parts) >= 3 else "kB"
                if unit == "kB":
                    swap_kb = int(parts[1])
    if not name:
        return None
    if not saw_swap:
        return {"comm": name, "swap_kb": None}
    return {"comm": name, "swap_kb": swap_kb}


def container_id_from_cgroup(text):
    if not text:
        return None
    ordered = []
    rest = []
    for line in text.splitlines():
        if line.startswith("0::"):
            ordered.append(line[3:])
        else:
            rest.append(line)
    ordered.extend(rest)
    for line in ordered:
        matches = list(DOCKER_ID.finditer(line))
        if matches:
            return matches[-1].group(1).lower()
    return None


def list_pids(root):
    pids = []
    try:
        names = os.listdir(root)
    except OSError:
        return pids
    for name in names:
        if not name.isdigit():
            continue
        joined = os.path.join(root, name)
        real = os.path.realpath(joined)
        if real != root and not real.startswith(root + os.sep):
            continue
        if not os.path.isdir(real):
            continue
        pids.append(int(name))
    pids.sort()
    return pids


def load_processes(root):
    rows = []
    for pid in list_pids(root):
        status = read_text(root, [str(pid), "status"])
        if status is None:
            continue
        parsed = parse_status(status)
        if parsed is None:
            continue
        cgroup = read_text(root, [str(pid), "cgroup"])
        rows.append({
            "pid": pid,
            "comm": parsed["comm"],
            "swap_kb": parsed["swap_kb"],
            "container_id": container_id_from_cgroup(cgroup) if cgroup else None,
        })
    return rows


def load_docker(path):
    try:
        text = open(path, encoding="utf-8", errors="replace").read()
    except OSError:
        return []
    rows = []
    seen = set()
    for line in text.splitlines():
        if "\t" not in line:
            continue
        cid, name = line.split("\t", 1)
        cid = cid.strip().lower()
        name = name.strip()
        if name.startswith("/"):
            name = name[1:]
        name = name.replace("\n", " ").replace("\r", " ").strip()
        if not HEX_ID.fullmatch(cid) or not name:
            continue
        if cid in seen:
            continue
        seen.add(cid)
        rows.append({"id": cid, "name": name})
    return rows


def match_container(short_id, containers):
    if not short_id:
        return None
    short_id = short_id.lower()
    for row in containers:
        full = row["id"]
        if full == short_id or full.startswith(short_id) or short_id.startswith(full):
            if min(len(full), len(short_id)) >= 12:
                return row
    return None


def fmt_bytes(value):
    if value is None:
        return "n/a"
    number = int(value)
    if number == 0:
        return "0 B"
    units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"]
    amount = float(abs(number))
    index = 0
    while amount >= 1024 and index < len(units) - 1:
        amount /= 1024.0
        index += 1
    if index == 0:
        rendered = "%d B" % int(amount)
    else:
        rendered = "%.2f %s" % (amount, units[index])
    if number < 0:
        return "-" + rendered
    return rendered


def cell(value):
    text = "" if value is None else str(value)
    cleaned = []
    for ch in text:
        if ch == "|" or ch == "`" or not ch.isprintable():
            cleaned.append(" ")
        else:
            cleaned.append(ch)
    rendered = "".join(cleaned).strip()
    return rendered or "?"


def rate_pair(delta, elapsed, page):
    if delta is None or delta < 0 or elapsed <= 0:
        return None, None
    pages = delta / float(elapsed)
    kib = pages * page / 1024.0
    return round(pages, 6), round(kib, 6)


def fmt_rate(pages, kib):
    if pages is None or kib is None:
        return "n/a"
    return "%.2f pages/s (%.2f KiB/s)" % (pages, kib)


def run_hook(command):
    if not command:
        return
    completed = subprocess.run(["bash", "-c", command], check=False)
    if completed.returncode != 0:
        die("sample hook failed", 1)


def second_sample(root, test_mode):
    if window == 0:
        return None, 0.0
    if skip:
        if not test_mode:
            die("test hooks are refused when HOST_SWAP_PROC is the live /proc", 2)
        try:
            elapsed = float(elapsed_raw)
        except ValueError:
            die("HOST_SWAP_ELAPSED_SEC must be a positive number when sleep is skipped", 2)
        if elapsed <= 0:
            die("HOST_SWAP_ELAPSED_SEC must be a positive number when sleep is skipped", 2)
        if hook:
            if not test_mode:
                die("test hooks are refused when HOST_SWAP_PROC is the live /proc", 2)
            run_hook(hook)
        return read_vmstat(root), elapsed
    started = time.perf_counter()
    if hook:
        if not test_mode:
            die("test hooks are refused when HOST_SWAP_PROC is the live /proc", 2)
        run_hook(hook)
    time.sleep(window)
    return read_vmstat(root), time.perf_counter() - started


proc = root_real(proc_root)
if proc is None:
    die("proc root is not a directory", 1)
live = os.path.realpath("/proc")
test_mode = proc != live

meminfo = read_text(proc, ["meminfo"])
if meminfo is None:
    die("could not read meminfo", 1)
swap_total_kb = parse_kb_field(meminfo, "SwapTotal")
swap_free_kb = parse_kb_field(meminfo, "SwapFree")
if swap_total_kb is None:
    die("meminfo has no SwapTotal", 1)
swap_used_kb = None
if swap_free_kb is not None and swap_free_kb <= swap_total_kb:
    swap_used_kb = swap_total_kb - swap_free_kb

first = read_vmstat(proc)
second, elapsed = second_sample(proc, test_mode)

def counter_view(key):
    start = None if first is None else first.get(key)
    end = None if second is None else second.get(key)
    if start is None or end is None:
        return start, end, None, False
    delta = end - start
    return start, end, delta, delta < 0


pin_start, pin_end, pin_delta, pin_reset = counter_view("pswpin")
pout_start, pout_end, pout_delta, pout_reset = counter_view("pswpout")
page = page_size(page_raw)
in_pages, in_kib = rate_pair(None if pin_reset else pin_delta, elapsed, page)
out_pages, out_kib = rate_pair(None if pout_reset else pout_delta, elapsed, page)

processes = load_processes(proc)
docker_rows = load_docker(docker_path)

swapped = []
for row in processes:
    if row["swap_kb"] is None or row["swap_kb"] <= 0:
        continue
    swapped.append({
        "pid": row["pid"],
        "comm": row["comm"],
        "vmswap_bytes": row["swap_kb"] * 1024,
        "container_id": row["container_id"],
    })
swapped.sort(key=lambda row: (-row["vmswap_bytes"], row["pid"]))
top_rows = []
for row in swapped[:top_n]:
    matched = match_container(row["container_id"], docker_rows)
    top_rows.append({
        "pid": row["pid"],
        "comm": row["comm"],
        "vmswap_bytes": row["vmswap_bytes"],
        "container": None if matched is None else matched["name"],
    })

by_container = {row["id"]: {"id": row["id"], "name": row["name"], "swap_bytes": 0, "pids": []} for row in docker_rows}
unattributed = 0
for row in swapped:
    matched = match_container(row["container_id"], docker_rows)
    if matched is None:
        unattributed += row["vmswap_bytes"]
        continue
    bucket = by_container[matched["id"]]
    bucket["swap_bytes"] += row["vmswap_bytes"]
    bucket["pids"].append(row["pid"])

containers = []
for bucket in by_container.values():
    pids = sorted(bucket["pids"])
    containers.append({
        "id": bucket["id"],
        "name": bucket["name"],
        "swap_bytes": bucket["swap_bytes"],
        "pid_count": len(pids),
        "pids": pids[:PID_CAP],
        "pids_truncated": len(pids) > PID_CAP,
    })
containers.sort(key=lambda row: (-row["swap_bytes"], row["name"], row["id"]))

devices = read_swaps(proc)
report = {
    "read_only": True,
    "schema_version": 1,
    "memory": {
        "total_bytes": kb_to_bytes(parse_kb_field(meminfo, "MemTotal")),
        "available_bytes": kb_to_bytes(parse_kb_field(meminfo, "MemAvailable")),
    },
    "swap": {
        "total_bytes": kb_to_bytes(swap_total_kb),
        "free_bytes": kb_to_bytes(swap_free_kb),
        "used_bytes": kb_to_bytes(swap_used_kb),
    },
    "vm": {
        "swappiness": read_int_file(proc, ["sys", "vm", "swappiness"]),
        "vfs_cache_pressure": read_int_file(proc, ["sys", "vm", "vfs_cache_pressure"]),
    },
    "swap_devices": devices,
    "sample": {
        "window_seconds": window,
        "elapsed_seconds": round(elapsed, 6),
        "page_size_bytes": page,
        "pswpin": {"start": pin_start, "end": pin_end, "delta": pin_delta},
        "pswpout": {"start": pout_start, "end": pout_end, "delta": pout_delta},
        "swap_in_pages_per_sec": in_pages,
        "swap_out_pages_per_sec": out_pages,
        "swap_in_kib_per_sec": in_kib,
        "swap_out_kib_per_sec": out_kib,
        "counter_reset": bool(pin_reset or pout_reset),
    },
    "top_processes": top_rows,
    "containers": containers,
    "unattributed_swap_bytes": unattributed,
}


def scalar(label, value):
    return "- %s: %s" % (label, value)


def table(headers, rows):
    lines = ["| " + " | ".join(headers) + " |", "| " + " | ".join("---" for _ in headers) + " |"]
    for row in rows:
        lines.append("| " + " | ".join(cell(item) for item in row) + " |")
    return lines


lines = [
    "# Host Swap Report",
    "",
    "Read-only." + GAP + "No sysctl writes and no restarts.",
    "",
    scalar("Swap used", fmt_bytes(report["swap"]["used_bytes"])),
    scalar("Swap total", fmt_bytes(report["swap"]["total_bytes"])),
    scalar("vm.swappiness", "n/a" if report["vm"]["swappiness"] is None else str(report["vm"]["swappiness"])),
    scalar("vm.vfs_cache_pressure", "n/a" if report["vm"]["vfs_cache_pressure"] is None else str(report["vm"]["vfs_cache_pressure"])),
    scalar("Window", "%ss" % report["sample"]["window_seconds"]),
    scalar("Swap in", fmt_rate(in_pages, in_kib)),
    scalar("Swap out", fmt_rate(out_pages, out_kib)),
]
if report["sample"]["counter_reset"]:
    lines.append("")
    lines.append("A counter went backwards." + GAP + "That rate is omitted.")
lines.append("")
lines.append("## Top Processes By VmSwap")
lines.append("")
if not top_rows:
    lines.append("No process is using swap.")
else:
    lines.extend(table(
        ["PID", "Comm", "VmSwap", "Container"],
        [[row["pid"], row["comm"], fmt_bytes(row["vmswap_bytes"]), row["container"] or "-"] for row in top_rows],
    ))
lines.append("")
lines.append("## Containers By Swap")
lines.append("")
if not containers:
    lines.append("No running container was listed.")
else:
    lines.extend(table(
        ["Container", "Swap", "PIDs"],
        [[row["name"], fmt_bytes(row["swap_bytes"]), row["pid_count"]] for row in containers],
    ))
lines.append("")
if devices is None:
    lines.append("Swap devices: n/a")
else:
    lines.append("## Swap Devices")
    lines.append("")
    if not devices:
        lines.append("No swap device is configured.")
    else:
        lines.extend(table(
            ["Device", "Type", "Used", "Size", "Priority"],
            [[row["filename"], row["type"], fmt_bytes(row["used_bytes"]), fmt_bytes(row["size_bytes"]), row["priority"]] for row in devices],
        ))
    lines.append("")
lines.append("Unattributed swap: %s" % fmt_bytes(unattributed))
lines.append("")
markdown = "\n".join(lines)
payload = json.dumps(report, indent=2, sort_keys=True) + "\n"

if out_dir:
    md_path = os.path.join(out_dir, "report.md")
    json_path = os.path.join(out_dir, "report.json")
    with open(md_path, "w", encoding="utf-8") as handle:
        handle.write(markdown)
    with open(json_path, "w", encoding="utf-8") as handle:
        handle.write(payload)

if json_flag == "1":
    sys.stdout.write(payload)
else:
    sys.stdout.write(markdown)
PY
