#!/usr/bin/env bash
# Offline tests for host-swap-report.sh.
# Fixture /proc files and a fake docker. No host changes and no 60s sleep.
#
#   bash scripts/ops/test-host-swap-report.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="${ROOT_DIR}/scripts/ops/host-swap-report.sh"
FIXTURE_SRC="${ROOT_DIR}/scripts/ops/fixtures/host-swap"
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

unset HOST_SWAP_SKIP_SLEEP HOST_SWAP_ELAPSED_SEC HOST_SWAP_BEFORE_SECOND_SAMPLE \
  HOST_SWAP_PAGE_SIZE HOST_SWAP_WINDOW_SEC HOST_SWAP_TOP_N HOST_SWAP_PROC HOST_SWAP_DOCKER \
  HOST_SWAP_DOCKER_LOG HOST_SWAP_DOCKER_FAIL || true

if grep -E -n 'swapoff|swapon|systemctl|sysctl[[:space:]]+-w' "$SCRIPT"; then
  echo "FAIL script contains a swap or sysctl write"
  fail=1
else
  echo "ok   script has no swap or sysctl write"
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/host-swap-report.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

FIX="${TMP}/fixture"
PROC="${FIX}/proc"
BIN="${TMP}/bin"
LOG="${TMP}/docker.log"
FORBIDDEN="${TMP}/forbidden.log"
SLEEP_LOG="${TMP}/sleep.log"
mkdir -p "$BIN"
cp -a "$FIXTURE_SRC" "$FIX"

cat >"${BIN}/sysctl" <<EOF
#!/bin/sh
echo "sysctl \$*" >>"$FORBIDDEN"
exit 99
EOF
cat >"${BIN}/swapoff" <<EOF
#!/bin/sh
echo "swapoff \$*" >>"$FORBIDDEN"
exit 99
EOF
cat >"${BIN}/swapon" <<EOF
#!/bin/sh
echo "swapon \$*" >>"$FORBIDDEN"
exit 99
EOF
cat >"${BIN}/systemctl" <<EOF
#!/bin/sh
echo "systemctl \$*" >>"$FORBIDDEN"
exit 99
EOF
cat >"${BIN}/sleep" <<EOF
#!/bin/sh
echo "sleep \$*" >>"$SLEEP_LOG"
exit 0
EOF
chmod 755 "${BIN}/sysctl" "${BIN}/swapoff" "${BIN}/swapon" "${BIN}/systemctl" "${BIN}/sleep"

FAKE="${TMP}/fake-docker"
cat >"$FAKE" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
log="${HOST_SWAP_DOCKER_LOG:?}"
{
  printf '%q' "$0"
  for arg in "$@"; do
    printf ' %q' "$arg"
  done
  printf '\n'
} >>"$log"
if [[ "${HOST_SWAP_DOCKER_FAIL:-0}" == "1" ]]; then
  echo "docker ps failed" >&2
  exit 1
fi
if [[ "${1:-}" != "ps" || "${2:-}" != "--no-trunc" || "${3:-}" != "--format" || -n "${5:-}" ]]; then
  echo "unexpected docker argv: $*" >&2
  exit 99
fi
cat "${HOST_SWAP_DOCKER_PS:?}"
EOF
chmod 755 "$FAKE"

export PATH="${BIN}:$PATH"
export HOST_SWAP_DOCKER="$FAKE"
export HOST_SWAP_DOCKER_LOG="$LOG"
export HOST_SWAP_DOCKER_PS="${FIX}/docker-ps.txt"
export HOST_SWAP_PROC="$PROC"
export HOST_SWAP_PAGE_SIZE=4096
export HOST_SWAP_SKIP_SLEEP=1
export HOST_SWAP_ELAPSED_SEC=60
export HOST_SWAP_BEFORE_SECOND_SAMPLE="cp ${FIX}/vmstat-t1 ${PROC}/vmstat"
export HOST_SWAP_DOCKER_FAIL=0

