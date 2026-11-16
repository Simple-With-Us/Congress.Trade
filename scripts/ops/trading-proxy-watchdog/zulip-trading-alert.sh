#!/usr/bin/env bash
# Post a trading-proxy alert to the Zulip Trading and Incident-Response streams
# AS THE WATCHDOG bot (Jay directive, 2026-10-29 evening: automated alerts use
# a dedicated, purpose-named system identity — the Watchdog bot — never an
# agent's bot identity; a post under a bot's name must be that system speaking).
# The posted copy tags Jay Wedgeworth, BF-Trader and GB-Trader.
# Usage: zulip-trading-alert.sh <alert-file> [--dry-run]
# On success, deletes the alert file so it is not reposted.
# Exit 0 on success (or dry-run), non-zero if any post failed (file kept).
set -u
ALERT_FILE="${1:?usage: zulip-trading-alert.sh <alert-file> [--dry-run]}"
DRY_RUN="${2:-}"
ZULIPRC="${ZULIPRC:-$HOME/.secrets/watchdog-zuliprc}"
export ZULIPRC
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="${WATCHDOG_LOG_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)/logs}"
mkdir -p "$LOG_DIR"

if [ ! -f "$ALERT_FILE" ]; then
  echo "alert file not found: $ALERT_FILE" >&2
  exit 2
fi

# The alert file's contents are posted verbatim to two streams, so confine
# it to the watchdog state directory and cap its size -- an arbitrary local
# path must never be postable (Kody review finding, 2026-10-30).
STATE_DIR="${WATCHDOG_STATE_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)/state}"
alert_dir="$(cd "$(dirname "$ALERT_FILE")" 2>/dev/null && pwd)"
if [ "$alert_dir" != "$STATE_DIR" ]; then
  echo "alert file must live in the watchdog state dir ($STATE_DIR): $ALERT_FILE" >&2
  exit 2
fi
alert_bytes="$(wc -c < "$ALERT_FILE" | tr -d ' ')"
if [ "$alert_bytes" -gt 8192 ]; then
  echo "alert file too large ($alert_bytes bytes): $ALERT_FILE" >&2
  exit 2
fi

pyout=$(python3 - "$ALERT_FILE" "$DRY_RUN" <<'PYEOF'
import configparser, json, sys, urllib.request, urllib.parse, datetime

alert_file, dry_run = sys.argv[1], (len(sys.argv) > 2 and sys.argv[2] == '--dry-run')
with open(alert_file) as f:
    content = f.read().strip()
if not content:
    print("alert file empty", file=sys.stderr)
    sys.exit(2)
content = "@**Jay Wedgeworth** @**BF-Trader** @**GB-Trader**\n" + content

import os
c = configparser.ConfigParser()
c.read(os.environ.get('ZULIPRC') or os.path.expanduser('~/.secrets/watchdog-zuliprc'))
site = c['api']['site'].rstrip('/')
email = c['api']['email']
key = c['api']['key']

import base64
auth = base64.b64encode(f"{email}:{key}".encode()).decode()

def post(payload):
    data = urllib.parse.urlencode(payload).encode()
    req = urllib.request.Request(
        site + '/api/v1/messages', data=data,
        headers={'Authorization': 'Basic ' + auth,
                 'Content-Type': 'application/x-www-form-urlencoded'})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)

targets = [
    {"type": "stream", "to": "Trading", "topic": "trading-proxy",
     "desc": "stream Trading"},
    {"type": "stream", "to": "Incident-Response", "topic": "trading-proxy",
     "desc": "stream Incident-Response"},
]

if dry_run:
    print(f"DRY RUN: would post {len(content)} chars to: " +
          ", ".join(t["desc"] for t in targets))
    sys.exit(0)

errors = []
for t in targets:
    payload = {"type": t["type"], "to": t["to"], "content": content}
    if t["type"] == "stream":
        payload["topic"] = t["topic"]
    try:
        res = post(payload)
        if res.get("result") != "success":
            errors.append(f'{t["desc"]}: {res}')
        else:
            print(f'posted to {t["desc"]} (id {res.get("id")})')
    except Exception as e:
        errors.append(f'{t["desc"]}: {e}')

if errors:
    for e in errors:
        print("FAILED:", e, file=sys.stderr)
    sys.exit(1)
PYEOF
)
rc=$?
ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
if [ "$DRY_RUN" = "--dry-run" ]; then
  echo "$ts zulip-trading-alert: dry-run ok for $ALERT_FILE" >> "$LOG_DIR/public-liveness.log"
  exit 0
fi
if [ $rc -eq 0 ]; then
  rm -f "$ALERT_FILE"
  ids=$(printf '%s\n' "$pyout" | grep -o 'id [0-9]*' | paste -sd' ' -)
  echo "$ts zulip-trading-alert: posted to Trading + Incident-Response streams [$ids], file removed" >> "$LOG_DIR/public-liveness.log"
  exit 0
else
  echo "$ts zulip-trading-alert: FAILED (exit $rc), file kept for retry: $ALERT_FILE" >> "$LOG_DIR/public-liveness.log"
  exit $rc
fi
