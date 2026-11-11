#!/usr/bin/env bash
# Consistent SQLite snapshots for fleet apps + optional off-host copy.
# Complements Hetzner daily host backups (RPO ~24h host-level).
#
# Per-app lanes (Jay 2026-10-30): one cron lane per app, Central-time slots
# (ST 6:30am + 7:30pm, CT 6:00am + 8:00pm, UM 8:30pm), local keep 2 days
# (ST 4, CT 4, UM 2), B2 3 dailies + 2 weeklies with a hard 14-day max age.
# Select apps with FLEET_BACKUP_APPS=socratic,congress,usage-monitor.
# Cron: /etc/cron.d/fleet-backups (three dump lines + weekly UM-only verify).
# The host runs on America/Chicago, so cron times are Central directly.
# FLEET_BACKUP_CT_HOURS is an optional extra gate (unset in the shipped cron).
#
# Hardening (2026-09-06, board e1f66898):
#   1) in-script flock -n single-flight (same path as the host cron wrapper)
#   2) local retention only counts/deletes COMPLETE dumps (.sha256 present, no
#      .db-journal sidecar); incomplete files never occupy KEEP_COUNT slots
#   3) timeout around sqlite3 VACUUM INTO (FLEET_BACKUP_TIMEOUT, default 30m)
# Hardening (2026-09-12, board cbed4f30 / 93c48e00):
#   4) VACUUM INTO instead of sqlite3 .backup -- online backup never converges on
#      the ~11 GB ST DB under continuous writers
#   5) a timed-out or failed dump ALERTS and returns non-zero (never return 0)
# Local compression (CT-2472, OPS-1006): after a dump is complete (sha256
#   present, no rollback journal), zstd replaces the plain `.db` with
#   `<name>-<STAMP>.db.zst` in the same directory.  Keep counts are unchanged
#   and the files stay on the root disk (`/data/backups` is a symlink chain
#   onto `/backups`; readlink -f before measure or delete).  Incomplete dumps
#   are never compressed or removed by the compress step.  Retention still
#   drops incomplete files so they cannot occupy a KEEP_COUNT slot.
#   FLEET_BACKUP_LOCAL_COMPRESS=0 leaves plain `.db`.  Missing zstd leaves
#   plain `.db` and logs a warning.
# B2 compression (Jay 2026-10-30): the offsite object is still
#   `<name>-<STAMP>.db.zst` plus the raw-db `.db.sha256`.  B2/R2 keep policy
#   is unchanged.  When the local file is already `.db.zst`, that file is
#   uploaded and kept.  FLEET_BACKUP_B2_COMPRESS=0, or no zstd on PATH,
#   uploads the raw `.db` when it is still present.
#   Restore: zstd -d X-<STAMP>.db.zst -o X-<STAMP>.db, then PRAGMA integrity_check.
#   Older B2 sets stay plain `.db`; prune handles both.
# Host install after merge: /usr/local/sbin/fleet-sqlite-backup.sh on
# fleet-hetzner-nbg1 (apply on top of the UUID-pinned host copy; do not
# overwrite wholesale).  Not a Coolify image bake.
set -euo pipefail

KEEP_DAYS="${FLEET_BACKUP_KEEP_DAYS:-2}"
KEEP_COUNT="${FLEET_BACKUP_KEEP_COUNT:-2}"
FLEET_BACKUP_TIMEOUT="${FLEET_BACKUP_TIMEOUT:-30m}"
LOCKFILE="${FLEET_BACKUP_LOCKFILE:-/var/lock/fleet-sqlite-backup.lock}"
ROOT="/data/backups"

# Comma-separated app dirs to dump/prune this run.  Default = all three.
# Valid tokens: socratic, congress, usage-monitor.
FLEET_BACKUP_APPS="${FLEET_BACKUP_APPS:-socratic,congress,usage-monitor}"
# When 1: print which local dirs and B2 hetzner/ prefixes prune would touch,
# then exit before VACUUM / upload / delete.  Never deletes.
FLEET_BACKUP_DRY_RUN="${FLEET_BACKUP_DRY_RUN:-0}"

backup_apps_selected() {
  local raw token
  BACKUP_APP_LIST=()
  raw="$(printf '%s' "${FLEET_BACKUP_APPS:-}" | tr '[:upper:]' '[:lower:]' | tr ',' ' ')"
  for token in $raw; do
    case "$token" in
      socratic|congress|usage-monitor) BACKUP_APP_LIST+=("$token") ;;
      '' ) ;;
      *) echo "[fleet-backup] WARN unknown FLEET_BACKUP_APPS token: $token (ignored)" ;;
    esac
  done
  if [ "${#BACKUP_APP_LIST[@]}" -eq 0 ]; then
    echo "[fleet-backup] FAIL FLEET_BACKUP_APPS empty after parse" >&2
    return 1
  fi
  return 0
}

app_enabled() {
  local want="$1" a
  [ "${#BACKUP_APP_LIST[@]}" -eq 0 ] && return 1
  for a in "${BACKUP_APP_LIST[@]}"; do
    [ "$a" = "$want" ] && return 0
  done
  return 1
}

BACKUP_APP_LIST=()


# /data/backups is a symlink chain onto /backups on the root disk.  Resolve
# before measuring or deleting, and never delete a path that lands outside
# that resolved root (a symlink planted in the dump dir).
resolve_fs_path() {
  local p="$1"
  if [ -e "$p" ] || [ -L "$p" ]; then
    readlink -f -- "$p"
  else
    printf '%s\n' "$p"
  fi
}

resolve_backup_root() {
  if [ -d "$ROOT" ] || [ -L "$ROOT" ]; then
    resolve_fs_path "$ROOT"
    return 0
  fi
  return 1
}

# Logical dump path ending in .db.  The .sha256 and -journal sidecars hang off it.
dump_base_db() {
  local f="$1"
  case "$f" in
    *.db.zst) printf '%s\n' "${f%.zst}" ;;
    *) printf '%s\n' "$f" ;;
  esac
}

