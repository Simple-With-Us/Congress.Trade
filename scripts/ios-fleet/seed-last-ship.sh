#!/usr/bin/env bash
# seed-last-ship.sh — write last-ship-<app>.txt on an empty hosted runner.
#
# Usage:
#   seed-last-ship.sh --workflow <file.yml> --app <key> [--require-upload]
#                     [--ship-step <name>] [--min-run-seconds N]
#                     [--min-step-seconds N] [--repo owner/name]
#                     [--state-dir PATH]
#
# Without --require-upload, the newest successful run is the seed. That is
# the GM workflow: a skip fails the job, so success means an upload.
#
# With --require-upload, a successful run counts only when --ship-step
# succeeded and lasted at least --min-step-seconds. ios-ship's scheduled
# skips are successful workflow runs. Seeding one of those would write a
# recent timestamp for a sha that was not uploaded, and the ship script's
# 1 hour rate gate would then skip every push. Short runs are ignored from
# the runs list (under --min-run-seconds) so a month of cron skips does not
# become a jobs request per tick.
#
# Exit 0 when nothing is seeded. The scheduled gate then skips, and a push
# with no state file still ships. This script never calls the ship wrapper
# and never passes --force-ship.
#
# ASCII-only (Apple bash 3.2 safe).

set +o xtrace
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MJS="${SCRIPT_DIR}/seed-last-ship.mjs"
WORKFLOW=""
APP=""
REQUIRE_UPLOAD=0
SHIP_STEP=""
MIN_RUN_SECONDS=180
MIN_STEP_SECONDS=60
REPO="${GITHUB_REPOSITORY:-}"
STATE_DIR="${IOS_FLEET_STATE_DIR:-${HOME}/.cache/ios-fleet}"
GH_BIN="${SEED_LAST_SHIP_GH:-gh}"
MAX_PAGES=50

