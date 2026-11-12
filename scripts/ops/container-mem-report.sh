#!/usr/bin/env bash
# Read-only per-container RAM and swap report.
#
# For each running container: name, image, docker stats memory usage, memory
# limit (or none), cgroup memory.low reservation, swap usage and swap max,
# memory.events oom and oom_kill, restart count, and the top processes by RSS
# is cheap. Sorted by usage. Totals at the end. --json prints one object.
#
# Reads `docker stats --no-stream` and `docker inspect` (a fixed format that
# does not include environment) plus /sys/fs/cgroup and /proc. Never starts,
# stops, updates, execs into, or limits a container.
#
#   bash scripts/ops/container-mem-report.sh
#   bash scripts/ops/container-mem-report.sh --json
#
# Offline tests point CONTAINER_MEM_DOCKER at a fake docker and
# CONTAINER_MEM_CGROUP / CONTAINER_MEM_PROC at a fake tree.
# CONTAINER_MEM_TOP_RSS (default 5) and CONTAINER_MEM_TOP_RSS_MAX_PROCS
# (default 250) bound the RSS scan. Above the proc cap, top RSS is skipped.
# Top RSS comes from cgroup.procs plus VmRSS in /proc/<pid>/status.
# smem is not run. It is optional, and spawning it is outside this
# read-only cgroup scan. The /proc read is the cheap path and is what
# the offline tests fake.
set -euo pipefail

CONTAINER_MEM_DOCKER="${CONTAINER_MEM_DOCKER:-docker}"
CONTAINER_MEM_CGROUP="${CONTAINER_MEM_CGROUP:-/sys/fs/cgroup}"
CONTAINER_MEM_PROC="${CONTAINER_MEM_PROC:-/proc}"
CONTAINER_MEM_TOP_RSS="${CONTAINER_MEM_TOP_RSS:-5}"
CONTAINER_MEM_TOP_RSS_MAX_PROCS="${CONTAINER_MEM_TOP_RSS_MAX_PROCS:-250}"

# Fixed inspect format. Do not widen this: a full inspect object includes
# Config.Env and would print secrets.
INSPECT_FMT='{{.Id}}{{"\t"}}{{.Name}}{{"\t"}}{{.Config.Image}}{{"\t"}}{{.HostConfig.Memory}}{{"\t"}}{{.HostConfig.MemoryReservation}}{{"\t"}}{{.HostConfig.MemorySwap}}{{"\t"}}{{.RestartCount}}{{"\t"}}{{.State.Pid}}{{"\t"}}{{.State.Status}}'

usage() {
  cat <<'EOF'
Usage: container-mem-report.sh [--json]

Read-only report of running containers, sorted by memory usage.
Prints name, image, docker stats memory, cgroup memory.current, limit
(or none), reservation, swap usage and swap limit, oom, oom_kill, restarts, and top RSS.
Does not start, stop, update, or limit anything.

  --json    print one JSON object instead of the text table
EOF
}

JSON=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --json) JSON=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "container-mem-report: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "$CONTAINER_MEM_TOP_RSS" in
  ''|*[!0-9]*) echo "container-mem-report: CONTAINER_MEM_TOP_RSS must be a positive integer" >&2; exit 2 ;;
esac
case "$CONTAINER_MEM_TOP_RSS_MAX_PROCS" in
  ''|*[!0-9]*) echo "container-mem-report: CONTAINER_MEM_TOP_RSS_MAX_PROCS must be a non-negative integer" >&2; exit 2 ;;
esac
if [[ "$CONTAINER_MEM_TOP_RSS" -lt 1 ]]; then
  echo "container-mem-report: CONTAINER_MEM_TOP_RSS must be a positive integer" >&2
  exit 2
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "container-mem-report: python3 is required" >&2
  exit 1
fi

