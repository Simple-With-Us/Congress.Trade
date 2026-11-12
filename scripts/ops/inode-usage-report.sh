#!/usr/bin/env bash
# inode-usage-report.sh — read-only inode pressure report for the Coolify/Hetzner host
#
# Reports df -i for real block filesystems (skips tmpfs/overlay/squashfs), and the
# top-N immediate child directories by file count under configurable scan roots.
# Exit: 0 ok, 1 warn, 2 crit (worst inode IUse% vs thresholds).
#
# Install (host as root):
#   install -m 0755 scripts/ops/inode-usage-report.sh /usr/local/bin/
#   install -m 0644 scripts/ops/systemd/fleet-inode-report.service /etc/systemd/system/
#   install -m 0644 scripts/ops/systemd/fleet-inode-report.timer /etc/systemd/system/
#   systemctl daemon-reload
#   systemctl enable --now fleet-inode-report.timer
#
# Optional /etc/fleet-inode-report.env:
#   INODE_WARN_PCT=80
#   INODE_CRIT_PCT=90
#   INODE_TOP_N=10
#   INODE_SCAN_ROOTS="/var/lib/docker /var/log /tmp /data /home"
#
# Test hooks (offline only):
#   INODE_REPORT_DF_FILE   — fixture df -iPT lines instead of live df
#   INODE_REPORT_DF_CMD    — alternate df command (must print df -iPT-compatible columns)

set -euo pipefail

JSON_MODE=0
if [[ "${1:-}" == "--json" ]]; then
  JSON_MODE=1
elif [[ -n "${1:-}" ]]; then
  echo "usage: $(basename "$0") [--json]" >&2
  exit 2
fi

LOG_TAG="${LOG_TAG:-fleet-inode-report}"
INODE_WARN_PCT="${INODE_WARN_PCT:-80}"
INODE_CRIT_PCT="${INODE_CRIT_PCT:-90}"
INODE_TOP_N="${INODE_TOP_N:-10}"
INODE_SCAN_ROOTS="${INODE_SCAN_ROOTS:-/var/lib/docker /var/log /tmp /data /home}"

if [[ -f /etc/fleet-inode-report.env ]]; then
  # shellcheck disable=SC1091
  set -a
  # shellcheck source=/dev/null
  source /etc/fleet-inode-report.env
  set +a
fi

log() {
  local msg="$*"
  if [[ "$JSON_MODE" -eq 0 ]]; then
    printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$msg"
  fi
  if command -v logger >/dev/null 2>&1; then
    logger -t "$LOG_TAG" -- "$msg" || true
  fi
}

# Types we never treat as durable inode pressure (ephemeral / container layers).
skip_fstype() {
  local t="${1,,}"
  case "$t" in
    tmpfs | overlay | overlayfs | squashfs) return 0 ;;
    *) return 1 ;;
  esac
}

read_df_raw() {
  if [[ -n "${INODE_REPORT_DF_FILE:-}" ]]; then
    cat "$INODE_REPORT_DF_FILE"
    return 0
  fi
  local cmd="${INODE_REPORT_DF_CMD:-df -iPT}"
  # shellcheck disable=SC2086
  $cmd 2>/dev/null || df -iPT 2>/dev/null || df -i -P 2>/dev/null
}

# Sets global arrays FS_ROWS_* via namerefs would need bash 4.3+; use parallel strings.
# We accumulate newline-delimited records: filesystem|type|inodes|iused|ifree|iuse_pct|mount
DF_RECORDS=()

