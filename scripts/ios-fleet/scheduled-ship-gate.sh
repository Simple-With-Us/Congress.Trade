#!/usr/bin/env bash
# scheduled-ship-gate.sh - Decide whether a SCHEDULED ios-ship run should ship.
#
# Why this exists
# ---------------
# .github/workflows/ios-ship.yml gained a `schedule:` trigger because a PR
# merged by github-actions[bot] lands on main under GitHub's recursion guard
# and dispatches no workflow run at all -- so `push:` alone could not be
# trusted to notice that iOS code had landed. Measured on this repo: sha
# c38b6787 (PR #1835, bot-merged, touches clients/ios) produced ZERO runs,
# while sha ceaca097 (PR #1836, human-merged) produced five.
#
# But a cron carries no `paths:` filter, and ship-testflight.sh's own gate only
# tests "is HEAD the sha I last shipped" plus a time interval. Without this
# script, a backend-only commit sitting past the rate-limit window would ship a
# TestFlight build for changes no tester can see. The owner does not want
# TestFlight spammed, so the scheduled path ships only when one of the
# workflow's push paths actually changed since its last successful ship.
#
# Usage:
#   scheduled-ship-gate.sh --path-prefix <pattern> [--path-prefix <pattern>...] [options] <app_key> [app_key...]
#
# Options:
#   --path-prefix P   Repo-relative path pattern that counts as ship input
#                     (required, repeatable; pass every entry from the
#                     workflow's on.push.paths list so a missed push still
#                     ships. Accepts a dir prefix like clients/ios/, a glob
#                     like clients/ios/**, an exact file, or a !exclusion
#                     the same way push does. A single use keeps the old
#                     behaviour.)
#   --event NAME      GitHub event name (default: $GITHUB_EVENT_NAME).
#                     Anything other than "schedule" votes ship=1 for every
#                     app: a push already passed the workflow's paths filter,
#                     and a manual dispatch is an explicit instruction.
#   --repo-root PATH  Repo to inspect (default: cwd)
#   --state-dir PATH  Where ship-testflight.sh records successful ships
#                     (default: $IOS_FLEET_STATE_DIR, else ~/.cache/ios-fleet)
#
# Output:
#   Human-readable reasoning on stdout, plus, when $GITHUB_OUTPUT is set:
#     should_ship=0|1        1 if ANY listed app should ship
#     ship_<app_key>=0|1     per app, with '-' in the key replaced by '_'
#
# Exit code is always 0 on a decision. Deciding "skip" is a normal outcome and
# must never turn a scheduled tick red.
#
# ASCII-only (Apple bash 3.2 safe), matches ship-testflight.sh conventions.

set -uo pipefail

PATH_PREFIXES=()
EVENT="${GITHUB_EVENT_NAME:-}"
REPO_ROOT=""
STATE_DIR="${IOS_FLEET_STATE_DIR:-${HOME}/.cache/ios-fleet}"
APPS=""

die() { echo "error: $*" >&2; exit 2; }
log() { echo "[ship-gate] $*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --path-prefix)
      [[ -n "${2:-}" ]] || die "--path-prefix requires a value"
      PATH_PREFIXES[${#PATH_PREFIXES[@]}]="$2"
      shift 2
      ;;
    --event) EVENT="${2:-}"; shift 2 ;;
    --repo-root) REPO_ROOT="${2:-}"; shift 2 ;;
    --state-dir) STATE_DIR="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,${/^[^#]/q;p;}' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
    -*) die "unknown option: $1" ;;
    *) APPS="${APPS} $1"; shift ;;
  esac
done

[[ "${#PATH_PREFIXES[@]}" -gt 0 ]] || die "--path-prefix is required"
[[ -n "${APPS// /}" ]] || die "at least one app key is required"

if [[ -z "$REPO_ROOT" ]]; then REPO_ROOT="$(pwd)"; fi
REPO_ROOT="$(cd "$REPO_ROOT" && pwd)" || die "bad --repo-root"

