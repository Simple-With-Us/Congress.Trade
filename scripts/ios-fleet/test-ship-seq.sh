#!/usr/bin/env bash
# test-ship-seq.sh - Offline tests for ship-testflight.sh's version rules.
#
# Covers:
#   1. ORDERING: a run rejected by the ship gate must NOT resolve or consume
#      a version.  It used to: the gate was evaluated after the counter had
#      already been advanced, so a rate-limited attempt burned a version that
#      shipped nowhere (observed live: skipped at 4392s of a 9000s interval,
#      and the sequence still went 5 -> 6).
#   2. PROTOCOL (restored AFC-356):  marketing is 1.0.N and build is N, where
#      N is the complete repository commit count. Published values validate N
#      but never allocate a replacement.
#   3. COUNTER: the local build-seq counter is retired.  Nothing writes it and
#      nothing reads it, so a leftover from an older scheme cannot push the
#      build number above the commit count it names.
#
# The App Store Connect answers come from a STUB `node` in FAKE_BIN:  it
# answers `asc-api.mjs latest-marketing-patch` with $FAKE_ASC_PATCH and
# `asc-api.mjs build-floor` with $FAKE_ASC_FLOOR (default 0), and exits 2 for
# anything else -- which is exactly what an unreachable App Store Connect
# looks like to the ship script.  Nothing here reaches the network.
#
# Everything runs offline against scratch state:
#   HOME                -> scratch (so no real home files exist and App Store
#                          Connect is never contacted; also makes it impossible
#                          for a test to touch the real ~/.cache/ios-fleet)
#   IOS_FLEET_STATE_DIR -> scratch last-ship file
#   PATH                -> a fake `xcodebuild` that refuses to archive and a
#                          fake `node` (passed as IOS_FLEET_NODE) that
#                          answers the ASC queries
# No network, no Xcode, no credentials. Runs on macOS and Linux.
#
# Usage:
#   bash scripts/ios-fleet/test-ship-seq.sh
#
# Exit 0 = all pass. Exit 1 = at least one failure (details on stdout).
#
# ASCII-only (Apple bash 3.2 safe), matches ship-testflight.sh conventions.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SHIP="${SCRIPT_DIR}/ship-testflight.sh"
[[ -f "$SHIP" ]] || { echo "missing $SHIP"; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/ios-fleet-seq-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

FAKE_HOME="${WORK}/home"
FAKE_BIN="${WORK}/bin"
STATE="${WORK}/state"
REPO="${WORK}/repo"
FAKE_METADATA_ROOT="${WORK}/generated"
mkdir -p "$FAKE_HOME" "$FAKE_BIN" "$STATE" "$REPO" "$FAKE_METADATA_ROOT" "${WORK}/tmp"

# A fake xcodebuild: answers -version, writes synthetic app/widget Info.plists
# from the exact values passed by ship-testflight.sh, and creates a dummy IPA.
# It cannot contact Xcode, App Store Connect, or a signing service.
cat >"${FAKE_BIN}/xcodebuild" <<'FAKE'
#!/usr/bin/env bash
if [[ "${1:-}" == "-version" ]]; then
  echo "Xcode 26.0"
  echo "Build version 17A000"
  exit 0
fi
if [[ "${1:-}" == "-exportArchive" ]]; then
  export_path=""
  while [[ $# -gt 0 ]]; do
    [[ "$1" == "-exportPath" ]] && { export_path="$2"; shift 2; continue; }
    shift
  done
  [[ -n "$export_path" ]] || exit 98
  mkdir -p "$export_path"
  : >"$export_path/fake.ipa"
  exit 0
fi
archive_path="" marketing="" build=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -archivePath) archive_path="$2"; shift 2 ;;
    MARKETING_VERSION=*) marketing="${1#*=}"; shift ;;
    CURRENT_PROJECT_VERSION=*) build="${1#*=}"; shift ;;
    *) shift ;;
  esac
