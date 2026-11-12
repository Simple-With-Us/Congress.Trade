#!/usr/bin/env bash
# Idempotent Docker log defaults + journald drop-in for Hetzner fleet box (CT-2483).
#
# Default is dry-run.  Host writes require APPLY=1 (root on the Coolify host).
# Never restarts Docker.  Prints a reminder that daemon defaults need a Docker
# restart (Jay approval) before existing/new containers pick them up.
#
#   APPLY=1 bash scripts/ops/fleet-log-cap-install.sh
#
# Overrides for tests:
#   DAEMON_JSON_PATH
#   JOURNALD_DROPIN_SRC
#   JOURNALD_DROPIN_DEST
#   JQ_CMD
#   INSTALL_CMD       default install
#   SYSTEMCTL_CMD     default systemctl
#   JOURNALCTL_CMD    default journalctl
#   DATE_CMD          default date
#   FLEET_LOG_MAX_SIZE  default 10m (fleet json-file max-size)
#   FLEET_LOG_MAX_FILE  default 3   (fleet json-file max-file)
#
# FLEET_LOG_MAX_SIZE / FLEET_LOG_MAX_FILE change the fleet target itself.  The
# never-loosen check only compares against the host's existing daemon.json, so
# raising them above 10m / 3 with APPLY=1 installs a looser cap on a host that
# has none.  Leave them unset outside tests.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
APPLY="${APPLY:-0}"
DAEMON_JSON_PATH="${DAEMON_JSON_PATH:-/etc/docker/daemon.json}"
JOURNALD_DROPIN_SRC="${JOURNALD_DROPIN_SRC:-${ROOT_DIR}/scripts/ops/journald.conf.d/fleet-journal-cap.conf}"
JOURNALD_DROPIN_DEST="${JOURNALD_DROPIN_DEST:-/etc/systemd/journald.conf.d/fleet-journal-cap.conf}"
JQ_CMD="${JQ_CMD:-jq}"
INSTALL_CMD="${INSTALL_CMD:-install}"
SYSTEMCTL_CMD="${SYSTEMCTL_CMD:-systemctl}"
JOURNALCTL_CMD="${JOURNALCTL_CMD:-journalctl}"
DATE_CMD="${DATE_CMD:-date}"
FLEET_LOG_MAX_SIZE="${FLEET_LOG_MAX_SIZE:-10m}"
FLEET_LOG_MAX_FILE="${FLEET_LOG_MAX_FILE:-3}"

log() {
  printf '%s\n' "$*"
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

# Convert a Docker json-file max-size to bytes for comparison.  Accepts the
# same forms as Docker's units.RAMInBytes: an integer or decimal number, an
# optional space, an optional k/m/g/t/p unit, and an optional "b"/"ib" tail
# (10m, 50M, 1.5g, 10mb, 10MiB, 1t, 512k, 2048).  Units are binary (1024).
# Prints nothing and returns 2 for a value it cannot parse, so callers can keep
# an existing host value they do not understand instead of aborting.
log_max_size_bytes() {
  local raw="${1:-}"
  local n unit mul
  raw="${raw#"${raw%%[![:space:]]*}"}"
  raw="${raw%"${raw##*[![:space:]]}"}"
  if [[ -z "$raw" ]]; then
    printf '%s' ''
    return 0
  fi
  if [[ ! "$raw" =~ ^([0-9]+(\.[0-9]+)?)\ ?([kKmMgGtTpP])?([iI]?[bB])?$ ]]; then
    return 2
  fi
  n="${BASH_REMATCH[1]}"
  unit="${BASH_REMATCH[3]:-}"
  case "${unit,,}" in
    '') mul=1 ;;
    k) mul=1024 ;;
    m) mul=1048576 ;;
    g) mul=1073741824 ;;
    t) mul=1099511627776 ;;
    p) mul=1125899906842624 ;;
  esac
  awk -v n="$n" -v m="$mul" 'BEGIN { printf "%.0f", n * m }'
}

log_max_file_int() {
  local raw="${1:-}"
  raw="${raw//[[:space:]]/}"
  if [[ -z "$raw" ]]; then
    printf '%s' ''
    return 0
  fi
  if [[ ! "$raw" =~ ^[0-9]+$ ]]; then
    die "unsupported log max-file value: ${raw}"
  fi
  printf '%s' "$raw"
}

# Existing max-file as an integer.  When log-opts sets max-size but no
# max-file, Docker's json-file driver keeps one file, so that counts as 1.
# Empty only when there is no max-size cap at all (logs are unbounded).
existing_max_file() {
  local json="$1" file size
  file="$(log_max_file_int "$("$JQ_CMD" -r '."log-opts"."max-file" // empty' <<<"$json")")"
  if [[ -z "$file" ]]; then
    size="$("$JQ_CMD" -r '."log-opts"."max-size" // empty' <<<"$json")"
    if [[ -n "$size" ]]; then
      file=1
    fi
  fi
  printf '%s' "$file"
}

