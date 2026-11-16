#!/usr/bin/env bash
# Offline tests for fleet-backup-restore-drill.sh.
# Temp databases and fake dumps only. No live DB, no host, no network.
#
#   bash scripts/ops/test-fleet-backup-restore-drill.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="${ROOT_DIR}/scripts/ops/fleet-backup-restore-drill.sh"
fail=0

assert_eq() {
  local got="$1" want="$2" name="$3"
  if [[ "$got" != "$want" ]]; then
    printf 'FAIL %s: got %q want %q\n' "$name" "$got" "$want"
    fail=1
  else
    printf 'ok   %s\n' "$name"
  fi
}

assert_rc() {
  local want="$1" name="$2"
  if [[ "$RUN_RC" != "$want" ]]; then
    printf 'FAIL %s: rc=%s\n%s\n' "$name" "$RUN_RC" "$RUN_OUT"
    fail=1
  else
    printf 'ok   %s\n' "$name"
  fi
}

assert_contains() {
  local needle="$1" name="$2"
  if [[ "$RUN_OUT" == *"$needle"* ]]; then
    printf 'ok   %s\n' "$name"
  else
    printf 'FAIL %s: missing %q\n%s\n' "$name" "$needle" "$RUN_OUT"
    fail=1
  fi
}

assert_clean() {
  local name="$1" stray
  if [[ ! -f "$WORKDIR/sentinel" || ! -f "$ROOT/congress/keep-me" ]]; then
    printf 'FAIL %s: sentinel missing\n' "$name"
    fail=1
    return
  fi
  stray="$(find "$WORKDIR" "$ROOT" -name 'drill.*' -o -name 'restored.sqlite' -o -name '*.sqlite' | grep -v '/keep-me$' || true)"
  if [[ -n "$stray" ]]; then
    printf 'FAIL %s: leftover temp\n%s\n' "$name" "$stray"
    fail=1
  else
    printf 'ok   %s\n' "$name"
  fi
}

new_case() {
  local name="$1"
  CASE="${TMP}/cases/${name}"
  ROOT="${CASE}/backups"
  WORKDIR="${CASE}/work"
  LOCK="${CASE}/drill.lock"
  mkdir -p "$ROOT/congress" "$ROOT/socratic" "$ROOT/usage-monitor" "$WORKDIR" "$(dirname "$LOCK")"
  printf 'sentinel\n' >"$WORKDIR/sentinel"
  printf 'keep\n' >"$ROOT/congress/keep-me"
  export FLEET_BACKUP_DRILL_NICED=1
  export FLEET_BACKUP_ROOT="$ROOT"
  export FLEET_BACKUP_DRILL_WORKDIR="$WORKDIR"
  export FLEET_BACKUP_DRILL_LOCKFILE="$LOCK"
  export FLEET_BACKUP_DRILL_APPS=congress
  export FLEET_BACKUP_DRILL_TABLES=filers,filings,transactions
}

run_drill() {
  set +e
  RUN_OUT="$(bash "$SCRIPT" "$@" 2>&1)"
  RUN_RC=$?
  set -e
}

json_last() {
  printf '%s\n' "$RUN_OUT" | tail -n 1
}

make_sqlite() {
  local path="$1" version="$2" filers="$3" filings="$4" txs="$5" extra="${6:-}"
  sqlite3 "$path" <<SQL
PRAGMA user_version=${version};
CREATE TABLE filers (id INTEGER PRIMARY KEY);
CREATE TABLE filings (id INTEGER PRIMARY KEY);
CREATE TABLE transactions (id INTEGER PRIMARY KEY);
${extra}
INSERT INTO filers (id) SELECT value FROM generate_series(1, ${filers});
INSERT INTO filings (id) SELECT value FROM generate_series(1, ${filings});
INSERT INTO transactions (id) SELECT value FROM generate_series(1, ${txs});
SQL
  sha256sum -- "$path" >"${path}.sha256"
  chmod 640 -- "$path"
}

