#!/usr/bin/env bash
# Offline tests for b2-backup-report (mocked object listings; no network).
#
#   bash scripts/ops/test-b2-backup-report.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
LIB="${ROOT_DIR}/scripts/ops/b2_backup_report.py"
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
  if printf '%s' "$hay" | grep -qF "$needle"; then
    echo "ok   ${name}"
  else
    echo "FAIL ${name}: output missing ${needle}"
    fail=1
  fi
}

TMP="$(mktemp -d "${TMPDIR:-/tmp}/b2-report-test.XXXXXX")"
FIXTURE="${TMP}/b2-fixtures"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$FIXTURE"

# Synthetic bucket names (offline only; no production bucket identifiers in git).
BUCKET_CT="fleet-test-ct-bucket"
BUCKET_ST="fleet-test-st-bucket"
BUCKET_UM="fleet-test-um-bucket"

# Fixture: fresh congress bucket; stale socratic; over-retention object on usage-monitor
NOW_MS="$(python3 - <<'PY'
import time
print(int(time.time() * 1000))
PY
)"
H30_MS="$(python3 - <<PY
import time
print(int((time.time() - 30 * 3600) * 1000))
PY
)"
OLD_MS="$(python3 - <<PY
import time
print(int((time.time() - 20 * 86400) * 1000))
PY
)"

cat >"${FIXTURE}/${BUCKET_CT}.json" <<EOF
[
  {"fileName": "hetzner/congress-trade-${NOW_MS}Z.db", "size": 1000, "uploadTimestamp": ${NOW_MS}, "action": "upload"},
  {"fileName": "hetzner/congress-trade-${NOW_MS}Z.db.sha256", "size": 64, "uploadTimestamp": ${NOW_MS}, "action": "upload"}
]
EOF

cat >"${FIXTURE}/${BUCKET_ST}.json" <<EOF
[
  {"fileName": "hetzner/socratic-app-old.db", "size": 500, "uploadTimestamp": ${H30_MS}, "action": "upload"}
]
EOF

cat >"${FIXTURE}/${BUCKET_UM}.json" <<EOF
[
  {"fileName": "hetzner/usage-monitor-20260101T000000Z.db", "size": 200, "uploadTimestamp": ${OLD_MS}, "action": "upload"},
  {"fileName": "hetzner/usage-monitor-20260101T000000Z.db", "size": 0, "uploadTimestamp": ${OLD_MS}, "action": "hide", "fileId": "hide1"}
]
EOF

run_report() {
  # shellcheck disable=SC2030,SC2031
  B2_REPORT_FIXTURE_DIR="$FIXTURE" \
  B2_REPORT_BUCKETS="congress=${BUCKET_CT},socratic=${BUCKET_ST},usage-monitor=${BUCKET_UM}" \
  B2_MAX_AGE_DAYS=14 \
  B2_REPORT_STALE_HOURS=26 \
  python3 "$LIB" "$@"
}

OUT="$(run_report --json || true)"
assert_contains "$OUT" '"status": "crit"' "stale socratic triggers crit"
assert_contains "$OUT" '"stale_prefix"' "crit includes stale_prefix flag"
assert_contains "$OUT" '"over_retention_count"' "usage-monitor old object counted"

set +e
run_report --json >/dev/null
EXIT=$?
set -e
assert_eq "$EXIT" "2" "exit code 2 on crit"

# Fix socratic freshness; keep one fresh dump per bucket but an old orphan object -> warn
cat >"${FIXTURE}/${BUCKET_ST}.json" <<EOF
[
  {"fileName": "hetzner/socratic-app-fresh.db", "size": 500, "uploadTimestamp": ${NOW_MS}, "action": "upload"}
]
EOF

cat >"${FIXTURE}/${BUCKET_UM}.json" <<EOF
[
  {"fileName": "hetzner/usage-monitor-fresh.db", "size": 200, "uploadTimestamp": ${NOW_MS}, "action": "upload"},
  {"fileName": "hetzner/usage-monitor-20260101T000000Z.db", "size": 200, "uploadTimestamp": ${OLD_MS}, "action": "upload"}
]
EOF