die() { echo "seed-last-ship: $*" >&2; exit 2; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --workflow) WORKFLOW="${2:-}"; shift 2 ;;
    --app) APP="${2:-}"; shift 2 ;;
    --require-upload) REQUIRE_UPLOAD=1; shift ;;
    --ship-step) SHIP_STEP="${2:-}"; shift 2 ;;
    --min-run-seconds) MIN_RUN_SECONDS="${2:-}"; shift 2 ;;
    --min-step-seconds) MIN_STEP_SECONDS="${2:-}"; shift 2 ;;
    --repo) REPO="${2:-}"; shift 2 ;;
    --state-dir) STATE_DIR="${2:-}"; shift 2 ;;
    -h|--help)
      sed -n '2,${/^[^#]/q;p;}' "$0" | sed 's/^# \{0,1\}//'
      exit 2
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ "$WORKFLOW" =~ ^[A-Za-z0-9._-]+\.ya?ml$ ]] || die "--workflow must be a workflow file name"
[[ "$APP" =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "--app must be an app key"
[[ "$MIN_RUN_SECONDS" =~ ^[0-9]+$ ]] || die "--min-run-seconds must be a number"
[[ "$MIN_STEP_SECONDS" =~ ^[0-9]+$ ]] || die "--min-step-seconds must be a number"
if [[ "$REQUIRE_UPLOAD" -eq 1 && -z "$SHIP_STEP" ]]; then
  die "--require-upload needs --ship-step"
fi

LOOKUP_FAILED=0

warn_skip() {
  echo "::warning::$*"
  echo "$*"
  exit 0
}

# One line of gh or node stderr, with credential-shaped text removed.
note_lookup_failure() {
  local err_file="$1"
  local summary
  LOOKUP_FAILED=1
  summary="$(sed -n '1p' "$err_file" 2>/dev/null | tr -d '\r')"
  summary="${summary:0:180}"
  if [[ "$summary" == *ghp_* || "$summary" == *gho_* || "$summary" == *github_pat_* ]]; then
    summary="lookup failed; the error text looked like a credential and was not printed"
  fi
  if [[ -z "$summary" ]]; then
    summary="lookup exited non-zero with no message"
  fi
  echo "::warning::${summary}"
  echo "seed-last-ship: ${summary}"
}

# gh_out <dest> <gh args...>
# Success leaves stdout in dest. Failure warns, empties dest, and returns 1.
gh_out() {
  local dest="$1"
  shift
  local err
  err="$(mktemp "${TMPDIR:-/tmp}/seed-last-ship-err.XXXXXX")"
  if "$GH_BIN" "$@" >"$dest" 2>"$err"; then
    rm -f "$err"
    return 0
  fi
  note_lookup_failure "$err"
  rm -f "$err"
  : >"$dest"
  return 1
}

# node_out <dest> <mjs args...> with JSON on stdin.
node_out() {
  local dest="$1"
  shift
  local err
  err="$(mktemp "${TMPDIR:-/tmp}/seed-last-ship-err.XXXXXX")"
  if node "$MJS" "$@" >"$dest" 2>"$err"; then
    rm -f "$err"
    return 0
  fi
  note_lookup_failure "$err"
  rm -f "$err"
  : >"$dest"
  return 1
}

finish_without_seed() {
  if [[ "$LOOKUP_FAILED" -eq 1 ]]; then
    echo "Could not read previous runs; not seeding."
  else
    echo "$1"
  fi
  exit 0
}

write_line() {
  local line="$1"
  local sha="${line##* }"
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR" 2>/dev/null || true
  printf '%s\n' "$line" >"${STATE_DIR}/last-ship-${APP}.txt"
  chmod 600 "${STATE_DIR}/last-ship-${APP}.txt" 2>/dev/null || true
  echo "Seeded last ship: ${sha:0:10}"
}

if ! command -v "$GH_BIN" >/dev/null 2>&1; then
  warn_skip "gh is not installed; not seeding last-ship state."
fi
if ! command -v node >/dev/null 2>&1; then
  warn_skip "node is not installed; not seeding last-ship state."
fi
if [[ -z "$REPO" ]]; then
  warn_skip "GITHUB_REPOSITORY is unset; not seeding last-ship state."
fi
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || warn_skip "repository name is not owner/name; not seeding."

if [[ "$REQUIRE_UPLOAD" -eq 0 ]]; then
  list_file="$(mktemp "${TMPDIR:-/tmp}/seed-last-ship.XXXXXX")"
  if ! gh_out "$list_file" run list --repo "$REPO" --workflow "$WORKFLOW" --status success --limit 1 --json headSha,updatedAt; then
    rm -f "$list_file"
    finish_without_seed "No previous successful run; the ship gate treats this as a first ship."
  fi
  json="$(cat "$list_file")"
  rm -f "$list_file"
  if [[ -z "$json" || "$json" == "[]" ]]; then
    finish_without_seed "No previous successful run; the ship gate treats this as a first ship."
  fi
  line_file="$(mktemp "${TMPDIR:-/tmp}/seed-last-ship.XXXXXX")"
  if ! node_out "$line_file" from-run-list <<<"$json"; then
    rm -f "$line_file"
    finish_without_seed "No previous successful run; the ship gate treats this as a first ship."
  fi
  line="$(cat "$line_file")"
  rm -f "$line_file"
  if [[ ! "$line" =~ ^[0-9]+\ [0-9a-f]{40}$ ]]; then
    echo "::warning::Previous run sha is not a full sha; not seeding."
    exit 0
  fi
  write_line "$line"
  exit 0
fi

page=1
page_file="$(mktemp "${TMPDIR:-/tmp}/seed-last-ship.XXXXXX")"
jobs_file="$(mktemp "${TMPDIR:-/tmp}/seed-last-ship.XXXXXX")"
parse_file="$(mktemp "${TMPDIR:-/tmp}/seed-last-ship.XXXXXX")"
while [[ "$page" -le "$MAX_PAGES" ]]; do
  if ! gh_out "$page_file" api "/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?status=success&per_page=100&page=${page}"; then
    rm -f "$page_file" "$jobs_file" "$parse_file"
    finish_without_seed "No previous successful upload; not seeding."
  fi
  body="$(cat "$page_file")"
  if [[ -z "$body" ]]; then
    rm -f "$page_file" "$jobs_file" "$parse_file"
    finish_without_seed "No previous successful upload; not seeding."
  fi
  if ! node_out "$parse_file" page-count <<<"$body"; then
    rm -f "$page_file" "$jobs_file" "$parse_file"
    finish_without_seed "No previous successful upload; not seeding."
  fi
  count="$(cat "$parse_file")"
  if ! node_out "$parse_file" long-runs --min-seconds "$MIN_RUN_SECONDS" <<<"$body"; then
    rm -f "$page_file" "$jobs_file" "$parse_file"
    finish_without_seed "No previous successful upload; not seeding."
  fi
  rows="$(cat "$parse_file")"
  if [[ -n "$rows" ]]; then
    while IFS="$(printf '\t')" read -r id updated sha; do
      [[ -n "${id:-}" ]] || continue
      [[ "$id" =~ ^[0-9]+$ ]] || continue
      [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || continue
      [[ "$updated" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.Z+-]+$ ]] || continue
      if ! gh_out "$jobs_file" api "/repos/${REPO}/actions/runs/${id}/jobs?per_page=100"; then
        continue
      fi
      jobs="$(cat "$jobs_file")"
      if [[ -z "$jobs" ]]; then
        LOOKUP_FAILED=1
        echo "::warning::Jobs lookup for run ${id} returned an empty body."
        continue
      fi
      if ! node_out "$parse_file" step-uploaded --step "$SHIP_STEP" --min-seconds "$MIN_STEP_SECONDS" <<<"$jobs"; then
        continue
      fi
      answer="$(cat "$parse_file")"
      if [[ "$answer" != "yes" ]]; then
        continue
      fi
      if ! node_out "$parse_file" state-line --updated-at "$updated" --sha "$sha"; then
        continue
      fi
      line="$(cat "$parse_file")"
      if [[ "$line" =~ ^[0-9]+\ [0-9a-f]{40}$ ]]; then
        rm -f "$page_file" "$jobs_file" "$parse_file"
        write_line "$line"
        exit 0
      fi
    done <<EOF
$rows
EOF
  fi
  if [[ ! "$count" =~ ^[0-9]+$ || "$count" -lt 100 ]]; then
    break
  fi
  page=$((page + 1))
done

rm -f "$page_file" "$jobs_file" "$parse_file"
finish_without_seed "No previous successful upload; not seeding."