stamp_db() {
  local dir="$1" name="$2" stamp="$3"
  printf '%s/%s-%s.db\n' "$dir" "$name" "$stamp"
}

source_stamp() {
  local path="$1"
  stat -c '%i %s %a %Y' -- "$path"
}

TMP="$(mktemp -d "${TMPDIR:-/tmp}/fleet-restore-drill-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
chmod +x "$SCRIPT"
bash -n "$SCRIPT"
printf 'ok   bash -n\n'

# --- pure helpers -----------------------------------------------------------
set +e
(
  set -euo pipefail
  export FLEET_BACKUP_DRILL_LIB_ONLY=1
  # shellcheck disable=SC1090
  source "$SCRIPT"
  [[ "$(space_need_bytes 10)" == "15" ]]
  [[ "$(space_need_bytes 11)" == "17" ]]
  is_live_db /data/congress-trade/db.sqlite
  is_live_db /data/congress-trade/kv.sqlite
  is_live_db /data/prod.db
  is_live_db /var/lib/docker/volumes/example/_data/app.db
  if is_live_db /tmp/not-a-live-database.db; then
    exit 1
  fi
  db="${TMP}/unit.db"
  printf 'hello\n' >"$db"
  zstd -q -o "${db}.zst" -- "$db"
  [[ "$(zstd_content_bytes "${db}.zst")" == "$(stat -c %s -- "$db")" ]]
  printf 'not-zstd\n' >"${db}.bad.zst"
  if zstd_content_bytes "${db}.bad.zst" >/dev/null 2>&1; then
    exit 1
  fi
)
unit_rc=$?
set -e
if [[ "$unit_rc" == 0 ]]; then
  printf 'ok   helper space, live-path, and zstd size\n'
else
  printf 'FAIL helper space, live-path, and zstd size (rc=%s)\n' "$unit_rc"
  fail=1
fi

# --- newest plain dump ------------------------------------------------------
new_case plain
old="$(stamp_db "$ROOT/congress" congress-trade 20261110T000000Z)"
new="$(stamp_db "$ROOT/congress" congress-trade 20261112T000000Z)"
make_sqlite "$old" 7 1 1 1
make_sqlite "$new" 42 2 3 4
touch -d '2020-01-01 00:00:00' "$old" "${old}.sha256"
before="$(source_stamp "$new")"
run_drill --json
assert_rc 0 "plain newest passes"
assert_contains "PASS duration=" "plain PASS line"
assert_contains "integrity_check=ok quick_check=ok" "plain checks"
assert_contains "table filers=2" "plain filer count"
assert_contains "table filings=3" "plain filing count"
assert_contains "table transactions=4" "plain transaction count"
assert_contains "schema_version=42" "plain schema version"
python3 - "$(json_last)" <<'PY'
import json, sys
doc = json.loads(sys.argv[1])
dump = doc["dumps"][0]
assert doc["ok"] is True and doc["result"] == "PASS" and doc["space_factor"] == 1.5
assert isinstance(doc["duration_sec"], float)
assert dump["format"] == "db" and dump["sha256"] == "match" and dump["ok"] is True
assert dump["schema_version"] == 42
assert dump["tables"] == {"filers": 2, "filings": 3, "transactions": 4}
assert dump["integrity_check"] == "ok" and dump["quick_check"] == "ok"
assert dump["dump"].endswith("20261112T000000Z.db")
PY
printf 'ok   plain json\n'
assert_eq "$(source_stamp "$new")" "$before" "plain source inode size mode mtime"
assert_clean "plain leaves sentinels and removes temp"

