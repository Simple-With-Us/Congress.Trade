#!/usr/bin/env bash
# Consistent SQLite snapshots for fleet apps + optional off-host copy.
# Complements Hetzner daily host backups (RPO ~24h host-level).
#
# Per-app split (Jay 2026-10-05 correction): Usage-Monitor alone is daily with
# 7+4 B2 retention.  Socratic.Trade and Congress.Trade stay on the previous
# 6-hourly keep-2 cadence until Jay decides separately.  Select apps with
# FLEET_BACKUP_APPS=socratic,congress,usage-monitor (comma-separated).
# Cron: /etc/cron.d/fleet-backups (two dump lines + weekly UM-only verify).
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


# A dump is complete only when the .db exists, a matching .sha256 sidecar
# exists, and sqlite3 is not still writing a rollback journal.  Incomplete
# files must never win KEEP_COUNT / KEEP_DAYS over a finished snapshot.
dump_is_complete() {
  local f="$1"
  [ -f "$f" ] || return 1
  [ -s "$f" ] || return 1
  [ -f "${f}.sha256" ] || return 1
  [ ! -e "${f}-journal" ]
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
    echo "[fleet-backup] OK $name -> $dest ($(du -h "$dest" | awk '{print $1}'))"
    sha256sum "$dest" > "${dest}.sha256"
  else
    echo "[fleet-backup] FAIL $name integrity not clean: $dest"
    rm -f "${dest}.sha256" "$dest"
    fleet_backup_alert "$name integrity_check failed"
    return 1
  fi
}