parse_df_inode() {
  DF_RECORDS=()
  while IFS= read -r line; do
    [[ -z "$line" || "$line" == Filesystem* ]] && continue
    local filesystem fstype inodes iused ifree iuse_pct mounton
    if [[ "$line" =~ ^[^[:space:]]+[[:space:]]+(tmpfs|overlay|overlayfs|squashfs)[[:space:]] ]]; then
      continue
    fi
    if [[ "$line" =~ ^[^[:space:]]+[[:space:]]+[[:alnum:]_-]+[[:space:]]+[0-9]+[[:space:]]+[0-9]+[[:space:]]+[0-9]+[[:space:]]+[0-9]+%[[:space:]] ]]; then
      filesystem=$(awk '{print $1}' <<<"$line")
      fstype=$(awk '{print $2}' <<<"$line")
      inodes=$(awk '{print $3}' <<<"$line")
      iused=$(awk '{print $4}' <<<"$line")
      ifree=$(awk '{print $5}' <<<"$line")
      iuse_pct=$(awk '{print $6}' <<<"$line")
      mounton=$(awk '{for(i=7;i<=NF;i++) printf "%s%s", $i, (i<NF?" ":"")}' <<<"$line")
      if skip_fstype "$fstype"; then
        continue
      fi
    else
      # POSIX df -i -P without type column
      filesystem=$(awk '{print $1}' <<<"$line")
      inodes=$(awk '{print $2}' <<<"$line")
      iused=$(awk '{print $3}' <<<"$line")
      ifree=$(awk '{print $4}' <<<"$line")
      iuse_pct=$(awk '{print $5}' <<<"$line")
      mounton=$(awk '{for(i=6;i<=NF;i++) printf "%s%s", $i, (i<NF?" ":"")}' <<<"$line")
      fstype=""
      case "$filesystem" in
        tmpfs | overlay | squashfs) continue ;;
      esac
    fi
    [[ -z "$filesystem" || -z "$iuse_pct" ]] && continue
    iuse_pct="${iuse_pct%%%}"
    if ! [[ "$iuse_pct" =~ ^[0-9]+$ ]]; then
      continue
    fi
    DF_RECORDS+=("${filesystem}|${fstype}|${inodes}|${iused}|${ifree}|${iuse_pct}|${mounton}")
  done < <(read_df_raw)
}

classify_pct() {
  local pct="$1"
  if (( pct >= INODE_CRIT_PCT )); then
    echo crit
  elif (( pct >= INODE_WARN_PCT )); then
    echo warn
  else
    echo ok
  fi
}

worst_status() {
  local worst=0 rec IFS='|'
  local fs ty inodes iused ifree pct mnt st
  for rec in "${DF_RECORDS[@]}"; do
    IFS='|' read -r fs ty inodes iused ifree pct mnt <<<"$rec"
    st="$(classify_pct "$pct")"
    case "$st" in
      crit) worst=2 ;;
      warn) if (( worst < 1 )); then worst=1; fi ;;
    esac
  done
  echo "$worst"
}

count_files_under() {
  local dir="$1"
  if [[ -n "${INODE_COUNT_CMD:-}" ]]; then
    # shellcheck disable=SC2086
    INODE_COUNT_TARGET="$dir" $INODE_COUNT_CMD
    return
  fi
  # -xdev: stay on one filesystem; best-effort when unreadable.
  find "$dir" -xdev -type f 2>/dev/null | wc -l | tr -d ' '
}