# --- zstd newest, raw sha256 ------------------------------------------------
new_case zst
older="$(stamp_db "$ROOT/congress" congress-trade 20261111T000000Z)"
newer="$(stamp_db "$ROOT/congress" congress-trade 20261112T030000Z)"
make_sqlite "$older" 1 9 9 9
make_sqlite "$newer" 5 4 5 6
zstd -q -o "${newer}.zst" -- "$newer"
rm -f -- "$newer"
touch -d '2020-01-02 00:00:00' "$older"
before_zst="$(source_stamp "${newer}.zst")"
before_side="$(source_stamp "${newer}.sha256")"
run_drill --json
assert_rc 0 "zst newest passes"
assert_contains "table filers=4" "zst filer count"
python3 - "$(json_last)" <<'PY'
import json, sys
doc = json.loads(sys.argv[1])
dump = doc["dumps"][0]
assert dump["format"] == "zst" and dump["sha256"] == "match" and dump["schema_version"] == 5
assert dump["tables"]["transactions"] == 6
assert doc["ok"] is True
PY
printf 'ok   zst json\n'
assert_eq "$(source_stamp "${newer}.zst")" "$before_zst" "zst payload unchanged"
assert_eq "$(source_stamp "${newer}.sha256")" "$before_side" "zst sidecar unchanged"
assert_clean "zst removes only the temp copy"

# --- plain newer than an older zst ------------------------------------------
new_case mixed
zst_path="$(stamp_db "$ROOT/congress" congress-trade 20261112T010000Z)"
plain_path="$(stamp_db "$ROOT/congress" congress-trade 20261112T020000Z)"
make_sqlite "$zst_path" 1 1 1 1
zstd -q -o "${zst_path}.zst" -- "$zst_path"
rm -f -- "$zst_path"
make_sqlite "$plain_path" 8 7 1 1
touch -d '2020-01-03 00:00:00' "${zst_path}.zst"
run_drill --json
assert_rc 0 "newer plain beats older zst"
python3 - "$(json_last)" <<'PY'
import json, sys
dump = json.loads(sys.argv[1])["dumps"][0]
assert dump["format"] == "db" and dump["tables"]["filers"] == 7
PY
printf 'ok   newer plain json\n'

# --- skip incomplete, journal, and unstamped files --------------------------
new_case skip
good="$(stamp_db "$ROOT/congress" congress-trade 20261101T000000Z)"
nosh="$(stamp_db "$ROOT/congress" congress-trade 20261112T040000Z)"
journal="$(stamp_db "$ROOT/congress" congress-trade 20261112T050000Z)"
make_sqlite "$good" 3 2 2 2
make_sqlite "$nosh" 1 8 8 8
rm -f -- "${nosh}.sha256"
make_sqlite "$journal" 1 8 8 8
printf 'j\n' >"${journal}-journal"
printf 'stray\n' >"$ROOT/congress/notes.db"
printf 'deadbeef  notes.db\n' >"$ROOT/congress/notes.db.sha256"
touch -d '2019-01-01 00:00:00' "$good"
run_drill --json
assert_rc 0 "skip incomplete newest"
python3 - "$(json_last)" <<'PY'
import json, sys
dump = json.loads(sys.argv[1])["dumps"][0]
assert dump["dump"].endswith("20261101T000000Z.db")
assert dump["tables"]["filers"] == 2
PY
printf 'ok   skipped dump is not the one restored\n'
[[ -f "$nosh" && -f "${journal}-journal" && -f "$ROOT/congress/notes.db" ]]
printf 'ok   skipped files still on disk\n'

# --- sha256 mismatch and absent ---------------------------------------------
new_case mismatch
bad="$(stamp_db "$ROOT/congress" congress-trade 20261112T060000Z)"
make_sqlite "$bad" 4 1 1 1
printf '0000000000000000000000000000000000000000000000000000000000000000  x\n' >"${bad}.sha256"
before="$(source_stamp "$bad")"
run_drill --json
assert_rc 1 "sha256 mismatch fails"
assert_contains "sha256 mismatch" "sha256 mismatch reason"
assert_eq "$(source_stamp "$bad")" "$before" "mismatch does not touch the dump"
assert_clean "mismatch temp removed"