docker_ro() {
  local sub="$1"
  shift
  case "$sub" in
    stats)
      if [[ "${1:-}" != "--no-stream" || "${2:-}" != "--format" || "${3:-}" != '{{json .}}' || -n "${4:-}" ]]; then
        echo "container-mem-report: docker stats is only invoked as --no-stream" >&2
        return 1
      fi
      ;;
    inspect)
      if [[ "${1:-}" != "--format" || "${2:-}" != "$INSPECT_FMT" ]]; then
        echo "container-mem-report: docker inspect format is fixed and cannot include the environment" >&2
        return 1
      fi
      local id
      for id in "${@:3}"; do
        if [[ ! "$id" =~ ^[0-9a-fA-F]{12,64}$ ]]; then
          echo "container-mem-report: refusing an inspect id that is not a container id" >&2
          return 1
        fi
      done
      ;;
    *)
      echo "container-mem-report: refusing docker ${sub}" >&2
      return 1
      ;;
  esac
  "$CONTAINER_MEM_DOCKER" "$sub" "$@"
}

stats_file="$(mktemp)"
inspect_file="$(mktemp)"
one_inspect="$(mktemp)"
trap 'rm -f "$stats_file" "$inspect_file" "$one_inspect"' EXIT

if ! docker_ro stats --no-stream --format '{{json .}}' >"$stats_file"; then
  echo "container-mem-report: docker stats --no-stream failed" >&2
  exit 1
fi

ids_text="$(python3 - "$stats_file" <<'PY'
import json, re, sys
path = sys.argv[1]
text = open(path, encoding="utf-8").read().strip()
if not text:
    sys.exit(0)
try:
    if text.startswith("["):
        rows = json.loads(text)
        if not isinstance(rows, list):
            raise ValueError("stats JSON was not a list")
    else:
        rows = []
        for line in text.splitlines():
            line = line.strip()
            if line:
                rows.append(json.loads(line))
except (json.JSONDecodeError, ValueError):
    sys.stderr.write("container-mem-report: docker stats output was not JSON\n")
    sys.exit(1)

hex_id = re.compile(r"^[0-9a-fA-F]{12,64}$")
seen = []
for obj in rows:
    if not isinstance(obj, dict):
        continue
    sid = ""
    for key in ("ID", "Id", "Container"):
        value = obj.get(key)
        if isinstance(value, str) and hex_id.fullmatch(value):
            sid = value
            break
    if sid and sid not in seen:
        seen.append(sid)
        print(sid)
PY
)" || {
  echo "container-mem-report: could not read container ids from docker stats" >&2
  exit 1
}

ids=()
if [[ -n "$ids_text" ]]; then
  mapfile -t ids <<< "$ids_text"
fi

# One inspect per id. A container that exits between stats and inspect must
# not throw away the rest of the report. Its stats row stays, without inspect
# fields. A failed inspect can still write a partial line, so keep that line
# only when the command succeeds.
: >"$inspect_file"
for id in "${ids[@]}"; do
  if docker_ro inspect --format "$INSPECT_FMT" "$id" >"$one_inspect"; then
    cat "$one_inspect" >>"$inspect_file"
  else
    echo "container-mem-report: docker inspect failed for ${id}; continuing without its inspect fields" >&2
  fi
done

python3 - "$stats_file" "$inspect_file" "$CONTAINER_MEM_CGROUP" "$CONTAINER_MEM_PROC" "$JSON" "$CONTAINER_MEM_TOP_RSS" "$CONTAINER_MEM_TOP_RSS_MAX_PROCS" <<'PY'
import json
import os
import re
import sys

stats_path, inspect_path, cgroup_root, proc_root, json_flag, top_n_s, max_procs_s = sys.argv[1:8]
top_n = int(top_n_s)
max_procs = int(max_procs_s)

UNITS = {
    "b": 1,
    "kb": 1000,
    "kib": 1024,
    "mb": 1000 ** 2,
    "mib": 1024 ** 2,
    "gb": 1000 ** 3,
    "gib": 1024 ** 3,
    "tb": 1000 ** 4,
    "tib": 1024 ** 4,
    "pb": 1000 ** 5,
    "pib": 1024 ** 5,
}
HEX_ID = re.compile(r"^[0-9a-fA-F]{12,64}$")
HUMAN_RE = re.compile(r"^([0-9]+(?:\.[0-9]+)?)([A-Za-z]+)$")


