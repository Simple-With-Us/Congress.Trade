#!/usr/bin/env bash
# Offline tests for container-mem-report.sh.
# Mock docker and a fake cgroup v2 / proc tree. No daemon and no host changes.
#
#   bash scripts/ops/test-container-mem-report.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="${ROOT_DIR}/scripts/ops/container-mem-report.sh"
fail=0

assert_eq() {
  local got="$1" want="$2" name="$3"
  if [ "$got" != "$want" ]; then
    echo "FAIL ${name}: got '${got}' want '${want}'"
    fail=1
  else
    echo "ok   ${name}"
  fi
}

TMP="$(mktemp -d "${TMPDIR:-/tmp}/container-mem-report.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

FAKE="${TMP}/fake-docker"
LOG="${TMP}/docker.log"
FIX="${TMP}/fixture"
CG="${TMP}/cgroup"
PROC="${TMP}/proc"
mkdir -p "$FIX/inspect" "$CG" "$PROC"

cat >"$FAKE" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
log="${CONTAINER_MEM_DOCKER_LOG:?}"
fixture="${CONTAINER_MEM_FIXTURE:?}"
{
  printf '%q' "$0"
  for arg in "$@"; do
    printf ' %q' "$arg"
  done
  printf '\n'
} >>"$log"

sub="${1:-}"
if [[ "$sub" == "inspect" && "${2:-}" == "--format" ]]; then
  printf '%s\n' "$3" >>"${log}.formats"
fi
if [[ "${CONTAINER_MEM_FAIL_STATS:-0}" == "1" && "$sub" == "stats" ]]; then
  echo "stats failed" >&2
  exit 1
fi
case "$sub" in
  stats)
    cat "${fixture}/stats.ndjson"
    ;;
  inspect)
    shift
    if [[ "${1:-}" != "--format" ]]; then
      echo "inspect missing --format" >&2
      exit 4
    fi
    shift 2
    for id in "$@"; do
      path="${fixture}/inspect/${id}"
      if [[ ! -f "$path" ]]; then
        echo "missing inspect fixture for ${id}" >&2
        exit 3
      fi
      cat "$path"
      printf '\n'
    done
    ;;
  *)
    echo "unexpected docker subcommand: ${sub}" >&2
    exit 99
    ;;
esac
EOF
chmod 755 "$FAKE"

write_status() {
  local pid="$1" name="$2" rss_kb="$3"
  mkdir -p "${PROC}/${pid}"
  printf 'Name:\t%s\nVmRSS:\t%8s kB\n' "$name" "$rss_kb" >"${PROC}/${pid}/status"
}

write_cgroup_ptr() {
  local pid="$1" rel="$2"
  mkdir -p "${PROC}/${pid}"
  printf '%s\n' "$rel" >"${PROC}/${pid}/cgroup"
}

scope_dir() {
  local id="$1"
  printf '%s/system.slice/docker-%s.scope' "$CG" "$id"
}

INSPECT_FMT='{{.Id}}{{"\t"}}{{.Name}}{{"\t"}}{{.Config.Image}}{{"\t"}}{{.HostConfig.Memory}}{{"\t"}}{{.RestartCount}}{{"\t"}}{{.State.Pid}}{{"\t"}}{{.State.Status}}'

write_inspect() {
  local short="$1" full="$2" name="$3" image="$4" memory="$5" restarts="$6" pid="$7"
  printf '%s\t%s\t%s\t%s\t%s\t%s\trunning\n' \
    "$full" "$name" "$image" "$memory" "$restarts" "$pid" >"${FIX}/inspect/${short}"
}

