#!/usr/bin/env bash
# Offline tests for box-disk-hygiene host-health checks.
# No production host, no Docker daemon, no network.
#
#   bash scripts/ops/test-box-disk-hygiene.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="${ROOT_DIR}/scripts/ops/box-disk-hygiene.sh"
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

assert_file_has() {
  local path="$1" needle="$2" name="$3"
  if grep -F -q -- "$needle" "$path"; then
    echo "ok   ${name}"
  else
    echo "FAIL ${name}: missing '${needle}' in ${path}"
    fail=1
  fi
}

assert_file_lacks() {
  local path="$1" needle="$2" name="$3"
  if grep -F -q -- "$needle" "$path"; then
    echo "FAIL ${name}: unexpectedly found '${needle}' in ${path}"
    fail=1
  else
    echo "ok   ${name}"
  fi
}

TMP="$(mktemp -d "${TMPDIR:-/tmp}/box-disk-hygiene-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

unset PUSHOVER_APP_TOKEN PUSHOVER_USER_KEY PUSHOVER_USAGE_API_TOKEN || true
export HYGIENE_LIB_ONLY=1
export STATE_DIR="${TMP}/state"
export PAGE_SIZE=4096
export ALERT_REMINDER_SEC=14400
mkdir -p "$STATE_DIR"
# shellcheck disable=SC1090
source "$SCRIPT"

section() { printf '\n# %s\n' "$1"; }

section "threshold evaluation"
assert_eq "$(level_for 79 15)" ok "root 79% and 15G is ok"
assert_eq "$(level_for 80 20)" warn "root 80% is warn"
assert_eq "$(level_for 89 8)" warn "root free 8G is not crit"
assert_eq "$(level_for 10 14.9)" warn "root free below 15G is warn"
assert_eq "$(level_for 90 20)" crit "root 90% is crit"
assert_eq "$(level_for 10 7.9)" crit "root free below 8G is crit"

assert_eq "$(mount_level 10 4 16 tmpfs)" ok "16G tmpfs with 4G free is ok"
assert_eq "$(mount_level 80 3.2 16 tmpfs)" warn "tmpfs 80% is warn"
assert_eq "$(mount_level 10 3.1 16 tmpfs)" warn "tmpfs free below 3.2G is warn"
assert_eq "$(mount_level 90 2 16 tmpfs)" crit "tmpfs 90% is crit"
assert_eq "$(mount_level 10 1.5 16 tmpfs)" crit "tmpfs free below 1.6G is crit"
assert_eq "$(mount_level 25 1.5 2 tmpfs)" ok "tiny tmpfs uses percent only"
assert_eq "$(mount_level 82 20 100 extra)" warn "fleet-extra 82% uses root percent"
assert_eq "$(mount_level 10 7 200 extra)" crit "fleet-extra free below 8G is crit"

assert_eq "$(mem_level 15)" ok "available memory at 15% is ok"
assert_eq "$(mem_level 14.9)" warn "available memory below 15% is warn"
assert_eq "$(mem_level 5)" warn "available memory at 5% is warn, crit is below 5%"
assert_eq "$(mem_level 4.9)" crit "available memory below 5% is crit"
assert_eq "$(mem_level "")" unknown "missing memory is unknown"

assert_eq "$(swap_level 50 95 0 1)" ok "high swap percent with no swap-out is ok"
assert_eq "$(swap_level 50 0 256 1)" warn "swap-out at warn rate pages"
assert_eq "$(swap_level 50 0 255.9 1)" ok "swap-out under warn rate is ok"
assert_eq "$(swap_level 50 10 2048 1)" crit "swap-out at crit rate pages"
assert_eq "$(swap_level 4 10 256 1)" crit "active swap-out with critical memory is crit"
assert_eq "$(swap_level 50 90 0 0)" ok "swap without a baseline does not page"
assert_eq "$(swap_level 4 na 5000 1)" ok "no swap device is ok"

assert_eq "$(inode_level 79)" ok "inodes 79% is ok"
assert_eq "$(inode_level 80)" warn "inodes 80% is warn"
assert_eq "$(inode_level 90)" crit "inodes 90% is crit"

assert_eq "$(load_level 15.9 8)" ok "load5 under 2 per cpu is ok"
assert_eq "$(load_level 16 8)" warn "load5 at 2 per cpu is warn"
assert_eq "$(load_level 31.9 8)" warn "load5 under 4 per cpu stays warn"
assert_eq "$(load_level 32 8)" crit "load5 at 4 per cpu is crit"
assert_eq "$(load_level "" 8)" unknown "missing load is unknown"

assert_eq "$(growth_level_from_delta 25 3600 25 3600)" warn "root growth 25G inside 1h is warn"
assert_eq "$(growth_level_from_delta 25 3600 24.9 3600)" ok "root growth under 25G is ok"
assert_eq "$(growth_level_from_delta 25 3600 40 3601)" stale "root growth outside the window is stale"
assert_eq "$(growth_level_from_delta 4 1200 4 900)" warn "/tmp growth 4G inside the sample window is warn"

section "builder cache parse and prune gate"
cache_text=$'TYPE            TOTAL     ACTIVE    SIZE      RECLAIMABLE\nBuild Cache     13        0         1.628GB   1.628GB'
parse_builder_cache "$cache_text"
assert_eq "$BUILDER_CACHE_TOTAL" 13 "build cache total is the third field"
assert_eq "$BUILDER_CACHE_ACTIVE" 0 "build cache active is the fourth field"
assert_eq "$BUILDER_CACHE_SIZE" 1.628GB "build cache size is the fifth field"
if builder_prune_af_allowed; then
  echo "ok   builder prune -af allowed when ACTIVE=0"
else
  echo "FAIL builder prune -af should be allowed when ACTIVE=0"
  fail=1
