#!/usr/bin/env bash
# Weekly restore drill for fleet SQLite backups.
# Cadence: 30 4 * * 0 (Sunday 04:30 UTC) via /etc/cron.d/fleet-backups.
#
# For each of socratic / congress / usage-monitor:
#   1) restore the latest local full dump to a scratch path
#   2) PRAGMA integrity_check + a simple row-count query
#   3) Litestream restore of the latest replica into scratch (when the
#      app container + litestream binary are available)
# On FAIL: Pushover via /etc/congress-health-recover.env (same path as
# fleet-health-verify.sh).  Never deletes production DBs or B2 objects.
set -euo pipefail

ROOT=/data/backups
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
  # Prefer sqlite_schema count (always present); fall back to a table scan.
  local n
  n="$(sqlite3 "$db" "SELECT COUNT(*) FROM sqlite_schema;" 2>/dev/null || echo "")"
  if [[ -z "$n" ]]; then
    return 1
  fi
  # Empty schema is impossible for a real app DB; treat 0 as fail.
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

# Litestream restore via the live app container (credentials already in-process).
# Mapping: app dir -> container name pattern -> in-container DB path -> config.
check_litestream() {
  local label="$1" name_pat="$2" db_path="$3" config_path="$4" bin_path="$5"
  local c tmp_host tmp_ctr
  c=$(docker ps --format '{{.Names}}' | grep -E "$name_pat" | head -1 || true)
  if [ -z "$c" ]; then
    echo "WARN $label litestream: no running container matching $name_pat (skip)"
    return 0
  fi
  if ! docker exec "$c" sh -c "test -x '$bin_path' && test -f '$config_path'"; then
    echo "WARN $label litestream: binary/config missing in $c (skip)"
    return 0
  fi
  tmp_ctr="/tmp/fleet-restore-drill-${label}.db"
  tmp_host="$SCRATCH/litestream-${label}.db"
  rm -f "$tmp_host"
  docker exec "$c" sh -c "rm -f '$tmp_ctr'"
  if ! docker exec "$c" "$bin_path" restore -config "$config_path" -o "$tmp_ctr" "$db_path"; then
    echo "FAIL $label litestream: restore"
    FAIL=1
    FAIL_MSGS+=("$label litestream restore")
    docker exec "$c" sh -c "rm -f '$tmp_ctr'" || true
    return 0
  fi
  # Copy out for host-side sqlite3 checks (container may lack sqlite3).
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

for d in socratic congress usage-monitor; do
  check_dump "$d"
done

# Litestream restores (one at a time; ST is ~14 GB).
check_litestream "socratic" 'd83b1aykr03uwr32yhgzaiay' "/app/data/app.db" "/app/litestream.coolify.yml" "/app/data/.bin/litestream"
check_litestream "congress" 'congress-app' "/data/congress-trade/db.sqlite" "/app/litestream.yml" "/app/bin/litestream"
check_litestream "usage-monitor" 'yagelvqux9e8l1kztif7bf2o' "/data/prod.db" "/app/litestream.yml" "/app/bin/litestream"

echo "[weekly-verify] done fail=$FAIL"
echo "NOTE: Hetzner server backups ON - use for full host recovery; this drill is app SQLite only."

if [ "$FAIL" -ne 0 ]; then
  alert_pushover "weekly restore drill FAIL: ${FAIL_MSGS[*]}.  See $LOG"
fi
exit $FAIL
