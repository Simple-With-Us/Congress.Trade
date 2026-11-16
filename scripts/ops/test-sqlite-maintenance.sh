#!/usr/bin/env bash
# Offline tests for scripts/ops/sqlite-maintenance.sh.
# Temporary sqlite databases only.  No Docker daemon, Coolify, or production host.
#
#   bash scripts/ops/test-sqlite-maintenance.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="${ROOT}/scripts/ops/sqlite-maintenance.sh"
SERVICE="${ROOT}/scripts/ops/systemd.noindex/sqlite-maintenance.service"
TIMER="${ROOT}/scripts/ops/systemd.noindex/sqlite-maintenance.timer"
REAL_SQLITE=/usr/bin/sqlite3
TMP="$(mktemp -d)"
BIN="${TMP}/bin"
LOCK="${TMP}/maint.lock"
WRAP_LOG="${TMP}/sqlite-wrapper.log"
DOCKER_LOG="${TMP}/docker-stub.log"
HOLDER=""
fail=0

cleanup() {
  if [[ -n "${HOLDER}" ]]; then
    kill "${HOLDER}" 2>/dev/null || true
    wait "${HOLDER}" 2>/dev/null || true
    HOLDER=""
  fi
  rm -rf -- "${TMP}"
}
trap cleanup EXIT

mkdir -p "${BIN}"
cat >"${BIN}/sqlite3" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${SQLITE_WRAPPER_LOG:?}"
if [[ -n "${SQLITE_WRAPPER_FAIL_SUBSTR:-}" && "$*" == *"${SQLITE_WRAPPER_FAIL_SUBSTR}"* ]]; then
  exit 1
fi
exec /usr/bin/sqlite3 "$@"
EOF
cat >"${BIN}/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${DOCKER_STUB_LOG:?}"
if [[ "${DOCKER_STUB_FAIL:-0}" == "1" ]]; then
  exit 1
fi
if [[ "$1" != "ps" ]]; then
  echo "unexpected docker args: $*" >&2
  exit 1
fi
if [[ "$*" == *"-a"* ]]; then
  printf '%s\n' "${DOCKER_STUB_PS_A-}"
  exit 0
fi
printf '%s\n' "${DOCKER_STUB_PS-}"
exit 0
EOF
chmod 755 "${BIN}/sqlite3" "${BIN}/docker"

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
    printf '%s\n' "$hay" | head -n 20
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

show_streams() {
  printf '%s\n' "${MAINT_ERR}" "${MAINT_OUT}" | head -n 40
}

expect_code() {
  local want="$1" name="$2"
  if [[ "${MAINT_CODE}" != "$want" ]]; then
    echo "FAIL ${name}: exit ${MAINT_CODE} want ${want}"
    show_streams
    fail=1
  else
    echo "ok   ${name}"
  fi
}

run_maint() {
  local err="${TMP}/stderr.txt"
  set +e
  MAINT_OUT=$("$@" 2>"${err}")
  MAINT_CODE=$?
  set -e
  MAINT_ERR="$(cat "${err}" 2>/dev/null || true)"
}

maint() {
  : >"${WRAP_LOG}"
  : >"${DOCKER_LOG}"
  run_maint env \
    PATH="${BIN}:/usr/bin:/bin" \
    SQLITE_WRAPPER_LOG="${WRAP_LOG}" \
    DOCKER_STUB_LOG="${DOCKER_LOG}" \
    "$@"
}

combined() {
  printf '%s\n%s\n' "${MAINT_OUT}" "${MAINT_ERR}"
}