# congress-app: stats 1.5 GiB, cgroup max 3 GiB wins over a conflicting inspect
# memory value, swap 4.5 GiB, oom history, six RSS rows so only five are shown.
CONGRESS_SHORT="aaaaaaaaaaaa"
CONGRESS_FULL="${CONGRESS_SHORT}$(printf '%052d' 0)"
write_inspect "$CONGRESS_SHORT" "$CONGRESS_FULL" "/congress-app" "congress-app:latest" "999" "3" "101"
CONGRESS_DIR="$(scope_dir "$CONGRESS_SHORT")"
mkdir -p "$CONGRESS_DIR"
printf '4831838208\n' >"${CONGRESS_DIR}/memory.swap.current"
printf '2147483648\n' >"${CONGRESS_DIR}/memory.current"
printf '3221225472\n' >"${CONGRESS_DIR}/memory.max"
cat >"${CONGRESS_DIR}/memory.events" <<'EOF'
low 0
high 0
max 0
oom 2
oom_kill 1
oom_group_kill 0
EOF
printf '101\n102\n103\n104\n105\n106\n107\n' >"${CONGRESS_DIR}/cgroup.procs"
write_cgroup_ptr 101 $'1:name=systemd:/system.slice/docker-aaaaaaaaaaaa.scope\n0::/system.slice/docker-aaaaaaaaaaaa.scope'
write_status 101 deno 204800
write_status 102 litestream 102400
write_status 103 tesseract 51200
write_status 104 pdftoppm 25600
write_status 105 wget 12800
write_status 106 cron 6400
write_status 107 idle 0

# scan-cpu-worker: no kernel cap (memory.max = max, inspect memory 0). The
# stats line's right-hand side looks like a 16 GiB limit and must be ignored.
SCAN_ID="bbbbbbbbbbbb"
write_inspect "$SCAN_ID" "$SCAN_ID" "/congress-scan-cpu-worker" "congress-scan-cpu-worker:latest" "0" "0" "201"
SCAN_DIR="$(scope_dir "$SCAN_ID")"
mkdir -p "$SCAN_DIR"
printf '0\n' >"${SCAN_DIR}/memory.swap.current"
printf '209715200\n' >"${SCAN_DIR}/memory.current"
printf 'max\n' >"${SCAN_DIR}/memory.max"
printf 'oom 0\noom_kill 0\n' >"${SCAN_DIR}/memory.events"
printf '201\n' >"${SCAN_DIR}/cgroup.procs"
write_cgroup_ptr 201 "0::/system.slice/docker-${SCAN_ID}.scope"
write_status 201 python 40960

# sqlite-web: limit comes from inspect because memory.max is absent. Swap file
# is absent, so swap stays unknown rather than zero.
SQL_ID="cccccccccccc"
write_inspect "$SQL_ID" "$SQL_ID" "/congress-sqlite-web" "congress-sqlite-web:latest" "536870912" "4" "301"
SQL_DIR="$(scope_dir "$SQL_ID")"
mkdir -p "$SQL_DIR"
printf '943718400\n' >"${SQL_DIR}/memory.current"
printf 'oom 0\noom_kill 0\n' >"${SQL_DIR}/memory.events"
printf '301\n' >"${SQL_DIR}/cgroup.procs"
write_cgroup_ptr 301 "0::/system.slice/docker-${SQL_ID}.scope"
write_status 301 sqlite_web 8192

# Another unlimited container. Swap file is a symlink that leaves the cgroup
# tree and must not be read.
PROXY_ID="dddddddddddd"
write_inspect "$PROXY_ID" "$PROXY_ID" "/unlimited-proxy" "traefik:v3.2" "0" "1" "401"
PROXY_DIR="$(scope_dir "$PROXY_ID")"
mkdir -p "$PROXY_DIR"
printf '10485760\n' >"${PROXY_DIR}/memory.current"
printf 'max\n' >"${PROXY_DIR}/memory.max"
printf 'oom 0\noom_kill 0\n' >"${PROXY_DIR}/memory.events"
printf '401\n' >"${PROXY_DIR}/cgroup.procs"
write_cgroup_ptr 401 "0::/system.slice/docker-${PROXY_ID}.scope"
write_status 401 traefik 2048
printf 'TOPSECRET-SWAP\n' >"${TMP}/secret-swap"
ln -s "${TMP}/secret-swap" "${PROXY_DIR}/memory.swap.current"