def load_stats(text):
    text = text.strip()
    if not text:
        return []
    if text.startswith("["):
        rows = json.loads(text)
        if not isinstance(rows, list):
            raise ValueError("stats JSON was not a list")
        return rows
    rows = []
    for line in text.splitlines():
        line = line.strip()
        if line:
            rows.append(json.loads(line))
    return rows


def parse_human(raw):
    if raw is None:
        return None
    text = str(raw).strip().replace(" ", "")
    if not text:
        return None
    if re.fullmatch(r"[0-9]+", text):
        return int(text)
    match = HUMAN_RE.fullmatch(text)
    if not match:
        return None
    unit = match.group(2).lower()
    if unit not in UNITS:
        return None
    return int(round(float(match.group(1)) * UNITS[unit]))


def parse_mem_usage(raw):
    if raw is None:
        return None
    left = str(raw).split("/", 1)[0]
    return parse_human(left)


def to_int(value):
    if value is None:
        return None
    text = str(value).strip()
    if text == "":
        return None
    if text.startswith("-"):
        rest = text[1:]
        if rest.isdigit():
            return -int(rest)
        return None
    if text.isdigit():
        return int(text)
    return None


def load_inspect(text):
    rows = []
    for line in text.splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        if len(parts) != 9:
            sys.stderr.write("container-mem-report: skipping an inspect row with an unexpected shape\n")
            continue
        cid, name, image, memory, reservation, memory_swap, restarts, pid, status = parts
        if name.startswith("/"):
            name = name[1:]
        rows.append({
            "id": cid.strip(),
            "name": name.strip(),
            "image": image.strip(),
            "memory": to_int(memory),
            "memory_reservation": to_int(reservation),
            "memory_swap": to_int(memory_swap),
            "restarts": to_int(restarts),
            "pid": to_int(pid),
            "status": status.strip(),
        })
    return rows


def find_inspect(rows, short_id):
    for row in rows:
        full = row["id"]
        if not full or not short_id:
            continue
        if full == short_id or full.startswith(short_id) or short_id.startswith(full):
            if min(len(full), len(short_id)) >= 12:
                return row
    return None


def inside(root_real, path):
    real = os.path.realpath(path)
    if real != root_real and not real.startswith(root_real + os.sep):
        return None
    if not os.path.isfile(real):
        return None
    return real


def read_text(root_real, path):
    real = inside(root_real, path)
    if real is None:
        return None
    try:
        with open(real, encoding="utf-8", errors="replace") as handle:
            return handle.read()
    except OSError:
        return None


def cgroup_rel(text):
    fallback = None
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("0::"):
            return line[3:]
        parts = line.split(":", 2)
        if len(parts) == 3 and parts[2].startswith("/"):
            fallback = parts[2]
    return fallback


def safe_cgroup_dir(root_real, rel):
    if not rel:
        return None
    rel_clean = rel.lstrip("/")
    if not rel_clean or "\x00" in rel or rel_clean.startswith("/"):
        return None
    candidate = os.path.normpath(os.path.join(root_real, rel_clean))
    if candidate != root_real and not candidate.startswith(root_real + os.sep):
        return None
    real = os.path.realpath(candidate)
    if real != root_real and not real.startswith(root_real + os.sep):
        return None
    if not os.path.isdir(real):
        return None
    return real


def parse_events(text):
    if text is None:
        return None, None
    oom = 0
    oom_kill = 0
    for line in text.splitlines():
        parts = line.split()
        if len(parts) < 2 or not parts[1].isdigit():
            continue
        if parts[0] == "oom":
            oom = int(parts[1])
        elif parts[0] == "oom_kill":
            oom_kill = int(parts[1])
    return oom, oom_kill


