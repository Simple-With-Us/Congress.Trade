#!/usr/bin/env bash
# Read-only Docker volume and bind-mount sizes for the Coolify host.
#
# Maps each volume and bind mount to a Coolify app or service from labels, or
# from the container name when those labels are absent. Orphaned volumes are
# volumes no container mounts. Stdout is a suggested `docker volume rm` line
# for each orphan and nothing else. The command is not executed.
#
#   scripts/ops/docker-volume-report.sh
#
# VOLUME_REPORT_DIR     default /var/lib/docker-volume-report
# VOLUME_REPORT_TOP     default 10
# VOLUME_REPORT_NOW     RFC3339 UTC timestamp, default current UTC
# VOLUME_REPORT_HOST    default the short hostname
# DOCKER                docker CLI, default docker
#
# APPLY and PRUNE_VOLUMES are refused. This script has no delete switch.
# JSON is $VOLUME_REPORT_DIR/latest.json. Markdown is latest.md beside it.
# The previous latest.json is the growth baseline. Scratch files under mktemp
# are removed after the report is written. They are not Docker objects.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="${SCRIPT_DIR}/docker_volume_report.py"

DOCKER="${DOCKER:-docker}"
VOLUME_REPORT_DIR="${VOLUME_REPORT_DIR:-/var/lib/docker-volume-report}"
VOLUME_REPORT_TOP="${VOLUME_REPORT_TOP:-10}"
VOLUME_REPORT_NOW="${VOLUME_REPORT_NOW:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
VOLUME_REPORT_HOST="${VOLUME_REPORT_HOST:-$(hostname -s 2>/dev/null || hostname)}"

# Names, labels, and mounts only. Env and volume options stay out of the snapshot.
INSPECT_FMT='{"Id":{{json .Id}},"Name":{{json .Name}},"Status":{{json .State.Status}},"Labels":{{json .Config.Labels}},"Mounts":{{json .Mounts}}}'

die() {
  echo "docker-volume-report: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
docker-volume-report.sh

Read-only sizes for every Docker volume and bind mount. Writes latest.json
and latest.md under VOLUME_REPORT_DIR. Prints one suggested removal line
per orphaned volume and does not run it.
EOF
}

cleanup() {
  if [[ -n "${REPORT_TMP:-}" ]]; then
    rm -rf "$REPORT_TMP"
  fi
}

collect_ids() {
  local raw="$1"
  local -n dest="$2"
  dest=()
  if [[ -z "$raw" ]]; then
    return 0
  fi
  local id
  while IFS= read -r id; do
    [[ -z "$id" ]] && continue
    [[ "$id" =~ ^[0-9a-f]{64}$ ]] || die "refused container id"
    dest+=("$id")
  done <<< "$raw"
}

validate_config() {
  if [[ $# -gt 0 ]]; then
    die "usage: docker-volume-report.sh"
  fi
  if [[ -n "${APPLY:-}" && "${APPLY}" != "0" ]]; then
    die "this report never deletes; unset APPLY"
  fi
  if [[ "${PRUNE_VOLUMES:-0}" != "0" ]]; then
    die "this report never prunes volumes"
  fi
  [[ "$VOLUME_REPORT_TOP" =~ ^[1-9][0-9]*$ ]] || die "VOLUME_REPORT_TOP must be a positive integer"
  [[ "$VOLUME_REPORT_DIR" == /* ]] || die "VOLUME_REPORT_DIR must be an absolute path"
  [[ "$VOLUME_REPORT_NOW" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || die "VOLUME_REPORT_NOW must be UTC RFC3339"
  [[ "$VOLUME_REPORT_HOST" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]{0,252})?$ ]] || die "VOLUME_REPORT_HOST must be a hostname"
}

collect_snapshot() {
  local dir="$1"
  "$DOCKER" system df -v > "$dir/df-verbose.txt"
  "$DOCKER" volume ls --format '{{json .}}' > "$dir/volumes.jsonl"
  : > "$dir/container-ids.txt"
  : > "$dir/containers.jsonl"
  local raw
  local -a ids=()
  raw="$("$DOCKER" ps -aq --no-trunc)"
  collect_ids "$raw" ids
  if ((${#ids[@]})); then
    printf '%s\n' "${ids[@]}" > "$dir/container-ids.txt"
    "$DOCKER" container inspect --format "$INSPECT_FMT" "${ids[@]}" > "$dir/containers.jsonl"
  fi
}

# du sizes only the bind sources the reporter already accepted. `/` is refused
# again here so a bad source list cannot walk the host root.
size_binds() {
  local dir="$1"
  local src out
  : > "$dir/bind-sizes.txt"
  while IFS= read -r src || [[ -n "${src:-}" ]]; do
    [[ -z "$src" ]] && continue
    if [[ "$src" != /* || "$src" == "/" ]]; then
      printf 'refused\t%s\n' "$src" >> "$dir/bind-sizes.txt"
      continue
    fi
    if [[ ! -e "$src" ]]; then
      printf 'missing\t%s\n' "$src" >> "$dir/bind-sizes.txt"
      continue
    fi
    # GNU du prints a total and exits nonzero when part of the tree is unreadable.
    # Keep that total but mark it partial so it is never ranked as growth.
    # Record an error only when du prints nothing.
    local rc=0
    out="$(LC_ALL=C du -sB1 -- "$src" 2>/dev/null)" || rc=$?
    if [[ -n "$out" && "$rc" -eq 0 ]]; then
      printf '%s\n' "$out" >> "$dir/bind-sizes.txt"
    elif [[ -n "$out" ]]; then
      printf 'partial\t%s\n' "$out" >> "$dir/bind-sizes.txt"
    else
      printf 'error\t%s\n' "$src" >> "$dir/bind-sizes.txt"
    fi
  done < "$dir/bind-sources.txt"
}

main() {
  if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    usage
    exit 0
  fi
  validate_config "$@"
  command -v "$DOCKER" >/dev/null 2>&1 || die "Docker CLI not found"
  command -v du >/dev/null 2>&1 || die "du not found"
  [[ -f "$PY" ]] || die "reporter not found"
  REPORT_TMP="$(mktemp -d)"
  chmod 700 "$REPORT_TMP"
  trap cleanup EXIT
  collect_snapshot "$REPORT_TMP"
  python3 "$PY" bind-sources --input-dir "$REPORT_TMP" > "$REPORT_TMP/bind-sources.txt"
  size_binds "$REPORT_TMP"
  mkdir -p "$VOLUME_REPORT_DIR"
  local -a args=()
  args=(
    python3 "$PY" report
    --input-dir "$REPORT_TMP"
    --json "$VOLUME_REPORT_DIR/latest.json"
    --markdown "$VOLUME_REPORT_DIR/latest.md"
    --now "$VOLUME_REPORT_NOW"
    --host "$VOLUME_REPORT_HOST"
    --top "$VOLUME_REPORT_TOP"
  )
  if [[ -f "$VOLUME_REPORT_DIR/latest.json" ]]; then
    args+=(--previous "$VOLUME_REPORT_DIR/latest.json")
  fi
  "${args[@]}"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
