#!/usr/bin/env bash
# box-disk-hygiene.sh — 15-minute host health + safe Docker prune on the Coolify host.
#
# CT-1875 shipped the timer. CT-2471 extends that same oneshot (no second unit)
# so it can stand in for the retired INSTINCT Datadog monitors 23168882-23168886
# after the Datadog agent was left off fleet-hetzner-nbg1. Do not reinstall it.
#
# Safe defaults:
#   - never restarts docker and never reboots the host
#   - never prunes named volumes and never passes --volumes
#   - skips prune while Coolify/nixpacks/buildkit is actively building
#   - skips `docker builder prune -af` unless Build Cache ACTIVE is 0
#   - rate-limits aggressive prunes
#   - pages on level change plus a periodic reminder, not every tick
#
# Host install is a separate step (not this script). From a checkout, as root:
#   install -m 0755 scripts/ops/box-disk-hygiene.sh /usr/local/bin/
#   install -m 0644 scripts/ops/systemd.noindex/box-disk-hygiene.service /etc/systemd/system/
#   install -m 0644 scripts/ops/systemd.noindex/box-disk-hygiene.timer /etc/systemd/system/
#   systemctl daemon-reload
#   systemctl enable --now box-disk-hygiene.timer
#
# Env (optional /etc/box-disk-hygiene.env, then /etc/congress-health-recover.env):
#   ROOT_PATH                 default /
#   WARN_USED_PCT             default 80     (root and other large mounts)
#   CRIT_USED_PCT             default 90
#   WARN_FREE_GB              default 15
#   CRIT_FREE_GB              default 8
#   TMPFS_WARN_FREE_GB        default 3.2    (/tmp and /dev/shm; monitors 23168885/86)
#   TMPFS_CRIT_FREE_GB        default 1.6
#   MEM_WARN_AVAIL_PCT        default 15     (MemAvailable below this)
#   MEM_CRIT_AVAIL_PCT        default 5
#   SWAP_OUT_WARN_KBPS        default 256    (activity; swap % alone does not page)
#   SWAP_OUT_CRIT_KBPS        default 2048
#   INODE_WARN_PCT            default 80
#   INODE_CRIT_PCT            default 90
#   LOAD_WARN_PER_CPU         default 2      (load5 / ncpu)
#   LOAD_CRIT_PER_CPU         default 4
#   ALERT_REMINDER_SEC        default 14400  (repeat a held warn/crit)
#   ROOT_GROWTH_GB            default 25     (monitor 23168882, within 1h)
#   ROOT_GROWTH_WINDOW_SEC    default 3600
#   TMP_GROWTH_GB             default 4      (monitor 23168883; sampled each run)
#   TMP_GROWTH_WINDOW_SEC     default 1200
#   LIGHT_BUILDER_UNTIL       default 12h
#   AGGRESSIVE_COOLDOWN_SEC   default 1800
#   PRUNE_VOLUMES             ignored       (named volumes are never pruned)
#   PUSHOVER_USAGE_API_TOKEN  preferred app token
#   PUSHOVER_APP_TOKEN        fallback app token
#   PUSHOVER_USER_KEY         recipient
#   DRY_RUN                   default 0
#
# Offline tests set HYGIENE_LIB_ONLY=1 and source this file, or point
# HYGIENE_FIXTURE_DIR at df/meminfo/vmstat fixtures. HYGIENE_NOW pins the clock.

set -euo pipefail

ROOT_PATH="${ROOT_PATH:-/}"
WARN_USED_PCT="${WARN_USED_PCT:-80}"
CRIT_USED_PCT="${CRIT_USED_PCT:-90}"
WARN_FREE_GB="${WARN_FREE_GB:-15}"
CRIT_FREE_GB="${CRIT_FREE_GB:-8}"
TMPFS_WARN_FREE_GB="${TMPFS_WARN_FREE_GB:-3.2}"
TMPFS_CRIT_FREE_GB="${TMPFS_CRIT_FREE_GB:-1.6}"
MEM_WARN_AVAIL_PCT="${MEM_WARN_AVAIL_PCT:-15}"
MEM_CRIT_AVAIL_PCT="${MEM_CRIT_AVAIL_PCT:-5}"
SWAP_OUT_WARN_KBPS="${SWAP_OUT_WARN_KBPS:-256}"
SWAP_OUT_CRIT_KBPS="${SWAP_OUT_CRIT_KBPS:-2048}"
INODE_WARN_PCT="${INODE_WARN_PCT:-80}"
INODE_CRIT_PCT="${INODE_CRIT_PCT:-90}"
LOAD_WARN_PER_CPU="${LOAD_WARN_PER_CPU:-2}"
LOAD_CRIT_PER_CPU="${LOAD_CRIT_PER_CPU:-4}"
ALERT_REMINDER_SEC="${ALERT_REMINDER_SEC:-14400}"
ROOT_GROWTH_GB="${ROOT_GROWTH_GB:-25}"
ROOT_GROWTH_WINDOW_SEC="${ROOT_GROWTH_WINDOW_SEC:-3600}"
TMP_GROWTH_GB="${TMP_GROWTH_GB:-4}"
TMP_GROWTH_WINDOW_SEC="${TMP_GROWTH_WINDOW_SEC:-1200}"
LIGHT_BUILDER_UNTIL="${LIGHT_BUILDER_UNTIL:-12h}"
AGGRESSIVE_COOLDOWN_SEC="${AGGRESSIVE_COOLDOWN_SEC:-1800}"
PRUNE_VOLUMES="${PRUNE_VOLUMES:-0}"
CT_DATA_DIR="${CT_DATA_DIR:-/data/congress-trade}"
BACKUP_DATA_DIR="${BACKUP_DATA_DIR:-/data/backups}"
BACKUP_KEEP_COUNT="${BACKUP_KEEP_COUNT:-4}"
SCRATCH_DATA_DIR="${SCRATCH_DATA_DIR:-/data/scratch}"
STATE_DIR="${STATE_DIR:-/var/lib/box-disk-hygiene}"
LOG_TAG="${LOG_TAG:-box-disk-hygiene}"
ALERT_WEBHOOK_URL="${ALERT_WEBHOOK_URL:-}"
DRY_RUN="${DRY_RUN:-0}"

