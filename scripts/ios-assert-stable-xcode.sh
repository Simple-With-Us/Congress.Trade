#!/usr/bin/env bash
# Assert the active Xcode toolchain is not a beta (App Store INVALID_BINARY risk).
# Used by GitHub-hosted ios-build / ios-ship jobs.  Mirrors the guard in
# scripts/ios-ship-testflight.sh without mutating DEVELOPER_DIR.
set -euo pipefail

dev_dir="${DEVELOPER_DIR:-$(xcode-select -p 2>/dev/null || true)}"
if [[ -z "$dev_dir" ]]; then
  echo "::error::Could not resolve DEVELOPER_DIR or xcode-select -p"
  exit 1
fi

is_beta_toolchain() {
  local dir="$1"
  [[ "$dir" == *Xcode-beta* ]] && return 0
  local plist="${dir%/Contents/Developer}/Contents/Info.plist"
  if [[ -r "$plist" ]]; then
    local bundle_ver
    bundle_ver="$(defaults read "$plist" CFBundleShortVersionString 2>/dev/null || true)"
    [[ "$bundle_ver" == *[Bb]eta* ]] && return 0
  fi
  return 1
}

echo "DEVELOPER_DIR=${dev_dir}"
xcodebuild -version
ver="$(xcodebuild -version | awk 'NR==1{print $2}')"
echo "Xcode version: ${ver}"

if is_beta_toolchain "$dev_dir"; then
  echo "::error::Refusing beta Xcode toolchain at ${dev_dir}"
  exit 1
fi

if [[ "$ver" == *[Bb]eta* ]]; then
  echo "::error::xcodebuild reports a beta toolchain: ${ver}"
  exit 1
fi
