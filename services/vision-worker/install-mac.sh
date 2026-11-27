#!/bin/bash
# Install or update Congress.Trade vision-worker files under ~/vision-worker.
# Safe with --dry-run (no filesystem writes).  Does not store or print tokens.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
TARGET_DIR="${VISION_WORKER_HOME:-$HOME/vision-worker}"
VENV_PYTHON="${VISION_WORKER_VENV_PYTHON:-$HOME/vision-worker-venv/bin/python3}"
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      cat <<'EOF'
Usage: install-mac.sh [--dry-run]

Copies worker.py, launch_with_infisical.py, run-vision-worker.sh,
requirements.txt, and README.md into $VISION_WORKER_HOME (default: ~/vision-worker).
EOF
      exit 0
      ;;
    *)
      echo "install-mac.sh: unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

FILES=(
  "worker.py:644"
  "launch_with_infisical.py:755"
  "run-vision-worker.sh:755"
  "requirements.txt:644"
  "README.md:644"
)

for spec in "${FILES[@]}"; do
  name="${spec%%:*}"
  if [[ ! -f "$HERE/$name" ]]; then
    echo "install-mac.sh: missing source file $HERE/$name" >&2
    exit 1
  fi
done

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "DRY RUN: would install into $TARGET_DIR:"
  for spec in "${FILES[@]}"; do
    name="${spec%%:*}"
    mode="${spec##*:}"
    echo "  $HERE/$name -> $TARGET_DIR/$name (mode $mode)"
  done
  exit 0
fi

mkdir -p "$TARGET_DIR"
for spec in "${FILES[@]}"; do
  name="${spec%%:*}"
  mode="${spec##*:}"
  cp -p "$HERE/$name" "$TARGET_DIR/$name"
  chmod "$mode" "$TARGET_DIR/$name"
done

if [[ ! -x "$VENV_PYTHON" ]]; then
  echo "WARNING: $VENV_PYTHON not found; run-vision-worker.sh will fall back to PATH python3" >&2
fi

echo "Installed vision-worker into $TARGET_DIR"
echo "Next on Mac:"
echo "  1. Ensure scoped Infisical service token 'vision-worker-ct-ro' is in Login Keychain"
echo "     (service 'infisical-service-token', account 'vision-worker-ct-ro') or 0600"
echo "     ~/.config/infisical/tokens/vision-worker-ct-ro.token for non-GUI pm2 sessions."
echo "  2. pm2 restart vision-worker || pm2 start ~/Code/AI-Fleet-Coordinator/scripts/pm2-ecosystem.config.cjs --only vision-worker"
