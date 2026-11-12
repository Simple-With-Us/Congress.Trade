#!/usr/bin/env bash
# Weekly restore drill for the newest local sqlite dump.
#
# Reads dumps produced by scripts/ops/fleet-sqlite-backup.sh:
#   /data/backups/<app>/<name>-<YYYYMMDDTHHMMSSZ>.db
#   /data/backups/<app>/<name>-<YYYYMMDDTHHMMSSZ>.db.zst
# The .sha256 sidecar is the raw database hash (the bytes after zstd -d).
# /data/backups is a symlink chain onto /backups. This script resolves it
# and only selects regular files under that root.
#
# The drill copies the newest complete dump for each selected app into a
# private temp directory on FLEET_BACKUP_DRILL_WORKDIR, then runs
# PRAGMA integrity_check, PRAGMA quick_check, key-table counts, and the
# sha256 compare when a sidecar is present. It prints PASS or FAIL and a
# duration. --json adds one JSON object as the last stdout line.
#
# Safety:
#   - nice -n 10 and ionice best-effort/7 (falls back to nice if ionice is missing)
#   - flock on FLEET_BACKUP_DRILL_LOCKFILE (a held lock is FAIL, not a silent skip)
#   - refuses live databases and any path under /var/lib/docker
#   - refuses a workdir inside the backup root
#   - fail closed when free space is under 1.5x the restored size
#   - never writes a dump, a sidecar, or a live database
#   - trap removes only this run's drill.* directory
#
# Host install waits for Jay. The sample timer is scripts/ops/systemd.noindex/.
# CT-1685 is the host-loss runbook. This drill does not perform that restore.
set -euo pipefail
export LC_ALL=C

if [[ "${FLEET_BACKUP_DRILL_LIB_ONLY:-}" != 1 && "${FLEET_BACKUP_DRILL_NICED:-}" != 1 ]]; then
  export FLEET_BACKUP_DRILL_NICED=1
  if command -v ionice >/dev/null 2>&1 && ionice -c 2 -n 7 true >/dev/null 2>&1; then
    exec ionice -c 2 -n 7 nice -n 10 "$0" "$@"
  fi
  printf '%s\n' "[restore-drill] WARN ionice unavailable; continuing with nice" >&2
  exec nice -n 10 "$0" "$@"
fi

ROOT="${FLEET_BACKUP_ROOT:-/data/backups}"
WORKDIR="${FLEET_BACKUP_DRILL_WORKDIR:-/var/tmp/fleet-backup-restore-drill}"
LOCKFILE="${FLEET_BACKUP_DRILL_LOCKFILE:-/var/lock/fleet-backup-restore-drill.lock}"
APPS="${FLEET_BACKUP_DRILL_APPS:-congress}"
TABLES="${FLEET_BACKUP_DRILL_TABLES:-filers,filings,transactions}"
JSON=0
EXPLICIT_DUMP=""
WORKDIR_REAL=""
ROOT_REAL=""
DRILL_TMP=""
RESULTS_FILE=""
FINISHED=0
START_NS=""
OVERALL_OK=1

log() {
  printf '%s\n' "[restore-drill] $*"
}

dump_base_db() {
  local f="$1"
  case "$f" in
    *.db.zst) printf '%s\n' "${f%.zst}" ;;
    *) printf '%s\n' "$f" ;;
  esac
}

dump_name_ok() {
  local base
  base="$(basename "$(dump_base_db "$1")")"
  [[ "$base" =~ -[0-9]{8}T[0-9]{6}Z\.db$ ]]
}

canonical_path() {
  local p="$1"
  if [[ -e "$p" || -L "$p" ]]; then
    readlink -f -- "$p"
    return 0
  fi
  realpath -m -- "$p"
}

