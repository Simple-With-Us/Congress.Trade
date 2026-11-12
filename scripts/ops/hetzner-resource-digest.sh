#!/usr/bin/env bash
# hetzner-resource-digest.sh — read-only host resource digest (Coolify / Hetzner).
#
# Emits one JSON document and a short markdown summary: root disk %, root inode %,
# RAM total/available, swap used, load (1/5/15) vs CPU count, and CPU steal sampled
# from /proc/stat.  Each metric gets green/yellow/red against env-configured thresholds.
# Numeric fields include deltas versus the previous run's saved JSON state file.
#
# Optional sibling report scripts (when installed on the host) may replace built-in
# collectors when they print one JSON object to stdout (HETZNER_DIGEST_JSON=1):
#   host-inode-report.sh, host-cpu-steal-sampler.sh,
#   host-container-ram-report.sh, host-disk-growth-snapshot.sh
# Default search: same directory as this script, then /usr/local/bin/.
# HETZNER_DIGEST_SIBLING_DIR, when set, is an exclusive sibling directory.
#
#   bash scripts/ops/hetzner-resource-digest.sh
#   HETZNER_DIGEST_FIXTURE_ROOT=scripts/ops/fixtures/hetzner-resource-digest \
#     bash scripts/ops/hetzner-resource-digest.sh
#
# Env (thresholds are "higher is worse" unless noted):
#   ROOT_PATH                          default /
#   HETZNER_DIGEST_STATE_PATH          default /var/lib/hetzner-resource-digest/last.json
#   HETZNER_DIGEST_JSON_OUT            default /var/lib/hetzner-resource-digest/latest.json
#   HETZNER_DIGEST_MD_OUT              default /var/lib/hetzner-resource-digest/latest.md
#   HETZNER_DIGEST_CPU_STEAL_SECONDS   default 3
#   THRESH_DISK_USED_YELLOW / _RED      default 80 / 90
#   THRESH_INODE_USED_YELLOW / _RED     default 80 / 90
#   THRESH_MEM_AVAIL_PCT_YELLOW / _RED  default 15 / 8  (LOW available % is worse; inverted)
#   THRESH_SWAP_USED_GB_YELLOW / _RED   default 4 / 12
#   THRESH_LOAD_PER_CPU_YELLOW / _RED   default 1.0 / 2.0  (load1 / ncpu)
#   THRESH_CPU_STEAL_PCT_YELLOW / _RED  default 3 / 8
#   HETZNER_DIGEST_FIXTURE_ROOT        offline fixtures (see test script)
#   HETZNER_DIGEST_SKIP_STATE_WRITE    default 0; 1 = do not update state file
#   HETZNER_DIGEST_STDOUT_ONLY         default 0; 1 = print JSON+md to stdout, skip file writes
#
# Exit 0 always when the digest was produced (read-only).  Exit 1 on usage errors.

set -euo pipefail

ROOT_PATH="${ROOT_PATH:-/}"
STATE_PATH="${HETZNER_DIGEST_STATE_PATH:-/var/lib/hetzner-resource-digest/last.json}"
JSON_OUT="${HETZNER_DIGEST_JSON_OUT:-/var/lib/hetzner-resource-digest/latest.json}"
MD_OUT="${HETZNER_DIGEST_MD_OUT:-/var/lib/hetzner-resource-digest/latest.md}"
CPU_STEAL_SECONDS="${HETZNER_DIGEST_CPU_STEAL_SECONDS:-3}"
FIXTURE_ROOT="${HETZNER_DIGEST_FIXTURE_ROOT:-}"
SKIP_STATE_WRITE="${HETZNER_DIGEST_SKIP_STATE_WRITE:-0}"
STDOUT_ONLY="${HETZNER_DIGEST_STDOUT_ONLY:-0}"

