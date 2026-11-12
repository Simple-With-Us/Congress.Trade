#!/usr/bin/env bash
# sqlite-maintenance.sh — size / freelist report and a safe WAL checkpoint.
#
# Default action is a human report plus PRAGMA wal_checkpoint(PASSIVE).
# RESTART and TRUNCATE run only with an explicit --checkpoint flag, and that
# invocation sets PRAGMA busy_timeout first.  VACUUM runs only with --vacuum,
# and only after every guard below passes.  DRY_RUN=1 or --dry-run reports
# and evaluates those guards, then skips checkpoint and VACUUM.
#
# Plain VACUUM, not VACUUM INTO plus a rename.  congress-app and Litestream
# keep the live file open.  rename(2) changes the directory entry only, so
# those processes would keep writing the old inode while the path points at
# the new file.  Plain VACUUM rewrites the same database under an exclusive
# lock (SQLite copies the live pages to a temporary file, then replaces the
# original).  Expect that lock to last on the order of minutes for a
# multi-gigabyte database, and longer while the root disk is busy.  Writers
# block until it finishes.  PASSIVE does not take that lock and does not
# shrink the main file.
#
# VACUUM guards, all required, fail closed:
#   - free space on the database filesystem >= 2.5x the main file size
#   - backup marker fresh within SQLITE_BACKUP_MAX_AGE_HOURS (default 36)
#   - Coolify deploy not in progress (docker name probe; unknown refuses)
#   - PRAGMA integrity_check is ok
#   - this process holds the lock (two runs never overlap)
#
# The marker is a file.  The first line is a unix epoch, verified_epoch=<epoch>,
# or a GNU date stamp.  A line that is exactly ok=0, status=fail, or fail
# refuses the run.  A missing marker refuses the run.  fleet-backup-verify
# does not write this file; an operator has to, after a verified backup.
#
# Deploy probe matches the docker checks already used on this host: container
# names nixpacks / coolify-builder / buildkit, and a congress-app container
# whose status is Created, Restarting, or health: starting.  This script does
# not read Coolify tokens.  If docker cannot be asked, VACUUM is refused.
# SQLITE_MAINT_DEPLOY_STATE and SQLITE_MAINT_FREE_BYTES are ignored unless
# the matching SQLITE_MAINT_ALLOW_*_OVERRIDE=1 is set (tests only).
#
# Exit codes (highest severity wins when several databases are listed):
#   0  report finished.  PASSIVE may report busy=1; that is still exit 0.
#   1  usage error, missing database, or sqlite/report/checkpoint error
#   2  another run holds the lock
#   3  --vacuum refused by a guard (including a failing dry-run guard check)
#   4  explicit RESTART or TRUNCATE returned busy!=0
#   5  VACUUM or the post-VACUUM integrity check failed
#
# This script never deletes a database, its -wal, or its -shm.  The only file
# it removes is a temporary JSON scratch file under mktemp.
#
# Host install is not part of this script.  Sample units live in
# scripts/ops/systemd.noindex/ and are report + PASSIVE only.
#
#   SQLITE_DBS=/data/congress-trade/db.sqlite \
#     bash scripts/ops/sqlite-maintenance.sh
#   bash scripts/ops/sqlite-maintenance.sh --db /path/to/a.sqlite --json
#   bash scripts/ops/sqlite-maintenance.sh --db /path/to/a.sqlite --vacuum \
#     --backup-marker /var/lib/sqlite-maintenance/backup-verified

set -euo pipefail

# Captured before the shell variables below reuse the same names.
ENV_DRY_RUN="${DRY_RUN:-0}"

DRY_RUN=0
WANT_JSON=0
WANT_VACUUM=0
CHECKPOINT_MODE="PASSIVE"
BUSY_MS=60000
MAX_AGE_HOURS=36
MARKER=""
LOCK_FILE="/var/lock/sqlite-maintenance.lock"
CHECKPOINT_TIMEOUT="${SQLITE_CHECKPOINT_TIMEOUT:-120s}"
VACUUM_TIMEOUT="${SQLITE_VACUUM_TIMEOUT:-30m}"
DBS=()
WORST=0
NDJSON=""

