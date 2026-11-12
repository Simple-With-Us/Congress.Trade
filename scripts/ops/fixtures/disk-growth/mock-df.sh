#!/usr/bin/env bash
# Test double for df — reads fixture tables from DISK_GROWTH_FIXTURE_DIR.
set -euo pipefail
FIX="${DISK_GROWTH_FIXTURE_DIR:?DISK_GROWTH_FIXTURE_DIR required}"
mode=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -P[kKiI]*) mode="$1"; shift ;;
    -*) shift ;;
    *) shift ;;
  esac
done
case "$mode" in
  -Pk) cat "${FIX}/mock-df-Pk.txt" ;;
  -Pi) cat "${FIX}/mock-df-Pi.txt" ;;
  *) echo "mock-df: unsupported mode ${mode}" >&2; exit 1 ;;
esac
