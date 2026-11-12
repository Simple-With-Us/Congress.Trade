#!/usr/bin/env bash
# Offline tests for inode-usage-report.sh (df -i fixtures, exit codes, --json).
#
#   bash scripts/ops/test-inode-usage-report.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="${ROOT_DIR}/scripts/ops/inode-usage-report.sh"
FIXTURES="${ROOT_DIR}/scripts/ops/fixtures"
fail=0

assert_rc() {
  local want="$1" label="$2"
  shift 2
  local rc=0
  # shellcheck disable=SC2068
  env "$@" "$SCRIPT" >/dev/null 2>&1 || rc=$?
  if [[ "$rc" -eq "$want" ]]; then
    echo "ok   $label"
  else
    echo "FAIL $label (rc=$rc want=$want)"
    fail=1
  fi
}

assert_json_field() {
  local label="$1" expr="$2"
  shift 2
  local out rc=0
  out="$(env "$@" "$SCRIPT" --json 2>/dev/null)" || rc=$?
  if python3 -c "import json,sys; d=json.loads(sys.argv[1]); sys.exit(0 if ($expr) else 1)" "$out" 2>/dev/null; then
    echo "ok   $label"
  else
    echo "FAIL $label"
    echo "$out"
    fail=1
  fi
}

TMP="$(mktemp -d "${TMPDIR:-/tmp}/inode-report-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

bash -n "$SCRIPT"

# --- df fixtures: exit codes ---
assert_rc 0 "ok fixture exits 0" \
  INODE_REPORT_DF_FILE="$FIXTURES/inode-df-ok.txt" \
  INODE_SCAN_ROOTS="$TMP" \
  INODE_TOP_N=3

assert_rc 1 "warn fixture exits 1" \
  INODE_REPORT_DF_FILE="$FIXTURES/inode-df-warn.txt" \
  INODE_SCAN_ROOTS="$TMP" \
  INODE_WARN_PCT=80 \
  INODE_CRIT_PCT=90

assert_rc 2 "crit fixture exits 2" \
  INODE_REPORT_DF_FILE="$FIXTURES/inode-df-crit.txt" \
  INODE_SCAN_ROOTS="$TMP"

# --- skips ephemeral filesystem types ---
out="$(INODE_REPORT_DF_FILE="$FIXTURES/inode-df-ok.txt" INODE_SCAN_ROOTS="$TMP" "$SCRIPT" 2>/dev/null)" || true
if grep -q tmpfs <<<"$out" || grep -q overlay <<<"$out"; then
  echo "FAIL ephemeral types leaked into human output"
  fail=1
else
  echo "ok   tmpfs/overlay omitted from report"
fi
if ! grep -q '/data' <<<"$out"; then
  echo "FAIL expected /data mount in human output"
  fail=1
else
  echo "ok   real /data mount present"
fi

# --- JSON shape ---
assert_json_field "json status ok" 'd["status"]=="ok" and d["exit_code"]==0' \
  INODE_REPORT_DF_FILE="$FIXTURES/inode-df-ok.txt" \
  INODE_SCAN_ROOTS="$TMP"

assert_json_field "json warn" 'd["status"]=="warn" and d["exit_code"]==1' \
  INODE_REPORT_DF_FILE="$FIXTURES/inode-df-warn.txt" \
  INODE_SCAN_ROOTS="$TMP"

assert_json_field "json crit" 'd["status"]=="crit" and d["exit_code"]==2' \
  INODE_REPORT_DF_FILE="$FIXTURES/inode-df-crit.txt" \
  INODE_SCAN_ROOTS="$TMP"

json_out="$(INODE_REPORT_DF_FILE="$FIXTURES/inode-df-crit.txt" INODE_SCAN_ROOTS="$TMP" "$SCRIPT" --json 2>/dev/null)" || true
if python3 -c "import json,sys; d=json.loads(sys.argv[1]); sys.exit(0 if all(x.get('fstype')!='squashfs' for x in d['filesystems']) else 1)" "$json_out"; then
  echo "ok   squashfs omitted from json filesystems"
else
  echo "FAIL squashfs present in json"
  fail=1
fi

# --- top directory ranking (small tree) ---
scan_root="$TMP/scan"
mkdir -p "$scan_root/heavy/nested" "$scan_root/light"
: >"$scan_root/heavy/f1" "$scan_root/heavy/f2" "$scan_root/heavy/nested/f3" "$scan_root/heavy/nested/f4"
: >"$scan_root/light/l1"

json_tree="$(INODE_REPORT_DF_FILE="$FIXTURES/inode-df-ok.txt" \
  INODE_SCAN_ROOTS="$scan_root" INODE_TOP_N=2 "$SCRIPT" --json 2>/dev/null)" || true
python3 - "$json_tree" "$scan_root" <<'PY' || { echo "FAIL top directory ordering"; fail=1; }
import json, sys
d = json.loads(sys.argv[1])
root = sys.argv[2]
tops = d.get("top_directories") or []
if len(tops) < 2:
    raise SystemExit("expected at least 2 top entries")
heavy = f"{root}/heavy"
if tops[0]["path"] != heavy:
    raise SystemExit(f"want heaviest path {heavy}, got {tops[0]!r}")
if tops[0]["file_count"] < tops[1]["file_count"]:
    raise SystemExit("top list not sorted by file_count desc")
print("ok   top directory ranking")
PY

# --- systemd units present ---
for u in fleet-inode-report.service fleet-inode-report.timer; do
  f="${ROOT_DIR}/scripts/ops/systemd/$u"
  if [[ -f "$f" ]]; then
    echo "ok   $u tracked"
  else
    echo "FAIL missing $f"
    fail=1
  fi
done

echo
if [[ "$fail" -eq 0 ]]; then
  echo "all inode-usage-report offline tests passed"
  exit 0
fi
echo "inode-usage-report offline tests failed"
exit 1