usage() {
  cat <<'EOF'
usage: sqlite-maintenance.sh [--db PATH]... [--json] [--dry-run] [--vacuum]
       [--checkpoint passive|restart|truncate|none]
       [--busy-timeout-ms N] [--backup-marker PATH]
       [--backup-max-age-hours N] [--lock-file PATH]

Reports file size, WAL size, SHM size, page_size, page_count, freelist_count,
and reclaimable bytes (freelist_count * page_size).  Default checkpoint is
PRAGMA wal_checkpoint(PASSIVE).  --checkpoint=restart and truncate set
PRAGMA busy_timeout first.  --vacuum is plain VACUUM and is fail-closed.
--json prints one JSON document on stdout and the human report on stderr.
--dry-run (or DRY_RUN=1) does not checkpoint or VACUUM.

Exit 0 report ok, 1 error, 2 lock busy, 3 vacuum refused, 4 restart/truncate
busy, 5 vacuum failed.  Never deletes database files.

SQLITE_DBS is a colon-separated path list.  Repeated --db flags append.
EOF
}

die() {
  local code="$1"
  shift
  printf 'sqlite-maintenance: error %s\n' "$*" >&2
  exit "$code"
}

say() {
  if [[ "$WANT_JSON" == "1" ]]; then
    printf '%s\n' "$*" >&2
  else
    printf '%s\n' "$*"
  fi
}

is_uint() {
  [[ "${1:-}" =~ ^[0-9]+$ ]]
}

# wal_checkpoint returns -1 for log and checkpointed when the file is not WAL.
is_checkpoint_int() {
  [[ "${1:-}" =~ ^-?[0-9]+$ ]]
}

raise_code() {
  local code="$1"
  local current next
  severity() {
    case "$1" in
      0) printf '0' ;;
      3) printf '10' ;;
      2) printf '20' ;;
      4) printf '30' ;;
      1) printf '40' ;;
      5) printf '50' ;;
      *) printf '40' ;;
    esac
  }
  current=$(severity "$WORST")
  next=$(severity "$code")
  if (( next > current )); then
    WORST=$code
  fi
}

file_size() {
  local path="$1"
  if [[ -f "$path" ]]; then
    stat -c%s -- "$path"
  else
    printf '0'
  fi
}

cleanup() {
  if [[ -n "$NDJSON" && -f "$NDJSON" ]]; then
    rm -f -- "$NDJSON"
  fi
}
trap cleanup EXIT

append_row() {
  local db="$1" error="$2" file_bytes="$3" wal_bytes="$4" shm_bytes="$5"
  local page_size="$6" page_count="$7" freelist="$8" reclaim="$9"
  local ck_skipped="${10}" ck_busy="${11}" ck_log="${12}" ck_ckpt="${13}"
  local vac_reason="${14}" vac_ran="${15}" post_free="${16}" post_reclaim="${17}"
  if [[ "$WANT_JSON" != "1" ]]; then
    return 0
  fi
  python3 - "$NDJSON" "$db" "$error" "$file_bytes" "$wal_bytes" "$shm_bytes" \
    "$page_size" "$page_count" "$freelist" "$reclaim" "$CHECKPOINT_MODE" \
    "$ck_skipped" "$ck_busy" "$ck_log" "$ck_ckpt" \
    "$WANT_VACUUM" "$vac_ran" "$vac_reason" "$post_free" "$post_reclaim" <<'PY'
import json
import sys

(
    ndjson,
    path,
    error,
    file_bytes,
    wal_bytes,
    shm_bytes,
    page_size,
    page_count,
    freelist,
    reclaim,
    mode,
    ck_skipped,
    ck_busy,
    ck_log,
    ck_ckpt,
    vacuum_requested,
    vacuum_ran,
    vacuum_reason,
    post_free,
    post_reclaim,
) = sys.argv[1:21]


def num(value):
    if value == "":
        return None
    return int(value)


row = {
    "path": path,
    "error": error or None,
    "file_bytes": num(file_bytes),
    "wal_bytes": num(wal_bytes),
    "shm_bytes": num(shm_bytes),
    "page_size": num(page_size),
    "page_count": num(page_count),
    "freelist_count": num(freelist),
    "reclaimable_bytes": num(reclaim),
    "checkpoint": {
        "mode": mode,
        "skipped": ck_skipped or None,
        "busy": num(ck_busy),
        "log": num(ck_log),
        "checkpointed": num(ck_ckpt),
    },
    "vacuum": {
        "requested": vacuum_requested == "1",
        "ran": vacuum_ran == "1",
        "reason": vacuum_reason or None,
        "post_freelist_count": num(post_free),
        "post_reclaimable_bytes": num(post_reclaim),
    },
}
with open(ndjson, "a", encoding="utf-8") as handle:
    handle.write(json.dumps(row, sort_keys=True) + "\n")
PY
}

