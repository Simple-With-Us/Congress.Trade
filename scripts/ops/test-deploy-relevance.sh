#!/usr/bin/env bash
# Offline tests for deploy_relevance.py (Coolify watch_paths matcher).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PY="${SCRIPT_DIR}/deploy_relevance.py"
[[ -f "$PY" ]] || { echo "missing $PY"; exit 1; }

PASS=0
FAIL=0

assert_rc() {
  local want="$1" label="$2"
  shift 2
  local rc=0
  OUT="$(python3 "$PY" "$@" 2>&1)" || rc=$?
  if [[ "$rc" -eq "$want" ]]; then
    PASS=$((PASS + 1))
    echo "ok  $label"
  else
    FAIL=$((FAIL + 1))
    echo "FAIL $label (rc=$rc want=$want)"
    echo "  $OUT"
  fi
}

assert_rc 0 "app source deploys" app/src/index.ts
assert_rc 0 "app compose deploys" app/docker-compose.yml
assert_rc 0 "app Dockerfile deploys" app/Dockerfile
assert_rc 0 "scan worker deploys" services/scan-cpu-worker/worker.py
assert_rc 0 "nested app path deploys" app/src/admin/routes.ts
assert_rc 1 "effort log skips" docs/EFFORT-LOG.md
assert_rc 1 "STATUS skips" STATUS.md
assert_rc 1 "iOS skips" clients/ios/CongressTrade/Views/TrendsView.swift
assert_rc 1 "ops script skips" scripts/ops/fleet-deploy-guard.sh
assert_rc 1 "github workflow skips" .github/workflows/ci.yml
assert_rc 1 "AGENTS.md skips" AGENTS.md
assert_rc 1 "review doc skips" docs/reviews/2026-08-19-full-app-expert-panel-review.md
assert_rc 1 "mixed docs-only skips" docs/EFFORT-LOG.md STATUS.md clients/ios/Foo.swift
assert_rc 0 "mixed with app deploys" docs/EFFORT-LOG.md app/src/index.ts
assert_rc 1 "empty stdin skips" --from-stdin <<'EOF'
EOF
assert_rc 0 "leading slash still deploys" /app/src/foo.ts
assert_rc 1 "leading slash docs skip" /docs/EFFORT-LOG.md

# stdin path list
rc=0
printf '%s\n' 'docs/EFFORT-LOG.md' 'clients/ios/A.swift' | python3 "$PY" --from-stdin >/dev/null || rc=$?
if [[ "$rc" -eq 1 ]]; then
  PASS=$((PASS + 1))
  echo "ok  stdin docs-only skips"
else
  FAIL=$((FAIL + 1))
  echo "FAIL stdin docs-only skips (rc=$rc)"
fi

echo
echo "passed=$PASS failed=$FAIL"
[[ "$FAIL" -eq 0 ]]
