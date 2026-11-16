#!/usr/bin/env bash
# fleet-cpu-sampler — minute CPU/load/steal/iowait samples for the Coolify/Hetzner host
#
# Appends one JSON object per run to samples.jsonl (self-rotates: 7d or 20MiB max).
# steal/iowait come from consecutive /proc/stat aggregate deltas (no sysstat).
# Optional top-5 Docker containers by CPU when docker is present.
#
# Install (host as root):
#   install -m 0755 scripts/ops/cpu-sampler.sh /usr/local/bin/
#   install -m 0644 scripts/ops/systemd.noindex/fleet-cpu-sampler.service /etc/systemd/system/
#   install -m 0644 scripts/ops/systemd.noindex/fleet-cpu-sampler.timer /etc/systemd/system/
#   install -d -m 0755 /var/log/fleet-cpu
#   systemctl daemon-reload && systemctl enable --now fleet-cpu-sampler.timer
#
# Test (offline):
#   bash scripts/ops/test-fleet-cpu-sampler.sh
#
# Env:
#   LOG_DIR              default /var/log/fleet-cpu
#   STATE_DIR            default /var/lib/fleet-cpu-sampler
#   MAX_AGE_DAYS         default 7
#   MAX_BYTES            default 20971520 (20 MiB)
#   PROC_STAT_PATH       override for tests
#   LOADAVG_PATH         override for tests
#   FLEET_CPU_LIB_ONLY=1 source without running main

set -euo pipefail

LOG_DIR="${LOG_DIR:-/var/log/fleet-cpu}"
STATE_DIR="${STATE_DIR:-/var/lib/fleet-cpu-sampler}"
SAMPLES_FILE="${SAMPLES_FILE:-$LOG_DIR/samples.jsonl}"
PROC_STAT_STATE="${PROC_STAT_STATE:-$STATE_DIR/proc-stat.prev}"
MAX_AGE_DAYS="${MAX_AGE_DAYS:-7}"
MAX_BYTES="${MAX_BYTES:-20971520}"
LOG_TAG="${LOG_TAG:-fleet-cpu-sampler}"
PROC_STAT_PATH="${PROC_STAT_PATH:-/proc/stat}"
LOADAVG_PATH="${LOADAVG_PATH:-/proc/loadavg}"
DRY_RUN="${DRY_RUN:-0}"

log() {
  local msg="$*"
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$msg"
  if command -v logger >/dev/null 2>&1; then
    logger -t "$LOG_TAG" -- "$msg" || true
  fi
}

read_cpu_line_fields() {
  # Prints: total steal iowait (aggregate jiffies from the "cpu" line)
  local path="${1:-$PROC_STAT_PATH}"
  awk '/^cpu / {
    steal=$9; iowait=$6;
    $1=""; total=0;
    for (i=2;i<=NF;i++) total+=$i;
    printf "%s %s %s\n", total, steal, iowait;
    exit
  }' "$path"
}

cpu_count_from_proc() {
  if [[ -n "${CPU_COUNT_OVERRIDE:-}" ]]; then
    printf '%s' "$CPU_COUNT_OVERRIDE"
    return
  fi
  if command -v nproc >/dev/null 2>&1; then
    nproc --all
    return
  fi
  awk '/^processor[[:space:]]*:/ { n++ } END { print n+0 }' /proc/cpuinfo
}

read_load_triple() {
  local path="${1:-$LOADAVG_PATH}"
  awk '{ printf "%s %s %s", $1, $2, $3 }' "$path"
}

# Globals set: DELTA_STEAL_PCT DELTA_IOWAIT_PCT (empty string if no baseline)
compute_steal_iowait_pct() {
  local total steal iowait
  read -r total steal iowait < <(read_cpu_line_fields)
  local now_ts
  now_ts=$(date +%s)
  DELTA_STEAL_PCT=""
  DELTA_IOWAIT_PCT=""
  if [[ -f "$PROC_STAT_STATE" ]]; then
    # shellcheck disable=SC1090
    source "$PROC_STAT_STATE"
    local dt=$((total - prev_total))
    if [[ "$dt" -gt 0 ]]; then
      DELTA_STEAL_PCT=$(awk -v d="$dt" -v s="$((steal - prev_steal))" 'BEGIN { printf "%.4f", (s/d)*100 }')
      DELTA_IOWAIT_PCT=$(awk -v d="$dt" -v i="$((iowait - prev_iowait))" 'BEGIN { printf "%.4f", (i/d)*100 }')
    fi
  fi
  if [[ "$DRY_RUN" != "1" ]]; then
    cat >"$PROC_STAT_STATE" <<EOF
prev_total=$total
prev_steal=$steal
prev_iowait=$iowait
prev_ts=$now_ts
EOF
  fi
}

