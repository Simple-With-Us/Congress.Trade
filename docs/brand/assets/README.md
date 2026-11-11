# Congress.Trade brand assets

**Source of truth (2026-08-09):** owner hi-res masters

- `source-owner-lockup-hires-2026-08-09.png` — full CONGRESS + eagle + TRADE lockup (~1670×334 after trim)
- `source-owner-mark-hires-2026-08-09.png` — eagle + money-bag mark alone (~1015×1048)

## Rules (owner)

- **Never** ship the navy-filled badge as the product mark or website logo.
- **Website:** transparent lockup/mark only (no cream fill) — the UI supplies the background.
- **Light lockup:** solid black letters on transparent (good on light/cream UI).
- **Dark lockup:** same art with **white** letters; eagle colors preserved.
- **iOS AppIcon only:** opaque **white/off-white full-bleed plate** + eagle mark (`eagle-app-icon-light-1024.png`). Hi-res: `eagle-app-icon-light-1408.png`. iOS rejects transparent AppIcon and applies its own squircle — do **not** ship pre-rounded mockups with outer canvas (kept only as `source-owner-app-icon-mockup-rounded-1408x1408.jpg` for reference).
- **Everywhere else that allows alpha** (web/PWA icons, favicon, apple-touch-icon, splash, in-app BrandLogo): transparent eagle mark — no plate fill.

## Files

| File | Use |
|------|-----|
| `source-owner-lockup-hires-2026-08-09.png` | Owner lockup master (hi-res) |
| `source-owner-mark-hires-2026-08-09.png` | Owner eagle mark master (hi-res) |
| `eagle-lockup-transparent.png` | Website light type (black text), transparent |
| `eagle-lockup-dark-ui.png` | Website dark type (white text), transparent |
| `eagle-header-lockup-{light,dark}-240.png` | High-DPI header embeds |
| `eagle-moneybag-icon-square.png` | Transparent eagle mark (splash / BrandLogo) |
| `source-owner-app-icon-1024x1024.jpg` | Legacy reference only; not the installed AppIcon source |
| `source-owner-app-icon-1408x1408.jpg` | Legacy reference only; not the installed AppIcon source |
| `source-owner-app-icon-mockup-rounded-1408x1408.jpg` | Pre-rounded presentation mockup; reference only, never install as AppIcon |
| `eagle-app-icon-light-1024.png` | Opaque full-bleed iOS AppIcon source |
| `eagle-app-icon-light-1408.png` | Hi-res opaque full-bleed iOS AppIcon source |
| `eagle-app-icon-light-{180,192,512}.png` | Plate-filled reference exports; not the transparent web/PWA icons |
| `eagle-app-icon-1024.png` | Archived navy mockup — **do not use** |

## Installed

- Web `app/public/assets/brand-logo-{light,dark}.png` ← hi-res lockups (`?v=20`)
- Web `app/public/assets/eagle-splash.png` ← transparent mark
- Web `app/public/{icon-192,icon-512,apple-touch-icon,favicon}.png` ← **transparent** mark (`?v=10`)
- iOS `BrandLockup` ← light (black letters) + dark (white letters)
- iOS `BrandLogo` ← transparent eagle mark (in-app; alpha OK)
- iOS `AppIcon` ← **opaque** `eagle-app-icon-light-1024.png` full-bleed plate only (not the JPG references or rounded mockup)
