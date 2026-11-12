# disk-growth-lib.sh — shared read-only disk snapshot + diff helpers (source only)
# shellcheck shell=bash
set -euo pipefail

: "${SNAPSHOT_DIR:=/var/lib/fleet-disk-growth}"
: "${RETENTION_DAYS:=60}"
: "${TOP_N:=20}"
: "${DU_TIMEOUT_SEC:=600}"
: "${COLLECTOR_TIMEOUT_SEC:=30}"
: "${DU_SCAN_ROOTS:=/,/var,/home,/data,/opt,/tmp,/mnt/fleet-extra}"
: "${BACKUP_SCAN_DIRS:=/data/backups}"
: "${SNAPSHOT_PREFIX:=disk-growth-}"
: "${DISK_GROWTH_DF:=df}"
: "${DISK_GROWTH_DU:=du}"
: "${DISK_GROWTH_TIMEOUT:=timeout}"
: "${DISK_GROWTH_DOCKER:=docker}"
: "${DISK_GROWTH_FINDMNT:=findmnt}"
: "${DISK_GROWTH_IONICE:=ionice}"
: "${DISK_GROWTH_NICE:=nice}"

disk_growth_snapshot_basename() {
  local d="${1:-$(date -u +%Y-%m-%d)}"
  printf '%s%s.json' "$SNAPSHOT_PREFIX" "$d"
}

disk_growth_snapshot_path() {
  printf '%s/%s' "$SNAPSHOT_DIR" "$(disk_growth_snapshot_basename "$1")"
}

disk_growth_is_snapshot_file() {
  local base
  base="$(basename "$1")"
  [[ "$base" =~ ^${SNAPSHOT_PREFIX}[0-9]{4}-[0-9]{2}-[0-9]{2}\.json$ ]]
}

disk_growth_mount_present() {
  local m="$1"
  if [[ "$m" == / ]]; then
    return 0
  fi
  "$DISK_GROWTH_TIMEOUT" --kill-after=5s "$COLLECTOR_TIMEOUT_SEC" "$DISK_GROWTH_FINDMNT" -n -T "$m" >/dev/null 2>&1
}

disk_growth_list_mount_targets() {
  local m
  for m in / /tmp /dev/shm /mnt/fleet-extra; do
    if disk_growth_mount_present "$m"; then
      printf '%s\n' "$m"
    fi
  done
}

disk_growth_collect_df() {
  local mounts tmp
  mounts="$(disk_growth_list_mount_targets | tr '\n' ' ')"
  # shellcheck disable=SC2086
  "$DISK_GROWTH_TIMEOUT" --kill-after=5s "$COLLECTOR_TIMEOUT_SEC" "$DISK_GROWTH_DF" -Pk $mounts 2>/dev/null || true
}

disk_growth_collect_df_inodes() {
  local mounts tmp
  mounts="$(disk_growth_list_mount_targets | tr '\n' ' ')"
  # shellcheck disable=SC2086
  "$DISK_GROWTH_TIMEOUT" --kill-after=5s "$COLLECTOR_TIMEOUT_SEC" "$DISK_GROWTH_DF" -Pi $mounts 2>/dev/null || true
}

# One traversal for overlapping roots on the same device. Keep requested
# child breakdowns by choosing the necessary depth, not rescanning each child.
disk_growth_collect_du() {
  export DU_SCAN_ROOTS BACKUP_SCAN_DIRS TOP_N DU_TIMEOUT_SEC
  export DISK_GROWTH_TIMEOUT DISK_GROWTH_IONICE DISK_GROWTH_NICE DISK_GROWTH_DU
  python3 - <<'PY'
import os, subprocess, sys
from pathlib import Path

# Paths are opaque filesystem bytes across both input and output pipes.
sys.stdout.reconfigure(errors="surrogateescape")
env = os.environ
top_n = int(env["TOP_N"])
if top_n <= 0:
    raise SystemExit("TOP_N must be positive")
roots = []
for value in (env["DU_SCAN_ROOTS"] + "," + env["BACKUP_SCAN_DIRS"]).split(","):
    requested = value.strip()
    if not requested or not os.path.isdir(requested):
        continue
    resolved = os.path.realpath(requested)
    if not any(row["path"] == resolved for row in roots):
        roots.append({"path": resolved, "device": os.stat(resolved).st_dev})
roots.sort(key=lambda row: (len(Path(row["path"]).parts), row["path"]))
groups = []
for row in roots:
    parent = next((g for g in groups if g["device"] == row["device"] and
                   os.path.commonpath([g["path"], row["path"]]) == g["path"]), None)
    if parent is None:
        parent = dict(row, roots=[])
        groups.append(parent)
    parent["roots"].append(row["path"])
for group in groups:
    base = group["path"]
    depth = max(len(Path(root).parts) - len(Path(base).parts) + 1 for root in group["roots"])
    command = [env["DISK_GROWTH_TIMEOUT"], "--kill-after=5s", env["DU_TIMEOUT_SEC"],
               env["DISK_GROWTH_IONICE"], "-c3", env["DISK_GROWTH_NICE"], "-n", "19",
               env["DISK_GROWTH_DU"], "-x", "-d", str(depth), "-B1", "--", base]
    # Consume the whole stream while retaining only bounded top-N rows.
    # Piping to head would truncate scans; staging all du output could fill /tmp.
    selected = {root: [] for root in group["roots"]}
    try:
        with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, errors="surrogateescape") as run:
            for line in run.stdout:
                parts = line.rstrip("\n").split(None, 1)
                if len(parts) != 2:
                    continue
                try:
                    size = int(parts[0])
                except ValueError:
                    continue
                path = parts[1]
                for root in group["roots"]:
                    if path == root or os.path.dirname(path.rstrip("/")) == root:
                        rows = selected[root]
                        rows.append((size, path))
                        rows.sort(key=lambda row: (-row[0], row[1]))
                        del rows[top_n:]
            code = run.wait()
    except OSError:
        code = 1
    for root in group["roots"]:
        print("ROOT " + root)
        for size, path in selected[root]:
            print(str(size) + "\t" + path)
        if code == 124:
            print("DU_TIMEOUT 1")
        elif code:
            print("DU_ERROR 1")
