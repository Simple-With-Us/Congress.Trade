#!/usr/bin/env bash
# Codex Cloud coordination helper.
# Runtime variables (not setup-only secrets): SLACK_BOT_TOKEN, GH_TOKEN
# Optional: SLACK_CHANNEL_ID, SLACK_PROJECT, SLACK_AGENT_NAME, AGENT_SYNC_TOKEN
set -u

CHANNEL_ID="${SLACK_CHANNEL_ID:-C0BEZDJDNKV}"
PROJECT="${SLACK_PROJECT:-${SLACK_TOPIC:-Congress-Trading-Shared}}"
AGENT="${SLACK_AGENT_NAME:-${AGENT_NAME:-CODEX}}"
AUTH_CONFIG=""

cleanup() {
  [ -n "${AUTH_CONFIG:-}" ] && rm -f "$AUTH_CONFIG" 2>/dev/null
}
trap cleanup EXIT INT TERM

slack_ok() {
  printf '%s' "$1" | python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)
sys.exit(0 if d.get("ok") else 1)'
}

slack_error() {
  printf '%s' "$1" | python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("parse_error"); sys.exit(0)
print(d.get("error", "unknown_error"))'
}

slack_call() {
  if [ -z "${SLACK_BOT_TOKEN:-}" ]; then
    echo "Slack unavailable: SLACK_BOT_TOKEN is not a runtime environment variable." >&2
    return 2
  fi
  local auth_cfg
  auth_cfg="$(mktemp "${TMPDIR:-/tmp}/codex-slack-auth.XXXXXX")"
  chmod 600 "$auth_cfg"
  printf 'header = "Authorization: Bearer %s"\n' "$SLACK_BOT_TOKEN" >"$auth_cfg"
  local endpoint="$1"
  shift
  local rc=0
  curl -sS --config "$auth_cfg" "$@" "https://slack.com/api/$endpoint" || rc=$?
  rm -f "$auth_cfg" 2>/dev/null
  return $rc
}

filter_history() {
  python3 -c '
import json, sys
topic = (sys.argv[1] if len(sys.argv) > 1 else "").lower()
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(1)
if not data.get("ok"):
    json.dump(data, sys.stdout)
    sys.exit(0)
if topic:
    kept = []
    for msg in data.get("messages") or []:
        text = (msg.get("text") or "").lower()
        if (
            ("[" + topic + "]") in text
            or "[fleet]" in text
            or "[all]" in text
        ):
            kept.append(msg)
    data["messages"] = kept
json.dump(data, sys.stdout)
' "$PROJECT"
}

case "${1:-help}" in
  test)
    resp="$(slack_call auth.test)" || { echo "Slack: FAILED" >&2; exit 1; }
    if slack_ok "$resp"; then
      echo "Slack: OK"
    else
      echo "Slack: FAILED ($(slack_error "$resp"))" >&2
      exit 1
    fi
    if [ -n "${GH_TOKEN:-}" ]; then
      gh api user --jq .login >/dev/null 2>&1 && echo "GitHub: OK" || { echo "GitHub: FAILED" >&2; exit 1; }
    else
      echo "GitHub: GH_TOKEN is not a runtime environment variable." >&2
      exit 2
    fi
    ;;
  read)
    limit="${2:-}"
    if [ -z "$limit" ]; then
      if [ -n "$PROJECT" ]; then
        limit="${SLACK_PROJECT_FETCH_LIMIT:-${SLACK_TOPIC_FETCH_LIMIT:-100}}"
      else
        limit=20
      fi
    fi
    case "$limit" in
      ''|*[!0-9]*) limit=20 ;;
    esac
    resp="$(slack_call "conversations.history?channel=${CHANNEL_ID}&limit=${limit}")" \
      || { echo "Slack read: FAILED" >&2; exit 1; }
    if ! slack_ok "$resp"; then
      echo "Slack read: FAILED ($(slack_error "$resp"))" >&2
      exit 1
    fi
    printf '%s' "$resp" | filter_history
    echo
    ;;
  post)
    shift
    text="$*"
    [ -n "$text" ] || { echo "usage: $0 post MESSAGE" >&2; exit 2; }
    tagged="[$PROJECT] [$AGENT]
repo: $PROJECT

$text"
    payload="$(python3 -c 'import json, sys; print(json.dumps({"channel": sys.argv[1], "text": sys.argv[2]}))' "$CHANNEL_ID" "$tagged")"
    resp="$(slack_call chat.postMessage -H "Content-Type: application/json; charset=utf-8" --data "$payload")" \
      || { echo "Slack post: FAILED" >&2; exit 1; }
    if slack_ok "$resp"; then
      echo "Slack post: OK"
    else
      echo "Slack post: FAILED ($(slack_error "$resp"))" >&2
      exit 1
    fi
    ;;
  github)
    gh api user --jq .login
    ;;
  help|*)
    echo "usage: $0 {test|read [N]|post MESSAGE|github}"
    ;;
esac