prune_incomplete_dumps() {
  local app dir f
  [ -d "$ROOT" ] || return 0
  for app in "${BACKUP_APP_LIST[@]}"; do
    dir="$ROOT/$app"
    [ -d "$dir" ] || continue
    for f in "$dir"/*.db; do
      [ -f "$f" ] || continue
      if dump_is_complete "$f"; then
        continue
      fi
      echo "[fleet-backup] prune-incomplete $f"
      rm -f "$f" "${f}.sha256" "${f}-journal" "${f}-wal"
    done
  done
}

prune_by_age() {
  local app dir f s db
  [ -d "$ROOT" ] || return 0
  case "$KEEP_DAYS" in
    ''|*[!0-9]*)
      echo "[fleet-backup] retention SKIP: non-numeric FLEET_BACKUP_KEEP_DAYS=$KEEP_DAYS"
      return 0
      ;;
  esac
  # Age-prune only complete dumps so an incomplete newer file cannot keep a
  # finished snapshot from being the one KEEP_DAYS considers.  Scoped to
  # FLEET_BACKUP_APPS dirs only (ST/CT keep-2 must not touch UM dumps).
  for app in "${BACKUP_APP_LIST[@]}"; do
    dir="$ROOT/$app"
    [ -d "$dir" ] || continue
    find "$dir" -type f -name '*.db' -mtime +"$KEEP_DAYS" -print 2>/dev/null | while read -r f; do
      dump_is_complete "$f" || continue
      echo "[fleet-backup] prune-age $f"
      rm -f "$f" "${f}.sha256"
    done || true
    find "$dir" -type f -name '*.sqlite' -mtime +"$KEEP_DAYS" -print -delete 2>/dev/null || true
    find "$dir" -type f -name '*.sha256' -mtime +"$KEEP_DAYS" -print 2>/dev/null | while read -r s; do
      db="${s%.sha256}"
      if [ ! -f "$db" ]; then
        echo "[fleet-backup] prune-age-orphan $s"
        rm -f "$s"
      fi
    done || true
  done
}

prune_by_keep_count() {
  local app dir f n
  [ -d "$ROOT" ] || return 0
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
    dir="$ROOT/$app"
    [ -d "$dir" ] || continue
    n=0
    # Newest-first; skip anything that is not a complete dump so a live
    # .db-journal or missing .sha256 cannot occupy a KEEP_COUNT slot.
    ls -1t "$dir"/*.db 2>/dev/null | while read -r f; do
      [ -f "$f" ] || continue
      dump_is_complete "$f" || continue
      n=$((n + 1))
      if [ "$n" -gt "$KEEP_COUNT" ]; then
        echo "[fleet-backup] prune-count $f"
        rm -f "$f" "${f}.sha256"
      fi
    done || true
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
}

if [ "${FLEET_BACKUP_LIB_ONLY:-0}" = "1" ]; then
  return 0 2>/dev/null || exit 0
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
mkdir -p "$ROOT" /var/log/fleet-backup
exec > >(tee -a "$LOG") 2>&1
echo "[fleet-backup] start $STAMP apps=$FLEET_BACKUP_APPS keep_days=$KEEP_DAYS keep_count=$KEEP_COUNT b2_sets=${B2_KEEP_SETS:-} b2_daily=${B2_KEEP_DAILY:-} b2_weekly=${B2_KEEP_WEEKLY:-}"

if ! backup_apps_selected; then
  exit 1
fi

if [ "$FLEET_BACKUP_DRY_RUN" = "1" ]; then
  echo "[fleet-backup] DRY-RUN: would dump/prune local dirs and B2 hetzner/ prefixes:"
  declare -A _B2_BUCKET=( [congress]="jays-congress-trade-eu" [socratic]="jays-socratic-trade-eu" [usage-monitor]="jays-usage-monitor-eu" )
  for app in "${BACKUP_APP_LIST[@]}"; do
    echo "  local: $ROOT/$app/"
    echo "  B2:    b2:${_B2_BUCKET[$app]}/hetzner/  (dump sets only; never Litestream / qdrant/)"
    if [ -d "$ROOT/$app" ]; then
      ls -1t "$ROOT/$app"/*.db 2>/dev/null | head -5 | while read -r f; do
        echo "    present: $(basename "$f") ($(du -h "$f" | awk '{print $1}'))"
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

# retention: drop incomplete dumps first, then age-based (default 7d) AND
# keep-count (default 3 newest COMPLETE .db per app dir)
apply_local_retention
echo "[fleet-backup] done $STAMP"
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

# B2-side prune (CLAUDE 2026-08-31; retention rewrite Jay 2026-10-05):
# keep ~7 daily + ~4 weekly dump sets under hetzner/ and delete older dump
# sets.  NEVER touches Litestream prefixes (trading-live/, congress-trade/,
# api-usage-monitor/) or qdrant/ under hetzner/.  A set = the .db/.sqlite
# files + .sha256 sidecars sharing one YYYYMMDDTHHMMSSZ stamp.
# Deletes go through rclone delete --include against the native [b2] remote
# (Class A, free).  Best-effort: a prune failure must never fail the backup
# run (callers append "|| true").
#
# Env:
#   B2_KEEP_DAILY   newest N dump sets to keep (default 7)
#   B2_KEEP_WEEKLY  additional Sunday-UTC dump sets to keep (default 4)
#   B2_KEEP_SETS    legacy total-newest fallback; if set, keep newest N only
B2_KEEP_DAILY="${B2_KEEP_DAILY:-7}"
B2_KEEP_WEEKLY="${B2_KEEP_WEEKLY:-4}"
B2_KEEP_SETS="${B2_KEEP_SETS:-}"
prune_b2_sets() {
  local app="$1" bucket="$2" current_stamp="$3"
  local listing stamps_all stamp name kept_count deleted_count set_fail
  local keep_daily="$B2_KEEP_DAILY" keep_weekly="$B2_KEEP_WEEKLY"
  local dow weekly_kept
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
  # Newest-first distinct stamps from dump-like names only.
  stamps_all="$(printf '%s\n' "$listing" \
    | grep -E '\.(db|sqlite)(\.sha256)?$' \
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
    while read -r stamp; do
      [ -n "$stamp" ] || continue
      KEEP_STAMPS["$stamp"]=1
      kept_count=$((kept_count + 1))
      [ "$kept_count" -ge "$keep_daily" ] && break
    done <<< "$stamps_all"
    weekly_kept=0
    while read -r stamp; do
      [ -n "$stamp" ] || continue
      [ -n "${KEEP_STAMPS[$stamp]:-}" ] && continue
      dow="$(date -u -d "${stamp:0:4}-${stamp:4:2}-${stamp:6:2}" +%u 2>/dev/null || true)"
      [ "$dow" = "7" ] || continue
      KEEP_STAMPS["$stamp"]=1
      weekly_kept=$((weekly_kept + 1))
      kept_count=$((kept_count + 1))
      [ "$weekly_kept" -ge "$keep_weekly" ] && break
    done <<< "$stamps_all"
  fi

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
  echo "[fleet-backup] B2 prune OK: $app kept=${kept_count} deleted=${deleted_count} (daily=${keep_daily} weekly=${keep_weekly})"
  return 0
}

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
  if rclone copy "$dir" "b2:${B2_BUCKET[$app]}/hetzner/" --include "*${STAMP}*" --transfers 2 -q; then
    echo "[fleet-backup] B2 offsite OK: $app ($STAMP)"
    prune_b2_sets "$app" "${B2_BUCKET[$app]}" "$STAMP" || true
  else
    echo "[fleet-backup] B2 offsite FAIL: $app"
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
        echo "[fleet-backup] R2 weekly OK: $app"
        # Receipt so congress.trade /api/health can say R2 weekly is fine
        # without listing the bucket (no secrets on the health path).
        if [ "$app" = "congress" ]; then
          status_path="/data/congress-trade/.r2-archive-status.json"
          newest="$(ls -1t "$dir"/*"${STAMP}"*.db 2>/dev/null | head -1 || true)"
          key="weekly/$(basename "${newest:-congress-trade-${STAMP}.db}")"
          printf '{"ok":true,"key":"%s","completedAt":"%s"}\n' "$key" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$status_path"
          # R2 is weekly-archive-only.  One CT db is ~1.9 GB; extra copies
          # trip the 10 GB free tier.  Keep the newest weekly set only.
          keep="$(basename "${newest:-}")"
          stamp_keep="${keep#congress-trade-}"
          stamp_keep="${stamp_keep%.db}"
          rclone lsf "r2:${r2bucket}/weekly/" 2>/dev/null | while read -r name; do
            [ -n "$name" ] || continue
            case "$name" in
              *"${stamp_keep}"*) ;;
              *) rclone deletefile "r2:${r2bucket}/weekly/${name}" && echo "[fleet-backup] R2 weekly pruned: $name" || true ;;
            esac
          done
        fi
      else
        echo "[fleet-backup] R2 weekly FAIL: $app"
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
