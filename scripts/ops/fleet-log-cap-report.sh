#!/usr/bin/env bash
# Read-only report: Docker container json-log sizes, journald disk use, daemon log settings.
#
#   bash scripts/ops/fleet-log-cap-report.sh
#
# Overrides for tests:
#   DOCKER_CMD          default docker
#   JOURNALCTL_CMD      default journalctl
#   DAEMON_JSON_PATH    default /etc/docker/daemon.json
#   JQ_CMD              default jq

set -euo pipefail

DOCKER_CMD="${DOCKER_CMD:-docker}"
JOURNALCTL_CMD="${JOURNALCTL_CMD:-journalctl}"
DAEMON_JSON_PATH="${DAEMON_JSON_PATH:-/etc/docker/daemon.json}"
JQ_CMD="${JQ_CMD:-jq}"

human_bytes() {
  local n="${1:-0}"
  if command -v numfmt >/dev/null 2>&1; then
    numfmt --to=iec-i --suffix=B "$n" 2>/dev/null || printf '%s B' "$n"
  else
    printf '%s B' "$n"
  fi
}

file_bytes() {
  local path="$1"
  if [[ ! -e "$path" ]]; then
    printf '0'
    return 0
  fi
  stat -c '%s' "$path" 2>/dev/null || stat -f '%z' "$path" 2>/dev/null || printf '0'
}

print_daemon_json() {
  echo "=== Docker daemon.json (${DAEMON_JSON_PATH}) ==="
  if [[ ! -f "$DAEMON_JSON_PATH" ]]; then
    echo "log-driver: (missing file; Docker defaults)"
    echo "log-opts: (missing file)"
    return 0
  fi
  if ! "$JQ_CMD" -e . "$DAEMON_JSON_PATH" >/dev/null 2>&1; then
    echo "ERROR: ${DAEMON_JSON_PATH} is not valid JSON"
    return 1
  fi
  local driver opts
  driver="$("$JQ_CMD" -r '."log-driver" // "(unset)"' "$DAEMON_JSON_PATH")"
  opts="$("$JQ_CMD" -r '."log-opts" // {} | if length == 0 then "(unset)" else to_entries | map("\(.key)=\(.value)") | join(" ") end' "$DAEMON_JSON_PATH")"
  echo "log-driver: ${driver}"
  echo "log-opts: ${opts}"
}

print_docker_info() {
  echo "=== Docker runtime (docker info) ==="
  if ! command -v "${DOCKER_CMD%% *}" >/dev/null 2>&1; then
    echo "docker: command not available"
    return 0
  fi
  local driver
  driver="$("$DOCKER_CMD" info -f '{{.LoggingDriver}}' 2>/dev/null || echo '(unknown)')"
  echo "logging driver: ${driver}"
}

echo "=== Docker container json logs ==="
total=0
if mapfile -t ids < <("$DOCKER_CMD" ps -aq 2>/dev/null); then
  if ((${#ids[@]} == 0)); then
    echo "(no containers)"
  else
    printf '%-14s %-40s %12s  %s\n' "CONTAINER_ID" "NAME" "BYTES" "LOG_PATH"
    for id in "${ids[@]}"; do
      [[ -z "$id" ]] && continue
      name="$("$DOCKER_CMD" inspect -f '{{.Name}}' "$id" 2>/dev/null | sed 's#^/##')"
      log_path="$("$DOCKER_CMD" inspect -f '{{.LogPath}}' "$id" 2>/dev/null || true)"
      bytes=0
      if [[ -n "$log_path" ]]; then
        bytes="$(file_bytes "$log_path")"
      fi
      total=$((total + bytes))
      printf '%-14s %-40s %12s  %s\n' "$id" "${name:-?}" "$(human_bytes "$bytes")" "${log_path:-}"
    done
  fi
else
  echo "WARN: could not list containers ($DOCKER_CMD ps -aq failed)"
fi
echo "total_container_log_bytes: ${total} ($(human_bytes "$total"))"
echo

if ! "$JOURNALCTL_CMD" --disk-usage 2>/dev/null; then
  echo "=== journald ==="
  echo "WARN: journalctl --disk-usage failed"
fi
echo

print_daemon_json
echo
print_docker_info
