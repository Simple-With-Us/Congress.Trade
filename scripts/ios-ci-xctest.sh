#!/usr/bin/env bash
# Run CongressTradeTests on the Mac runner.  Fail (never skip) if compile or
# any XCTest case fails, or if fewer than 71 cases execute.
set -euo pipefail

PROJECT="${IOS_CI_PROJECT:-clients/ios/CongressTrade.xcodeproj}"
SCHEME="${IOS_CI_SCHEME:-CongressTrade}"
MIN_TESTS="${IOS_CI_MIN_TESTS:-71}"
RESULT="${RUNNER_TEMP:-/tmp}/CongressTrade.xcresult"
LOG="${RUNNER_TEMP:-/tmp}/xcodebuild-test.log"
DERIVED="${RUNNER_TEMP:-/tmp}/DerivedData-ct-ci"
CREATED_FILE="$(mktemp)"

cleanup() {
  if [ -s "$CREATED_FILE" ]; then
    created="$(cat "$CREATED_FILE")"
    xcrun simctl shutdown "$created" >/dev/null 2>&1 || true
    xcrun simctl delete "$created" >/dev/null 2>&1 || true
  fi
  rm -f "$CREATED_FILE"
}
trap cleanup EXIT

# Reap leftover CI sims from a prior failed run.
while IFS= read -r leftover; do
  [ -z "$leftover" ] && continue
  xcrun simctl shutdown "$leftover" >/dev/null 2>&1 || true
  xcrun simctl delete "$leftover" >/dev/null 2>&1 || true
done < <(xcrun simctl list devices | sed -n 's/.*ct-ci-xctest-[0-9]* (\([A-F0-9-]\{36\}\)).*/\1/p')

try_boot() {
  local id="$1"
  local err
  err="$(mktemp)"
  if xcrun simctl boot "$id" >"$err" 2>&1; then
    rm -f "$err"
    return 0
  fi
  if grep -q "current state: Booted" "$err"; then
    rm -f "$err"
    return 0
  fi
  echo "Skipping ${id}: $(tr '\n' ' ' <"$err")" >&2
  if grep -q "cannot be located on disk" "$err"; then
    xcrun simctl delete "$id" >/dev/null 2>&1 || true
  fi
  rm -f "$err"
  return 1
}

pick_existing() {
  local line name id
  while IFS= read -r line; do
    case "$line" in
      *"iPhone 17 Pro ("*|*"iPhone 16 Pro ("*|*"iPhone 15 Pro ("*|*"iPhone 16 ("*|*"iPhone 15 ("*|*"iPhone 14 Pro ("*|*"iPhone"*)
        name="${line%% (*}"
        name="${name#"${name%%[![:space:]]*}"}"
        id="$(printf '%s\n' "$line" | sed -n 's/.*(\([A-F0-9-]\{36\}\)).*/\1/p')"
        if [ -n "$id" ] && try_boot "$id"; then
          printf '%s\n' "$id"
          echo "Using existing ${name} id=${id}" >&2
          return 0
        fi
        ;;
    esac
  done < <(xcrun simctl list devices available)
  return 1
}

create_fresh() {
  local runtime dtype created
  runtime="$(xcrun simctl list runtimes | grep -o 'com.apple.CoreSimulator.SimRuntime.iOS-[^[:space:]]*' | head -1)"
  if [ -z "$runtime" ]; then
    echo "::error::No iOS Simulator runtime is installed. XCTest must run; do not skip." >&2
    xcrun simctl list runtimes >&2
    return 1
  fi
  for dtype in "iPhone 17 Pro" "iPhone 16 Pro" "iPhone 15 Pro" "iPhone 16" "iPhone 15" "iPhone 14 Pro" "iPhone 14"; do
    if created="$(xcrun simctl create "ct-ci-xctest-$$" "$dtype" "$runtime" 2>/dev/null)"; then
      printf '%s\n' "$created" >"$CREATED_FILE"
      if try_boot "$created"; then
        echo "Created and booted ${dtype} id=${created} runtime=${runtime}" >&2
        printf '%s\n' "$created"
        return 0
      fi
      xcrun simctl delete "$created" >/dev/null 2>&1 || true
      : >"$CREATED_FILE"
    fi
  done
  echo "::error::Could not create a bootable iPhone simulator. XCTest must run; do not skip." >&2
  xcrun simctl list devices available >&2
  xcrun simctl list runtimes >&2
  return 1
}

udid="$(pick_existing || create_fresh)" || {
  echo "::error::No bootable iPhone simulator. XCTest must run; do not skip." >&2
  exit 1
}
if ! printf '%s' "$udid" | grep -Eq '^[A-F0-9-]{36}$'; then
  echo "::error::Simulator picker returned a non-UDID: ${udid}" >&2
  exit 1
fi
echo "Using destination id=${udid}"
xcrun simctl bootstatus "$udid" -b

run_tests() {
  rm -rf "$RESULT"
  # Simulator XCTest needs a runnable TEST_HOST.  Do not pass
  # CODE_SIGNING_ALLOWED=NO here — that is only for the device compile job.
  xcodebuild test \
    -project "$PROJECT" \
    -scheme "$SCHEME" \
    -destination "platform=iOS Simulator,id=${udid}" \
    -destination-timeout 60 \
    -derivedDataPath "$DERIVED" \
    -only-testing:CongressTradeTests \
    -parallel-testing-enabled NO \
    -maximum-concurrent-test-simulator-destinations 1 \
    -resultBundlePath "$RESULT" \
    | tee "$LOG"
}

set +e
run_tests
status=$?
if [ "$status" -ne 0 ] && grep -q "Failed to clone device\|stuck in creation state" "$LOG"; then
  echo "Simulator clone/creation stuck; shutdown, boot, retry once. Tests are not skipped."
  xcrun simctl shutdown "$udid" >/dev/null 2>&1 || true
  try_boot "$udid" || true
  xcrun simctl bootstatus "$udid" -b
  run_tests
  status=$?
fi
set -e

if [ "$status" -ne 0 ]; then
  echo "::error::xcodebuild test failed (compile or XCTest)."
  exit "$status"
fi

executed="$(
  grep -E "Executed [0-9]+ tests?" "$LOG" \
    | tail -1 \
    | awk '{print $2}'
)"
executed="${executed:-0}"
if [ "$executed" -lt "$MIN_TESTS" ]; then
  echo "::error::Expected at least ${MIN_TESTS} XCTest cases in CongressTradeTests; executed ${executed}. Do not skip tests."
  exit 1
fi
echo "Executed ${executed} XCTest cases."

# Visual regression artifact: booted simulator after XCTest (WidgetKit / paywall
# changes should be reviewed from this PNG in CI artifacts).
SCREENSHOT="${RUNNER_TEMP:-/tmp}/congress-trade-ios-ci-simulator.png"
if xcrun simctl io booted screenshot "$SCREENSHOT" 2>/dev/null; then
  echo "Simulator screenshot saved to ${SCREENSHOT}"
else
  echo "::warning::Could not capture simulator screenshot (simulator may have shut down)."
fi