THRESH_DISK_USED_YELLOW="${THRESH_DISK_USED_YELLOW:-80}"
THRESH_DISK_USED_RED="${THRESH_DISK_USED_RED:-90}"
THRESH_INODE_USED_YELLOW="${THRESH_INODE_USED_YELLOW:-80}"
THRESH_INODE_USED_RED="${THRESH_INODE_USED_RED:-90}"
THRESH_MEM_AVAIL_PCT_YELLOW="${THRESH_MEM_AVAIL_PCT_YELLOW:-15}"
THRESH_MEM_AVAIL_PCT_RED="${THRESH_MEM_AVAIL_PCT_RED:-8}"
THRESH_SWAP_USED_GB_YELLOW="${THRESH_SWAP_USED_GB_YELLOW:-4}"
THRESH_SWAP_USED_GB_RED="${THRESH_SWAP_USED_GB_RED:-12}"
THRESH_LOAD_PER_CPU_YELLOW="${THRESH_LOAD_PER_CPU_YELLOW:-1.0}"
THRESH_LOAD_PER_CPU_RED="${THRESH_LOAD_PER_CPU_RED:-2.0}"
THRESH_CPU_STEAL_PCT_YELLOW="${THRESH_CPU_STEAL_PCT_YELLOW:-3}"
THRESH_CPU_STEAL_PCT_RED="${THRESH_CPU_STEAL_PCT_RED:-8}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  sed -n '1,36p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

die() {
  printf 'hetzner-resource-digest: error: %s\n' "$*" >&2
  exit 1
}

fixture_path() {
  local name="$1"
  if [[ -n "$FIXTURE_ROOT" ]]; then
    printf '%s/%s' "$FIXTURE_ROOT" "$name"
  else
    printf ''
  fi
}

read_file_or_live() {
  local fixture_name="$1" live_path="$2"
  local fp
  fp="$(fixture_path "$fixture_name")"
  if [[ -n "$FIXTURE_ROOT" ]]; then
    [[ -f "$fp" ]] || return 1
    cat -- "$fp"
    return 0
  fi
  if [[ -r "$live_path" ]]; then
    cat -- "$live_path"
    return 0
  fi
  return 1
}

# --- built-in collectors -------------------------------------------------------

collect_disk() {
  local line total used avail pct
  if [[ -n "$(fixture_path df-root.txt)" ]]; then
    line="$(cat "$(fixture_path df-root.txt)")"
  else
    line="$(df -P "$ROOT_PATH" 2>/dev/null | awk 'NR==2 {print $2, $3, $4, $5}' || true)"
  fi
  if [[ -z "$line" ]]; then
    DISK_ERR="df_failed"
    return 1
  fi
  read -r total used avail pct <<<"$line"
  DISK_USED_PCT="${pct%%%}"
  DISK_TOTAL_KB="$total"
  DISK_AVAIL_KB="$avail"
  DISK_ERR=""
}

collect_inodes() {
  local line total used avail pct
  if [[ -n "$(fixture_path df-inodes.txt)" ]]; then
    line="$(cat "$(fixture_path df-inodes.txt)")"
  else
    line="$(df -Pi "$ROOT_PATH" 2>/dev/null | awk 'NR==2 {print $2, $3, $4, $5}' || true)"
  fi
  if [[ -z "$line" ]]; then
    INODE_ERR="df_failed"
    return 1
  fi
  read -r total used avail pct <<<"$line"
  INODE_USED_PCT="${pct%%%}"
  INODE_ERR=""
}