load_host_env() {
  local box="${BOX_DISK_HYGIENE_ENV:-/etc/box-disk-hygiene.env}"
  local rec="${CONGRESS_HEALTH_RECOVER_ENV:-/etc/congress-health-recover.env}"
  if [[ -f "$box" ]]; then
    # shellcheck disable=SC1090
    set -a; source "$box"; set +a
  fi
  if [[ -f "$rec" ]]; then
    # shellcheck disable=SC1090
    set -a; source "$rec"; set +a
  fi
  PUSHOVER_APP_TOKEN="${PUSHOVER_USAGE_API_TOKEN:-${PUSHOVER_APP_TOKEN:-}}"
}

log() {
  local msg="$*"
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$msg"
  if command -v logger >/dev/null 2>&1; then
    logger -t "$LOG_TAG" -- "$msg" || true
  fi
}

alert_now() {
  if [[ -n "${HYGIENE_NOW:-}" ]]; then
    printf '%s\n' "$HYGIENE_NOW"
    return 0
  fi
  date +%s
}

now() { alert_now; }

is_deploy_active() {
  if [[ -n "${HYGIENE_DEPLOY_ACTIVE:-}" ]]; then
    [[ "$HYGIENE_DEPLOY_ACTIVE" == "1" ]]
    return
  fi
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -Eqi 'nixpacks|coolify-builder|buildkit'; then
    return 0
  fi
  return 1
}

kb_to_gb() {
  awk -v k="$1" 'BEGIN { printf "%.1f", (k+0)/1024/1024 }'
}

df_fields_for() {
  local text="$1"
  local mount="$2"
  printf '%s\n' "$text" | awk -v m="$mount" 'NR>1 && $NF==m {print $2, $3, $4, $5; exit}'
}

mount_is_mounted() {
  local mount="$1"
  printf '%s\n' "$MOUNTS_TEXT" | awk -v m="$mount" '$2==m {found=1; exit} END {exit !found}'
}

level_for_thresholds() {
  local used_pct="$1"
  local free_gb="$2"
  local crit_used="$3"
  local crit_free="$4"
  local warn_used="$5"
  local warn_free="$6"
  local apply_free="$7"
  if [[ "$apply_free" == "1" ]]; then
    if awk -v u="$used_pct" -v c="$crit_used" -v f="$free_gb" -v cf="$crit_free" \
      'BEGIN { exit !((u+0) >= (c+0) || (f+0) < (cf+0)) }'; then
      echo crit
      return 0
    fi
    if awk -v u="$used_pct" -v w="$warn_used" -v f="$free_gb" -v wf="$warn_free" \
      'BEGIN { exit !((u+0) >= (w+0) || (f+0) < (wf+0)) }'; then
      echo warn
      return 0
    fi
  else
    if awk -v u="$used_pct" -v c="$crit_used" 'BEGIN { exit !((u+0) >= (c+0)) }'; then
      echo crit
      return 0
    fi
    if awk -v u="$used_pct" -v w="$warn_used" 'BEGIN { exit !((u+0) >= (w+0)) }'; then
      echo warn
      return 0
    fi
  fi
  echo ok
}

level_for() {
  level_for_thresholds "$1" "$2" "$CRIT_USED_PCT" "$CRIT_FREE_GB" "$WARN_USED_PCT" "$WARN_FREE_GB" 1
}

mount_level() {
  local used_pct="$1"
  local free_gb="$2"
  local total_gb="$3"
  local kind="$4"
  local warn_free crit_free apply_free
  apply_free=1
  case "$kind" in
    root|extra)
      warn_free="$WARN_FREE_GB"
      crit_free="$CRIT_FREE_GB"
      ;;
    tmpfs)
      warn_free="$TMPFS_WARN_FREE_GB"
      crit_free="$TMPFS_CRIT_FREE_GB"
      ;;
    *)
      echo unknown
      return 0
      ;;
  esac
  if awk -v t="$total_gb" -v w="$warn_free" 'BEGIN { exit !((t+0) < (w+0)) }'; then
    apply_free=0
  fi
  level_for_thresholds "$used_pct" "$free_gb" "$CRIT_USED_PCT" "$crit_free" "$WARN_USED_PCT" "$warn_free" "$apply_free"
}

inode_level() {
  local pct="$1"
  if [[ -z "$pct" ]]; then
    echo unknown
    return 0
  fi
  if awk -v u="$pct" -v c="$INODE_CRIT_PCT" 'BEGIN { exit !((u+0) >= (c+0)) }'; then
    echo crit
    return 0
  fi
  if awk -v u="$pct" -v w="$INODE_WARN_PCT" 'BEGIN { exit !((u+0) >= (w+0)) }'; then
    echo warn
    return 0
  fi
  echo ok
}

mem_level() {
  local avail_pct="$1"
  if [[ -z "$avail_pct" ]]; then
    echo unknown
    return 0
  fi
  if awk -v a="$avail_pct" -v c="$MEM_CRIT_AVAIL_PCT" 'BEGIN { exit !((a+0) < (c+0)) }'; then
    echo crit
    return 0
  fi
  if awk -v a="$avail_pct" -v w="$MEM_WARN_AVAIL_PCT" 'BEGIN { exit !((a+0) < (w+0)) }'; then
    echo warn
    return 0
  fi
  echo ok
}

