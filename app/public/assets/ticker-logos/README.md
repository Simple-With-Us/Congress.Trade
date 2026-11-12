# Local ticker logos (repo-hosted)

**Gap-fills and owner-uploaded marks**, not automatically the winner.

`GET /api/logos/ticker?symbol=AAPL&theme=light|dark` walks a **per-ticker, per-theme** source list (see `src/ui/tickerLogoPolicy.ts`):

1. **Themed local file** `light/SYMBOL.png` or `dark/SYMBOL.png` (always wins when present)
2. **Jury order** for that theme: logo.dev and/or GitHub `davidepalazzo/ticker-logos`, plus unthemed `SYMBOL.png`
3. Default when ungraded: logo.dev → unthemed pack → GitHub

A/B/C/D in the admin jury (`/api/admin/logo-jury`) means GitHub-on-light / GitHub-on-dark / logo.dev-light / logo.dev-dark. The top 30 from 2026-08-23 are seeded. Further grades live in CONFIG_KV until copied into the seed map.

## Upload a mark

- Both themes: `SYMBOL.png` in this folder
- One theme: `light/SYMBOL.png` or `dark/SYMBOL.png` (preferred when GitHub only works on dark, etc.)
- Square PNG, 256×256 preferred
- Deploy; confirm `x-logo-source` and `x-logo-policy`

Owner follow-ups from the first 30: SPCX (own mark), IBM (both themes), UBER/UNH/BLK (light-mode uploads).
