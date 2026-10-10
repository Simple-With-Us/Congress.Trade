#!/usr/bin/env bash
# Capture App Store screenshots on a macOS runner.  Generates a throwaway UI test
# target at runtime (project-shots.yml); nothing here touches the committed
# Xcode project.  Output PNGs land in $SHOT_OUT (default ./shots-out).
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
OUT="${SHOT_OUT:-$ROOT/shots-out}"
SRC="scripts/ios-screenshots"
IOS="clients/ios"
DERIVED="${RUNNER_TEMP:-/tmp}/DerivedData-ct-shots"
mkdir -p "$OUT" "$IOS/ShotsUITests"
FAIL=0

cp "$SRC/ScreenshotUITests.swift" "$SRC/Shots.storekit" "$IOS/ShotsUITests/"
cp "$SRC/project-shots.yml" "$IOS/project-shots.yml"

XCODEGEN="$(command -v xcodegen || true)"
if [ -z "$XCODEGEN" ]; then
  NONINTERACTIVE=1 HOMEBREW_NO_AUTO_UPDATE=1 brew install xcodegen
  XCODEGEN="$(command -v xcodegen)"
fi
(cd "$IOS" && "$XCODEGEN" generate --spec project-shots.yml) || { echo "xcodegen failed"; exit 1; }

xcodebuild build-for-testing \
  -project "$IOS/CongressTrade.xcodeproj" \
  -scheme CongressTradeShots \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$DERIVED" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO 2>&1 | tail -40
[ "${PIPESTATUS[0]}" -eq 0 ] || { echo "build-for-testing failed"; exit 1; }

xcrun simctl list devices available | sed -n 1,80p

# label|device name prefix
DEVICES="${SHOT_DEVICES:-phone63|iPhone 17 Pro
phone69|iPhone 17 Pro Max
ipad13|iPad Pro 13-inch}"

pick_udid() {
  xcrun simctl list devices available -j | python3 -c '
import json, sys
prefix = sys.argv[1]
data = json.load(sys.stdin)["devices"]
best = None
for runtime in sorted(data):
    for d in data[runtime]:
        name = d["name"]
        if name == prefix or name.startswith(prefix + " ("):
            best = d["udid"]
print(best or "")
' "$1"
}

while IFS='|' read -r LABEL NAME; do
  [ -z "$LABEL" ] && continue
  UDID="$(pick_udid "$NAME")"
  if [ -z "$UDID" ]; then
    echo "::warning::no simulator named '$NAME' for $LABEL (skipped)"
    continue
  fi
  echo "=== $LABEL: $NAME ($UDID)"
  xcrun simctl boot "$UDID" 2>/dev/null || true
  xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1 || true
  xcrun simctl status_bar "$UDID" override --time 9:41 --batteryState charged --batteryLevel 100 --cellularMode active --cellularBars 4 --wifiBars 3 || true
  TEST_RUNNER_SHOT_DIR="$OUT" TEST_RUNNER_SHOT_PREFIX="$LABEL" \
    xcodebuild test-without-building \
      -project "$IOS/CongressTrade.xcodeproj" \
      -scheme CongressTradeShots \
      -destination "platform=iOS Simulator,id=$UDID" \
      -derivedDataPath "$DERIVED" \
      -resultBundlePath "$OUT/$LABEL.xcresult" \
      CODE_SIGNING_ALLOWED=NO 2>&1 | tail -60
  [ "${PIPESTATUS[0]}" -eq 0 ] || FAIL=1
  xcrun simctl shutdown "$UDID" 2>/dev/null || true
done <<< "$DEVICES"

echo "=== output"
for f in "$OUT"/*.png; do
  [ -f "$f" ] || continue
  echo "$(basename "$f") $(sips -g pixelWidth -g pixelHeight "$f" | awk '/pixel/{printf "%s ", $2}')"
done
# A missing device is only a warning; fail when a test failed or nothing was captured.
ls "$OUT"/*.png >/dev/null 2>&1 || FAIL=1
exit "$FAIL"
