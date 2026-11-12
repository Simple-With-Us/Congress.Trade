# 2026-08-14 — iOS Trades sort grouping + search-slot status

## Summary

Owner: Trades tab looks better, but the reverse control and Date dropdown
were not a group, the menu chevron did not change on reverse sort, and there
was too much space above and below the search field.  Reload/updating text
should occupy the search slot, then the field returns with the same typed
query.

- Flip arrow sits flush against Date / Amount / Ticker.  The icon is the
  live direction (`arrow.up` / `arrow.down`).  The menu no longer carries a
  second, static chevron.
- Pagination, the sort group, and the rows dropdown share even space.
- Filter strip to search is 6pt.  The reserved “Updating results…” row
  under search is gone.
- Updating / Reload replace the search field in-place.  `searchText` is
  kept and the field comes back with the same contents.

## Files

- `clients/ios/CongressTrade/Views/Feed/FeedDashboardView.swift`
- `clients/ios/CongressTrade/App.swift` (`-startOnTrades` QA launch flag)

## Verification

`xcodebuild` BUILD SUCCEEDED.  Simulator screenshot: `↓` + Date grouped in
the center, pager left, 50 right, search tight to filters and to the list.