collect_mem() {
  local meminfo
  if ! meminfo="$(read_file_or_live meminfo.txt /proc/meminfo 2>/dev/null)"; then
    MEM_ERR="meminfo_unreadable"
    return 1
  fi
  MEM_TOTAL_KB="$(printf '%s\n' "$meminfo" | awk '/^MemTotal:/ {print $2; exit}')"
  MEM_AVAIL_KB="$(printf '%s\n' "$meminfo" | awk '/^MemAvailable:/ {print $2; exit}')"
  SWAP_TOTAL_KB="$(printf '%s\n' "$meminfo" | awk '/^SwapTotal:/ {print $2; exit}')"
  SWAP_FREE_KB="$(printf '%s\n' "$meminfo" | awk '/^SwapFree:/ {print $2; exit}')"
  if [[ -z "$MEM_TOTAL_KB" || -z "$MEM_AVAIL_KB" ]]; then
    MEM_ERR="meminfo_incomplete"
    return 1
  fi
  SWAP_USED_KB=$((SWAP_TOTAL_KB - SWAP_FREE_KB))
  MEM_AVAIL_PCT="$(awk -v a="$MEM_AVAIL_KB" -v t="$MEM_TOTAL_KB" 'BEGIN { if (t>0) printf "%.2f", 100*a/t; else print "0" }')"
  SWAP_USED_GB="$(awk -v u="$SWAP_USED_KB" 'BEGIN { printf "%.2f", u/1024/1024 }')"
  MEM_ERR=""
}

collect_load() {
  local la
  if ! la="$(read_file_or_live loadavg.txt /proc/loadavg 2>/dev/null)"; then
    LOAD_ERR="loadavg_unreadable"
    return 1
  fi
  read -r LOAD_1 LOAD_5 LOAD_15 _rest <<<"$la"
  if [[ -n "$FIXTURE_ROOT" ]]; then
    if [[ ! -s "$(fixture_path ncpu.txt)" ]]; then
      LOAD_ERR="cpu_count_unavailable"
      return 1
    fi
    CPU_COUNT="$(cat "$(fixture_path ncpu.txt)")"
  elif [[ -n "${HETZNER_DIGEST_CPU_COUNT:-}" ]]; then
    CPU_COUNT="$HETZNER_DIGEST_CPU_COUNT"
  else
    CPU_COUNT="$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1)"
  fi
  LOAD_PER_CPU="$(awk -v l="$LOAD_1" -v n="$CPU_COUNT" 'BEGIN { if (n>0) printf "%.3f", l/n; else print l }')"
  LOAD_ERR=""
}

read_cpu_agg() {
  local stat
  if ! stat="$(read_file_or_live proc-stat.txt /proc/stat 2>/dev/null)"; then
  return 1
  fi
  printf '%s\n' "$stat" | awk '/^cpu / {
    user=$2; nice=$3; sys=$4; idle=$5; iowait=$6; irq=$7; softirq=$8; steal=$9;
    total=user+nice+sys+idle+iowait+irq+softirq+steal;
    printf "%s %s\n", total, steal;
    exit
  }'
}

collect_cpu_steal() {
  local a b total1 steal1 total2 steal2
  if [[ -n "$FIXTURE_ROOT" ]]; then
    if [[ ! -s "$(fixture_path proc-stat-a.txt)" || ! -s "$(fixture_path proc-stat-b.txt)" ]]; then
      CPU_STEAL_PCT=""
      CPU_STEAL_ERR="fixture_missing"
      return 1
    fi
    read -r total1 steal1 < <(awk '/^cpu / {
      user=$2; nice=$3; sys=$4; idle=$5; iowait=$6; irq=$7; softirq=$8; steal=$9;
      total=user+nice+sys+idle+iowait+irq+softirq+steal;
      printf "%s %s\n", total, steal;
      exit
    }' "$(fixture_path proc-stat-a.txt)")
    read -r total2 steal2 < <(awk '/^cpu / {
      user=$2; nice=$3; sys=$4; idle=$5; iowait=$6; irq=$7; softirq=$8; steal=$9;
      total=user+nice+sys+idle+iowait+irq+softirq+steal;
      printf "%s %s\n", total, steal;
      exit
    }' "$(fixture_path proc-stat-b.txt)")
    CPU_STEAL_SAMPLE_SECONDS="$CPU_STEAL_SECONDS"
  else
    read -r total1 steal1 < <(read_cpu_agg || echo "0 0")
    if [[ -z "$FIXTURE_ROOT" ]]; then
      sleep "$CPU_STEAL_SECONDS"
    fi
    read -r total2 steal2 < <(read_cpu_agg || echo "0 0")
    CPU_STEAL_SAMPLE_SECONDS="$CPU_STEAL_SECONDS"
  fi
  local dt ds
  dt=$((total2 - total1))
  ds=$((steal2 - steal1))
  if (( dt <= 0 )); then
    CPU_STEAL_PCT=""
    CPU_STEAL_ERR="zero_interval"
    return 0
  fi
  CPU_STEAL_PCT="$(awk -v ds="$ds" -v dt="$dt" 'BEGIN { printf "%.3f", 100*ds/dt }')"
  CPU_STEAL_ERR=""
}