swap_level() {
  local avail_pct="$1"
  local swap_used_pct="$2"
  local kbps="$3"
  local have_baseline="$4"
  if [[ "$have_baseline" != "1" || "$swap_used_pct" == "na" || -z "$swap_used_pct" ]]; then
    echo ok
    return 0
  fi
  local hot=0 active=0 mem_crit=0
  if awk -v k="$kbps" -v c="$SWAP_OUT_CRIT_KBPS" 'BEGIN { exit !((k+0) >= (c+0)) }'; then
    hot=1
  fi
  if awk -v k="$kbps" -v w="$SWAP_OUT_WARN_KBPS" 'BEGIN { exit !((k+0) >= (w+0)) }'; then
    active=1
  fi
  if [[ -n "$avail_pct" ]] && awk -v a="$avail_pct" -v c="$MEM_CRIT_AVAIL_PCT" 'BEGIN { exit !((a+0) < (c+0)) }'; then
    mem_crit=1
  fi
  if [[ "$hot" == "1" || ( "$active" == "1" && "$mem_crit" == "1" ) ]]; then
    echo crit
    return 0
  fi
  if [[ "$active" == "1" ]]; then
    echo warn
    return 0
  fi
  echo ok
}

load_level() {
  local load5="$1"
  local ncpu="$2"
  if [[ -z "$load5" || -z "$ncpu" ]]; then
    echo unknown
    return 0
  fi
  if awk -v n="$ncpu" 'BEGIN { exit !((n+0) < 1) }'; then
    echo unknown
    return 0
  fi
  if awk -v l="$load5" -v n="$ncpu" -v c="$LOAD_CRIT_PER_CPU" 'BEGIN { exit !((l+0) >= (n+0)*(c+0)) }'; then
    echo crit
    return 0
  fi
  if awk -v l="$load5" -v n="$ncpu" -v w="$LOAD_WARN_PER_CPU" 'BEGIN { exit !((l+0) >= (n+0)*(w+0)) }'; then
    echo warn
    return 0
  fi
  echo ok
}

growth_level_from_delta() {
  local threshold_gb="$1"
  local window_sec="$2"
  local delta_gb="$3"
  local elapsed="$4"
  if awk -v e="$elapsed" -v w="$window_sec" 'BEGIN { exit !((e+0) > (w+0)) }'; then
    echo stale
    return 0
  fi
  if awk -v d="$delta_gb" -v t="$threshold_gb" 'BEGIN { exit !((d+0) >= (t+0)) }'; then
    echo warn
    return 0
  fi
  echo ok
}

read_metric_texts() {
  if [[ -n "${HYGIENE_FIXTURE_DIR:-}" ]]; then
    DF_P_TEXT=$(cat "$HYGIENE_FIXTURE_DIR/df-P.txt")
    DF_I_TEXT=$(cat "$HYGIENE_FIXTURE_DIR/df-i.txt")
    MEMINFO_TEXT=$(cat "$HYGIENE_FIXTURE_DIR/meminfo")
    VMSTAT_TEXT=$(cat "$HYGIENE_FIXTURE_DIR/vmstat")
    LOADAVG_TEXT=$(cat "$HYGIENE_FIXTURE_DIR/loadavg")
    NPROC_TEXT=$(tr -d '[:space:]' < "$HYGIENE_FIXTURE_DIR/nproc")
    MOUNTS_TEXT=$(cat "$HYGIENE_FIXTURE_DIR/mounts")
    if [[ -f "$HYGIENE_FIXTURE_DIR/docker-df.txt" ]]; then
      DOCKER_DF_TEXT=$(cat "$HYGIENE_FIXTURE_DIR/docker-df.txt")
    else
      DOCKER_DF_TEXT=""
    fi
    return 0
  fi
  DF_P_TEXT=$(df -P 2>/dev/null || true)
  DF_I_TEXT=$(df -Pi 2>/dev/null || true)
  if [[ -r /proc/meminfo ]]; then
    MEMINFO_TEXT=$(cat /proc/meminfo)
  else
    MEMINFO_TEXT=""
  fi
  if [[ -r /proc/vmstat ]]; then
    VMSTAT_TEXT=$(cat /proc/vmstat)
  else
    VMSTAT_TEXT=""
  fi
  if [[ -r /proc/loadavg ]]; then
    LOADAVG_TEXT=$(cat /proc/loadavg)
  else
    LOADAVG_TEXT=""
  fi
  if command -v nproc >/dev/null 2>&1; then
    NPROC_TEXT=$(nproc 2>/dev/null || echo 0)
  else
    NPROC_TEXT=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 0)
  fi
  if [[ -r /proc/mounts ]]; then
    MOUNTS_TEXT=$(cat /proc/mounts)
  else
    MOUNTS_TEXT=""
  fi
  DOCKER_DF_TEXT=""
}

fill_mount_metrics() {
  local mount="$1"
  local kind="$2"
  local prefix="$3"
  local mounted=1
  if [[ "$mount" != "/" ]] && ! mount_is_mounted "$mount"; then
    mounted=0
  fi
  printf -v "M_${prefix}_MOUNTED" '%s' "$mounted"
  if [[ "$mounted" != "1" ]]; then
    printf -v "M_${prefix}_LEVEL" '%s' unknown
    printf -v "M_${prefix}_INODE_LEVEL" '%s' unknown
    printf -v "M_${prefix}_USED_PCT" '%s' ""
    printf -v "M_${prefix}_FREE_GB" '%s' ""
    printf -v "M_${prefix}_INODE_PCT" '%s' ""
    log "mount ${mount}: unmounted level=unknown"
    return 0
  fi
  local fields
  fields=$(df_fields_for "$DF_P_TEXT" "$mount")
  if [[ -z "$fields" ]]; then
    printf -v "M_${prefix}_LEVEL" '%s' unknown
    printf -v "M_${prefix}_INODE_LEVEL" '%s' unknown
    if [[ "$mount" == "/" ]]; then
      log "error: df failed for /"
      return 1
    fi
    log "mount ${mount}: missing from df level=unknown"
    return 0
  fi
  local total_k used_k avail_k pct free_gb total_gb used_gb level
  read -r total_k used_k avail_k pct <<<"$fields"
  pct=${pct%%%}
  free_gb=$(kb_to_gb "$avail_k")
  total_gb=$(kb_to_gb "$total_k")
  used_gb=$(kb_to_gb "$used_k")
  level=$(mount_level "$pct" "$free_gb" "$total_gb" "$kind")
  printf -v "M_${prefix}_USED_PCT" '%s' "$pct"
  printf -v "M_${prefix}_FREE_GB" '%s' "$free_gb"
  printf -v "M_${prefix}_TOTAL_GB" '%s' "$total_gb"
  printf -v "M_${prefix}_USED_GB" '%s' "$used_gb"
  printf -v "M_${prefix}_LEVEL" '%s' "$level"
  if [[ "$mount" == "/" ]]; then
    USED_PCT=$pct
    FREE_GB=$free_gb
    TOTAL_GB=$total_gb
    USED_GB=$used_gb
  fi
  local inodes ipct ilevel _t _u _f
  inodes=$(df_fields_for "$DF_I_TEXT" "$mount")
  if [[ -z "$inodes" ]]; then
    printf -v "M_${prefix}_INODE_PCT" '%s' ""
    printf -v "M_${prefix}_INODE_LEVEL" '%s' unknown
    ilevel=unknown
    ipct=""
  else
    read -r _t _u _f ipct <<<"$inodes"
    ipct=${ipct%%%}
    ilevel=$(inode_level "$ipct")
    printf -v "M_${prefix}_INODE_PCT" '%s' "$ipct"
    printf -v "M_${prefix}_INODE_LEVEL" '%s' "$ilevel"
  fi
  log "mount ${mount}: used=${pct}% free=${free_gb}G total=${total_gb}G level=${level} inodes=${ipct:-unknown}% inode_level=${ilevel}"
}

