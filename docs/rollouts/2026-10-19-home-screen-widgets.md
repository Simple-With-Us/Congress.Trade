# iPhone Home Screen Widgets

## Summary

Replaced the widget's fixed “5 new trades” scaffold with public disclosure data.  Small widgets show the newest feed row; medium widgets show two; large widgets show four.  The extension fetches up to five records from `GET https://congress.trade/api/client/v1/feed?limit=5&order=desc`, using the backend's descending feed cursor order.  “Recently Added” describes that order; it does not claim transaction-date or filing-date order.

Each disclosure shows a ticker or asset name, filer, Buy/Sell/Exchange/Other label with an icon, and the reported amount range.  Amounts are disclosure bounds, not portfolio values or aggregate trading volume.  Small and large layouts label separate “Traded” and “Filed” dates; absent dates show an em dash.  Medium layouts reserve two legible lines per row and show the filing date alongside the filer; the transaction date remains in the linked trade detail.  If the filing date is absent but feed discovery time exists, “Added” is shown explicitly alongside “Filed —” on small/large widgets, and replaces the filing-date slot on medium widgets.  No fabricated totals, invented activity counts, or production fixtures are used.

The design follows the system's light/dark appearance with a light-background default on light Home Screens.  Direction indicators use words and symbols as well as color.  Small widgets open their displayed trade; medium/large disclosure rows open their own trade details, while the remaining widget surface opens Trades.  URLs use the existing custom-scheme `AppDeepLink` parser, with `URLQueryItem` encoding disclosure IDs.

The extension retains its last successfully decoded snapshot atomically in its own caches directory.  Network, HTTP, or malformed-response failures keep the last good snapshot and show “Saved” with its original refresh time.  A valid empty response replaces the snapshot with an honest empty state.  Invalid optional amount values are ignored; an invalid row identity is skipped without dropping valid sibling rows.  An all-invalid nonempty feed is treated as a failed refresh.  Missing ticker, member, transaction, or filing metadata does not crash the entire feed.

Refreshes are requested every 15 minutes; WidgetKit determines the actual schedule.  A future timeline entry marks data older after one hour even when the next fetch is delayed.  Refresh times use the owner's 12-hour Central clock.  Empty, loading, and unavailable states explain what is happening and link to the app feed.  Fictional sample rows are restricted to gallery snapshots and Xcode previews.

## Files Changed

- `clients/ios/CongressTradeWidget/CongressTradeWidget.swift`: provider, minimal value DTOs, cache, widget layouts, deep links, and previews.
- `docs/rollouts/2026-10-19-home-screen-widgets.md`: behavior, verification, and release limits.

No project, entitlement, backend, database, credential, or archived effort-log changes are required.

## Verification

- Queried the public endpoint successfully on 2026-10-19 and compared its nested `member`, `asset`, `transaction`, and `filing` payload with `clientTradeFromRow` in `app/src/client/utils.ts` and the native app models.  Live rows include absent tickers and null filing dates, handled explicitly in the widget.
- Reviewed custom-scheme links against `AppDeepLink.parse` in `clients/ios/CongressTrade/App.swift`; each row carries its backend trade ID, not its filing ID.
- `git diff --check` must pass before publication.
- Swift, Xcode, Simulator, and Apple signing/shipping tools are unavailable on this Linux host.  No compile, XCTest, screenshot, or signed-device verification is claimed here.

## Follow-ups

Run the existing macOS iOS build workflow to compile the app and widget extension before merging.  On stable Xcode, render the included small, medium, large, empty, offline, and saved-data previews; verify Home Screen light, dark, and tinted appearance, text fit on smaller iPhones, VoiceOver labels, every row's destination, network failure with/without a cache, and a genuine empty feed.  Existing cache files may be purged by iOS; the no-cache error state remains valid.

Deliver through the existing iOS archive/TestFlight/App Store path after signing and device verification.  A repository merge or backend deployment does not install the widget redesign on an iPhone.  This change needs no backend deployment, migration, or production ingestion job.
