#!/usr/bin/env bash
# Offline tests for docker-volume-report.sh. No Docker daemon and no network.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
bash -n "$ROOT/scripts/ops/docker-volume-report.sh"
python3 -m py_compile "$ROOT/scripts/ops/docker_volume_report.py"
python3 "$ROOT/scripts/ops/tests/test_docker_volume_report.py"