# No inspect body and no cgroup. Limit stays unknown (n/a), not "none".
MYSTERY_ID="eeeeeeeeeeee"
: >"${FIX}/inspect/${MYSTERY_ID}"

# Path escape: rel walks out of the cgroup root. Also a symlink scope dir.
printf 'TOPSECRET-OUTSIDE\n' >"${TMP}/secret-outside"
mkdir -p "${TMP}/outside"
printf '999999\n' >"${TMP}/outside/memory.swap.current"
ESCAPE_ID="ffffffffffff"
write_inspect "$ESCAPE_ID" "$ESCAPE_ID" "/escape" "escape:latest" "1048576" "0" "501"
write_cgroup_ptr 501 "0::/../../outside"
mkdir -p "${CG}/system.slice"
ln -s "${TMP}/outside" "${CG}/system.slice/link.scope"

cat >"${FIX}/stats.ndjson" <<EOF
{"ID":"${CONGRESS_SHORT}","Container":"${CONGRESS_SHORT}","Name":"congress-app","MemUsage":"1.5GiB / 3GiB","PIDs":"7"}
{"ID":"${SCAN_ID}","Name":"congress-scan-cpu-worker","MemUsage":"200MiB / 16GiB","PIDs":"1"}
{"ID":"${SQL_ID}","Name":"congress-sqlite-web","MemUsage":"900MiB / 512MiB","PIDs":"1"}
{"ID":"${PROXY_ID}","Name":"unlimited-proxy","MemUsage":"10MiB / 16GiB","PIDs":"1"}
{"ID":"${MYSTERY_ID}","Name":"mystery","MemUsage":"5MiB / 1GiB","PIDs":"1"}
EOF

export CONTAINER_MEM_DOCKER="$FAKE"
export CONTAINER_MEM_DOCKER_LOG="$LOG"
export CONTAINER_MEM_FIXTURE="$FIX"
export CONTAINER_MEM_CGROUP="$CG"
export CONTAINER_MEM_PROC="$PROC"
export CONTAINER_MEM_FAIL_STATS=0

snapshot() {
  python3 - "$CG" "$PROC" <<'PY'
import hashlib, os, sys
root_cg, root_proc = sys.argv[1:3]
digest = hashlib.sha256()
for root in (root_cg, root_proc):
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames.sort()
        for name in sorted(filenames):
            path = os.path.join(dirpath, name)
            digest.update(path.encode())
            if os.path.islink(path):
                digest.update(b"link")
                digest.update(os.readlink(path).encode())
            else:
                with open(path, "rb") as handle:
                    digest.update(handle.read())
print(digest.hexdigest())
PY
}

before="$(snapshot)"
human="${TMP}/human.txt"
json_out="${TMP}/report.json"
bash "$SCRIPT" >"$human"
bash "$SCRIPT" --json >"$json_out"
after="$(snapshot)"
assert_eq "$before" "$after" "cgroup and proc trees are unchanged"

python3 - "$json_out" "$human" "$LOG" "$INSPECT_FMT" <<'PY'
import json, sys
path, human_path, log_path, inspect_fmt = sys.argv[1:5]
report = json.load(open(path, encoding="utf-8"))
human = open(human_path, encoding="utf-8").read()
log = open(log_path, encoding="utf-8").read().splitlines()

assert report["read_only"] is True
by_name = {row["name"]: row for row in report["containers"]}

order = [row["name"] for row in report["containers"]]
assert order == [
    "congress-app",
    "congress-sqlite-web",
    "congress-scan-cpu-worker",
    "unlimited-proxy",
    "mystery",
], order