done
[[ -n "$archive_path" && -n "$marketing" && -n "$build" ]] || exit 97
FAKE_MARKETING="$marketing" FAKE_BUILD="$build" FAKE_ARCHIVE="$archive_path" /usr/bin/python3 - <<'PY'
import os
import plistlib
from pathlib import Path

archive = Path(os.environ["FAKE_ARCHIVE"])
products = archive / "Products" / "Applications"
app = products / "CongressTrade.app"
widget = app / "PlugIns" / "CongressWidget.appex"
for target in (app, widget):
    target.mkdir(parents=True, exist_ok=True)
    with (target / "Info.plist").open("wb") as out:
        plistlib.dump({
            "CFBundleShortVersionString": os.environ["FAKE_MARKETING"],
            "CFBundleVersion": os.environ["FAKE_BUILD"],
        }, out)
PY
printf '%s\n' "$FAKE_ARCHIVE" >"${FAKE_METADATA_ROOT}/archive-path.txt"
exit 0
FAKE
chmod +x "${FAKE_BIN}/xcodebuild"

# A stub `node`:  answers the two App Store Connect version queries from the
# environment and exits 2 for everything else.  Exiting 2 is what the ship
# script sees when App Store Connect cannot be consulted, so a test can drive
# the unreachable-App-Store-Connect path without a network.
cat >"${FAKE_BIN}/node" <<'FAKE'
#!/usr/bin/env bash
cmd=""
for a in "$@"; do
  case "$a" in
    */asc-api.mjs) cmd="asc-api" ;;
    latest-marketing-patch|build-floor)
      if [[ "$cmd" == "asc-api" ]]; then cmd="${cmd}:${a}"; fi
      ;;
  esac
done
case "$cmd" in
  asc-api:latest-marketing-patch)
    # No stubbed patch = App Store Connect cannot be consulted.
    # "auth" = App Store Connect rejected the key (asc-api exits 4).
    [[ "${FAKE_ASC_PATCH:-}" == "auth" ]] && exit 4
    [[ "${FAKE_ASC_PATCH:-}" == "unknown" ]] && exit 2
    [[ -n "${FAKE_ASC_PATCH:-}" ]] || exit 2
    printf '%s\n' "$FAKE_ASC_PATCH"
    exit 0
    ;;
  asc-api:build-floor)
    [[ "${FAKE_ASC_FLOOR:-}" == "unknown" ]] && exit 2
    printf '%s\n' "${FAKE_ASC_FLOOR:-0}"
    exit 0
    ;;
esac
exit 2
FAKE
chmod +x "${FAKE_BIN}/node"

# A stub fleet-secrets that always reports "absent", so ASC credentials stay unset and no test
# can reach the real Infisical (the script falls back to fleet-secrets on PATH).
printf '#!/usr/bin/env bash\nexit 3\n' >"${FAKE_BIN}/fleet-secrets"
chmod +x "${FAKE_BIN}/fleet-secrets"
export FLEET_SECRETS="${FAKE_BIN}/fleet-secrets"

# A tiny clean git repo so repo_head_sha() has a real, stable SHA.
git -C "$REPO" init -q 2>/dev/null || git -C "$REPO" init >/dev/null
git -C "$REPO" config user.email test@example.invalid
git -C "$REPO" config user.name "seq test"
echo seed >"${REPO}/README"
git -C "$REPO" add README
git -C "$REPO" -c commit.gpgsign=false commit -qm seed
# Seed enough commits that the repo's commit count sits ABOVE the floor these
# tests use, so the normal path is exercised:  the build number is the commit
# count and the floor guard does not fire.  With a one-commit fixture the
# floor wins and every version assertion ends up testing the guard instead of
# the scheme.
_seed=2
while [ "$_seed" -le 6 ]; do
  echo "seed $_seed" >>"${REPO}/README"
  git -C "$REPO" add README
  git -C "$REPO" -c commit.gpgsign=false commit -qm "seed $_seed"
  _seed=$((_seed + 1))