OUT_WARN="$(run_report --json || true)"
assert_contains "$OUT_WARN" '"status": "warn"' "over-retention alone is warn"
set +e
run_report --json >/dev/null
EXIT_WARN=$?
set -e
assert_eq "$EXIT_WARN" "1" "exit code 1 on warn"

# Byte cap warn when all fresh but total over cap
cat >"${FIXTURE}/${BUCKET_UM}.json" <<EOF
[
  {"fileName": "hetzner/usage-monitor-fresh.db", "size": 9000, "uploadTimestamp": ${NOW_MS}, "action": "upload"}
]
EOF

OUT_CAP="$(B2_REPORT_TOTAL_BYTES_CAP=5000 run_report --json || true)"
assert_contains "$OUT_CAP" '"total_bytes_over_cap": true' "byte cap flagged"
set +e
B2_REPORT_TOTAL_BYTES_CAP=5000 run_report --json >/dev/null
EXIT_CAP=$?
set -e
assert_eq "$EXIT_CAP" "1" "byte cap is warn"

# Clean report
cat >"${FIXTURE}/${BUCKET_UM}.json" <<EOF
[
  {"fileName": "hetzner/usage-monitor-fresh.db", "size": 100, "uploadTimestamp": ${NOW_MS}, "action": "upload"}
]
EOF

OUT_OK="$(run_report --json || true)"
assert_contains "$OUT_OK" '"status": "ok"' "all fresh and within retention"
set +e
run_report --json >/dev/null
EXIT_OK=$?
set -e
assert_eq "$EXIT_OK" "0" "exit code 0 on ok"

TEXT="$(run_report || true)"
assert_contains "$TEXT" "bucket congress" "text output includes bucket line"

bash -n "${ROOT_DIR}/scripts/ops/b2-backup-report.sh"

# Library self-test (age buckets + parse_fixture)
python3 - <<'PY' "$LIB"
import importlib.util, sys, json
from datetime import datetime, timezone, timedelta

path = sys.argv[1]
spec = importlib.util.spec_from_file_location("b2_backup_report", path)
mod = importlib.util.module_from_spec(spec)
sys.modules["b2_backup_report"] = mod
spec.loader.exec_module(mod)

now = datetime.now(timezone.utc)
rows = [
    {"fileName": "hetzner/a.db", "size": 1, "uploadTimestamp": int((now - timedelta(hours=2)).timestamp() * 1000), "action": "upload"},
    {"fileName": "hetzner/b.db", "size": 1, "uploadTimestamp": int((now - timedelta(days=3)).timestamp() * 1000), "action": "upload"},
    {"fileName": "hetzner/c.db", "size": 1, "uploadTimestamp": int((now - timedelta(days=10)).timestamp() * 1000), "action": "upload"},
    {"fileName": "hetzner/d.db", "size": 1, "uploadTimestamp": int((now - timedelta(days=40)).timestamp() * 1000), "action": "upload"},
]
objs = mod.b2_rows_to_objects("b", "lbl", rows, prefix="hetzner/")
cfg = mod.ReportConfig(
    bucket_map={"lbl": "b"},
    object_prefix="hetzner/",
    stale_hours=26,
    max_age_days=14,
    keep_daily=3,
    keep_weekly=2,
    total_bytes_cap=None,
    now=now,
)
rep = mod.build_report(cfg, objs)
assert rep["by_age"]["lt_1d"]["count"] == 1
assert rep["by_age"]["d1_7"]["count"] == 1
assert rep["by_age"]["d7_30"]["count"] == 1
assert rep["by_age"]["gt_30d"]["count"] == 1
print("ok   python age-bucket unit checks")
PY

if [ "$fail" -ne 0 ]; then
  echo "b2-backup-report tests FAILED"
  exit 1
fi
echo "b2-backup-report tests passed"