app = by_name["congress-app"]
assert app["image"] == "congress-app:latest"
assert app["memory_usage_bytes"] == int(1.5 * 1024 ** 3)
assert app["memory_usage_source"] == "docker_stats"
assert app["memory_current_bytes"] == 2147483648
assert app["memory_limit_bytes"] == 3221225472
assert app["memory_limit_source"] == "cgroup_max"
assert app["swap_bytes"] == int(4.5 * 1024 ** 3)
assert app["oom"] == 2
assert app["oom_kill"] == 1
assert app["restart_count"] == 3
assert [row["comm"] for row in app["top_rss"]] == ["deno", "litestream", "tesseract", "pdftoppm", "wget"]
assert app["top_rss"][0]["rss_bytes"] == 200 * 1024 * 1024
assert app["top_rss_status"] == "ok"
assert all(row["comm"] != "cron" for row in app["top_rss"])
assert all(row["comm"] != "idle" for row in app["top_rss"])

scan = by_name["congress-scan-cpu-worker"]
assert scan["memory_usage_bytes"] == 200 * 1024 * 1024
assert scan["memory_limit_bytes"] is None
assert scan["memory_limit_source"] == "none"
assert scan["swap_bytes"] == 0
assert scan["oom"] == 0 and scan["oom_kill"] == 0
assert scan["top_rss"][0]["comm"] == "python"

sql = by_name["congress-sqlite-web"]
assert sql["memory_limit_bytes"] == 536870912
assert sql["memory_limit_source"] == "inspect"
assert sql["swap_bytes"] is None
assert sql["restart_count"] == 4

proxy = by_name["unlimited-proxy"]
assert proxy["memory_limit_source"] == "none"
assert proxy["swap_bytes"] is None
assert proxy["image"] == "traefik:v3.2"

mystery = by_name["mystery"]
assert mystery["memory_limit_source"] == "unknown"
assert mystery["image"] is None
assert mystery["restart_count"] is None
assert mystery["swap_bytes"] is None
assert mystery["top_rss_status"] == "unavailable"

totals = report["totals"]
usage_sum = sum(row["memory_usage_bytes"] or 0 for row in report["containers"])
assert totals["memory_usage_bytes"] == usage_sum
assert totals["containers"] == 5
assert totals["unlimited"] == 2
assert totals["swap_bytes"] == int(4.5 * 1024 ** 3)
assert totals["swap_unknown"] == 3  # sqlite (no file), proxy (symlink), mystery
assert totals["oom"] == 2
assert totals["oom_kill"] == 1
assert totals["restart_count"] == 8  # 3+0+4+1; mystery unknown
assert totals["oom_unknown"] == 1
assert totals["restart_unknown"] == 1

blob = json.dumps(report)
assert "TOPSECRET" not in blob
assert "999999" not in blob
assert "Config.Env" not in blob

# Human report: order, none vs n/a, totals, and the read-only banner.
body = human.split("TOTALS", 1)[0]
positions = [body.index(name) for name in order]
assert positions == sorted(positions)
assert "MEM_LIMIT" in human
assert "none" in human
assert "n/a" in human
assert "TOTALS  containers=5" in human
assert "unlimited=2" in human
assert "read-only" in human
assert "deno 200.00 MiB" in human
assert "cron" not in human.split("congress-app", 1)[1].split("\n", 1)[0]

stats_lines = [line for line in log if " stats " in line]
inspect_lines = [line for line in log if " inspect " in line]
assert len(stats_lines) == 2  # human + json
assert len(inspect_lines) == 2
for line in stats_lines:
    assert "--no-stream" in line
    assert "json" in line
for line in log:
    assert " update " not in line
    assert " exec " not in line
    assert " kill " not in line
    assert "touch" not in line
    assert "Env" not in line
