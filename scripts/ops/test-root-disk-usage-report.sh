#!/usr/bin/env bash
# Offline tests for root-disk-usage-report (temp-dir fixture tree; no live host).
#
#   bash scripts/ops/test-root-disk-usage-report.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
fail=0

if ! python3 -m py_compile "${ROOT}/scripts/ops/root-disk-usage-report.py"; then
  echo "FAIL py_compile root-disk-usage-report.py"
  exit 1
fi

if ! bash -n "${ROOT}/scripts/ops/root-disk-usage-report.sh"; then
  echo "FAIL bash -n root-disk-usage-report.sh"
  exit 1
fi

if python3 -m unittest -v "${ROOT}/scripts/ops/tests/test_root_disk_usage_report.py"; then
  echo "ok   unittest root_disk_usage_report"
else
  echo "FAIL unittest root_disk_usage_report"
  fail=1
fi

exit "$fail"