new_case absent
plain_abs="$(stamp_db "$ROOT/congress" congress-trade 20261112T070000Z)"
make_sqlite "$plain_abs" 6 1 2 3
rm -f -- "${plain_abs}.sha256"
run_drill --dump "$plain_abs" --json
assert_rc 0 "missing sidecar still checks the dump"
python3 - "$(json_last)" <<'PY'
import json, sys
dump = json.loads(sys.argv[1])["dumps"][0]
assert dump["sha256"] == "absent" and dump["ok"] is True
assert dump["tables"]["filings"] == 2
PY
printf 'ok   absent sidecar json\n'

# --- corrupt database and corrupt zstd --------------------------------------
new_case corrupt
corrupt="$(stamp_db "$ROOT/congress" congress-trade 20261112T080000Z)"
printf 'not a database\n' >"$corrupt"
sha256sum -- "$corrupt" >"${corrupt}.sha256"
run_drill --json
assert_rc 1 "corrupt db fails integrity"
assert_contains "integrity_check" "corrupt integrity reason"
assert_clean "corrupt temp removed"
[[ -f "$corrupt" ]]
printf 'ok   corrupt dump still present\n'

new_case badzst
badz="$(stamp_db "$ROOT/congress" congress-trade 20261112T090000Z)"
printf 'not-zstd\n' >"${badz}.zst"
printf 'abc  x\n' >"${badz}.sha256"
run_drill --json
assert_rc 1 "bad zstd fails closed"
assert_contains "unknown restored size" "bad zstd reason"
assert_clean "bad zstd writes nothing"

# --- free space fail closed, then exact 1.5x passes ------------------------
new_case space
space_db="$(stamp_db "$ROOT/congress" congress-trade 20261112T100000Z)"
make_sqlite "$space_db" 9 2 2 2
size="$(stat -c %s -- "$space_db")"
need=$(( (size * 3 + 1) / 2 ))
printf '%s\n' "$((need - 1))" >"$CASE/free"
stub="${CASE}/bin"
mkdir -p "$stub"
cat >"$stub/df" <<'EOF'
#!/bin/bash
if [[ "$1" != "-B1" || "$2" != "--output=avail" ]]; then
  printf 'bad df args\n' >&2
  exit 1
fi
printf 'Avail\n'
tr -d '[:space:]' <"$DRILL_FAKE_FREE"
printf '\n'
EOF
chmod +x "$stub/df"
before="$(source_stamp "$space_db")"
PATH="${stub}:${PATH}" DRILL_FAKE_FREE="${CASE}/free" run_drill --json
assert_rc 1 "free space below 1.5x fails"
assert_contains "free space" "free space reason"
assert_eq "$(source_stamp "$space_db")" "$before" "low space does not touch the dump"
assert_clean "low space creates no restore"
python3 - "$(json_last)" "$need" <<'PY'
import json, sys
doc = json.loads(sys.argv[1])
need = int(sys.argv[2])
dump = doc["dumps"][0]
assert doc["ok"] is False
assert dump["need_bytes"] == need
assert dump["free_bytes"] == need - 1
assert dump["error"].startswith("free space ")
PY
printf 'ok   low space json\n'

printf '%s\n' "$need" >"$CASE/free"
PATH="${stub}:${PATH}" DRILL_FAKE_FREE="${CASE}/free" run_drill --json
assert_rc 0 "free space at 1.5x passes"
assert_clean "exact space temp removed"

# --- live databases are refused and not created -----------------------------
new_case live
for live in \
  /data/congress-trade/db.sqlite \
  /data/congress-trade/kv.sqlite \
  /data/prod.db \
  /var/lib/docker/volumes/example/_data/app.db
do
  if [[ -e "$live" ]]; then
    before_live="$(source_stamp "$live")"
  else
    before_live=""
  fi
  run_drill --dump "$live" --json
  assert_rc 1 "live path fails ($(basename "$live"))"
  assert_contains "refusing live database" "live path message ($(basename "$live"))"
  if [[ -n "$before_live" ]]; then
    assert_eq "$(source_stamp "$live")" "$before_live" "live file unchanged ($(basename "$live"))"
  elif [[ -e "$live" ]]; then
    printf 'FAIL live path created %s\n' "$live"
    fail=1
  else
    printf 'ok   live path not created (%s)\n' "$(basename "$live")"
  fi