top_docker_containers_json() {
  if [[ -n "${DOCKER_STATS_STUB:-}" ]]; then
    eval "$DOCKER_STATS_STUB"
    return
  fi
  if ! command -v docker >/dev/null 2>&1; then
    printf '[]'
    return
  fi
  # docker stats can be slow; cap wait. Skip quietly if daemon down.
  local stats_out
  if ! stats_out="$(docker stats --no-stream --format '{{.Name}}	{{.CPUPerc}}' 2>/dev/null)"; then
    printf '[]'
    return
  fi
  if [[ -z "$stats_out" ]]; then
    printf '[]'
    return
  fi
  printf '%s\n' "$stats_out" | python3 -c '
import sys, re, json
rows = []
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    parts = line.split("\t", 1)
    if len(parts) != 2:
        continue
    name, cpu_s = parts
    m = re.match(r"([\d.]+)%", cpu_s.strip())
    if not m:
        continue
    rows.append((float(m.group(1)), name))
rows.sort(reverse=True)
out = [{"name": n, "cpu_pct": round(c, 2)} for c, n in rows[:5]]
print(json.dumps(out))
'
}

build_sample_json() {
  local ts load_1 load_5 load_15 cpus containers_json
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  read -r load_1 load_5 load_15 < <(read_load_triple)
  cpus="$(cpu_count_from_proc)"
  compute_steal_iowait_pct
  containers_json="$(top_docker_containers_json)"
  python3 - "$ts" "$load_1" "$load_5" "$load_15" "$cpus" "$DELTA_STEAL_PCT" "$DELTA_IOWAIT_PCT" "$containers_json" <<'PY'
import json, sys
ts, l1, l5, l15, cpus, steal, iowait, containers_json = sys.argv[1:9]
obj = {
    "ts": ts,
    "load": {"1": float(l1), "5": float(l5), "15": float(l15)},
    "cpus": int(cpus),
    "containers": json.loads(containers_json),
}
if steal:
    obj["steal_pct"] = float(steal)
else:
    obj["steal_pct"] = None
if iowait:
    obj["iowait_pct"] = float(iowait)
else:
    obj["iowait_pct"] = None
print(json.dumps(obj, separators=(",", ":")))
PY
}

rotate_samples_file() {
  local path="$1"
  [[ -f "$path" ]] || return 0
  python3 - "$path" "$MAX_AGE_DAYS" "$MAX_BYTES" <<'PY'
import json, os, sys, time
from datetime import datetime, timezone

path, max_days, max_bytes = sys.argv[1], float(sys.argv[2]), int(sys.argv[3])
cutoff = time.time() - max_days * 86400
lines = []
with open(path, "r", encoding="utf-8") as f:
    for raw in f:
        raw = raw.strip()
        if not raw:
            continue
        try:
            obj = json.loads(raw)
        except json.JSONDecodeError:
            continue
        ts = obj.get("ts")
        if not ts:
            continue
        try:
            if ts.endswith("Z"):
                t = datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
            else:
                t = datetime.fromisoformat(ts).timestamp()
        except ValueError:
            continue
        if t < cutoff:
            continue
        lines.append(raw)

while lines and sum(len(x) + 1 for x in lines) > max_bytes:
    lines.pop(0)

tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as out:
    for line in lines:
        out.write(line + "\n")
os.replace(tmp, path)
PY
}

sample_once() {
  mkdir -p "$(dirname "$SAMPLES_FILE")" "$(dirname "$PROC_STAT_STATE")"
  local line
  line="$(build_sample_json)"
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '%s\n' "$line"
    return 0
  fi
  printf '%s\n' "$line" >>"$SAMPLES_FILE"
  rotate_samples_file "$SAMPLES_FILE"
}

main() {
  mkdir -p "$LOG_DIR" "$STATE_DIR"
  sample_once
}

if [[ "${FLEET_CPU_LIB_ONLY:-}" != "1" ]]; then
  main "$@"
fi