# Tightest cap per axis: never above fleet default, never above existing (no loosening).
effective_log_opts_json() {
  local existing_json="$1"
  local fleet_size_bytes fleet_file fleet_size existing_size_bytes existing_file
  local eff_size_bytes eff_file eff_size_human

  fleet_size_bytes="$(log_max_size_bytes "$FLEET_LOG_MAX_SIZE")" || die "unsupported FLEET_LOG_MAX_SIZE: ${FLEET_LOG_MAX_SIZE}"
  fleet_file="$(log_max_file_int "$FLEET_LOG_MAX_FILE")"

  existing_size="$("$JQ_CMD" -r '."log-opts"."max-size" // empty' <<<"$existing_json")"
  existing_file="$(existing_max_file "$existing_json")"
  if [[ -n "$existing_size" ]]; then
    existing_size_bytes="$(log_max_size_bytes "$existing_size")" || existing_size_bytes='unparseable'
  else
    existing_size_bytes=''
  fi

  if [[ "$existing_size_bytes" == "unparseable" ]]; then
    # Docker accepted a value this script cannot read; keep it untouched.
    log "WARNING: keeping existing log max-size '${existing_size}' (cannot compare it)" >&2
    eff_size_bytes=''
  elif [[ -n "$existing_size_bytes" ]]; then
    if (( existing_size_bytes < fleet_size_bytes )); then
      eff_size_bytes="$existing_size_bytes"
    else
      eff_size_bytes="$fleet_size_bytes"
    fi
  else
    eff_size_bytes="$fleet_size_bytes"
  fi

  if [[ -n "$existing_file" ]]; then
    if (( existing_file < fleet_file )); then
      eff_file="$existing_file"
    else
      eff_file="$fleet_file"
    fi
  else
    eff_file="$fleet_file"
  fi

  if [[ -z "$eff_size_bytes" ]] || [[ "$eff_size_bytes" == "$existing_size_bytes" && "$eff_size_bytes" != "$fleet_size_bytes" ]]; then
    eff_size_human="$existing_size"
  else
    eff_size_human="$FLEET_LOG_MAX_SIZE"
  fi

  "$JQ_CMD" -cn --arg max_size "$eff_size_human" --argjson max_file "$eff_file" \
    '{"max-size": $max_size, "max-file": ($max_file|tostring)}'
}

existing_cap_tighter_or_equal_than_fleet() {
  local existing_json="$1"
  local existing_size existing_file sz_bytes fleet_bytes fleet_file file_n

  existing_size="$("$JQ_CMD" -r '."log-opts"."max-size" // empty' <<<"$existing_json")"
  existing_file="$(existing_max_file "$existing_json")"
  fleet_bytes="$(log_max_size_bytes "$FLEET_LOG_MAX_SIZE")" || die "unsupported FLEET_LOG_MAX_SIZE: ${FLEET_LOG_MAX_SIZE}"
  fleet_file="$(log_max_file_int "$FLEET_LOG_MAX_FILE")"

  if [[ -z "$existing_size" ]] || [[ -z "$existing_file" ]]; then
    return 1
  fi
  sz_bytes="$(log_max_size_bytes "$existing_size")" || return 1
  file_n="$existing_file"
  (( sz_bytes <= fleet_bytes )) && (( file_n <= fleet_file ))
}

merged_loosens_existing_caps() {
  local current_json="$1" merged_json="$2"
  local cur_sz cur_file mrg_sz mrg_file cur_b mrg_b

  cur_sz="$("$JQ_CMD" -r '."log-opts"."max-size" // empty' <<<"$current_json")"
  cur_file="$(existing_max_file "$current_json")"
  mrg_sz="$("$JQ_CMD" -r '."log-opts"."max-size" // empty' <<<"$merged_json")"
  mrg_file="$(log_max_file_int "$("$JQ_CMD" -r '."log-opts"."max-file" // empty' <<<"$merged_json")")"

  if [[ -n "$cur_sz" ]]; then
    if ! cur_b="$(log_max_size_bytes "$cur_sz")"; then
      # Unreadable existing size: only an unchanged value is safe.
      [[ "$mrg_sz" != "$cur_sz" ]] && return 0
    else
      mrg_b="$(log_max_size_bytes "$mrg_sz")" || return 0
      if (( mrg_b > cur_b )); then
        return 0
      fi
    fi
  fi
  if [[ -n "$cur_file" ]] && (( mrg_file > cur_file )); then
    return 0
  fi
  return 1
}

