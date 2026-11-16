#!/usr/bin/env bash
# Test double for findmnt — treats DISK_GROWTH_FIXTURE_ROOT as / and optional extra mount.
set -euo pipefail
target=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -T) target="$2"; shift 2 ;;
    -n) shift ;;
    *) shift ;;
  esac
done
case "$target" in
  / | "") exit 0 ;;
  /mnt/fleet-extra)
    [[ -d "${DISK_GROWTH_FIXTURE_ROOT:?}/mnt/fleet-extra" ]] && exit 0
    exit 1
    ;;
  /tmp | /dev/shm) exit 0 ;;
  *)
    [[ -d "$target" ]] && exit 0
    exit 1
    ;;
esac
