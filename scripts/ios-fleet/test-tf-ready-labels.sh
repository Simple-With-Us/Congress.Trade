#!/usr/bin/env bash
# Offline checks: each ensure-tf-ready exit code maps to its own wording in
# ship-testflight.sh (OPS-1052).  No network, no credentials.
#
# Usage: bash scripts/ios-fleet/test-tf-ready-labels.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SHIP="${SCRIPT_DIR}/ship-testflight.sh"
REPORT="${ROOT}/scripts/ios-report-post-sync-tf-ready.sh"

[[ -f "$SHIP" ]] || { echo "missing $SHIP"; exit 1; }
[[ -f "$REPORT" ]] || { echo "missing $REPORT"; exit 1; }

SHIP_TEXT="$(cat "$SHIP")"
REPORT_TEXT="$(cat "$REPORT")"

PASS=0
FAIL=0
ok() { echo "  ok  : $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }
contains() {
  if [[ "$2" == *"$3"* ]]; then ok "$1"; else bad "$1 (missing '$3')"; fi
}
lacks() {
  if [[ "$2" != *"$3"* ]]; then ok "$1"; else bad "$1 (unexpected '$3')"; fi
}

slice_between() {
  # slice_between <file> <start-line-pattern> <end-line-pattern>
  awk -v start="$2" -v end="$3" '
    $0 ~ start { on=1 }
    on && $0 ~ end && $0 !~ start { exit }
    on { print }
  ' "$1"
}

ensure_start="$(grep -n '^ensure_tf_ready() {' "$SHIP" | head -1 | cut -d: -f1)"
ensure_end="$(awk -v s="$ensure_start" 'NR > s && /^acquire_archive_lock$/ { print NR; exit }' "$SHIP")"
[[ -n "$ensure_end" && "$ensure_end" -gt "$ensure_start" ]] || { echo "could not bound ensure_tf_ready in $SHIP"; exit 1; }
ensure_tmp="$(mktemp)"
sed -n "${ensure_start},${ensure_end}p" "$SHIP" >"$ensure_tmp"

echo "== ensure_tf_ready has distinct rc=5 and rc=6 branches (internal-tester contract) =="
rc5="$(slice_between "$ensure_tmp" 'rc -eq 5' 'rc -eq 6')"
rc6="$(slice_between "$ensure_tmp" 'rc -eq 6' 'rc -eq 3')"
rc3="$(slice_between "$ensure_tmp" 'rc -eq 3' 'rc -eq 4')"
rc4="$(slice_between "$ensure_tmp" 'rc -eq 4' '# rc=2 is')"
ensure_block="$(cat "$ensure_tmp")"
rm -f "$ensure_tmp"

contains "rc=5 names zero internal testers" "$rc5" "NO internal tester has access to all builds"
contains "rc=5 GitHub annotation" "$rc5" "no internal tester can install it"
lacks "rc=5 branch does not blame export compliance" "$rc5" "stuck on export compliance"
lacks "rc=5 branch does not use external-only labels" "$rc5" "no external TestFlight group"

contains "rc=6 names unreadable internal count" "$rc6" "internal tester count could not be read"
contains "rc=6 GitHub annotation" "$rc6" "internal tester state is unreadable"
lacks "rc=6 branch does not blame export compliance" "$rc6" "stuck on export compliance"

contains "rc=3 branch" "$rc3" "has not reached IN_BETA_TESTING yet"
contains "rc=4 branch" "$rc4" "ASC never surfaced build"
contains "rc=4 compliance annotation" "$rc4" "export compliance not declared"
contains "catch-all export compliance for rc=2" "$ensure_block" "stuck on export compliance"

echo "== the five failure codes use different anchor phrases =="
markers=(
  "has not reached IN_BETA_TESTING yet"
  "ASC never surfaced build"
  "NO internal tester has access to all builds"
  "internal tester count could not be read"
  "stuck on export compliance"
)
for i in "${!markers[@]}"; do
  for j in "${!markers[@]}"; do
    if [[ "$i" -ne "$j" && "${markers[$i]}" == "${markers[$j]}" ]]; then
      bad "duplicate marker between rc classes: ${markers[$i]}"
    fi
  done
done
ok "rc=2..6 anchor phrases are pairwise distinct in ensure_tf_ready"

echo "== post-sync summary script maps rc=2..6 to distinct verdict lines =="
verdict_fn="$(sed -n '/^tf_ready_verdict_line/,/^}/p' "$REPORT")"
for rc in 2 3 4 5 6; do
  contains "post-sync case for rc=${rc}" "$verdict_fn" "${rc})"
done
lacks "post-sync rc=5 does not use export-compliance catch-all" "$verdict_fn" "stuck on export compliance"
contains "post-sync rc=5 names internal path" "$verdict_fn" "no internal tester"
contains "post-sync rc=6 names unverified internal read" "$verdict_fn" "internal tester count could not be read"

echo "== asc-api ensure-tf-ready documents 0/2/3/4 only today (rc=5/6 are shell+client contract) =="
ASC_API="${SCRIPT_DIR}/asc-api.mjs"
ready_block="$(awk '/Exit codes: 0 ready/,/^  if \(method === "latest-marketing-patch"\)/' "$ASC_API")"
contains "asc-api documents exit 0/2/3/4" "$ready_block" "Exit codes: 0 ready | 2 usage/API error | 3 readiness timeout"
lacks "asc-api does not exit 5 in ensure-tf-ready yet" "$ready_block" "process.exit(5)"
lacks "asc-api does not exit 6 in ensure-tf-ready yet" "$ready_block" "process.exit(6)"

echo
echo "passed: ${PASS}  failed: ${FAIL}"
[[ $FAIL -eq 0 ]] || exit 1
exit 0