is_live_db() {
  local p
  p="$(canonical_path "$1")"
  case "$p" in
    /data/congress-trade/db.sqlite|/data/congress-trade/kv.sqlite|/data/prod.db)
      return 0
      ;;
    /var/lib/docker/*)
      return 0
      ;;
  esac
  return 1
}

dump_is_complete() {
  local base="$1"
  base="$(dump_base_db "$base")"
  case "$base" in
    *.db) ;;
    *) return 1 ;;
  esac
  [[ -f "${base}.sha256" ]] || return 1
  [[ ! -e "${base}-journal" ]] || return 1
  if [[ -f "$base" && -s "$base" ]]; then
    return 0
  fi
  if [[ -f "${base}.zst" && -s "${base}.zst" ]]; then
    return 0
  fi
  return 1
}

path_under() {
  local root="$1" path="$2"
  case "$path" in
    "$root"/*) return 0 ;;
  esac
  return 1
}

latest_complete_dump() {
  local dir="$1" path base root_real
  local -A seen=()
  root_real="${ROOT_REAL:-}"
  [[ -n "$root_real" && -d "$dir" ]] || return 0
  while IFS=$'\t' read -r _ts path; do
    [[ -n "$path" ]] || continue
    [[ -f "$path" ]] || continue
    path="$(readlink -f -- "$path")"
    path_under "$root_real" "$path" || continue
    base="$(dump_base_db "$path")"
    [[ -n "${seen[$base]:-}" ]] && continue
    seen["$base"]=1
    dump_name_ok "$base" || continue
    dump_is_complete "$base" || continue
    if is_live_db "$path"; then
      continue
    fi
    printf '%s\n' "$path"
    return 0
  done < <(find "$dir" -maxdepth 1 -type f \( -name '*.db' -o -name '*.db.zst' \) -printf '%T@\t%p\n' | sort -nr)
}

space_need_bytes() {
  local restored="$1"
  [[ "$restored" =~ ^[0-9]+$ ]] || return 1
  # Signed 64-bit ceiling for restored * 3 + 1.
  if [[ "$restored" -gt 3074457345618258602 ]]; then
    return 1
  fi
  printf '%s\n' $(( (restored * 3 + 1) / 2 ))
}

filesystem_free_bytes() {
  local path="$1" avail
  avail="$(df -B1 --output=avail -- "$path" | awk 'NR==2 { print $1; exit }')" || return 1
  [[ "$avail" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "$avail"
}

zstd_content_bytes() {
  python3 - "$1" <<'PY'
import sys

def read_exact(f, n):
    buf = f.read(n)
    if len(buf) != n:
        raise ValueError("truncated zstd frame")
    return buf

def uncompressed_size(path):
    total = 0
    frames = 0
    with open(path, "rb") as f:
        while True:
            magic = f.read(4)
            if magic == b"":
                break
            if len(magic) != 4:
                raise ValueError("truncated zstd magic")
            m = int.from_bytes(magic, "little")
            if 0x184D2A50 <= m <= 0x184D2A5F:
                skip = int.from_bytes(read_exact(f, 4), "little")
                read_exact(f, skip)
                continue
            if m != 0xFD2FB528:
                raise ValueError("not a zstd frame")
            desc = read_exact(f, 1)[0]
            fcs_flag = (desc >> 6) & 3
            single = (desc >> 5) & 1
            checksum = (desc >> 2) & 1
            did_flag = desc & 3
            if not single:
                read_exact(f, 1)
            did_len = (0, 1, 2, 4)[did_flag]
            if did_len:
                read_exact(f, did_len)
            if fcs_flag == 0 and not single:
                raise ValueError("unknown zstd content size")
            fcs_len = (1, 2, 4, 8)[fcs_flag]
            raw = int.from_bytes(read_exact(f, fcs_len), "little")
            if fcs_flag == 1:
                raw += 256
            total += raw
            frames += 1
            while True:
                hdr = int.from_bytes(read_exact(f, 3), "little")
                last = hdr & 1
                btype = (hdr >> 1) & 3
                bsize = hdr >> 3
                if btype == 0:
                    read_exact(f, bsize)
                elif btype == 1:
                    read_exact(f, 1)
                elif btype == 2:
                    read_exact(f, bsize)
                else:
                    raise ValueError("reserved zstd block")
                if last:
                    break
            if checksum:
                read_exact(f, 4)
    if frames == 0 or total <= 0:
        raise ValueError("empty zstd payload")
    return total

try:
    print(uncompressed_size(sys.argv[1]))
except Exception as exc:
    print(str(exc), file=sys.stderr)
    sys.exit(1)
PY
}

restored_size_bytes() {
  local src="$1"
  case "$src" in
    *.zst) zstd_content_bytes "$src" ;;
    *)
      [[ -f "$src" && -s "$src" ]] || return 1
      stat -c %s -- "$src"
      ;;
  esac
}

# -nofollow is SQLite 3.39+. An older CLI rejects the flag and would fail a
# healthy dump. Probe once. -readonly is older and stays on either way.
# The restored file is one this run just created, and symlink sources are
# already refused, so a CLI without -nofollow is still not opening the live DB.
sqlite_ro_flags() {
  if [[ "${SQLITE_RO_READY:-}" == 1 ]]; then
    return 0
  fi
  SQLITE_RO_FLAGS=(-readonly)
  if sqlite3 -nofollow :memory: "SELECT 1;" >/dev/null 2>&1; then
    SQLITE_RO_FLAGS+=(-nofollow)
  fi
  SQLITE_RO_READY=1
}

sqlite_ro() {
  local db="$1" sql="$2"
  sqlite_ro_flags
  sqlite3 "${SQLITE_RO_FLAGS[@]}" -- "$db" "$sql"
}

valid_ident() {
  [[ "$1" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]
}

schema_version_of() {
  local db="$1" uv has col max
  uv="$(sqlite_ro "$db" "PRAGMA user_version;")" || return 1
  if [[ "$uv" =~ ^[1-9][0-9]*$ ]]; then
    printf '%s\n' "$uv"
    return 0
  fi
  has="$(sqlite_ro "$db" "SELECT COUNT(*) FROM sqlite_schema WHERE type='table' AND name='schema_migrations';")" || return 1
  if [[ "$has" == "1" ]]; then
    col="$(sqlite_ro "$db" "SELECT COUNT(*) FROM pragma_table_info('schema_migrations') WHERE name='version';")" || return 1
    if [[ "$col" == "1" ]]; then
      max="$(sqlite_ro "$db" "SELECT MAX(version) FROM schema_migrations;")" || return 1
      if [[ "$max" =~ ^[0-9]+$ ]]; then
        printf '%s\n' "$max"
        return 0
      fi
    fi
  fi
  printf '\n'
}

remove_drill_tmp() {
  local tmp="${DRILL_TMP:-}"
  [[ -n "$tmp" ]] || return 0
  DRILL_TMP=""
  [[ -n "${WORKDIR_REAL:-}" ]] || return 0
  case "$tmp" in
    "$WORKDIR_REAL"/drill.*) ;;
    *)
      log "WARN refusing to remove unexpected path"
      return 0
      ;;
  esac
  [[ -L "$tmp" ]] && return 0
  [[ -d "$tmp" ]] || return 0
  rm -rf -- "$tmp"
}

remove_results() {
  if [[ -n "${RESULTS_FILE:-}" && -f "$RESULTS_FILE" ]]; then
    rm -f -- "$RESULTS_FILE"
  fi
  RESULTS_FILE=""
}

cleanup() {
  remove_drill_tmp
  remove_results
}

trap cleanup EXIT

duration_sec() {
  local now
  now="$(date +%s%N)"
  python3 -c 'import sys; print(f"{(int(sys.argv[1]) - int(sys.argv[2])) / 1e9:.3f}")' "$now" "$START_NS"
}

emit_json() {
  local result="$1" dur="$2"
  [[ "$JSON" == 1 ]] || return 0
  python3 - "$RESULTS_FILE" "$result" "$dur" <<'PY'
import json, sys
path, result, dur = sys.argv[1], sys.argv[2], sys.argv[3]
dumps = []
if path:
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                dumps.append(json.loads(line))
print(json.dumps({
    "ok": result == "PASS",
    "result": result,
    "duration_sec": float(dur),
    "space_factor": 1.5,
    "dumps": dumps,
}, separators=(",", ":")))
PY
}

finish() {
  local result="$1"
  local dur code
  [[ "$FINISHED" == 1 ]] && return 0
  FINISHED=1
  dur="$(duration_sec)"
  log "$result duration=${dur}s"
  emit_json "$result" "$dur"
  if [[ "$result" == "PASS" ]]; then
    code=0
  else
    code=1
  fi
  exit "$code"
}

record_dump() {
  python3 - "$@" >>"$RESULTS_FILE" <<'PY'
import json, sys
app, dump, fmt, restored, free, need, integrity, quick, sha, schema, ok, error, tables = sys.argv[1:]
parsed = {}
if tables:
    for item in tables.split(","):
        name, value = item.split("=", 1)
        parsed[name] = None if value == "" else int(value)
print(json.dumps({
    "app": app,
    "dump": dump,
    "format": fmt,
    "restored_bytes": int(restored) if restored.isdigit() else None,
    "free_bytes": int(free) if free.isdigit() else None,
    "need_bytes": int(need) if need.isdigit() else None,
    "integrity_check": integrity or None,
    "quick_check": quick or None,
    "sha256": sha or None,
    "schema_version": int(schema) if schema.isdigit() else None,
    "tables": parsed,
    "ok": ok == "1",
    "error": error or None,
}, separators=(",", ":")))
PY
}

app_dir() {
  case "$1" in
    socratic) printf '%s\n' "$ROOT_REAL/socratic" ;;
    congress) printf '%s\n' "$ROOT_REAL/congress" ;;
    usage-monitor) printf '%s\n' "$ROOT_REAL/usage-monitor" ;;
    *) return 1 ;;
  esac
}

sha256_file() {
  local line
  line="$(sha256sum -- "$1")" || return 1
  printf '%s\n' "${line%% *}"
}

sha256_status() {
  local base="$1" restored="$2" sidecar want got
  base="$(dump_base_db "$base")"
  sidecar="${base}.sha256"
  if [[ ! -f "$sidecar" ]]; then
    printf '%s\n' "absent"
    return 0
  fi
  want="$(awk 'NR==1 { print $1; exit }' "$sidecar")"
  got="$(sha256_file "$restored")" || return 1
  if [[ -n "$want" && "$want" == "$got" ]]; then
    printf '%s\n' "match"
    return 0
  fi
  printf '%s\n' "mismatch"
  return 1
}

count_key_tables() {
  local db="$1"
  local -n _out=$2
  local table exists count missing=0
  _out=""
  for table in "${TABLE_LIST[@]}"; do
    exists="$(sqlite_ro "$db" "SELECT COUNT(*) FROM sqlite_schema WHERE type='table' AND name='${table}';")" || return 1
    if [[ "$exists" != "1" ]]; then
      missing=1
      if [[ -n "$_out" ]]; then
        _out+=","
      fi
      _out+="${table}="
      continue
    fi
    count="$(sqlite_ro "$db" "SELECT COUNT(*) FROM \"${table}\";")" || return 1
    [[ "$count" =~ ^[0-9]+$ ]] || return 1
    if [[ -n "$_out" ]]; then
      _out+=","
    fi
    _out+="${table}=${count}"
  done
  [[ "$missing" == 0 ]]
}

drill_one() {
  local app="$1" src="$2"
  local base fmt restored="" free="" need="" dest integrity="" quick="" sha="" schema="" tables="" err="" ok=1
  local src_inode src_size src_mode src_mtime
  base="$(dump_base_db "$src")"
  case "$src" in
    *.zst) fmt="zst" ;;
    *.db) fmt="db" ;;
    *)
      ok=0
      err="unsupported dump name"
      OVERALL_OK=0
      record_dump "$app" "$(basename "$src")" "" "" "" "" "" "" "" "" 0 "$err" ""
      log "FAIL $app $err ($(basename "$src"))"
      return 0
      ;;
  esac
  if is_live_db "$src"; then
    ok=0
    err="refusing live database"
    OVERALL_OK=0
    record_dump "$app" "$(basename "$src")" "$fmt" "" "" "" "" "" "" "" 0 "$err" ""
    log "FAIL $app $err"
    return 0
  fi
  if [[ ! -f "$src" || -L "$src" ]]; then
    ok=0
    err="dump is not a regular file"
    OVERALL_OK=0
    record_dump "$app" "$(basename -- "$src")" "$fmt" "" "" "" "" "" "" "" 0 "$err" ""
    log "FAIL $app $err"
    return 0
  fi
  src="$(readlink -f -- "$src")"
  if is_live_db "$src"; then
    ok=0
    err="refusing live database"
    OVERALL_OK=0
    record_dump "$app" "$(basename "$src")" "$fmt" "" "" "" "" "" "" "" 0 "$err" ""
    log "FAIL $app $err"
    return 0
  fi
  src_inode="$(stat -c %i -- "$src")"
  src_size="$(stat -c %s -- "$src")"
  src_mode="$(stat -c %a -- "$src")"
  src_mtime="$(stat -c %Y -- "$src")"
  if ! restored="$(restored_size_bytes "$src")"; then
    ok=0
    err="unknown restored size"
    OVERALL_OK=0
    record_dump "$app" "$(basename "$src")" "$fmt" "" "" "" "" "" "" "" 0 "$err" ""
    log "FAIL $app $err ($(basename "$src"))"
    return 0
  fi
  if ! need="$(space_need_bytes "$restored")"; then
    ok=0
    err="restored size is not a safe byte count"
    OVERALL_OK=0
    record_dump "$app" "$(basename "$src")" "$fmt" "$restored" "" "" "" "" "" "" 0 "$err" ""
    log "FAIL $app $err"
    return 0
  fi
  if ! free="$(filesystem_free_bytes "$WORKDIR_REAL")"; then
    ok=0
    err="free space unknown"
    OVERALL_OK=0
    record_dump "$app" "$(basename "$src")" "$fmt" "$restored" "" "$need" "" "" "" "" 0 "$err" ""
    log "FAIL $app $err"
    return 0
  fi
  log "$app $(basename "$src") restored_bytes=$restored free_bytes=$free need_bytes=$need"
  if [[ "$free" -lt "$need" ]]; then
    ok=0
    err="free space ${free} < need ${need}"
    OVERALL_OK=0
    record_dump "$app" "$(basename "$src")" "$fmt" "$restored" "$free" "$need" "" "" "" "" 0 "$err" ""
    log "FAIL $app $err"
    return 0
  fi
  if [[ "$fmt" == "zst" ]] && ! command -v zstd >/dev/null 2>&1; then
    ok=0
    err="zstd missing"
    OVERALL_OK=0
    record_dump "$app" "$(basename "$src")" "$fmt" "$restored" "$free" "$need" "" "" "" "" 0 "$err" ""
    log "FAIL $app $err"
    return 0
  fi
  remove_drill_tmp
  umask 077
  DRILL_TMP="$(mktemp -d "$WORKDIR_REAL/drill.XXXXXX")"
  dest="$DRILL_TMP/restored.sqlite"
  if [[ "$fmt" == "zst" ]]; then
    if ! zstd -q -d -o "$dest" -- "$src"; then
      ok=0
      err="decompress failed"
    fi
  else
    if ! cp -- "$src" "$dest"; then
      ok=0
      err="copy failed"
    fi
  fi
  if [[ "$ok" == 1 ]]; then
    chmod 600 -- "$dest" || true
    if ! integrity="$(sqlite_ro "$dest" "SELECT integrity_check FROM pragma_integrity_check LIMIT 1;")"; then
      integrity="error"
      ok=0
      err="integrity_check failed"
    elif [[ "$integrity" != "ok" ]]; then
      ok=0
      err="integrity_check not ok"
    fi
  fi
  if [[ "$ok" == 1 ]]; then
    if ! quick="$(sqlite_ro "$dest" "SELECT quick_check FROM pragma_quick_check LIMIT 1;")"; then
      quick="error"
      ok=0
      err="quick_check failed"
    elif [[ "$quick" != "ok" ]]; then
      ok=0
      err="quick_check not ok"
    fi
  fi
  if [[ "$ok" == 1 ]]; then
    if ! schema="$(schema_version_of "$dest")"; then
      ok=0
      err="schema version unreadable"
      schema=""
    fi
  fi
  if [[ "$ok" == 1 ]]; then
    if ! count_key_tables "$dest" tables; then
      ok=0
      if [[ "$err" == "" ]]; then
        err="key table missing or unreadable"
      fi
    fi
  fi
  if [[ -f "$dest" ]]; then
    if sha="$(sha256_status "$base" "$dest")"; then
      :
    else
      ok=0
      if [[ "$err" == "" ]]; then
        err="sha256 mismatch"
      fi
    fi
  fi
  if [[ "$(stat -c %i -- "$src")" != "$src_inode" \
    || "$(stat -c %s -- "$src")" != "$src_size" \
    || "$(stat -c %a -- "$src")" != "$src_mode" \
    || "$(stat -c %Y -- "$src")" != "$src_mtime" ]]; then
    ok=0
    err="source dump changed during drill"
    OVERALL_OK=0
  fi
  if [[ "$ok" != 1 ]]; then
    OVERALL_OK=0
  fi
  record_dump "$app" "$(basename "$src")" "$fmt" "$restored" "$free" "$need" "$integrity" "$quick" "$sha" "$schema" "$ok" "$err" "$tables"
  if [[ "$ok" == 1 ]]; then
    log "$app integrity_check=${integrity} quick_check=${quick} sha256=${sha} schema_version=${schema:-none}"
    if [[ -n "$tables" ]]; then
      local item name value
      IFS=',' read -r -a _items <<<"$tables"
      for item in "${_items[@]}"; do
        name="${item%%=*}"
        value="${item#*=}"
        log "$app table ${name}=${value}"
      done
    fi
  else
    log "FAIL $app ${err}"
  fi
  remove_drill_tmp
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --json)
        JSON=1
        shift
        ;;
      --apps)
        [[ $# -ge 2 ]] || { log "FAIL missing --apps value"; exit 1; }
        APPS="$2"
        shift 2
        ;;
      --dump)
        [[ $# -ge 2 ]] || { log "FAIL missing --dump value"; exit 1; }
        EXPLICIT_DUMP="$2"
        shift 2
        ;;
      --workdir)
        [[ $# -ge 2 ]] || { log "FAIL missing --workdir value"; exit 1; }
        WORKDIR="$2"
        shift 2
        ;;
      -h|--help)
        usage
        FINISHED=1
        exit 0
        ;;
      *)
        log "FAIL unknown argument: $1"
        exit 1
        ;;
    esac
  done
}

usage() {
  cat <<'EOF'
Usage: fleet-backup-restore-drill.sh [--json] [--apps a,b] [--dump PATH] [--workdir DIR]

Restore the newest complete local sqlite dump for each selected app into a
temp directory, check it, and delete only that temp directory.

  FLEET_BACKUP_ROOT              dump root (default /data/backups)
  FLEET_BACKUP_DRILL_APPS        socratic,congress,usage-monitor (default congress)
  FLEET_BACKUP_DRILL_WORKDIR     filesystem for the temp copy
  FLEET_BACKUP_DRILL_LOCKFILE    single-flight lock
  FLEET_BACKUP_DRILL_TABLES      key tables to count (default filers,filings,transactions)
EOF
}

prepare_tables() {
  local raw token
  TABLE_LIST=()
  raw="$(printf '%s' "$TABLES" | tr -d '[:space:]')"
  IFS=',' read -r -a _tokens <<<"$raw"
  for token in "${_tokens[@]}"; do
    [[ -n "$token" ]] || continue
    if ! valid_ident "$token"; then
      log "FAIL invalid table name"
      exit 1
    fi
    TABLE_LIST+=("$token")
  done
  if [[ "${#TABLE_LIST[@]}" -eq 0 ]]; then
    log "FAIL no key tables configured"
    exit 1
  fi
}

prepare_paths() {
  local resolved
  WORKDIR_REAL="$(canonical_path "$WORKDIR")"
  if [[ "$WORKDIR_REAL" == "/" || -z "$WORKDIR_REAL" ]]; then
    log "FAIL refusing workdir /"
    exit 1
  fi
  if [[ -d "$ROOT" || -L "$ROOT" ]]; then
    ROOT_REAL="$(canonical_path "$ROOT")"
  else
    ROOT_REAL="$(realpath -m -- "$ROOT")"
  fi
  if path_under "$ROOT_REAL" "$WORKDIR_REAL" || [[ "$WORKDIR_REAL" == "$ROOT_REAL" ]]; then
    log "FAIL workdir is inside the backup root"
    exit 1
  fi
  if is_live_db "$WORKDIR_REAL"; then
    log "FAIL workdir is a live database path"
    exit 1
  fi
  mkdir -p -- "$WORKDIR_REAL" || { log "FAIL cannot create workdir"; exit 1; }
  resolved="$(dirname -- "$LOCKFILE")"
  mkdir -p -- "$resolved" || { log "FAIL cannot create lock dir"; exit 1; }
}

acquire_lock() {
  exec 9>"$LOCKFILE" || return 1
  flock -n 9
}

selected_apps() {
  local raw token
  APP_LIST=()
  raw="$(printf '%s' "$APPS" | tr '[:upper:]' '[:lower:]' | tr ',' ' ')"
  for token in $raw; do
    case "$token" in
      socratic|congress|usage-monitor) APP_LIST+=("$token") ;;
      "") ;;
      *)
        log "FAIL unknown app: $token"
        exit 1
        ;;
    esac
  done
  if [[ "${#APP_LIST[@]}" -eq 0 ]]; then
    log "FAIL no apps selected"
    exit 1
  fi
}

main() {
  local app dir latest label
  umask 077
  START_NS="$(date +%s%N)"
  RESULTS_FILE="$(mktemp "${TMPDIR:-/tmp}/fleet-restore-drill-results.XXXXXX")"
  parse_args "$@"
  prepare_tables
  prepare_paths
  if ! acquire_lock; then
    log "FAIL lock held"
    OVERALL_OK=0
    finish FAIL
  fi
  if [[ -n "$EXPLICIT_DUMP" ]]; then
    label="$(basename "$(dirname -- "$EXPLICIT_DUMP")")"
    case "$label" in
      socratic|congress|usage-monitor) ;;
      *) label="dump" ;;
    esac
    if [[ ! -e "$EXPLICIT_DUMP" && ! -L "$EXPLICIT_DUMP" ]]; then
      if is_live_db "$EXPLICIT_DUMP"; then
        log "FAIL refusing live database"
        record_dump "$label" "$(basename -- "$EXPLICIT_DUMP")" "" "" "" "" "" "" "" "" 0 "refusing live database" ""
      else
        log "FAIL dump not found"
        record_dump "$label" "$(basename -- "$EXPLICIT_DUMP")" "" "" "" "" "" "" "" "" 0 "dump not found" ""
      fi
      OVERALL_OK=0
      finish FAIL
    fi
    drill_one "$label" "$EXPLICIT_DUMP"
  else
    selected_apps
    for app in "${APP_LIST[@]}"; do
      dir="$(app_dir "$app")"
      latest="$(latest_complete_dump "$dir" || true)"
      if [[ -z "$latest" ]]; then
        OVERALL_OK=0
        record_dump "$app" "" "" "" "" "" "" "" "" "" 0 "no complete dump" ""
        log "FAIL $app no complete dump"
        continue
      fi
      drill_one "$app" "$latest"
    done
  fi
  if [[ "$OVERALL_OK" == 1 ]]; then
    finish PASS
  fi
  finish FAIL
}

if [[ "${FLEET_BACKUP_DRILL_LIB_ONLY:-}" == 1 ]]; then
  # return when sourced; exit when a shell ignores return at top level.
  # shellcheck disable=SC2317
  return 0 2>/dev/null || exit 0
fi

main "$@"
