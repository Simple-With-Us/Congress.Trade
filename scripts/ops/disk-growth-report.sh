#!/usr/bin/env bash
# disk-growth-report.sh — diff today's snapshot vs 1-day and 7-day baselines
#
#   bash scripts/ops/disk-growth-report.sh
#   bash scripts/ops/disk-growth-report.sh --json
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=scripts/ops/disk-growth-lib.sh
# shellcheck disable=SC1091
source "${ROOT_DIR}/scripts/ops/disk-growth-lib.sh"

if [[ -f /etc/disk-growth-snapshot.env ]]; then
  # shellcheck disable=SC1091
  set -a
  # shellcheck source=/dev/null
  source /etc/disk-growth-snapshot.env
  set +a
fi

SNAPSHOT_DIR="${SNAPSHOT_DIR:-/var/lib/fleet-disk-growth}"
REPORT_DATE="${REPORT_DATE:-$(date -u +%Y-%m-%d)}"
JSON_OUT=0
for arg in "$@"; do
  case "$arg" in
    --json) JSON_OUT=1 ;;
    -h | --help)
      echo "Usage: disk-growth-report.sh [--json]"
      exit 0
      ;;
    *)
      echo "disk-growth-report: unknown arg: $arg" >&2
      exit 2
      ;;
  esac
done

disk_growth_path_for_offset() {
  local base="$1" offset="$2"
  python3 - "$base" "$offset" <<'PY'
import datetime, sys
base = datetime.date.fromisoformat(sys.argv[1])
off = int(sys.argv[2])
print((base - datetime.timedelta(days=off)).isoformat())
PY
}

load_snap() {
  local d="$1"
  local p
  p="$(SNAPSHOT_DIR="$SNAPSHOT_DIR" disk_growth_snapshot_path "$d")"
  if [[ ! -f "$p" ]]; then
    echo ""
    return 1
  fi
  cat "$p"
}

current_json="$(load_snap "$REPORT_DATE" || true)"
if [[ -z "$current_json" ]]; then
  echo "disk-growth-report: missing snapshot for ${REPORT_DATE} in ${SNAPSHOT_DIR}" >&2
  exit 1
fi

day1="$(disk_growth_path_for_offset "$REPORT_DATE" 1)"
day7="$(disk_growth_path_for_offset "$REPORT_DATE" 7)"
json1="$(load_snap "$day1" || true)"
json7="$(load_snap "$day7" || true)"

DISK_GROWTH_CURRENT="$current_json" \
DISK_GROWTH_BASE1="$json1" \
DISK_GROWTH_BASE7="$json7" \
DISK_GROWTH_REPORT_DATE="$REPORT_DATE" \
DISK_GROWTH_DAY1="$day1" \
DISK_GROWTH_DAY7="$day7" \
DISK_GROWTH_JSON_OUT="$JSON_OUT" \
python3 - <<'PY'
import json, os, sys

def load(label, raw):
    if not raw.strip():
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        print(f"disk-growth-report: invalid JSON for {label}: {exc}", file=sys.stderr)
        sys.exit(1)

def dir_index(doc):
    out = {}
    for block in (doc.get("directory_totals") or {}).values():
        for ent in block.get("entries") or []:
            path = ent.get("path")
            if path:
                out[path] = int(ent.get("size_bytes") or 0)
    return out

def fs_index(doc):
    return {r["mount"]: r for r in doc.get("filesystems") or [] if r.get("mount")}

def docker_index(doc):
    d = doc.get("docker") or {}
    return dict((d.get("summary") or {}).items())

def diff_maps(new, old):
    if old is None:
        return {"available": False, "growers": [], "shrinkers": []}
    keys = set(new) | set(old)
    deltas = []
    for k in sorted(keys):
        deltas.append((k, int(new.get(k, 0)) - int(old.get(k, 0))))
    growers = sorted([x for x in deltas if x[1] > 0], key=lambda t: t[1], reverse=True)
    shrinkers = sorted([x for x in deltas if x[1] < 0], key=lambda t: t[1])
    return {"available": True, "growers": growers[:15], "shrinkers": shrinkers[:15]}

