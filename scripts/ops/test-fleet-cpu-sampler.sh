#!/usr/bin/env bash
# Offline tests for fleet CPU sampler + history report.
#
#   bash scripts/ops/test-fleet-cpu-sampler.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SAMPLER="${ROOT_DIR}/scripts/ops/cpu-sampler.sh"
REPORT="${ROOT_DIR}/scripts/ops/cpu-history-report.sh"
FIXTURES="${ROOT_DIR}/scripts/ops/fixtures/fleet-cpu"
fail=0

assert_eq() {
  local got="$1" want="$2" name="$3"
  if [ "$got" != "$want" ]; then
    echo "FAIL ${name}: got '${got}' want '${want}'"
    fail=1
  else
    echo "ok   ${name}"
  fi
}

assert_contains() {
  local hay="$1" needle="$2" name="$3"
  if [[ "$hay" == *"$needle"* ]]; then
    echo "ok   ${name}"
  else
    echo "FAIL ${name}: missing '${needle}' in output"
    fail=1
  fi
}

TMP="$(mktemp -d "${TMPDIR:-/tmp}/fleet-cpu-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# shellcheck disable=SC1090
FLEET_CPU_LIB_ONLY=1 . "$SAMPLER"

# --- /proc/stat delta math (fixture snapshots) -------------------------------
PROC_STAT_PATH="${FIXTURES}/proc-stat-t0.txt"
PROC_STAT_STATE="$TMP/proc-stat.prev"
rm -f "$PROC_STAT_STATE"
DRY_RUN=0
compute_steal_iowait_pct
# First sample has no baseline
assert_eq "$DELTA_STEAL_PCT" "" "first proc/stat sample has no steal delta"

PROC_STAT_PATH="${FIXTURES}/proc-stat-t1.txt"
compute_steal_iowait_pct
# t0 total 102515; t1 total 205060 -> dt 102545; steal 10->50 (+40); iowait 1000->1500 (+500)
want_steal=$(awk 'BEGIN { printf "%.4f", (40/102545)*100 }')
want_iowait=$(awk 'BEGIN { printf "%.4f", (500/102545)*100 }')
assert_eq "$DELTA_STEAL_PCT" "$want_steal" "steal delta from fixtures"
assert_eq "$DELTA_IOWAIT_PCT" "$want_iowait" "iowait delta from fixtures"

# --- sample JSON line --------------------------------------------------------
LOG_DIR="$TMP/log"
STATE_DIR="$TMP/state"
SAMPLES_FILE="$LOG_DIR/samples.jsonl"
PROC_STAT_STATE="$STATE_DIR/proc-stat.prev"
LOADAVG_PATH="${FIXTURES}/loadavg.txt"
CPU_COUNT_OVERRIDE=8
DOCKER_STATS_STUB='printf "%s\n" '"'"'[{"name":"congress-app","cpu_pct":12.5}]'"'"''

rm -rf "$LOG_DIR" "$STATE_DIR"
mkdir -p "$LOG_DIR" "$STATE_DIR"

PROC_STAT_PATH="${FIXTURES}/proc-stat-t0.txt"
DRY_RUN=0
sample_once
PROC_STAT_PATH="${FIXTURES}/proc-stat-t1.txt"
sample_once

line_count="$(wc -l < "$SAMPLES_FILE" | tr -d ' ')"
assert_eq "$line_count" 2 "sampler appends two JSON lines"

last_line="$(tail -1 "$SAMPLES_FILE")"
assert_contains "$last_line" '"cpus":8' "sample records cpu count"
assert_contains "$last_line" '"congress-app"' "docker stub container name present"
assert_contains "$last_line" '"steal_pct"' "sample includes steal_pct"

# --- docker CLI present but daemon down (must not double-emit [] under pipefail)
FAKE_BIN="$TMP/fakebin"
mkdir -p "$FAKE_BIN"
printf '#!/bin/sh\nexit 1\n' >"$FAKE_BIN/docker"
chmod +x "$FAKE_BIN/docker"
LOG_DIR="$TMP/log-down"
STATE_DIR="$TMP/state-down"
SAMPLES_FILE="$LOG_DIR/samples.jsonl"
PROC_STAT_STATE="$STATE_DIR/proc-stat.prev"
LOADAVG_PATH="${FIXTURES}/loadavg.txt"
CPU_COUNT_OVERRIDE=8
unset DOCKER_STATS_STUB
rm -rf "$LOG_DIR" "$STATE_DIR"
mkdir -p "$LOG_DIR" "$STATE_DIR"
PROC_STAT_PATH="${FIXTURES}/proc-stat-t0.txt"
PATH="$FAKE_BIN:$PATH" sample_once
down_line="$(tail -1 "$SAMPLES_FILE")"
assert_contains "$down_line" '"containers":[]' "daemon-down still writes valid sample json"

