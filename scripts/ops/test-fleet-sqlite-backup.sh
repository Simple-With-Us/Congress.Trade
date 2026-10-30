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

# --- B2 prune: daily + weekly + hard 14-day age cap (Jay 2026-10-30) -------
# rclone stub backed by a local dir standing in for b2:<bucket>/hetzner/.
B2_FAKE="$TMP/b2-hetzner"
rclone() {
  case "$1" in
    lsf) ls -1 "$B2_FAKE" 2>/dev/null ;;
    delete)
      local inc=""
      while [ $# -gt 0 ]; do
        if [ "$1" = "--include" ]; then inc="${2#/}"; shift; fi
        shift
      done
      [ -n "$inc" ] && rm -f "$B2_FAKE/$inc"
      ;;
    *) return 0 ;;
  esac
}
# Seed one dump set (db + sha256) per stamp.
b2_seed() {
  rm -rf "$B2_FAKE"; mkdir -p "$B2_FAKE"
  local st
  for st in "$@"; do
    : > "$B2_FAKE/usage-monitor-${st}.db"
    : > "$B2_FAKE/usage-monitor-${st}.db.sha256"
  done
  # Litestream / qdrant style names must be ignored.
  : > "$B2_FAKE/generation.snapshot"
}
b2_has() { [ -e "$B2_FAKE/usage-monitor-$1.db" ] && echo yes || echo no; }
b2_stamps_for_days() {
  # Daily 06:45Z stamps for the N days ending on $1 (YYYY-MM-DD), newest first.
  local end="$1" n="$2" i
  for i in $(seq 0 $((n - 1))); do
    date -u -d "$end - $i days" +%Y%m%dT064500Z
  done
}

B2_KEEP_SETS=""
B2_KEEP_DAILY=3
B2_KEEP_WEEKLY=2
B2_MAX_AGE_DAYS=14

# Monday 2026-11-16: Sundays are 11-15 (1d), 11-08 (8d), 11-01 (15d).
# Pre-cap behaviour kept 11-08 + 11-01 as weeklies (11-15 is a daily) -> 15d.
# shellcheck disable=SC2046
b2_seed $(b2_stamps_for_days 2026-11-16 20)
prune_b2_sets usage-monitor jays-usage-monitor-eu 20261116T064500Z >/dev/null
assert_eq "$(b2_has 20261116T064500Z)" yes "B2 Monday keeps today (daily)"
assert_eq "$(b2_has 20261115T064500Z)" yes "B2 Monday keeps Sunday 1d (daily)"
assert_eq "$(b2_has 20261114T064500Z)" yes "B2 Monday keeps Saturday 2d (daily)"
assert_eq "$(b2_has 20261108T064500Z)" yes "B2 Monday keeps Sunday 8d (weekly)"
assert_eq "$(b2_has 20261101T064500Z)" no "B2 Monday age-caps Sunday 15d"
assert_eq "$(ls -1 "$B2_FAKE" | grep -c '\.db$')" 4 "B2 Monday leaves 4 sets"
assert_exists "$B2_FAKE/generation.snapshot" "B2 prune never touches snapshot files"

# Sunday 2026-11-15: weeklies land at 7d (11-08) and exactly 14d (11-01).
# shellcheck disable=SC2046
b2_seed $(b2_stamps_for_days 2026-11-15 20)
prune_b2_sets usage-monitor jays-usage-monitor-eu 20261115T064500Z >/dev/null
assert_eq "$(b2_has 20261108T064500Z)" yes "B2 Sunday keeps 7d weekly"
assert_eq "$(b2_has 20261101T064500Z)" yes "B2 Sunday keeps 14d weekly (cap is > 14d)"
assert_eq "$(b2_has 20261025T064500Z)" no "B2 Sunday drops 21d Sunday"
assert_eq "$(ls -1 "$B2_FAKE" | grep -c '\.db$')" 5 "B2 Sunday leaves 3 daily + 2 weekly"