# Every --path-prefix becomes one git pathspec, so the gate matches the same
# set the workflow's on.push.paths list matched. Globs and dir prefixes pass
# through (git wildmatch is close to GitHub's), and a leading ! becomes git's
# :! exclusion.
PATTERNS_LOG=""
GIT_SPECS=()
for _pat in "${PATH_PREFIXES[@]}"; do
  if [[ -z "$PATTERNS_LOG" ]]; then PATTERNS_LOG="$_pat"; else PATTERNS_LOG="${PATTERNS_LOG}, $_pat"; fi
  case "$_pat" in '!'*)
    _inner="${_pat#!}"
    [[ -n "$_inner" ]] || die "invalid --path-prefix '!': exclusion needs a path"
    GIT_SPECS[${#GIT_SPECS[@]}]=":!${_inner}"
    ;;
  *)
    GIT_SPECS[${#GIT_SPECS[@]}]="$_pat"
    ;;
  esac
done

emit() {
  # emit <key> <value>
  echo "$1=$2"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf '%s=%s\n' "$1" "$2" >>"$GITHUB_OUTPUT"
  fi
}

out_key() {
  # App keys carry '-' (usage-local); GitHub step outputs read better with '_'.
  printf 'ship_%s' "$(printf '%s' "$1" | tr '-' '_')"
}

if [[ "$EVENT" != "schedule" ]]; then
  log "event='${EVENT}': not the scheduled backstop, so intent is already explicit."
  for app in $APPS; do emit "$(out_key "$app")" 1; done
  emit should_ship 1
  exit 0
fi

HEAD_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)"
if [[ -z "$HEAD_SHA" ]]; then
  # No git, no ability to reason about what changed. Do NOT ship on a guess.
  log "cannot resolve HEAD in ${REPO_ROOT}; scheduled tick skips."
  for app in $APPS; do emit "$(out_key "$app")" 0; done
  emit should_ship 0
  exit 0
fi

SHOULD_ANY=0
for app in $APPS; do
  state="${STATE_DIR}/last-ship-${app}.txt"
  decision=0

  if [[ ! -f "$state" ]]; then
    # Hosted runners start with an empty home.  Treating that as "never
    # shipped" re-archives every cron tick.  A first ship is a push that
    # already passed paths: or an explicit workflow_dispatch.
    log "[${app}] no prior ship recorded (${state}); scheduled tick skips."
    decision=0
  else
    # Format written by record_successful_ship(): "<unix_ts> <git_sha>"
    last_sha="$(awk 'NR==1{print $2}' "$state" 2>/dev/null || true)"
    if [[ -z "${last_sha:-}" || "$last_sha" == "unknown" ]]; then
      log "[${app}] ship state carries no sha; letting ship-testflight.sh decide."
      decision=1
    elif [[ "$last_sha" == "$HEAD_SHA" ]]; then
      log "[${app}] HEAD ${HEAD_SHA} already shipped; skip."
    elif ! git -C "$REPO_ROOT" merge-base --is-ancestor "$last_sha" HEAD 2>/dev/null; then
      git -C "$REPO_ROOT" fetch --deepen=200 --quiet 2>/dev/null || true
      if git -C "$REPO_ROOT" merge-base --is-ancestor "$last_sha" HEAD 2>/dev/null; then
        log "[${app}] deepened the clone to reach ${last_sha}."
        decision=-1
      else
        # Real and observed, not hypothetical: on 2026-08-13 Usage-Monitor's
        # recorded ship sha was 27b89434, the tip of a grok/* ship worktree --
        # not an ancestor of main at all. Skipping forever on that would be a
        # backstop that never backstops; shipping blind would be TestFlight
        # spam. So fall back to the TIMESTAMP the same state file records and
        # ask a question that needs no sha: has any commit touching this app
        # landed since the last successful ship?
        log "[${app}] last shipped sha ${last_sha} is unreachable from HEAD (shipped from another worktree/branch, or history was rewritten)."
        last_ts="$(awk 'NR==1{print $1}' "$state" 2>/dev/null || true)"
        if [[ "${last_ts:-}" =~ ^[0-9]+$ ]]; then
          since_changed="$(git -C "$REPO_ROOT" log --since="@${last_ts}" --format= --name-only -- "${GIT_SPECS[@]}" 2>/dev/null | sed '/^$/d' | sort -u | head -20)"
          if [[ -n "$since_changed" ]]; then
            log "[${app}] falling back to time: ${PATTERNS_LOG} changed after the last ship:"
            # Line-by-line, NOT `printf ... $var`: Socratic.Trade's iOS path is
            # "ios/Socratic Trade.xcodeproj/...", and unquoted word-splitting
            # printed that one file as two bogus lines. Decision logic is
            # unaffected; the log was just lying about what changed.
            printf '%s\n' "$since_changed" | while IFS= read -r f; do echo "  $f"; done
            decision=1
          else
            log "[${app}] falling back to time: no ${PATTERNS_LOG} commits since the last ship; skip."
          fi
        else
          log "[${app}] state has no usable timestamp either; letting ship-testflight.sh decide."
          decision=1
        fi
      fi
    else
      decision=-1
    fi

    if [[ "$decision" -eq -1 ]]; then
      # Reachable range: the only case where a real diff is meaningful.
      # Captured into a variable, not piped into `grep -q`: under pipefail an
      # early-exiting grep SIGPIPEs git and the pipeline reports failure even
      # though it matched.
      changed="$(git -C "$REPO_ROOT" diff --name-only "$last_sha" HEAD -- "${GIT_SPECS[@]}" 2>/dev/null | head -20)"
      if [[ -n "$changed" ]]; then
        log "[${app}] ${PATTERNS_LOG} changed since ${last_sha}:"
        printf '%s\n' "$changed" | while IFS= read -r f; do echo "  $f"; done
        decision=1
      else
        log "[${app}] no ${PATTERNS_LOG} changes since ${last_sha}; skip (TestFlight is not a commit log)."
        decision=0
      fi
    fi
  fi

  emit "$(out_key "$app")" "$decision"
  if [[ "$decision" -eq 1 ]]; then SHOULD_ANY=1; fi
done

emit should_ship "$SHOULD_ANY"
if [[ "$SHOULD_ANY" -eq 0 ]]; then
  log "scheduled tick: nothing to ship."
fi
exit 0
