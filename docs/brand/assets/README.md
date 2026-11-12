# Congress.Trade brand assets

**Source of truth (2026-08-09):** owner hi-res masters

- `source-owner-lockup-hires-2026-08-09.png` — full CONGRESS + eagle + TRADE lockup (~1670×334 after trim)
- `source-owner-mark-hires-2026-08-09.png` — eagle + money-bag mark alone (~1015×1048)

## Rules (owner)

- **Never** ship the navy-filled badge as the product mark or website logo.
- **Website:** transparent lockup/mark only (no cream fill) — the UI supplies the background.
- **Light lockup:** solid black letters on transparent (good on light/cream UI).
- **Dark lockup:** same art with **white** letters; eagle colors preserved.
- **iOS AppIcon only:** opaque light-gray full-bleed plate (`eagle-app-icon-light-1024.png` / `source-owner-app-icon-1024x1024.jpg`). Hi-res master: `eagle-app-icon-light-1408.png` / `source-owner-app-icon-1408x1408.jpg`. iOS rejects transparent AppIcon.
- **Everywhere else that allows alpha** (web/PWA icons, favicon, apple-touch-icon, splash, in-app BrandLogo): transparent eagle mark — no plate fill.
- **Social OG cards:** horizontal site-heading lockup (CONGRESS · eagle · TRADE), light plate; context subtitles for Trends / Company / Politician deep links.

## Active files (this folder)

| File | Use |
|------|-----|
| `source-owner-lockup-hires-2026-08-09.png` | Owner lockup master (hi-res) |
| `source-owner-mark-hires-2026-08-09.png` | Owner eagle mark master (hi-res) |
| `eagle-lockup-transparent.png` | Website light type (black text), transparent |
| `eagle-lockup-dark-ui.png` | Website dark type (white text), transparent |
| `eagle-header-lockup-{light,dark}-*.png` | High-DPI header embeds |
| `eagle-moneybag-icon-square.png` | Transparent eagle mark (splash / BrandLogo) |
| `source-owner-app-icon-1024x1024.jpg` | Owner App Store / AppIcon plate (1024×1024) |
| `source-owner-app-icon-1408x1408.jpg` | Owner app-icon master at 1408×1408 |
| `eagle-app-icon-light-1024.png` | iOS AppIcon + derived PWA icons |
| `eagle-app-icon-light-1408.png` | Hi-res app-icon master |
| `eagle-app-icon-light-{180,192,512}.png` | Derived install / PWA sizes |
| `eagle-mark-transparent-*.png` | Transparent mark sizes |
| `og-image-light-1200x630.png` | Default social card master |
| `og-image-{trends,company,politician}-1200x630.png` | Context social card masters |
| `brand-logo-*-from-user.png` / `brand-logo-dark-fullres.png` | Owner-supplied lockup sources |

## Archived

Older experiments, navy mockups, circle badges, and superseded sizes live in **`OLD/`**. Do not reinstall those as product art.

## Installed

- Web `app/public/assets/brand-logo-{light,dark}.png` ← hi-res lockups (`?v=20`)
- Web `app/public/assets/eagle-splash.png` ← transparent mark
- Web `app/public/{icon-192,icon-512,apple-touch-icon,favicon}.png` ← **transparent** mark (`?v=10`)
- Web `app/public/og-image.png` ← default social card (lockup layout; meta `?v=22`)
- Web `app/public/og-image-{trends,company,politician}.png` ← context cards (`?v=22`)
- iOS `BrandLockup` ← light (black letters) + dark (white letters)
- iOS `BrandLogo` ← transparent eagle mark (in-app; alpha OK)
- iOS `AppIcon` ← **opaque** owner 1024×1024 plate (light bg + soft shadow); web icons stay transparent

## Regenerating OG cards

Use the light lockup + Zilla Slab to paint 1200×630 cards on `#eff3f8`. Server picks the file from the deep-link query (`app/src/ui/ogMeta.ts`). Bump `OG_IMAGE_VERSION` in `app/src/ui/assets.ts` after replacing PNGs.