snapshot() {
  python3 - "$PROC" <<'PY'
import hashlib, os, sys
root = sys.argv[1]
digest = hashlib.sha256()
for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
    dirnames.sort()
    for name in sorted(filenames):
        path = os.path.join(dirpath, name)
        digest.update(path.encode())
        if os.path.islink(path):
            digest.update(b"link")
            digest.update(os.readlink(path).encode())
        elif os.path.isfile(path):
            with open(path, "rb") as handle:
                digest.update(handle.read())
print(digest.hexdigest())
PY
}

# Sentinel that must never be copied into the report.
printf 'TOPSECRET-CGROUP\n' >>"${PROC}/301/cgroup"

OUT="${TMP}/out"
mkdir -p "$OUT"
: >"$LOG"
: >"$FORBIDDEN"
: >"$SLEEP_LOG"
before="$(snapshot)"
timeout 15 bash "$SCRIPT" --out-dir "$OUT" >"${TMP}/human.md"
after="$(snapshot)"
if [[ "$before" == "$after" ]]; then
  echo "FAIL sample hook did not replace vmstat"
  fail=1
else
  echo "ok   second vmstat sample is read"
fi
# Both invocations have to observe the same 1000 -> 1120 delta.
cp "${FIXTURE_SRC}/proc/vmstat" "${PROC}/vmstat"
timeout 15 bash "$SCRIPT" --json >"${TMP}/report.json"
cp "${FIXTURE_SRC}/proc/vmstat" "${PROC}/vmstat"

python3 - "${TMP}/report.json" "${TMP}/human.md" "$OUT/report.md" "$OUT/report.json" "$LOG" "$FORBIDDEN" "$SLEEP_LOG" <<'PY'
import json, sys
js_path, human_path, md_path, out_json, log_path, forbidden_path, sleep_path = sys.argv[1:8]
report = json.load(open(js_path, encoding="utf-8"))
human = open(human_path, "rb").read()
md = open(md_path, "rb").read()
out_report = json.load(open(out_json, encoding="utf-8"))
log = open(log_path, encoding="utf-8").read()
forbidden = open(forbidden_path, encoding="utf-8").read()
sleep_log = open(sleep_path, encoding="utf-8").read()

assert report == out_report
assert report["read_only"] is True
assert report["schema_version"] == 1
assert report["swap"]["total_bytes"] == 4194304 * 1024
assert report["swap"]["free_bytes"] == 1048576 * 1024
assert report["swap"]["used_bytes"] == 3145728 * 1024
assert report["memory"]["total_bytes"] == 16384000 * 1024
assert report["memory"]["available_bytes"] == 4096000 * 1024
assert report["vm"]["swappiness"] == 10
assert report["vm"]["vfs_cache_pressure"] == 100
assert report["sample"]["window_seconds"] == 60
assert report["sample"]["elapsed_seconds"] == 60
assert report["sample"]["page_size_bytes"] == 4096
assert report["sample"]["pswpin"]["start"] == 1000
assert report["sample"]["pswpin"]["end"] == 1120
assert report["sample"]["pswpin"]["delta"] == 120
assert report["sample"]["pswpout"]["delta"] == 0
assert report["sample"]["swap_in_pages_per_sec"] == 2.0
assert report["sample"]["swap_out_pages_per_sec"] == 0.0
assert report["sample"]["swap_in_kib_per_sec"] == 8.0
assert report["sample"]["swap_out_kib_per_sec"] == 0.0
assert report["sample"]["counter_reset"] is False
# pgpgin jumped in the second sample and must not affect the rate.
assert report["sample"]["swap_in_pages_per_sec"] < 100

names = [row["comm"] for row in report["top_processes"]]
assert names == ["deno", "litestream", "python", "sshd", "unconfined"], names
assert report["top_processes"][0]["vmswap_bytes"] == 524288 * 1024
assert report["top_processes"][0]["container"] == "congress-app"
assert report["top_processes"][2]["container"] == "scan-cpu-worker"
assert report["top_processes"][3]["container"] is None
assert all(row["comm"] != "cron" for row in report["top_processes"])
assert all(row["comm"] != "kthreadd" for row in report["top_processes"])
assert all(row["comm"] != "weirdunit" for row in report["top_processes"])

