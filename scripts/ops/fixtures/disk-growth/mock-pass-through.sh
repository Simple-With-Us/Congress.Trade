#!/usr/bin/env bash
# Ignores first args (timeout duration, ionice/nice flags) and execs the real du command.
set -euo pipefail
while [[ $# -gt 0 ]]; do
  case "$1" in
    timeout | ionice | nice) shift; continue ;;
    -c* | -n) shift 2 ;;
    [0-9]*) shift ;;
    -*) shift ;;
    *) break ;;
  esac
done
exec "$@"