new_db() {
  local path="${TMP}/db-${1}.sqlite"
  # sqlite3_close checkpoints the WAL.  os._exit skips that so the -wal file
  # is still there for the report.  Stats are recorded before any later open.
  python3 - "${path}" <<'PY'
import os
import sqlite3
import sys

path = sys.argv[1]
conn = sqlite3.connect(path)
conn.execute("PRAGMA journal_mode=WAL")
conn.execute("PRAGMA wal_autocheckpoint=0")
conn.execute("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)")
conn.execute("BEGIN")
rows = [("kept-%s-%s" % (i, "x" * 80),) for i in range(1, 301)]
conn.executemany("INSERT INTO t(v) VALUES (?)", rows)
conn.commit()
conn.execute("DELETE FROM t WHERE id<=250")
conn.commit()
page_size = conn.execute("PRAGMA page_size").fetchone()[0]
page_count = conn.execute("PRAGMA page_count").fetchone()[0]
freelist = conn.execute("PRAGMA freelist_count").fetchone()[0]
kept = conn.execute("SELECT v FROM t WHERE id=300").fetchone()[0]
count = conn.execute("SELECT COUNT(*) FROM t").fetchone()[0]
conn.commit()
def size(suffix):
    target = path + suffix
    return os.path.getsize(target) if os.path.exists(target) else 0
stats = "\n".join([
    "file_bytes=%s" % size(""),
    "wal_bytes=%s" % size("-wal"),
    "shm_bytes=%s" % size("-shm"),
    "page_size=%s" % page_size,
    "page_count=%s" % page_count,
    "freelist=%s" % freelist,
    "kept=%s" % kept,
    "count=%s" % count,
]) + "\n"
with open(path + ".stats", "w", encoding="utf-8") as handle:
    handle.write(stats)
sys.stdout.write(path + "\n")
sys.stdout.flush()
os._exit(0)
PY
}

stat_field() {
  sed -n "s/^${2}=//p" "${1}.stats"
}

fresh_marker() {
  local path="$1"
  date +%s >"${path}"
}

bash -n "${SCRIPT}"
echo "ok   bash -n sqlite-maintenance.sh"

help_out="$(bash "${SCRIPT}" --help)"
assert_eq "$?" "0" "help exits 0"
assert_contains "${help_out}" "wal_checkpoint(PASSIVE)" "help names the default checkpoint"
assert_contains "${help_out}" "Never deletes database files." "help states databases are kept"

maint bash "${SCRIPT}" --lock-file "${LOCK}"
expect_code 1 "no database paths is an error"
assert_not_contains "$(combined)" "wal_checkpoint(TRUNCATE)" "usage error does not checkpoint"

missing="${TMP}/missing.sqlite"
maint bash "${SCRIPT}" --lock-file "${LOCK}" --db "${missing}"
expect_code 1 "missing database is an error"
if [[ -e "${missing}" || -e "${missing}-wal" || -e "${missing}-shm" ]]; then
  echo "FAIL missing database was created"
  fail=1
else
  echo "ok   missing database is not created"
fi

maint bash "${SCRIPT}" --lock-file "${LOCK}" --json --db "${missing}"
expect_code 1 "missing database json exits 1"
assert_not_contains "$(combined)" "unbound variable" "missing database does not abort in append_row"
python3 - "${missing}" "${MAINT_OUT}" <<'PY'
import json, sys
path, raw = sys.argv[1:]
doc = json.loads(raw)
row = doc["databases"][0]
assert row["path"] == path
assert row["error"] == "missing"
assert row["vacuum"]["requested"] is False
assert row["vacuum"]["ran"] is False
assert row["vacuum"]["reason"] is None
print("ok   missing database json names the error")
PY

db="$(new_db one)"
file_bytes="$(stat_field "${db}" file_bytes)"
wal_bytes="$(stat_field "${db}" wal_bytes)"
shm_bytes="$(stat_field "${db}" shm_bytes)"
page_size="$(stat_field "${db}" page_size)"
page_count="$(stat_field "${db}" page_count)"
freelist="$(stat_field "${db}" freelist)"
reclaim=$((freelist * page_size))
if [[ "${freelist}" -le 0 || "${wal_bytes}" -le 0 || "${shm_bytes}" -le 0 ]]; then
  echo "FAIL fixture has no freelist or WAL (freelist=${freelist} wal=${wal_bytes} shm=${shm_bytes})"
  fail=1