def read_top_rss(proc_real, cg_dir, cg_root_real):
    procs_text = read_text(cg_root_real, os.path.join(cg_dir, "cgroup.procs"))
    if procs_text is None:
        return {"status": "unavailable", "proc_count": None, "procs": []}
    pids = []
    for line in procs_text.splitlines():
        line = line.strip()
        if line.isdigit():
            pids.append(int(line))
    if len(pids) > max_procs:
        return {"status": "skipped", "proc_count": len(pids), "procs": []}
    rows = []
    for pid in pids:
        status = read_text(proc_real, os.path.join(proc_real, str(pid), "status"))
        if status is None:
            continue
        name = None
        rss_kb = None
        for line in status.splitlines():
            if line.startswith("Name:"):
                name = line.split(":", 1)[1].strip().replace("\n", "")
            elif line.startswith("VmRSS:"):
                parts = line.split()
                if len(parts) >= 2 and parts[1].isdigit():
                    rss_kb = int(parts[1])
        if name and rss_kb and rss_kb > 0:
            rows.append({"pid": pid, "comm": name, "rss_bytes": rss_kb * 1024})
    rows.sort(key=lambda row: (-row["rss_bytes"], row["pid"]))
    return {"status": "ok", "proc_count": len(pids), "procs": rows[:top_n]}


def fmt_bytes(value):
    if value is None:
        return "n/a"
    number = int(value)
    if number == 0:
        return "0 B"
    units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"]
    amount = float(number)
    index = 0
    while amount >= 1024 and index < len(units) - 1:
        amount /= 1024.0
        index += 1
    if index == 0:
        return "%d B" % int(amount)
    return "%.2f %s" % (amount, units[index])


def fmt_top(row):
    status = row.get("top_rss_status")
    if status == "skipped":
        return "skipped (%s procs)" % row.get("top_rss_proc_count")
    if status != "ok":
        return "n/a"
    procs = row.get("top_rss") or []
    if not procs:
        return "-"
    return ", ".join("%s %s" % (item["comm"], fmt_bytes(item["rss_bytes"])) for item in procs)


def limit_label(source, limit_bytes):
    if source == "unknown":
        return "n/a"
    if limit_bytes is None:
        return "none"
    return fmt_bytes(limit_bytes)


def cell(value):
    if value is None:
        return "n/a"
    return str(value)


try:
    stats_rows = load_stats(open(stats_path, encoding="utf-8").read())
except (OSError, json.JSONDecodeError, ValueError):
    sys.stderr.write("container-mem-report: docker stats output was not JSON\n")
    sys.exit(1)

try:
    inspect_rows = load_inspect(open(inspect_path, encoding="utf-8").read())
except OSError:
    sys.stderr.write("container-mem-report: could not read docker inspect output\n")
    sys.exit(1)

cgroup_real = os.path.realpath(cgroup_root) if os.path.isdir(cgroup_root) else None
proc_real = os.path.realpath(proc_root) if os.path.isdir(proc_root) else None