order = [row["name"] for row in report["containers"]]
assert order == ["congress-app", "scan-cpu-worker", "aaa-zero", "unlimited-proxy"], order
by_name = {row["name"]: row for row in report["containers"]}
assert by_name["congress-app"]["swap_bytes"] == (524288 + 262144) * 1024
assert by_name["congress-app"]["pids"] == [101, 102]
assert by_name["scan-cpu-worker"]["swap_bytes"] == 10240 * 1024
assert by_name["scan-cpu-worker"]["pid_count"] == 1
assert by_name["unlimited-proxy"]["swap_bytes"] == 0
assert by_name["aaa-zero"]["swap_bytes"] == 0
assert "bogus" not in by_name and "short" not in by_name
assert report["unattributed_swap_bytes"] == (8192 + 4096) * 1024

devices = report["swap_devices"]
assert devices[0]["filename"] == "/swapfile"
assert devices[0]["used_bytes"] == 3145728 * 1024
assert devices[0]["priority"] == -2

blob = json.dumps(report)
assert "TOPSECRET" not in blob
assert "999999" not in blob
assert "pgpgin" not in blob

text = human.decode("utf-8")
assert human.startswith(b"# Host Swap Report\n")
assert b"Read-only.\xc2\xa0 No sysctl writes and no restarts." in human
assert b"\xc2\xa0" not in open(js_path, "rb").read()
assert "3.00 GiB" in text and "4.00 GiB" in text
assert "768.00 MiB" in text
assert "2.00 pages/s (8.00 KiB/s)" in text
assert "0.00 pages/s (0.00 KiB/s)" in text
assert "vm.swappiness: 10" in text
assert "vm.vfs_cache_pressure: 100" in text
assert "/swapfile" in text
assert "Unattributed swap: 12.00 MiB" in text
assert md == human
assert " ps " in log and "--no-trunc" in log
assert " restart " not in log and " exec " not in log and " kill " not in log
assert forbidden == ""
assert sleep_log == ""
print("ok   json, markdown, rates, containers, secrets")
PY

# No hook: proc tree stays byte-identical and the rate is zero.
unset HOST_SWAP_BEFORE_SECOND_SAMPLE
cp -a "$FIXTURE_SRC/proc/." "$PROC/"
: >"$LOG"
same_before="$(snapshot)"
timeout 15 bash "$SCRIPT" --json >"${TMP}/still.json"
same_after="$(snapshot)"
assert_eq "$same_before" "$same_after" "proc tree is unchanged without a hook"
python3 - "${TMP}/still.json" <<'PY'
import json, sys
report = json.load(open(sys.argv[1], encoding="utf-8"))
assert report["sample"]["swap_in_pages_per_sec"] == 0.0
assert report["sample"]["pswpin"]["delta"] == 0
assert report["sample"]["pswpin"]["start"] == 1000
assert report["sample"]["pswpin"]["end"] == 1000
print("ok   unchanged vmstat reports a zero rate")
PY

# Top N limits the process table and does not change container totals.
export HOST_SWAP_BEFORE_SECOND_SAMPLE="cp ${FIX}/vmstat-t1 ${PROC}/vmstat"
timeout 15 bash "$SCRIPT" --json --top 2 >"${TMP}/top.json"
python3 - "${TMP}/top.json" <<'PY'
import json, sys
report = json.load(open(sys.argv[1], encoding="utf-8"))
assert [row["comm"] for row in report["top_processes"]] == ["deno", "litestream"]
by_name = {row["name"]: row for row in report["containers"]}
assert by_name["congress-app"]["swap_bytes"] == (524288 + 262144) * 1024
assert by_name["scan-cpu-worker"]["pid_count"] == 1
print("ok   top N keeps full container totals")
PY

# Page size changes the KiB rate and not the page rate.
cp "${FIXTURE_SRC}/proc/vmstat" "${PROC}/vmstat"
export HOST_SWAP_BEFORE_SECOND_SAMPLE="cp ${FIX}/vmstat-t1 ${PROC}/vmstat"
HOST_SWAP_PAGE_SIZE=8192 timeout 15 bash "$SCRIPT" --json >"${TMP}/page.json"
export HOST_SWAP_PAGE_SIZE=4096
python3 - "${TMP}/page.json" <<'PY'
import json, sys
sample = json.load(open(sys.argv[1], encoding="utf-8"))["sample"]
assert sample["page_size_bytes"] == 8192
assert sample["swap_in_pages_per_sec"] == 2.0
assert sample["swap_in_kib_per_sec"] == 16.0
print("ok   page size scales the KiB rate")
PY