path_under_root() {
  local root="$1" path="$2" r p
  r="$(resolve_fs_path "$root")"
  p="$(resolve_fs_path "$path")"
  case "$p" in
    "$r"/*) return 0 ;;
  esac
  return 1
}

# Byte size of the physical file.  Callers pass either the symlink path or
# the real path; du always sees the readlink -f target.
measure_path_bytes() {
  local resolved
  [ -e "$1" ] || [ -L "$1" ] || return 1
  resolved="$(resolve_fs_path "$1")"
  du -b "$resolved" | awk '{print $1}'
}

# Delete one logical dump's payload and sidecars on the resolved root.
rm_dump_set() {
  local base="$1" root_real p resolved
  base="$(dump_base_db "$base")"
  root_real="$(resolve_backup_root)" || return 0
  for p in "$base" "${base}.sha256" "${base}.zst" "${base}-journal" "${base}-wal" "${base}.zst.partial"; do
    [ -e "$p" ] || [ -L "$p" ] || continue
    resolved="$(resolve_fs_path "$p")"
    if ! path_under_root "$root_real" "$resolved"; then
      echo "[fleet-backup] SKIP delete outside backup root: $p -> $resolved" >&2
      continue
    fi
    rm -f "$resolved"
  done
}

# A dump is complete when a payload exists (.db and/or .db.zst), a matching
# .sha256 sidecar exists, and sqlite3 is not still writing a rollback journal.
# Incomplete files must never win KEEP_COUNT / KEEP_DAYS over a finished snapshot.
dump_is_complete() {
  local f base
  f="$1"
  if [ -e "$f" ] || [ -L "$f" ]; then
    f="$(resolve_fs_path "$f")"
  fi
  base="$(dump_base_db "$f")"
  case "$base" in
    *.db) ;;
    *) return 1 ;;
  esac
  [ -f "${base}.sha256" ] || return 1
  [ ! -e "${base}-journal" ] || return 1
  if [ -f "$base" ] && [ -s "$base" ]; then
    return 0
  fi
  if [ -f "${base}.zst" ] && [ -s "${base}.zst" ]; then
    return 0
  fi
  return 1
}

# Newest-first logical .db paths (one per stamp) under a physical app dir.
list_dump_bases_newest_first() {
  local dir="$1" path
  [ -d "$dir" ] || return 0
  find "$dir" -maxdepth 1 -type f \( -name '*.db' -o -name '*.db.zst' \) -printf '%T@\t%p\n' 2>/dev/null \
    | sort -nr \
    | while IFS=$'\t' read -r _ts path; do
        [ -n "$path" ] || continue
        dump_base_db "$path"
      done
}

# VACUUM INTO runs in ONE read transaction so concurrent writers cannot
# restart it (sqlite3 .backup restarts from page 1 on every writer
# checkpoint and never finishes an ~11 GB live DB).
sqlite_backup_with_timeout() {
  local src="$1" dest="$2"
  local tmo="${FLEET_BACKUP_TIMEOUT:-30m}"
  rm -f "$dest"
  if command -v timeout >/dev/null 2>&1; then
    timeout -k 30s "$tmo" sqlite3 "$src" "VACUUM INTO '$dest'"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout -k 30s "$tmo" sqlite3 "$src" "VACUUM INTO '$dest'"
  else
    echo "[fleet-backup] WARN timeout(1) missing; sqlite3 VACUUM INTO has no bound"
    sqlite3 "$src" "VACUUM INTO '$dest'"
  fi
}

# Optional host webhook (Infisical/host env).  Never embed a secret here.
fleet_backup_alert() {
  local msg="$1"
  echo "[fleet-backup] ALERT $msg" >&2
  if [ -n "${FLEET_BACKUP_ALERT_URL:-}" ]; then
    python3 - "$FLEET_BACKUP_ALERT_URL" "$msg" <<'PY'
import json, sys, urllib.request
url, msg = sys.argv[1], sys.argv[2]
req = urllib.request.Request(
    url,
    data=json.dumps({"text": "fleet-backup: " + msg}).encode(),
    headers={"content-type": "application/json"},
    method="POST",
)
try:
    urllib.request.urlopen(req, timeout=10).read()
except Exception:
    pass
PY
  fi
}

backup_one() {
  local name="$1" src="$2" dest_dir="$3"
  mkdir -p "$dest_dir"
  if [ ! -f "$src" ]; then
    echo "[fleet-backup] SKIP $name (missing $src)"
    return 0
  fi
  if [ ! -s "$src" ]; then
    echo "[fleet-backup] SKIP $name (empty $src)"
    return 0
  fi
  # Housekeeper 2026-09-15: do not VACUUM CT while congress-app is stopped
  # (races IR wal_checkpoint / leaves writers holding WAL).
  if [ "$name" = "congress-trade" ]; then
    if ! docker ps --format '{{.Names}}' | grep -qE 'congress-app'; then
      echo "[fleet-backup] SKIP $name (congress-app not running -- avoid VACUUM race with host IR)"
      return 0
    fi
  fi
  local dest="$dest_dir/${name}-${STAMP}.db"
  if command -v sqlite3 >/dev/null 2>&1; then
    if ! sqlite_backup_with_timeout "$src" "$dest"; then
      echo "[fleet-backup] FAIL $name sqlite3 VACUUM INTO timed out or failed (timeout=${FLEET_BACKUP_TIMEOUT}): $src"
      rm -f "$dest" "${dest}-journal" "${dest}-wal" "${dest}.sha256"
      fleet_backup_alert "$name VACUUM INTO timed out or failed (timeout=${FLEET_BACKUP_TIMEOUT})"
      return 1
    fi
  else
    echo "[fleet-backup] FAIL $name sqlite3 CLI missing; refusing a torn cp of a live DB"
    fleet_backup_alert "$name sqlite3 CLI missing"
    return 1
  fi
  # integrity + checksum: sha256 is the completeness marker for retention
  if sqlite3 "$dest" "PRAGMA integrity_check;" | head -1 | grep -qx ok; then
    echo "[fleet-backup] OK $name -> $dest ($(du -h "$(resolve_fs_path "$dest")" | awk '{print $1}')) at $(fleet_ct_label)"
    sha256sum "$dest" > "${dest}.sha256"
  else
    echo "[fleet-backup] FAIL $name integrity not clean: $dest"
    rm -f "${dest}.sha256" "$dest"
    fleet_backup_alert "$name integrity_check failed"
    return 1
  fi
}

prune_incomplete_dumps() {
  local root_real app dir f base resolved
  local -A seen=()
  root_real="$(resolve_backup_root)" || return 0
  for app in "${BACKUP_APP_LIST[@]}"; do
    dir="$root_real/$app"
    [ -d "$dir" ] || continue
    seen=()
    # Torn compress output only.  A finished .db.zst is a local dump, not a
    # leftover B2 upload, and must survive this pass.
    for f in "$dir"/*.zst.partial; do
      [ -e "$f" ] || [ -L "$f" ] || continue
      resolved="$(resolve_fs_path "$f")"
      path_under_root "$root_real" "$resolved" || continue
      echo "[fleet-backup] prune-stale-zst $resolved at $(fleet_ct_label)"
      rm -f "$resolved"
    done
    for f in "$dir"/*.db "$dir"/*.db.zst; do
      [ -f "$f" ] || continue
      base="$(dump_base_db "$(resolve_fs_path "$f")")"
      [ -n "${seen[$base]:-}" ] && continue
      seen["$base"]=1
      if dump_is_complete "$base"; then
        continue
      fi
      echo "[fleet-backup] prune-incomplete $base at $(fleet_ct_label)"
      rm_dump_set "$base"
    done
  done
}

payload_is_older_than_keep_days() {
  local p="$1"
  [ -f "$p" ] || return 1
  find "$p" -maxdepth 0 -type f -mtime +"$KEEP_DAYS" -print 2>/dev/null | grep -q .
}

prune_by_age() {
  local root_real app dir f s db base p aged resolved
  local -A seen=()
  root_real="$(resolve_backup_root)" || return 0
  case "$KEEP_DAYS" in
    ''|*[!0-9]*)
      echo "[fleet-backup] retention SKIP: non-numeric FLEET_BACKUP_KEEP_DAYS=$KEEP_DAYS"
      return 0
      ;;
  esac
  # Age-prune only complete dumps so an incomplete newer file cannot keep a
  # finished snapshot from being the one KEEP_DAYS considers.  Scoped to
  # FLEET_BACKUP_APPS dirs only (ST/CT keep-2 must not touch UM dumps).
  # A logical dump is old only when every payload that exists (.db and .db.zst)
  # is older than KEEP_DAYS, so compressing a fresh copy cannot be undone by
  # an older sidecar.
  for app in "${BACKUP_APP_LIST[@]}"; do
    dir="$root_real/$app"
    [ -d "$dir" ] || continue
    seen=()
    for f in "$dir"/*.db "$dir"/*.db.zst; do
      [ -f "$f" ] || continue
      base="$(dump_base_db "$(resolve_fs_path "$f")")"
      [ -n "${seen[$base]:-}" ] && continue
      seen["$base"]=1
      dump_is_complete "$base" || continue
      aged=1
      for p in "$base" "${base}.zst"; do
        [ -f "$p" ] || continue
        if ! payload_is_older_than_keep_days "$p"; then
          aged=0
        fi
      done
      if [ "$aged" = 1 ]; then
        echo "[fleet-backup] prune-age $base at $(fleet_ct_label)"
        rm_dump_set "$base"
      fi
    done
    find "$dir" -type f -name '*.sqlite' -mtime +"$KEEP_DAYS" -print 2>/dev/null | while read -r f; do
      resolved="$(resolve_fs_path "$f")"
      path_under_root "$root_real" "$resolved" || continue
      echo "[fleet-backup] prune-age $resolved at $(fleet_ct_label)"
      rm -f "$resolved"
    done || true
    find "$dir" -type f -name '*.sha256' -mtime +"$KEEP_DAYS" -print 2>/dev/null | while read -r s; do
      db="${s%.sha256}"
      # .db.sha256 belongs to either the plain dump or the .db.zst payload.
      if [ ! -f "$db" ] && [ ! -f "${db}.zst" ]; then
        resolved="$(resolve_fs_path "$s")"
        path_under_root "$root_real" "$resolved" || continue
        echo "[fleet-backup] prune-age-orphan $resolved at $(fleet_ct_label)"
        rm -f "$resolved"
      fi
    done || true
  done
}

prune_by_keep_count() {
  local root_real app dir base n
  local -A seen=()
  root_real="$(resolve_backup_root)" || return 0
  case "$KEEP_COUNT" in
    ''|*[!0-9]*)
      echo "[fleet-backup] retention SKIP: non-numeric FLEET_BACKUP_KEEP_COUNT=$KEEP_COUNT"
      return 0
      ;;
  esac
  if [ "$KEEP_COUNT" -lt 1 ]; then
    echo "[fleet-backup] retention SKIP: FLEET_BACKUP_KEEP_COUNT must be >= 1 (got $KEEP_COUNT)"
    return 0
  fi
  for app in "${BACKUP_APP_LIST[@]}"; do
    dir="$root_real/$app"
    [ -d "$dir" ] || continue
    n=0
    seen=()
    # Newest-first; skip anything that is not a complete dump so a live
    # .db-journal or missing .sha256 cannot occupy a KEEP_COUNT slot.
    # Plain .db and .db.zst of the same stamp count once.
    while IFS= read -r base; do
      [ -n "$base" ] || continue
      [ -n "${seen[$base]:-}" ] && continue
      seen["$base"]=1
      dump_is_complete "$base" || continue
      n=$((n + 1))
      if [ "$n" -gt "$KEEP_COUNT" ]; then
        echo "[fleet-backup] prune-count $base at $(fleet_ct_label)"
        rm_dump_set "$base"
      fi
    done < <(list_dump_bases_newest_first "$dir")
  done
}

# Compress complete plain dumps in place.  Never compresses or deletes an
# incomplete dump.  A hash mismatch keeps the plain file and drops the .zst.
FLEET_BACKUP_LOCAL_COMPRESS="${FLEET_BACKUP_LOCAL_COMPRESS:-1}"
compress_one_complete_dump() {
  local db="$1" base lvl zst partial want got root_real db_resolved zst_resolved
  [ "${FLEET_BACKUP_LOCAL_COMPRESS:-1}" = "1" ] || return 0
  if [ -e "$db" ] || [ -L "$db" ]; then
    db="$(resolve_fs_path "$db")"
  fi
  base="$(dump_base_db "$db")"
  case "$base" in
    *.db) ;;
    *) return 0 ;;
  esac
  dump_is_complete "$base" || return 0
  [ -f "$base" ] && [ -s "$base" ] || return 0
  [ ! -e "${base}-journal" ] || return 0
  root_real="$(resolve_backup_root)" || return 0
  if ! path_under_root "$root_real" "$base"; then
    echo "[fleet-backup] SKIP compress outside backup root: $base" >&2
    return 0
  fi
  if ! command -v zstd >/dev/null 2>&1; then
    echo "[fleet-backup] WARN zstd missing; leaving plain $(basename "$base")"
    return 0
  fi
  want="$(awk 'NR==1 { print $1; exit }' "${base}.sha256")"
  got="$(sha256sum "$base" | awk '{print $1}')"
  if [ -z "$want" ] || [ "$got" != "$want" ]; then
    echo "[fleet-backup] WARN $(basename "$base") sha256 mismatch; not compressing"
    return 0
  fi
  lvl="${FLEET_BACKUP_ZSTD_LEVEL:-3}"
  case "$lvl" in ''|*[!0-9]*) lvl=3 ;; esac
  zst="${base}.zst"
  partial="${base}.zst.partial"
  rm -f "$partial"
  if [ ! -s "$zst" ]; then
    if ! nice -n 10 zstd -q -T2 -"$lvl" "$base" -o "$partial"; then
      rm -f "$partial"
      echo "[fleet-backup] WARN zstd failed for $(basename "$base"); keeping plain dump"
      return 0
    fi
    if ! zstd -q -t "$partial"; then
      rm -f "$partial"
      echo "[fleet-backup] WARN zstd test failed for $(basename "$base"); keeping plain dump"
      return 0
    fi
    mv -f "$partial" "$zst"
  elif ! zstd -q -t "$zst"; then
    rm -f "$zst"
    echo "[fleet-backup] WARN existing zst failed test for $(basename "$base"); keeping plain dump"
    return 0
  fi
  # Re-check immediately before unlinking the plain dump.
  dump_is_complete "$base" || { rm -f "$zst"; return 0; }
  [ ! -e "${base}-journal" ] || { rm -f "$zst"; return 0; }
  if ! got="$(zstd -q -d -c "$zst" | sha256sum | awk '{print $1}')"; then
    rm -f "$zst"
    echo "[fleet-backup] WARN decompress failed for $(basename "$base"); keeping plain dump"
    return 0
  fi
  if [ "$got" != "$want" ]; then
    echo "[fleet-backup] WARN compressed $(basename "$base") != sha256; keeping plain dump"
    rm -f "$zst"
    return 0
  fi
  dump_is_complete "$base" || { rm -f "$zst"; return 0; }
  db_resolved="$(resolve_fs_path "$base")"
  zst_resolved="$(resolve_fs_path "$zst")"
  path_under_root "$root_real" "$db_resolved" || return 0
  path_under_root "$root_real" "$zst_resolved" || { rm -f "$zst"; return 0; }
  rm -f "$db_resolved"
  echo "[fleet-backup] local zstd $(basename "$base") -> $(basename "$zst_resolved") ($(du -h "$zst_resolved" | awk '{print $1}')) at $(fleet_ct_label)"
}

compress_complete_local_dumps() {
  local root_real app dir f
  [ "${FLEET_BACKUP_LOCAL_COMPRESS:-1}" = "1" ] || return 0
  root_real="$(resolve_backup_root)" || return 0
  if [ "${#BACKUP_APP_LIST[@]}" -eq 0 ]; then
    backup_apps_selected || return 0
  fi
  for app in "${BACKUP_APP_LIST[@]}"; do
    dir="$root_real/$app"
    [ -d "$dir" ] || continue
    for f in "$dir"/*.db; do
      [ -f "$f" ] || continue
      compress_one_complete_dump "$f"
    done
  done
}

apply_local_retention() {
  # Tests / callers may set ROOT without going through main; ensure app list.
  if [ "${#BACKUP_APP_LIST[@]}" -eq 0 ]; then
    backup_apps_selected || return 0
  fi
  prune_incomplete_dumps
  prune_by_age
  prune_by_keep_count
  compress_complete_local_dumps
}

# B2-side prune (defined above the LIB_ONLY return so the offline test can
# source it; CLAUDE 2026-08-31; retention rewrite Jay 2026-10-05; defaults
# 3+2 Jay 2026-10-29 to match the fleet "3 days short-term, at most 2 weeks"
# privacy copy): keep ~3 daily + ~2 weekly dump sets under hetzner/ and delete older dump
# sets.  NEVER touches Litestream prefixes (trading-live/, congress-trade/,
# api-usage-monitor/) or qdrant/ under hetzner/.  A set = the .db/.sqlite
# files + .sha256 sidecars sharing one YYYYMMDDTHHMMSSZ stamp.
# Deletes go through rclone delete --include against the native [b2] remote
# (Class A, free).  Best-effort: a prune failure must never fail the backup
# run (callers append "|| true").
#
# Env:
#   B2_KEEP_DAILY   newest N UTC days to keep one dump set from (newest set of
#                   each day; default 3)
#   B2_KEEP_WEEKLY  additional Sunday-UTC dump sets to keep (default 2)
#   B2_KEEP_SETS    legacy total-newest fallback; if set, keep newest N only and
#                   ignore B2_KEEP_DAILY / B2_KEEP_WEEKLY (ST+CT cron sets 2)
#   B2_MAX_AGE_DAYS hard age cap (default 14, Jay 2026-10-30: "the 2 weeks
#                   counts from day 1").  Any dump set whose stamp is more than
#                   N days older than the current run's stamp is deleted no
#                   matter what the keep counts say, so the ~2-week weekly copy
#                   is never more than 14 days old.  Applies to every mode,
#                   including B2_KEEP_SETS.  Must be an integer >= 1; anything
#                   else falls back to 14 (the cap is never disabled).
# Weekly picks are one set per distinct Sunday (UTC) date, newest stamp of that
# day, skipping Sunday dates already covered by a daily.  With daily runs that lands the
# weekly copies at roughly 1-7 and 8-14 days old.
# Host env/cron values override these defaults; a default change here does
# nothing for a lane whose cron line sets its own values.
B2_KEEP_DAILY="${B2_KEEP_DAILY:-3}"
B2_KEEP_WEEKLY="${B2_KEEP_WEEKLY:-2}"
B2_KEEP_SETS="${B2_KEEP_SETS:-}"
B2_MAX_AGE_DAYS="${B2_MAX_AGE_DAYS:-14}"
# Epoch seconds for a YYYYMMDDTHHMMSSZ stamp; empty on parse failure.
b2_stamp_epoch() {
  local st="$1"
  date -u -d "${st:0:4}-${st:4:2}-${st:6:2} ${st:9:2}:${st:11:2}:${st:13:2}" +%s 2>/dev/null || true
}
# Log label (Jay 2026-10-30): UTC stamp plus Central wall time with offset,
# e.g. "20261030T113000Z (6:30am CDT, -05:00)".  Log lines only; file and
# object names stay plain UTC ...Z stamps.  $1 = stamp (default: now).
fleet_ct_label() {
  local st="${1:-}" epoch
  if [ -z "$st" ]; then
    st="$(date -u +%Y%m%dT%H%M%SZ)"
  fi
  epoch="$(b2_stamp_epoch "$st")"
  if [ -z "$epoch" ]; then
    printf '%s' "$st"
    return 0
  fi
  printf '%s (%s)' "$st" "$(TZ=America/Chicago date -d "@${epoch}" '+%-I:%M%P %Z, %:z' 2>/dev/null || echo 'Central n/a')"
}
prune_b2_sets() {
  local app="$1" bucket="$2" current_stamp="$3"
  local listing stamps_all stamp name kept_count deleted_count set_fail
  local keep_daily="$B2_KEEP_DAILY" keep_weekly="$B2_KEEP_WEEKLY"
  local dow weekly_kept stamp_day max_age_days now_epoch stamp_epoch max_age_secs
  local -A WEEKLY_DAYS=() DAILY_DAYS=()
  local daily_kept
  # Only ever touch the hetzner/ prefix of the three known fleet buckets.
  case "$bucket" in
    jays-congress-trade-eu|jays-socratic-trade-eu|jays-usage-monitor-eu) ;;
    *) echo "[fleet-backup] B2 prune SKIP: unexpected bucket $bucket for $app"; return 0 ;;
  esac
  if [ -n "$B2_KEEP_SETS" ]; then
    case "$B2_KEEP_SETS" in
      ''|*[!0-9]*) echo "[fleet-backup] B2 prune SKIP: non-numeric B2_KEEP_SETS=$B2_KEEP_SETS"; return 0 ;;
    esac
    if [ "$B2_KEEP_SETS" -lt 1 ]; then
      echo "[fleet-backup] B2 prune SKIP: B2_KEEP_SETS must be >= 1 (got $B2_KEEP_SETS)"
      return 0
    fi
  fi
  case "$keep_daily" in
    ''|*[!0-9]*) echo "[fleet-backup] B2 prune SKIP: non-numeric B2_KEEP_DAILY=$keep_daily"; return 0 ;;
  esac
  case "$keep_weekly" in
    ''|*[!0-9]*) echo "[fleet-backup] B2 prune SKIP: non-numeric B2_KEEP_WEEKLY=$keep_weekly"; return 0 ;;
  esac
  if [ "$keep_daily" -lt 1 ]; then
    echo "[fleet-backup] B2 prune SKIP: B2_KEEP_DAILY must be >= 1 (got $keep_daily)"
    return 0
  fi
  max_age_days="$B2_MAX_AGE_DAYS"
  case "$max_age_days" in
    ''|*[!0-9]*) echo "[fleet-backup] B2 prune WARN: non-numeric B2_MAX_AGE_DAYS=$max_age_days; using 14"; max_age_days=14 ;;
  esac
  if [ "$max_age_days" -lt 1 ]; then
    echo "[fleet-backup] B2 prune WARN: B2_MAX_AGE_DAYS must be >= 1 (got $max_age_days); using 14"
    max_age_days=14
  fi
  max_age_days=$((10#$max_age_days))
  max_age_secs=$((max_age_days * 86400))
  # Age is measured from the current run's stamp (the set just uploaded), so
  # tests are deterministic and a slow run cannot shift the cutoff.
  now_epoch="$(b2_stamp_epoch "$current_stamp")"
  [ -n "$now_epoch" ] || now_epoch="$(date -u +%s)"
  if ! listing="$(rclone lsf "b2:${bucket}/hetzner/" --files-only 2>/dev/null)"; then
    echo "[fleet-backup] B2 prune SKIP: listing failed for $app"
    return 0
  fi
  if [ -z "$listing" ]; then
    echo "[fleet-backup] B2 prune SKIP: empty listing for $app"
    return 0
  fi
  while read -r name; do
    [ -n "$name" ] || continue
    case "$name" in
      *.snapshot|*.snapshot.sha256) continue ;;
    esac
    if ! printf '%s\n' "$name" | grep -qE '[0-9]{8}T[0-9]{6}Z'; then
      echo "[fleet-backup] B2 prune WARN: unparseable name skipped: $name"
    fi
  done <<< "$listing"
  # Newest-first distinct stamps from dump-like names only (plain .db/.sqlite
  # sets from before 2026-10-30 and .db.zst/.sqlite.zst sets after).
  stamps_all="$(printf '%s\n' "$listing" \
    | grep -E '\.(db|sqlite)(\.zst)?(\.sha256)?$' \
    | grep -oE '[0-9]{8}T[0-9]{6}Z' \
    | sort -u -r)"
  if [ -z "$stamps_all" ]; then
    echo "[fleet-backup] B2 prune SKIP: no parseable snapshot sets for $app"
    return 0
  fi

  declare -A KEEP_STAMPS=()
  kept_count=0
  if [ -n "$B2_KEEP_SETS" ]; then
    while read -r stamp; do
      [ -n "$stamp" ] || continue
      KEEP_STAMPS["$stamp"]=1
      kept_count=$((kept_count + 1))
      [ "$kept_count" -ge "$B2_KEEP_SETS" ] && break
    done <<< "$stamps_all"
  else
    # Dailies: the newest set of each of the newest N distinct UTC dates, so a
    # lane that dumps twice a day still keeps ~N days, not N/2.
    daily_kept=0
    while read -r stamp; do
      [ -n "$stamp" ] || continue
      stamp_day="${stamp:0:8}"
      [ -n "${DAILY_DAYS[$stamp_day]:-}" ] && continue
      DAILY_DAYS["$stamp_day"]=1
      KEEP_STAMPS["$stamp"]=1
      # A Sunday already covered by a daily does not need a weekly too.
      WEEKLY_DAYS["$stamp_day"]=1
      kept_count=$((kept_count + 1))
      daily_kept=$((daily_kept + 1))
      [ "$daily_kept" -ge "$keep_daily" ] && break
    done <<< "$stamps_all"
    weekly_kept=0
    while read -r stamp; do
      [ -n "$stamp" ] || continue
      [ -n "${KEEP_STAMPS[$stamp]:-}" ] && continue
      dow="$(date -u -d "${stamp:0:4}-${stamp:4:2}-${stamp:6:2}" +%u 2>/dev/null || true)"
      [ "$dow" = "7" ] || continue
      # One weekly per Sunday date: 6-hourly lanes would otherwise spend both
      # weekly slots on the same Sunday.
      stamp_day="${stamp:0:8}"
      [ -n "${WEEKLY_DAYS[$stamp_day]:-}" ] && continue
      WEEKLY_DAYS["$stamp_day"]=1
      KEEP_STAMPS["$stamp"]=1
      weekly_kept=$((weekly_kept + 1))
      kept_count=$((kept_count + 1))
      [ "$weekly_kept" -ge "$keep_weekly" ] && break
    done <<< "$stamps_all"
  fi

  # Hard age cap: drop any kept set older than max_age_days (never the
  # current set; the delete loop below also refuses that).
  while read -r stamp; do
    [ -n "$stamp" ] || continue
    [ -n "${KEEP_STAMPS[$stamp]:-}" ] || continue
    [ "$stamp" = "$current_stamp" ] && continue
    stamp_epoch="$(b2_stamp_epoch "$stamp")"
    [ -n "$stamp_epoch" ] || continue
    if [ $((now_epoch - stamp_epoch)) -gt "$max_age_secs" ]; then
      unset "KEEP_STAMPS[$stamp]"
      kept_count=$((kept_count - 1))
      echo "[fleet-backup] B2 prune age-cap: $(fleet_ct_label "$stamp") older than ${max_age_days}d for $app"
    fi
  done <<< "$stamps_all"

  deleted_count=0
  while read -r stamp; do
    [ -n "$stamp" ] || continue
    [ -n "${KEEP_STAMPS[$stamp]:-}" ] && continue
    if [ "$stamp" = "$current_stamp" ]; then
      echo "[fleet-backup] B2 prune SKIP: refusing to delete current set $stamp for $app"
      continue
    fi
    set_fail=0
    while read -r name; do
      [ -n "$name" ] || continue
      rclone delete "b2:${bucket}/hetzner/" --include "/${name}" 2>/dev/null || true
      if rclone lsf "b2:${bucket}/hetzner/" --files-only 2>/dev/null | grep -qxF "$name"; then
        echo "[fleet-backup] B2 prune WARN: delete failed: $name"
        set_fail=1
      fi
    done <<< "$(printf '%s\n' "$listing" | grep -F "$stamp" || true)"
    if [ "$set_fail" = "0" ]; then
      deleted_count=$((deleted_count + 1))
    fi
  done <<< "$stamps_all"
  echo "[fleet-backup] B2 prune OK: $app kept=${kept_count} deleted=${deleted_count} (daily=${keep_daily} weekly=${keep_weekly} max_age_days=${max_age_days}) at $(fleet_ct_label)"
  return 0
}

# Optional Central-time gate (Jay 2026-10-30).  Originally each cron line fired
# at both UTC candidates (CDT and CST) and this gate let only the matching
# America/Chicago hour through.  The host now runs on America/Chicago, so the
# shipped cron leaves it unset; kept for UTC hosts and manual use.  FLEET_BACKUP_CT_HOURS is a comma list of 2-digit hours, e.g.
# "06,19".  Unset = no gate (manual runs).  If the zoneinfo file is missing
# the gate fails OPEN (runs) so a tzdata problem cannot silently stop backups.
FLEET_BACKUP_CT_HOURS="${FLEET_BACKUP_CT_HOURS:-}"
fleet_backup_ct_gate() {
  local hour="${1:-}"
  [ -n "$FLEET_BACKUP_CT_HOURS" ] || return 0
  if [ -z "$hour" ]; then
    if [ ! -e /usr/share/zoneinfo/America/Chicago ]; then
      echo "[fleet-backup] WARN: no America/Chicago zoneinfo; CT gate open" >&2
      return 0
    fi
    hour="$(TZ=America/Chicago date +%H)"
  fi
  case ",${FLEET_BACKUP_CT_HOURS// /}," in
    *",${hour},"*) return 0 ;;
  esac
  return 1
}

# zstd the current run's dumps for the B2 upload (Jay 2026-10-30).  Writes
# <file>.zst next to each <file> (via .zst.partial + zstd -t, so a torn file
# never gets the final name).  Returns 0 only if every file compressed and
# tested clean; on any failure it removes its .zst output and returns 1 so the
# caller uploads the raw set instead.  nice + 2 threads: the box also runs ST.
FLEET_BACKUP_B2_COMPRESS="${FLEET_BACKUP_B2_COMPRESS:-1}"
FLEET_BACKUP_ZSTD_LEVEL="${FLEET_BACKUP_ZSTD_LEVEL:-3}"
compress_offsite_set() {
  local dir="$1" stamp="$2" f lvl made=()
  [ "$FLEET_BACKUP_B2_COMPRESS" = "1" ] || return 1
  if ! command -v zstd >/dev/null 2>&1; then
    echo "[fleet-backup] WARN zstd missing; uploading raw dumps"
    return 1
  fi
  lvl="$FLEET_BACKUP_ZSTD_LEVEL"
  case "$lvl" in ''|*[!0-9]*) lvl=3 ;; esac
  for f in "$dir"/*"${stamp}".db "$dir"/*"${stamp}".sqlite; do
    [ -f "$f" ] || continue
    rm -f "${f}.zst" "${f}.zst.partial"
    if nice -n 10 zstd -q -T2 -"$lvl" "$f" -o "${f}.zst.partial" \
      && nice -n 10 zstd -q -t "${f}.zst.partial" \
      && mv -f "${f}.zst.partial" "${f}.zst"; then
      made+=("${f}.zst")
      echo "[fleet-backup] zstd $(basename "$f") $(du -h "$f" | awk '{print $1}') -> $(du -h "${f}.zst" | awk '{print $1}') at $(fleet_ct_label)"
    else
      echo "[fleet-backup] WARN zstd failed for $(basename "$f"); uploading raw dumps"
      rm -f "${f}.zst.partial" "${made[@]}"
      return 1
    fi
  done
  [ "${#made[@]}" -gt 0 ] || return 1
  return 0
}

# Upload this run's set to b2:<bucket>/hetzner/.  Compressed: only .zst files
# plus the raw-db .sha256 sidecars.  Raw fallback: the whole set as before.
# A local .db.zst that is already the retained dump is uploaded and kept.
# A .zst produced only for this upload is removed after success when the plain
# .db is still the local copy (FLEET_BACKUP_LOCAL_COMPRESS=0).
upload_b2_set() {
  local dir="$1" bucket="$2" stamp="$3" rc=0 raw=0 have_zst=0 f
  for f in "$dir"/*"${stamp}".db; do
    [ -f "$f" ] && raw=1 && break
  done
  for f in "$dir"/*"${stamp}".db.zst; do
    [ -f "$f" ] && have_zst=1 && break
  done
  if [ "$have_zst" = 1 ] && [ "$raw" = 0 ]; then
    rclone copy "$dir" "b2:${bucket}/hetzner/" --include "*${stamp}*.zst" --include "*${stamp}*.sha256" --transfers 2 -q || rc=$?
    return "$rc"
  fi
  if compress_offsite_set "$dir" "$stamp"; then
    rclone copy "$dir" "b2:${bucket}/hetzner/" --include "*${stamp}*.zst" --include "*${stamp}*.sha256" --transfers 2 -q || rc=$?
    # Keep the verified .zst after a failed upload for a manual retry; the next
    # run's prune removes a .zst that has no sha256.  On success the plain .db
    # is still the local copy, so the upload-only .zst goes away.
    if [ "$rc" -eq 0 ]; then
      local zf zr root_real
      root_real="$(resolve_backup_root || true)"
      for zf in "$dir"/*"${stamp}"*.zst "$dir"/*"${stamp}"*.zst.partial; do
        [ -e "$zf" ] || [ -L "$zf" ] || continue
        zr="$(resolve_fs_path "$zf")"
        if [ -n "$root_real" ] && path_under_root "$root_real" "$zr"; then
          rm -f "$zr"
        fi
      done
    fi
  else
    # compress_offsite_set already removed any partial .zst output.
    rclone copy "$dir" "b2:${bucket}/hetzner/" --include "*${stamp}*" --transfers 2 -q || rc=$?
  fi
  return "$rc"
}

if [ "${FLEET_BACKUP_LIB_ONLY:-0}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi

if ! fleet_backup_ct_gate; then
  # Off-slot UTC candidate (other side of DST): nothing to do.
  exit 0
fi

# Single-flight: same inode as the host cron wrapper
# (flock -n /var/lock/fleet-sqlite-backup.lock ...).  flock(2) grants a
# second lock to the same process, so the wrapper and this script compose.
if ! command -v flock >/dev/null 2>&1; then
  echo "[fleet-backup] FAIL flock not found (util-linux required for single-flight)" >&2
  exit 1
fi
mkdir -p "$(dirname "$LOCKFILE")" || {
  echo "[fleet-backup] FAIL cannot create lock dir $(dirname "$LOCKFILE")" >&2
  exit 1
}
exec 9>"$LOCKFILE" || {
  echo "[fleet-backup] FAIL cannot open lock $LOCKFILE" >&2
  exit 1
}
if ! flock -n 9; then
  echo "[fleet-backup] SKIP already running (lock held: $LOCKFILE)" >&2
  exit 0
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_FAILED=0
LOG="/var/log/fleet-backup/sqlite-${STAMP}.log"
# Pin the physical directory.  /data/backups is a symlink chain onto /backups.
if _root_real="$(resolve_backup_root)"; then
  ROOT="$_root_real"
fi
unset _root_real
mkdir -p "$ROOT" /var/log/fleet-backup
exec > >(tee -a "$LOG") 2>&1
echo "[fleet-backup] start $(fleet_ct_label "$STAMP") apps=$FLEET_BACKUP_APPS keep_days=$KEEP_DAYS keep_count=$KEEP_COUNT b2_sets=${B2_KEEP_SETS:-} b2_daily=${B2_KEEP_DAILY:-} b2_weekly=${B2_KEEP_WEEKLY:-} b2_max_age_days=${B2_MAX_AGE_DAYS:-} ct_hours=${FLEET_BACKUP_CT_HOURS:-}"

if ! backup_apps_selected; then
  exit 1
fi

if [ "$FLEET_BACKUP_DRY_RUN" = "1" ]; then
  echo "[fleet-backup] DRY-RUN: would dump/prune local dirs and B2 hetzner/ prefixes:"
  declare -A _B2_BUCKET=( [congress]="jays-congress-trade-eu" [socratic]="jays-socratic-trade-eu" [usage-monitor]="jays-usage-monitor-eu" )
  for app in "${BACKUP_APP_LIST[@]}"; do
    echo "  local: $(resolve_fs_path "$ROOT/$app")/"
    echo "  B2:    b2:${_B2_BUCKET[$app]}/hetzner/  (dump sets only; never Litestream / qdrant/)"
    if [ -d "$ROOT/$app" ]; then
      find "$(resolve_fs_path "$ROOT/$app")" -maxdepth 1 -type f \( -name '*.db' -o -name '*.db.zst' \) -printf '%T@\t%p\n' 2>/dev/null \
        | sort -nr | head -5 | while IFS=$'\t' read -r _ f; do
          [ -n "$f" ] || continue
          echo "    present: $(basename "$f") ($(du -h "$(resolve_fs_path "$f")" | awk '{print $1}'))"
        done || true
    fi
  done
  echo "[fleet-backup] DRY-RUN done (no VACUUM, upload, or delete)"
  exit 0
fi

# Socratic: Coolify docker volume
if app_enabled socratic; then
  SOCRATIC_VOL=$(docker volume ls -q | grep -E 'socratic.*prod-app-data|prod-app-data' | head -1 || true)
  if [ -n "$SOCRATIC_VOL" ] && [ -f "/var/lib/docker/volumes/${SOCRATIC_VOL}/_data/app.db" ]; then
    backup_one "socratic-app" "/var/lib/docker/volumes/${SOCRATIC_VOL}/_data/app.db" "$ROOT/socratic" || BACKUP_FAILED=1
  else
    # try live container path via docker cp
    C=$(docker ps --format '{{.Names}}' | grep -E 'socratic-app|socratic|d83b1aykr03uwr32yhgzaiay' | head -1 || true)
    if [ -n "$C" ]; then
      tmp="/tmp/socratic-app.db"
      docker cp "$C:/app/data/app.db" "$tmp"
      backup_one "socratic-app" "$tmp" "$ROOT/socratic" || BACKUP_FAILED=1
      rm -f "$tmp"
    else
      echo "[fleet-backup] SKIP socratic (no volume/container)"
    fi
  fi
else
  echo "[fleet-backup] SKIP socratic (not in FLEET_BACKUP_APPS)"
fi

if app_enabled congress; then
  backup_one "congress-trade" "/data/congress-trade/db.sqlite" "$ROOT/congress" || BACKUP_FAILED=1
  # Deno KV is not pure sqlite recovery the same way; still copy for best-effort
  if [ -f /data/congress-trade/kv.sqlite ]; then
    mkdir -p "$ROOT/congress"
    cp -a /data/congress-trade/kv.sqlite "$ROOT/congress/kv-${STAMP}.sqlite" || true
    echo "[fleet-backup] copied congress kv"
  fi
else
  echo "[fleet-backup] SKIP congress (not in FLEET_BACKUP_APPS)"
fi

if app_enabled usage-monitor; then
  backup_one "usage-monitor" "/data/prod.db" "$ROOT/usage-monitor" || BACKUP_FAILED=1
  # Coolify also mounts UM volume - find it
  UM_VOL=$(docker volume ls -q | grep -E 'usage-data|usage-monitor' | head -1 || true)
  if [ -n "$UM_VOL" ] && [ -f "/var/lib/docker/volumes/${UM_VOL}/_data/prod.db" ]; then
    backup_one "usage-monitor-vol" "/var/lib/docker/volumes/${UM_VOL}/_data/prod.db" "$ROOT/usage-monitor" || BACKUP_FAILED=1
  fi
else
  echo "[fleet-backup] SKIP usage-monitor (not in FLEET_BACKUP_APPS)"
fi

# retention: drop incomplete dumps first, then age-based (FLEET_BACKUP_KEEP_DAYS,
# default 2d) AND keep-count (FLEET_BACKUP_KEEP_COUNT, default 2 newest COMPLETE
# dumps per app dir, plain .db or .db.zst).  Then compress surviving plain dumps.
apply_local_retention
echo "[fleet-backup] done $(fleet_ct_label "$STAMP") finished $(fleet_ct_label)"
df -h /data / | tail -5

# ---- Off-host replication (MONET 2026-08-09) --------------------------------
# B2 = primary offsite (every run, scoped key in /root/.config/rclone).
# R2 = weekly cold copy (Sundays), ONLY if an [r2] rclone remote is configured
#      -- one copy/week keeps R2 definitively inside its free tier.
declare -A B2_BUCKET=( [congress]="jays-congress-trade-eu" [socratic]="jays-socratic-trade-eu" [usage-monitor]="jays-usage-monitor-eu" )
# R2 destination bucket is a DIFFERENT namespace than B2 -- only apps present in
# this map have a real R2 bucket provisioned. Do not reuse B2_BUCKET names here
# (fixed 2026-08-12: previous code pushed to "r2:<b2-bucket-name>/weekly/", a
# bucket name that only exists on B2, so the R2 weekly leg silently failed).
declare -A R2_BUCKET=( [congress]="congress-trade-bucket" )

# R2 weekly receipt guard (CLAUDE 2026-08-31): the Sunday leg is gated only by
# day-of-week, so it re-ran on all four Sunday cron ticks.  Success when the
# receipt exists, says ok:true, and completedAt is today's UTC date; anything
# missing/stale/failed keeps the retry behavior.
r2_receipt_ok_today() {
  local receipt="$1" today
  [ -f "$receipt" ] || return 1
  grep -q '"ok":true' "$receipt" || return 1
  today="$(date -u +%Y-%m-%d)"
  grep -q "\"completedAt\":\"${today}T" "$receipt" || return 1
  return 0
}

for app in congress socratic usage-monitor; do
  app_enabled "$app" || continue
  dir="$ROOT/$app"; [ -d "$dir" ] || continue
  files=$(ls -1 "$dir" 2>/dev/null | grep "$STAMP" || true)
  [ -n "$files" ] || continue
  if upload_b2_set "$dir" "${B2_BUCKET[$app]}" "$STAMP"; then
    echo "[fleet-backup] B2 offsite OK: $app set=$(fleet_ct_label "$STAMP") at $(fleet_ct_label)"
    prune_b2_sets "$app" "${B2_BUCKET[$app]}" "$STAMP" || true
  else
    echo "[fleet-backup] B2 offsite FAIL: $app set=$(fleet_ct_label "$STAMP") at $(fleet_ct_label)"
    fleet_backup_alert "B2 offsite FAIL: $app"
    BACKUP_FAILED=1
  fi
  # Weekly R2 leg: Sundays, or FLEET_BACKUP_FORCE_WEEKLY=1 for manual/out-of-cycle proof runs.
  if [ "$(date -u +%u)" = "7" ] || [ "${FLEET_BACKUP_FORCE_WEEKLY:-0}" = "1" ]; then
    r2bucket="${R2_BUCKET[$app]:-}"
    if [ -z "$r2bucket" ]; then
      echo "[fleet-backup] R2 weekly skipped: no R2 bucket mapped for $app"
    elif [ "$app" = "congress" ] && [ "${FLEET_BACKUP_FORCE_WEEKLY:-0}" != "1" ] \
      && r2_receipt_ok_today "/data/congress-trade/.r2-archive-status.json"; then
      # Receipt guard: skip the later Sunday cron ticks after one success.
      echo "[fleet-backup] R2 weekly SKIP: already succeeded today"
    elif rclone listremotes 2>/dev/null | grep -q "^r2:"; then
      if rclone copy "$dir" "r2:${r2bucket}/weekly/" --include "*${STAMP}*" --transfers 2 -q; then
        echo "[fleet-backup] R2 weekly OK: $app set=$(fleet_ct_label "$STAMP") at $(fleet_ct_label)"
        # Receipt so congress.trade /api/health can say R2 weekly is fine
        # without listing the bucket (no secrets on the health path).
        if [ "$app" = "congress" ]; then
          status_path="/data/congress-trade/.r2-archive-status.json"
          newest=""
          for candidate in "$dir"/*"${STAMP}".db.zst "$dir"/*"${STAMP}".db; do
            [ -f "$candidate" ] || continue
            newest="$candidate"
            break
          done
          key="weekly/$(basename "${newest:-congress-trade-${STAMP}.db.zst}")"
          printf '{"ok":true,"key":"%s","completedAt":"%s"}\n' "$key" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$status_path"
          # R2 is weekly-archive-only.  One CT db is ~1.9 GB; extra copies
          # trip the 10 GB free tier.  Keep the newest weekly set only.
          # Stamp strip accepts both congress-trade-<STAMP>.db.zst and .db.
          keep="$(basename "${newest:-}")"
          stamp_keep="${keep#congress-trade-}"
          stamp_keep="${stamp_keep%.db.zst}"
          stamp_keep="${stamp_keep%.db}"
          rclone lsf "r2:${r2bucket}/weekly/" 2>/dev/null | while read -r name; do
            [ -n "$name" ] || continue
            case "$name" in
              *"${stamp_keep}"*) ;;
              *) rclone deletefile "r2:${r2bucket}/weekly/${name}" && echo "[fleet-backup] R2 weekly pruned: $name at $(fleet_ct_label)" || true ;;
            esac
          done
        fi
      else
        echo "[fleet-backup] R2 weekly FAIL: $app set=$(fleet_ct_label "$STAMP") at $(fleet_ct_label)"
        fleet_backup_alert "R2 weekly FAIL: $app"
        if [ "$app" = "congress" ]; then
          printf '{"ok":false,"reason":"rclone_failed","checkedAt":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
            > /data/congress-trade/.r2-archive-status.json || true
        fi
      fi
    else
      echo "[fleet-backup] R2 weekly skipped: no r2 remote configured yet"
    fi
  fi
done

if [ "${BACKUP_FAILED:-0}" != "0" ]; then
  echo "[fleet-backup] FAIL one or more dumps or offsite copies failed" >&2
  printf '{"ok":false,"reason":"dump_or_offsite_failed","checkedAt":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    > /data/congress-trade/.r2-archive-status.json || true
  exit 1
fi
