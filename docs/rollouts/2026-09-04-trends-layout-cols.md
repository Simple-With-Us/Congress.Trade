# Trends card swap, full-bleed filter bar, Trades column defaults

## Summary

Owner 2026-09-04: the first Trends pair (What Is Being Traded + Rising
Activity) was cramped horizontally; the later equal-width pair had room.
Rising Activity (four columns) now sits next to Most Active Politicians.
Top Performers sits next to What Is Being Traded.

The sticky filter bar was only as wide as the 1280px Trends column, so
header.top (full viewport, white) left cool-grey notches on the left and
right (45px each side at 1440px).  The strip now breaks out with `100vw`
and `margin-left: calc(50% - 50vw)` so it matches the header edge to edge.
Chips keep `--ct-main-pad`, same inset as the wordmark.

Trades table defaults (Columns chooser still offers every field):

- Public: Country, Confidence, Latency, and Source are off.  Confidence,
  Latency, and Source were already admin-only; Country is newly off for
  signed-out visitors.
- Admin: only Source is off by default.  Country, Confidence, and Latency
  stay on.  Confidence was previously off for admins too; it is now on.

Storage key bumped `feed-cols-hidden-v3` → `feed-cols-hidden-v4`, with a
separate `-admin` suffix, so existing localStorage does not keep the old
Country column on and admins do not inherit the public hidden set.

iPad regular-width Trends grid matches the web pairing.  iPhone stacked
order is unchanged (Rising Activity stays high on a one-column phone).

## Files

- `app/src/ui/dashboardHtml.ts`
- `app/src/ui/__tests__/dashboardHtml.test.ts`
- `clients/ios/CongressTrade/Views/TrendsView.swift`

## Verification

- `cd app && npm run typecheck` (deno check src/deno/main.ts, exit 0)
- `cd app && npx --no-install vitest run src/ui/__tests__/dashboardHtml.test.ts` (351 passed)
- `cd app && npm test` (301 files / 3831 tests passed)

## Follow-ups

- Coolify auto-deploys on merge.  After deploy: Trends at 1440px — no grey
  notches under the white bar; Rising Activity Politicians column fully
  visible in the later pair; Trades Columns chooser matches the defaults
  above (reset columns if an old v3 pref is still in the screenshot
  session — new visitors get v4 automatically).
- Board `8cff54b6` (Rising Activity clipped at 1440px) is addressed by the
  swap into the equal-width pair.

Board: `1f0f2bd4`.