else
  echo "ok   fixture has freelist and a WAL"
fi
inode="$(stat -c%i -- "${db}")"
kept_before="$(stat_field "${db}" kept)"

maint bash "${SCRIPT}" --lock-file "${LOCK}" --db "${db}"
expect_code 0 "default run exits 0"
report="$(combined)"
assert_contains "${report}" "report db=${db} file_bytes=${file_bytes} wal_bytes=${wal_bytes} shm_bytes=${shm_bytes} page_size=${page_size} page_count=${page_count} freelist_count=${freelist} reclaimable_bytes=${reclaim}" "report matches file and page stats"
assert_contains "${report}" "checkpoint mode=PASSIVE" "default checkpoint is PASSIVE"
assert_contains "$(cat "${WRAP_LOG}")" "PRAGMA wal_checkpoint(PASSIVE);" "default SQL is PASSIVE"
assert_not_contains "$(cat "${WRAP_LOG}")" "wal_checkpoint(TRUNCATE)" "default SQL has no TRUNCATE"
assert_not_contains "$(cat "${WRAP_LOG}")" "wal_checkpoint(RESTART)" "default SQL has no RESTART"
assert_not_contains "$(cat "${WRAP_LOG}")" "busy_timeout" "PASSIVE does not set busy_timeout"
assert_not_contains "$(cat "${WRAP_LOG}")" "VACUUM" "default SQL has no VACUUM"
assert_eq "$(stat -c%i -- "${db}")" "${inode}" "PASSIVE keeps the database inode"
assert_eq "$("${REAL_SQLITE}" "${db}" "SELECT v FROM t WHERE id=300;")" "${kept_before}" "PASSIVE keeps the row"
assert_eq "$(wc -l <"${DOCKER_LOG}" | tr -d ' ')" "0" "report plus PASSIVE does not ask docker"

maint bash "${SCRIPT}" --lock-file "${LOCK}" --db "${db}" --db "${db}"
expect_code 0 "duplicate paths are accepted"
report_count="$(printf '%s\n' "$(combined)" | grep -c "report db=${db} " || true)"
assert_eq "${report_count}" "1" "duplicate paths run once"

maint env DRY_RUN=1 bash "${SCRIPT}" --lock-file "${LOCK}" --db "${db}"
expect_code 0 "DRY_RUN exits 0"
assert_contains "$(combined)" "checkpoint skipped reason=dry-run mode=PASSIVE" "DRY_RUN skips the checkpoint"
assert_not_contains "$(cat "${WRAP_LOG}")" "wal_checkpoint" "DRY_RUN does not call wal_checkpoint"
assert_contains "$(cat "${WRAP_LOG}")" "PRAGMA freelist_count;" "DRY_RUN still reads page stats"

plain="${TMP}/plain.sqlite"
"${REAL_SQLITE}" "${plain}" "CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t(v) VALUES ('kept-plain');"
maint bash "${SCRIPT}" --lock-file "${LOCK}" --db "${plain}" --vacuum
expect_code 3 "a non-WAL database still reaches the vacuum guards"
assert_contains "$(combined)" "checkpoint skipped reason=not-wal" "a rollback database is reported as not-wal"
assert_not_contains "$(combined)" "checkpoint-parse" "a not-WAL checkpoint is not a parse error"
assert_contains "$(combined)" "reason=backup-marker-missing" "not-wal does not skip the vacuum guards"
assert_eq "$("${REAL_SQLITE}" "${plain}" "SELECT v FROM t WHERE id=1;")" "kept-plain" "a not-WAL report keeps the row"

maint bash "${SCRIPT}" --lock-file "${LOCK}" --db "${db}" --checkpoint none
expect_code 0 "checkpoint none exits 0"
assert_contains "$(combined)" "reason=checkpoint-none" "none mode is reported"
assert_not_contains "$(cat "${WRAP_LOG}")" "wal_checkpoint" "none mode does not checkpoint"

