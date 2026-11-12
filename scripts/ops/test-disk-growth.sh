#!/usr/bin/env bash
# Offline tests for disk-growth-snapshot.sh + disk-growth-report.sh
#
#   bash scripts/ops/test-disk-growth.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
FIXTURE_DIR="${ROOT_DIR}/scripts/ops/fixtures/disk-growth"
SNAPSHOT_SH="${ROOT_DIR}/scripts/ops/disk-growth-snapshot.sh"
REPORT_SH="${ROOT_DIR}/scripts/ops/disk-growth-report.sh"
LIB="${ROOT_DIR}/scripts/ops/disk-growth-lib.sh"
fail=0

assert_ok() {
  local name="$1"
  echo "ok   ${name}"
}

assert_fail() {
  local name="$1" detail="${2:-}"
  echo "FAIL ${name}${detail:+: ${detail}}"
  fail=1
}

TMP="$(mktemp -d "${TMPDIR:-/tmp}/disk-growth-test.XXXXXX")"
FIX_ROOT="${TMP}/root"
SNAP_DIR="${TMP}/snapshots"
mkdir -p "${FIX_ROOT}/var/large" "${FIX_ROOT}/data/backups" "${SNAP_DIR}"
truncate -s 2M "${FIX_ROOT}/var/large/blob.bin"
truncate -s 500K "${FIX_ROOT}/data/backups/day.sql"

trap 'rm -rf "$TMP"' EXIT

chmod +x "${FIXTURE_DIR}/mock-"*.sh

export DISK_GROWTH_FIXTURE_DIR="$FIXTURE_DIR"
export DISK_GROWTH_FIXTURE_ROOT="$FIX_ROOT"
export SNAPSHOT_DIR="$SNAP_DIR"
export RETENTION_DAYS=2
export TOP_N=5
export DU_TIMEOUT_SEC=30
export DU_SCAN_ROOTS="${FIX_ROOT}/var,${FIX_ROOT}/data"
export BACKUP_SCAN_DIRS="${FIX_ROOT}/data/backups"
export DISK_GROWTH_DF="${FIXTURE_DIR}/mock-df.sh"
export DISK_GROWTH_DOCKER="${FIXTURE_DIR}/mock-docker.sh"
export DISK_GROWTH_FINDMNT="${FIXTURE_DIR}/mock-findmnt.sh"
export DISK_GROWTH_TIMEOUT="${FIXTURE_DIR}/mock-pass-through.sh"
export DISK_GROWTH_IONICE="${FIXTURE_DIR}/mock-pass-through.sh"
export DISK_GROWTH_NICE="${FIXTURE_DIR}/mock-pass-through.sh"

# shellcheck disable=SC1091
source "$LIB"

if disk_growth_is_snapshot_file "${SNAP_DIR}/disk-growth-2026-01-01.json"; then
  assert_ok "snapshot filename guard accepts canonical name"
else
  assert_fail "snapshot filename guard"
fi
if disk_growth_is_snapshot_file "${SNAP_DIR}/other.json"; then
  assert_fail "snapshot filename guard rejects foreign files"
else
  assert_ok "snapshot filename guard rejects foreign files"
fi

SNAPSHOT_DATE="2026-06-01" DISK_GROWTH_FORCE=1 bash "$SNAPSHOT_SH" >/dev/null
out="${SNAP_DIR}/disk-growth-2026-06-01.json"
if [[ -f "$out" ]]; then
  assert_ok "snapshot script writes JSON"
else
  assert_fail "snapshot script write"
fi

if ! python3 - "$out" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
assert doc["schema_version"] == 1
assert doc["filesystems"], "expected filesystem rows"
assert doc["directory_totals"], "expected directory totals"
assert doc["docker"].get("available") is True
assert doc["docker"].get("sections"), "expected docker sections"
assert "Images" in doc["docker"]["sections"], "docker parser should retain Images block"
PY
then
  assert_fail "snapshot JSON shape"
else
  assert_ok "snapshot JSON shape"
fi

# Retention deletes only our snapshot files beyond RETENTION_DAYS.
for d in 2026-05-30 2026-05-31; do
  cp "$out" "${SNAP_DIR}/disk-growth-${d}.json"
done
touch -d '2026-06-02' "${SNAP_DIR}/disk-growth-2026-06-01.json"
touch -d '2026-05-31' "${SNAP_DIR}/disk-growth-2026-05-31.json"
touch -d '2026-05-30' "${SNAP_DIR}/disk-growth-2026-05-30.json"
printf 'foreign\n' >"${SNAP_DIR}/unrelated.txt"
disk_growth_prune_old_snapshots
if [[ -f "${SNAP_DIR}/disk-growth-2026-05-30.json" ]]; then
  assert_fail "retention should drop oldest snapshot"
else
  assert_ok "retention drops oldest snapshot"
fi
if [[ -f "${SNAP_DIR}/unrelated.txt" ]]; then
  assert_ok "retention leaves non-snapshot files"
else
  assert_fail "retention touched foreign file"
fi

python3 - "$SNAP_DIR" <<'PY'
import json, pathlib, sys
snap = pathlib.Path(sys.argv[1])

def write_day(day, used_kb, dir_bytes):
    doc = {
        "schema_version": 1,
        "captured_at": f"{day}T00:00:00Z",
        "date": day,
        "host": "test",
        "filesystems": [{"mount": "/", "size_kb": 100000, "used_kb": used_kb, "avail_kb": 100000 - used_kb, "use_pct": "50", "inodes": None}],
        "directory_totals": {"/var": {"entries": [{"path": "/var/lib", "size_bytes": dir_bytes}], "timeout": False}},
        "docker": {"available": True, "summary": {"Images": {"size_bytes_sum": dir_bytes}}},
    }
    (snap / f"disk-growth-{day}.json").write_text(json.dumps(doc))

write_day("2026-07-01", 50000, 1_000_000)
write_day("2026-06-30", 48000, 900_000)
write_day("2026-06-24", 40000, 700_000)
PY

report_json="$(REPORT_DATE=2026-07-01 SNAPSHOT_DIR="$SNAP_DIR" bash "$REPORT_SH" --json)"
if ! REPORT_JSON="$report_json" python3 <<'PY'
import json, os
r = json.loads(os.environ["REPORT_JSON"])
g1 = r["directories"]["1d"]
assert g1["available"] and g1["growers"]
path, delta = g1["growers"][0]
assert path == "/var/lib" and delta == 100_000
fs = r["filesystems"]["1d"]
assert fs["used_kb_growers"][0][1] == 2000
PY
then
  assert_fail "report deltas"
else
  assert_ok "report computes 1d directory and fs deltas"
fi

if [[ "$fail" -eq 0 ]]; then
  echo "All disk-growth tests passed."
else
  echo "Disk-growth tests failed."
  exit 1
fi