done
HEAD_SHA="$(git -C "$REPO" rev-parse HEAD)"
# Owner directive 2026-10-24 (AFC-517): the build number starts from the commit
# count.  Read the count from the fixture instead of hard-coding it, so adding
# a seed commit to the harness cannot silently stale the assertions.
COMMIT_COUNT="$(git -C "$REPO" rev-list --count HEAD)"

SEQ_FILE="${STATE}/build-seq-congress.txt"
SHIP_FILE="${STATE}/last-ship-congress.txt"

# The App Store Connect answers the stub gives.  Unset = unreachable.
FAKE_ASC_PATCH=""
FAKE_ASC_FLOOR=""

PASS=0
FAIL=0
OUT=""
RC=0

# run_ship <args...> - invoke ship-testflight.sh in the sandbox.
run_ship() {
  OUT="$(env -i \
    HOME="$FAKE_HOME" \
    PATH="${FAKE_BIN}:/usr/bin:/bin:/usr/sbin:/sbin" \
    TMPDIR="${WORK}/tmp" \
    IOS_FLEET_STATE_DIR="$STATE" \
    FLEET_SECRETS="${FAKE_BIN}/fleet-secrets" \
    ASC_KEY_ID=fake \
    IOS_FLEET_NODE="${FAKE_BIN}/node" \
    FAKE_METADATA_ROOT="$FAKE_METADATA_ROOT" \
    FAKE_ASC_PATCH="$FAKE_ASC_PATCH" \
    FAKE_ASC_FLOOR="$FAKE_ASC_FLOOR" \
    bash "$SHIP" "$@" 2>&1)"
  RC=$?
  return 0
}

ok() { PASS=$((PASS + 1)); echo "  PASS  $1"; }
bad() {
  FAIL=$((FAIL + 1))
  echo "  FAIL  $1"
  echo "        ---- output ----"
  printf '%s\n' "$OUT" | sed 's/^/        /'
  echo "        ---- end (rc=${RC}) ----"
}

check() { # check <desc> <condition-result 0/1>
  if [[ "$2" -eq 0 ]]; then ok "$1"; else bad "$1"; fi
}

seq_now() { cat "$SEQ_FILE" 2>/dev/null || echo MISSING; }
# Literal substring. grep is a bad fit here: skip lines carry a UTF-8 em-dash
# (C-locale grep then treats the stream as binary) and marketing/build
# needles contain '.' / '()'.
contains() { [[ "$OUT" == *"$1"* ]]; }

# The planned pair, read out of the "marketing=<m> build=<b>" log line.
planned_pair() {
  local line
  line="$(printf '%s' "$OUT" | grep -o 'marketing=[^ ]* build=[^ ]*' | head -1)"
  PLANNED_MARKETING="$(printf '%s' "$line" | sed 's/^marketing=//; s/ build=.*$//')"
  PLANNED_BUILD="$(printf '%s' "$line" | sed 's/^.* build=//')"
}

reset_state() {
  rm -f "$SEQ_FILE" "$SHIP_FILE"
  printf '5' >"$SEQ_FILE"
}

# The paths below are the projectRel entries in this repo's
# scripts/ios-fleet/apps.json.
project_rel() { # <app key>
  case "$1" in
    socratic)          printf '%s' 'ios/Socratic Trade.xcodeproj' ;;
    congress)          printf '%s' 'clients/ios/CongressTrade.xcodeproj' ;;
    usage|usage-local) printf '%s' 'ios/UsageMonitor/UsageMonitor.xcodeproj' ;;
    *)                 return 1 ;;
  esac
}

write_record() { # <app key> <record N>
  local rel dir
  rel="$(project_rel "$1")" || return 1
  dir="${REPO}/${rel}"
  mkdir -p "$dir"
  {
    echo '/* fixture project.pbxproj */'
    echo "        CURRENT_PROJECT_VERSION = ${2};"
    echo "        MARKETING_VERSION = 1.0.${2};"
  } >"${dir}/project.pbxproj"
}

