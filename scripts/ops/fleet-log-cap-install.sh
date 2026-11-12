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

log() {
  printf '%s\n' "$*"
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

merge_daemon_json() {
  local in_path="$1"
  local existing='{}'
  if [[ -f "$in_path" ]] && [[ -s "$in_path" ]]; then
    if ! existing="$("$JQ_CMD" -c . "$in_path" 2>/dev/null)" || [[ -z "$existing" ]]; then
      die "cannot parse ${in_path} as JSON (fix or remove before install)"
    fi
  fi
  printf '%s' "$existing" | "$JQ_CMD" -c '
    ."log-driver" = "json-file"
    | ."log-opts" = ((."log-opts" // {}) + {"max-size": "50m", "max-file": "3"})
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
    log "daemon.json already has fleet log caps (no change)"
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
