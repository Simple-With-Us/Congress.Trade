#!/usr/bin/env bash
# Offline tests for seed-last-ship.sh. A stub gh serves fixtures. No network,
# no token, no ship.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SEED="${SCRIPT_DIR}/seed-last-ship.sh"
[[ -f "$SEED" ]] || { echo "missing $SEED"; exit 1; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/seed-last-ship.XXXXXX")"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

SHA_A="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
SHA_B="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
UNIX_A="$(node -e 'process.stdout.write(String(Math.floor(Date.parse("2026-11-01T12:00:00Z")/1000)))')"
UNIX_B="$(node -e 'process.stdout.write(String(Math.floor(Date.parse("2026-11-02T12:10:00Z")/1000)))')"

PASS=0
FAIL=0
check() {
  if [[ "$2" == "$3" ]]; then
    echo "  ok  : $1"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $1 (expected '$2', got '$3')"
    FAIL=$((FAIL + 1))
  fi
}

cat >"${TMP}/gh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${GH_LOG:?}"
if [[ "$1" == "run" ]]; then
  cat "${FIXTURE_LIST:?}"
  exit 0
fi
if [[ "$1" == "api" ]]; then
  url="$2"
  case "$url" in
    */workflows/ios-ship.yml/runs*)
      cat "${FIXTURE_PAGE:?}"
      ;;
    */runs/*/jobs*)
      id="${url#*/runs/}"
      id="${id%%/*}"
      cat "${FIXTURE_DIR:?}/jobs-${id}.json"
      ;;
    *)
      echo "unexpected api ${url}" >&2
      exit 1
      ;;
  esac
  exit 0
fi
echo "unexpected gh $*" >&2
exit 1
STUB
chmod 755 "${TMP}/gh"

write_jobs() {
  # write_jobs <id> <conclusion> <seconds>
  local id="$1" conclusion="$2" seconds="$3"
  local end=$((12 * 3600 + seconds))
  local end_h=$((end / 3600))
  local end_m=$(((end % 3600) / 60))
  local end_s=$((end % 60))
  printf '{"jobs":[{"steps":[{"name":"Ship CongressTrade to TestFlight","conclusion":"%s","started_at":"2026-11-02T12:00:00Z","completed_at":"2026-11-02T%02d:%02d:%02dZ"}]}]}\n' \
    "$conclusion" "$end_h" "$end_m" "$end_s" >"${TMP}/jobs-${id}.json"
}

run_seed() {
  SEED_LAST_SHIP_GH="${TMP}/gh" \
  GH_LOG="${TMP}/gh.log" \
  FIXTURE_DIR="${TMP}" \
  FIXTURE_LIST="${TMP}/list.json" \
  FIXTURE_PAGE="${TMP}/page.json" \
  IOS_FLEET_STATE_DIR="${TMP}/state" \
  GITHUB_REPOSITORY="Simple-With-Us/Congress.Trade" \
  bash "$SEED" "$@"
}

rm -rf "${TMP}/state"
: >"${TMP}/gh.log"
printf '[{"updatedAt":"2026-11-01T12:00:00.999Z","headSha":"%s"}]\n' "$SHA_A" >"${TMP}/list.json"
out="$(run_seed --workflow ios-appstore-gm.yml --app congress --state-dir "${TMP}/state")"
check "gm mode seeds the newest success" "Seeded last ship: ${SHA_A:0:10}" "$out"
check "gm mode state file" "${UNIX_A} ${SHA_A}" "$(cat "${TMP}/state/last-ship-congress.txt")"

rm -rf "${TMP}/state"
: >"${TMP}/gh.log"
printf '[]\n' >"${TMP}/list.json"
out="$(run_seed --workflow ios-appstore-gm.yml --app congress --state-dir "${TMP}/state")"
status=0
check "empty history says first ship" "No previous successful run; the ship gate treats this as a first ship." "$out"
check "empty history writes no file" "missing" "$([[ -f ${TMP}/state/last-ship-congress.txt ]] && echo present || echo missing)"

rm -rf "${TMP}/state"
: >"${TMP}/gh.log"
cat >"${TMP}/page.json" <<EOF
{"workflow_runs":[
  {"id":1,"head_sha":"${SHA_A}","run_started_at":"2026-11-03T12:00:00Z","updated_at":"2026-11-03T12:00:09Z"},
  {"id":2,"head_sha":"${SHA_B}","run_started_at":"2026-11-02T12:00:00Z","updated_at":"2026-11-02T12:10:00Z"}
]}
EOF
write_jobs 2 success 480
out="$(run_seed --workflow ios-ship.yml --app congress --require-upload --ship-step "Ship CongressTrade to TestFlight" --state-dir "${TMP}/state")"
check "upload seed ignores the short skip" "Seeded last ship: ${SHA_B:0:10}" "$out"
check "upload seed state file" "${UNIX_B} ${SHA_B}" "$(cat "${TMP}/state/last-ship-congress.txt")"
if grep -q '/runs/1/jobs' "${TMP}/gh.log"; then
  check "short skip does not fetch jobs" "absent" "present"
else
  check "short skip does not fetch jobs" "absent" "absent"
fi

rm -rf "${TMP}/state"
: >"${TMP}/gh.log"
cat >"${TMP}/page.json" <<EOF
{"workflow_runs":[
  {"id":3,"head_sha":"${SHA_A}","run_started_at":"2026-11-02T12:00:00Z","updated_at":"2026-11-02T12:10:00Z"}
]}
EOF
write_jobs 3 skipped 480
out="$(run_seed --workflow ios-ship.yml --app congress --require-upload --ship-step "Ship CongressTrade to TestFlight" --state-dir "${TMP}/state")"
check "skipped ship step does not seed" "No previous successful upload; not seeding." "$out"
check "skipped ship step writes no file" "missing" "$([[ -f ${TMP}/state/last-ship-congress.txt ]] && echo present || echo missing)"

rm -rf "${TMP}/state"
: >"${TMP}/gh.log"
write_jobs 3 success 5
out="$(run_seed --workflow ios-ship.yml --app congress --require-upload --ship-step "Ship CongressTrade to TestFlight" --state-dir "${TMP}/state")"
check "rate-gate skip does not seed" "No previous successful upload; not seeding." "$out"

set +e
run_seed --workflow '../etc/passwd' --app congress --state-dir "${TMP}/state" >/dev/null 2>"${TMP}/err"
status=$?
set -e
check "bad workflow name is rejected" "2" "$status"

echo
echo "${PASS} passed, ${FAIL} failed"
[[ "$FAIL" -eq 0 ]]
