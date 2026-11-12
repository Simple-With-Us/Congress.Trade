#!/usr/bin/env bash
# Offline tests for hetzner-resource-digest.sh (fixture inputs only).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="${ROOT}/scripts/ops/hetzner-resource-digest.sh"
FIXTURES="${ROOT}/scripts/ops/fixtures/hetzner-resource-digest"
TMP="$(mktemp -d)"
fail=0
mkdir -p "$TMP/empty-siblings"

cleanup() {
  rm -rf -- "${TMP}"
}
trap cleanup EXIT

assert_eq() {
  local got="$1" want="$2" name="$3"
  if [[ "$got" != "$want" ]]; then
    echo "FAIL ${name}: got '${got}' want '${want}'"
    fail=1
  else
    echo "ok   ${name}"
  fi
}

assert_json_field() {
  local json="$1" expr="$2" want="$3" name="$4"
  local got
  got="$(printf '%s' "$json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(${expr})")"
  assert_eq "$got" "$want" "$name"
}

run_digest() {
  local state="$1" json_out="$2" md_out="$3"
  HETZNER_DIGEST_SIBLING_DIR="$TMP/empty-siblings" \
    HETZNER_DIGEST_FIXTURE_ROOT="$FIXTURES" \
    HETZNER_DIGEST_STATE_PATH="$state" \
    HETZNER_DIGEST_JSON_OUT="$json_out" \
    HETZNER_DIGEST_MD_OUT="$md_out" \
    HETZNER_DIGEST_CPU_STEAL_SECONDS=0 \
    HETZNER_DIGEST_SKIP_STATE_WRITE=0 \
    bash "$SCRIPT" >"${TMP}/stdout.json"
}

chmod +x "$SCRIPT"

# Prior run for delta checks (disk was 80%, steal was 1.0).
cat >"${TMP}/prior.json" <<'EOF'
{
  "metrics": {
    "root_disk_used_pct": {"value": 80},
    "root_inode_used_pct": {"value": 45},
    "memory": {"available_pct": 40.0},
    "swap": {"used_gb": 2.0},
    "load": {"load_per_cpu_1": 0.25},
    "cpu_steal": {"steal_pct": 1.0}
  }
}
EOF

JSON_OUT="${TMP}/latest.json"
MD_OUT="${TMP}/latest.md"
run_digest "${TMP}/prior.json" "$JSON_OUT" "$MD_OUT"

if [[ ! -f "$JSON_OUT" ]]; then
  echo "FAIL json output file missing"
  exit 1
fi

DOC="$(cat "$JSON_OUT")"

assert_json_field "$DOC" "d['overall_status']" "yellow" "overall status worst-of"
assert_json_field "$DOC" "d['metrics']['root_disk_used_pct']['value']" "82.0" "disk used pct"
assert_json_field "$DOC" "d['metrics']['root_disk_used_pct']['status']" "yellow" "disk status"
assert_json_field "$DOC" "d['metrics']['root_disk_used_pct']['delta']" "2.0" "disk delta"
assert_json_field "$DOC" "d['metrics']['root_inode_used_pct']['status']" "green" "inode status"
assert_json_field "$DOC" "d['metrics']['memory']['status']" "green" "memory status"
assert_json_field "$DOC" "d['metrics']['load']['cpu_count']" "16.0" "cpu count"
assert_json_field "$DOC" "d['metrics']['cpu_steal']['status']" "yellow" "cpu steal status"
assert_json_field "$DOC" "d['siblings']['inode_report']['status']" "absent" "sibling inode absent"

if ! grep -qF '**yellow**' "$MD_OUT"; then
  echo "FAIL markdown missing overall yellow"
  fail=1
else
  echo "ok   markdown summary"
fi

# Sibling override: fake inode report replaces 47% with 91% (red).
SIB="${TMP}/siblings"
mkdir -p "$SIB"
cat >"${SIB}/host-inode-report.sh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' '{"used_pct": 91}'
EOF
chmod +x "${SIB}/host-inode-report.sh"

HETZNER_DIGEST_FIXTURE_ROOT="$FIXTURES" \
  HETZNER_DIGEST_SIBLING_DIR="$SIB" \
  HETZNER_DIGEST_STATE_PATH="${TMP}/prior.json" \
  HETZNER_DIGEST_JSON_OUT="${TMP}/with-sibling.json" \
  HETZNER_DIGEST_MD_OUT="${TMP}/with-sibling.md" \
  HETZNER_DIGEST_SKIP_STATE_WRITE=1 \
  bash "$SCRIPT" >/dev/null

DOC2="$(cat "${TMP}/with-sibling.json")"
assert_json_field "$DOC2" "d['metrics']['root_inode_used_pct']['value']" "91.0" "sibling overrides inode"
assert_json_field "$DOC2" "d['metrics']['root_inode_used_pct']['status']" "red" "sibling inode red"
assert_json_field "$DOC2" "d['siblings']['inode_report']['status']" "ok" "sibling inode ok"

if [[ "$fail" -ne 0 ]]; then
  echo "hetzner-resource-digest tests FAILED"
  exit 1
fi
python3 "$ROOT/scripts/ops/test_hetzner_digest_failures.py"
python3 "$ROOT/scripts/ops/test_hetzner_container_memory.py"
echo "hetzner-resource-digest tests passed"
