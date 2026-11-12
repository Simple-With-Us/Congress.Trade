#!/usr/bin/env bash
# Offline tests for fleet-log-cap-report.sh and fleet-log-cap-install.sh.
# No Docker daemon, no journald, no network.
#
#   bash scripts/ops/test-fleet-log-cap.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REPORT="${ROOT}/scripts/ops/fleet-log-cap-report.sh"
INSTALL="${ROOT}/scripts/ops/fleet-log-cap-install.sh"
DROPIN_SRC="${ROOT}/scripts/ops/journald.conf.d/fleet-journal-cap.conf"
fail=0

assert_eq() {
  local got="$1" want="$2" name="$3"
  if [[ "$got" != "$want" ]]; then
    echo "FAIL ${name}: got '${got}' want '${want}'"
    fail=1
  else
    echo "ok   ${name}"
  fi
}

assert_contains() {
  local hay="$1" needle="$2" name="$3"
  if ! printf '%s' "$hay" | grep -qF -- "$needle"; then
    echo "FAIL ${name}: missing '${needle}'"
    fail=1
  else
    echo "ok   ${name}"
  fi
}

assert_not_contains() {
  local hay="$1" needle="$2" name="$3"
  if printf '%s' "$hay" | grep -qF -- "$needle"; then
    echo "FAIL ${name}: unexpectedly contains '${needle}'"
    fail=1
  else
    echo "ok   ${name}"
  fi
}

assert_file_exists() {
  local path="$1" name="$2"
  if [[ -f "$path" ]]; then
    echo "ok   ${name}"
  else
    echo "FAIL ${name}: missing ${path}"
    fail=1
  fi
}

TMP="$(mktemp -d "${TMPDIR:-/tmp}/fleet-log-cap-test.XXXXXX")"
MOCK_BIN="${TMP}/mock-bin"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$MOCK_BIN" "${TMP}/var/log/docker" "${TMP}/journald.d"

# --- mock docker / journalctl / systemctl ------------------------------------
cat >"${MOCK_BIN}/docker" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  ps)
    if [[ "${2:-}" == "-aq" ]]; then
      echo "aaa111"
      echo "bbb222"
    fi
    ;;
  inspect)
    shift
    fmt=""
    id=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        -f) fmt="$2"; shift 2 ;;
        *) id="$1"; shift ;;
      esac
    done
  case "$fmt" in
    '{{.Name}}')
      case "$id" in
        aaa111) echo "/web" ;;
        bbb222) echo "/db" ;;
        *) echo "/unknown" ;;
      esac
      ;;
    '{{.LogPath}}')
      case "$id" in
        aaa111) echo "${MOCK_LOG_ROOT:-/tmp}/aaa111-json.log" ;;
        bbb222) echo "${MOCK_LOG_ROOT:-/tmp}/bbb222-json.log" ;;
        *) echo "" ;;
      esac
      ;;
    esac
    ;;
  info)
    shift
    if [[ "${1:-}" == "-f" && "${2:-}" == '{{.LoggingDriver}}' ]]; then
      echo "json-file"
    fi
    ;;
  *)
    echo "unexpected docker args: $*" >&2
    exit 2
    ;;
esac
MOCK
chmod +x "${MOCK_BIN}/docker"

export MOCK_LOG_ROOT="${TMP}/var/log/docker"
printf 'x%.0s' {1..100} >"${MOCK_LOG_ROOT}/aaa111-json.log"
printf 'y%.0s' {1..200} >"${MOCK_LOG_ROOT}/bbb222-json.log"

cat >"${MOCK_BIN}/journalctl" <<'MOCK'
#!/usr/bin/env bash
if [[ "${1:-}" == "--disk-usage" ]]; then
  echo "Archived and active journals take up 512.0M in the file system."
fi
MOCK
chmod +x "${MOCK_BIN}/journalctl"

SYSTEMCTL_LOG="${TMP}/systemctl.log"
: >"$SYSTEMCTL_LOG"
cat >"${MOCK_BIN}/systemctl" <<MOCK
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"${SYSTEMCTL_LOG}"
exit 0
MOCK
chmod +x "${MOCK_BIN}/systemctl"

cat >"${MOCK_BIN}/install" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
mode=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -m) mode="$2"; shift 2 ;;
    *) break ;;
  esac