done

# --- workdir inside the backup root -----------------------------------------
new_case inside
inside_db="$(stamp_db "$ROOT/congress" congress-trade 20261112T110000Z)"
make_sqlite "$inside_db" 1 1 1 1
FLEET_BACKUP_DRILL_WORKDIR="$ROOT/congress" run_drill --json
assert_rc 1 "workdir inside backup root fails"
assert_contains "workdir is inside the backup root" "workdir reason"
[[ -f "$inside_db" && -f "$ROOT/congress/keep-me" ]]
printf 'ok   backup root untouched when workdir is refused\n'

# --- lock, unknown app, missing zstd, missing key table --------------------
new_case lock
lock_db="$(stamp_db "$ROOT/congress" congress-trade 20261112T120000Z)"
make_sqlite "$lock_db" 1 1 1 1
flock -n "$LOCK" -c 'sleep 30' &
lock_pid=$!
held=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if ! flock -n "$LOCK" true 2>/dev/null; then
    held=1
    break
  fi
  sleep 0.1
done
if [[ "$held" != 1 ]]; then
  printf 'FAIL could not observe held lock\n'
  fail=1
else
  run_drill --json
  assert_rc 1 "held lock fails"
  assert_contains "lock held" "held lock reason"
fi
kill "$lock_pid" 2>/dev/null || true
wait "$lock_pid" 2>/dev/null || true

new_case badapp
FLEET_BACKUP_DRILL_APPS=nope run_drill
assert_rc 1 "unknown app fails"
assert_contains "unknown app" "unknown app reason"

new_case nozstd
noz="$(stamp_db "$ROOT/congress" congress-trade 20261112T130000Z)"
make_sqlite "$noz" 2 1 1 1
zstd -q -o "${noz}.zst" -- "$noz"
rm -f -- "$noz"
bin="${CASE}/nozstd-bin"
mkdir -p "$bin"
for cmd in bash sqlite3 python3 df stat flock mkdir mktemp realpath readlink sha256sum awk find sort date chmod cp rm cat mv touch basename dirname tr head tail grep sed nice ionice; do
  src="$(command -v "$cmd" || true)"
  [[ -n "$src" ]] || continue
  ln -s "$src" "$bin/$cmd"
done
before="$(source_stamp "${noz}.zst")"
PATH="$bin" run_drill --json
assert_rc 1 "missing zstd fails"
assert_contains "zstd missing" "missing zstd reason"
assert_eq "$(source_stamp "${noz}.zst")" "$before" "missing zstd does not touch the payload"
assert_clean "missing zstd temp removed"

new_case notable
note="$(stamp_db "$ROOT/congress" congress-trade 20261112T140000Z)"
sqlite3 "$note" "CREATE TABLE other (id INTEGER); INSERT INTO other VALUES (1);"
sha256sum -- "$note" >"${note}.sha256"
run_drill --json
assert_rc 1 "missing key table fails"
assert_contains "key table" "missing key table reason"

# --- schema_migrations, and user_version wins when both exist ---------------
new_case migrations
mig="$(stamp_db "$ROOT/congress" congress-trade 20261112T150000Z)"
sqlite3 "$mig" <<'SQL'
PRAGMA user_version=0;
CREATE TABLE filers (id INTEGER PRIMARY KEY);
CREATE TABLE filings (id INTEGER PRIMARY KEY);
CREATE TABLE transactions (id INTEGER PRIMARY KEY);
CREATE TABLE schema_migrations (version INTEGER);
INSERT INTO schema_migrations (version) VALUES (3), (11);
INSERT INTO filers (id) VALUES (1);
INSERT INTO filings (id) VALUES (1);
INSERT INTO transactions (id) VALUES (1);
SQL
sha256sum -- "$mig" >"${mig}.sha256"
run_drill --json
assert_rc 0 "schema_migrations version passes"
python3 - "$(json_last)" <<'PY'
import json, sys
assert json.loads(sys.argv[1])["dumps"][0]["schema_version"] == 11
PY
printf 'ok   schema_migrations version json\n'

