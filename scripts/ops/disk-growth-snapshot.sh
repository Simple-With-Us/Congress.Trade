#!/usr/bin/env bash
# disk-growth-snapshot.sh — read-only daily JSON snapshot of disk + Docker usage (host install optional)
#
# Writes one file per UTC day under SNAPSHOT_DIR (default /var/lib/fleet-disk-growth), prunes to RETENTION_DAYS.
# No deletes outside SNAPSHOT_DIR.  No pruning of Docker/images/volumes.
#
#   bash scripts/ops/disk-growth-snapshot.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=scripts/ops/disk-growth-lib.sh
# shellcheck disable=SC1091
if [[ -f "$SCRIPT_DIR/disk-growth-lib.sh" ]]; then
  source "$SCRIPT_DIR/disk-growth-lib.sh"
else
  source "${ROOT_DIR}/scripts/ops/disk-growth-lib.sh"
fi

if [[ -f /etc/disk-growth-snapshot.env ]]; then
  # shellcheck disable=SC1091
  set -a
  # shellcheck source=/dev/null
  source /etc/disk-growth-snapshot.env
  set +a
fi

SNAPSHOT_DIR="${SNAPSHOT_DIR:-/var/lib/fleet-disk-growth}"
SNAPSHOT_DATE="${SNAPSHOT_DATE:-$(date -u +%Y-%m-%d)}"
export DISK_GROWTH_SNAPSHOT_DATE="${DISK_GROWTH_SNAPSHOT_DATE:-$SNAPSHOT_DATE}"
DRY_RUN="${DRY_RUN:-0}"

mkdir -p "$SNAPSHOT_DIR"
out="$(disk_growth_snapshot_path "$SNAPSHOT_DATE")"

if [[ -f "$out" && "${DISK_GROWTH_FORCE:-0}" != "1" ]]; then
  echo "disk-growth-snapshot: already captured ${SNAPSHOT_DATE} at ${out}" >&2
  exit 0
fi

json="$(disk_growth_build_snapshot_json)"
if [[ "$DRY_RUN" == "1" ]]; then
  printf '%s\n' "$json"
  exit 0
fi

tmp="${out}.partial.$$"
printf '%s\n' "$json" >"$tmp"
mv -f "$tmp" "$out"
disk_growth_prune_old_snapshots
echo "disk-growth-snapshot: wrote ${out}" >&2