fi
parse_builder_cache $'Build Cache     13        4         2GB       1GB'
assert_eq "$BUILDER_CACHE_ACTIVE" 4 "nonzero build cache active is parsed"
if builder_prune_af_allowed; then
  echo "FAIL builder prune -af should wait for ACTIVE=0"
  fail=1
else
  echo "ok   builder prune -af blocked when ACTIVE!=0"
fi
BUILDER_CACHE_ACTIVE=""
if builder_prune_af_allowed; then
  echo "FAIL builder prune -af should wait when ACTIVE is unknown"
  fail=1
else
  echo "ok   builder prune -af blocked when ACTIVE is unknown"
fi

section "alert dedupe"
rm -rf "$STATE_DIR"
mkdir -p "$STATE_DIR"
HYGIENE_NOW=1000
emit_alert "disk:/" warn "first warn"
HYGIENE_NOW=1060
emit_alert "disk:/" warn "same warn level does not re-page immediately"
assert_eq "$(wc -l < "$STATE_DIR/notifications.log" | tr -d ' ')" 1 "same warn level does not re-page immediately"
assert_eq "$(awk -F '\t' 'NR==1 {print $4}' "$STATE_DIR/notifications.log")" change "first warn is a level change"
HYGIENE_NOW=2000
emit_alert "disk:/" crit "escalated"
assert_eq "$(wc -l < "$STATE_DIR/notifications.log" | tr -d ' ')" 2 "warn to crit pages on the level change"
HYGIENE_NOW=2060
emit_alert "disk:/" crit "still crit"
assert_eq "$(wc -l < "$STATE_DIR/notifications.log" | tr -d ' ')" 2 "same crit level does not re-page immediately"
HYGIENE_NOW=$((2000 + ALERT_REMINDER_SEC))
emit_alert "disk:/" crit "reminder"
assert_eq "$(wc -l < "$STATE_DIR/notifications.log" | tr -d ' ')" 3 "held crit pages again after the reminder interval"
assert_eq "$(awk -F '\t' 'NR==3 {print $4}' "$STATE_DIR/notifications.log")" reminder "third page is the reminder"
HYGIENE_NOW=$((2000 + ALERT_REMINDER_SEC + 30))
emit_alert "disk:/" ok "recovered"
assert_eq "$(awk -F '\t' 'END {print $3" "$4}' "$STATE_DIR/notifications.log")" "ok recovery" "recovery pages once on the way back to ok"
HYGIENE_NOW=$((2000 + ALERT_REMINDER_SEC + 90))
emit_alert "disk:/" ok "still ok"
assert_eq "$(wc -l < "$STATE_DIR/notifications.log" | tr -d ' ')" 4 "quiet ok does not page again"
emit_alert "disk:/mnt/fleet-extra" unknown "not mounted"
assert_eq "$(wc -l < "$STATE_DIR/notifications.log" | tr -d ' ')" 4 "unknown mount does not page"
rm -rf "$STATE_DIR"
mkdir -p "$STATE_DIR"
HYGIENE_NOW=3000
emit_alert "disk:/tmp" crit "tmp crit"
HYGIENE_NOW=3060
emit_alert "disk:/tmp" unknown "tmp unmounted"
assert_eq "$(awk -F '\t' '$1=="disk:/tmp" {print $2; exit}' "$STATE_DIR/alert-state.tsv")" crit "unknown preserves prior crit level in state"
HYGIENE_NOW=3120
emit_alert "disk:/tmp" ok "tmp back"
assert_eq "$(wc -l < "$STATE_DIR/notifications.log" | tr -d ' ')" 2 "recovery still pages after unknown gap"
assert_eq "$(awk -F '\t' 'END {print $3" "$4}' "$STATE_DIR/notifications.log")" "ok recovery" "recovery after unknown is recovery"
rm -rf "$STATE_DIR"
mkdir -p "$STATE_DIR"
printf 'disk:/mnt/fleet-extra\tunknown\t2500\n' > "$STATE_DIR/alert-state.tsv"
HYGIENE_NOW=2600
emit_alert "disk:/mnt/fleet-extra" ok "legacy unknown cleared"
assert_eq "$(wc -l < "$STATE_DIR/notifications.log" | tr -d ' ')" 1 "legacy unknown then ok pages recovery"
assert_eq "$(awk -F '\t' 'END {print $4}' "$STATE_DIR/notifications.log")" legacy-recovery "legacy unknown recovery reason"

section "pushover token preference"
env_dir="${TMP}/env"
mkdir -p "$env_dir"
printf 'PUSHOVER_APP_TOKEN=app-from-box\nPUSHOVER_USER_KEY=user-from-box\n' > "$env_dir/box.env"
printf 'PUSHOVER_APP_TOKEN=app-from-recover\nPUSHOVER_USAGE_API_TOKEN=usage-from-recover\nPUSHOVER_USER_KEY=user-from-recover\n' > "$env_dir/recover.env"
unset PUSHOVER_APP_TOKEN PUSHOVER_USER_KEY PUSHOVER_USAGE_API_TOKEN
BOX_DISK_HYGIENE_ENV="$env_dir/box.env" CONGRESS_HEALTH_RECOVER_ENV="$env_dir/recover.env" load_host_env
assert_eq "$PUSHOVER_APP_TOKEN" usage-from-recover "usage token wins over both app tokens"
assert_eq "$PUSHOVER_USER_KEY" user-from-recover "later env file supplies the user key"
unset PUSHOVER_APP_TOKEN PUSHOVER_USER_KEY PUSHOVER_USAGE_API_TOKEN
printf 'PUSHOVER_APP_TOKEN=only-app\nPUSHOVER_USER_KEY=only-user\n' > "$env_dir/box.env"
printf '\n' > "$env_dir/recover.env"
BOX_DISK_HYGIENE_ENV="$env_dir/box.env" CONGRESS_HEALTH_RECOVER_ENV="$env_dir/recover.env" load_host_env
assert_eq "$PUSHOVER_APP_TOKEN" only-app "app token is used when usage token is absent"
unset PUSHOVER_APP_TOKEN PUSHOVER_USER_KEY PUSHOVER_USAGE_API_TOKEN
unset BOX_DISK_HYGIENE_ENV CONGRESS_HEALTH_RECOVER_ENV

