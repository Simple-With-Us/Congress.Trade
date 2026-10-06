#!/usr/bin/env bash
# Weekly restore drill for fleet SQLite backups.
# Cadence: 30 4 * * 0 (Sunday 04:30 UTC) via /etc/cron.d/fleet-backups.
#
# Jay 2026-10-05 correction: Usage-Monitor ONLY by default
# (FLEET_BACKUP_VERIFY_APPS=usage-monitor).  ST/CT stay on the previous
# dump cadence and are not part of this weekly Litestream restore drill
# until Jay decides separately.
#
# For each selected app:
#   1) restore the latest local full dump to a scratch path
#   2) PRAGMA integrity_check + a simple row-count query
#   3) Litestream restore of the latest replica into scratch (when the
#      app container + litestream binary are available)
# On FAIL: Pushover via /etc/congress-health-recover.env (same path as
# fleet-health-verify.sh).  Never deletes production DBs or B2 objects.
set -euo pipefail

ROOT=/data/backups
# Comma-separated: socratic, congress, usage-monitor.  Default = UM only.
FLEET_BACKUP_VERIFY_APPS="${FLEET_BACKUP_VERIFY_APPS:-usage-monitor}"
SCRATCH="${FLEET_RESTORE_SCRATCH:-/data/scratch/fleet-restore-drill}"
LOG=/var/log/fleet-backup/weekly-verify-$(date -u +%Y%m%d).log
mkdir -p /var/log/fleet-backup "$SCRATCH"
exec > >(tee -a "$LOG") 2>&1
echo "[weekly-verify] start $(date -u -Iseconds)"

if [[ -f /etc/congress-health-recover.env ]]; then
  set -a
  # shellcheck disable=SC1091
  source /etc/congress-health-recover.env
  set +a
fi

FAIL=0
FAIL_MSGS=()

alert_pushover() {
  local msg="$1"
  if [[ -z "${PUSHOVER_APP_TOKEN:-}" || -z "${PUSHOVER_USER_KEY:-}" ]]; then
    echo "[weekly-verify] WARN pushover not configured; failure logged only"
    return 0
  fi
  curl -sS -m 15 -o /dev/null \
    --form-string "token=${PUSHOVER_APP_TOKEN}" \
    --form-string "user=${PUSHOVER_USER_KEY}" \
    --form-string "title=fleet-backup-verify-weekly FAIL" \
    --form-string "message=${msg}" \
    --form-string "priority=1" \
    https://api.pushover.net/1/messages.json >/dev/null 2>&1 \
    || echo "[weekly-verify] WARN pushover notify failed"
}

row_count_ok() {
  local db="$1"
  local n
  n="$(sqlite3 "$db" "SELECT COUNT(*) FROM sqlite_schema;" 2>/dev/null || echo "")"
  if [[ -z "$n" ]]; then
    return 1
  fi
  [[ "$n" -gt 0 ]]
}