# A backwards counter omits that rate and keeps the other one.
cat >"${TMP}/vmstat-reset" <<'EOF'
pgpgin 10
pgpgout 20
pswpin 900
pswpout 2060
EOF
export HOST_SWAP_BEFORE_SECOND_SAMPLE="cp ${TMP}/vmstat-reset ${PROC}/vmstat"
timeout 15 bash "$SCRIPT" --json >"${TMP}/reset.json"
python3 - "${TMP}/reset.json" <<'PY'
import json, sys
sample = json.load(open(sys.argv[1], encoding="utf-8"))["sample"]
assert sample["counter_reset"] is True
assert sample["swap_in_pages_per_sec"] is None
assert sample["swap_out_pages_per_sec"] == 1.0
assert sample["swap_out_kib_per_sec"] == 4.0
print("ok   counter reset omits only the backwards rate")
PY

# Window 0 does not take a second sample.
unset HOST_SWAP_BEFORE_SECOND_SAMPLE
cp "${FIXTURE_SRC}/proc/vmstat" "${PROC}/vmstat"
timeout 10 bash "$SCRIPT" --json --window 0 >"${TMP}/zero.json"
python3 - "${TMP}/zero.json" <<'PY'
import json, sys
sample = json.load(open(sys.argv[1], encoding="utf-8"))["sample"]
assert sample["window_seconds"] == 0
assert sample["elapsed_seconds"] == 0
assert sample["pswpin"]["end"] is None
assert sample["swap_in_pages_per_sec"] is None
assert sample["swap_out_pages_per_sec"] is None
print("ok   window 0 skips the rate")
PY

# Symlinks that leave the fixture are not read.
cp -a "$FIXTURE_SRC/proc/." "$PROC/"
printf 'TOPSECRET-STATUS\n' >"${TMP}/secret-status"
mkdir -p "${TMP}/outside"
printf 'Name:\tsecret\nVmSwap:\t  99999 kB\n' >"${TMP}/outside/status"
printf 'TOPSECRET-CGROUP\n' >"${TMP}/outside/cgroup"
ln -s "${TMP}/outside" "${PROC}/803"
mkdir -p "${PROC}/804"
printf 'Name:\tinside\nVmSwap:\t    2048 kB\n' >"${PROC}/804/status"
ln -s "${TMP}/secret-status" "${PROC}/804/cgroup"
timeout 15 bash "$SCRIPT" --json --window 0 >"${TMP}/escape.json"
python3 - "${TMP}/escape.json" <<'PY'
import json, sys
blob = open(sys.argv[1], encoding="utf-8").read()
report = json.loads(blob)
assert "TOPSECRET" not in blob
assert "secret" not in [row["comm"] for row in report["top_processes"]]
assert "inside" in [row["comm"] for row in report["top_processes"]]
print("ok   symlink escape is not read")
PY

# docker ps failure still reports swap and lists no containers.
export HOST_SWAP_DOCKER_FAIL=1
: >"$LOG"
timeout 15 bash "$SCRIPT" --json --window 0 >"${TMP}/nodocker.json" 2>"${TMP}/nodocker.err"
export HOST_SWAP_DOCKER_FAIL=0
python3 - "${TMP}/nodocker.json" "${TMP}/nodocker.err" <<'PY'
import json, sys
report = json.load(open(sys.argv[1], encoding="utf-8"))
err = open(sys.argv[2], encoding="utf-8").read()
assert report["containers"] == []
assert report["swap"]["used_bytes"] == 3145728 * 1024
assert "docker ps failed" in err
print("ok   docker ps failure keeps the host report")
PY

# Missing SwapTotal is an error and prints no report.
mkdir -p "${TMP}/empty/proc"
printf 'MemTotal: 1 kB\n' >"${TMP}/empty/proc/meminfo"
set +e
HOST_SWAP_PROC="${TMP}/empty/proc" timeout 10 bash "$SCRIPT" --json --window 0 >"${TMP}/bad-mem.out" 2>"${TMP}/bad-mem.err"
bad_status=$?
set -e
export HOST_SWAP_PROC="$PROC"
if [[ "$bad_status" -eq 1 ]]; then
  echo "ok   missing SwapTotal exits 1"