load_env_defaults() {
  if [[ "$ENV_DRY_RUN" == "1" ]]; then
    DRY_RUN=1
  else
    DRY_RUN=0
  fi
  if [[ "${SQLITE_VACUUM:-0}" == "1" ]]; then
    WANT_VACUUM=1
  fi
  if [[ "${SQLITE_JSON:-0}" == "1" ]]; then
    WANT_JSON=1
  fi
  CHECKPOINT_MODE="${SQLITE_CHECKPOINT:-passive}"
  BUSY_MS="${SQLITE_BUSY_TIMEOUT_MS:-60000}"
  MAX_AGE_HOURS="${SQLITE_BACKUP_MAX_AGE_HOURS:-36}"
  MARKER="${SQLITE_BACKUP_MARKER:-}"
  LOCK_FILE="${SQLITE_LOCK_FILE:-/var/lock/sqlite-maintenance.lock}"
  if [[ -n "${SQLITE_DBS:-}" ]]; then
    IFS=':' read -r -a DBS <<<"${SQLITE_DBS}"
  fi
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --help|-h)
        usage
        exit 0
        ;;
      --db)
        [[ $# -ge 2 ]] || die 1 "--db needs a path"
        DBS+=("$2")
        shift 2
        ;;
      --json)
        WANT_JSON=1
        shift
        ;;
      --dry-run)
        DRY_RUN=1
        shift
        ;;
      --vacuum)
        WANT_VACUUM=1
        shift
        ;;
      --checkpoint)
        [[ $# -ge 2 ]] || die 1 "--checkpoint needs a mode"
        CHECKPOINT_MODE="$2"
        shift 2
        ;;
      --busy-timeout-ms)
        [[ $# -ge 2 ]] || die 1 "--busy-timeout-ms needs an integer"
        BUSY_MS="$2"
        shift 2
        ;;
      --backup-marker)
        [[ $# -ge 2 ]] || die 1 "--backup-marker needs a path"
        MARKER="$2"
        shift 2
        ;;
      --backup-max-age-hours)
        [[ $# -ge 2 ]] || die 1 "--backup-max-age-hours needs an integer"
        MAX_AGE_HOURS="$2"
        shift 2
        ;;
      --lock-file)
        [[ $# -ge 2 ]] || die 1 "--lock-file needs a path"
        LOCK_FILE="$2"
        shift 2
        ;;
      *)
        die 1 "unknown argument: $1"
        ;;
    esac
  done
}

normalize_mode() {
  local raw="${CHECKPOINT_MODE,,}"
  case "$raw" in
    passive) CHECKPOINT_MODE="PASSIVE" ;;
    restart) CHECKPOINT_MODE="RESTART" ;;
    truncate) CHECKPOINT_MODE="TRUNCATE" ;;
    none) CHECKPOINT_MODE="NONE" ;;
    *) die 1 "checkpoint mode must be passive, restart, truncate, or none" ;;
  esac
}

