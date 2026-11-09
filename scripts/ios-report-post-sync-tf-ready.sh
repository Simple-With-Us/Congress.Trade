#!/usr/bin/env bash
# Re-run ensure-tf-ready after the workflow's post-upload TestFlight sync step
# and record that second verdict on the job summary.  The in-ship check still
# runs inside ship-testflight.sh; this pass sees the state after the external
# beta refresh assigns the build (OPS-1052 / BF-2552 ordering fix).
#
# Usage (from ios-ship.yml, ASC credentials already in the environment):
#   bash scripts/ios-report-post-sync-tf-ready.sh <bundleId> <buildNumber> [marketingVersion]
#
# ASCII-only (Apple bash 3.2 safe).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUNDLE_ID="${1:-}"
BUILD_NUM="${2:-}"
MARKETING="${3:-}"

if [[ -z "$BUNDLE_ID" || -z "$BUILD_NUM" ]]; then
  echo "usage: $0 <bundleId> <buildNumber> [marketingVersion]" >&2
  exit 2
fi

tf_ready_verdict_line() {
  local rc="${1:-}"
  case "$rc" in
    0) printf '%s' "TestFlight readiness: build ${BUILD_NUM} is processed; internal testers can install this build (ensure-tf-ready rc=0)." ;;
    3) printf '%s' "TestFlight readiness: upload succeeded but App Store Connect has not reached IN_BETA_TESTING yet for build ${BUILD_NUM} (ensure-tf-ready rc=3)." ;;
    4) printf '%s' "TestFlight readiness: App Store Connect never surfaced build ${BUILD_NUM} in time; export compliance was NOT declared on it (ensure-tf-ready rc=4)." ;;
    5) printf '%s' "TestFlight readiness: build ${BUILD_NUM} is processed but ${BUNDLE_ID} has no external TestFlight group with testers or a public link, so no external tester can install it yet (ensure-tf-ready rc=5).  Check the Refresh the public TestFlight beta step." ;;
    6) printf '%s' "TestFlight readiness: build ${BUILD_NUM} is processed but external installability could not be read for ${BUNDLE_ID}; installability is unverified (ensure-tf-ready rc=6)." ;;
    2) printf '%s' "TestFlight readiness: ensure-tf-ready failed with rc=2 for ${BUNDLE_ID} build ${BUILD_NUM}; export compliance may not be declared (usage or App Store Connect API error)." ;;
    *) printf '%s' "TestFlight readiness: ensure-tf-ready failed with rc=${rc} for ${BUNDLE_ID} build ${BUILD_NUM}; export compliance may not be declared." ;;
  esac
}

tf_ready_warn() {
  local rc="${1:-}"
  case "$rc" in
    5)
      echo "::warning title=TestFlight has no reachable external tester::${BUNDLE_ID} build ${BUILD_NUM} is processed but no external tester can install it.  Check the Refresh the public TestFlight beta step."
      ;;
    6)
      echo "::warning title=TestFlight installability unverified::${BUNDLE_ID} build ${BUILD_NUM} is processed but the external installability could not be read.  Check TestFlight."
      ;;
    4)
      echo "::warning::ensure-tf-ready could not find uploaded build ${BUILD_NUM} for ${BUNDLE_ID}; export compliance not declared"
      ;;
    2|*)
      echo "::warning::ensure-tf-ready failed (rc=${rc}) for ${BUNDLE_ID} build ${BUILD_NUM}; export compliance not declared"
      ;;
  esac
}

args=(ensure-tf-ready "$BUNDLE_ID" "$BUILD_NUM")
if [[ -n "$MARKETING" ]]; then
  args+=("$MARKETING")
fi

set +e
node "$ROOT/scripts/ios-fleet/asc-api.mjs" "${args[@]}" \
  >"${RUNNER_TEMP:-/tmp}/post-sync-ensure-tf-ready.json" \
  2>"${RUNNER_TEMP:-/tmp}/post-sync-ensure-tf-ready.err"
rc=$?
set -e

if [[ -s "${RUNNER_TEMP:-/tmp}/post-sync-ensure-tf-ready.err" ]]; then
  while IFS= read -r line; do
    echo "post-sync tf-ready: $line"
  done <"${RUNNER_TEMP:-/tmp}/post-sync-ensure-tf-ready.err"
fi

verdict="$(tf_ready_verdict_line "$rc")"
echo "$verdict"

if [[ "$rc" -ne 0 ]]; then
  tf_ready_warn "$rc"
fi

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "### TestFlight readiness (post-sync)"
    echo
    echo "$verdict"
    echo
    echo "ensure-tf-ready exit code: **${rc}** (second check after the external beta refresh step)."
  } >>"$GITHUB_STEP_SUMMARY"
fi

echo "tf_ready_rc=${rc}"
exit 0