maint bash "${SCRIPT}" --lock-file "${LOCK}" --db "${db}" --checkpoint truncate --busy-timeout-ms 15000
expect_code 0 "explicit truncate exits 0"
assert_contains "$(cat "${WRAP_LOG}")" "PRAGMA busy_timeout=15000; PRAGMA wal_checkpoint(TRUNCATE);" "truncate sets busy_timeout in the same call"
assert_not_contains "$(cat "${WRAP_LOG}")" "wal_checkpoint(PASSIVE)" "truncate run is not PASSIVE"
assert_eq "$("${REAL_SQLITE}" "${db}" "SELECT v FROM t WHERE id=300;")" "${kept_before}" "truncate keeps the row"

maint bash "${SCRIPT}" --lock-file "${LOCK}" --db "${db}" --checkpoint restart --busy-timeout-ms 15000
expect_code 0 "explicit restart exits 0"
assert_contains "$(cat "${WRAP_LOG}")" "PRAGMA busy_timeout=15000; PRAGMA wal_checkpoint(RESTART);" "restart sets busy_timeout"
assert_eq "$("${REAL_SQLITE}" "${db}" "SELECT COUNT(*) FROM t;")" "50" "restart keeps the remaining rows"

maint bash "${SCRIPT}" --lock-file "${LOCK}" --db "${db}" --checkpoint full
expect_code 1 "unknown checkpoint mode is an error"
assert_eq "$(wc -l <"${WRAP_LOG}" | tr -d ' ')" "0" "unknown mode does not open sqlite"

maint bash "${SCRIPT}" --lock-file "${LOCK}" --db "${db}" --busy-timeout-ms 999999
expect_code 1 "busy timeout above the cap is an error"

db_b="$(new_db two)"
maint bash "${SCRIPT}" --lock-file "${LOCK}" --json --db "${db}" --db "${db_b}"
expect_code 0 "json run exits 0"
assert_not_contains "${MAINT_OUT}" "sqlite-maintenance:" "json stdout is not the human report"
python3 - "${db}" "${db_b}" "${MAINT_OUT}" <<'PY'
import json, sys
path_a, path_b, raw = sys.argv[1:]
doc = json.loads(raw)
assert doc["dry_run"] is False
assert doc["checkpoint_mode"] == "PASSIVE"
assert doc["vacuum"] is False
assert [row["path"] for row in doc["databases"]] == [path_a, path_b]
row = doc["databases"][0]
assert row["error"] is None
assert row["reclaimable_bytes"] == row["freelist_count"] * row["page_size"]
assert row["file_bytes"] > 0
assert row["wal_bytes"] >= 0
assert row["shm_bytes"] >= 0
assert isinstance(row["checkpoint"]["busy"], int)
assert isinstance(row["checkpoint"]["log"], int)
assert isinstance(row["checkpoint"]["checkpointed"], int)
assert row["checkpoint"]["mode"] == "PASSIVE"
assert row["checkpoint"]["skipped"] is None
assert row["vacuum"]["requested"] is False
assert row["vacuum"]["ran"] is False
print("ok   json document has both databases and the page fields")
PY

marker="${TMP}/marker"
db_v="$(new_db vacuum)"
free_before="$(stat_field "${db_v}" freelist)"
kept_v="$(stat_field "${db_v}" kept)"
if [[ "${free_before}" -le 0 ]]; then
  echo "FAIL vacuum fixture has no freelist"
  fail=1
else
  echo "ok   vacuum fixture has freelist ${free_before}"
fi

maint bash "${SCRIPT}" --lock-file "${LOCK}" --db "${db_v}" --vacuum \
  --busy-timeout-ms 60000
expect_code 3 "vacuum without a marker is refused"
assert_contains "$(combined)" "vacuum refused reason=backup-marker-missing" "missing marker is named"
assert_not_contains "$(cat "${WRAP_LOG}")" "VACUUM;" "refused vacuum does not run VACUUM"
assert_eq "$("${REAL_SQLITE}" "${db_v}" "PRAGMA freelist_count;")" "${free_before}" "refused vacuum keeps the freelist"