section "env file does not replace process secrets"
printf 'PUSHOVER_APP_TOKEN=file-app\nPUSHOVER_USER_KEY=file-user\nPUSHOVER_USAGE_API_TOKEN=file-usage\nALERT_WEBHOOK_URL=https://file.example/hook\nWARN_USED_PCT=77\n' > "$env_dir/box.env"
printf 'PUSHOVER_APP_TOKEN=recover-app\nALERT_WEBHOOK_URL=https://recover.example/hook\n' > "$env_dir/recover.env"
PUSHOVER_APP_TOKEN=process-app
PUSHOVER_USER_KEY=process-user
PUSHOVER_USAGE_API_TOKEN=process-usage
ALERT_WEBHOOK_URL=https://process.example/hook
WARN_USED_PCT=80
BOX_DISK_HYGIENE_ENV="$env_dir/box.env" CONGRESS_HEALTH_RECOVER_ENV="$env_dir/recover.env" load_host_env
assert_eq "$PUSHOVER_APP_TOKEN" process-app "process app token is not replaced by an env file"
assert_eq "$PUSHOVER_USER_KEY" process-user "process user key is not replaced by an env file"
assert_eq "$PUSHOVER_USAGE_API_TOKEN" process-usage "process usage token is not replaced by an env file"
assert_eq "$ALERT_WEBHOOK_URL" "https://process.example/hook" "process webhook url is not replaced by an env file"
assert_eq "$WARN_USED_PCT" 77 "non-secret env file settings still apply"
unset PUSHOVER_APP_TOKEN PUSHOVER_USER_KEY PUSHOVER_USAGE_API_TOKEN ALERT_WEBHOOK_URL
WARN_USED_PCT=80
BOX_DISK_HYGIENE_ENV="$env_dir/box.env" CONGRESS_HEALTH_RECOVER_ENV="$env_dir/recover.env" load_host_env
assert_eq "$PUSHOVER_APP_TOKEN" file-usage "empty process token is filled from the env file"
assert_eq "$PUSHOVER_USER_KEY" file-user "empty process user key is filled from the env file"
assert_eq "$ALERT_WEBHOOK_URL" "https://recover.example/hook" "empty process webhook url is filled from the env file"
unset PUSHOVER_APP_TOKEN PUSHOVER_USER_KEY PUSHOVER_USAGE_API_TOKEN ALERT_WEBHOOK_URL
unset BOX_DISK_HYGIENE_ENV CONGRESS_HEALTH_RECOVER_ENV
WARN_USED_PCT=80

section "webhook url and pushover tokens stay out of curl argv"
CURL_STUB="${TMP}/curlbin"
mkdir -p "$CURL_STUB"
export CURL_LOG="${TMP}/curl-argv.log"
cat > "$CURL_STUB/curl" <<'EOF'
#!/bin/bash
{
  printf 'ARGV'
  printf ' %q' "$@"
  printf '\nSTDIN\n'
  cat
  printf '\nEND\n'
} >> "${CURL_LOG:?}"
exit 0
EOF
chmod 0755 "$CURL_STUB/curl"
: > "$CURL_LOG"
saved_path="$PATH"
PATH="${CURL_STUB}:${PATH}"
ALERT_WEBHOOK_URL='https://alerts.example/hook?token=webhook-secret-ZZZ'
alert_webhook "disk critical"
PATH="$saved_path"
argv_line=$(head -n 1 "$CURL_LOG")
case "$argv_line" in
  ARGV*)
    case "$argv_line" in
      *webhook-secret-ZZZ*)
        echo "FAIL webhook url appeared in curl argv: ${argv_line}"
        fail=1
        ;;
      *)
        echo "ok   webhook url is absent from curl argv"
        ;;
    esac
    ;;
  *)
    echo "FAIL curl argv was not recorded: ${argv_line}"
    fail=1
    ;;
esac
if awk 'f && index($0, "webhook-secret-ZZZ"){found=1} /^STDIN$/{f=1} END{exit !found}' "$CURL_LOG"; then
  echo "ok   webhook url is passed on the curl config stream"
else
  echo "FAIL webhook url missing from curl config stream"
  fail=1
fi
: > "$CURL_LOG"
PATH="${CURL_STUB}:${PATH}"
PUSHOVER_APP_TOKEN=pushover-token-QQQ
PUSHOVER_USER_KEY=pushover-user-RRR
alert_pushover crit "host disk"
PATH="$saved_path"
argv_line=$(head -n 1 "$CURL_LOG")
case "$argv_line" in
  ARGV*)
    case "$argv_line" in
      *pushover-token-QQQ*|*pushover-user-RRR*)
        echo "FAIL pushover token appeared in curl argv: ${argv_line}"
        fail=1
        ;;
      *)
        echo "ok   pushover token and user key are absent from curl argv"
        ;;
    esac
    ;;
  *)
    echo "FAIL curl argv was not recorded: ${argv_line}"
    fail=1
    ;;
esac
if awk 'f && index($0, "pushover-token-QQQ"){t=1} f && index($0, "pushover-user-RRR"){u=1} /^STDIN$/{f=1} END{exit !(t && u)}' "$CURL_LOG"; then
  echo "ok   pushover token and user key are passed on the curl config stream"
