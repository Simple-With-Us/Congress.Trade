# 2026-08-16 — Web chrome: admin, tabs, header, settings, Apple tap

## 1. Context & Objective

Owner screenshots of congress.trade on iPhone: Admin gone, sticky
filters colliding with the logo while scrolling, a floating glass tab
bar sitting above Safari's URL chrome, signed-out desktop-site header
stuffed with Light/Dark/System, a tiny settings/sign-in sheet, and
Apple Sign In that would not take a tap (then 302'd to "not configured").

## 2. Changes Made

- Bottom tabs are a full-bleed solid dock (`bottom: 0`, no pill, no
  12px inset) matching Socratic.Trade's console tab bar.
- Phone / coarse-pointer / iPhone "desktop site" use the compact
  hamburger chrome so theme is not dumped into the top bar when signed
  out.
- Sticky header stays 52px on phones (removed the 720px 14px/22px
  padding bump that made `--ct-header-h` lie).
- Account menu is larger, sectioned (Appearance / Account / Admin), and
  lists Admin + Review Queue when `canUseAdmin()`.
- Sign-in sheet is a large bottom sheet on touch.  Apple is a real
  `<a href="/auth/apple/start">` (48px tap target).
- `GET /auth/me` now includes `auth.appleWeb`.  `GET /auth/apple/status`
  is a no-side-effect probe.

Touched:

- `app/src/ui/dashboardHtml.ts`
- `app/src/ui/__tests__/dashboardHtml.test.ts`
- `app/src/auth/routes.ts`
- `app/src/auth/__tests__/routes.test.ts`
- `app/src/auth/__tests__/appleRoute.test.ts`
- `docs/EFFORT-LOG.md`
- `STATUS.md`

## 3. Decisions & Trade-offs

- Did not invent `APPLE_SERVICES_ID` / `APPLE_TEAM_ID` / `APPLE_KEY_ID` /
  `APPLE_P8`.  Native iOS SIWA is on (`APPLE_SIGNIN_ENABLED`).  Website
  SIWA still needs those four Infisical keys (Services ID + the same
  .p8 used to mint Apple client_secret).  Until they exist, tapping
  Apple stays on the sheet and says it is not configured — no bounce
  to `?auth_error=`.
- Admin stays a tab on desktop.  On phones the extra tabs are easy to
  miss, so Admin also lives in the settings sheet.
- Default theme remains light.  Signed-out header no longer shows
  Light/Dark/System.

## 4. Verification State

```bash
cd app && npx vitest run src/ui/__tests__/dashboardHtml.test.ts \
  src/auth/__tests__/appleRoute.test.ts src/auth/__tests__/routes.test.ts
# 3 files / 289 passed
npx deno check src/deno/main.ts
```

Infisical names-only on the CT app project: `APPLE_SIGNIN_ENABLED`,
`APPLE_BUNDLE_ID`, IAP product knobs.  No `APPLE_SERVICES_ID`.

## 5. Next Steps & Blockers

1. Owner: if website Sign in with Apple should complete, add
   `APPLE_SERVICES_ID` + `APPLE_TEAM_ID` + `APPLE_KEY_ID` + `APPLE_P8`
   to Infisical (do not invent keys).  Same .p8 family as native SIWA.
2. Owner: if Admin still missing after this ships, paste
   `CT_ADMIN_TOKEN` from `~/.secrets/global-api-keys` into Admin Access
   (or sign in with an allowlisted email).  Do not paste the token here.

## 6. Zero-Code Findings

The 720px header padding bump (`14px 22px`) vs `--ct-header-h: 52px`
is why scrolling mashed the filter pills through the logo.  iPhone
"Request Desktop Website" is a wide viewport, so the old max-width
queries never applied — that is why signed-out dumped theme + wrapping
tabs into the top bar.