merge_daemon_json() {
  local in_path="$1"
  local existing='{}'
  if [[ -f "$in_path" ]] && [[ -s "$in_path" ]]; then
    if ! existing="$("$JQ_CMD" -c . "$in_path" 2>/dev/null)"; then
      die "cannot parse ${in_path} as JSON (fix or remove before install)"
    fi
    if [[ -z "$existing" ]]; then
      existing='{}'
    fi
  fi
  local log_opts
  log_opts="$(effective_log_opts_json "$existing")"
  printf '%s' "$existing" | "$JQ_CMD" -c --argjson log_opts "$log_opts" '
    ."log-driver" = "json-file"
    | ."log-opts" = ((."log-opts" // {}) + $log_opts)
  '
}

canonical_json() {
  "$JQ_CMD" -c -S .
}

install_docker_daemon_json() {
  log "=== Docker daemon.json ==="
  local merged current_dir backup
  merged="$(merge_daemon_json "$DAEMON_JSON_PATH")"
  if ! printf '%s' "$merged" | "$JQ_CMD" empty 2>/dev/null; then
    die "merged daemon.json failed JSON validation"
  fi

  local want current
  want="$(printf '%s' "$merged" | canonical_json)"
  if [[ -f "$DAEMON_JSON_PATH" ]] && [[ -s "$DAEMON_JSON_PATH" ]]; then
    if ! current="$(canonical_json <"$DAEMON_JSON_PATH" 2>/dev/null)"; then
      current=''
    fi
  else
    current=''
  fi

  if [[ "$want" == "$current" ]]; then
    if [[ -n "$current" ]] && existing_cap_tighter_or_equal_than_fleet "$current"; then
      log "daemon.json log caps are already at or below fleet defaults (${FLEET_LOG_MAX_SIZE} / ${FLEET_LOG_MAX_FILE}); skipping (will not loosen)"
    else
      log "daemon.json already has fleet log caps (no change)"
    fi
  elif [[ -n "$current" ]] && merged_loosens_existing_caps "$current" "$merged"; then
    log "daemon.json already has tighter log caps than fleet defaults; refusing to loosen — no write"
  else
    log "planned daemon.json:"
    printf '%s\n' "$merged" | "$JQ_CMD" .
    if [[ "$APPLY" == "1" ]]; then
      current_dir="$(dirname "$DAEMON_JSON_PATH")"
      mkdir -p "$current_dir"
      if [[ -f "$DAEMON_JSON_PATH" ]]; then
        backup="${DAEMON_JSON_PATH}.bak.$("$DATE_CMD" -u +%Y%m%dT%H%M%SZ)"
        cp -a "$DAEMON_JSON_PATH" "$backup"
        log "backed up to ${backup}"
      fi
      tmp="$(mktemp "${DAEMON_JSON_PATH}.XXXXXX")"
      printf '%s\n' "$merged" | "$JQ_CMD" . >"$tmp"
      "$JQ_CMD" empty <"$tmp"
      chmod 0644 "$tmp"
      mv -f "$tmp" "$DAEMON_JSON_PATH"
      log "wrote ${DAEMON_JSON_PATH}"
    else
      log "DRY_RUN: would write ${DAEMON_JSON_PATH} (set APPLY=1 to apply)"
    fi
  fi

  log ""
  log "NOTE: Docker was NOT restarted by this script."
  log "NOTE: json-file max-size/max-file defaults apply to new containers after Docker restarts."
  log "NOTE: Restarting Docker on the fleet host requires Jay's explicit approval."
}

reload_journald_light() {
  if [[ "$APPLY" != "1" ]]; then
    log "DRY_RUN: would signal systemd-journald (SIGUSR2) or run journalctl --vacuum-size=1G"
    return 0
  fi
  if "$SYSTEMCTL_CMD" kill --kill-who=main --signal=SIGUSR2 systemd-journald 2>/dev/null; then
    log "signaled systemd-journald (SIGUSR2) for log rotation"
    return 0
  fi
  log "SIGUSR2 unavailable; running journalctl --vacuum-size=1G (best-effort)"
  if ! "$JOURNALCTL_CMD" --vacuum-size=1G; then
    log "WARNING: journalctl --vacuum-size=1G failed (drop-in still installed)"
  fi
}

install_journald_dropin() {
  log "=== journald drop-in ==="
  if [[ ! -f "$JOURNALD_DROPIN_SRC" ]]; then
    die "missing source drop-in: ${JOURNALD_DROPIN_SRC}"
  fi

  local dest_dir
  dest_dir="$(dirname "$JOURNALD_DROPIN_DEST")"
  if [[ -f "$JOURNALD_DROPIN_DEST" ]] && cmp -s "$JOURNALD_DROPIN_SRC" "$JOURNALD_DROPIN_DEST"; then
    log "${JOURNALD_DROPIN_DEST} already matches repo (no copy needed)"
  else
    if [[ "$APPLY" == "1" ]]; then
      mkdir -p "$dest_dir"
      "$INSTALL_CMD" -m 0644 "$JOURNALD_DROPIN_SRC" "$JOURNALD_DROPIN_DEST"
      log "installed ${JOURNALD_DROPIN_DEST}"
    else
      log "DRY_RUN: would install ${JOURNALD_DROPIN_SRC} -> ${JOURNALD_DROPIN_DEST}"
    fi
  fi

  reload_journald_light
  log ""
  log "NOTE: journald drop-in caps apply after systemd-journald restart."
  log "NOTE: Full journald restart is out of scope for this script (Jay approval)."
}

main() {
  if [[ "$APPLY" == "1" ]]; then
    log "MODE: APPLY"
  else
    log "MODE: DRY_RUN (set APPLY=1 on the host to write)"
  fi
  install_docker_daemon_json
  echo
  install_journald_dropin
}

main "$@"