new_case bothver
both="$(stamp_db "$ROOT/congress" congress-trade 20261112T160000Z)"
make_sqlite "$both" 42 1 1 1 "CREATE TABLE schema_migrations (version INTEGER); INSERT INTO schema_migrations (version) VALUES (1);"
run_drill --json
assert_rc 0 "user_version wins"
python3 - "$(json_last)" <<'PY'
import json, sys
assert json.loads(sys.argv[1])["dumps"][0]["schema_version"] == 42
PY
printf 'ok   user_version preferred over schema_migrations\n'

# --- two apps: one bad dump fails the run -----------------------------------
new_case two
good2="$(stamp_db "$ROOT/congress" congress-trade 20261112T170000Z)"
bad2="$(stamp_db "$ROOT/socratic" socratic-app 20261112T170000Z)"
make_sqlite "$good2" 1 1 1 1
printf 'nope\n' >"$bad2"
sha256sum -- "$bad2" >"${bad2}.sha256"
FLEET_BACKUP_DRILL_APPS=congress,socratic run_drill --json
assert_rc 1 "one bad app fails the run"
python3 - "$(json_last)" <<'PY'
import json, sys
dumps = json.loads(sys.argv[1])["dumps"]
by_app = {item["app"]: item for item in dumps}
assert by_app["congress"]["ok"] is True
assert by_app["socratic"]["ok"] is False
PY
printf 'ok   per-app json\n'
assert_clean "two-app temp removed"

# --- sqlite3 without -nofollow still passes ---------------------------------
new_case oldsqlite
oldcli="$(stamp_db "$ROOT/congress" congress-trade 20261112T175000Z)"
make_sqlite "$oldcli" 4 2 2 2
cat >"$CASE/sqlite3" <<'EOF'
#!/bin/bash
kept=()
for arg in "$@"; do
  if [[ "$arg" == "-nofollow" ]]; then
    printf '%s\n' "Error: unknown option: -nofollow" >&2
    exit 1
  fi
  kept+=("$arg")
done
exec /usr/bin/sqlite3 "${kept[@]}"
EOF
chmod +x "$CASE/sqlite3"
PATH="${CASE}:${PATH}" run_drill --json
assert_rc 0 "older sqlite3 without -nofollow passes"
assert_contains "integrity_check=ok quick_check=ok" "older sqlite3 still checks"
python3 - "$(json_last)" <<'PY'
import json, sys
dump = json.loads(sys.argv[1])["dumps"][0]
assert dump["ok"] is True and dump["tables"]["filers"] == 2
assert dump["schema_version"] == 4
PY
printf 'ok   older sqlite3 json\n'
assert_clean "older sqlite3 temp removed"

# --- nice/ionice re-exec still passes ---------------------------------------
new_case renice
nice_db="$(stamp_db "$ROOT/congress" congress-trade 20261112T180000Z)"
make_sqlite "$nice_db" 1 1 1 1
set +e
RUN_OUT="$(env -u FLEET_BACKUP_DRILL_NICED \
  FLEET_BACKUP_ROOT="$ROOT" \
  FLEET_BACKUP_DRILL_WORKDIR="$WORKDIR" \
  FLEET_BACKUP_DRILL_LOCKFILE="$LOCK" \
  FLEET_BACKUP_DRILL_APPS=congress \
  bash "$SCRIPT" --json 2>&1)"
RUN_RC=$?
set -e
assert_rc 0 "nice/ionice re-exec passes"
assert_contains "PASS duration=" "re-exec PASS line"
if [[ "$RUN_OUT" == *"ionice unavailable"* ]]; then
  printf 'FAIL ionice should be available in this environment\n%s\n' "$RUN_OUT"
  fail=1
else
  printf 'ok   ionice re-exec used\n'
fi
assert_clean "re-exec temp removed"

if [[ "$fail" != 0 ]]; then
  printf 'restore drill tests failed\n'
  exit 1
fi
printf 'restore drill tests passed\n'