# --- sibling hooks -------------------------------------------------------------

sibling_search_paths() {
  local base="$1"
  if [[ -n "${HETZNER_DIGEST_SIBLING_DIR:-}" ]]; then
    printf '%s\n' "$HETZNER_DIGEST_SIBLING_DIR/$base"
    return 0
  fi
  printf '%s\n' \
    "${HETZNER_DIGEST_SIBLING_DIR:-$SCRIPT_DIR}/$base" \
    "$SCRIPT_DIR/$base" \
    "/usr/local/bin/$base"
}

try_sibling_json() {
  local base="$1"
  local path out
  local candidate failed=0
  while IFS= read -r candidate; do
    [[ -z "$candidate" ]] && continue
    if [[ -x "$candidate" ]]; then
      if out="$(HETZNER_DIGEST_JSON=1 "$candidate" 2>/dev/null)" && [[ -n "$out" ]]; then
        printf '%s' "$out"
        return 0
      fi
      printf '{"sibling":"%s","path":"%s","status":"error"}\n' "$base" "$candidate" >&2
      failed=1
      continue
    fi
  done < <(sibling_search_paths "$base")
  # A failed installed collector is not an absent collector.
  if (( failed )); then
    printf '{"status":"error"}'
    return 1
  fi
  return 1
}

merge_sibling_metric() {
  local key="$1" json="$2" field="$3"
  if [[ -z "$json" ]]; then
    return 1
  fi
  python3 - "$json" "$field" <<'PY'
import json, sys
doc = json.loads(sys.argv[1])
field = sys.argv[2]
if field in doc and isinstance(doc[field], (int, float)):
    print(doc[field])
elif "value" in doc and isinstance(doc["value"], (int, float)):
    print(doc["value"])
elif field in doc and isinstance(doc[field], dict) and "value" in doc[field]:
    print(doc[field]["value"])
PY
}

# --- status helpers ------------------------------------------------------------

