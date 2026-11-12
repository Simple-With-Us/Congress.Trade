# 2026-08-17 — Filter chrome, trades table, Delivery latency

Issue #1918.  Branch `grok/filters-table-latency`.

## What shipped

- Trends/Trades filter bar is flush under the header and full-bleed.  It starts
  already at its sticky rest position, so it no longer slides a few pixels then
  pins.
- Trades column resize no longer treats a hidden `#view-trades` (`offsetWidth`
  0) as a 62px Politician column.  Switching to Trades resyncs widths.
- Public Filing Latency Comparison lives at the end of Delivery (web + iOS).
  Trends keeps a link.  Both hide when we are behind on most usable providers.
  Admin still always shows the full scoreboard.

## Verify

- Open Trends and Trades: no blue gap above/beside filters; scroll does not
  walk the bar.
- Land on Trends (default), then open Trades: Politician/Asset columns fill
  the table.
- Delivery bottom: scoreboard only if we are not behind on most providers.
  Admin always has it.