done
src="$1"
dest="$2"
cp "$src" "$dest"
if [[ -n "$mode" ]]; then
  chmod "$mode" "$dest"
fi
MOCK
chmod +x "${MOCK_BIN}/install"

export PATH="${MOCK_BIN}:${PATH}"

if ! command -v jq >/dev/null 2>&1; then
  echo "FAIL jq is required for offline tests"
  exit 1
fi

# --- report ------------------------------------------------------------------
DAEMON_JSON="${TMP}/daemon.json"
printf '%s\n' '{"storage-driver":"overlay2","log-driver":"json-file","log-opts":{"max-size":"10m"}}' >"$DAEMON_JSON"

report_out="$(DOCKER_CMD=docker JOURNALCTL_CMD=journalctl DAEMON_JSON_PATH="$DAEMON_JSON" bash "$REPORT")"
assert_contains "$report_out" "total_container_log_bytes: 300" "report sums mock log sizes"
assert_contains "$report_out" "aaa111" "report lists container aaa111"
assert_contains "$report_out" "logging driver: json-file" "report docker info driver"
assert_contains "$report_out" "Archived and active journals" "report journald disk usage"

# --- empty daemon.json merges as {} ------------------------------------------
EMPTY_DAEMON="${TMP}/etc/docker/empty-daemon.json"
mkdir -p "$(dirname "$EMPTY_DAEMON")"
: >"$EMPTY_DAEMON"
APPLY=1 DAEMON_JSON_PATH="$EMPTY_DAEMON" JOURNALD_DROPIN_SRC="$DROPIN_SRC" JOURNALD_DROPIN_DEST="${TMP}/empty-journald.conf" SYSTEMCTL_CMD=systemctl INSTALL_CMD=install bash "$INSTALL" >/dev/null
assert_eq "$(jq -r '."log-opts"."max-size"' <"$EMPTY_DAEMON")" "50m" "empty daemon.json file gets log caps"

# --- journalctl vacuum failure does not abort install ----------------------
VAC_FAIL_LOG="${TMP}/journalctl-fail.log"
cat >"${MOCK_BIN}/journalctl-fail" <<'MOCK'
#!/usr/bin/env bash
case "$1" in
  --vacuum-size|--vacuum-size=*) exit 1 ;;
esac
exec journalctl "$@"
MOCK
chmod +x "${MOCK_BIN}/journalctl-fail"
VAC_DAEMON="${TMP}/vac/daemon.json"
mkdir -p "$(dirname "$VAC_DAEMON")"
printf '{"storage-driver":"overlay2"}\n' >"$VAC_DAEMON"
VAC_DEST="${TMP}/vac-journald.conf"
if APPLY=1 DAEMON_JSON_PATH="$VAC_DAEMON" JOURNALD_DROPIN_SRC="$DROPIN_SRC" JOURNALD_DROPIN_DEST="$VAC_DEST" SYSTEMCTL_CMD=/bin/false JOURNALCTL_CMD=journalctl-fail INSTALL_CMD=install bash "$INSTALL" | tee "$VAC_FAIL_LOG"; then
  echo "ok   install succeeds when vacuum fails"
else
  echo "FAIL install should not exit non-zero when vacuum fails"
  fail=1
fi
assert_contains "$(cat "$VAC_FAIL_LOG")" "WARNING: journalctl --vacuum-size=1G failed" "vacuum failure is warning only"

# --- install dry-run ---------------------------------------------------------
INSTALL_DAEMON="${TMP}/etc/docker/daemon.json"
mkdir -p "$(dirname "$INSTALL_DAEMON")"
printf '%s\n' '{"storage-driver":"overlay2","features":{"cdi":true}}' >"$INSTALL_DAEMON"
JOURNALD_DEST="${TMP}/journald.d/fleet-journal-cap.conf"