emit_json_and_md() {
  local prior_path="$1"
  python3 - "$prior_path" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone

def num(x):
    if x is None:
        return None
    if isinstance(x, (int, float)):
        return x
    try:
        return float(x)
    except (TypeError, ValueError):
        return None

def delta(cur, prev):
    if cur is None or prev is None:
        return None
    return round(cur - prev, 3)

def status_high(value, yellow, red):
    if value is None:
        return "unknown"
    if value >= red:
        return "red"
    if value >= yellow:
        return "yellow"
    return "green"

def status_low(value, yellow, red):
    """Lower value is worse (e.g. available memory %)."""
    if value is None:
        return "unknown"
    if value <= red:
        return "red"
    if value <= yellow:
        return "yellow"
    return "green"

def worst(*statuses):
    rank = {"red": 4, "yellow": 3, "unknown": 2, "green": 1}
    best = "green"
    for s in statuses:
        if rank.get(s, 0) > rank.get(best, 0):
            best = s
    return best

prior = {}
prior_path = sys.argv[1]
if prior_path and os.path.isfile(prior_path):
    with open(prior_path, encoding="utf-8") as f:
        try:
            prior = json.load(f)
        except json.JSONDecodeError:
            prior = {}

env = os.environ

disk_pct = num(env.get("DISK_USED_PCT"))
inode_pct = num(env.get("INODE_USED_PCT"))
mem_total = num(env.get("MEM_TOTAL_KB"))
mem_avail = num(env.get("MEM_AVAIL_KB"))
mem_avail_pct = num(env.get("MEM_AVAIL_PCT"))
swap_used_gb = num(env.get("SWAP_USED_GB"))
load_1 = num(env.get("LOAD_1"))
load_5 = num(env.get("LOAD_5"))
load_15 = num(env.get("LOAD_15"))
cpu_count = num(env.get("CPU_COUNT"))
load_per = num(env.get("LOAD_PER_CPU"))
steal_pct = num(env.get("CPU_STEAL_PCT"))

pm = prior.get("metrics") or {}

metrics = {
    "root_disk_used_pct": {
        "value": disk_pct,
        "status": status_high(
            disk_pct,
            float(env["THRESH_DISK_USED_YELLOW"]),
            float(env["THRESH_DISK_USED_RED"]),
        ),
        "thresholds": {
            "yellow": float(env["THRESH_DISK_USED_YELLOW"]),
            "red": float(env["THRESH_DISK_USED_RED"]),
        },
        "delta": delta(disk_pct, num((pm.get("root_disk_used_pct") or {}).get("value"))),
        "error": env.get("DISK_ERR") or None,
    },
    "root_inode_used_pct": {
        "value": inode_pct,
        "status": status_high(
            inode_pct,
            float(env["THRESH_INODE_USED_YELLOW"]),
            float(env["THRESH_INODE_USED_RED"]),
        ),
        "thresholds": {
            "yellow": float(env["THRESH_INODE_USED_YELLOW"]),
            "red": float(env["THRESH_INODE_USED_RED"]),
        },
        "delta": delta(inode_pct, num((pm.get("root_inode_used_pct") or {}).get("value"))),
        "error": env.get("INODE_ERR") or None,
    },
    "memory": {
        "total_kb": mem_total,
        "available_kb": mem_avail,
        "available_pct": mem_avail_pct,
        "status": status_low(
            mem_avail_pct,
            float(env["THRESH_MEM_AVAIL_PCT_YELLOW"]),
            float(env["THRESH_MEM_AVAIL_PCT_RED"]),
        ),
        "thresholds": {
            "yellow_min_pct": float(env["THRESH_MEM_AVAIL_PCT_YELLOW"]),
            "red_min_pct": float(env["THRESH_MEM_AVAIL_PCT_RED"]),
        },
        "delta_available_pct": delta(
            mem_avail_pct,
            num((pm.get("memory") or {}).get("available_pct")),
        ),
        "error": env.get("MEM_ERR") or None,
    },
    "swap": {
        "used_gb": swap_used_gb,
        "status": status_high(
            swap_used_gb,
            float(env["THRESH_SWAP_USED_GB_YELLOW"]),
            float(env["THRESH_SWAP_USED_GB_RED"]),
        ),
        "thresholds": {
            "yellow_gb": float(env["THRESH_SWAP_USED_GB_YELLOW"]),
            "red_gb": float(env["THRESH_SWAP_USED_GB_RED"]),
        },
        "delta_used_gb": delta(swap_used_gb, num((pm.get("swap") or {}).get("used_gb"))),
    },
    "load": {
        "load_1": load_1,
        "load_5": load_5,
        "load_15": load_15,
        "cpu_count": cpu_count,
        "load_per_cpu_1": load_per,
        "status": status_high(
            load_per,
            float(env["THRESH_LOAD_PER_CPU_YELLOW"]),
            float(env["THRESH_LOAD_PER_CPU_RED"]),
        ),
        "thresholds": {
            "yellow_per_cpu": float(env["THRESH_LOAD_PER_CPU_YELLOW"]),
            "red_per_cpu": float(env["THRESH_LOAD_PER_CPU_RED"]),
        },
        "delta_load_per_cpu_1": delta(
            load_per,
            num((pm.get("load") or {}).get("load_per_cpu_1")),
        ),
        "error": env.get("LOAD_ERR") or None,
    },
    "cpu_steal": {
        "steal_pct": steal_pct,
        "sample_seconds": num(env.get("CPU_STEAL_SAMPLE_SECONDS")),
        "status": status_high(
            steal_pct,
            float(env["THRESH_CPU_STEAL_PCT_YELLOW"]),
            float(env["THRESH_CPU_STEAL_PCT_RED"]),
        ),
        "thresholds": {
            "yellow_pct": float(env["THRESH_CPU_STEAL_PCT_YELLOW"]),
            "red_pct": float(env["THRESH_CPU_STEAL_PCT_RED"]),
        },
        "delta_steal_pct": delta(
            steal_pct,
            num((pm.get("cpu_steal") or {}).get("steal_pct")),
        ),
        "error": env.get("CPU_STEAL_ERR") or None,
    },
}

siblings = {}
for key, raw in (
    ("inode_report", env.get("SIBLING_INODE_JSON")),
    ("cpu_steal_sampler", env.get("SIBLING_CPU_JSON")),
    ("container_ram_report", env.get("SIBLING_RAM_JSON")),
    ("disk_growth_snapshot", env.get("SIBLING_DISK_GROWTH_JSON")),
):
    if raw:
        try:
            payload = json.loads(raw)
            siblings[key] = {"status": "error" if isinstance(payload, dict) and payload.get("status") == "error" else "ok", "payload": payload}
        except json.JSONDecodeError:
            siblings[key] = {"status": "error", "payload": None}
    else:
        siblings[key] = {"status": "absent", "payload": None}

doc = {
    "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "root_path": env.get("ROOT_PATH", "/"),
    "metrics": metrics,
    "siblings": siblings,
    "overall_status": worst(
        metrics["root_disk_used_pct"]["status"],
        metrics["root_inode_used_pct"]["status"],
        metrics["memory"]["status"],
        metrics["swap"]["status"],
        metrics["load"]["status"],
        metrics["cpu_steal"]["status"],
    ),
}

json_text = json.dumps(doc, sort_keys=True, indent=2) + "\n"

lines = [
    "# Hetzner resource digest",
    "",
    f"- Generated: {doc['generated_at']}",
    f"- Overall: **{doc['overall_status']}**",
    "",
    "| Metric | Value | Status | Δ prior |",
    "| --- | --- | --- | --- |",
]
rows = [
    (
        "Root disk used %",
        metrics["root_disk_used_pct"]["value"],
        metrics["root_disk_used_pct"]["status"],
        metrics["root_disk_used_pct"]["delta"],
    ),
    (
        "Root inode used %",
        metrics["root_inode_used_pct"]["value"],
        metrics["root_inode_used_pct"]["status"],
        metrics["root_inode_used_pct"]["delta"],
    ),
    (
        "Mem available %",
        metrics["memory"]["available_pct"],
        metrics["memory"]["status"],
        metrics["memory"]["delta_available_pct"],
    ),
    (
        "Swap used (GiB)",
        metrics["swap"]["used_gb"],
        metrics["swap"]["status"],
        metrics["swap"]["delta_used_gb"],
    ),
    (
        "Load₁ / CPU",
        metrics["load"]["load_per_cpu_1"],
        metrics["load"]["status"],
        metrics["load"]["delta_load_per_cpu_1"],
    ),
    (
        "CPU steal %",
        metrics["cpu_steal"]["steal_pct"],
        metrics["cpu_steal"]["status"],
        metrics["cpu_steal"]["delta_steal_pct"],
    ),
]
for label, val, st, d in rows:
    v = "—" if val is None else val
    dstr = "—" if d is None else f"{d:+g}"
    lines.append(f"| {label} | {v} | {st} | {dstr} |")

md_text = "\n".join(lines) + "\n"

out_json = env.get("JSON_OUT", "")
out_md = env.get("MD_OUT", "")
stdout_only = env.get("STDOUT_ONLY") == "1"
skip_state = env.get("SKIP_STATE_WRITE") == "1"
state_path = env.get("STATE_PATH", "")

if stdout_only:
    sys.stdout.write("--- json ---\n")
    sys.stdout.write(json_text)
    sys.stdout.write("--- markdown ---\n")
    sys.stdout.write(md_text)
else:
    for path, text in ((out_json, json_text), (out_md, md_text)):
        if not path:
            continue
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
    if not skip_state and state_path:
        os.makedirs(os.path.dirname(state_path) or ".", exist_ok=True)
        with open(state_path, "w", encoding="utf-8") as f:
            f.write(json_text)

# File-output mode also exposes one machine-readable document on stdout.
if not stdout_only:
    print(json_text, end="")
PY
}

