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
assert_eq "$(jq -r '."log-opts"."max-size"' <"$EMPTY_DAEMON")" "10m" "empty daemon.json file gets log caps"

WS_DAEMON="${TMP}/etc/docker/ws-daemon.json"
printf ' \n' >"$WS_DAEMON"
APPLY=1 DAEMON_JSON_PATH="$WS_DAEMON" JOURNALD_DROPIN_SRC="$DROPIN_SRC" JOURNALD_DROPIN_DEST="${TMP}/ws-journald.conf" SYSTEMCTL_CMD=systemctl INSTALL_CMD=install bash "$INSTALL" >/dev/null
assert_eq "$(jq -r '."log-opts"."max-size"' <"$WS_DAEMON")" "10m" "whitespace-only daemon.json gets log caps"

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
assert_eq "$(jq -r '."log-opts"."max-size"' <<<"$merged")" "10m" "merge sets max-size"
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
reapply_docker="$(cat "${TMP}/reapply.out")"
if printf '%s' "$reapply_docker" | grep -qE 'already has fleet log caps|will not loosen'; then
  echo "ok   second apply is idempotent for docker"
else
  echo "FAIL second apply is idempotent for docker: missing idempotent docker message"
  fail=1
fi
assert_contains "$(cat "${TMP}/reapply.out")" "already matches repo" "second apply idempotent journald copy"

# --- merge on missing file ---------------------------------------------------
MISSING_DAEMON="${TMP}/fresh/daemon.json"
mkdir -p "$(dirname "$MISSING_DAEMON")"
APPLY=1 DAEMON_JSON_PATH="$MISSING_DAEMON" JOURNALD_DROPIN_SRC="$DROPIN_SRC" JOURNALD_DROPIN_DEST="${TMP}/journald2.conf" SYSTEMCTL_CMD=systemctl INSTALL_CMD=install bash "$INSTALL" >/dev/null
assert_file_exists "$MISSING_DAEMON" "apply creates missing daemon.json"
assert_eq "$(jq -r '."log-opts"."max-file"' <"$MISSING_DAEMON")" "3" "fresh daemon.json has caps"

# --- no daemon.json (missing file) -------------------------------------------
NOFILE_DAEMON="${TMP}/nofile/daemon.json"
mkdir -p "$(dirname "$NOFILE_DAEMON")"
rm -f "$NOFILE_DAEMON"
APPLY=1 DAEMON_JSON_PATH="$NOFILE_DAEMON" JOURNALD_DROPIN_SRC="$DROPIN_SRC" JOURNALD_DROPIN_DEST="${TMP}/nofile-journald.conf" SYSTEMCTL_CMD=systemctl INSTALL_CMD=install bash "$INSTALL" >/dev/null
assert_file_exists "$NOFILE_DAEMON" "missing daemon.json path is created"
assert_eq "$(jq -r '."log-opts"."max-size"' <"$NOFILE_DAEMON")" "10m" "missing daemon.json uses 10m default"
assert_eq "$(jq -r '."log-opts"."max-file"' <"$NOFILE_DAEMON")" "3" "missing daemon.json uses max-file 3"

# --- tighter existing cap (never loosen) -------------------------------------
TIGHT_DAEMON="${TMP}/etc/docker/tight-daemon.json"
mkdir -p "$(dirname "$TIGHT_DAEMON")"
printf '%s\n' '{"storage-driver":"overlay2","log-driver":"json-file","log-opts":{"max-size":"5m","max-file":"2"}}' >"$TIGHT_DAEMON"
tight_before="$(cat "$TIGHT_DAEMON")"
tight_out="$(APPLY=1 DAEMON_JSON_PATH="$TIGHT_DAEMON" JOURNALD_DROPIN_SRC="$DROPIN_SRC" JOURNALD_DROPIN_DEST="${TMP}/tight-journald.conf" SYSTEMCTL_CMD=systemctl INSTALL_CMD=install bash "$INSTALL")"
assert_eq "$(cat "$TIGHT_DAEMON")" "$tight_before" "tighter cap leaves daemon.json bytes unchanged"
assert_eq "$(jq -r '."log-opts"."max-size"' <"$TIGHT_DAEMON")" "5m" "tighter max-size preserved"
assert_eq "$(jq -r '."log-opts"."max-file"' <"$TIGHT_DAEMON")" "2" "tighter max-file preserved"
assert_contains "$tight_out" "will not loosen" "tighter cap reports skip"

# --- looser existing cap (tighten only) --------------------------------------
LOOSE_DAEMON="${TMP}/etc/docker/loose-daemon.json"
mkdir -p "$(dirname "$LOOSE_DAEMON")"
printf '%s\n' '{"log-driver":"json-file","log-opts":{"max-size":"50m","max-file":"5"}}' >"$LOOSE_DAEMON"
APPLY=1 DAEMON_JSON_PATH="$LOOSE_DAEMON" JOURNALD_DROPIN_SRC="$DROPIN_SRC" JOURNALD_DROPIN_DEST="${TMP}/loose-journald.conf" SYSTEMCTL_CMD=systemctl INSTALL_CMD=install bash "$INSTALL" >/dev/null
assert_eq "$(jq -r '."log-opts"."max-size"' <"$LOOSE_DAEMON")" "10m" "looser max-size tightened to 10m"
assert_eq "$(jq -r '."log-opts"."max-file"' <"$LOOSE_DAEMON")" "3" "looser max-file tightened to 3"

