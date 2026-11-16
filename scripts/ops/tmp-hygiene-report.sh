#!/usr/bin/env bash
# Read-only /tmp report. Prints filesystem bytes, inodes, a regular-file
# walk, and the immediate child directories with the most files.
# Does not create, delete, or follow symlinks. Pass a fixture directory
# as the first argument. The default root is /tmp.
set -euo pipefail

root="${1:-${TMP_HYGIENE_ROOT:-/tmp}}"
if [[ ! -d "$root" ]]; then
  echo "tmp-hygiene-report: not a directory: $root" >&2
  exit 2
fi

echo "root=$root"

if df_bytes="$(df -B1 -P "$root" 2>/dev/null)"; then
  echo "$df_bytes" | awk 'NR==2 { printf "filesystem_bytes_used=%s\nfilesystem_bytes_avail=%s\n", $3, $4 }'
else
  echo "filesystem_bytes_used=unavailable"
  echo "filesystem_bytes_avail=unavailable"
fi

if df_inodes="$(df -Pi "$root" 2>/dev/null)"; then
  echo "$df_inodes" | awk 'NR==2 { printf "filesystem_inodes_used=%s\nfilesystem_inodes_free=%s\n", $3, $4 }'
else
  echo "filesystem_inodes_used=unavailable"
  echo "filesystem_inodes_free=unavailable"
fi

# One pass for both totals. An unreadable subtree must not abort the report.
find() {
  command find "$@" 2>/dev/null || true
}

walk_stats="$(
  find -P "$root" -xdev -type f -printf '%s\n' |
    awk '{ count++; bytes += $1 } END { print count + 0, bytes + 0 }'
)"
read -r walk_files walk_bytes <<< "$walk_stats"
echo "walk_files=$walk_files"
echo "walk_bytes=$walk_bytes"

echo "top_directories"
find -P "$root" -xdev -mindepth 1 -maxdepth 1 -type d -print0 |
  while IFS= read -r -d '' dir; do
    count="$(find -P "$dir" -xdev -type f -printf '.' | wc -c | awk '{print $1}')"
    printf '%s\t%s\n' "$count" "${dir#"$root"/}"
  done | sort -nr -k1,1 | sed -n '1,10p'