meminfo_kb() {
  local key="$1"
  printf '%s\n' "$MEMINFO_TEXT" | awk -v k="$key" '$1==k {print $2; exit}'
}

collect_memory() {
  local total avail
  total=$(meminfo_kb "MemTotal:")
  avail=$(meminfo_kb "MemAvailable:")
  if [[ -z "$total" || -z "$avail" || "$total" == "0" ]]; then
    MEM_AVAIL_PCT=""
    M_MEM_LEVEL=unknown
    log "memory: unavailable"
    return 0
  fi
  MEM_AVAIL_PCT=$(awk -v a="$avail" -v t="$total" 'BEGIN { printf "%.1f", (a/t)*100 }')
  MEM_AVAIL_MB=$(awk -v a="$avail" 'BEGIN { printf "%.0f", a/1024 }')
  M_MEM_LEVEL=$(mem_level "$MEM_AVAIL_PCT")
  log "memory: available=${MEM_AVAIL_PCT}% (${MEM_AVAIL_MB}MiB) level=${M_MEM_LEVEL}"
}

collect_swap() {
  local total free pages
  total=$(meminfo_kb "SwapTotal:")
  free=$(meminfo_kb "SwapFree:")
  if [[ -z "$total" || "$total" == "0" ]]; then
    SWAP_USED_PCT=na
  else
    SWAP_USED_PCT=$(awk -v t="$total" -v f="${free:-0}" 'BEGIN { printf "%.1f", ((t-f)/t)*100 }')
  fi
  pages=$(printf '%s\n' "$VMSTAT_TEXT" | awk '$1=="pswpout" {print $2; exit}')
  local now_ts="${HYGIENE_NOW:-}"
  if [[ -z "$now_ts" ]]; then
    now_ts=$(date +%s)
  fi
  SWAP_HAVE_BASELINE=0
  SWAP_OUT_KBPS=0
  mkdir -p "$STATE_DIR"
  if [[ -z "$pages" ]]; then
    log "swap: used=$(swap_used_label) swap-out unavailable"
    M_SWAP_LEVEL=$(swap_level "$MEM_AVAIL_PCT" "$SWAP_USED_PCT" 0 0)
    return 0
  fi
  local prev_epoch="" prev_pages=""
  if [[ -f "$STATE_DIR/pswpout.prev" ]]; then
    read -r prev_epoch prev_pages < "$STATE_DIR/pswpout.prev" || true
  fi
  printf '%s %s\n' "$now_ts" "$pages" > "$STATE_DIR/pswpout.prev"
  if [[ "$prev_epoch" =~ ^[0-9]+$ && "$prev_pages" =~ ^[0-9]+$ ]]; then
    local elapsed=$((now_ts - prev_epoch))
    local delta=$((pages - prev_pages))
    if [[ "$elapsed" -gt 0 && "$delta" -ge 0 ]]; then
      local pagesize="${PAGE_SIZE:-}"
      if [[ -z "$pagesize" ]]; then
        pagesize=$(getconf PAGESIZE 2>/dev/null || echo 4096)
      fi
      SWAP_OUT_KBPS=$(awk -v d="$delta" -v e="$elapsed" -v z="$pagesize" 'BEGIN { printf "%.1f", (d * z / 1024) / e }')
      SWAP_HAVE_BASELINE=1
    fi
  fi
  M_SWAP_LEVEL=$(swap_level "$MEM_AVAIL_PCT" "$SWAP_USED_PCT" "$SWAP_OUT_KBPS" "$SWAP_HAVE_BASELINE")
  log "swap: used=$(swap_used_label) swap_out=${SWAP_OUT_KBPS}KB/s baseline=${SWAP_HAVE_BASELINE} level=${M_SWAP_LEVEL}"
}

swap_used_label() {
  if [[ -z "${SWAP_USED_PCT:-}" || "$SWAP_USED_PCT" == "na" ]]; then
    printf '%s\n' none
    return 0
  fi
  printf '%s%%\n' "$SWAP_USED_PCT"
}

collect_load() {
  LOAD5=""
  NCPU=""
  if [[ -n "$LOADAVG_TEXT" ]]; then
    read -r _ LOAD5 _ <<<"$LOADAVG_TEXT"
  fi
  NCPU="${NPROC_TEXT:-}"
  M_LOAD_LEVEL=$(load_level "$LOAD5" "$NCPU")
  log "load: load5=${LOAD5:-unknown} ncpu=${NCPU:-unknown} level=${M_LOAD_LEVEL}"
}

growth_file_for() {
  local mount="$1"
  case "$mount" in
    /) printf '%s\n' "$STATE_DIR/growth.root" ;;
    /tmp) printf '%s\n' "$STATE_DIR/growth.tmp" ;;
    *) printf '%s\n' "$STATE_DIR/growth.other" ;;
  esac
}