validate_numbers() {
  if ! is_uint "$BUSY_MS" || (( BUSY_MS > 600000 )); then
    die 1 "busy timeout must be an integer from 0 to 600000 milliseconds"
  fi
  if ! is_uint "$MAX_AGE_HOURS" || (( MAX_AGE_HOURS > 8760 )); then
    die 1 "backup max age must be an integer from 0 to 8760 hours"
  fi
}

dedupe_dbs() {
  local path
  local -A seen=()
  local -a unique=()
  for path in "${DBS[@]}"; do
    [[ -n "$path" ]] || continue
    if [[ -n "${seen[$path]:-}" ]]; then
      continue
    fi
    seen["$path"]=1
    unique+=("$path")
  done
  if [[ "${#unique[@]}" -eq 0 ]]; then
    die 1 "no database paths.  Pass --db PATH or SQLITE_DBS=path:path"
  fi
  DBS=("${unique[@]}")
}

acquire_lock() {
  local dir
  dir=$(dirname -- "$LOCK_FILE")
  if [[ ! -d "$dir" || ! -w "$dir" ]]; then
    die 1 "lock directory is not writable: $dir"
  fi
  exec 9>>"$LOCK_FILE"
  if ! flock -n 9; then
    say "sqlite-maintenance: lock busy path=$LOCK_FILE"
    exit 2
  fi
}

deploy_state() {
  local names status
  if [[ "${SQLITE_MAINT_ALLOW_DEPLOY_OVERRIDE:-0}" == "1" && -n "${SQLITE_MAINT_DEPLOY_STATE:-}" ]]; then
    case "$SQLITE_MAINT_DEPLOY_STATE" in
      idle|active|unknown)
        printf '%s\n' "$SQLITE_MAINT_DEPLOY_STATE"
        return 0
        ;;
      *)
        printf 'unknown\n'
        return 0
        ;;
    esac
  fi
  if ! command -v docker >/dev/null 2>&1; then
    printf 'unknown\n'
    return 0
  fi
  if ! names=$(docker ps --format '{{.Names}}' 2>/dev/null); then
    printf 'unknown\n'
    return 0
  fi
  # Same builder-name probe as scripts/ops/box-disk-hygiene.sh is_deploy_active.
  if printf '%s\n' "$names" | grep -Eqi 'nixpacks|coolify-builder|buildkit'; then
    printf 'active\n'
    return 0
  fi
  # Same congress-app gap probe as scripts/ops/congress-health-recover.sh.
  if ! status=$(docker ps -a --filter 'name=congress-app-' --format '{{.Status}}' 2>/dev/null); then
    printf 'unknown\n'
    return 0
  fi
  if printf '%s\n' "$status" | grep -Eqi 'Created|Restarting|health: starting'; then
    printf 'active\n'
    return 0
  fi
  printf 'idle\n'
}

