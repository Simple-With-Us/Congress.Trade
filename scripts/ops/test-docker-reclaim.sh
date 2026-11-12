#!/usr/bin/env bash
# Offline tests for docker-reclaim.sh. No Docker daemon and no network.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
bash -n "$ROOT/scripts/ops/docker-reclaim.sh"
python3 -m py_compile "$ROOT/scripts/ops/docker_reclaim.py"
python3 "$ROOT/scripts/ops/tests/test_docker_reclaim.py"