# Compare used-GB against the oldest sample still inside the window, then
# append this tick. A 15-minute run can therefore see an hour of root growth
# (monitor 23168882) instead of only the last interval.
update_growth() {
  local mount="$1"
  local used_gb="$2"
  local threshold="$3"
  local window="$4"
  GROWTH_ACTION=skip
  GROWTH_LEVEL=ok
  GROWTH_DELTA=0
  GROWTH_ELAPSED=0
  local now_ts file tmp epoch used age dropped oldest_epoch oldest_used
  now_ts=$(alert_now)
  file=$(growth_file_for "$mount")
  mkdir -p "$STATE_DIR"
  tmp=$(mktemp "$STATE_DIR/growth-rewrite.XXXXXX")
  dropped=0
  oldest_epoch=""
  oldest_used=""
  if [[ -f "$file" ]]; then
    while read -r epoch used; do
      [[ "$epoch" =~ ^[0-9]+$ ]] || continue
      age=$((now_ts - epoch))
      if [[ "$age" -le 0 ]]; then
        continue
      fi
      if [[ "$age" -gt "$window" ]]; then
        dropped=$((dropped + 1))
        continue
      fi
      printf '%s %s\n' "$epoch" "$used" >> "$tmp"
      if [[ -z "$oldest_epoch" || "$epoch" -lt "$oldest_epoch" ]]; then
        oldest_epoch=$epoch
        oldest_used=$used
      fi
    done < "$file" || true
  fi
  printf '%s %s\n' "$now_ts" "$used_gb" >> "$tmp"
  mv "$tmp" "$file"
  if [[ -z "$oldest_epoch" ]]; then
    if [[ "$dropped" -gt 0 ]]; then
      GROWTH_ACTION=emit
      GROWTH_LEVEL=ok
      log "growth ${mount}: window reset"
      return 0
    fi
    log "growth ${mount}: baseline used=${used_gb}G"
    return 0
  fi
  local elapsed delta level
  elapsed=$((now_ts - oldest_epoch))
  delta=$(awk -v n="$used_gb" -v o="$oldest_used" 'BEGIN { printf "%.3f", (n+0)-(o+0) }')
  level=$(growth_level_from_delta "$threshold" "$window" "$delta" "$elapsed")
  if [[ "$level" == "stale" ]]; then
    level=ok
  fi
  GROWTH_ACTION=emit
  GROWTH_LEVEL=$level
  GROWTH_DELTA=$delta
  GROWTH_ELAPSED=$elapsed
  log "growth ${mount}: delta=${delta}G elapsed=${elapsed}s level=${level}"
}

collect_host_metrics() {
  read_metric_texts
  mkdir -p "$STATE_DIR"
  fill_mount_metrics "/" root ROOT || return 1
  fill_mount_metrics "/tmp" tmpfs TMP || return 1
  fill_mount_metrics "/dev/shm" tmpfs SHM || return 1
  fill_mount_metrics "/mnt/fleet-extra" extra EXTRA || return 1
  collect_memory
  collect_swap
  collect_load
  M_GROWTH_ROOT_ACTION=skip
  M_GROWTH_ROOT_LEVEL=ok
  M_GROWTH_TMP_ACTION=skip
  M_GROWTH_TMP_LEVEL=ok
  if [[ "${M_ROOT_LEVEL}" != "unknown" && -n "${M_ROOT_USED_GB:-}" ]]; then
    update_growth "/" "$M_ROOT_USED_GB" "$ROOT_GROWTH_GB" "$ROOT_GROWTH_WINDOW_SEC"
    M_GROWTH_ROOT_ACTION=$GROWTH_ACTION
    M_GROWTH_ROOT_LEVEL=$GROWTH_LEVEL
    M_GROWTH_ROOT_DELTA=$GROWTH_DELTA
    M_GROWTH_ROOT_ELAPSED=$GROWTH_ELAPSED
  fi
  if [[ "${M_TMP_LEVEL}" != "unknown" && -n "${M_TMP_USED_GB:-}" ]]; then
    update_growth "/tmp" "$M_TMP_USED_GB" "$TMP_GROWTH_GB" "$TMP_GROWTH_WINDOW_SEC"
    M_GROWTH_TMP_ACTION=$GROWTH_ACTION
    M_GROWTH_TMP_LEVEL=$GROWTH_LEVEL
    M_GROWTH_TMP_DELTA=$GROWTH_DELTA
    M_GROWTH_TMP_ELAPSED=$GROWTH_ELAPSED
  fi
}

parse_builder_cache() {
  local text="$1"
  BUILDER_CACHE_TOTAL=""
  BUILDER_CACHE_ACTIVE=""
  BUILDER_CACHE_SIZE=""
  BUILDER_CACHE_BYTES=0
  local line
  line=$(printf '%s\n' "$text" | awk '/Build Cache/ {print; exit}')
  if [[ -z "$line" ]]; then
    log "builder-cache: unknown"
    return 0
  fi
  read -r _ _ BUILDER_CACHE_TOTAL BUILDER_CACHE_ACTIVE BUILDER_CACHE_SIZE _ <<<"$line"
  if command -v numfmt >/dev/null 2>&1 && [[ -n "${BUILDER_CACHE_SIZE:-}" ]]; then
    BUILDER_CACHE_BYTES=$(numfmt --from=iec "$BUILDER_CACHE_SIZE" 2>/dev/null || echo 0)
  fi
  log "builder-cache: total=${BUILDER_CACHE_TOTAL:-unknown} active=${BUILDER_CACHE_ACTIVE:-unknown} size=${BUILDER_CACHE_SIZE:-unknown}"
}

