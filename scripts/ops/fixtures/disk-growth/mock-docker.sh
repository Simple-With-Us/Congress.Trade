#!/usr/bin/env bash
# Test double for docker system df -v
set -euo pipefail
FIX="${DISK_GROWTH_FIXTURE_DIR:?DISK_GROWTH_FIXTURE_DIR required}"
if [[ "${1:-}" == system && "${2:-}" == df && "${3:-}" == -v ]]; then
  cat "${FIX}/mock-docker-df-v.txt"
  exit 0
fi
echo "mock-docker: unsupported argv: $*" >&2
exit 1