else
  echo "FAIL pushover token missing from curl config stream"
  fail=1
fi
unset PUSHOVER_APP_TOKEN PUSHOVER_USER_KEY PUSHOVER_USAGE_API_TOKEN ALERT_WEBHOOK_URL

section "metric collection from fixtures"
FIX="${TMP}/fixture"
mkdir -p "$FIX"
python3 - "$FIX" <<'PY'
import sys
from pathlib import Path
fix = Path(sys.argv[1])
def kb(gb):
    return int(round(gb * 1024 * 1024))
def df_line(fs, total_gb, used_pct, free_gb, mount):
    return f"{fs} {kb(total_gb)} {kb(total_gb - free_gb)} {kb(free_gb)} {used_pct}% {mount}"
df = [
    "Filesystem 1024-blocks Used Available Capacity Mounted on",
    df_line("/dev/sda1", 150, 82, 20, "/"),
    df_line("tmpfs", 16, 85, 2.4, "/tmp"),
    df_line("tmpfs", 16, 10, 14, "/dev/shm"),
]
inode = [
    "Filesystem Inodes IUsed IFree IUse% Mounted on",
    "/dev/sda1 10000000 8000000 2000000 80% /",
    "tmpfs 4000000 40000 3960000 1% /tmp",
    "tmpfs 4000000 3600000 400000 90% /dev/shm",
]
(fix / "df-P.txt").write_text("\n".join(df) + "\n")
(fix / "df-i.txt").write_text("\n".join(inode) + "\n")
(fix / "meminfo").write_text(
    "MemTotal:       16384000 kB\n"
    "MemAvailable:    1638400 kB\n"
    "SwapTotal:       4096000 kB\n"
    "SwapFree:        204800 kB\n"
)
(fix / "vmstat").write_text("pswpout 7500\n")
(fix / "loadavg").write_text("3.00 16.00 4.00 2/200 99\n")
(fix / "nproc").write_text("8\n")
(fix / "mounts").write_text(
    "/dev/sda1 / ext4 rw 0 0\n"
    "tmpfs /tmp tmpfs rw 0 0\n"
    "tmpfs /dev/shm tmpfs rw 0 0\n"
)
(fix / "docker-df.txt").write_text(
    "TYPE            TOTAL     ACTIVE    SIZE      RECLAIMABLE\n"
    "Images          5         2         16.43GB   14.67GB (89%)\n"
    "Build Cache     13        0         1.628GB   1.628GB\n"
)
PY
rm -rf "$STATE_DIR"
mkdir -p "$STATE_DIR"
# 100s before now, zero pages swapped out, so 7500 pages * 4KiB / 100s = 300 KB/s.
printf '9900 0\n' > "$STATE_DIR/pswpout.prev"
# Root used about 130G now; 30G above the sample from 10 minutes ago,
# still inside the one-hour window.
printf '9400 100.0\n' > "$STATE_DIR/growth.root"
HYGIENE_NOW=10000
HYGIENE_FIXTURE_DIR="$FIX"
collect_host_metrics
assert_eq "$M_ROOT_LEVEL" warn "fixture root 82% is warn"
assert_eq "$M_ROOT_FREE_GB" 20.0 "fixture root free GB is parsed"
assert_eq "$M_TMP_LEVEL" warn "fixture /tmp 85% and low free is warn"
assert_eq "$M_SHM_LEVEL" ok "fixture /dev/shm 10% is ok"
assert_eq "$M_SHM_INODE_LEVEL" crit "fixture shm inodes 90% is crit"
assert_eq "$M_ROOT_INODE_LEVEL" warn "fixture root inodes 80% is warn"
assert_eq "$M_EXTRA_LEVEL" unknown "unmounted /mnt/fleet-extra is unknown"
assert_eq "$M_EXTRA_MOUNTED" 0 "unmounted /mnt/fleet-extra is not mounted"
assert_eq "$MEM_AVAIL_PCT" 10.0 "meminfo available percent is collected"
assert_eq "$M_MEM_LEVEL" warn "10% available memory is warn"
assert_eq "$SWAP_USED_PCT" 95.0 "swap used percent is collected"
assert_eq "$SWAP_OUT_KBPS" 300.0 "swap-out KB/s is collected from vmstat delta"
assert_eq "$M_SWAP_LEVEL" warn "collected swap-out above the warn rate pages"
assert_eq "$LOAD5" 16.00 "load5 is collected"
assert_eq "$NCPU" 8 "ncpu is collected"
assert_eq "$M_LOAD_LEVEL" warn "load5 of 16 on 8 cpus is warn"
assert_eq "$M_GROWTH_ROOT_LEVEL" warn "root growth inside the hour is warn"
assert_eq "$BUILDER_CACHE_ACTIVE" "" "collect does not parse docker df by itself"
parse_builder_cache "$DOCKER_DF_TEXT"
assert_eq "$BUILDER_CACHE_ACTIVE" 0 "fixture docker df active is 0"

# High swap percent and a zero delta must stay ok even though swap is full.
printf '9000 7500\n' > "$STATE_DIR/pswpout.prev"
HYGIENE_NOW=10000
collect_host_metrics
assert_eq "$SWAP_OUT_KBPS" 0.0 "second sample with no new pages is 0 KB/s"
assert_eq "$M_SWAP_LEVEL" ok "full swap with zero swap-out stays ok"