report_sqlite() {
  local dir="$CT_DATA_DIR"
  if [[ ! -d "$dir" ]]; then
    log "sqlite: $dir absent"
    return 0
  fi
  local db wal shm kv
  db=$(stat -c%s "$dir/db.sqlite" 2>/dev/null || echo 0)
  wal=$(stat -c%s "$dir/db.sqlite-wal" 2>/dev/null || echo 0)
  shm=$(stat -c%s "$dir/db.sqlite-shm" 2>/dev/null || echo 0)
  kv=$(stat -c%s "$dir/kv.sqlite" 2>/dev/null || echo 0)
  log "sqlite: db=$(awk -v n="$db" 'BEGIN{printf "%.1fMiB", n/1024/1024}') wal=$(awk -v n="$wal" 'BEGIN{printf "%.1fMiB", n/1024/1024}') shm=$(awk -v n="$shm" 'BEGIN{printf "%.0fKiB", n/1024}') kv=$(awk -v n="$kv" 'BEGIN{printf "%.1fMiB", n/1024/1024}')"
}

report_docker() {
  local text=""
  if [[ -n "${HYGIENE_FIXTURE_DIR:-}" ]]; then
    text="${DOCKER_DF_TEXT:-}"
  elif command -v docker >/dev/null 2>&1; then
    text=$(docker system df 2>/dev/null || true)
  else
    log "docker: not installed"
    DOCKER_DF_TEXT=""
    return 0
  fi
  DOCKER_DF_TEXT="$text"
  if [[ -z "$text" ]]; then
    log "docker: system df empty"
    return 0
  fi
  printf '%s\n' "$text" | tee "$STATE_DIR/last-docker-df.txt" | while IFS= read -r line; do
    log "docker-df: $line"
  done || log "docker: system df failed"
}

report_builder_cache() {
  parse_builder_cache "${DOCKER_DF_TEXT:-}"
}

report_backup_dir() {
  if [[ ! -d "$BACKUP_DATA_DIR" ]]; then
    log "backups: $BACKUP_DATA_DIR absent"
    return 0
  fi
  local total
  total=$(du -sb "$BACKUP_DATA_DIR" 2>/dev/null | awk '{print $1}')
  log "backups: dir=$BACKUP_DATA_DIR size=$(awk -v n="${total:-0}" 'BEGIN{printf "%.1fGiB", n/1024/1024/1024}')"
}

prune_old_backups() {
  if [[ ! -d "$BACKUP_DATA_DIR" ]]; then
    return 0
  fi
  local keep_days=14
  if [[ "$DRY_RUN" == "1" ]]; then
    log "dry-run: prune backups in $BACKUP_DATA_DIR older than ${keep_days}d"
    return 0
  fi
  find "$BACKUP_DATA_DIR" -type f \( -name '*.db' -o -name '*.db.gz' -o -name '*.sqlite' \) -mtime +"${keep_days}" -print -delete 2>/dev/null | while IFS= read -r path; do
    log "backup-prune: deleted $path"
  done || true
}

prune_old_scratch() {
  if [[ ! -d "$SCRATCH_DATA_DIR" ]]; then
    return 0
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    log "dry-run: find $SCRATCH_DATA_DIR -mindepth 1 -mtime +7"
    return 0
  fi
  find "$SCRATCH_DATA_DIR" -mindepth 1 -mtime +7 -print -exec rm -rf {} + 2>/dev/null | while IFS= read -r path; do
    log "scratch-prune: removed $path"
  done || true
}

run_cmd() {
  if [[ "$DRY_RUN" == "1" ]]; then
    log "dry-run: $*"
    return 0
  fi
  log "run: $*"
  "$@" 2>&1 | while IFS= read -r line; do
    log "  $line"
  done || {
    log "warn: command failed: $*"
    return 1
  }
  return 0
}

refuse_volume_prune() {
  if [[ "${PRUNE_VOLUMES:-0}" == "1" ]]; then
    log "volume prune refused (named volumes are never pruned; PRUNE_VOLUMES is ignored)"
  fi
}

builder_prune_af_allowed() {
  if [[ ! "${BUILDER_CACHE_ACTIVE:-}" =~ ^[0-9]+$ ]]; then
    log "builder prune -af skipped (Build Cache ACTIVE unknown)"
    return 1
  fi
  if [[ "$BUILDER_CACHE_ACTIVE" != "0" ]]; then
    log "builder prune -af skipped (Build Cache ACTIVE=${BUILDER_CACHE_ACTIVE})"
    return 1
  fi
  return 0
}

cooldown_ok() {
  local f="$STATE_DIR/last_aggressive"
  local last now_ts
  now_ts=$(now)
  if [[ ! -f "$f" ]]; then
    return 0
  fi
  last=$(cat "$f" 2>/dev/null || echo 0)
  [[ $((now_ts - last)) -ge $AGGRESSIVE_COOLDOWN_SEC ]]
}

mark_aggressive() {
  echo "$(now)" >"$STATE_DIR/last_aggressive"
}

light_prune() {
  run_cmd docker image prune -f || true
  run_cmd docker builder prune -f --filter "until=${LIGHT_BUILDER_UNTIL}" || true
}

soft_prune() {
  if builder_prune_af_allowed; then
    run_cmd docker builder prune -af || true
  fi
  run_cmd docker image prune -af || true
  refuse_volume_prune
}

aggressive_prune() {
  if builder_prune_af_allowed; then
    run_cmd docker builder prune -af || true
  fi
  run_cmd docker image prune -af || true
  run_cmd docker container prune -f || true
  refuse_volume_prune
  run_cmd docker system prune -af || true
}