marker_reason() {
  local line="" epoch now age max_s
  if [[ -z "$MARKER" || ! -f "$MARKER" ]]; then
    printf 'backup-marker-missing\n'
    return 0
  fi
  if grep -Eq '^(ok=0|status=fail|fail)$' "$MARKER"; then
    printf 'backup-marker-not-ok\n'
    return 0
  fi
  IFS= read -r line <"$MARKER" || true
  line=${line//$'\r'/}
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  if [[ -z "$line" ]]; then
    printf 'backup-marker-invalid\n'
    return 0
  fi
  if [[ "$line" =~ ^[0-9]+$ ]]; then
    epoch=$line
  elif [[ "$line" =~ ^verified_epoch=([0-9]+)$ ]]; then
    epoch=${BASH_REMATCH[1]}
  else
    epoch=$(date -u -d "$line" +%s 2>/dev/null || true)
    if ! is_uint "${epoch:-}"; then
      printf 'backup-marker-invalid\n'
      return 0
    fi
  fi
  now=$(date +%s)
  age=$((now - epoch))
  if (( age < -300 )); then
    printf 'backup-marker-invalid\n'
    return 0
  fi
  max_s=$((MAX_AGE_HOURS * 3600))
  if (( age > max_s )); then
    printf 'backup-marker-stale\n'
    return 0
  fi
  printf '\n'
}

free_bytes_for() {
  local path="$1" free
  if [[ "${SQLITE_MAINT_ALLOW_FREE_OVERRIDE:-0}" == "1" ]]; then
    if is_uint "${SQLITE_MAINT_FREE_BYTES:-}"; then
      printf '%s\n' "$SQLITE_MAINT_FREE_BYTES"
      return 0
    fi
    return 1
  fi
  free=$(df -P -B1 -- "$path" | awk 'NR==2 { print $4 }')
  if ! is_uint "${free:-}"; then
    return 1
  fi
  printf '%s\n' "$free"
}

vacuum_guard_reason() {
  local db="$1" file_bytes="$2" state free reason chk
  reason=$(marker_reason)
  if [[ -n "$reason" ]]; then
    printf '%s\n' "$reason"
    return 0
  fi
  state=$(deploy_state)
  case "$state" in
    idle) ;;
    active)
      printf 'deploy-active\n'
      return 0
      ;;
    *)
      printf 'deploy-unknown\n'
      return 0
      ;;
  esac
  if ! free=$(free_bytes_for "$db"); then
    printf 'disk-unknown\n'
    return 0
  fi
  if (( free * 2 < file_bytes * 5 )); then
    printf 'disk-free-low %s %s\n' "$free" "$(((file_bytes * 5 + 1) / 2))"
    return 0
  fi
  if ! chk=$(sqlite3 -- "$db" "PRAGMA integrity_check;"); then
    printf 'integrity-failed\n'
    return 0
  fi
  if [[ "${chk%%$'\n'*}" != "ok" ]]; then
    printf 'integrity-failed\n'
    return 0
  fi
  printf '\n'
}

run_sqlite() {
  local db="$1" sql="$2" tmo="$3" required="$4"
  if ! command -v timeout >/dev/null 2>&1; then
    if [[ "$required" == "1" ]]; then
      return 127
    fi
    sqlite3 -- "$db" "$sql"
    return
  fi
  timeout -k 15s "$tmo" sqlite3 -- "$db" "$sql"
}

checkpoint_sql() {
  case "$CHECKPOINT_MODE" in
    PASSIVE)
      printf 'PRAGMA wal_checkpoint(PASSIVE);'
      ;;
    RESTART)
      printf 'PRAGMA busy_timeout=%s; PRAGMA wal_checkpoint(RESTART);' "$BUSY_MS"
      ;;
    TRUNCATE)
      printf 'PRAGMA busy_timeout=%s; PRAGMA wal_checkpoint(TRUNCATE);' "$BUSY_MS"
      ;;
    *)
      return 1
      ;;
  esac
}

read_pages() {
  local db="$1"
  sqlite3 -readonly -- "$db" "PRAGMA page_size; PRAGMA page_count; PRAGMA freelist_count;"
}