printf '1000\n' >"${marker}"
maint bash "${SCRIPT}" --lock-file "${LOCK}" --db "${db_v}" --vacuum \
  --backup-marker "${marker}" --backup-max-age-hours 36
expect_code 3 "stale marker is refused"
assert_contains "$(combined)" "reason=backup-marker-stale" "stale marker is named"

date +%s >"${marker}"
printf 'ok=0\n' >>"${marker}"
maint bash "${SCRIPT}" --lock-file "${LOCK}" --db "${db_v}" --vacuum \
  --backup-marker "${marker}"
expect_code 3 "not-ok marker is refused"
assert_contains "$(combined)" "reason=backup-marker-not-ok" "not-ok marker is named"

printf 'verified_epoch=%s\n' "$(( $(date +%s) + 3600 ))" >"${marker}"
maint bash "${SCRIPT}" --lock-file "${LOCK}" --db "${db_v}" --vacuum \
  --backup-marker "${marker}"
expect_code 3 "future marker is refused"
assert_contains "$(combined)" "reason=backup-marker-invalid" "future marker is invalid"

printf '%s\n' "$(( $(date +%s) - 3700 ))" >"${marker}"
maint SQLITE_MAINT_ALLOW_FREE_OVERRIDE=1 SQLITE_MAINT_FREE_BYTES=1 \
  SQLITE_MAINT_ALLOW_DEPLOY_OVERRIDE=1 SQLITE_MAINT_DEPLOY_STATE=idle \
  bash "${SCRIPT}" --lock-file "${LOCK}" --db "${db_v}" --vacuum \
  --backup-marker "${marker}" --backup-max-age-hours 1
expect_code 3 "marker older than the cap is stale before the disk guard"
assert_contains "$(combined)" "reason=backup-marker-stale" "a marker past the cap is stale"

printf '%s\n' "$(( $(date +%s) - 3500 ))" >"${marker}"
maint SQLITE_MAINT_ALLOW_FREE_OVERRIDE=1 SQLITE_MAINT_FREE_BYTES=1 \
  SQLITE_MAINT_ALLOW_DEPLOY_OVERRIDE=1 SQLITE_MAINT_DEPLOY_STATE=idle \
  bash "${SCRIPT}" --lock-file "${LOCK}" --db "${db_v}" --vacuum \
  --backup-marker "${marker}" --backup-max-age-hours 1
expect_code 3 "marker inside the cap reaches the disk guard"
assert_contains "$(combined)" "reason=disk-free-low" "a marker inside the cap is fresh"
assert_not_contains "$(combined)" "reason=backup-marker-stale" "a marker inside the cap is not stale"

date -u -Iseconds >"${marker}"
maint SQLITE_MAINT_ALLOW_FREE_OVERRIDE=1 SQLITE_MAINT_FREE_BYTES=1 \
  SQLITE_MAINT_ALLOW_DEPLOY_OVERRIDE=1 SQLITE_MAINT_DEPLOY_STATE=idle \
  bash "${SCRIPT}" --lock-file "${LOCK}" --db "${db_v}" --vacuum \
  --backup-marker "${marker}"
expect_code 3 "ISO marker is parsed"
assert_contains "$(combined)" "reason=disk-free-low" "ISO marker is fresh enough to reach the disk guard"

bytes="$(stat -c%s -- "${db_v}")"
need=$(((bytes * 5 + 1) / 2))
below=$((need - 1))
fresh_marker "${marker}"
maint SQLITE_MAINT_ALLOW_FREE_OVERRIDE=1 SQLITE_MAINT_FREE_BYTES="${below}" \
  SQLITE_MAINT_ALLOW_DEPLOY_OVERRIDE=1 SQLITE_MAINT_DEPLOY_STATE=idle \
  bash "${SCRIPT}" --lock-file "${LOCK}" --db "${db_v}" --vacuum \
  --backup-marker "${marker}"