containers = []
for obj in stats_rows:
    if not isinstance(obj, dict):
        continue
    sid = ""
    for key in ("ID", "Id", "Container"):
        value = obj.get(key)
        if isinstance(value, str) and HEX_ID.fullmatch(value):
            sid = value
            break
    info = find_inspect(inspect_rows, sid) if sid else None
    name = ""
    raw_name = obj.get("Name")
    if isinstance(raw_name, str) and raw_name.strip():
        name = raw_name.strip()
        if name.startswith("/"):
            name = name[1:]
    if not name and info:
        name = info["name"]
    if not name:
        name = sid or "?"
    name = name.replace("\n", " ").replace("\r", " ")

    image = info["image"] if info and info["image"] else None
    raw_usage = obj.get("MemUsage")
    if not isinstance(raw_usage, str):
        raw_usage = None
    usage = parse_mem_usage(raw_usage)
    usage_source = "docker_stats" if usage is not None else None

    memory_current = None
    swap_bytes = None
    swap_limit_bytes = None
    swap_limit_source = "unknown"
    reservation_bytes = None
    reservation_source = "unknown"
    oom = None
    oom_kill = None
    limit_bytes = None
    limit_source = "unknown"
    rss = {"status": "unavailable", "proc_count": None, "procs": []}
    restarts = info["restarts"] if info else None
    if restarts is not None and restarts < 0:
        restarts = None

    cg_dir = None
    pid = info["pid"] if info else None
    if pid is not None and pid > 0 and proc_real and cgroup_real:
        cg_text = read_text(proc_real, os.path.join(proc_real, str(pid), "cgroup"))
        if cg_text:
            rel = cgroup_rel(cg_text)
            cg_dir = safe_cgroup_dir(cgroup_real, rel) if rel else None

    if cg_dir and cgroup_real:
        current_text = read_text(cgroup_real, os.path.join(cg_dir, "memory.current"))
        if current_text is not None:
            memory_current = to_int(current_text.strip())
        swap_text = read_text(cgroup_real, os.path.join(cg_dir, "memory.swap.current"))
        if swap_text is not None:
            swap_bytes = to_int(swap_text.strip())
            if swap_bytes is not None and swap_bytes < 0:
                swap_bytes = None
        swap_max_text = read_text(cgroup_real, os.path.join(cg_dir, "memory.swap.max"))
        if swap_max_text is not None:
            swap_token = swap_max_text.strip()
            if swap_token == "max":
                swap_limit_bytes = None
                swap_limit_source = "none"
            else:
                parsed_swap_max = to_int(swap_token)
                if parsed_swap_max is not None and parsed_swap_max >= 0:
                    swap_limit_bytes = parsed_swap_max
                    swap_limit_source = "cgroup_swap_max"
        low_text = read_text(cgroup_real, os.path.join(cg_dir, "memory.low"))
        if low_text is not None:
            parsed_low = to_int(low_text.strip())
            if parsed_low is not None and parsed_low > 0:
                reservation_bytes = parsed_low
                reservation_source = "cgroup_low"
            elif parsed_low is not None and parsed_low == 0:
                reservation_source = "none"
        oom, oom_kill = parse_events(read_text(cgroup_real, os.path.join(cg_dir, "memory.events")))
        max_text = read_text(cgroup_real, os.path.join(cg_dir, "memory.max"))
        if max_text is not None:
            token = max_text.strip()
            if token == "max":
                inspected_cap = info["memory"] if info is not None else None
                if inspected_cap is not None and inspected_cap > 0:
                    limit_bytes = inspected_cap
                    limit_source = "inspect"
                else:
                    limit_bytes = None
                    limit_source = "none"
            else:
                parsed_max = to_int(token)
                if parsed_max is not None and parsed_max > 0:
                    limit_bytes = parsed_max
                    limit_source = "cgroup_max"
        if proc_real:
            rss = read_top_rss(proc_real, cg_dir, cgroup_real)

    if limit_source == "unknown" and info is not None:
        inspected = info["memory"]
        if inspected is not None and inspected > 0:
            limit_bytes = inspected
            limit_source = "inspect"
        elif inspected is not None and inspected <= 0:
            limit_bytes = None
            limit_source = "none"

    if reservation_source == "unknown" and info is not None:
        inspected_res = info["memory_reservation"]
        if inspected_res is not None and inspected_res > 0:
            reservation_bytes = inspected_res
            reservation_source = "inspect"
        elif inspected_res is not None and inspected_res <= 0:
            reservation_source = "none"

    if swap_limit_source == "unknown" and info is not None:
        inspected_swap = info["memory_swap"]
        if inspected_swap is not None and inspected_swap > 0:
            swap_limit_bytes = inspected_swap
            swap_limit_source = "inspect"
        elif inspected_swap is not None and inspected_swap < 0:
            swap_limit_bytes = None
            swap_limit_source = "none"

    if usage is None and memory_current is not None and memory_current >= 0:
        usage = memory_current
        usage_source = "cgroup_current"

    containers.append({
        "name": name,
        "id": sid or (info["id"] if info else None),
        "image": image,
        "memory_usage_bytes": usage,
        "memory_usage_raw": raw_usage,
        "memory_usage_source": usage_source,
        "memory_current_bytes": memory_current,
        "memory_limit_bytes": limit_bytes,
        "memory_limit_source": limit_source,
        "memory_reservation_bytes": reservation_bytes,
        "memory_reservation_source": reservation_source,
        "swap_bytes": swap_bytes,
        "swap_limit_bytes": swap_limit_bytes,
        "swap_limit_source": swap_limit_source,
        "oom": oom,
        "oom_kill": oom_kill,
        "restart_count": restarts,
        "top_rss_status": rss["status"],
        "top_rss_proc_count": rss["proc_count"],
        "top_rss": rss["procs"],
    })

