#!/usr/bin/env bash
# Report reclaimable Docker space on a Coolify host, and prune only with APPLY=1.
#
# Dry-run is the default. APPLY=1 removes only the objects the planner listed:
# stopped containers older than N days, unused images older than N days,
# dangling anonymous volumes, and build cache older than BUILD_CACHE_UNTIL.
# Named volumes are never removed. Coolify's running and recently run
# resources, every container's current image, and one previous image per
# Coolify app are kept.
#
#   scripts/ops/docker-reclaim.sh
#   APPLY=1 scripts/ops/docker-reclaim.sh
#
# IMAGE_MIN_AGE_DAYS        default 14, minimum 1
# CONTAINER_MIN_AGE_DAYS    default 14, minimum 1
# COOLIFY_RECENT_DAYS       default 14, minimum 1
# BUILD_CACHE_UNTIL         default 72h (hours only, such as 96h)
# DOCKER                    docker CLI, default docker
# DOCKER_RECLAIM_NOW        RFC3339 timestamp, default current UTC

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="${SCRIPT_DIR}/docker_reclaim.py"

APPLY="${APPLY:-0}"
IMAGE_MIN_AGE_DAYS="${IMAGE_MIN_AGE_DAYS:-14}"
CONTAINER_MIN_AGE_DAYS="${CONTAINER_MIN_AGE_DAYS:-14}"
COOLIFY_RECENT_DAYS="${COOLIFY_RECENT_DAYS:-14}"
BUILD_CACHE_UNTIL="${BUILD_CACHE_UNTIL:-72h}"
DOCKER="${DOCKER:-docker}"

# Labels, timestamps, and image ids only. Env, mounts, and volume options stay
# out of the collected snapshot.
CONTAINER_FMT='{"Id":{{json .Id}},"Image":{{json .Image}},"Name":{{json .Name}},"Created":{{json .Created}},"Status":{{json .State.Status}},"FinishedAt":{{json .State.FinishedAt}},"StartedAt":{{json .State.StartedAt}},"Labels":{{json .Config.Labels}}}'
IMAGE_FMT='{"Id":{{json .Id}},"Created":{{json .Created}},"Size":{{.Size}},"RepoTags":{{json .RepoTags}},"Labels":{{json .Config.Labels}}}'

die() {
  echo "docker-reclaim: $*" >&2
  exit 1
}

cleanup() {
  if [[ -n "${RECLAIM_TMP:-}" ]]; then
    rm -rf "$RECLAIM_TMP"
  fi
}

validate_config() {
  [[ "$IMAGE_MIN_AGE_DAYS" =~ ^[1-9][0-9]*$ ]] || die "IMAGE_MIN_AGE_DAYS must be a positive integer of days"
  [[ "$CONTAINER_MIN_AGE_DAYS" =~ ^[1-9][0-9]*$ ]] || die "CONTAINER_MIN_AGE_DAYS must be a positive integer of days"
  [[ "$COOLIFY_RECENT_DAYS" =~ ^[1-9][0-9]*$ ]] || die "COOLIFY_RECENT_DAYS must be a positive integer of days"
  [[ "$BUILD_CACHE_UNTIL" =~ ^[1-9][0-9]*h$ ]] || die "BUILD_CACHE_UNTIL must look like 72h"
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
    [[ -n "$id" ]] && dest+=("$id")
  done <<< "$raw"
}

collect_snapshot() {
  local dir="$1"
  "$DOCKER" system df > "$dir/df-summary.txt"
  "$DOCKER" system df -v > "$dir/df-verbose.txt"
  : > "$dir/containers.jsonl"
  : > "$dir/images.jsonl"
  local -a cids=()
  local -a iids=()
  local raw
  raw="$("$DOCKER" ps -aq --no-trunc)"
  collect_ids "$raw" cids
  if ((${#cids[@]})); then
    "$DOCKER" container inspect --format "$CONTAINER_FMT" "${cids[@]}" > "$dir/containers.jsonl"
  fi
  raw="$("$DOCKER" images -aq --no-trunc)"
  collect_ids "$raw" iids
  if ((${#iids[@]})); then
    "$DOCKER" image inspect --format "$IMAGE_FMT" "${iids[@]}" > "$dir/images.jsonl"
  fi
  "$DOCKER" volume ls --format '{{json .}}' > "$dir/volumes.jsonl"
}

apply_actions() {
  local file="$1"
  local kind="" value="" extra=""
  while IFS=$'\t' read -r kind value extra || [[ -n "$kind" ]]; do
    [[ -z "$kind" ]] && continue
    if [[ -n "$extra" ]]; then
      die "refused malformed action"
    fi
    case "$kind" in
      container)
        [[ "$value" =~ ^[0-9a-f]{64}$ ]] || die "refused container id"
        "$DOCKER" rm "$value"
        ;;
      image)
        [[ "$value" =~ ^[0-9a-f]{64}$ ]] || die "refused image id"
        "$DOCKER" image rm "$value"
        ;;
      volume)
        [[ "$value" =~ ^[a-f0-9]{64}$ ]] || die "refused volume name"
        "$DOCKER" volume rm "$value"
        ;;
      build-cache)
        [[ "$value" =~ ^[1-9][0-9]*h$ ]] || die "refused build cache age"
        "$DOCKER" builder prune -f --filter "until=${value}"
        ;;
      *)
        die "refused action"
        ;;
    esac
    kind=""
    value=""
    extra=""
  done < "$file"
}

main() {
  validate_config
  command -v "$DOCKER" >/dev/null 2>&1 || die "Docker CLI not found"
  [[ -f "$PY" ]] || die "planner not found"
  local now mode
  RECLAIM_TMP="$(mktemp -d)"
  chmod 700 "$RECLAIM_TMP"
  trap cleanup EXIT
  now="${DOCKER_RECLAIM_NOW:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
  if [[ "$APPLY" == "1" ]]; then
    mode="apply"
  else
    mode="dry-run"
  fi
  collect_snapshot "$RECLAIM_TMP"
  python3 "$PY" plan \
    --input-dir "$RECLAIM_TMP" \
    --now "$now" \
    --image-min-age-days "$IMAGE_MIN_AGE_DAYS" \
    --container-min-age-days "$CONTAINER_MIN_AGE_DAYS" \
    --coolify-recent-days "$COOLIFY_RECENT_DAYS" \
    --build-cache-until "$BUILD_CACHE_UNTIL" \
    --commands "$RECLAIM_TMP/actions.tsv" \
    --mode "$mode"
  if [[ "$mode" == "apply" ]]; then
    apply_actions "$RECLAIM_TMP/actions.tsv"
    echo "after:"
    "$DOCKER" system df
  else
    echo "after:"
    echo "skipped (dry-run; set APPLY=1 to prune)"
  fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