echo "ship-testflight.sh version tests"
echo "state=${STATE}"
echo

# --- 1. Rate-limited run must not consume ----------------------------------
echo "1. ship gate: rate-limited run does not resolve a version"
reset_state
printf '%s %s\n' "$(date +%s)" "0000000000000000000000000000000000000000" >"$SHIP_FILE"
run_ship congress --repo-root "$REPO"
check "exits 0 (nothing to do)" "$([[ $RC -eq 0 ]] && echo 0 || echo 1)"
check "reports the rate-limit skip" "$(contains 'ship-gate: skip' && echo 0 || echo 1)"
check "sequence still 5 (was 5 -> 6 before the fix)" "$([[ "$(seq_now)" == "5" ]] && echo 0 || echo 1)"
check "names the override (IOS_TF_MIN_INTERVAL_SEC / --force-ship)" \
  "$(contains 'IOS_TF_MIN_INTERVAL_SEC' && contains 'force-ship' && echo 0 || echo 1)"
check "names the 3600s default and where it lives" \
  "$(contains '3600s' && contains 'DEFAULT_MIN_INTERVAL_SEC' && echo 0 || echo 1)"
check "skips the App Store Connect round trip entirely" \
  "$(contains 'version plan:' && echo 1 || echo 0)"
echo

# --- 2. Same-HEAD run must not consume -------------------------------------
echo "2. ship gate: already-shipped HEAD does not resolve a version"
reset_state
printf '%s %s\n' "1" "$HEAD_SHA" >"$SHIP_FILE"
run_ship congress --repo-root "$REPO"
check "exits 0" "$([[ $RC -eq 0 ]] && echo 0 || echo 1)"
check "reports the same-HEAD skip" "$(contains 'already shipped' && echo 0 || echo 1)"
check "sequence still 5" "$([[ "$(seq_now)" == "5" ]] && echo 0 || echo 1)"
echo

# --- 3. A run the gate allows does not advance the counter -----------------
echo "3. ship gate: an allowed run proceeds without advancing the counter"
reset_state
FAKE_ASC_PATCH=5
FAKE_ASC_FLOOR=5
run_ship congress --repo-root "$REPO"
check "proceeds past the gate" "$(contains 'no prior ship' && echo 0 || echo 1)"
check "stops at the missing project (never archives)" \
  "$(contains 'project not found' && echo 0 || echo 1)"
check "the local counter is not advanced (it is not the build number now)" \
  "$([[ "$(seq_now)" == "5" ]] && echo 0 || echo 1)"
check "the planned build number is the commit count" \
  "$(contains "build=${COMMIT_COUNT}" && echo 0 || echo 1)"
check "marketing is tied to the full repository commit count" \
  "$(contains "marketing=1.0.${COMMIT_COUNT} build=${COMMIT_COUNT}" && echo 0 || echo 1)"
echo

# --- 4. --dry-run must not consume -----------------------------------------
echo "4. --dry-run does not ship anything"
reset_state
run_ship congress --repo-root "$REPO" --dry-run
check "exits 0" "$([[ $RC -eq 0 ]] && echo 0 || echo 1)"
check "sequence still 5" "$([[ "$(seq_now)" == "5" ]] && echo 0 || echo 1)"
check "plans the build number without shipping it" \
  "$(contains "build=${COMMIT_COUNT}" && echo 0 || echo 1)"
echo

# --- 5. --dry-run reports a gated run without consuming --------------------
echo "5. --dry-run still reports the gate outcome"
reset_state
printf '%s %s\n' "$(date +%s)" "0000000000000000000000000000000000000000" >"$SHIP_FILE"
run_ship congress --repo-root "$REPO" --dry-run
check "exits 0" "$([[ $RC -eq 0 ]] && echo 0 || echo 1)"
check "says the gate would skip" "$(contains 'would SKIP' && echo 0 || echo 1)"
check "sequence still 5" "$([[ "$(seq_now)" == "5" ]] && echo 0 || echo 1)"
echo