section "growth over the trailing window"
GROWTH_STATE="${TMP}/growth-state"
mkdir -p "$GROWTH_STATE"
SAVED_STATE="$STATE_DIR"
STATE_DIR="$GROWTH_STATE"
HYGIENE_NOW=10000
rm -f "$STATE_DIR/growth.root"
update_growth "/" 10 "$ROOT_GROWTH_GB" "$ROOT_GROWTH_WINDOW_SEC"
assert_eq "$GROWTH_ACTION" skip "first growth sample is a baseline"
printf '9000 20\n' > "$STATE_DIR/growth.root"
update_growth "/" 26 "$ROOT_GROWTH_GB" "$ROOT_GROWTH_WINDOW_SEC"
assert_eq "$GROWTH_LEVEL" ok "6G since the previous tick is not a 25G hour"
printf '7000 10\n8500 16\n' > "$STATE_DIR/growth.root"
update_growth "/" 36 "$ROOT_GROWTH_GB" "$ROOT_GROWTH_WINDOW_SEC"
assert_eq "$GROWTH_LEVEL" warn "25G inside the trailing hour pages"
assert_eq "$GROWTH_DELTA" 26.000 "growth delta uses the oldest in-window sample"
HYGIENE_NOW=20000
printf '10000 10\n' > "$STATE_DIR/growth.root"
update_growth "/" 40 "$ROOT_GROWTH_GB" "$ROOT_GROWTH_WINDOW_SEC"
assert_eq "$GROWTH_ACTION" emit "a sample older than the window still resolves"
assert_eq "$GROWTH_LEVEL" ok "growth older than the window does not page"
STATE_DIR="$SAVED_STATE"

section "prune paths and dry run"
STUB="${TMP}/bin"
mkdir -p "$STUB"
DOCKER_LOG="${TMP}/docker.log"
cat > "$STUB/docker" <<'EOF'
#!/bin/bash
printf '%s\n' "$*" >> "${DOCKER_LOG:?}"
if [[ "${HYGIENE_REWRITE_AFTER_PRUNE:-0}" == "1" && "$*" == *prune* ]]; then
  mark="${HYGIENE_AFTER_DIR:-}/.rewritten"
  if [[ -n "${HYGIENE_AFTER_DIR:-}" && -f "${HYGIENE_AFTER_DIR}/df-P.txt" && ! -f "$mark" ]]; then
    cp "${HYGIENE_AFTER_DIR}/df-P.txt" "${HYGIENE_FIXTURE_DIR}/df-P.txt"
    cp "${HYGIENE_AFTER_DIR}/df-i.txt" "${HYGIENE_FIXTURE_DIR}/df-i.txt"
    cp "${HYGIENE_AFTER_DIR}/docker-df.txt" "${HYGIENE_FIXTURE_DIR}/docker-df.txt"
    : > "$mark"
  fi
fi
if [[ "$1" == "system" && "$2" == "df" ]]; then
  if [[ -n "${DOCKER_DF_FILE:-}" && -f "$DOCKER_DF_FILE" ]]; then
    cat "$DOCKER_DF_FILE"
  fi
fi
exit 0
EOF
chmod 0755 "$STUB/docker"
cp "$CURL_STUB/curl" "$STUB/curl"
CURL_LOG="${TMP}/curl-from-main.log"
: > "$CURL_LOG"

write_levels() {
  local root_pct="$1" root_free="$2" cache_active="$3" mem_avail_kb="$4"
  python3 - "$FIX" "$root_pct" "$root_free" "$cache_active" "$mem_avail_kb" <<'PY'
import sys
from pathlib import Path
fix, root_pct, root_free, cache_active, mem_avail = sys.argv[1:]
root_pct = int(root_pct)
root_free = float(root_free)
cache_active = int(cache_active)
mem_avail = int(mem_avail)
def kb(gb):
    return int(round(gb * 1024 * 1024))
def df_line(fs, total_gb, used_pct, free_gb, mount):
    return f"{fs} {kb(total_gb)} {kb(max(total_gb - free_gb, 0))} {kb(free_gb)} {used_pct}% {mount}"
df = [
    "Filesystem 1024-blocks Used Available Capacity Mounted on",
    df_line("/dev/sda1", 150, root_pct, root_free, "/"),
    df_line("tmpfs", 16, 10, 14, "/tmp"),
    df_line("tmpfs", 16, 10, 14, "/dev/shm"),
    df_line("/dev/sdb1", 400, 10, 360, "/mnt/fleet-extra"),
]
inode = [
    "Filesystem Inodes IUsed IFree IUse% Mounted on",
    "/dev/sda1 10000000 500000 9500000 5% /",
    "tmpfs 4000000 40000 3960000 1% /tmp",
    "tmpfs 4000000 40000 3960000 1% /dev/shm",
    "/dev/sdb1 10000000 500000 9500000 5% /mnt/fleet-extra",
]
Path(fix, "df-P.txt").write_text("\n".join(df) + "\n")
Path(fix, "df-i.txt").write_text("\n".join(inode) + "\n")
Path(fix, "meminfo").write_text(
    "MemTotal:       16384000 kB\n"
    f"MemAvailable:    {mem_avail} kB\n"
    "SwapTotal:       4096000 kB\n"
    "SwapFree:        4096000 kB\n"
)
Path(fix, "vmstat").write_text("pswpout 0\n")
Path(fix, "loadavg").write_text("0.20 0.40 0.30 1/100 10\n")
Path(fix, "nproc").write_text("8\n")
Path(fix, "mounts").write_text(
    "/dev/sda1 / ext4 rw 0 0\n"
    "tmpfs /tmp tmpfs rw 0 0\n"
    "tmpfs /dev/shm tmpfs rw 0 0\n"
    "/dev/sdb1 /mnt/fleet-extra ext4 rw 0 0\n"
)
Path(fix, "docker-df.txt").write_text(
    "TYPE            TOTAL     ACTIVE    SIZE      RECLAIMABLE\n"
    "Images          5         1         10GB      2GB (20%)\n"
    f"Build Cache     13        {cache_active}         1.628GB   1.628GB\n"
)
PY
}