pushover_curl_config() {
  local t="${PUSHOVER_APP_TOKEN:-}" u="${PUSHOVER_USER_KEY:-}"
  case "$t$u" in
    *$'\n'*|*$'\r'*) return 1 ;;
  esac
  t=${t//\\/\\\\}; t=${t//\"/\\\"}
  u=${u//\\/\\\\}; u=${u//\"/\\\"}
  printf 'form-string = "token=%s"\nform-string = "user=%s"\n' "$t" "$u"
}

pushover_priority() {
  local severity="$1"
  if [[ "$severity" == "crit" ]]; then
    echo 1
    return 0
  fi
  echo 0
}

alert_webhook() {
  local body="$1"
  if [[ -z "$ALERT_WEBHOOK_URL" ]]; then
    return 0
  fi
  local payload
  payload=$(printf '{"text":"[%s] %s"}' "$LOG_TAG" "$body")
  curl -fsS -m 15 -X POST -H 'Content-Type: application/json' \
    -d "$payload" "$ALERT_WEBHOOK_URL" >/dev/null 2>&1 \
    || log "warn: alert webhook failed"
}

alert_pushover() {
  local severity="$1"
  local body="$2"
  if [[ -z "${PUSHOVER_APP_TOKEN:-}" || -z "${PUSHOVER_USER_KEY:-}" ]]; then
    return 0
  fi
  local title="Coolify host ${severity}"
  local _po_cfg pri
  if ! _po_cfg=$(pushover_curl_config); then
    log "warn: pushover config rejected (token/user contains CR/LF); notify skipped"
    return 0
  fi
  pri=$(pushover_priority "$severity")
  curl -fsS -m 15 \
    -K <(printf '%s\n' "$_po_cfg") \
    --form-string "title=${title}" \
    --form-string "message=${body}" \
    --form-string "priority=${pri}" \
    https://api.pushover.net/1/messages.json >/dev/null 2>&1 \
    || log "warn: pushover notify failed (curl exit $?; bad config or network)"
}

alert_warn() {
  local body="$1"
  log "ALERT warn: $body"
  alert_pushover warn "$body"
  alert_webhook "$body"
}

alert_critical() {
  local body="$1"
  log "ALERT critical: $body"
  alert_pushover crit "$body"
  alert_webhook "$body"
}

alert_recovery() {
  local body="$1"
  log "ALERT recovery: $body"
  alert_pushover recovery "$body"
  alert_webhook "$body"
}

disk_alert_suffix() {
  local cache_note="${BUILDER_CACHE_SIZE:-}"
  if [[ -z "$cache_note" ]]; then
    cache_note="${BUILDER_CACHE_BYTES:-0}"
  fi
  printf '(builder cache %s; check %s)' "${cache_note}" "$BACKUP_DATA_DIR"
}

alert_state_file() { printf '%s\n' "$STATE_DIR/alert-state.tsv"; }

alert_state_get() {
  local signal="$1"
  local file
  file=$(alert_state_file)
  [[ -f "$file" ]] || return 0
  awk -F '\t' -v s="$signal" '$1==s {print $2, $3; exit}' "$file"
}

alert_state_set() {
  local signal="$1"
  local level="$2"
  local epoch="$3"
  local file tmp
  file=$(alert_state_file)
  mkdir -p "$STATE_DIR"
  tmp=$(mktemp "$STATE_DIR/alert-state.XXXXXX")
  if [[ -f "$file" ]]; then
    awk -F '\t' -v s="$signal" '$1!=s' "$file" > "$tmp" || true
  fi
  printf '%s\t%s\t%s\n' "$signal" "$level" "$epoch" >> "$tmp"
  mv "$tmp" "$file"
}

alert_decision() {
  local signal="$1"
  local level="$2"
  local now_ts prev prev_level prev_ts
  now_ts=$(alert_now)
  prev_level=""
  prev_ts=0
  prev=$(alert_state_get "$signal" || true)
  if [[ -n "$prev" ]]; then
    read -r prev_level prev_ts <<<"$prev"
  fi
  if [[ ! "${prev_ts:-0}" =~ ^[0-9]+$ ]]; then
    prev_ts=0
  fi
  if [[ "$level" == "unknown" ]]; then
    alert_state_set "$signal" unknown "$prev_ts"
    echo suppress unknown
    return 0
  fi
  if [[ "$level" == "ok" ]]; then
    if [[ -z "$prev_level" || "$prev_level" == "ok" || "$prev_level" == "unknown" ]]; then
      alert_state_set "$signal" ok "$prev_ts"
      echo suppress ok-quiet
      return 0
    fi
    alert_state_set "$signal" ok "$now_ts"
    echo notify recovery
    return 0
  fi
  if [[ "$prev_level" != "$level" ]]; then
    alert_state_set "$signal" "$level" "$now_ts"
    echo notify change
    return 0
  fi
  if [[ $((now_ts - prev_ts)) -ge ${ALERT_REMINDER_SEC} ]]; then
    alert_state_set "$signal" "$level" "$now_ts"
    echo notify reminder
    return 0
  fi
  echo suppress same
}

emit_alert() {
  local signal="$1"
  local level="$2"
  local body="$3"
  local decision reason
  read -r decision reason < <(alert_decision "$signal" "$level")
  log "alert-decision signal=${signal} level=${level} decision=${decision} reason=${reason}"
  if [[ "$decision" != "notify" ]]; then
    return 0
  fi
  mkdir -p "$STATE_DIR"
  printf '%s\t%s\t%s\t%s\n' "$(alert_now)" "$signal" "$level" "$reason" >> "$STATE_DIR/notifications.log"
  case "$level" in
    crit) alert_critical "$body" ;;
    warn) alert_warn "$body" ;;
    ok) alert_recovery "$body" ;;
    *) log "alert: skip notify for level=${level}" ;;
  esac
}

emit_mount_signal() {
  local mount="$1"
  local prefix="$2"
  local level_var="M_${prefix}_LEVEL"
  local used_var="M_${prefix}_USED_PCT"
  local free_var="M_${prefix}_FREE_GB"
  local ilevel_var="M_${prefix}_INODE_LEVEL"
  local ipct_var="M_${prefix}_INODE_PCT"
  local level="${!level_var}"
  local used="${!used_var:-}"
  local free="${!free_var:-}"
  local ilevel="${!ilevel_var}"
  local ipct="${!ipct_var:-}"
  local host body ibody
  host=$(hostname)
  if [[ "$level" == "unknown" ]]; then
    body="mount ${mount} unmounted on ${host}"
  else
    body="mount ${mount} ${level} used=${used}% free=${free}G on ${host}"
  fi
  emit_alert "disk:${mount}" "$level" "$body"
  if [[ "$ilevel" == "unknown" ]]; then
    ibody="inodes ${mount} unknown on ${host}"
  else
    ibody="inodes ${mount} ${ilevel} use=${ipct}% on ${host}"
  fi
  emit_alert "inode:${mount}" "$ilevel" "$ibody"
}