# --- rotation (age + size) ---------------------------------------------------
python3 - <<PY
import json, os, time
from datetime import datetime, timezone

path = "$SAMPLES_FILE"
now = datetime.now(timezone.utc)
old = now.timestamp() - 8 * 86400
old_ts = datetime.fromtimestamp(old, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
new_ts = now.strftime("%Y-%m-%dT%H:%M:%SZ")
with open(path, "w", encoding="utf-8") as f:
    f.write(json.dumps({"ts": old_ts, "load": {"1": 0, "5": 0, "15": 0}, "cpus": 1}) + "\\n")
    big = "x" * 50000
    f.write(json.dumps({"ts": new_ts, "load": {"1": 1, "5": 1, "15": 1}, "cpus": 1, "pad": big}) + "\\n")
    f.write(json.dumps({"ts": new_ts, "load": {"1": 2, "5": 2, "15": 2}, "cpus": 1}) + "\\n")
PY

MAX_AGE_DAYS=7
MAX_BYTES=60000
rotate_samples_file "$SAMPLES_FILE"
rotated="$(wc -l < "$SAMPLES_FILE" | tr -d ' ')"
if [ "$rotated" -lt 3 ] && [ "$rotated" -ge 1 ]; then
  echo "ok   rotation dropped aged/oversize lines (lines=$rotated)"
else
  echo "FAIL rotation: unexpected line count $rotated"
  fail=1
fi

# --- history report percentiles and exit codes --------------------------------
gen_samples() {
  local path="$1"
  python3 - "$path" <<'PY'
import json, sys
from datetime import datetime, timezone, timedelta

path = sys.argv[1]
base = datetime.now(timezone.utc) - timedelta(minutes=29)
lines = []
for i in range(30):
    ts = (base + timedelta(minutes=i)).strftime("%Y-%m-%dT%H:%M:%SZ")
    steal = 15.0 if 5 <= i < 21 else 1.0
    load1 = 14.0 if 10 <= i < 26 else 2.0
    lines.append(
        {
            "ts": ts,
            "load": {"1": load1, "5": load1 * 0.8, "15": load1 * 0.6},
            "cpus": 8,
            "steal_pct": steal,
            "iowait_pct": 2.0,
        }
    )
with open(path, "w", encoding="utf-8") as f:
    for obj in lines:
        f.write(json.dumps(obj) + "\n")
PY
}

REPORT_SAMPLES="$TMP/report.jsonl"
gen_samples "$REPORT_SAMPLES"
SAMPLES_FILE="$REPORT_SAMPLES"

set +e
SAMPLES_FILE="$REPORT_SAMPLES" bash "$REPORT" 1 --json >"$TMP/report.json"
rc=$?
set -e

if [ "$rc" -eq 2 ]; then
  echo "ok   report exit 2 on sustained high steal"
else
  echo "FAIL report expected exit 2, got $rc"
  fail=1
fi

assert_contains "$(cat "$TMP/report.json")" '"sustained_high_steal": true' "report flags sustained steal"
assert_contains "$(cat "$TMP/report.json")" '"sustained_high_load": true' "report flags sustained load"

# Healthy window: low values only
gen_samples_low() {
  python3 - "$1" <<'PY'
import json, sys
from datetime import datetime, timezone, timedelta

path = sys.argv[1]
base = datetime.now(timezone.utc) - timedelta(minutes=19)
with open(path, "w", encoding="utf-8") as f:
    for i in range(20):
        ts = (base + timedelta(minutes=i)).strftime("%Y-%m-%dT%H:%M:%SZ")
        f.write(
            json.dumps(
                {
                    "ts": ts,
                    "load": {"1": 2.0, "5": 1.5, "15": 1.0},
                    "cpus": 8,
                    "steal_pct": 1.0,
                    "iowait_pct": 0.5,
                }
            )
            + "\n"
        )
PY
}
LOW_SAMPLES="$TMP/low.jsonl"
gen_samples_low "$LOW_SAMPLES"
set +e
SAMPLES_FILE="$LOW_SAMPLES" bash "$REPORT" 1 --json >/dev/null
low_rc=$?
set -e
assert_eq "$low_rc" 0 "report exit 0 when metrics are calm"

# shellcheck
bash -n "$SAMPLER" && echo "ok   bash -n cpu-sampler.sh"
bash -n "$REPORT" && echo "ok   bash -n cpu-history-report.sh"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "all tests passed"
exit 0