def diff_fs(new, old):
    if old is None:
        return {"available": False}
    mounts = set(fs_index(new)) | set(fs_index(old))
    used_deltas = []
    avail_deltas = []
    for m in mounts:
        nu = int((fs_index(new).get(m) or {}).get("used_kb") or 0)
        ou = int((fs_index(old).get(m) or {}).get("used_kb") or 0)
        na = int((fs_index(new).get(m) or {}).get("avail_kb") or 0)
        oa = int((fs_index(old).get(m) or {}).get("avail_kb") or 0)
        used_deltas.append((m, nu - ou))
        avail_deltas.append((m, na - oa))
    growers = sorted([x for x in used_deltas if x[1] > 0], key=lambda t: t[1], reverse=True)
    shrinkers = sorted([x for x in used_deltas if x[1] < 0], key=lambda t: t[1])
    return {
        "available": True,
        "used_kb_growers": growers,
        "used_kb_shrinkers": shrinkers,
        "avail_kb_changes": sorted(avail_deltas, key=lambda t: t[1]),
    }

def diff_docker_summary(new, old):
    if old is None:
        return {"available": False}

    def sizes(doc):
        out = {}
        for name, block in (docker_index(doc)).items():
            out[name] = int(block.get("size_bytes_sum") or 0)
        return out

    return diff_maps(sizes(new), sizes(old))

current = load("current", os.environ["DISK_GROWTH_CURRENT"])
base1 = load("day1", os.environ.get("DISK_GROWTH_BASE1", ""))
base7 = load("day7", os.environ.get("DISK_GROWTH_BASE7", ""))

report = {
    "report_date": os.environ["DISK_GROWTH_REPORT_DATE"],
    "baseline_1d": os.environ["DISK_GROWTH_DAY1"],
    "baseline_7d": os.environ["DISK_GROWTH_DAY7"],
    "filesystems": {
        "1d": diff_fs(current, base1),
        "7d": diff_fs(current, base7),
    },
    "directories": {
        "1d": diff_maps(dir_index(current), dir_index(base1) if base1 else None),
        "7d": diff_maps(dir_index(current), dir_index(base7) if base7 else None),
    },
    "docker_summary": {
        "1d": diff_docker_summary(current, base1),
        "7d": diff_docker_summary(current, base7),
    },
}

if os.environ.get("DISK_GROWTH_JSON_OUT") == "1":
    print(json.dumps(report, indent=2, sort_keys=True))
    sys.exit(0)

def fmt_kb(kb):
    sign = "+" if kb > 0 else ""
    return f"{sign}{kb} KiB"

def fmt_bytes(b):
    sign = "+" if b > 0 else ""
    if abs(b) >= 1024**3:
        return f"{sign}{b / 1024**3:.2f} GiB"
    if abs(b) >= 1024**2:
        return f"{sign}{b / 1024**2:.1f} MiB"
    if abs(b) >= 1024:
        return f"{sign}{b / 1024:.1f} KiB"
    return f"{sign}{b} B"

snap_dir = current.get("meta", {}).get("snapshot_dir") or os.environ.get("SNAPSHOT_DIR", "")
print(f"Disk growth report for {report['report_date']} (snapshots in {snap_dir})")
for label, key, baseline_key in (
    ("1-day", "1d", "baseline_1d"),
    ("7-day", "7d", "baseline_7d"),
):
    print(f"\n== vs {label} baseline ({report[baseline_key]}) ==")
    fs = report["filesystems"][key]
    if fs.get("available"):
        print("Filesystem used KiB growers:")
        for m, d in fs.get("used_kb_growers", [])[:10]:
            print(f"  {m}: {fmt_kb(d)}")
        if fs.get("used_kb_shrinkers"):
            print("Filesystem used KiB shrinkers:")
            for m, d in fs.get("used_kb_shrinkers", [])[:10]:
                print(f"  {m}: {fmt_kb(d)}")
    else:
        print("  (no baseline snapshot)")

    dirs = report["directories"][key]
    if dirs.get("available"):
        print("Directory byte growers:")
        for path, d in dirs.get("growers", [])[:10]:
            print(f"  {path}: {fmt_bytes(d)}")
        if dirs.get("shrinkers"):
            print("Directory byte shrinkers:")
            for path, d in dirs.get("shrinkers", [])[:10]:
                print(f"  {path}: {fmt_bytes(d)}")
    else:
        print("  (no baseline snapshot for directories)")

    dk = report["docker_summary"][key]
    if dk.get("available"):
        print("Docker section size growers:")
        for name, d in dk.get("growers", [])[:10]:
            print(f"  {name}: {fmt_bytes(d)}")
    else:
        print("  (no baseline snapshot for docker)")
PY