emit_aux_alerts() {
  local host
  host=$(hostname)
  emit_mount_signal /tmp TMP
  emit_mount_signal /dev/shm SHM
  emit_mount_signal /mnt/fleet-extra EXTRA
  emit_alert "inode:/" "$M_ROOT_INODE_LEVEL" "inodes / ${M_ROOT_INODE_LEVEL} use=${M_ROOT_INODE_PCT:-unknown}% on ${host}"
  emit_alert mem "$M_MEM_LEVEL" "memory available ${MEM_AVAIL_PCT:-unknown}% on ${host} (warn below ${MEM_WARN_AVAIL_PCT}%, crit below ${MEM_CRIT_AVAIL_PCT}%)"
  emit_alert swap "$M_SWAP_LEVEL" "swap used=$(swap_used_label) swap_out=${SWAP_OUT_KBPS:-0}KB/s on ${host}"
  emit_alert load "$M_LOAD_LEVEL" "load5=${LOAD5:-unknown} ncpu=${NCPU:-unknown} on ${host} (warn ${LOAD_WARN_PER_CPU}/cpu, crit ${LOAD_CRIT_PER_CPU}/cpu)"
  if [[ "$M_GROWTH_ROOT_ACTION" == "emit" ]]; then
    emit_alert "growth:/" "$M_GROWTH_ROOT_LEVEL" "root growth delta=${M_GROWTH_ROOT_DELTA}G elapsed=${M_GROWTH_ROOT_ELAPSED}s on ${host} (warn ${ROOT_GROWTH_GB}G/${ROOT_GROWTH_WINDOW_SEC}s)"
  fi
  if [[ "$M_GROWTH_TMP_ACTION" == "emit" ]]; then
    emit_alert "growth:/tmp" "$M_GROWTH_TMP_LEVEL" "/tmp growth delta=${M_GROWTH_TMP_DELTA}G elapsed=${M_GROWTH_TMP_ELAPSED}s on ${host} (warn ${TMP_GROWTH_GB}G/${TMP_GROWTH_WINDOW_SEC}s)"
  fi
}

emit_root_alert() {
  local level="$1"
  local phase="$2"
  local host body
  host=$(hostname)
  if [[ "$phase" == "after" && "$level" == "crit" ]]; then
    body="disk STILL critical after reclaim used=${USED_PCT}% free=${FREE_GB}G on ${host} $(disk_alert_suffix). Needs a human if this repeats."
  elif [[ "$level" == "crit" ]]; then
    body="disk critical used=${USED_PCT}% free=${FREE_GB}G on ${host} $(disk_alert_suffix)"
  elif [[ "$level" == "warn" ]]; then
    body="disk warn used=${USED_PCT}% free=${FREE_GB}G on ${host} $(disk_alert_suffix)"
  else
    body="disk recovered used=${USED_PCT}% free=${FREE_GB}G on ${host}"
  fi
  emit_alert "disk:/" "$level" "$body"
}

write_status() {
  local before="$1"
  local after="$2"
  echo "$after" >"$STATE_DIR/last_level"
  printf '%s used=%s free=%sG level_before=%s level_after=%s mem=%s swap=%s load=%s extra=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${USED_PCT:-}" "${FREE_GB:-}" "$before" "$after" \
    "${M_MEM_LEVEL:-unknown}" "${M_SWAP_LEVEL:-unknown}" "${M_LOAD_LEVEL:-unknown}" "${M_EXTRA_LEVEL:-unknown}" \
    >"$STATE_DIR/last-status"
}

apply_prune() {
  local level="$1"
  case "$level" in
    ok)
      light_prune
      ;;
    warn)
      prune_old_backups
      prune_old_scratch
      if cooldown_ok; then
        soft_prune
        mark_aggressive
      else
        log "soft prune: skipped (cooldown ${AGGRESSIVE_COOLDOWN_SEC}s)"
        light_prune
      fi
      ;;
    crit)
      prune_old_backups
      prune_old_scratch
      if cooldown_ok; then
        aggressive_prune
        mark_aggressive
      else
        log "aggressive prune: skipped (cooldown ${AGGRESSIVE_COOLDOWN_SEC}s); soft path"
        soft_prune
      fi
      ;;
    *)
      log "prune: skipped (root level ${level})"
      ;;
  esac
}

main() {
  mkdir -p "$STATE_DIR"
  log "start root=$ROOT_PATH warn=${WARN_USED_PCT}%/${WARN_FREE_GB}G crit=${CRIT_USED_PCT}%/${CRIT_FREE_GB}G dry_run=$DRY_RUN reminder=${ALERT_REMINDER_SEC}s"
  collect_host_metrics || return 1
  log "disk: path=/ used=${USED_PCT}% (${USED_GB}G/${TOTAL_GB}G) free=${FREE_GB}G level=${M_ROOT_LEVEL}"
  report_sqlite
  report_backup_dir
  report_docker
  report_builder_cache
  emit_aux_alerts

  local root_level="$M_ROOT_LEVEL"
  if is_deploy_active; then
    log "prune: skipped (Coolify build/deploy active)"
    emit_root_alert "$root_level" "live"
    write_status "$root_level" "$root_level"
    log "done level_before=$root_level level_after=$root_level deploy_active=1"
    return 0
  fi

  apply_prune "$root_level"
  fill_mount_metrics "/" root ROOT || return 1
  local level_after="$M_ROOT_LEVEL"
  log "disk-after: used=${USED_PCT}% free=${FREE_GB}G level=${level_after}"
  report_docker
  emit_root_alert "$level_after" "after"
  write_status "$root_level" "$level_after"
  log "done level_before=$root_level level_after=$level_after"
}

if [[ "${HYGIENE_LIB_ONLY:-0}" != "1" ]]; then
  load_host_env
  main "$@"
fi
