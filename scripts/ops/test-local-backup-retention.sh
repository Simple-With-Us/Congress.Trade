#!/usr/bin/env bash
# Offline fixture tests for local backup retention. No host, no network.
set -euo pipefail
cd "$(dirname "$0")/../.."
bash -n scripts/ops/local-backup-retention.sh
python3 -m py_compile scripts/ops/local_backup_retention.py
python3 scripts/ops/test_local_backup_retention.py
