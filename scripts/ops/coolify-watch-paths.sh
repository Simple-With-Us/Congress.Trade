#!/usr/bin/env bash
# Apply (or verify) Coolify watch_paths on congress-trade so docs-only main
# pushes do not rebuild the origin.
#
# Usage:
#   COOLIFY_TOKEN=... bash scripts/ops/coolify-watch-paths.sh
#   COOLIFY_TOKEN=... bash scripts/ops/coolify-watch-paths.sh --check
#
# Never prints the token.  PATCH sends only watch_paths.

set -uo pipefail

COOLIFY_BASE_URL="${COOLIFY_BASE_URL:-https://host.jays.services}"
APP_UUID="${APP_UUID:-${COOLIFY_APP_UUID:-congress-app}}"
# Repo-root relative.  No leading slash — Coolify strips it and matches the
# GitHub webhook file list (see Application::parseWatchPaths / globMatch).
WATCH_PATHS="${WATCH_PATHS:-app/**
services/**}"
CHECK_ONLY=0
CANCEL_QUEUED=0
case "${1:-}" in
  --check) CHECK_ONLY=1 ;;
  --cancel-queued) CANCEL_QUEUED=1 ;;
esac

if [[ -z "${COOLIFY_TOKEN:-}" ]]; then
  echo "coolify-watch-paths: COOLIFY_TOKEN missing" >&2
  exit 1
fi

UA="${COOLIFY_UA:-Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36}"
HDR=$(mktemp) || exit 1
trap 'rm -f "$HDR"' EXIT
chmod 600 "$HDR"
printf 'Authorization: Bearer %s\n' "$COOLIFY_TOKEN" > "$HDR"

api() {
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -sS -m 30 -A "$UA" -X "$method" -H @"$HDR" \
      -H 'Accept: application/json' -H 'Content-Type: application/json' \
      -d "$body" "${COOLIFY_BASE_URL%/}${path}"
  else
    curl -sS -m 30 -A "$UA" -X "$method" -H @"$HDR" \
      -H 'Accept: application/json' \
      "${COOLIFY_BASE_URL%/}${path}"
  fi
}

if [[ "$CANCEL_QUEUED" -eq 1 ]]; then
  json=$(api GET "/api/v1/deployments") || {
    echo "coolify-watch-paths: GET deployments failed" >&2
    exit 1
  }
  queued=$(printf '%s' "$json" | APP_UUID="$APP_UUID" python3 -c '
import json, os, sys
d = json.load(sys.stdin)
if isinstance(d, list):
    rows = d
elif isinstance(d, dict):
    inner = d.get("data", d.get("deployments"))
    if isinstance(inner, list):
        rows = inner
    elif isinstance(inner, dict):
        rows = list(inner.values())
    elif d and all(str(k).isdigit() for k in d.keys()):
        rows = list(d.values())
    else:
        rows = []
else:
    rows = []
uuid = os.environ["APP_UUID"]
for row in rows:
    if not isinstance(row, dict):
        continue
    mine = (
        row.get("application_id") == uuid
        or row.get("application_uuid") == uuid
        or row.get("application_name") == "congress-trade"
    )
    if mine and row.get("status") == "queued" and row.get("deployment_uuid"):
        print(row["deployment_uuid"])
')
  cancelled=0
  if [[ -n "$queued" ]]; then
    while read -r dep; do
      [[ -z "$dep" ]] && continue
      if api POST "/api/v1/deployments/${dep}/cancel" >/dev/null; then
        echo "cancelled ${dep:0:8}"
        cancelled=$((cancelled + 1))
      else
        echo "could not cancel ${dep:0:8}"
      fi
    done <<<"$queued"
  fi
  echo "cancelled=${cancelled}"
  exit 0
fi

want_normalized=$(printf '%s\n' "$WATCH_PATHS" | python3 -c '
import sys
lines=[]
for raw in sys.stdin:
    line=raw.strip()
    if not line:
        continue
    if line.startswith("!"):
        lines.append("!"+line[1:].lstrip("/"))
    else:
        lines.append(line.lstrip("/"))
print("\n".join(lines))
')

json=$(api GET "/api/v1/applications/${APP_UUID}") || {
  echo "coolify-watch-paths: GET application failed" >&2
  exit 1
}

eval "$(printf '%s' "$json" | python3 -c '
import json,sys,shlex
try:
    d=json.load(sys.stdin)
except Exception:
    print("echo coolify-watch-paths: GET did not return JSON >&2")
    print("exit 1")
    raise SystemExit
uuid=d.get("uuid") or ""
if not uuid:
    print("echo coolify-watch-paths: could not read application >&2")
    print("exit 1")
    raise SystemExit
wp=d.get("watch_paths") or ""
print("uuid="+shlex.quote(str(uuid)))
print("name="+shlex.quote(str(d.get("name") or "")))
print("pack="+shlex.quote(str(d.get("build_pack") or "")))
print("have="+shlex.quote(wp.replace("\n","|") if wp else "NONE"))
print("have_plain="+shlex.quote(wp))
')"

if [[ -z "${uuid:-}" ]]; then
  echo "coolify-watch-paths: could not read application ${APP_UUID}" >&2
  exit 1
fi

if [[ "$have_plain" == "$want_normalized" ]]; then
  echo "coolify-watch-paths: already set on ${name} (${uuid}) pack=${pack}"
  printf '%s\n' "$want_normalized" | sed 's/^/  /'
  exit 0
fi

echo "coolify-watch-paths: current=${have} want=$(printf '%s' "$want_normalized" | tr '\n' '|' )"

if [[ "$CHECK_ONLY" -eq 1 ]]; then
  echo "coolify-watch-paths: --check: drift (not patching)"
  exit 2
fi

body=$(WATCH_PATHS="$want_normalized" python3 -c 'import json,os; print(json.dumps({"watch_paths": os.environ["WATCH_PATHS"]}))')
patched=$(api PATCH "/api/v1/applications/${APP_UUID}" "$body") || {
  echo "coolify-watch-paths: PATCH failed" >&2
  exit 1
}

after=$(api GET "/api/v1/applications/${APP_UUID}")
after_wp=$(printf '%s' "$after" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("watch_paths") or "")')
if [[ "$after_wp" != "$want_normalized" ]]; then
  echo "coolify-watch-paths: PATCH did not stick (got $(printf '%s' "$after_wp" | tr '\n' '|'))" >&2
  printf '%s\n' "$patched" | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin)
    print("message:", d.get("message") or d.get("error") or "no-message")
except Exception:
    print("unparseable patch body")
' >&2
  exit 1
fi

echo "coolify-watch-paths: applied on ${name} (${uuid})"
printf '%s\n' "$after_wp" | sed 's/^/  /'
