#!/usr/bin/env bash
# root-disk-usage-report.sh — report-only Hetzner/Coolify root disk usage (JSON + markdown)
#
#   bash scripts/ops/root-disk-usage-report.sh --json-out /var/lib/fleet-disk-reports/latest.json
#
# Optional host env file (not installed by this repo):
#   /etc/root-disk-usage-report.env
#
# See scripts/ops/root-disk-usage-report.py for flags and ROOT_DISK_* overrides.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
PY="${ROOT_DIR}/scripts/ops/root-disk-usage-report.py"

if [[ -f /etc/root-disk-usage-report.env ]]; then
  # shellcheck disable=SC1091
  set -a
  # shellcheck source=/dev/null
  source /etc/root-disk-usage-report.env
  set +a
fi

exec python3 "$PY" "$@"