dry_out="$(APPLY=0 DAEMON_JSON_PATH="$INSTALL_DAEMON" JOURNALD_DROPIN_SRC="$DROPIN_SRC" JOURNALD_DROPIN_DEST="$JOURNALD_DEST" SYSTEMCTL_CMD=systemctl bash "$INSTALL")"
assert_contains "$dry_out" "MODE: DRY_RUN" "install defaults to dry run"
assert_contains "$dry_out" "DRY_RUN: would write" "dry run does not claim write"
assert_not_contains "$dry_out" "wrote ${INSTALL_DAEMON}" "dry run leaves daemon.json bytes"
before="$(cat "$INSTALL_DAEMON")"
sleep 1
APPLY=0 DAEMON_JSON_PATH="$INSTALL_DAEMON" JOURNALD_DROPIN_SRC="$DROPIN_SRC" JOURNALD_DROPIN_DEST="$JOURNALD_DEST" SYSTEMCTL_CMD=systemctl bash "$INSTALL" >/dev/null
after="$(cat "$INSTALL_DAEMON")"
assert_eq "$before" "$after" "dry run does not mutate daemon.json"

# --- install apply -----------------------------------------------------------
apply_out="$(APPLY=1 DAEMON_JSON_PATH="$INSTALL_DAEMON" JOURNALD_DROPIN_SRC="$DROPIN_SRC" JOURNALD_DROPIN_DEST="$JOURNALD_DEST" SYSTEMCTL_CMD=systemctl INSTALL_CMD=install bash "$INSTALL")"
assert_contains "$apply_out" "MODE: APPLY" "apply mode header"
assert_contains "$apply_out" "backed up to" "apply backs up existing daemon.json"
assert_contains "$apply_out" "NOT restarted" "apply reminds no docker restart"

merged="$(jq -c . "$INSTALL_DAEMON")"
assert_eq "$(jq -r '."log-driver"' <<<"$merged")" "json-file" "merge sets log-driver"
assert_eq "$(jq -r '."log-opts"."max-size"' <<<"$merged")" "50m" "merge sets max-size"
assert_eq "$(jq -r '."log-opts"."max-file"' <<<"$merged")" "3" "merge sets max-file"
assert_eq "$(jq -r '."storage-driver"' <<<"$merged")" "overlay2" "merge keeps storage-driver"
assert_eq "$(jq -r '.features.cdi' <<<"$merged")" "true" "merge keeps unrelated keys"

assert_file_exists "$JOURNALD_DEST" "apply copies journald drop-in"
grep -q 'SystemMaxUse=1G' "$JOURNALD_DEST" && echo "ok   drop-in SystemMaxUse" || { echo "FAIL drop-in SystemMaxUse"; fail=1; }

if grep -q 'SIGUSR2' "$SYSTEMCTL_LOG"; then
  echo "ok   apply signals journald via systemctl"
else
  echo "FAIL apply should signal journald"
  fail=1
fi

assert_not_contains "$(tr '\n' ' ' <"$SYSTEMCTL_LOG")" "restart" "systemctl mock does not restart services"

# --- idempotent re-apply -----------------------------------------------------
APPLY=1 DAEMON_JSON_PATH="$INSTALL_DAEMON" JOURNALD_DROPIN_SRC="$DROPIN_SRC" JOURNALD_DROPIN_DEST="$JOURNALD_DEST" SYSTEMCTL_CMD=systemctl INSTALL_CMD=install bash "$INSTALL" >"${TMP}/reapply.out"
assert_contains "$(cat "${TMP}/reapply.out")" "already has fleet log caps" "second apply is idempotent for docker"
assert_contains "$(cat "${TMP}/reapply.out")" "already matches repo" "second apply idempotent journald copy"

# --- merge on missing file ---------------------------------------------------
MISSING_DAEMON="${TMP}/fresh/daemon.json"
mkdir -p "$(dirname "$MISSING_DAEMON")"
APPLY=1 DAEMON_JSON_PATH="$MISSING_DAEMON" JOURNALD_DROPIN_SRC="$DROPIN_SRC" JOURNALD_DROPIN_DEST="${TMP}/journald2.conf" SYSTEMCTL_CMD=systemctl INSTALL_CMD=install bash "$INSTALL" >/dev/null
assert_file_exists "$MISSING_DAEMON" "apply creates missing daemon.json"
assert_eq "$(jq -r '."log-opts"."max-file"' <"$MISSING_DAEMON")" "3" "fresh daemon.json has caps"

if [[ "$fail" -ne 0 ]]; then
  echo "FAILED"
  exit 1
fi
echo "ALL ok"