run_main() {
  : > "$DOCKER_LOG"
  : > "$CURL_LOG"
  mkdir -p "$TMP/backups" "$TMP/scratch" "$TMP/ct"
  env -u HYGIENE_LIB_ONLY \
    -u PUSHOVER_APP_TOKEN -u PUSHOVER_USER_KEY -u PUSHOVER_USAGE_API_TOKEN -u ALERT_WEBHOOK_URL \
    HYGIENE_FIXTURE_DIR="$FIX" \
    STATE_DIR="$STATE_DIR" \
    HYGIENE_NOW="${HYGIENE_NOW}" \
    HYGIENE_DEPLOY_ACTIVE="${HYGIENE_DEPLOY_ACTIVE:-0}" \
    HYGIENE_FAIL_DF_AFTER_PRUNE="${HYGIENE_FAIL_DF_AFTER_PRUNE:-0}" \
    HYGIENE_REWRITE_AFTER_PRUNE="${HYGIENE_REWRITE_AFTER_PRUNE:-0}" \
    HYGIENE_AFTER_DIR="${HYGIENE_AFTER_DIR:-}" \
    PAGE_SIZE=4096 \
    PATH="${STUB}:${PATH}" \
    DOCKER_LOG="$DOCKER_LOG" \
    CURL_LOG="$CURL_LOG" \
    DOCKER_DF_FILE="$FIX/docker-df.txt" \
    DRY_RUN="${DRY_RUN:-0}" \
    PRUNE_VOLUMES="${PRUNE_VOLUMES:-0}" \
    ALERT_REMINDER_SEC="${ALERT_REMINDER_SEC}" \
    AGGRESSIVE_COOLDOWN_SEC="${AGGRESSIVE_COOLDOWN_SEC:-1800}" \
    BACKUP_DATA_DIR="$TMP/backups" \
    SCRATCH_DATA_DIR="$TMP/scratch" \
    CT_DATA_DIR="$TMP/ct" \
    BOX_DISK_HYGIENE_ENV="$TMP/no-box-disk-hygiene.env" \
    CONGRESS_HEALTH_RECOVER_ENV="$TMP/no-congress-health-recover.env" \
    ROOT_PATH=/var/tmp \
    bash "$SCRIPT"
}

notify_count() {
  if [[ -f "$STATE_DIR/notifications.log" ]]; then
    wc -l < "$STATE_DIR/notifications.log" | tr -d ' '
  else
    echo 0
  fi
}

rm -rf "$STATE_DIR"
mkdir -p "$STATE_DIR"
HYGIENE_NOW=50000
HYGIENE_DEPLOY_ACTIVE=0
DRY_RUN=0
PRUNE_VOLUMES=0
write_levels 40 90 0 8192000
run_main > "${TMP}/light.out"
assert_file_has "$DOCKER_LOG" "image prune -f" "ok path prunes dangling images"
assert_file_has "${TMP}/light.out" "start path=/" "start log measures /"
assert_file_lacks "${TMP}/light.out" "root=/var/tmp" "ROOT_PATH override is not advertised"
assert_file_has "${TMP}/light.out" "backups: dir=${TMP}/backups" "prune backup dir stays under the temp dir"
assert_file_has "$DOCKER_LOG" "builder prune -f --filter until=12h" "ok path prunes old builder cache"
assert_file_lacks "$DOCKER_LOG" "builder prune -af" "ok path does not run builder prune -af"
assert_file_lacks "$DOCKER_LOG" "volume prune" "ok path does not prune volumes"
assert_file_lacks "$DOCKER_LOG" "--volumes" "ok path does not pass --volumes"
assert_eq "$(notify_count)" 0 "healthy host does not page"

rm -rf "$STATE_DIR"
mkdir -p "$STATE_DIR"
HYGIENE_NOW=60000
write_levels 85 12 0 8192000
mkdir -p "$TMP/backups" "$TMP/scratch/olddir" "$TMP/ct"
touch -d '30 days ago' "$TMP/backups/old.db"
touch -d '20 days ago' "$TMP/scratch/olddir"
export ALERT_WEBHOOK_URL='https://alerts.example/hook?token=webhook-secret-LEAK'
export PUSHOVER_APP_TOKEN=pushover-token-LEAK
export PUSHOVER_USER_KEY=pushover-user-LEAK
run_main > "${TMP}/warn.out"
unset ALERT_WEBHOOK_URL PUSHOVER_APP_TOKEN PUSHOVER_USER_KEY
if [[ -f "$TMP/backups/old.db" ]]; then
  echo "FAIL old backup under the temp dir was not pruned"
  fail=1
else
  echo "ok   old backup prune target is the temp dir"
fi
if [[ -d "$TMP/scratch/olddir" ]]; then
  echo "FAIL old scratch under the temp dir was not pruned"
  fail=1
else
  echo "ok   old scratch prune target is the temp dir"
fi
assert_file_lacks "${TMP}/warn.out" "/data/backups" "warn path does not touch /data/backups"
assert_file_lacks "${TMP}/warn.out" "/data/scratch" "warn path does not touch /data/scratch"
assert_file_lacks "$CURL_LOG" "webhook-secret-LEAK" "run_main does not send the parent webhook"
assert_file_lacks "$CURL_LOG" "pushover-token-LEAK" "run_main does not send the parent pushover token"
assert_file_has "$DOCKER_LOG" "builder prune -af" "warn path runs builder prune -af when cache is idle"
assert_file_has "$DOCKER_LOG" "image prune -af" "warn path prunes unused images"
assert_file_lacks "$DOCKER_LOG" "system prune -af" "warn path does not system-prune"
assert_file_lacks "$DOCKER_LOG" "volume prune" "warn path does not prune volumes"
assert_file_has "${TMP}/warn.out" "level=warn" "warn path logs warn"
first_warn_pages="$(notify_count)"
assert_eq "$first_warn_pages" 1 "first root warn pages once"
# Same warn on the next tick must not page again (backup swing above 80%).
HYGIENE_NOW=60900
run_main > "${TMP}/warn2.out"
assert_eq "$(notify_count)" 1 "same warn level does not re-page immediately"