containers.sort(key=lambda row: (
    -(row["memory_usage_bytes"] if row["memory_usage_bytes"] is not None else -1),
    row["name"],
    row["id"] or "",
))


def add_known(total, unknown, value):
    if value is None:
        return total, unknown + 1
    return total + int(value), unknown


mem_total, mem_unknown = 0, 0
swap_total, swap_unknown = 0, 0
oom_total, oom_unknown = 0, 0
kill_total, kill_unknown = 0, 0
restart_total, restart_unknown = 0, 0
unlimited = 0
for row in containers:
    mem_total, mem_unknown = add_known(mem_total, mem_unknown, row["memory_usage_bytes"])
    swap_total, swap_unknown = add_known(swap_total, swap_unknown, row["swap_bytes"])
    oom_total, oom_unknown = add_known(oom_total, oom_unknown, row["oom"])
    kill_total, kill_unknown = add_known(kill_total, kill_unknown, row["oom_kill"])
    restart_total, restart_unknown = add_known(restart_total, restart_unknown, row["restart_count"])
    if row["memory_limit_source"] == "none":
        unlimited += 1

totals = {
    "containers": len(containers),
    "memory_usage_bytes": mem_total,
    "memory_usage_unknown": mem_unknown,
    "swap_bytes": swap_total,
    "swap_unknown": swap_unknown,
    "unlimited": unlimited,
    "oom": oom_total,
    "oom_unknown": oom_unknown,
    "oom_kill": kill_total,
    "oom_kill_unknown": kill_unknown,
    "restart_count": restart_total,
    "restart_unknown": restart_unknown,
}

report = {"read_only": True, "containers": containers, "totals": totals}

if json_flag == "1":
    json.dump(report, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    sys.exit(0)

headers = [
    "NAME", "IMAGE", "MEM_USAGE", "CGROUP", "MEM_LIMIT", "MEM_RESERV", "SWAP", "SWAP_LIMIT",
    "OOM", "OOM_KILL", "RESTARTS", "TOP_RSS",
]
table = []
for row in containers:
    table.append([
        row["name"],
        cell(row["image"]),
        fmt_bytes(row["memory_usage_bytes"]),
        fmt_bytes(row["memory_current_bytes"]),
        limit_label(row["memory_limit_source"], row["memory_limit_bytes"]),
        limit_label(row["memory_reservation_source"], row["memory_reservation_bytes"]),
        fmt_bytes(row["swap_bytes"]),
        limit_label(row["swap_limit_source"], row["swap_limit_bytes"]),
        cell(row["oom"]),
        cell(row["oom_kill"]),
        cell(row["restart_count"]),
        fmt_top(row),
    ])

widths = [len(header) for header in headers]
for cells in table:
    for index, value in enumerate(cells[:-1]):
        widths[index] = max(widths[index], len(value))

def render(cells):
    padded = []
    for index, value in enumerate(cells[:-1]):
        padded.append(value.ljust(widths[index]))
    padded.append(cells[-1])
    return "  ".join(padded)

sys.stdout.write("# read-only container memory report; no containers were changed\n")
sys.stdout.write(render(headers) + "\n")
for cells in table:
    sys.stdout.write(render(cells) + "\n")
sys.stdout.write(
    "TOTALS  containers=%d  memory=%s  swap=%s  unlimited=%d  oom=%d  oom_kill=%d  restarts=%d\n"
    % (
        totals["containers"],
        fmt_bytes(totals["memory_usage_bytes"]),
        fmt_bytes(totals["swap_bytes"]),
        totals["unlimited"],
        totals["oom"],
        totals["oom_kill"],
        totals["restart_count"],
    )
)
if any(totals[key] for key in (
    "memory_usage_unknown", "swap_unknown", "oom_unknown", "oom_kill_unknown", "restart_unknown"
)):
    sys.stdout.write(
        "UNKNOWN  memory=%d  swap=%d  oom=%d  oom_kill=%d  restarts=%d\n"
        % (
            totals["memory_usage_unknown"],
            totals["swap_unknown"],
            totals["oom_unknown"],
            totals["oom_kill_unknown"],
            totals["restart_unknown"],
        )
    )
PY