check_dump() {
  local d="$1"
  local latest tmp
  latest=$(ls -1t "$ROOT/$d"/*.db 2>/dev/null | head -1 || true)
  if [ -z "$latest" ]; then
    echo "FAIL $d dump: no backup"
    FAIL=1
    FAIL_MSGS+=("$d dump missing")
    return 0
  fi
  tmp="$SCRATCH/dump-$(basename "$latest")"
  rm -f "$tmp"
  cp -a "$latest" "$tmp"
  if ! sqlite3 "$tmp" "PRAGMA integrity_check;" | head -1 | grep -qx ok; then
    echo "FAIL $d dump: integrity"
    FAIL=1
    FAIL_MSGS+=("$d dump integrity")
    rm -f "$tmp"
    return 0
  fi
  if ! row_count_ok "$tmp"; then
    echo "FAIL $d dump: row-count"
    FAIL=1
    FAIL_MSGS+=("$d dump row-count")
    rm -f "$tmp"
    return 0
  fi
  echo "OK  $d dump integrity+rows ($(du -h "$tmp" | awk '{print $1}')) from $(basename "$latest")"
  if [ -f "${latest}.sha256" ]; then
    if (cd "$(dirname "$latest")" && sha256sum -c "$(basename "$latest").sha256" >/dev/null); then
      echo "OK  $d dump sha256"
    else
      echo "FAIL $d dump sha256"
      FAIL=1
      FAIL_MSGS+=("$d dump sha256")
    fi
  fi
  rm -f "$tmp"
}

# Find the host PID of the litestream replicate process whose cmdline
# mentions the given config basename and whose root is this container.
find_litestream_host_pid() {
  local c="$1" needle="$2"
  local cid hp cmd
  cid="$(docker inspect -f '{{.Id}}' "$c" 2>/dev/null || true)"
  [ -n "$cid" ] || return 1
  for hp in $(pgrep -f "litestream replicate" || true); do
    cmd="$(tr '\0' ' ' < "/proc/$hp/cmdline" 2>/dev/null || true)"
    printf '%s' "$cmd" | grep -qF "$needle" || continue
    if grep -q "$cid" "/proc/$hp/cgroup" 2>/dev/null; then
      echo "$hp"
      return 0
    fi
    if docker top "$c" -eo pid,cmd 2>/dev/null | awk '{print $1}' | grep -qx "$hp"; then
      echo "$hp"
      return 0
    fi
  done
  # Last resort on this single-host fleet: unique needle alone.
  for hp in $(pgrep -f "litestream replicate" || true); do
    cmd="$(tr '\0' ' ' < "/proc/$hp/cmdline" 2>/dev/null || true)"
    printf '%s' "$cmd" | grep -qF "$needle" || continue
    echo "$hp"
    return 0
  done
  return 1
}

# Write a 0600 env-file with only the S3/Litestream keys the restore needs.
# Values come from the live litestream process environ (Infisical-injected).
# File is deleted by the caller; never logged.
write_litestream_envfile() {
  local hp="$1" dest="$2"
  python3 - "$hp" "$dest" <<'PY'
import sys
hp, dest = sys.argv[1], sys.argv[2]
want_exact = {
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_REGION",
}
want_prefixes = (
  "LITESTREAM_S3_",
  "AWS_S3_",
)
keys = {}
with open(f"/proc/{hp}/environ", "rb") as f:
  for item in f.read().split(b"\0"):
    if not item or b"=" not in item:
      continue
    k, v = item.split(b"=", 1)
    ks = k.decode("utf-8", "replace")
    if ks in want_exact or any(ks.startswith(p) for p in want_prefixes):
      keys[ks] = v.decode("utf-8", "replace")
if not keys:
  raise SystemExit("no litestream/AWS S3 env keys on process")
with open(dest, "w") as out:
  for k, v in keys.items():
    if "\n" in v or "\r" in v:
      continue
    out.write(f"{k}={v}\n")
import os
os.chmod(dest, 0o600)
print(f"[weekly-verify] litestream env keys={sorted(keys.keys())}")
PY
}

# Litestream restore via the live app container.
# Credentials are NOT in a bare docker exec shell; they live on the
# litestream replicate process.  We copy only the S3 key names into a
# temporary --env-file (0600, deleted in the same tick).
check_litestream() {
  local label="$1" name_pat="$2" db_path="$3" config_path="$4" bin_path="$5" cmdline_needle="$6"
  local c tmp_host tmp_ctr hp envfile config_base
  c=$(docker ps --format '{{.Names}}' | grep -E "$name_pat" | head -1 || true)
  if [ -z "$c" ]; then
    echo "WARN $label litestream: no running container matching $name_pat (skip)"
    return 0
  fi
  if ! docker exec "$c" sh -c "test -x '$bin_path' && test -f '$config_path'"; then
    echo "WARN $label litestream: binary/config missing in $c (skip)"
    return 0
  fi
  config_base="$(basename "$config_path")"
  hp="$(find_litestream_host_pid "$c" "$cmdline_needle" || true)"
  if [ -z "$hp" ]; then
    echo "FAIL $label litestream: cannot find replicate PID for env"
    FAIL=1
    FAIL_MSGS+=("$label litestream env")
    return 0
  fi
  envfile="$(mktemp /tmp/fleet-ls-restore.XXXXXX.env)"
  chmod 600 "$envfile"
  if ! write_litestream_envfile "$hp" "$envfile"; then
    echo "FAIL $label litestream: env extract"
    FAIL=1
    FAIL_MSGS+=("$label litestream env")
    rm -f "$envfile"
    return 0
  fi
  tmp_ctr="/tmp/fleet-restore-drill-${label}.db"
  tmp_host="$SCRATCH/litestream-${label}.db"
  rm -f "$tmp_host"
  docker exec "$c" sh -c "rm -f '$tmp_ctr'"
  if ! docker exec --env-file "$envfile" "$c" "$bin_path" restore -config "$config_path" -o "$tmp_ctr" "$db_path"; then
    echo "FAIL $label litestream: restore"
    FAIL=1
    FAIL_MSGS+=("$label litestream restore")
    rm -f "$envfile"
    docker exec "$c" sh -c "rm -f '$tmp_ctr'" || true
    return 0
  fi
  rm -f "$envfile"
  if ! docker cp "$c:$tmp_ctr" "$tmp_host"; then
    echo "FAIL $label litestream: docker cp"
    FAIL=1
    FAIL_MSGS+=("$label litestream docker-cp")
    docker exec "$c" sh -c "rm -f '$tmp_ctr'" || true
    return 0
  fi
  docker exec "$c" sh -c "rm -f '$tmp_ctr'" || true
  if ! sqlite3 "$tmp_host" "PRAGMA integrity_check;" | head -1 | grep -qx ok; then
    echo "FAIL $label litestream: integrity"
    FAIL=1
    FAIL_MSGS+=("$label litestream integrity")
    rm -f "$tmp_host"
    return 0
  fi
  if ! row_count_ok "$tmp_host"; then
    echo "FAIL $label litestream: row-count"
    FAIL=1
    FAIL_MSGS+=("$label litestream row-count")
    rm -f "$tmp_host"
    return 0
  fi
  echo "OK  $label litestream restore integrity+rows ($(du -h "$tmp_host" | awk '{print $1}'))"
  rm -f "$tmp_host"
}

verify_app_enabled() {
  local want="$1" raw token
  raw="$(printf '%s' "$FLEET_BACKUP_VERIFY_APPS" | tr '[:upper:]' '[:lower:]' | tr ',' ' ')"
  for token in $raw; do
    [ "$token" = "$want" ] && return 0
  done
  return 1
}

echo "[weekly-verify] apps=$FLEET_BACKUP_VERIFY_APPS"

for d in socratic congress usage-monitor; do
  if verify_app_enabled "$d"; then
    check_dump "$d"
  else
    echo "SKIP $d dump (not in FLEET_BACKUP_VERIFY_APPS)"
  fi
done

# Litestream restores (one at a time).  ST is ~14 GB -- only when selected.
if verify_app_enabled socratic; then
  check_litestream "socratic" 'd83b1aykr03uwr32yhgzaiay' "/app/data/app.db" "/app/litestream.coolify.yml" "/app/data/.bin/litestream" "litestream.coolify.yml"
else
  echo "SKIP socratic litestream (not in FLEET_BACKUP_VERIFY_APPS)"
fi
if verify_app_enabled congress; then
  check_litestream "congress" 'congress-app' "/data/congress-trade/db.sqlite" "/app/litestream.yml" "/app/bin/litestream" "unstable-cron"
else
  echo "SKIP congress litestream (not in FLEET_BACKUP_VERIFY_APPS)"
fi
if verify_app_enabled usage-monitor; then
  check_litestream "usage-monitor" 'yagelvqux9e8l1kztif7bf2o' "/data/prod.db" "/app/litestream.yml" "/app/bin/litestream" "run-app-with-replica-heartbeat"
else
  echo "SKIP usage-monitor litestream (not in FLEET_BACKUP_VERIFY_APPS)"
fi

echo "[weekly-verify] done fail=$FAIL"
echo "NOTE: Hetzner server backups ON - use for full host recovery; this drill is app SQLite only."

if [ "$FAIL" -ne 0 ]; then
  alert_pushover "weekly restore drill FAIL: ${FAIL_MSGS[*]}.  See $LOG"
fi
exit $FAIL