PY
}

disk_growth_docker_verbose() {
  "$DISK_GROWTH_TIMEOUT" --kill-after=5s "$COLLECTOR_TIMEOUT_SEC" "$DISK_GROWTH_DOCKER" system df -v 2>/dev/null || return 1
}

disk_growth_prune_old_snapshots() {
  local dir="$SNAPSHOT_DIR" keep="$RETENTION_DAYS"
  [[ -d "$dir" ]] || return 0
  mapfile -t files < <(
    find "$dir" -maxdepth 1 -type f -name "${SNAPSHOT_PREFIX}"????-??-??.json -printf '%T@ %p\n' 2>/dev/null \
      | sort -rn | awk '{ $1=""; sub(/^ /,""); print }'
  )
  local i=0 f
  for f in "${files[@]}"; do
    i=$((i + 1))
    if (( i > keep )); then
      if disk_growth_is_snapshot_file "$f"; then
        rm -f "$f"
      fi
    fi
  done
}

disk_growth_build_snapshot_json() (
  local captured_at date_utc host
  date_utc="${DISK_GROWTH_SNAPSHOT_DATE:-$(date -u +%Y-%m-%d)}"
  captured_at="${DISK_GROWTH_CAPTURED_AT:-${date_utc}T$(date -u +%H:%M:%SZ)}"
  host="$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo unknown)"

  local df_out inode_out docker_out du_partial=0
  df_out="$(disk_growth_collect_df)"
  inode_out="$(disk_growth_collect_df_inodes)"
  docker_out=""
  if ! docker_out="$(disk_growth_docker_verbose)"; then
    docker_out=""
  fi

  local du_blob
  du_blob="$(disk_growth_collect_du)"
  if grep -Eq '^DU_(TIMEOUT|ERROR) 1$' <<<"$du_blob"; then
    du_partial=1
  fi
  # Data files avoid MAX_ARG_STRLEN/ARG_MAX even for a large Docker inventory.
  local input_dir
  input_dir="$(mktemp -d "${TMPDIR:-/tmp}/disk-growth-input.XXXXXX")"
  trap 'rm -rf "$input_dir"' EXIT
  printf '%s' "$df_out" > "$input_dir/df"
  printf '%s' "$inode_out" > "$input_dir/inodes"
  printf '%s' "$docker_out" > "$input_dir/docker"
  printf '%s' "$du_blob" > "$input_dir/du"

  DISK_GROWTH_SNAPSHOT_DIR="$SNAPSHOT_DIR" \
  DISK_GROWTH_CAPTURED_AT="$captured_at" \
  DISK_GROWTH_DATE="$date_utc" \
  DISK_GROWTH_HOST="$host" \
  DISK_GROWTH_TOP_N="$TOP_N" \
  DISK_GROWTH_DU_TIMEOUT="$DU_TIMEOUT_SEC" \
  DISK_GROWTH_DU_PARTIAL="$du_partial" \
  python3 - "$input_dir" <<'PY'
import json, os, re, sys
from pathlib import Path

def blob(name):
    return (Path(sys.argv[1]) / name).read_text(encoding="utf-8", errors="surrogateescape")

def parse_df(blob):
    out = []
    for line in (blob or "").strip().splitlines()[1:]:
        parts = line.split()
        if len(parts) < 6:
            continue
        mount = parts[5]
        out.append({
            "mount": mount,
            "size_kb": int(parts[1]),
            "used_kb": int(parts[2]),
            "avail_kb": int(parts[3]),
            "use_pct": parts[4].rstrip("%"),
            "inodes": None,
        })
    return out

def merge_inodes(rows, blob):
    by_mount = {r["mount"]: r for r in rows}
    for line in (blob or "").strip().splitlines()[1:]:
        parts = line.split()
        if len(parts) < 6:
            continue
        mount = parts[5]
        if mount not in by_mount:
            by_mount[mount] = {"mount": mount}
        by_mount[mount]["inodes"] = {
            "total": int(parts[1]),
            "used": int(parts[2]),
            "free": int(parts[3]),
            "use_pct": parts[4].rstrip("%"),
        }
    return list(by_mount.values())

def parse_docker(blob):
    if not blob.strip():
        return {"available": False, "error": "docker_unavailable", "sections": {}}
    sections = {}
    current = None
    headers = None
    rows = []
    for raw in blob.splitlines():
        line = raw.rstrip()
        if not line:
            if current and rows:
                sections[current] = {"headers": headers, "rows": rows}
                current = None
                headers = None
                rows = []
            continue
        if line.endswith("usage:") or line.endswith("usage"):
            if current and rows:
                sections[current] = {"headers": headers, "rows": rows}
            current = line.replace(" space usage:", "").replace(" usage:", "").strip()
            headers = None
            rows = []
            continue
        if current and headers is None and (
            "REPOSITORY" in line
            or "TYPE" in line
            or "VOLUME NAME" in line
            or "CACHE ID" in line
            or "CONTAINER ID" in line
        ):
            headers = re.split(r"\s{2,}", line.strip())
            continue
        if current and headers:
            if line.startswith("REPOSITORY") or line.startswith("TYPE"):
                continue
            cols = re.split(r"\s{2,}", line.strip())
            if len(cols) >= 2:
                row = {headers[i] if i < len(headers) else f"col{i}": cols[i] for i in range(len(cols))}
                rows.append(row)
    if current and rows:
        sections[current] = {"headers": headers, "rows": rows}

    summary = {}
    for name, block in sections.items():
        size_key = next((h for h in (block.get("headers") or []) if "SIZE" in h.upper()), None)
        if not size_key:
            continue
        total = 0
        for row in block.get("rows") or []:
            val = row.get(size_key, "")
            m = re.match(r"([\d.]+)\s*([KMGT]?i?B)", str(val).replace(" ", ""), re.I)
            if not m:
                continue
            num = float(m.group(1))
            unit = m.group(2)
            mult = {"B": 1, "KB": 1024, "MB": 1024**2, "GB": 1024**3, "TB": 1024**4, "KIB": 1024, "MIB": 1024**2, "GIB": 1024**3}.get(unit.upper(), 1)
            total += int(num * mult)
        summary[name] = {"row_count": len(block.get("rows") or []), "size_bytes_sum": total}

    return {"available": True, "sections": sections, "summary": summary}

def parse_du(blob):
    roots = {}
    current = None
    for line in (blob or "").splitlines():
        if line.startswith("ROOT "):
            current = line[5:].strip()
            roots[current] = {"entries": [], "timeout": False, "error": False}
            continue
        if line.strip() == "DU_TIMEOUT 1" and current:
            roots[current]["timeout"] = True
            continue
        if line.strip() == "DU_ERROR 1" and current:
            roots[current]["error"] = True
            continue
        parts = line.split(None, 1)
        if len(parts) != 2 or not current:
            continue
        try:
            size = int(parts[0])
        except ValueError:
            continue
        path = parts[1].strip()
        roots[current]["entries"].append({"path": path, "size_bytes": size})
    return roots

fs = merge_inodes(parse_df(blob("df")), blob("inodes"))
doc = {
    "schema_version": 1,
    "captured_at": os.environ["DISK_GROWTH_CAPTURED_AT"],
    "date": os.environ["DISK_GROWTH_DATE"],
    "host": os.environ["DISK_GROWTH_HOST"],
    "filesystems": fs,
    "directory_totals": parse_du(blob("du")),
    "docker": parse_docker(blob("docker")),
    "meta": {
        "top_n": int(os.environ["DISK_GROWTH_TOP_N"]),
        "du_timeout_sec": int(os.environ["DISK_GROWTH_DU_TIMEOUT"]),
        "du_partial": os.environ["DISK_GROWTH_DU_PARTIAL"] == "1",
        "snapshot_dir": os.environ.get("DISK_GROWTH_SNAPSHOT_DIR", ""),
    },
}
print(json.dumps(doc, indent=2, sort_keys=True))
PY
)