expect_code 3 "free space one byte under 2.5x is refused"
assert_contains "$(combined)" "reason=disk-free-low" "low disk is named"
assert_contains "$(combined)" "need_bytes=${need}" "low disk reports the 2.5x threshold"
assert_eq "$("${REAL_SQLITE}" "${db_v}" "PRAGMA freelist_count;")" "${free_before}" "low disk does not vacuum"

fresh_marker "${marker}"
maint SQLITE_MAINT_FREE_BYTES=1 \
  SQLITE_MAINT_ALLOW_DEPLOY_OVERRIDE=1 SQLITE_MAINT_DEPLOY_STATE=idle \
  bash "${SCRIPT}" --lock-file "${LOCK}" --db "${db_v}" --vacuum --dry-run \
  --backup-marker "${marker}"
expect_code 0 "ungated free-byte override does not trip the disk guard"
assert_contains "$(combined)" "vacuum dry-run" "real free space allows a dry-run vacuum"
assert_not_contains "$(cat "${WRAP_LOG}")" "VACUUM;" "dry-run vacuum does not execute VACUUM"
assert_eq "$("${REAL_SQLITE}" "${db_v}" "PRAGMA freelist_count;")" "${free_before}" "dry-run keeps the freelist"

fresh_marker "${marker}"
maint DOCKER_STUB_PS="coolify-builder" \
  SQLITE_MAINT_DEPLOY_STATE=idle \
  SQLITE_MAINT_ALLOW_FREE_OVERRIDE=1 SQLITE_MAINT_FREE_BYTES="${need}" \
  bash "${SCRIPT}" --lock-file "${LOCK}" --db "${db_v}" --vacuum \
  --backup-marker "${marker}"
expect_code 3 "builder container refuses vacuum"
assert_contains "$(combined)" "reason=deploy-active" "coolify-builder is deploy-active"
assert_not_contains "$(cat "${WRAP_LOG}")" "VACUUM;" "deploy-active does not vacuum"

fresh_marker "${marker}"
maint DOCKER_STUB_PS="NiXpAcKs-1" \
  SQLITE_MAINT_ALLOW_FREE_OVERRIDE=1 SQLITE_MAINT_FREE_BYTES="${need}" \
  bash "${SCRIPT}" --lock-file "${LOCK}" --db "${db_v}" --vacuum \
  --backup-marker "${marker}"
expect_code 3 "nixpacks name refuses vacuum"
assert_contains "$(combined)" "reason=deploy-active" "nixpacks match is case-insensitive"

fresh_marker "${marker}"
maint DOCKER_STUB_PS="" DOCKER_STUB_PS_A="Created" \
  SQLITE_MAINT_ALLOW_FREE_OVERRIDE=1 SQLITE_MAINT_FREE_BYTES="${need}" \
  bash "${SCRIPT}" --lock-file "${LOCK}" --db "${db_v}" --vacuum \
  --backup-marker "${marker}"
expect_code 3 "created app container refuses vacuum"
assert_contains "$(combined)" "reason=deploy-active" "congress-app Created is deploy-active"

fresh_marker "${marker}"
maint DOCKER_STUB_FAIL=1 \
  SQLITE_MAINT_ALLOW_FREE_OVERRIDE=1 SQLITE_MAINT_FREE_BYTES="${need}" \
  bash "${SCRIPT}" --lock-file "${LOCK}" --db "${db_v}" --vacuum \
  --backup-marker "${marker}"
expect_code 3 "unknown deploy state refuses vacuum"
assert_contains "$(combined)" "reason=deploy-unknown" "docker failure is fail-closed"

fresh_marker "${marker}"
maint DOCKER_STUB_PS="congress-app-1" DOCKER_STUB_PS_A="Up 3 hours (healthy)" \
  SQLITE_MAINT_ALLOW_FREE_OVERRIDE=1 SQLITE_MAINT_FREE_BYTES="${need}" \
  bash "${SCRIPT}" --lock-file "${LOCK}" --db "${db_v}" --vacuum --dry-run \
  --backup-marker "${marker}"