formats = open(log_path + ".formats", encoding="utf-8").read().splitlines()
assert formats, "inspect format was not recorded"
assert all(line == inspect_fmt for line in formats), formats
print("ok   json report, sort, limits, swap, rss, totals, secrets")
PY

# Unparsable stats usage falls back to memory.current. Too many procs skips RSS.
SKIP_ID="abcabcabcabc"
write_inspect "$SKIP_ID" "$SKIP_ID" "/skip-rss" "skip:latest" "104857600" "2" "601"
SKIP_DIR="$(scope_dir "$SKIP_ID")"
mkdir -p "$SKIP_DIR"
printf '4096\n' >"${SKIP_DIR}/memory.current"
printf '0\n' >"${SKIP_DIR}/memory.swap.current"
printf '104857600\n' >"${SKIP_DIR}/memory.max"
printf 'oom 4\noom_kill 2\n' >"${SKIP_DIR}/memory.events"
{
  printf '601\n'
  printf '602\n'
  printf '603\n'
} >"${SKIP_DIR}/cgroup.procs"
write_cgroup_ptr 601 "0::/system.slice/docker-${SKIP_ID}.scope"
write_status 601 one 3000
write_status 602 two 2000
write_status 603 three 1000
printf '%s\n' "{\"ID\":\"${SKIP_ID}\",\"Name\":\"skip-rss\",\"MemUsage\":\"not-a-size\"}" >"${FIX}/stats.ndjson"
: >"$LOG"
CONTAINER_MEM_TOP_RSS_MAX_PROCS=2 bash "$SCRIPT" --json >"${TMP}/skip.json"
python3 - "${TMP}/skip.json" <<'PY'
import json, sys
report = json.load(open(sys.argv[1], encoding="utf-8"))
row = report["containers"][0]
assert row["name"] == "skip-rss"
assert row["memory_usage_bytes"] == 4096
assert row["memory_usage_source"] == "cgroup_current"
assert row["memory_limit_bytes"] == 104857600
assert row["top_rss_status"] == "skipped"
assert row["top_rss_proc_count"] == 3
assert row["top_rss"] == []
assert row["oom_kill"] == 2
print("ok   cgroup usage fallback and skipped RSS")
PY

# Empty docker stats: no inspect, zero totals.
printf '' >"${FIX}/stats.ndjson"
: >"$LOG"
bash "$SCRIPT" --json >"${TMP}/empty.json"
python3 - "${TMP}/empty.json" "$LOG" <<'PY'
import json, sys
report = json.load(open(sys.argv[1], encoding="utf-8"))
log = open(sys.argv[2], encoding="utf-8").read()
assert report["containers"] == []
assert report["totals"]["containers"] == 0
assert report["totals"]["memory_usage_bytes"] == 0
assert report["totals"]["swap_bytes"] == 0
assert " inspect " not in log
assert " stats " in log
print("ok   empty stats skips inspect")
PY

# docker stats failure.
printf '' >"${FIX}/stats.ndjson"
: >"$LOG"
set +e
CONTAINER_MEM_FAIL_STATS=1 bash "$SCRIPT" --json >"${TMP}/fail-out.txt" 2>"${TMP}/fail-err.txt"
fail_status=$?
set -e
export CONTAINER_MEM_FAIL_STATS=0
if [[ "$fail_status" -eq 0 ]]; then
  echo "FAIL docker stats failure should be non-zero"
  fail=1
else
  echo "ok   docker stats failure exits non-zero"
fi
if [[ -s "${TMP}/fail-out.txt" ]]; then
  echo "FAIL docker stats failure should not print a report"
  fail=1
else
  echo "ok   docker stats failure prints no report"
fi

set +e
bash "$SCRIPT" --apply >"${TMP}/bad-flag.txt" 2>"${TMP}/bad-flag.err"
flag_status=$?
set -e
if [[ "$flag_status" -eq 2 ]]; then
  echo "ok   unknown flag exits 2"
else
  echo "FAIL unknown flag: exit ${flag_status}"
  fail=1