rm -rf "$STATE_DIR"
mkdir -p "$STATE_DIR"
HYGIENE_NOW=70000
write_levels 85 12 3 8192000
run_main > "${TMP}/active.out"
assert_file_lacks "$DOCKER_LOG" "builder prune -af" "active build cache skips builder prune -af"
assert_file_has "$DOCKER_LOG" "image prune -af" "active build cache still allows image prune"
assert_file_has "${TMP}/active.out" "Build Cache ACTIVE=3" "active cache skip is logged"

rm -rf "$STATE_DIR"
mkdir -p "$STATE_DIR"
HYGIENE_NOW=80000
write_levels 95 5 0 8192000
run_main > "${TMP}/crit.out"
assert_file_has "$DOCKER_LOG" "builder prune -af" "crit path runs builder prune -af"
assert_file_has "$DOCKER_LOG" "image prune -af" "crit path prunes unused images"
assert_file_has "$DOCKER_LOG" "container prune -f" "crit path prunes stopped containers"
assert_file_has "$DOCKER_LOG" "system prune -af" "crit path runs system prune -af"
assert_file_lacks "$DOCKER_LOG" "--volumes" "crit path never passes --volumes"
assert_file_lacks "$DOCKER_LOG" "volume prune" "crit path never prunes volumes"
assert_file_has "${TMP}/crit.out" "STILL critical" "crit after a no-op reclaim says so"
assert_file_has "${TMP}/crit.out" "phase=live level=crit" "pre-prune root level is emitted"
assert_eq "$(notify_count)" 1 "same crit level is not double-paged in one run"
assert_file_has "$STATE_DIR/last-status" "level_before=crit" "status keeps the pre-prune level"
assert_file_has "$STATE_DIR/last-status" "level_after=crit" "status keeps the post-prune level"

rm -rf "$STATE_DIR"
mkdir -p "$STATE_DIR"
HYGIENE_NOW=80500
HYGIENE_FAIL_DF_AFTER_PRUNE=1
write_levels 95 5 0 8192000
run_main > "${TMP}/df-fail.out"
assert_file_has "${TMP}/df-fail.out" "disk-after: re-read failed" "post-prune df failure is logged"
assert_file_has "${TMP}/df-fail.out" "STILL critical" "post-prune df failure still pages STILL critical"
assert_file_has "$STATE_DIR/last-status" "level_after=crit" "post-prune df failure still writes status"
unset HYGIENE_FAIL_DF_AFTER_PRUNE

rm -rf "$STATE_DIR"
mkdir -p "$STATE_DIR"
HYGIENE_NOW=81000
PRUNE_VOLUMES=1
write_levels 95 5 0 8192000
run_main > "${TMP}/novol.out"
assert_file_has "${TMP}/novol.out" "volume prune refused" "PRUNE_VOLUMES=1 is refused"
assert_file_lacks "$DOCKER_LOG" "volume prune" "PRUNE_VOLUMES=1 still does not prune volumes"
assert_file_lacks "$DOCKER_LOG" "--volumes" "PRUNE_VOLUMES=1 still does not pass --volumes"
PRUNE_VOLUMES=0

rm -rf "$STATE_DIR"
mkdir -p "$STATE_DIR"
HYGIENE_NOW=82000
DRY_RUN=1
write_levels 85 12 0 8192000
run_main > "${TMP}/dry.out"
assert_file_has "${TMP}/dry.out" "dry-run: docker builder prune -af" "dry run logs soft builder prune"
assert_file_has "${TMP}/dry.out" "dry-run: docker image prune -af" "dry run logs image prune"
if [[ -s "$DOCKER_LOG" ]]; then
  echo "FAIL dry run invoked docker: $(cat "$DOCKER_LOG")"
  fail=1
else
  echo "ok   dry run does not invoke docker"
fi
DRY_RUN=0

rm -rf "$STATE_DIR"
mkdir -p "$STATE_DIR"
HYGIENE_NOW=83000
HYGIENE_DEPLOY_ACTIVE=1
write_levels 95 5 0 8192000
run_main > "${TMP}/deploy.out"
assert_file_has "${TMP}/deploy.out" "prune: skipped (Coolify build/deploy active)" "deploy skip is logged"
if grep -E -q 'prune' "$DOCKER_LOG"; then
  echo "FAIL deploy-active run pruned: $(cat "$DOCKER_LOG")"
  fail=1
else
  echo "ok   deploy-active run does not prune"
fi
assert_file_has "$STATE_DIR/notifications.log" $'disk:/\tcrit' "crit still pages while a deploy is active"
HYGIENE_DEPLOY_ACTIVE=0

# Memory pressure must not escalate the docker prune path.
rm -rf "$STATE_DIR"
mkdir -p "$STATE_DIR"
HYGIENE_NOW=84000
write_levels 40 90 4 655360
run_main > "${TMP}/mem.out"
assert_file_has "$DOCKER_LOG" "builder prune -f --filter until=12h" "low memory keeps the light prune path"
assert_file_lacks "$DOCKER_LOG" "builder prune -af" "low memory does not builder-prune -af"
assert_file_has "$STATE_DIR/notifications.log" $'mem\tcrit' "critical available memory pages"
assert_file_has "$STATE_DIR/last-status" "mem=crit" "status records memory level"
assert_file_has "$STATE_DIR/last-status" "extra=ok" "mounted fleet-extra is recorded"