expect_code 0 "idle app container allows the guarded dry-run"
assert_contains "$(combined)" "vacuum dry-run" "healthy congress-app is not a deploy"
assert_not_contains "$(combined)" "reason=deploy-active" "healthy status is idle"

fresh_marker "${marker}"
maint SQLITE_MAINT_ALLOW_DEPLOY_OVERRIDE=1 SQLITE_MAINT_DEPLOY_STATE=idle \
  SQLITE_MAINT_ALLOW_FREE_OVERRIDE=1 SQLITE_MAINT_FREE_BYTES="${need}" \
  bash "${SCRIPT}" --lock-file "${LOCK}" --db "${db_v}" --vacuum \
  --backup-marker "${marker}" --busy-timeout-ms 60000
expect_code 0 "guarded vacuum exits 0"
assert_contains "$(cat "${WRAP_LOG}")" "PRAGMA busy_timeout=60000; VACUUM;" "vacuum SQL is plain VACUUM"
assert_not_contains "$(cat "${WRAP_LOG}")" "VACUUM INTO" "vacuum SQL is not VACUUM INTO"
assert_contains "$(combined)" "vacuum ok" "vacuum reports success"
free_after="$("${REAL_SQLITE}" "${db_v}" "PRAGMA freelist_count;")"
if [[ "${free_after}" -ge "${free_before}" ]]; then
  echo "FAIL vacuum did not shrink freelist (${free_before} -> ${free_after})"
  fail=1
else
  echo "ok   vacuum shrinks freelist ${free_before} -> ${free_after}"
fi
assert_eq "$("${REAL_SQLITE}" "${db_v}" "SELECT v FROM t WHERE id=300;")" "${kept_v}" "vacuum keeps the row"
page_after="$("${REAL_SQLITE}" "${db_v}" "PRAGMA page_size;")"
fresh_marker "${marker}"
maint SQLITE_MAINT_ALLOW_DEPLOY_OVERRIDE=1 SQLITE_MAINT_DEPLOY_STATE=idle \
  SQLITE_MAINT_ALLOW_FREE_OVERRIDE=1 SQLITE_MAINT_FREE_BYTES="${need}" \
  bash "${SCRIPT}" --lock-file "${LOCK}" --json --db "${db_v}" --vacuum \
  --backup-marker "${marker}" --busy-timeout-ms 60000
expect_code 0 "json vacuum exits 0"
python3 - "${db_v}" "${page_after}" "${MAINT_OUT}" <<'PY'
import json, sys
path, page_size, raw = sys.argv[1:]
doc = json.loads(raw)
row = doc["databases"][0]
assert row["path"] == path
assert row["error"] is None
assert row["page_size"] == int(page_size)
assert row["reclaimable_bytes"] == row["freelist_count"] * row["page_size"]
assert row["vacuum"]["ran"] is True
assert row["vacuum"]["post_freelist_count"] == 0
assert row["vacuum"]["post_reclaimable_bytes"] == 0
print("ok   json vacuum keeps the pre-run page size")
PY
if [[ ! -f "${db_v}" ]]; then
  echo "FAIL vacuum removed the database file"
  fail=1
else
  echo "ok   vacuum leaves the database file in place"
fi

db_fail="$(new_db fail)"
free_fail="$(stat_field "${db_fail}" freelist)"
fresh_marker "${marker}"
fail_bytes="$(stat -c%s -- "${db_fail}")"
fail_need=$(((fail_bytes * 5 + 1) / 2))
maint SQLITE_WRAPPER_FAIL_SUBSTR="VACUUM;" \
  SQLITE_MAINT_ALLOW_DEPLOY_OVERRIDE=1 SQLITE_MAINT_DEPLOY_STATE=idle \
  SQLITE_MAINT_ALLOW_FREE_OVERRIDE=1 SQLITE_MAINT_FREE_BYTES="${fail_need}" \
  bash "${SCRIPT}" --lock-file "${LOCK}" --db "${db_fail}" --vacuum \
  --backup-marker "${marker}" --busy-timeout-ms 60000