# --- Docker size formats, partial configs, unreadable values ------------------
# run_case NAME JSON -> applies installer to a fresh daemon.json, prints file path
run_case() {
  local name="$1" json="$2" path
  path="${TMP}/cases/${name}/daemon.json"
  mkdir -p "$(dirname "$path")"
  printf '%s\n' "$json" >"$path"
  APPLY=1 DAEMON_JSON_PATH="$path" JOURNALD_DROPIN_SRC="$DROPIN_SRC" JOURNALD_DROPIN_DEST="${TMP}/cases/${name}/journald.conf" SYSTEMCTL_CMD=systemctl INSTALL_CMD=install bash "$INSTALL" >"${TMP}/cases/${name}/out" 2>&1
  printf '%s' "$path"
}
opt() { jq -r --arg k "$2" '."log-opts"[$k] // "absent"' <"$1"; }

p="$(run_case upper-m '{"log-opts":{"max-size":"10M","max-file":"3"}}')"
assert_eq "$(opt "$p" max-size)/$(opt "$p" max-file)" "10m/3" "10M equals fleet cap (not loosened)"
p="$(run_case one-g '{"log-opts":{"max-size":"1g","max-file":"5"}}')"
assert_eq "$(opt "$p" max-size)/$(opt "$p" max-file)" "10m/3" "1g tightened to 10m/3"
p="$(run_case k512 '{"log-opts":{"max-size":"512k","max-file":"2"}}')"
assert_eq "$(opt "$p" max-size)/$(opt "$p" max-file)" "512k/2" "512k preserved"
p="$(run_case bare '{"log-opts":{"max-size":"2048","max-file":"2"}}')"
assert_eq "$(opt "$p" max-size)/$(opt "$p" max-file)" "2048/2" "bare byte count preserved"
p="$(run_case decimal '{"log-opts":{"max-size":"1.5g","max-file":"3"}}')"
assert_eq "$(opt "$p" max-size)" "10m" "Docker-valid 1.5g parsed and tightened"
assert_file_exists "${TMP}/cases/decimal/journald.conf" "1.5g run still installs journald drop-in"
p="$(run_case mib '{"log-opts":{"max-size":"10MiB","max-file":"3"}}')"
assert_eq "$(opt "$p" max-size)/$(opt "$p" max-file)" "10m/3" "10MiB treated as 10m"
p="$(run_case small-mb '{"log-opts":{"max-size":"5mb","max-file":"3"}}')"
assert_eq "$(opt "$p" max-size)" "5mb" "5mb tighter than fleet preserved"
p="$(run_case size-only '{"log-opts":{"max-size":"5m"}}')"
assert_eq "$(opt "$p" max-size)/$(opt "$p" max-file)" "5m/1" "max-size without max-file keeps one file"
p="$(run_case size-only-big '{"log-opts":{"max-size":"50m"}}')"
assert_eq "$(opt "$p" max-size)/$(opt "$p" max-file)" "10m/1" "50m without max-file tightens size, keeps one file"
p="$(run_case weird '{"log-opts":{"max-size":"lots","max-file":"2"}}')"
assert_eq "$(opt "$p" max-size)/$(opt "$p" max-file)" "lots/2" "unreadable max-size preserved, not aborted"
assert_contains "$(cat "${TMP}/cases/weird/out")" "keeping existing log max-size" "unreadable max-size warns"
assert_file_exists "${TMP}/cases/weird/journald.conf" "unreadable max-size still installs journald drop-in"

# --- malformed daemon.json ---------------------------------------------------
BAD_DAEMON="${TMP}/etc/docker/bad-daemon.json"
printf '{not json' >"$BAD_DAEMON"
set +e
bad_out="$(APPLY=1 DAEMON_JSON_PATH="$BAD_DAEMON" JOURNALD_DROPIN_SRC="$DROPIN_SRC" JOURNALD_DROPIN_DEST="${TMP}/bad-journald.conf" SYSTEMCTL_CMD=systemctl INSTALL_CMD=install bash "$INSTALL" 2>&1)"
bad_rc=$?
set -e
if [[ "$bad_rc" -ne 0 ]]; then
  echo "ok   malformed daemon.json exits non-zero"
else
  echo "FAIL malformed daemon.json should exit non-zero"
  fail=1
fi
assert_contains "$bad_out" "cannot parse" "malformed daemon.json error message"

if [[ "$fail" -ne 0 ]]; then
  echo "FAILED"
  exit 1
fi
echo "ALL ok"