# --- 6. --upload-only must not consume -------------------------------------
echo "6. --upload-only does not resolve a version"
reset_state
: >"${WORK}/fake.ipa"
run_ship congress --repo-root "$REPO" --upload-only "${WORK}/fake.ipa"
check "sequence still 5" "$([[ "$(seq_now)" == "5" ]] && echo 0 || echo 1)"
check "says the version comes from the IPA" \
  "$(contains 'from the existing IPA' && echo 0 || echo 1)"
echo

# --- 7. --force-ship still bypasses the gate ------------------------------
echo "7. --force-ship bypasses the gate"
reset_state
printf '%s %s\n' "$(date +%s)" "0000000000000000000000000000000000000000" >"$SHIP_FILE"
run_ship congress --repo-root "$REPO" --force-ship --dry-run
check "bypasses the gate" "$(contains 'bypassing min-interval' && echo 0 || echo 1)"
check "the local counter is still not advanced" \
  "$([[ "$(seq_now)" == "5" ]] && echo 0 || echo 1)"
echo

# --- 8. AFC-356 shared release number ------------------------------------
echo "8. AFC-356: marketing and build use the same full-history commit count"
FAKE_ASC_PATCH=5
FAKE_ASC_FLOOR=5
write_record congress 5
run_ship congress --repo-root "$REPO" --dry-run --version "1.0.${COMMIT_COUNT}" --build "$COMMIT_COUNT"
planned_pair
check "marketing is 1.0.N (got '${PLANNED_MARKETING}')" \
  "$([[ "$PLANNED_MARKETING" == "1.0.${COMMIT_COUNT}" ]] && echo 0 || echo 1)"
check "build is the same N (got '${PLANNED_BUILD}')" \
  "$([[ "$PLANNED_BUILD" == "$COMMIT_COUNT" ]] && echo 0 || echo 1)"
check "the planner logs its commit count and paired outputs" \
  "$(contains "commit_count=${COMMIT_COUNT}" && contains "resolved metadata: MARKETING_VERSION=1.0.${COMMIT_COUNT} CURRENT_PROJECT_VERSION=${COMMIT_COUNT}" && echo 0 || echo 1)"
check "canonical explicit overrides are assertions and are accepted" "$([[ $RC -eq 0 ]] && echo 0 || echo 1)"
echo

# --- 9. Fail closed on noncanonical overrides and known published floors --
echo "9. overrides and published floors cannot allocate a different number"
run_ship congress --repo-root "$REPO" --dry-run --version 1.0.148
check "148 is not treated as a requested marketing target" \
  "$(contains 'conflicts with canonical marketing version' && echo 0 || echo 1)"
run_ship congress --repo-root "$REPO" --dry-run --build 148
check "a noncanonical build override is rejected" \
  "$(contains 'conflicts with canonical build number' && echo 0 || echo 1)"
FAKE_ASC_PATCH="$COMMIT_COUNT"
run_ship congress --repo-root "$REPO" --dry-run
check "published marketing at N fails instead of regressing" \
  "$(contains 'refusing a marketing regression' && echo 0 || echo 1)"
FAKE_ASC_PATCH=5
FAKE_ASC_FLOOR="$COMMIT_COUNT"
run_ship congress --repo-root "$REPO" --dry-run
check "published build floor at N fails instead of minting a replacement" \
  "$(contains 'refusing to mint a replacement number' && echo 0 || echo 1)"
FAKE_ASC_FLOOR=5
echo

# --- 10. Unknown floors and invalid project records remain visible --------
echo "10. unknown and conflicting version records fail closed"
FAKE_ASC_PATCH=unknown
run_ship congress --repo-root "$REPO" --dry-run
check "unknown published marketing floor blocks planning" "$([[ $RC -ne 0 ]] && echo 0 || echo 1)"
FAKE_ASC_PATCH=5
FAKE_ASC_FLOOR=unknown
run_ship congress --repo-root "$REPO" --dry-run
check "unknown published build floor blocks planning" "$([[ $RC -ne 0 ]] && echo 0 || echo 1)"
FAKE_ASC_FLOOR=5
write_record congress "$COMMIT_COUNT"
run_ship congress --repo-root "$REPO" --dry-run
check "a project marketing floor at N is not silently overwritten" \
  "$(contains 'project marketing floor' && echo 0 || echo 1)"
