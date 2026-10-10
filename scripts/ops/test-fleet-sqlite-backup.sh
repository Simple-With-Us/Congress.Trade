#!/usr/bin/env bash
# Offline tests for fleet-sqlite-backup.sh retention + completeness.
# No Docker, no live DBs, no network.
#
#   bash scripts/ops/test-fleet-sqlite-backup.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="${ROOT_DIR}/scripts/ops/fleet-sqlite-backup.sh"
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

assert_exists() {
  local path="$1" name="$2"
  if [ -e "$path" ]; then
    echo "ok   ${name}"
  else
    echo "FAIL ${name}: missing ${path}"
    fail=1
  fi
}

assert_missing() {
  local path="$1" name="$2"
  if [ -e "$path" ]; then
    echo "FAIL ${name}: unexpectedly exists ${path}"
    fail=1
  else
    echo "ok   ${name}"
  fi
}

age_file() {
  local path="$1" days="$2"
  python3 - "$path" "$days" <<'PY'
import os, sys, time
path, days = sys.argv[1], float(sys.argv[2])
ts = time.time() - days * 86400
os.utime(path, (ts, ts))
PY
}

TMP="$(mktemp -d "${TMPDIR:-/tmp}/fleet-backup-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# shellcheck disable=SC1090
export FLEET_BACKUP_APPS=socratic,congress
FLEET_BACKUP_LIB_ONLY=1 . "$SCRIPT"
backup_apps_selected

# --- dump_is_complete -------------------------------------------------------
APP="$TMP/socratic"
mkdir -p "$APP"
complete="$APP/socratic-app-20260101T000000Z.db"
printf 'complete-db\n' > "$complete"
printf 'deadbeef  %s\n' "$complete" > "${complete}.sha256"
if dump_is_complete "$complete"; then
  echo "ok   complete dump with sha256 and no journal"
else
  echo "FAIL complete dump should pass dump_is_complete"
  fail=1
fi

incomplete_nosh="$APP/socratic-app-20260102T000000Z.db"
printf 'incomplete-no-sha\n' > "$incomplete_nosh"
if dump_is_complete "$incomplete_nosh"; then
  echo "FAIL dump missing .sha256 should not be complete"
  fail=1
else
  echo "ok   missing .sha256 is incomplete"
fi

journaled="$APP/socratic-app-20260103T000000Z.db"
printf 'journaled\n' > "$journaled"
printf 'deadbeef  %s\n' "$journaled" > "${journaled}.sha256"
printf 'j\n' > "${journaled}-journal"
if dump_is_complete "$journaled"; then
  echo "FAIL dump with .db-journal should not be complete"
  fail=1
else
  echo "ok   .db-journal sidecar is incomplete"
fi

# --- KEEP_COUNT must ignore incomplete dumps (the 2026-09-06 race) ---------
# Newest file is incomplete (mtime now).  Older file is complete.
# KEEP_COUNT=1 must keep the complete dump and drop the incomplete one.
ROOT="$TMP"
KEEP_COUNT=1
KEEP_DAYS=30
age_file "$complete" 2
age_file "${complete}.sha256" 2
apply_local_retention

assert_exists "$complete" "KEEP_COUNT keeps older complete dump"
assert_exists "${complete}.sha256" "KEEP_COUNT keeps matching .sha256"
assert_missing "$incomplete_nosh" "KEEP_COUNT does not keep dump without .sha256"
assert_missing "$journaled" "KEEP_COUNT does not keep dump with .db-journal"
assert_missing "${journaled}-journal" "journal sidecar is removed with incomplete dump"

# Extra complete dumps beyond KEEP_COUNT are pruned (newest complete kept).
newer_complete="$APP/socratic-app-20260104T000000Z.db"
printf 'newer-complete\n' > "$newer_complete"
printf 'deadbeef  %s\n' "$newer_complete" > "${newer_complete}.sha256"
older_complete="$APP/socratic-app-20251201T000000Z.db"
printf 'older-complete\n' > "$older_complete"
printf 'deadbeef  %s\n' "$older_complete" > "${older_complete}.sha256"
age_file "$older_complete" 3
age_file "${older_complete}.sha256" 3
KEEP_COUNT=1
apply_local_retention
assert_exists "$newer_complete" "KEEP_COUNT=1 keeps newest complete"
assert_missing "$older_complete" "KEEP_COUNT=1 prunes older complete"
assert_missing "${older_complete}.sha256" "KEEP_COUNT prunes sha256 with the dump"

# --- KEEP_DAYS only age-prunes complete dumps --------------------------------
age_dir="$TMP/congress"
mkdir -p "$age_dir"
old_complete="$age_dir/congress-trade-20251201T000000Z.db"
printf 'old-complete\n' > "$old_complete"
printf 'deadbeef  %s\n' "$old_complete" > "${old_complete}.sha256"
age_file "$old_complete" 10
age_file "${old_complete}.sha256" 10
fresh_complete="$age_dir/congress-trade-20260906T000000Z.db"
printf 'fresh-complete\n' > "$fresh_complete"
printf 'deadbeef  %s\n' "$fresh_complete" > "${fresh_complete}.sha256"
stale_incomplete="$age_dir/congress-trade-20260905T000000Z.db"
printf 'stale-incomplete\n' > "$stale_incomplete"
age_file "$stale_incomplete" 10
KEEP_DAYS=7
KEEP_COUNT=10
apply_local_retention
assert_missing "$old_complete" "KEEP_DAYS deletes complete dump older than keep days"
assert_missing "${old_complete}.sha256" "KEEP_DAYS deletes sha256 with aged complete dump"
assert_exists "$fresh_complete" "KEEP_DAYS keeps complete dump inside the window"
assert_missing "$stale_incomplete" "incomplete dump is dropped even when aged (never preferred)"

# kv.sqlite copies are age-pruned independently of completeness
old_kv="$age_dir/kv-20251201T000000Z.sqlite"
printf 'kv\n' > "$old_kv"
age_file "$old_kv" 10
KEEP_DAYS=7
prune_by_age
assert_missing "$old_kv" "KEEP_DAYS deletes aged kv.sqlite copies"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "all tests passed"
exit 0
