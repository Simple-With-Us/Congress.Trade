# Light vs Sepia, Trends layout, combined disclaimer

Thu, Aug 20, 2026

Owner screenshots: Mac Account sheet stark white vs cream Directory cards;
website Trends header not full-bleed; All Time Rising Activity; net-flow wrap;
Buy Pressure `70 % buys`.

## Theme

Light (cool `#eff3f8`) and Sepia (warm paper) are complete palettes on web and
iOS — page, header, cards, filters, Account sheet.  Dark and System stay.
Default remains light.

## Disclaimer

One footer line, two spaces around each `·`, no trailing period:

Congress.Trade  ·  educational tool for public STOCK Act (2012) disclosures  ·  not financial advice  ·  $ estimated from brackets  ·  independent/private service not affiliated with or endorsed/sponsored by any government agency

ToS §1 still has the longer legal non-affiliation sentence.

## Trends

- Filter bar full-bleed uses main padding.  A later two-ID `width: auto` rule
  that clipped the right edge is gone.
- `--trends-gap: 24px` above snapshot cards, below them, and between What Is
  Being Traded and Rising Activity.
- Filter dropdowns use the same `--panel` fill as the timeframe pill.
- Rising Activity hides on All Time (no prior period — `momentumOffsets('all')`
  used to fake 90d vs 180d).  Skips the trending fetch on web and iOS.
- Remaining All Time wait is the full-corpus summary/leaderboard queries, not
  a prior-period compare.
- Net flow stays one row with a minus (`−$178.3m`), nowrap, and shrinks via
  `clamp` if the card is narrow.
- Option footnote is 10px nowrap.
- Buy Pressure is `70%` + `buys` with `%` 8px smaller than the number and
  `buys` 4px smaller than `%` (no space between number and `%`).

## iOS

Timeframe labels match the website (`3 Months`, not `Past 3 Months`).
Filter pills use the card fill (not a blue selected chip).  Account sheet and
Form rows follow the selected Light/Sepia/Dark palette.

Issue: #2097.  Board: `512be684`.