collect_top_directories() {
  TOP_DIR_RECORDS=()
  local root sub path count
  for root in $INODE_SCAN_ROOTS; do
    [[ -d "$root" ]] || continue
    shopt -s nullglob
    for sub in "$root"/*; do
      [[ -d "$sub" ]] || continue
      count="$(count_files_under "$sub")"
      TOP_DIR_RECORDS+=("${count}|${sub}")
    done
    shopt -u nullglob
  done
  # Sort by count descending, take top N
  local sorted=()
  if ((${#TOP_DIR_RECORDS[@]} > 0)); then
    mapfile -t sorted < <(printf '%s\n' "${TOP_DIR_RECORDS[@]}" | sort -t'|' -k1,1nr)
  fi
  TOP_DIR_RECORDS=("${sorted[@]:0:INODE_TOP_N}")
}

emit_human() {
  local exit_code="$1"
  local st_label=ok
  (( exit_code == 1 )) && st_label=warn
  (( exit_code == 2 )) && st_label=crit
  log "inode report status=${st_label} warn_pct=${INODE_WARN_PCT} crit_pct=${INODE_CRIT_PCT}"
  printf '\nFilesystem inode usage (real block FS only):\n'
  printf '%-24s %-8s %10s %10s %10s %6s %s\n' Filesystem Type Inodes IUsed IFree IUse% Mount
  local rec IFS='|'
  local fs ty inodes iused ifree pct mnt row_st
  for rec in "${DF_RECORDS[@]}"; do
    IFS='|' read -r fs ty inodes iused ifree pct mnt <<<"$rec"
    row_st="$(classify_pct "$pct")"
    printf '%-24s %-8s %10s %10s %10s %5s%% %s  [%s]\n' \
      "$fs" "$ty" "$inodes" "$iused" "$ifree" "$pct" "$mnt" "$row_st"
  done
  printf '\nTop %s directories by file count (scan roots: %s):\n' "$INODE_TOP_N" "$INODE_SCAN_ROOTS"
  local count path
  for rec in "${TOP_DIR_RECORDS[@]}"; do
    IFS='|' read -r count path <<<"$rec"
    printf '%10s  %s\n' "$count" "$path"
  done
}

emit_json() {
  local exit_code="$1"
  local st_label=ok
  (( exit_code == 1 )) && st_label=warn
  (( exit_code == 2 )) && st_label=crit
  {
    printf 'EXIT_CODE=%s\n' "$exit_code"
    printf 'STATUS=%s\n' "$st_label"
    printf 'WARN_PCT=%s\n' "$INODE_WARN_PCT"
    printf 'CRIT_PCT=%s\n' "$INODE_CRIT_PCT"
    printf 'TOP_N=%s\n' "$INODE_TOP_N"
    printf 'SCAN_ROOTS=%s\n' "$INODE_SCAN_ROOTS"
    printf 'DF_BEGIN\n'
    printf '%s\n' "${DF_RECORDS[@]}"
    printf 'DF_END\n'
    printf 'TOP_BEGIN\n'
    printf '%s\n' "${TOP_DIR_RECORDS[@]}"
    printf 'TOP_END\n'
  } | python3 -c '
import json, sys

def load_block(lines, begin, end):
    try:
        i = lines.index(begin)
        j = lines.index(end)
    except ValueError:
        return []
    return [ln for ln in lines[i + 1 : j] if ln]

raw = sys.stdin.read().splitlines()
meta = {}
for ln in raw:
    if ln in ("DF_BEGIN", "DF_END", "TOP_BEGIN", "TOP_END"):
        break
    if "=" in ln:
        k, v = ln.split("=", 1)
        meta[k] = v

df_lines = load_block(raw, "DF_BEGIN", "DF_END")
top_lines = load_block(raw, "TOP_BEGIN", "TOP_END")

warn = int(meta.get("WARN_PCT", "80"))
crit = int(meta.get("CRIT_PCT", "90"))

filesystems = []
for rec in df_lines:
    parts = rec.split("|")
    if len(parts) < 7:
        continue
    pct = int(parts[5])
    if pct >= crit:
        st = "crit"
    elif pct >= warn:
        st = "warn"
    else:
        st = "ok"
    filesystems.append(
        {
            "filesystem": parts[0],
            "fstype": parts[1],
            "inodes": parts[2],
            "iused": parts[3],
            "ifree": parts[4],
            "iuse_pct": pct,
            "mount": parts[6],
            "status": st,
        }
    )

tops = []
for rec in top_lines:
    count, path = rec.split("|", 1)
    tops.append({"file_count": int(count), "path": path})

doc = {
    "status": meta.get("STATUS", "ok"),
    "exit_code": int(meta.get("EXIT_CODE", "0")),
    "thresholds": {"warn_pct": warn, "crit_pct": crit},
    "scan_roots": meta.get("SCAN_ROOTS", "").split(),
    "top_n": int(meta.get("TOP_N", "10")),
    "filesystems": filesystems,
    "top_directories": tops,
}
print(json.dumps(doc, indent=2, sort_keys=True))
'
}

TOP_DIR_RECORDS=()

main() {
  parse_df_inode
  if ((${#DF_RECORDS[@]} == 0)); then
    log "error: no inode filesystem rows after filter"
    exit 2
  fi
  collect_top_directories
  local exit_code
  exit_code="$(worst_status)"
  if [[ "$JSON_MODE" -eq 1 ]]; then
    emit_json "$exit_code"
  else
    emit_human "$exit_code"
  fi
  exit "$exit_code"
}

main
