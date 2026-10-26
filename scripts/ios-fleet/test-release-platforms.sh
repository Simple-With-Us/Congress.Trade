#!/usr/bin/env bash
# test-release-platforms.sh - Offline cross-platform tests for the shared fleet
# release protocol.
#
# version-plan.test.mjs and test-ship-seq.sh cover ONE platform. This file
# covers the questions that only exist when an app has more than one native
# platform (macOS and iOS):
#
#   1. NATIVE-PATH GATING: a platform ships only when its own native tree
#      changed. The real scheduled-ship-gate.sh decides this, once per
#      platform, with one path prefix each.
#   2. PAIRED RELEASE: when both platforms ship at the same commit they are
#      one release, so both get the SAME number. The real ship-testflight.sh
#      resolves it, once per platform, and both must agree.
#   3. PLATFORM-ONLY UPDATE: the platform that did not ship keeps the release
#      it already had. Its committed project record is not rewritten.
#   4. DELAYED COMPANION BUILD: when the companion platform ships later it is
#      a later release, so its number is larger, and the partner's release is
#      untouched.
#   5. PUBLISHED-VERSION FLOORS: a published floor at or above the repository
#      commit count fails closed instead of minting a replacement number.
#
# The App Store Connect answers come from a STUB `node` in FAKE_BIN and the
# archive comes from a STUB `xcodebuild` that writes synthetic app and widget
# Info.plists. Nothing here reaches the network, Xcode, or a credential.
#
# Everything runs offline against scratch state:
#   HOME                -> scratch, so no real home files exist
#   IOS_FLEET_STATE_DIR -> scratch last-ship files
#   IOS_FLEET_APPS_JSON -> a two-platform fixture registry
#   PATH                -> a fake `xcodebuild` and a fake `node`
#
# Usage:
#   bash scripts/ios-fleet/test-release-platforms.sh
#
# Exit 0 = all pass. Exit 1 = at least one failure (details on stdout).
#
# ASCII-only (Apple bash 3.2 safe), matches ship-testflight.sh conventions.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SHIP="${SCRIPT_DIR}/ship-testflight.sh"
GATE="${SCRIPT_DIR}/scheduled-ship-gate.sh"
PLANNER="${SCRIPT_DIR}/release-platform-plan.mjs"
[[ -f "$SHIP" ]] || { echo "missing $SHIP"; exit 1; }
[[ -f "$GATE" ]] || { echo "missing $GATE"; exit 1; }
[[ -f "$PLANNER" ]] || { echo "missing $PLANNER"; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/ios-fleet-platform-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

FAKE_HOME="${WORK}/home"
FAKE_BIN="${WORK}/bin"
STATE="${WORK}/state"
REPO="${WORK}/repo"
APPS_FIXTURE="${WORK}/apps.json"
mkdir -p "$FAKE_HOME" "$FAKE_BIN" "$STATE" "$REPO" "${WORK}/tmp"

# --- the two-platform fixture registry -------------------------------------
# The shared registry keys one native platform per app key, which is how the
# fleet already models a Mac+iOS pair (autorotate / autorotate-mac and the
# contactlogo / botfleet pairs use the same shape).
cat >"$APPS_FIXTURE" <<'JSON'
{
  "teamId": "CC8UTF7ATG",
  "apps": {
    "ct-ios": {
      "displayName": "Congress.Trade iOS",
      "bundleId": "trade.congress.ios",
      "appleId": 6798076688,
      "scheme": "CongressTrade",
      "platform": "iOS",
      "projectRel": "clients/ios/CongressTrade.xcodeproj",
      "marketingVersionDefault": "1.0.0"
    },
    "ct-mac": {
      "displayName": "Congress.Trade macOS",
      "bundleId": "trade.congress.macos",
      "appleId": 6798076689,
      "scheme": "CongressTradeMac",
      "platform": "macOS",
      "projectRel": "clients/macos/CongressTradeMac.xcodeproj",
      "marketingVersionDefault": "1.0.0"
    }
  }
}
JSON

# A fake xcodebuild: answers -version, writes synthetic app and widget
# Info.plists from the exact values ship-testflight.sh passes, and creates a
# dummy IPA on export. The bundle name comes from the archive path, so the
# iOS and the macOS fixture apps get their own bundles.
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
name = archive.name[: -len(".xcarchive")] if archive.name.endswith(".xcarchive") else archive.name
app = archive / "Products" / "Applications" / f"{name}.app"
widget = app / "PlugIns" / f"{name}Widget.appex"
for target in (app, widget):
    target.mkdir(parents=True, exist_ok=True)
    with (target / "Info.plist").open("wb") as out:
        plistlib.dump({
            "CFBundleShortVersionString": os.environ["FAKE_MARKETING"],
            "CFBundleVersion": os.environ["FAKE_BUILD"],
        }, out)
PY
exit 0
FAKE
chmod +x "${FAKE_BIN}/xcodebuild"

# A stub `node`: answers the two App Store Connect version queries from the
# environment and exits 2 for anything else, which is exactly what an
# unreachable App Store Connect looks like to the ship script.
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

# A stub fleet-secrets that always reports "absent", so no test can reach the
# real Infisical.
printf '#!/usr/bin/env bash\nexit 3\n' >"${FAKE_BIN}/fleet-secrets"
chmod +x "${FAKE_BIN}/fleet-secrets"
export FLEET_SECRETS="${FAKE_BIN}/fleet-secrets"

# --- the fixture repository -------------------------------------------------
git -C "$REPO" init -q 2>/dev/null || git -C "$REPO" init >/dev/null
git -C "$REPO" config user.email test@example.invalid
git -C "$REPO" config user.name "platform test"

commit() { # commit <path> <content> <message>
  mkdir -p "$(dirname "${REPO}/$1")"
  printf '%s\n' "$2" >"${REPO}/$1"
  git -C "$REPO" add -A
  git -C "$REPO" -c commit.gpgsign=false commit -qm "$3"
  git -C "$REPO" rev-parse HEAD
}

commit_all() { # commit_all <message>
  git -C "$REPO" add -A
  git -C "$REPO" -c commit.gpgsign=false commit -qm "$1"
  git -C "$REPO" rev-parse HEAD
}

write_project() { # write_project <projectRel> <record N>
  local dir="${REPO}/$1"
  mkdir -p "$dir"
  {
    echo '/* fixture project.pbxproj */'
    echo "        CURRENT_PROJECT_VERSION = ${2};"
    echo "        MARKETING_VERSION = 1.0.${2};"
  } >"${dir}/project.pbxproj"
}

IOS_PROJECT="clients/ios/CongressTrade.xcodeproj"
MAC_PROJECT="clients/macos/CongressTradeMac.xcodeproj"

commit "README.md" "seed" "chore: seed" >/dev/null
_seed=2
while [ "$_seed" -le 8 ]; do
  commit "README.md" "seed ${_seed}" "chore: seed ${_seed}" >/dev/null
  _seed=$((_seed + 1))
done

BASE_SHA="$(git -C "$REPO" rev-parse HEAD)"
write_project "$IOS_PROJECT" 5
write_project "$MAC_PROJECT" 6
# The fixture project records are committed BEFORE the base sha is taken, so
# the first range the gate inspects holds the backend change only. A fixture
# that swept the project files into that commit would look like a native
# change to both platforms and the gate would (correctly) release both.
commit_all "chore: fixture project records" >/dev/null
BASE_SHA="$(git -C "$REPO" rev-parse HEAD)"
commit "server/api.ts" "backend" "feat(server): backend only" >/dev/null

# The App Store Connect answers the stub gives.  Unset = unreachable.
FAKE_ASC_PATCH=5
FAKE_ASC_FLOOR=5

PASS=0
FAIL=0
OUT=""
GATE_OUT=""
RC=0

run_ship() { # run_ship <app key> [args...]
  local key="$1"; shift
  OUT="$(env -i \
    HOME="$FAKE_HOME" \
    PATH="${FAKE_BIN}:/usr/bin:/bin:/usr/sbin:/sbin" \
    TMPDIR="${WORK}/tmp" \
    IOS_FLEET_STATE_DIR="$STATE" \
    IOS_FLEET_APPS_JSON="$APPS_FIXTURE" \
    FLEET_SECRETS="${FAKE_BIN}/fleet-secrets" \
    ASC_KEY_ID=fake \
    IOS_FLEET_NODE="${FAKE_BIN}/node" \
    FAKE_ASC_PATCH="$FAKE_ASC_PATCH" \
    FAKE_ASC_FLOOR="$FAKE_ASC_FLOOR" \
    bash "$SHIP" "$key" --repo-root "$REPO" "$@" 2>&1)"
  RC=$?
  return 0
}

run_gate() { # run_gate <path prefix> <app key> -> prints "key=value" lines
  GATE_OUT="$(bash "$GATE" \
    --event schedule \
    --path-prefix "$1" \
    --repo-root "$REPO" \
    --state-dir "$STATE" \
    "$2" 2>&1)"
  printf '%s\n' "$GATE_OUT"
}

gate_field() { # gate_field <output> <key>
  printf '%s\n' "$1" | awk -F= -v k="$2" '$1 == k {print $2}' | tail -1
}

set_state() { # set_state <app key> <sha>
  printf '%s %s\n' "$(date +%s)" "$2" >"${STATE}/last-ship-$1.txt"
}

ok() { PASS=$((PASS + 1)); echo "  PASS  $1"; }
bad() {
  FAIL=$((FAIL + 1))
  echo "  FAIL  $1"
  echo "        ---- ship output ----"
  printf '%s\n' "$OUT" | sed 's/^/        /'
  echo "        ---- gate output ----"
  printf '%s\n' "$GATE_OUT" | sed 's/^/        /'
  echo "        ---- end (rc=${RC}) ----"
}
check() { # check <desc> <condition-result 0/1>
  if [[ "$2" -eq 0 ]]; then ok "$1"; else bad "$1"; fi
}

planned_pair() {
  local line
  line="$(printf '%s' "$OUT" | grep -o 'marketing=[^ ]* build=[^ ]*' | head -1)"
  PLANNED_MARKETING="$(printf '%s' "$line" | sed 's/^marketing=//; s/ build=.*$//')"
  PLANNED_BUILD="$(printf '%s' "$line" | sed 's/^.* build=//')"
}

# The generated metadata of the most recent archive for an app key: prints
# "<marketing> <build>" for the app bundle and for the widget, or "none".
archive_metadata() { # archive_metadata <app key>
  local archive
  archive="$(find "${WORK}/tmp" -type d -name '*.xcarchive' -path "*ios-ship-$1-*" -print 2>/dev/null | sort | tail -1)"
  [[ -n "$archive" ]] || { printf 'none'; return 0; }
  FAKE_ARCHIVE="$archive" /usr/bin/python3 - <<'PY'
import os
import plistlib
from pathlib import Path

archive = Path(os.environ["FAKE_ARCHIVE"])
name = archive.name[: -len(".xcarchive")]
app = archive / "Products" / "Applications" / f"{name}.app"
widget = app / "PlugIns" / f"{name}Widget.appex"
parts = []
for bundle in (app, widget):
    with (bundle / "Info.plist").open("rb") as stream:
        info = plistlib.load(stream)
    parts.append(f"{info.get('CFBundleShortVersionString')} {info.get('CFBundleVersion')}")
print(" | ".join(parts))
PY
}

echo "cross-platform release protocol tests"
echo "repo=${REPO}"
echo

# --- 1. Native-path gating decides per platform -----------------------------
echo "1. native-path gating: each platform answers for its own tree"
set_state ct-ios "$BASE_SHA"
set_state ct-mac "$BASE_SHA"
out="$(run_gate "clients/ios/" ct-ios)"
check "a backend-only change does not release iOS" \
  "$([[ "$(gate_field "$out" should_ship)" == "0" ]] && echo 0 || echo 1)"
out="$(run_gate "clients/macos/" ct-mac)"
check "a backend-only change does not release macOS" \
  "$([[ "$(gate_field "$out" should_ship)" == "0" ]] && echo 0 || echo 1)"

IOS_SHA="$(commit "clients/ios/App.swift" "// ios" "fix(ios): visible change")"
out="$(run_gate "clients/ios/" ct-ios)"
check "an iOS change releases iOS" \
  "$([[ "$(gate_field "$out" should_ship)" == "1" ]] && echo 0 || echo 1)"
out="$(run_gate "clients/macos/" ct-mac)"
check "an iOS change does not release macOS" \
  "$([[ "$(gate_field "$out" should_ship)" == "0" ]] && echo 0 || echo 1)"

MAC_SHA="$(commit "clients/macos/App.swift" "// mac" "fix(macos): visible change")"
out="$(run_gate "clients/ios/" ct-ios)"
check "a macOS change still releases iOS (its own tree changed earlier)" \
  "$([[ "$(gate_field "$out" should_ship)" == "1" ]] && echo 0 || echo 1)"
out="$(run_gate "clients/macos/" ct-mac)"
check "a macOS change releases macOS" \
  "$([[ "$(gate_field "$out" should_ship)" == "1" ]] && echo 0 || echo 1)"
echo

# --- 2. A paired release gives both platforms the same number ----------------
echo "2. paired release: both platforms shipping together share one number"
COMMIT_COUNT="$(git -C "$REPO" rev-list --count HEAD)"
FAKE_ASC_PATCH=5
FAKE_ASC_FLOOR=5
run_ship ct-ios --dry-run
planned_pair
IOS_MARKETING="$PLANNED_MARKETING"
IOS_BUILD="$PLANNED_BUILD"
check "iOS resolves 1.0.N / N (got '${IOS_MARKETING}' / '${IOS_BUILD}')" \
  "$([[ "$IOS_MARKETING" == "1.0.${COMMIT_COUNT}" && "$IOS_BUILD" == "$COMMIT_COUNT" ]] && echo 0 || echo 1)"
run_ship ct-mac --dry-run
planned_pair
MAC_MARKETING="$PLANNED_MARKETING"
MAC_BUILD="$PLANNED_BUILD"
check "macOS resolves the same 1.0.N / N (got '${MAC_MARKETING}' / '${MAC_BUILD}')" \
  "$([[ "$MAC_MARKETING" == "$IOS_MARKETING" && "$MAC_BUILD" == "$IOS_BUILD" ]] && echo 0 || echo 1)"
echo

# --- 3. The generated app and widget metadata carry the pair -----------------
echo "3. generated app and widget metadata carry 1.0.N / N on both platforms"
run_ship ct-ios --export-only --allow-dirty
IOS_META="$(archive_metadata ct-ios)"
check "the iOS app and widget bundles carry 1.0.N / N (got '${IOS_META}')" \
  "$([[ "$IOS_META" == "1.0.${COMMIT_COUNT} ${COMMIT_COUNT} | 1.0.${COMMIT_COUNT} ${COMMIT_COUNT}" ]] && echo 0 || echo 1)"
run_ship ct-mac --export-only --allow-dirty
MAC_META="$(archive_metadata ct-mac)"
check "the macOS app and widget bundles carry 1.0.N / N (got '${MAC_META}')" \
  "$([[ "$MAC_META" == "1.0.${COMMIT_COUNT} ${COMMIT_COUNT} | 1.0.${COMMIT_COUNT} ${COMMIT_COUNT}" ]] && echo 0 || echo 1)"
echo

# --- 4. A platform-only update leaves the other platform alone -------------
echo "4. platform-only update: the platform that does not ship keeps its release"
# Both platforms shipped at MAC_SHA, so neither has anything native left to
# release. The next change is backend only.
set_state ct-ios "$MAC_SHA"
set_state ct-mac "$MAC_SHA"
IOS_RECORD_BEFORE="$(grep -o 'CURRENT_PROJECT_VERSION = [^;]*;' "${REPO}/${IOS_PROJECT}/project.pbxproj")"
MAC_RECORD_BEFORE="$(grep -o 'CURRENT_PROJECT_VERSION = [^;]*;' "${REPO}/${MAC_PROJECT}/project.pbxproj")"
SERVER_SHA="$(commit "server/api.ts" "backend again" "feat(server): backend only again")"
out="$(run_gate "clients/ios/" ct-ios)"
check "a backend-only change does not release iOS" \
  "$([[ "$(gate_field "$out" should_ship)" == "0" ]] && echo 0 || echo 1)"
out="$(run_gate "clients/macos/" ct-mac)"
check "a backend-only change does not release macOS" \
  "$([[ "$(gate_field "$out" should_ship)" == "0" ]] && echo 0 || echo 1)"
IOS_RECORD_AFTER="$(grep -o 'CURRENT_PROJECT_VERSION = [^;]*;' "${REPO}/${IOS_PROJECT}/project.pbxproj")"
MAC_RECORD_AFTER="$(grep -o 'CURRENT_PROJECT_VERSION = [^;]*;' "${REPO}/${MAC_PROJECT}/project.pbxproj")"
check "the iOS release record is untouched" \
  "$([[ "$IOS_RECORD_BEFORE" == "$IOS_RECORD_AFTER" ]] && echo 0 || echo 1)"
check "the macOS release record is untouched" \
  "$([[ "$MAC_RECORD_BEFORE" == "$MAC_RECORD_AFTER" ]] && echo 0 || echo 1)"
echo

# --- 5. A delayed companion build is a later release ------------------------
echo "5. delayed companion build: the later platform gets a later number"
MAC_ONLY_SHA="$(commit "clients/macos/Window.swift" "// window" "feat(macos): a macOS-only change")"
LATER_COUNT="$(git -C "$REPO" rev-list --count HEAD)"
# iOS shipped at MAC_SHA and its own tree has not changed since, so the
# macOS-only change is not an iOS release. macOS shipped at MAC_SHA too, and
# its tree has just changed.
set_state ct-ios "$MAC_SHA"
set_state ct-mac "$MAC_SHA"
out="$(run_gate "clients/ios/" ct-ios)"
check "iOS does not ship for a macOS-only change" \
  "$([[ "$(gate_field "$out" should_ship)" == "0" ]] && echo 0 || echo 1)"
set_state ct-mac "$MAC_SHA"
out="$(run_gate "clients/macos/" ct-mac)"
check "macOS ships for its own change" \
  "$([[ "$(gate_field "$out" should_ship)" == "1" ]] && echo 0 || echo 1)"
run_ship ct-mac --dry-run
planned_pair
check "the companion build is the later repository count (${LATER_COUNT} > ${COMMIT_COUNT})" \
  "$([[ "$PLANNED_BUILD" == "$LATER_COUNT" ]] && echo 0 || echo 1)"
check "the companion number is larger than the one iOS shipped with" \
  "$([[ "$PLANNED_BUILD" -gt "$IOS_BUILD" ]] && echo 0 || echo 1)"
IOS_RECORD_FINAL="$(grep -o 'CURRENT_PROJECT_VERSION = [^;]*;' "${REPO}/${IOS_PROJECT}/project.pbxproj")"
check "the partner's release record is still untouched" \
  "$([[ "$IOS_RECORD_BEFORE" == "$IOS_RECORD_FINAL" ]] && echo 0 || echo 1)"
echo

# --- 6. A published floor at the repository count fails closed ---------------
echo "6. published-version floors fail closed instead of minting a replacement"
FAKE_ASC_FLOOR="$LATER_COUNT"
run_ship ct-mac --dry-run
check "a published build floor at N refuses the ship" \
  "$([[ $RC -ne 0 ]] && echo 0 || echo 1)"
check "it says why" \
  "$([[ "$OUT" == *"refusing to mint a replacement number"* ]] && echo 0 || echo 1)"
FAKE_ASC_PATCH="$LATER_COUNT"
run_ship ct-mac --dry-run
check "a published marketing patch at N refuses the ship" \
  "$([[ $RC -ne 0 ]] && echo 0 || echo 1)"
check "it says why" \
  "$([[ "$OUT" == *"refusing a marketing regression"* ]] && echo 0 || echo 1)"
FAKE_ASC_PATCH=5
FAKE_ASC_FLOOR=5
echo

# --- 7. The shared planner agrees with what the scripts did -----------------
echo "7. the shared release planner agrees with the real scripts"
cat >"${WORK}/plan.json" <<JSON
{
  "commitCount": ${LATER_COUNT},
  "changedPaths": ["clients/macos/Window.swift"],
  "platforms": [
    {
      "key": "ct-ios",
      "platform": "IOS",
      "nativePrefixes": ["clients/ios/"],
      "published": { "marketing": "${IOS_MARKETING}", "build": "${IOS_BUILD}" }
    },
    {
      "key": "ct-mac",
      "platform": "MAC_OS",
      "nativePrefixes": ["clients/macos/"],
      "published": { "marketing": "1.0.6", "build": "6" }
    }
  ]
}
JSON
PLAN_OUT="$(node "$PLANNER" --plan "${WORK}/plan.json" 2>&1)"
PLAN_RC=$?
check "the planner reads the document" "$([[ $PLAN_RC -eq 0 ]] && echo 0 || echo 1)"
PLAN_SHIPPING="$(printf '%s' "$PLAN_OUT" | node -e '
let s = "";
process.stdin.on("data", (d) => { s += d; });
process.stdin.on("end", () => {
  const plan = JSON.parse(s);
  process.stdout.write(plan.shipping.map((entry) => entry.key + "=" + entry.marketing + "/" + entry.build).join(","));
});
')"
check "the planner releases only macOS, at the number the ship script used (got '${PLAN_SHIPPING}')" \
  "$([[ "$PLAN_SHIPPING" == "ct-mac=1.0.${LATER_COUNT}/${LATER_COUNT}" ]] && echo 0 || echo 1)"
PLAN_HOLDING="$(printf '%s' "$PLAN_OUT" | node -e '
let s = "";
process.stdin.on("data", (d) => { s += d; });
process.stdin.on("end", () => {
  const plan = JSON.parse(s);
  process.stdout.write(plan.holding.map((entry) => entry.key + "=" + entry.marketing + "/" + entry.build).join(","));
});
')"
check "the planner holds the partner at the release it already had (got '${PLAN_HOLDING}')" \
  "$([[ "$PLAN_HOLDING" == "ct-ios=${IOS_MARKETING}/${IOS_BUILD}" ]] && echo 0 || echo 1)"
echo

echo "----------------------------------------"
echo "passed: ${PASS}   failed: ${FAIL}"
[[ "$FAIL" -eq 0 ]] || exit 1
exit 0
