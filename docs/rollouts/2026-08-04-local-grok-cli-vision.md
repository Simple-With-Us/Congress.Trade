# 2026-08-04 — Local Grok CLI vision (subscription) as primary worker engine

## Summary
Owner asked for Grok vision **via local subscription** (not only OpenRouter). The Mac vision worker now uses:

1. **PRIMARY:** `grok -p` headless CLI (`~/.grok/bin/grok`), OIDC auth from the owner's xAI subscription (`~/.grok/auth.json`). PDF → `pdftoppm` PNGs → multimodal `read_file` vision.
2. **FALLBACK:** OpenRouter `x-ai/grok-4.5` (kept; useful when CLI is down or for server-side parity).

`VISION_ENGINE=auto|local_cli|openrouter` (default `auto`).

## Verification
- `grok -p "Reply: OK"` works with subscription auth
- Smoke: `E-2021-debra-a-haaland-12-07-2021-278t` → `extractor=local_grok_cli_v1`, 1 tx via local CLI in ~25s

## Files
- `services/vision-worker/worker.py`
- `services/vision-worker/run-vision-worker.sh`
- `services/vision-worker/README.md`
