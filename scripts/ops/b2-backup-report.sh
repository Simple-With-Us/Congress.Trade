#!/usr/bin/env bash
# Read-only report of fleet Hetzner SQLite dumps in Backblaze B2 (hetzner/ prefix).
# Complements fleet-sqlite-backup.sh: never uploads, prunes, or deletes.
#
# Credentials (names only; values from env / rclone / Infisical on the host):
#   b2 CLI: B2_APPLICATION_KEY_ID, B2_APPLICATION_KEY
#   aws s3api fallback: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, B2_S3_ENDPOINT
#
# Config (aligned with scripts/ops/fleet-sqlite-backup.sh and fleet-backups.cron):
#   B2_REPORT_BUCKETS     optional label=bucket list (default three fleet buckets)
#   B2_REPORT_PREFIX        default hetzner/
#   B2_MAX_AGE_DAYS         default 14
#   B2_KEEP_DAILY / B2_KEEP_WEEKLY  informational in report (default 3 / 2)
#   B2_REPORT_STALE_HOURS   default 26 (crit if no object newer)
#   B2_REPORT_TOTAL_BYTES_CAP  optional warn threshold on summed bytes
#   B2_REPORT_INCLUDE_VERSIONS  default 0 (current objects); set 1 for full version audit
#   B2_REPORT_SKIP_HIDDEN     default 1 (exclude hide/delete markers)
#   B2_REPORT_FIXTURE_DIR   offline/json fixtures (tests only)
#
# Usage:
#   bash scripts/ops/b2-backup-report.sh [--json]
# Exit: 0 ok, 1 warn, 2 crit — see scripts/ops/b2_backup_report.py
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
exec python3 "${ROOT_DIR}/scripts/ops/b2_backup_report.py" "$@"