# Cooldown falls back to the light prune on warn.
rm -rf "$STATE_DIR"
mkdir -p "$STATE_DIR"
HYGIENE_NOW=90000
printf '%s\n' "$HYGIENE_NOW" > "$STATE_DIR/last_aggressive"
write_levels 85 12 0 8192000
run_main > "${TMP}/cool.out"
assert_file_has "${TMP}/cool.out" "soft prune: skipped (cooldown" "warn cooldown is logged"
assert_file_has "$DOCKER_LOG" "builder prune -f --filter until=12h" "warn cooldown uses the light prune"
assert_file_lacks "$DOCKER_LOG" "builder prune -af" "warn cooldown does not run builder prune -af"

section "missing root df still emits other alerts"
rm -rf "$STATE_DIR"
mkdir -p "$STATE_DIR"
HYGIENE_NOW=91000
write_levels 95 5 0 655360
grep -v ' /$' "$FIX/df-P.txt" > "$FIX/df-P.txt.noroot"
mv "$FIX/df-P.txt.noroot" "$FIX/df-P.txt"
grep -v ' /$' "$FIX/df-i.txt" > "$FIX/df-i.txt.noroot"
mv "$FIX/df-i.txt.noroot" "$FIX/df-i.txt"
run_main > "${TMP}/noroot.out"
assert_file_has "${TMP}/noroot.out" "mount /: missing from df level=unknown" "missing root df is recorded unknown"
assert_file_has "${TMP}/noroot.out" "prune: skipped (root level unknown)" "missing root df skips prune"
assert_file_lacks "$DOCKER_LOG" "prune" "missing root df does not prune"
assert_file_has "$STATE_DIR/notifications.log" $'mem\tcrit' "missing root df still pages memory"
assert_file_has "$STATE_DIR/last-status" "mem=crit" "missing root df still writes status"

section "no metrics fails the run"
rm -rf "$STATE_DIR"
mkdir -p "$STATE_DIR"
HYGIENE_NOW=92000
printf '%s\n' 'Filesystem 1024-blocks Used Available Capacity Mounted on' > "$FIX/df-P.txt"
printf '%s\n' 'Filesystem Inodes IUsed IFree IUse% Mounted on' > "$FIX/df-i.txt"
: > "$FIX/meminfo"
: > "$FIX/vmstat"
: > "$FIX/loadavg"
: > "$FIX/nproc"
: > "$FIX/mounts"
: > "$FIX/docker-df.txt"
none_rc=0
run_main > "${TMP}/nometrics.out" || none_rc=$?
assert_eq "$none_rc" 1 "a run with no metrics fails"
assert_file_has "${TMP}/nometrics.out" "error: no host metrics collected" "empty collection is logged"
assert_eq "$(notify_count)" 0 "a run with no metrics does not page"

section "pre-prune page and fresh post-prune metrics"
rm -rf "$STATE_DIR"
mkdir -p "$STATE_DIR" "$TMP/afterfix"
HYGIENE_NOW=93000
write_levels 40 90 0 8192000
python3 - "$FIX/docker-df.txt" <<'PY'
from pathlib import Path
import sys
Path(sys.argv[1]).write_text(
    "TYPE            TOTAL     ACTIVE    SIZE      RECLAIMABLE\n"
    "Images          5         1         10GB      2GB (20%)\n"
    "Build Cache     2         0         0.050GB   0.050GB\n"
)
PY
cp "$FIX/df-P.txt" "$FIX/df-i.txt" "$FIX/docker-df.txt" "$TMP/afterfix/"
write_levels 95 5 0 8192000
HYGIENE_REWRITE_AFTER_PRUNE=1
HYGIENE_AFTER_DIR="$TMP/afterfix"
run_main > "${TMP}/fresh.out"
unset HYGIENE_REWRITE_AFTER_PRUNE HYGIENE_AFTER_DIR
assert_file_has "${TMP}/fresh.out" "phase=live level=crit" "pre-prune crit is emitted"
assert_file_has "${TMP}/fresh.out" "disk-after: used=40% free=90.0G level=ok" "post-prune df is re-read"
assert_file_has "${TMP}/fresh.out" "builder-cache: total=2 active=0 size=0.050GB" "post-prune builder cache is re-read"
assert_file_has "${TMP}/fresh.out" "phase=after level=ok" "post-prune recovery is emitted"
assert_eq "$(awk -F '\t' '$2=="disk:/" && $3=="crit"' "$STATE_DIR/notifications.log" | wc -l | tr -d ' ')" 1 "pre-prune crit pages once"
assert_eq "$(awk -F '\t' '$2=="disk:/" && $3=="ok"' "$STATE_DIR/notifications.log" | wc -l | tr -d ' ')" 1 "post-prune recovery pages once"
if awk '/size=1\.628GB/{pre=NR} /size=0\.050GB/{post=NR} END{exit !(pre && post && post>pre)}' "${TMP}/fresh.out"; then
  echo "ok   fresh builder-cache size is logged after the pre-prune size"
else
  echo "FAIL fresh builder-cache size was not logged after the pre-prune size"
  fail=1
fi

if grep -E -n 'docker volume prune|system prune --volumes|prune --volumes' "$SCRIPT"; then
  echo "FAIL script still contains a volume prune command"
  fail=1
else
  echo "ok   script has no volume prune command"
fi

section "timer cadence"
timer="${ROOT_DIR}/scripts/ops/systemd.noindex/box-disk-hygiene.timer"
assert_file_has "$timer" "OnUnitActiveSec=15min" "timer stays on a 15 minute cadence"
timer_files=$(find "${ROOT_DIR}/scripts/ops/systemd.noindex" -name 'box-disk-hygiene.timer' | wc -l | tr -d ' ')
assert_eq "$timer_files" 1 "there is still one box-disk-hygiene timer"

if [[ "$fail" -ne 0 ]]; then
  echo "FAILED"
  exit 1
fi
echo "OK"
