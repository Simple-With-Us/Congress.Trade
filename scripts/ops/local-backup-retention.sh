#!/usr/bin/env bash
# Keep newest local Coolify and fleet sqlite backups on the root disk.
# Dry-run unless APPLY=1. Does not move files. See
# docs/rollouts/2026-11-12-local-backup-retention.md.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
HELPER="${BACKUP_RETENTION_PY:-$HERE/local_backup_retention.py}"

# systemd EnvironmentFile is applied before ExecStart. For a manual run, fill
# only variables that are still unset so an explicit APPLY=0 cannot be
# overridden by the env file. Values are never printed.
load_unset_from_file() {
  local file="$1" line key value
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"
    case "$line" in
      ''|\#*) continue ;;
      export\ *) line="${line#export }" ;;
    esac
    case "$line" in
      *=*) ;;
      *) continue ;;
    esac
    key="${line%%=*}"
    case "$key" in
      [A-Za-z_][A-Za-z0-9_]*) ;;
      *) continue ;;
    esac
    if [ -n "${!key+x}" ]; then
      continue
    fi
    value="${line#*=}"
    if [ "${#value}" -ge 2 ]; then
      case "$value" in
        \"*\") value="${value:1:${#value}-2}" ;;
        \'*\') value="${value:1:${#value}-2}" ;;
      esac
    fi
    printf -v "$key" '%s' "$value"
    export "$key"
  done < "$file"
}

if [ "${BACKUP_RETENTION_LOAD_ENV:-1}" != "0" ]; then
  load_unset_from_file "${BACKUP_RETENTION_ENV:-/etc/fleet-local-backup-retention.env}"
fi

LOCK="${BACKUP_RETENTION_LOCK:-/var/lock/fleet-local-backup-retention.lock}"
if command -v flock >/dev/null 2>&1; then
  lock_dir="$(dirname "$LOCK")"
  if [ ! -d "$lock_dir" ] && ! mkdir -p "$lock_dir" 2>/dev/null; then
    LOCK="${TMPDIR:-/tmp}/fleet-local-backup-retention.lock"
    mkdir -p "$(dirname "$LOCK")"
  fi
  exec 8>"$LOCK"
  if ! flock -n 8; then
    echo "SKIP	already-running"
    exit 0
  fi
fi

if [ ! -f "$HELPER" ]; then
  echo "ERROR	missing helper $HELPER" >&2
  exit 1
fi
exec python3 "$HELPER"