process_one() {
  local db="$1"
  local file_bytes wal_bytes shm_bytes row page_size page_count freelist reclaim
  local ck_skipped="" ck_busy="" ck_log="" ck_ckpt="" sql out last
  local vac_reason="" vac_ran=0 post_free="" post_reclaim="" guard guard_line free_note free_seen need_seen chk

  if [[ ! -f "$db" ]]; then
    say "sqlite-maintenance: error missing db=$db"
    append_row "$db" "missing" "" "" "" "" "" "" "" "" "" "" "" "0" "" ""
    raise_code 1
    return 0
  fi

  file_bytes=$(file_size "$db")
  wal_bytes=$(file_size "${db}-wal")
  shm_bytes=$(file_size "${db}-shm")
  if ! row=$(read_pages "$db"); then
    say "sqlite-maintenance: error pragma-read db=$db"
    append_row "$db" "pragma-read" "$file_bytes" "$wal_bytes" "$shm_bytes" \
      "" "" "" "" "" "" "" "" "" "0" "" ""
    raise_code 1
    return 0
  fi
  page_size=$(printf '%s\n' "$row" | sed -n '1p' | tr -d '[:space:]')
  page_count=$(printf '%s\n' "$row" | sed -n '2p' | tr -d '[:space:]')
  freelist=$(printf '%s\n' "$row" | sed -n '3p' | tr -d '[:space:]')
  if ! is_uint "$page_size" || ! is_uint "$page_count" || ! is_uint "$freelist"; then
    say "sqlite-maintenance: error pragma-parse db=$db"
    append_row "$db" "pragma-parse" "$file_bytes" "$wal_bytes" "$shm_bytes" \
      "" "" "" "" "" "" "" "" "" "0" "" ""
    raise_code 1
    return 0
  fi
  reclaim=$((freelist * page_size))
  say "sqlite-maintenance: report db=$db file_bytes=$file_bytes wal_bytes=$wal_bytes shm_bytes=$shm_bytes page_size=$page_size page_count=$page_count freelist_count=$freelist reclaimable_bytes=$reclaim"

  if [[ "$CHECKPOINT_MODE" == "NONE" ]]; then
    ck_skipped="checkpoint-none"
    say "sqlite-maintenance: checkpoint skipped reason=checkpoint-none db=$db"
  elif [[ "$DRY_RUN" == "1" ]]; then
    ck_skipped="dry-run"
    say "sqlite-maintenance: checkpoint skipped reason=dry-run mode=$CHECKPOINT_MODE db=$db"
  else
    sql=$(checkpoint_sql)
    if ! out=$(run_sqlite "$db" "$sql" "$CHECKPOINT_TIMEOUT" 0); then
      say "sqlite-maintenance: error checkpoint db=$db"
      append_row "$db" "checkpoint" "$file_bytes" "$wal_bytes" "$shm_bytes" \
        "$page_size" "$page_count" "$freelist" "$reclaim" "" "" "" "" "" "0" "" ""
      raise_code 1
      return 0
    fi
    last=$(printf '%s\n' "$out" | awk 'NF { line=$0 } END { print line }')
    IFS='|' read -r ck_busy ck_log ck_ckpt <<<"$last"
    ck_busy=${ck_busy//[[:space:]]/}
    ck_log=${ck_log//[[:space:]]/}
    ck_ckpt=${ck_ckpt//[[:space:]]/}
    if ! is_uint "$ck_busy" || ! is_checkpoint_int "$ck_log" || ! is_checkpoint_int "$ck_ckpt"; then
      say "sqlite-maintenance: error checkpoint-parse db=$db raw=${last}"
      append_row "$db" "checkpoint-parse" "$file_bytes" "$wal_bytes" "$shm_bytes" \
        "$page_size" "$page_count" "$freelist" "$reclaim" "" "" "" "" "" "0" "" ""
      raise_code 1
      return 0
    fi
    if [[ "$ck_log" == "-1" || "$ck_ckpt" == "-1" ]]; then
      ck_skipped="not-wal"
      say "sqlite-maintenance: checkpoint skipped reason=not-wal mode=$CHECKPOINT_MODE busy=$ck_busy log=$ck_log checkpointed=$ck_ckpt db=$db"
    else
      say "sqlite-maintenance: checkpoint mode=$CHECKPOINT_MODE busy=$ck_busy log=$ck_log checkpointed=$ck_ckpt db=$db"
      if [[ "$CHECKPOINT_MODE" != "PASSIVE" && "$ck_busy" != "0" ]]; then
        raise_code 4
      fi
    fi
  fi

  if [[ "$WANT_VACUUM" == "1" ]]; then
    guard_line=$(vacuum_guard_reason "$db" "$file_bytes")
    guard=${guard_line%% *}
    if [[ -n "$guard" ]]; then
      vac_reason=$guard
      free_note=""
      if [[ "$guard" == "disk-free-low" ]]; then
        read -r _ free_seen need_seen <<<"${guard_line}"
        free_note=" free_bytes=${free_seen} need_bytes=${need_seen}"
      fi
      say "sqlite-maintenance: vacuum refused reason=$guard db=$db${free_note}"
      raise_code 3
    elif [[ "$DRY_RUN" == "1" ]]; then
      vac_reason="dry-run"
      say "sqlite-maintenance: vacuum dry-run db=$db"
    else
      say "sqlite-maintenance: vacuum start mode=plain db=$db exclusive_lock=1 note=writers-block-for-the-rewrite"
      sql=$(printf 'PRAGMA busy_timeout=%s; VACUUM;' "$BUSY_MS")
      if ! run_sqlite "$db" "$sql" "$VACUUM_TIMEOUT" 1; then
        vac_reason="failed"
        say "sqlite-maintenance: vacuum failed db=$db"
        raise_code 5
      else
        if ! chk=$(sqlite3 -- "$db" "PRAGMA integrity_check;"); then
          vac_reason="integrity-failed"
          say "sqlite-maintenance: vacuum integrity-failed db=$db"
          raise_code 5
        elif [[ "${chk%%$'\n'*}" != "ok" ]]; then
          vac_reason="integrity-failed"
          say "sqlite-maintenance: vacuum integrity-failed db=$db"
          raise_code 5
        else
          if ! row=$(read_pages "$db"); then
            vac_reason="pragma-read"
            say "sqlite-maintenance: error post-vacuum-read db=$db"
            raise_code 5
          else
            post_free=$(printf '%s\n' "$row" | sed -n '3p' | tr -d '[:space:]')
            page_size=$(printf '%s\n' "$row" | sed -n '1p' | tr -d '[:space:]')
            if ! is_uint "$post_free" || ! is_uint "$page_size"; then
              vac_reason="pragma-parse"
              raise_code 5
            else
              post_reclaim=$((post_free * page_size))
              vac_ran=1
              vac_reason=""
              say "sqlite-maintenance: vacuum ok db=$db freelist_count=$post_free reclaimable_bytes=$post_reclaim"
            fi
          fi
        fi
      fi
    fi
  fi

  append_row "$db" "" "$file_bytes" "$wal_bytes" "$shm_bytes" \
    "$page_size" "$page_count" "$freelist" "$reclaim" \
    "$ck_skipped" "$ck_busy" "$ck_log" "$ck_ckpt" \
    "$vac_reason" "$vac_ran" "$post_free" "$post_reclaim"
}

emit_json() {
  python3 - "$NDJSON" "$DRY_RUN" "$CHECKPOINT_MODE" "$WANT_VACUUM" <<'PY'
import json
import sys

path, dry_run, mode, vacuum = sys.argv[1:5]
rows = []
with open(path, encoding="utf-8") as handle:
    for line in handle:
        if line.strip():
            rows.append(json.loads(line))
doc = {
    "checkpoint_mode": mode,
    "databases": rows,
    "dry_run": dry_run == "1",
    "vacuum": vacuum == "1",
}
json.dump(doc, sys.stdout, sort_keys=True)
sys.stdout.write("\n")
PY
}

main() {
  load_env_defaults
  parse_args "$@"
  normalize_mode
  validate_numbers
  dedupe_dbs
  if ! command -v sqlite3 >/dev/null 2>&1; then
    die 1 "sqlite3 is not on PATH"
  fi
  if [[ "$WANT_JSON" == "1" ]] && ! command -v python3 >/dev/null 2>&1; then
    die 1 "python3 is required for --json"
  fi
  if [[ "$WANT_JSON" == "1" ]]; then
    NDJSON=$(mktemp)
  fi
  acquire_lock
  local db
  for db in "${DBS[@]}"; do
    process_one "$db"
  done
  if [[ "$WANT_JSON" == "1" ]]; then
    emit_json
  fi
  exit "$WORST"
}

main "$@"
