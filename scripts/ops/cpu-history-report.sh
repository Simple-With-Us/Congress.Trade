#!/usr/bin/env bash
# cpu-history-report — summarize fleet-cpu samples and flag sustained steal/load.
#
# Usage:
#   cpu-history-report.sh [HOURS] [--json]
#
# Exit codes:
#   0 — no sustained steal or load flags in the window
#   1 — sustained load_per_cpu > 1.5 for 15+ consecutive minutes
#   2 — sustained steal_pct > 10 for 15+ consecutive minutes (wins over 1)
#
# Env:
#   SAMPLES_FILE          default /var/log/fleet-cpu/samples.jsonl
#   SUSTAIN_MINUTES       default 15
#   LOAD_PER_CPU_THRESH   default 1.5
#   STEAL_PCT_THRESH      default 10
#   FLEET_CPU_REPORT_LIB_ONLY=1  source without running main

set -euo pipefail

SAMPLES_FILE="${SAMPLES_FILE:-/var/log/fleet-cpu/samples.jsonl}"
SUSTAIN_MINUTES="${SUSTAIN_MINUTES:-15}"
LOAD_PER_CPU_THRESH="${LOAD_PER_CPU_THRESH:-1.5}"
STEAL_PCT_THRESH="${STEAL_PCT_THRESH:-10}"
WINDOW_HOURS="${WINDOW_HOURS:-24}"
JSON_OUT=0

usage() {
  echo "Usage: $(basename "$0") [HOURS] [--json]" >&2
  exit 2
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --json) JSON_OUT=1; shift ;;
      -h|--help) usage ;;
      *)
        if [[ "$1" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
          WINDOW_HOURS="$1"
          shift
        else
          usage
        fi
        ;;
    esac
  done
}

report_python() {
  python3 - "$@" <<'PY'
import json, sys, statistics
from datetime import datetime, timezone

samples_path = sys.argv[1]
window_h = float(sys.argv[2])
sustain = int(sys.argv[3])
load_thr = float(sys.argv[4])
steal_thr = float(sys.argv[5])
json_out = sys.argv[6] == "1"

now = datetime.now(timezone.utc).timestamp()
cutoff = now - window_h * 3600

def parse_ts(ts):
    if ts.endswith("Z"):
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
    return datetime.fromisoformat(ts).timestamp()

rows = []
try:
    with open(samples_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            ts = obj.get("ts")
            if not ts:
                continue
            t = parse_ts(ts)
            if t < cutoff:
                continue
            cpus = int(obj.get("cpus") or 1) or 1
            load1 = float((obj.get("load") or {}).get("1") or 0)
            steal = obj.get("steal_pct")
            iowait = obj.get("iowait_pct")
            rows.append(
                {
                    "t": t,
                    "load_per_cpu": load1 / cpus,
                    "steal_pct": float(steal) if steal is not None else None,
                    "iowait_pct": float(iowait) if iowait is not None else None,
                }
            )
except FileNotFoundError:
    rows = []

rows.sort(key=lambda r: r["t"])

def pctile(vals, p):
    if not vals:
        return None
    vals = sorted(vals)
    if len(vals) == 1:
        return vals[0]
    k = (len(vals) - 1) * (p / 100.0)
    f = int(k)
    c = min(f + 1, len(vals) - 1)
    if f == c:
        return vals[f]
    return vals[f] + (vals[c] - vals[f]) * (k - f)

load_pc = [r["load_per_cpu"] for r in rows]
steals = [r["steal_pct"] for r in rows if r["steal_pct"] is not None]
iowaits = [r["iowait_pct"] for r in rows if r["iowait_pct"] is not None]

def max_streak(predicate):
    best = cur = 0
    for r in rows:
        if predicate(r):
            cur += 1
            best = max(best, cur)
        else:
            cur = 0
    return best

streak_load = max_streak(lambda r: r["load_per_cpu"] > load_thr)
streak_steal = max_streak(
    lambda r: r["steal_pct"] is not None and r["steal_pct"] > steal_thr
)

sustained_load = streak_load >= sustain
sustained_steal = streak_steal >= sustain

exit_code = 0
if sustained_load:
    exit_code = 1
if sustained_steal:
    exit_code = 2

summary = {
    "window_hours": window_h,
    "samples": len(rows),
    "load_per_cpu": {
        "p50": round(pctile(load_pc, 50), 4) if load_pc else None,
        "p95": round(pctile(load_pc, 95), 4) if load_pc else None,
    },
    "steal_pct": {
        "p50": round(pctile(steals, 50), 4) if steals else None,
        "p95": round(pctile(steals, 95), 4) if steals else None,
    },
    "iowait_pct": {
        "p50": round(pctile(iowaits, 50), 4) if iowaits else None,
        "p95": round(pctile(iowaits, 95), 4) if iowaits else None,
    },
    "thresholds": {
        "load_per_cpu": load_thr,
        "steal_pct": steal_thr,
        "sustain_minutes": sustain,
    },
    "flags": {
        "sustained_high_load": sustained_load,
        "sustained_high_steal": sustained_steal,
        "streak_minutes_load": streak_load,
        "streak_minutes_steal": streak_steal,
    },
    "exit_code": exit_code,
}

if json_out:
    print(json.dumps(summary, indent=2))
else:
    print(f"Window: last {window_h:g}h, samples={len(rows)}")
    l = summary["load_per_cpu"]
    print(f"load/CPU p50={l['p50']} p95={l['p95']}")
    s = summary["steal_pct"]
    print(f"steal% p50={s['p50']} p95={s['p95']}")
    io = summary["iowait_pct"]
    print(f"iowait% p50={io['p50']} p95={io['p95']}")
    f = summary["flags"]
    print(
        f"flags: sustained_high_load={f['sustained_high_load']} "
        f"(streak {f['streak_minutes_load']}m), "
        f"sustained_high_steal={f['sustained_high_steal']} "
        f"(streak {f['streak_minutes_steal']}m)"
    )
    print(f"exit_code={exit_code}")

sys.exit(exit_code)
PY
}

main() {
  parse_args "$@"
  report_python "$SAMPLES_FILE" "$WINDOW_HOURS" "$SUSTAIN_MINUTES" \
    "$LOAD_PER_CPU_THRESH" "$STEAL_PCT_THRESH" "$JSON_OUT"
}

if [[ "${FLEET_CPU_REPORT_LIB_ONLY:-}" != "1" ]]; then
  main "$@"
fi