else
  echo "FAIL missing SwapTotal exit ${bad_status}"
  fail=1
fi
if [[ -s "${TMP}/bad-mem.out" ]]; then
  echo "FAIL missing SwapTotal printed a report"
  fail=1
else
  echo "ok   missing SwapTotal prints no report"
fi

# Live /proc refuses the sleep-skip hook before any sample.
set +e
HOST_SWAP_PROC=/proc HOST_SWAP_SKIP_SLEEP=1 HOST_SWAP_ELAPSED_SEC=60 \
  timeout 10 bash "$SCRIPT" --window 60 >"${TMP}/live.out" 2>"${TMP}/live.err"
live_status=$?
set -e
export HOST_SWAP_PROC="$PROC"
if [[ "$live_status" -eq 2 ]]; then
  echo "ok   live /proc refuses test hooks"
else
  echo "FAIL live /proc hook exit ${live_status}"
  fail=1
fi
if [[ -s "${TMP}/live.out" ]]; then
  echo "FAIL live /proc hook printed a report"
  fail=1
else
  echo "ok   live /proc hook prints no report"
fi

set +e
bash "$SCRIPT" --apply >"${TMP}/bad-flag.out" 2>"${TMP}/bad-flag.err"
flag_status=$?
bash "$SCRIPT" --window 99999 >/dev/null 2>"${TMP}/big-window.err"
big_status=$?
bash "$SCRIPT" --top 0 >/dev/null 2>"${TMP}/top0.err"
top_status=$?
set -e
assert_eq "$flag_status" "2" "unknown flag exits 2"
assert_eq "$big_status" "2" "huge window exits 2"
assert_eq "$top_status" "2" "top 0 exits 2"

# Leading zeros are decimal. 09 must not abort, and 010 is ten rather than eight.
timeout 10 bash "$SCRIPT" --json --window 09 >"${TMP}/w09.json"
timeout 10 bash "$SCRIPT" --json --window 010 >"${TMP}/w010.json"
timeout 10 bash "$SCRIPT" --json --window 0 --top 08 >"${TMP}/top08.json"
HOST_SWAP_PAGE_SIZE=08 timeout 10 bash "$SCRIPT" --json --window 0 >"${TMP}/page08.json"
export HOST_SWAP_PAGE_SIZE=4096
python3 - "${TMP}/w09.json" "${TMP}/w010.json" "${TMP}/top08.json" "${TMP}/page08.json" <<'PY'
import json, sys
w09, w010, top08, page08 = [json.load(open(path, encoding="utf-8")) for path in sys.argv[1:5]]
assert w09["sample"]["window_seconds"] == 9
assert w010["sample"]["window_seconds"] == 10
assert top08["sample"]["window_seconds"] == 0
assert 1 <= len(top08["top_processes"]) <= 8
assert page08["sample"]["page_size_bytes"] == 8
print("ok   leading zeros are decimal")
PY

set +e
bash "$SCRIPT" --window 0007000 >/dev/null 2>"${TMP}/octal.err"
octal_status=$?
set -e
assert_eq "$octal_status" "2" "7000 with leading zeros exits 2"
if grep -q 'value too great for base' "${TMP}/octal.err" "${TMP}/w09.json"; then
  echo "FAIL octal arithmetic error leaked"
  fail=1
else
  echo "ok   no octal arithmetic error"
fi

: >"$LOG"
bash "$SCRIPT" --help >"${TMP}/help.txt"
if grep -q 'ps' "$LOG"; then
  echo "FAIL --help invoked docker"
  fail=1
else
  echo "ok   --help does not call docker"
fi

if [[ -s "$FORBIDDEN" ]]; then
  echo "FAIL a forbidden command ran: $(cat "$FORBIDDEN")"
  fail=1
else
  echo "ok   sysctl, swapoff, swapon, and systemctl were not run"
fi

if [[ "$fail" -ne 0 ]]; then
  echo "host-swap-report tests failed"
  exit 1
fi
echo "host-swap-report tests passed"