# Every day for 6 weeks of daily runs: nothing on B2 is ever > 14 days old,
# and there are always 3 sets from the last 3 days.
rm -rf "$B2_FAKE"; mkdir -p "$B2_FAKE"
cap_ok=yes; daily_ok=yes
for i in $(seq 0 41); do
  day="$(date -u -d "2026-11-01 + $i days" +%Y-%m-%d)"
  st="$(date -u -d "$day" +%Y%m%dT064500Z)"
  : > "$B2_FAKE/usage-monitor-${st}.db"; : > "$B2_FAKE/usage-monitor-${st}.db.sha256"
  prune_b2_sets usage-monitor jays-usage-monitor-eu "$st" >/dev/null
  now_e="$(b2_stamp_epoch "$st")"
  for f in "$B2_FAKE"/*.db; do
    s2="$(basename "$f" .db)"; s2="${s2#usage-monitor-}"
    if [ $((now_e - $(b2_stamp_epoch "$s2"))) -gt $((14 * 86400)) ]; then cap_ok=no; fi
  done
  if [ "$i" -ge 2 ]; then
    for d in 0 1 2; do
      [ "$(b2_has "$(date -u -d "$day - $d days" +%Y%m%dT064500Z)")" = yes ] || daily_ok=no
    done
  fi
done
assert_eq "$cap_ok" yes "B2 6-week simulation never keeps a set older than 14d"
assert_eq "$daily_ok" yes "B2 6-week simulation always has the last 3 days"

# Twice-daily lane (ST/CT): dailies are one set per UTC date (3 days, not 1.5),
# and the two weeklies are two different Sundays.
rm -rf "$B2_FAKE"; mkdir -p "$B2_FAKE"
for st in 20261115T113000Z 20261115T003000Z 20261114T113000Z 20261114T003000Z \
          20261113T113000Z 20261113T003000Z 20261108T113000Z 20261108T003000Z \
          20261101T113000Z 20261101T003000Z; do
  : > "$B2_FAKE/usage-monitor-${st}.db"
done
prune_b2_sets usage-monitor jays-usage-monitor-eu 20261115T113000Z >/dev/null
assert_eq "$(b2_has 20261115T113000Z)" yes "B2 2x/day daily keeps newest of day 0"
assert_eq "$(b2_has 20261114T113000Z)" yes "B2 2x/day daily keeps newest of day 1"
assert_eq "$(b2_has 20261113T113000Z)" yes "B2 2x/day daily keeps newest of day 2"
assert_eq "$(b2_has 20261115T003000Z)" no "B2 2x/day drops older same-day set"
assert_eq "$(b2_has 20261114T003000Z)" no "B2 2x/day drops older set of day 1"
assert_eq "$(b2_has 20261108T113000Z)" yes "B2 weekly picks newest stamp of previous Sunday"
assert_eq "$(b2_has 20261108T003000Z)" no "B2 weekly keeps one set per Sunday"
assert_eq "$(b2_has 20261101T113000Z)" yes "B2 second weekly is the Sunday 14d back"
assert_eq "$(b2_has 20261101T003000Z)" no "B2 drops Sunday set older than 14d"

# Legacy B2_KEEP_SETS mode is capped too.
b2_seed 20261130T064500Z 20261101T064500Z
B2_KEEP_SETS=2
prune_b2_sets usage-monitor jays-usage-monitor-eu 20261130T064500Z >/dev/null
assert_eq "$(b2_has 20261130T064500Z)" yes "B2_KEEP_SETS keeps current set"
assert_eq "$(b2_has 20261101T064500Z)" no "B2_KEEP_SETS set older than 14d is age-capped"
B2_KEEP_SETS=""

# Bad B2_MAX_AGE_DAYS never disables the cap.
for bad in abc 0; do
  b2_seed 20261130T064500Z 20261115T064500Z
  B2_MAX_AGE_DAYS="$bad"
  prune_b2_sets usage-monitor jays-usage-monitor-eu 20261130T064500Z >/dev/null
  assert_eq "$(b2_has 20261115T064500Z)" no "B2_MAX_AGE_DAYS=$bad falls back to 14"
done
B2_MAX_AGE_DAYS=14

# Leading-zero B2_MAX_AGE_DAYS is decimal, not octal (Kody #2900).
b2_seed 20261130T064500Z 20261115T064500Z
B2_MAX_AGE_DAYS=08
prune_b2_sets usage-monitor jays-usage-monitor-eu 20261130T064500Z >/dev/null
assert_eq "$(b2_has 20261115T064500Z)" no "B2_MAX_AGE_DAYS=08 caps at 8 days"
B2_MAX_AGE_DAYS=14

# --- Central-time gate (Jay 2026-10-30 schedule) -------------------------
FLEET_BACKUP_CT_HOURS="06,19"
fleet_backup_ct_gate 06 && r=run || r=skip; assert_eq "$r" run "CT gate runs at 06 CT"
fleet_backup_ct_gate 19 && r=run || r=skip; assert_eq "$r" run "CT gate runs at 19 CT"
fleet_backup_ct_gate 05 && r=run || r=skip; assert_eq "$r" skip "CT gate skips off-slot 05 CT"
fleet_backup_ct_gate 20 && r=run || r=skip; assert_eq "$r" skip "CT gate skips off-slot 20 CT"
FLEET_BACKUP_CT_HOURS=""
fleet_backup_ct_gate 05 && r=run || r=skip; assert_eq "$r" run "CT gate unset always runs"

# Host runs on America/Chicago: each lane is one Central-time cron line.
CRON_FILE="${ROOT_DIR}/scripts/ops/fleet-backups.cron"
cron_ct_runs() {
  # $1 = lock name.  Prints Central HH:MM runs from the line's minute/hour fields.
  local line min hours h
  line="$(grep "fleet-sqlite-backup-$1.lock" "$CRON_FILE")"
  min="$(echo "$line" | awk '{print $1}')"
  hours="$(echo "$line" | awk '{print $2}')"
  for h in ${hours//,/ }; do printf '%02d:%02d\n' "$((10#$h))" "$((10#$min))"; done | sort | tr '\n' ' '
}
assert_eq "$(cron_ct_runs st)" "06:30 19:30 " "cron ST runs 6:30am+7:30pm CT"
assert_eq "$(cron_ct_runs ct)" "06:00 20:00 " "cron CT runs 6:00am+8:00pm CT"
assert_eq "$(cron_ct_runs um)" "20:30 " "cron UM runs 8:30pm CT"
assert_eq "$(grep -c 'FLEET_BACKUP_CT_HOURS=' "$CRON_FILE")" 0 "cron lines carry no UTC-era CT gate"
grep -q 'FLEET_BACKUP_APPS=socratic .*FLEET_BACKUP_KEEP_COUNT=4' "$CRON_FILE" && r=yes || r=no
assert_eq "$r" yes "cron ST local keep 4"
grep -q 'FLEET_BACKUP_APPS=congress .*FLEET_BACKUP_KEEP_COUNT=4' "$CRON_FILE" && r=yes || r=no
assert_eq "$r" yes "cron CT local keep 4"
grep -q 'FLEET_BACKUP_APPS=usage-monitor .*FLEET_BACKUP_KEEP_DAYS=2 FLEET_BACKUP_KEEP_COUNT=2' "$CRON_FILE" && r=yes || r=no
assert_eq "$r" yes "cron UM local keep 2 / 2 days"
assert_eq "$(grep -c 'B2_KEEP_DAILY=3 B2_KEEP_WEEKLY=2 B2_MAX_AGE_DAYS=14' "$CRON_FILE")" 3 "cron all lanes B2 3+2 with 14d cap"

# --- Log labels: UTC stamp + Central time with offset (Jay 2026-10-30) -----
assert_eq "$(fleet_ct_label 20261030T113000Z)" "20261030T113000Z (6:30am CDT, -05:00)" "log label CDT"
assert_eq "$(fleet_ct_label 20261102T123000Z)" "20261102T123000Z (6:30am CST, -06:00)" "log label CST after DST"
assert_eq "$(fleet_ct_label 20261101T063000Z)" "20261101T063000Z (1:30am CDT, -05:00)" "log label first 1:30am on fall-back night"
assert_eq "$(fleet_ct_label 20261101T073000Z)" "20261101T073000Z (1:30am CST, -06:00)" "log label second 1:30am on fall-back night"
assert_eq "$(fleet_ct_label not-a-stamp)" "not-a-stamp" "log label falls back to raw stamp"
now_label="$(fleet_ct_label)"
case "$now_label" in
  [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z\ \(*\ C[DS]T,\ -0[56]:00\)) r=ok ;;
  *) r="$now_label" ;;
esac
assert_eq "$r" ok "log label default is now"
grep -q 'start \$(fleet_ct_label "\$STAMP")' "$SCRIPT" && r=yes || r=no
assert_eq "$r" yes "start line carries Central label"
grep -q 'done \$(fleet_ct_label "\$STAMP")' "$SCRIPT" && r=yes || r=no
assert_eq "$r" yes "done line carries Central label"
grep -q 'STAMP="\$(date -u +%Y%m%dT%H%M%SZ)"' "$SCRIPT" && r=yes || r=no
assert_eq "$r" yes "file/object stamp stays UTC Z"

# The current set is never deleted even if its stamp parses oddly old.
b2_seed 20261130T064500Z
prune_b2_sets usage-monitor jays-usage-monitor-eu 20261130T064500Z >/dev/null
assert_eq "$(b2_has 20261130T064500Z)" yes "B2 prune never deletes the current set"

# --- B2 prune handles mixed plain .db and .db.zst sets (2026-10-30) --------
rm -rf "$B2_FAKE"; mkdir -p "$B2_FAKE"
for st in $(b2_stamps_for_days 2026-11-16 10); do
  if [ "$st" \> 20261112T000000Z ]; then ext=db.zst; else ext=db; fi
  : > "$B2_FAKE/usage-monitor-${st}.${ext}"; : > "$B2_FAKE/usage-monitor-${st}.db.sha256"
done
prune_b2_sets usage-monitor jays-usage-monitor-eu 20261116T064500Z >/dev/null
assert_exists "$B2_FAKE/usage-monitor-20261116T064500Z.db.zst" "B2 prune keeps newest .zst daily"
assert_exists "$B2_FAKE/usage-monitor-20261114T064500Z.db.zst" "B2 prune keeps 3rd .zst daily"
assert_missing "$B2_FAKE/usage-monitor-20261113T064500Z.db.zst" "B2 prune drops 4th .zst set"
assert_exists "$B2_FAKE/usage-monitor-20261108T064500Z.db" "B2 prune keeps plain .db weekly"
assert_missing "$B2_FAKE/usage-monitor-20261110T064500Z.db" "B2 prune drops old plain .db set"
assert_missing "$B2_FAKE/usage-monitor-20261110T064500Z.db.sha256" "B2 prune drops old sha256 sidecar"
assert_eq "$(ls -1 "$B2_FAKE" | grep -cE '\.db(\.zst)?$')" 4 "B2 mixed prune leaves 3 daily + 1 weekly"
unset -f rclone

# --- zstd upload + restore round trip (needs sqlite3 + zstd) ----------------
if command -v sqlite3 >/dev/null 2>&1 && command -v zstd >/dev/null 2>&1; then
  ZD="$TMP/zstd-app"; ZB="$TMP/zstd-b2"; mkdir -p "$ZD" "$ZB"
  zst_stamp=20261130T113000Z
  sqlite3 "$ZD/live.db" "PRAGMA journal_mode=WAL; CREATE TABLE t(x TEXT); WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i<20000) INSERT INTO t SELECT printf('row-%08d', i) FROM c;" >/dev/null
  STAMP="$zst_stamp"
  fleet_backup_alert() { :; }
  backup_one "socratic-app" "$ZD/live.db" "$ZD/out" >/dev/null
  : > "$ZD/out/socratic-app-20261129T113000Z.db"   # older raw dump: never uploaded
  rclone() {
    # copy <dir> <remote> --include A [--include B] ...: copy matching basenames.
    [ "$1" = copy ] || return 0
    local src="$2" pats=() f n p
    shift 3
    while [ $# -gt 0 ]; do
      [ "$1" = "--include" ] && { pats+=("$2"); shift; }
      shift
    done
    for f in "$src"/*; do
      n="$(basename "$f")"
      for p in "${pats[@]}"; do
        # shellcheck disable=SC2053
        if [[ "$n" == $p ]]; then cp "$f" "$ZB/$n"; break; fi
      done
    done
  }
  upload_b2_set "$ZD/out" jays-socratic-trade-eu "$zst_stamp" >/dev/null
  assert_exists "$ZB/socratic-app-${zst_stamp}.db.zst" "zstd upload sends .db.zst"
  assert_exists "$ZB/socratic-app-${zst_stamp}.db.sha256" "zstd upload sends raw sha256"
  assert_missing "$ZB/socratic-app-${zst_stamp}.db" "zstd upload does not send raw .db"
  assert_missing "$ZB/socratic-app-20261129T113000Z.db" "zstd upload only sends this run's set"
  assert_missing "$ZD/out/socratic-app-${zst_stamp}.db.zst" "local .zst removed after upload"
  assert_exists "$ZD/out/socratic-app-${zst_stamp}.db" "local raw dump kept"
  # Restore exactly like an operator would from B2.
  RD="$TMP/zstd-restore"; mkdir -p "$RD"
  zstd -q -d "$ZB/socratic-app-${zst_stamp}.db.zst" -o "$RD/socratic-app-${zst_stamp}.db"
  assert_eq "$(sqlite3 "$RD/socratic-app-${zst_stamp}.db" 'PRAGMA integrity_check;')" ok "restored .zst passes integrity_check"
  assert_eq "$(sqlite3 "$RD/socratic-app-${zst_stamp}.db" 'SELECT count(*) FROM t;')" 20000 "restored .zst has every row"
  want_sha="$(awk '{print $1}' "$ZB/socratic-app-${zst_stamp}.db.sha256")"
  got_sha="$(sha256sum "$RD/socratic-app-${zst_stamp}.db" | awk '{print $1}')"
  assert_eq "$got_sha" "$want_sha" "restored .zst matches raw-db sha256"
  # Disabled or failed compression falls back to the raw set.
  rm -f "$ZB"/*
  FLEET_BACKUP_B2_COMPRESS=0 upload_b2_set "$ZD/out" jays-socratic-trade-eu "$zst_stamp" >/dev/null
  assert_exists "$ZB/socratic-app-${zst_stamp}.db" "compress off uploads raw .db"
  assert_missing "$ZB/socratic-app-${zst_stamp}.db.zst" "compress off sends no .zst"
  unset -f rclone
else
  echo "skip zstd round trip (sqlite3 or zstd not installed)"
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "all tests passed"
exit 0