main() {
  if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    usage
  fi

  if ! command -v python3 >/dev/null 2>&1; then
    die "python3 is required"
  fi

  collect_disk || true
  collect_inodes || true
  collect_mem || true
  collect_load || true
  collect_cpu_steal || true

  # Optional sibling JSON (graceful absence); siblings may override built-ins.
  SIBLING_INODE_JSON=""
  SIBLING_CPU_JSON=""
  SIBLING_RAM_JSON=""
  SIBLING_DISK_GROWTH_JSON=""
  sib="$(try_sibling_json host-inode-report.sh)" || true
  if [[ -n "$sib" ]]; then
    SIBLING_INODE_JSON="$sib"
    v="$(merge_sibling_metric inode "$sib" used_pct 2>/dev/null || true)"
    [[ -n "$v" ]] && INODE_USED_PCT="$v" && INODE_ERR=""
  fi
  sib="$(try_sibling_json host-cpu-steal-sampler.sh)" || true
  if [[ -n "$sib" ]]; then
    SIBLING_CPU_JSON="$sib"
    v="$(merge_sibling_metric steal "$sib" steal_pct 2>/dev/null || true)"
    [[ -n "$v" ]] && CPU_STEAL_PCT="$v" && CPU_STEAL_ERR=""
  fi
  sib="$(try_sibling_json host-container-ram-report.sh)" || true
  if [[ -n "$sib" ]]; then
    SIBLING_RAM_JSON="$sib"
  fi
  sib="$(try_sibling_json host-disk-growth-snapshot.sh)" || true
  if [[ -n "$sib" ]]; then
    SIBLING_DISK_GROWTH_JSON="$sib"
    v="$(merge_sibling_metric disk "$sib" used_pct 2>/dev/null || true)"
    [[ -n "$v" ]] && DISK_USED_PCT="$v" && DISK_ERR=""
  fi

  export DISK_USED_PCT INODE_USED_PCT MEM_TOTAL_KB MEM_AVAIL_KB MEM_AVAIL_PCT
  export SWAP_USED_GB LOAD_1 LOAD_5 LOAD_15 CPU_COUNT LOAD_PER_CPU
  export CPU_STEAL_PCT CPU_STEAL_SAMPLE_SECONDS
  export DISK_ERR="${DISK_ERR:-}" INODE_ERR="${INODE_ERR:-}" MEM_ERR="${MEM_ERR:-}"
  export LOAD_ERR="${LOAD_ERR:-}" CPU_STEAL_ERR="${CPU_STEAL_ERR:-}"
  export SIBLING_INODE_JSON SIBLING_CPU_JSON SIBLING_RAM_JSON SIBLING_DISK_GROWTH_JSON
  export JSON_OUT MD_OUT STATE_PATH STDOUT_ONLY SKIP_STATE_WRITE
  export THRESH_DISK_USED_YELLOW THRESH_DISK_USED_RED
  export THRESH_INODE_USED_YELLOW THRESH_INODE_USED_RED
  export THRESH_MEM_AVAIL_PCT_YELLOW THRESH_MEM_AVAIL_PCT_RED
  export THRESH_SWAP_USED_GB_YELLOW THRESH_SWAP_USED_GB_RED
  export THRESH_LOAD_PER_CPU_YELLOW THRESH_LOAD_PER_CPU_RED
  export THRESH_CPU_STEAL_PCT_YELLOW THRESH_CPU_STEAL_PCT_RED
  export ROOT_PATH

  emit_json_and_md "$STATE_PATH"
}

main "$@"