fi

# Help does not call docker.
: >"$LOG"
bash "$SCRIPT" --help >"${TMP}/help.txt"
if grep -q 'stats' "$LOG"; then
  echo "FAIL --help invoked docker"
  fail=1
else
  echo "ok   --help does not call docker"
fi

# Tie-break by name when usage matches.
printf '%s\n' \
  '{"ID":"111111111111","Name":"zeta","MemUsage":"1MiB / 1MiB"}' \
  '{"ID":"222222222222","Name":"alpha","MemUsage":"1MiB / 1MiB"}' \
  >"${FIX}/stats.ndjson"
write_inspect "111111111111" "111111111111" "/zeta" "zeta:latest" "1048576" "0" "0"
write_inspect "222222222222" "222222222222" "/alpha" "alpha:latest" "1048576" "0" "0"
: >"$LOG"
bash "$SCRIPT" --json >"${TMP}/tie.json"
python3 - "${TMP}/tie.json" <<'PY'
import json, sys
names = [row["name"] for row in json.load(open(sys.argv[1], encoding="utf-8"))["containers"]]
assert names == ["alpha", "zeta"], names
print("ok   equal usage sorts by name")
PY

# SI units (MB = 1000^2) still parse.
printf '%s\n' '{"ID":"333333333333","Name":"si-units","MemUsage":"100MB / 1GB"}' >"${FIX}/stats.ndjson"
write_inspect "333333333333" "333333333333" "/si-units" "si:latest" "1000000000" "0" "0"
bash "$SCRIPT" --json >"${TMP}/si.json"
python3 - "${TMP}/si.json" <<'PY'
import json, sys
row = json.load(open(sys.argv[1], encoding="utf-8"))["containers"][0]
assert row["memory_usage_bytes"] == 100 * 1000 ** 2, row["memory_usage_bytes"]
assert row["memory_limit_bytes"] == 1000000000
print("ok   SI megabytes parse")
PY

# Unsafe ids are not passed to docker. A cgroup path that walks out of the
# root, and a scope directory that is a symlink to the outside, are not read.
LINK_ID="fedcba987654"
write_inspect "$LINK_ID" "$LINK_ID" "/link-escape" "link:latest" "0" "0" "701"
write_cgroup_ptr 701 "0::/system.slice/link.scope"
printf '%s\n' \
  "{\"ID\":\"${ESCAPE_ID}\",\"Name\":\"escape\",\"MemUsage\":\"7MiB / 1MiB\"}" \
  "{\"ID\":\"${LINK_ID}\",\"Name\":\"link-escape\",\"MemUsage\":\"8MiB / 1MiB\"}" \
  '{"ID":"deadbeefdead;touch /tmp/x","Name":"bad-id","MemUsage":"1MiB / 1MiB"}' \
  >"${FIX}/stats.ndjson"
: >"$LOG"
bash "$SCRIPT" --json >"${TMP}/escape.json"
python3 - "${TMP}/escape.json" "$LOG" <<'PY'
import json, sys
report = json.load(open(sys.argv[1], encoding="utf-8"))
blob = json.dumps(report)
assert "TOPSECRET" not in blob
assert "999999" not in blob, blob
by_name = {row["name"]: row for row in report["containers"]}
assert by_name["escape"]["swap_bytes"] is None
assert by_name["escape"]["memory_current_bytes"] is None
assert by_name["link-escape"]["swap_bytes"] is None
assert by_name["link-escape"]["memory_limit_source"] == "none"
assert "bad-id" in by_name
log = open(sys.argv[2], encoding="utf-8").read()
assert "touch" not in log
assert "deadbeefdead" not in log
print("ok   path escape, symlink, and unsafe id")
PY

if [[ "$fail" -ne 0 ]]; then
  echo "container-mem-report tests failed"
  exit 1
fi
echo "container-mem-report tests passed"