write_record congress 5
echo

# --- 11. Missing and shallow history are not valid allocators -------------
echo "11. missing or shallow history blocks a guessed sequence"
mkdir -p "${WORK}/not-a-repository"
run_ship congress --repo-root "${WORK}/not-a-repository" --dry-run
check "missing Git history fails planning" "$([[ $RC -ne 0 ]] && echo 0 || echo 1)"
git clone -q --depth 1 "file://${REPO}" "${WORK}/shallow"
run_ship congress --repo-root "${WORK}/shallow" --dry-run
check "a shallow commit count is rejected" \
  "$(contains 'full repository history is required' && echo 0 || echo 1)"
echo

# --- 12. Actual archive metadata gets the resolved pair -------------------
echo "12. export-only archive writes app and widget metadata with the pair"
FAKE_ASC_PATCH=5
FAKE_ASC_FLOOR=5
run_ship congress --repo-root "$REPO" --export-only --allow-dirty
check "offline export-only completed with fake Xcode" "$([[ $RC -eq 0 ]] && echo 0 || echo 1)"
ARCHIVE_PATH="$(find "${WORK}/tmp" -type d -name 'CongressTrade.xcarchive' -print | tail -1)"
if [[ -n "$ARCHIVE_PATH" ]]; then
  _metadata_out="$(FAKE_ARCHIVE="$ARCHIVE_PATH" FAKE_COUNT="$COMMIT_COUNT" /usr/bin/python3 - <<'PY'
import os
import plistlib
from pathlib import Path

root = Path(os.environ["FAKE_ARCHIVE"]) / "Products/Applications/CongressTrade.app"
expected = (f"1.0.{os.environ['FAKE_COUNT']}", os.environ["FAKE_COUNT"])
for bundle in (root, root / "PlugIns/CongressWidget.appex"):
    with (bundle / "Info.plist").open("rb") as stream:
        info = plistlib.load(stream)
    actual = (info.get("CFBundleShortVersionString"), info.get("CFBundleVersion"))
    if actual != expected:
        raise SystemExit(f"{bundle}: expected {expected!r}, got {actual!r}")
PY
  2>&1)"
  _metadata_rc=$?
  [[ $_metadata_rc -eq 0 ]] || OUT="${OUT}
${_metadata_out}"
else
  _metadata_rc=1
fi
check "generated app and widget Info.plists carry 1.0.N / N" "$([[ $_metadata_rc -eq 0 ]] && echo 0 || echo 1)"
echo

# --- 13. Standing ship gate still applies before resolving a version -------
echo "13. ship gate ordering remains intact"
reset_state
printf '%s %s\n' "$(date +%s)" "0000000000000000000000000000000000000000" >"$SHIP_FILE"
run_ship congress --repo-root "$REPO" --allow-dirty
check "rate-limited run exits successfully" "$([[ $RC -eq 0 ]] && echo 0 || echo 1)"
check "rate-limited run does not query/resolve a version" "$(contains 'version plan:' && echo 1 || echo 0)"
echo

# --- 14. Rejected credentials remain fatal --------------------------------
echo "14. rejected App Store Connect credentials are fatal"
FAKE_ASC_PATCH=auth
run_ship congress --repo-root "$REPO" --dry-run
check "a rejected API key fails planning" "$([[ $RC -ne 0 ]] && echo 0 || echo 1)"
FAKE_ASC_PATCH=5

rm -f "${REPO}/$(project_rel congress)/project.pbxproj"

echo "----------------------------------------"
echo "passed: ${PASS}   failed: ${FAIL}"
[[ "$FAIL" -eq 0 ]] || exit 1
exit 0
