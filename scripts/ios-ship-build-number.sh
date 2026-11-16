#!/usr/bin/env bash
# Print the build number (CFBundleVersion) that the fleet ship script uploaded.
#
# WHY THIS EXISTS (CT-2434):  the external TestFlight promotion must target
# the build THIS ship uploaded, not "the newest build App Store Connect knows
# about".  For the first minutes after an upload the newest one is the
# PREVIOUS ship, so a promotion that picks by recency promotes the wrong
# build -- and one that waits for recency waits for the wrong build.  The
# vendored client says this out loud in scripts/ios-fleet/asc-api.mjs
# (ensure-tf-ready):  "There is deliberately NO 'newest build' fallback: that
# fallback IS the defect."
#
# So the ship hands its build number to the promotion step.  The fleet script
# resolves the version before it uploads anything and logs it as
#
#   [ios-ship] marketing=1.0.<m> build=<b>
#
# which is the line this script reads.  The two numbers are independent
# (owner directive 2026-10-24, AFC-517):  the marketing version is the next
# patch on the train, and the build number is the checkout's commit count
# raised above the App Store Connect floor.  The fallback -- the commit count
# -- is the number the ship starts from (BUILD_NUM is "git rev-list --count
# HEAD" in scripts/ios-fleet/ship-testflight.sh), so it is right whenever the
# log line is missing; when the floor raised the build number, the log line is
# the only exact source.
#
# Usage:  ios-ship-build-number.sh <ship-log-file> [repo-root]
#
# Prints the build number on stdout.  Exits 3 when no number can be found:
# a wrong number is worse than none, because it would promote the wrong build.
set -euo pipefail

LOG="${1:?usage: ios-ship-build-number.sh <ship-log-file> [repo-root]}"
ROOT="${2:-$(cd "$(dirname "$0")/.." && pwd)}"

if [[ ! -r "$LOG" ]]; then
  echo "ios-ship-build-number: ship log not readable: ${LOG}" >&2
  exit 3
fi

n="$(sed -nE 's/^\[ios-ship\] marketing=[0-9]+\.[0-9]+\.[0-9]+ build=([0-9]+(\.[0-9]+){0,2})$/\1/p' "$LOG" | tail -n 1)"

if [[ ! "$n" =~ ^[0-9]+(\.[0-9]+){0,2}$ ]]; then
  echo "ios-ship-build-number: no build number in ${LOG}; falling back to the checkout commit count" >&2
  n="$(git -C "$ROOT" rev-list --count HEAD 2>/dev/null || true)"
fi

if [[ ! "$n" =~ ^[0-9]+(\.[0-9]+){0,2}$ ]]; then
  echo "ios-ship-build-number: could not determine the uploaded build number" >&2
  exit 3
fi

printf '%s\n' "$n"