expect_code 5 "failed VACUUM is exit 5"
assert_contains "$(combined)" "vacuum failed" "failed VACUUM is reported"
assert_eq "$("${REAL_SQLITE}" "${db_fail}" "SELECT COUNT(*) FROM t;")" "50" "failed VACUUM keeps the rows"
assert_eq "$("${REAL_SQLITE}" "${db_fail}" "PRAGMA freelist_count;")" "${free_fail}" "failed VACUUM keeps the freelist"
if [[ ! -f "${db_fail}" ]]; then
  echo "FAIL a failed VACUUM removed the database"
  fail=1
else
  echo "ok   a failed VACUUM leaves the database file"
fi

flock -n "${LOCK}" -c "sleep 30" &
HOLDER=$!
held=0
for _ in $(seq 1 50); do
  if ! flock -n "${LOCK}" -c "true"; then
    held=1
    break
  fi
  sleep 0.05
done
assert_eq "${held}" "1" "test holds the maintenance lock"
db_lock="$(new_db lock)"
lock_mtime="$(stat -c%Y -- "${db_lock}")"
maint bash "${SCRIPT}" --lock-file "${LOCK}" --db "${db_lock}"
expect_code 2 "a second run exits 2"
assert_contains "$(combined)" "lock busy" "lock contention is reported"
assert_eq "$(wc -l <"${WRAP_LOG}" | tr -d ' ')" "0" "a busy lock does not open sqlite"
assert_eq "$(stat -c%Y -- "${db_lock}")" "${lock_mtime}" "a busy lock does not touch the database"
kill "${HOLDER}" 2>/dev/null || true
wait "${HOLDER}" 2>/dev/null || true
HOLDER=""

script_text="$(cat "${SCRIPT}")"
rm_lines="$(grep -n -E '(^|[^[:alnum:]_])rm( |$)' "${SCRIPT}" || true)"
rm_count="$(printf '%s\n' "${rm_lines}" | grep -c . || true)"
assert_eq "${rm_count}" "1" "the script removes one scratch path"
assert_contains "${rm_lines}" 'rm -f -- "$NDJSON"' "that removal is the json scratch file"
assert_not_contains "${script_text}" "COOLIFY_TOKEN" "script does not read a Coolify token"
assert_not_contains "${script_text}" "congress-health-recover.env" "script does not source the health env"
if grep -E '^(source|\.) ' "${SCRIPT}" | grep -E 'box-disk-hygiene|fleet-sqlite-backup|fleet-backup-verify'; then
  echo "FAIL script sources a CT-2471 or CT-2472 file"
  fail=1
else
  echo "ok   script does not source CT-2471 or CT-2472 files"
fi

service_text="$(cat "${SERVICE}")"
timer_text="$(cat "${TIMER}")"
assert_contains "${service_text}" "ExecStart=/usr/local/bin/sqlite-maintenance.sh" "service starts the script with no extra args"
assert_contains "${service_text}" "SQLITE_DBS=/data/congress-trade/db.sqlite" "service names the live database"
assert_contains "${service_text}" "SQLITE_CHECKPOINT=passive" "service checkpoint is passive"
assert_not_contains "${service_text}" "SQLITE_VACUUM" "service does not opt into VACUUM"
assert_not_contains "${service_text}" "--vacuum" "service command has no vacuum flag"
assert_contains "${timer_text}" "OnCalendar=Sun 09:30:00" "timer is weekly"
assert_not_contains "${timer_text}" "Requires=" "timer does not start the service when the timer starts"
assert_not_contains "${timer_text}" "--vacuum" "timer has no vacuum flag"
assert_not_contains "${timer_text}" "SQLITE_VACUUM" "timer does not opt into VACUUM"

if [[ "${fail}" -ne 0 ]]; then
  echo "sqlite-maintenance tests failed"
  exit 1
fi
echo "sqlite-maintenance tests passed"
