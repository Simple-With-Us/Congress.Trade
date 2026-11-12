#!/usr/bin/env bash
# Render the four 1200x630 Open Graph / social share cards from scripts/og-card.html.
#
# Deterministic pipeline: headless Chrome renders the template at 2x device
# scale, then `sips` downscales to exactly 1200x630 so type and 1px borders
# stay clean.
#
# Usage (from anywhere):
#   scripts/render-og-cards.sh                  # render into app/public/
#   scripts/render-og-cards.sh /tmp/proof       # render into a scratch dir
#
# Also writes 360px-wide thumbnail proofs into <outdir>/thumbs/ — social cards
# are almost always seen at that size, so review them there first.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${1:-$ROOT/app/public}"
TEMPLATE="$ROOT/scripts/og-card.html"
LOCKUP="$ROOT/docs/brand/assets/eagle-lockup-transparent.png"

W=1200
H=630

find_chrome() {
  if [[ -n "${CHROME_BIN:-}" && -x "${CHROME_BIN}" ]]; then
    printf '%s' "$CHROME_BIN"
    return
  fi
  local shell_bin
  shell_bin="$(find "$HOME/.cache/puppeteer" -name 'chrome-headless-shell' -type f 2>/dev/null | sort | tail -1)"
  if [[ -n "$shell_bin" ]]; then
    printf '%s' "$shell_bin"
    return
  fi
  if [[ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]]; then
    printf '%s' "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    return
  fi
  echo "error: no Chrome binary found; set CHROME_BIN" >&2
  exit 1
}

CHROME="$(find_chrome)"
[[ -f "$TEMPLATE" ]] || { echo "error: missing $TEMPLATE" >&2; exit 1; }
[[ -f "$LOCKUP" ]] || { echo "error: missing lockup art $LOCKUP" >&2; exit 1; }

mkdir -p "$OUT_DIR" "$OUT_DIR/thumbs"
PROFILE="$(mktemp -d)"
trap 'rm -rf "$PROFILE"' EXIT

render() {
  local variant="$1" name="$2" out="$OUT_DIR/$2"
  "$CHROME" \
    --headless \
    --disable-gpu \
    --hide-scrollbars \
    --no-sandbox \
    --user-data-dir="$PROFILE/$variant" \
    --force-device-scale-factor=2 \
    --window-size="$W,$H" \
    --virtual-time-budget=4000 \
    --screenshot="$out" \
    "file://$TEMPLATE?v=$variant&lockup=file://$LOCKUP" >/dev/null 2>&1

  [[ -s "$out" ]] || { echo "error: render failed for $variant" >&2; exit 1; }
  sips -z "$H" "$W" "$out" >/dev/null
  cp "$out" "$OUT_DIR/thumbs/$name"
  sips -Z 360 "$OUT_DIR/thumbs/$name" >/dev/null
  printf '%-28s %s\n' "$name" "$(sips -g pixelWidth -g pixelHeight "$out" | tr '\n' ' ' | sed 's/  */ /g')"
}

render default    og-image.png
render trends     og-image-trends.png
render company    og-image-company.png
render politician og-image-politician.png

echo "cards  -> $OUT_DIR"
echo "thumbs -> $OUT_DIR/thumbs (360px proofs)"
