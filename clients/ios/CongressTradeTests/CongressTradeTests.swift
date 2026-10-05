import AuthenticationServices
import Foundation
import StoreKit
import SwiftData
import SwiftUI
import UIKit
import XCTest
@testable import CongressTrade

final class CongressTradeTests: XCTestCase {
    override func tearDown() {
        // Nilling bumps MockURLProtocol's generation so a leftover URLSession
        // callback from this case cannot run the next case's handler — and
        // startLoading no longer XCTUnwraps a nil handler onto whoever is
        // running (the `testFeedQueryEmitsTypeForBuySellFilter` crash).
        MockURLProtocol.handler = nil
        super.tearDown()
    }

    /// Thread-safe per-path URL capture (#1549). `refresh()` and
    /// `refreshTrends()` fire concurrently; a single `var feedURL` written
    /// from every request races and intermittently reads an analytics URL.
    private final class RequestCapture: @unchecked Sendable {
        private let lock = NSLock()
        private var urls: [URL] = []

        func record(_ url: URL?) {
            guard let url else { return }
            lock.lock()
            urls.append(url)
            lock.unlock()
        }

        func last(pathContains needle: String) -> URL? {
            lock.lock()
            defer { lock.unlock() }
            return urls.last { $0.path.contains(needle) }
        }

        func all(pathContains needle: String) -> [URL] {
            lock.lock()
            defer { lock.unlock() }
            return urls.filter { $0.path.contains(needle) }
        }
    }

    private func installFeedMock(capture: RequestCapture, feedJSON: String? = nil) {
        MockURLProtocol.handler = { request in
            capture.record(request.url)
            if request.url?.path.hasSuffix("/bootstrap") == true {
                return Self.response(for: request, json: Self.bootstrapJSON)
            }
            if request.url?.path.contains("/feed") == true {
                return Self.response(
                    for: request,
                    json: feedJSON ?? Self.feedJSON(items: [], cursor: 0, count: 0, total: 0, limit: 50)
                )
            }
            return Self.response(for: request, json: "{}")
        }
    }

    func testAppUpdateVersionOrdering() {
        XCTAssertGreaterThan(AppUpdatePrompt.Version("1.0.10"), AppUpdatePrompt.Version("1.0.9"))
        XCTAssertEqual(AppUpdatePrompt.Version("1.0.0"), AppUpdatePrompt.Version("1.0"))
        XCTAssertTrue(AppUpdatePrompt.isNewer(
            latestMarketing: "1.0.68",
            latestBuild: nil,
            currentMarketing: "1.0.50",
            currentBuild: "1"
        ))
        XCTAssertFalse(AppUpdatePrompt.isNewer(
            latestMarketing: "1.0.8",
            latestBuild: "9",
            currentMarketing: "1.0.8",
            currentBuild: "10"
        ))
        XCTAssertTrue(AppUpdatePrompt.isNewer(
            latestMarketing: "1.0.8",
            latestBuild: "202608211800",
            currentMarketing: "1.0.8",
            currentBuild: "202608201800"
        ))
    }

    func testParseTickersNormalizesAndDropsEmptyValues() async {
        let tickers = await CongressTradeStore.parseTickers(" aapl, MSFT, , nvda \n")
        XCTAssertEqual(tickers, ["AAPL", "MSFT", "NVDA"])
    }

    func testCompactFormatUsdRollsBillionsUpToTrillions() {
        // A market cap like $3,622,500,000,000 previously rendered as
        // "$3622.5b" because CompactFormat.usd had no >= 1e12 branch.
        XCTAssertEqual(CompactFormat.usd(3_622_500_000_000), "$3.62t")
        XCTAssertEqual(CompactFormat.usd(1_000_000_000_000), "$1.00t")
        XCTAssertEqual(CompactFormat.usd(-2_500_000_000_000), "-$2.50t")
        // Existing billions/millions/thousands precision stays untouched.
        XCTAssertEqual(CompactFormat.usd(3_500_000_000), "$3.5b")
        XCTAssertEqual(CompactFormat.usd(23_000_000_000), "$23b")
    }

    func testDirectoryNameSortLabelIsNameNotPolitician() {
        XCTAssertEqual(MemberDirectorySearch.SortKey.name.label, "Name")
        XCTAssertEqual(MemberDirectorySearch.SortKey.chamber.label, "Branch")
        XCTAssertEqual(MemberDirectorySearch.SortKey.trades.label, "Trades")
        XCTAssertEqual(AssetDirectorySearch.SortKey.name.label, "Asset")
    }

    func testTimeRangeLabelsMatchWebsiteWithoutPastPrefix() {
        XCTAssertEqual(TimeRange.thirtyDays.label, "1 Month")
        XCTAssertEqual(TimeRange.ninetyDays.label, "3 Months")
        XCTAssertEqual(TimeRange.all.label, "All Time")
        for range in TimeRange.allCases {
            XCTAssertFalse(range.label.hasPrefix("Past "), "\(range.rawValue) still says Past")
        }
    }

    func testSiteFooterDisclaimerIsOneCombinedLine() {
        let line = AppTheme.siteFooterDisclaimer
        XCTAssertTrue(line.contains("  ·  "))
        XCTAssertTrue(line.contains("(2012)"))
        XCTAssertTrue(line.hasSuffix("agency"))
        XCTAssertFalse(line.hasSuffix("."))
        XCTAssertTrue(line.contains("independent/private service not affiliated"))
    }

    func testHeaderChromeIsOpaqueCardNotTranslucentPanel() {
        let lightTraits = UITraitCollection(userInterfaceStyle: .light)
        let darkTraits = UITraitCollection(userInterfaceStyle: .dark)
        // Solid header/filter chrome in both light and dark.
        XCTAssertEqual(UIColor(AppTheme.headerChrome).resolvedColor(with: lightTraits).cgColor.alpha, 1.0, accuracy: 0.001)
        XCTAssertEqual(UIColor(AppTheme.card).resolvedColor(with: lightTraits).cgColor.alpha, 1.0, accuracy: 0.001)
        XCTAssertLessThan(UIColor(AppTheme.panel).resolvedColor(with: lightTraits).cgColor.alpha, 0.99)
        XCTAssertEqual(UIColor(AppTheme.headerChrome).resolvedColor(with: darkTraits).cgColor.alpha, 1.0, accuracy: 0.001)
        XCTAssertEqual(UIColor(AppTheme.card).resolvedColor(with: darkTraits).cgColor.alpha, 1.0, accuracy: 0.001)
    }

    func testSignedFlowFormatUsesUnicodeMinusOnOneLine() {
        XCTAssertEqual(SignedFlowFormat.usd(1_200_000), "+$1.2m")
        XCTAssertEqual(SignedFlowFormat.usd(-178_300_000), "\u{2212}$178.3m")
        XCTAssertEqual(SignedFlowFormat.usd(0), "$0")
        XCTAssertEqual(SignedFlowFormat.usd(nil), "—")
    }

    func testNameInitialsMatchWebAvatarFallback() {
        XCTAssertEqual("Ro Khanna".nameInitials, "RK")
        XCTAssertEqual("Pelosi".nameInitials, "PE")
        XCTAssertEqual("".nameInitials, "?")
    }

    func testTopPerformersScopeLineUsesFivePlusAndCapPerTrade() {
        let line = TrendsView.performersScopeLine()
        XCTAssertEqual(line, "5+ buys  •  stocks only  •  +/-200% cap per trade")
        XCTAssertFalse(line.contains("minimum"))
        XCTAssertFalse(line.contains("capped at"))
        XCTAssertFalse(line.contains("Past"))
    }

    func testWhatIsBeingTradedRanksByCountOrDollarsWithoutARowNumber() {
        func item(_ ticker: String, trades: Int, volume: Double) -> TickerLeaderboardItem {
            TickerLeaderboardItem(
                ticker: ticker,
                name: ticker,
                tradeCount: trades,
                buyCount: trades,
                sellCount: 0,
                memberCount: 1,
                estVolumeUsd: volume,
                estNetFlowUsd: volume
            )
        }
        let rows = [
            item("AAA", trades: 3, volume: 9_000_000),
            item("BBB", trades: 10, volume: 1_000),
            item("CCC", trades: 4, volume: 500_000),
        ]
        XCTAssertEqual(
            TrendsView.rankedTickers(rows, metric: .count).map(\.ticker),
            ["BBB", "CCC", "AAA"]
        )
        XCTAssertEqual(
            TrendsView.rankedTickers(rows, metric: .dollars).map(\.ticker),
            ["AAA", "CCC", "BBB"]
        )
    }

    func testDisclosureTimelinessOmitsInThisWindow() {
        let line = TrendsView.timelinessBasis(count: 1868)
        XCTAssertTrue(line.hasPrefix("9 in 10 filings land inside the P90 figure.  Based on "))
        XCTAssertTrue(line.hasSuffix(" disclosed trades."))
        XCTAssertFalse(line.contains("in this window"))
    }

    func testMemberPhotoURLPrefersAPIThenSeedAndIgnoresRelativePaths() {
        let api = "https://congress.trade/api/photos/member?key=K000389"
        let seed = "https://example.test/seed.jpg"
        XCTAssertEqual(MemberPhotoURL.resolve(api, seed)?.absoluteString, api)
        XCTAssertEqual(MemberPhotoURL.resolve(nil, seed)?.absoluteString, seed)
        XCTAssertNil(MemberPhotoURL.resolve("/api/photos/member?key=K000389", ""))
        XCTAssertNil(MemberPhotoURL.resolve(nil, nil))
    }

    func testActiveOnlySubscriptionCommandPreservesFilters() async throws {
        let session = makeSession()
        let client = CongressTradeAPIClient(
            baseURL: URL(string: "https://example.test/api/client/v1")!,
            tokenStore: MemoryTokenStore(token: "native-session"),
            session: session
        )
        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Idempotency-Key"), "intent-123")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer native-session")
            let body = try XCTUnwrap(Self.requestBody(request))
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
            let payload = try XCTUnwrap(json["payload"] as? [String: Any])
            XCTAssertEqual(payload["id"] as? String, "sub_1")
            XCTAssertEqual(payload["active"] as? Bool, false)
            XCTAssertNil(payload["filters"], "Pause/resume must not replace the subscription filters")
            return Self.response(
                for: request,
                json: """
                {
                  "command": {
                    "id": "cmd_1", "userId": "user_1", "type": "update_subscription",
                    "status": "succeeded", "idempotencyKey": "intent-123", "error": null,
                    "createdAt": "2026-07-11T00:00:00Z", "updatedAt": "2026-07-11T00:00:00Z",
                    "startedAt": "2026-07-11T00:00:00Z", "finishedAt": "2026-07-11T00:00:01Z"
                  },
                  "result": { "subscription": {
                    "id": "sub_1", "delivery": "sse", "targetUrl": null,
                    "filters": { "tickers": ["AAPL"] }, "cursor": 0, "active": false,
                    "createdAt": "2026-07-11T00:00:00Z", "hasSecret": true
                  }}
                }
                """
            )
        }

        let result = try await client.setSubscriptionActive(
            id: "sub_1",
            active: false,
            idempotencyKey: "intent-123"
        )
        XCTAssertEqual(result.result?.subscription.filters.tickers, ["AAPL"])
        XCTAssertFalse(try XCTUnwrap(result.result?.subscription.active))
    }

    func testPreferencesLoadUsesServerWatchlist() async throws {
        let session = makeSession()
        let client = CongressTradeAPIClient(
            baseURL: URL(string: "https://example.test/api/client/v1")!,
            tokenStore: MemoryTokenStore(token: nil),
            session: session
        )
        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/client/v1/preferences")
            return Self.response(
                for: request,
                json: """
                {"preferences": {
                  "userId": "user_1", "savedFilters": {}, "watchlist": ["TSLA", "AMD"],
                  "notificationSettings": {}, "defaultWindow": "all",
                  "updatedAt": "2026-07-11T00:00:00Z"
                }}
                """
            )
        }

        let response = try await client.preferences()
        XCTAssertEqual(response.preferences.watchlist, ["TSLA", "AMD"])
        XCTAssertEqual(PushSettings(from: response.preferences.notificationSettings).mode, .filings)
    }

    func testPushSettingsParseWatchlistRulesAndAmountLabels() {
        let json: [String: JSONValue] = [
            "pushMode": .string("watchlist"),
            "watchlistRules": .object([
                "nvda": .object([
                    "minAmount": .number(50001),
                    "sides": .string("buys"),
                ]),
            ]),
        ]
        let settings = PushSettings(from: json)
        XCTAssertEqual(settings.mode, .watchlist)
        XCTAssertEqual(settings.watchlistRules["NVDA"]?.minAmount, 50001)
        XCTAssertEqual(settings.watchlistRules["NVDA"]?.sides, .buys)
        XCTAssertEqual(PushSettings.amountLabel(nil), "None")
        XCTAssertEqual(PushSettings.amountLabel(15001), "$15k")
        XCTAssertEqual(PushSettings.amountCutoffs.first, 1001)
        XCTAssertEqual(PushAlertMode.allCases.map(\.label), ["Off", "New Filings", "Watchlist"])
    }

    func testRelativeStreamURLResolvesAgainstAPIOrigin() {
        let client = CongressTradeAPIClient(
            baseURL: URL(string: "https://example.test/api/client/v1")!,
            tokenStore: MemoryTokenStore(token: nil)
        )
        XCTAssertEqual(
            client.absoluteClientURL("/api/stream?subscription=sub_1&token=secret"),
            "https://example.test/api/stream?subscription=sub_1&token=secret"
        )

        let localClient = CongressTradeAPIClient(
            baseURL: URL(string: "http://127.0.0.1:8787/api/client/v1")!,
            tokenStore: MemoryTokenStore(token: nil)
        )
        XCTAssertEqual(
            localClient.absoluteClientURL("/api/stream?subscription=sub_1"),
            "http://127.0.0.1:8787/api/stream?subscription=sub_1"
        )
    }

    // MARK: - SubscriptionFilters Codable round-trip (item 4)

    func testSubscriptionFiltersRoundTripsAllDocumentedFields() throws {
        let filters = SubscriptionFilters(
            members: ["B000944"],
            tickers: ["AAPL"],
            chambers: ["house", "senate"],
            minAmount: 1001,
            maxAmount: 50000,
            sides: ["B"],
            sectors: ["Technology"],
            marketCapBuckets: ["mega", "large"]
        )
        let data = try JSONEncoder().encode(filters)
        let decoded = try JSONDecoder().decode(SubscriptionFilters.self, from: data)
        XCTAssertEqual(decoded, filters, "Every documented SubscriptionFilters field must survive an encode/decode round trip")
    }

    func testSubscriptionMemberSummaryNamesMembersAndFlagsUnmatchedEntries() throws {
        // `GET /api/client/v1/subscriptions` adds memberLabels (filer id -> name) and
        // unresolvedMembers (free text saved before names were resolved; board a6058af2).
        let json = """
        {"id":"sub_1","delivery":"sse","targetUrl":null,
         "filters":{"members":["P000197","S000510","C001047","Nancy Pelosii"]},
         "cursor":0,"active":true,"createdAt":"2026-01-01T00:00:00.000Z","hasSecret":true,
         "memberLabels":{"P000197":"Nancy Pelosi","S000510":"Adam Smith","C001047":"Shelley Moore Capito"},
         "unresolvedMembers":["Nancy Pelosii"]}
        """
        let sub = try JSONDecoder().decode(Subscription.self, from: Data(json.utf8))
        XCTAssertEqual(
            sub.memberSummary,
            "Members: Nancy Pelosi, Adam Smith +1 more · Not matched: Nancy Pelosii (delete and recreate this delivery)"
        )

        // No members filter, or an old server that sends no labels, must not break decoding.
        let plain = try JSONDecoder().decode(
            Subscription.self,
            from: Data("""
            {"id":"sub_2","delivery":"sse","filters":{},"cursor":0,"active":true,
             "createdAt":"2026-01-01T00:00:00.000Z","hasSecret":true}
            """.utf8)
        )
        XCTAssertNil(plain.memberSummary)
        let unlabeled = try JSONDecoder().decode(
            Subscription.self,
            from: Data("""
            {"id":"sub_3","delivery":"sse","filters":{"members":["EXEC-FRANK-J-BISIGNANO"]},"cursor":0,
             "active":true,"createdAt":"2026-01-01T00:00:00.000Z","hasSecret":true}
            """.utf8)
        )
        XCTAssertEqual(unlabeled.memberSummary, "Members: EXEC-FRANK-J-BISIGNANO")
    }

    func testSubscriptionFiltersDecodeDoesNotDropBackendOnlyFields() throws {
        // A subscription created elsewhere (e.g. the web/PWA client) with the
        // full filter set the backend documents in app/src/shared/types.ts.
        let json = """
        {"members":["B000944"],"tickers":["AAPL"],"chambers":["house"],
         "minAmount":1001,"maxAmount":50000,"sides":["P"],
         "sectors":["Technology"],"marketCapBuckets":["mega","large"]}
        """
        let decoded = try JSONDecoder().decode(SubscriptionFilters.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.maxAmount, 50000)
        XCTAssertEqual(decoded.sides, ["P"])
        XCTAssertEqual(decoded.sectors, ["Technology"])
        XCTAssertEqual(decoded.marketCapBuckets, ["mega", "large"])
    }

    // MARK: - Chamber filter honesty (item CT-AUD-010)

    @MainActor
    func testDefaultChamberSelectionMatchesBackendDefaultAndOmitsTheParam() async throws {
        let store = CongressTradeStore(
            api: CongressTradeAPIClient(baseURL: Self.baseURL, tokenStore: MemoryTokenStore(token: nil), session: makeSession()),
            cursorStore: InMemorySyncCursorStore(),
            sleeper: { _ in }
        )
        // Empty selection = website-style "no HSP chips selected" (all branches).
        XCTAssertEqual(store.selectedChambers, [])

        let capture = RequestCapture()
        installFeedMock(capture: capture)
        // Empty selection omits chamber= so unresolved-chamber rows stay in view.
        await store.setChamberSelection([])

        let components = try XCTUnwrap(URLComponents(url: XCTUnwrap(capture.last(pathContains: "/feed")), resolvingAgainstBaseURL: false))
        XCTAssertNil(
            components.queryItems?.first(where: { $0.name == "chamber" }),
            "Empty (all) selection must omit chamber= entirely so unresolved-chamber rows stay in view"
        )
    }

    @MainActor
    func testWidenedChamberSelectionSendsOneCanonicalSortedList() async throws {
        let store = CongressTradeStore(
            api: CongressTradeAPIClient(baseURL: Self.baseURL, tokenStore: MemoryTokenStore(token: nil), session: makeSession()),
            cursorStore: InMemorySyncCursorStore(),
            sleeper: { _ in }
        )
        let capture = RequestCapture()
        installFeedMock(capture: capture)
        // Selecting a proper subset (not all three) must send a sorted CSV.
        await store.setChamberSelection([.executive, .house])

        let components = try XCTUnwrap(URLComponents(url: XCTUnwrap(capture.last(pathContains: "/feed")), resolvingAgainstBaseURL: false))
        let chamberValue = components.queryItems?.first(where: { $0.name == "chamber" })?.value
        XCTAssertEqual(chamberValue, "executive,house")
    }

    @MainActor
    func testDeselectingTheLastChamberChipMeansAllBranches() async throws {
        let store = CongressTradeStore(
            api: CongressTradeAPIClient(baseURL: Self.baseURL, tokenStore: MemoryTokenStore(token: nil), session: makeSession()),
            cursorStore: InMemorySyncCursorStore(),
            sleeper: { _ in }
        )
        MockURLProtocol.handler = { request in
            if request.url?.path.hasSuffix("/bootstrap") == true {
                return Self.response(for: request, json: Self.bootstrapJSON)
            }
            return Self.response(for: request, json: Self.feedJSON(items: [], cursor: 0, count: 0, total: 0, limit: 50))
        }

        await store.setChamberSelection([.house])
        await store.setChamberSelection([])

        // Empty stays empty (= all branches), matching website party-chip UX.
        XCTAssertEqual(store.selectedChambers, [])
    }

    // MARK: - Feed snapshot load (newest-first window, not multi-page crawl)

    @MainActor
    func testRefreshLoadsSingleNewestFirstSnapshotWithTradeDateSortAndDefaultWindow() async throws {
        let cursorStore = InMemorySyncCursorStore()
        let capture = RequestCapture()
        installFeedMock(
            capture: capture,
            feedJSON: Self.feedJSON(
                items: (1...10).map { Self.tradeJSON(id: "a\($0)", cursor: 100 + $0) },
                cursor: 110, count: 10, total: 718, limit: 100
            )
        )

        let store = CongressTradeStore(
            api: CongressTradeAPIClient(baseURL: Self.baseURL, tokenStore: MemoryTokenStore(token: nil), session: makeSession()),
            cursorStore: cursorStore,
            sleeper: { _ in }
        )
        XCTAssertEqual(store.selectedTimeRange, .ninetyDays)
        await store.setChamberSelection([.house, .senate])

        XCTAssertEqual(capture.all(pathContains: "/feed").count, 1, "Visible feed is one newest-first snapshot, not a multi-page historical crawl")
        XCTAssertEqual(store.tradeTotal, 718, "Trades KPI must use API total, never max cursor_seq")
        XCTAssertEqual(store.feed?.cursor, 110)
        XCTAssertNil(store.feedNotice)

        let components = try XCTUnwrap(URLComponents(url: XCTUnwrap(capture.last(pathContains: "/feed")), resolvingAgainstBaseURL: false))
        let items = components.queryItems ?? []
        XCTAssertEqual(items.first(where: { $0.name == "order" })?.value, "desc")
        XCTAssertEqual(items.first(where: { $0.name == "sort" })?.value, "tx_date")
        XCTAssertNotNil(items.first(where: { $0.name == "from" })?.value, "Default 90d window must send from=")
        // Cursor watermark is keyed by chamber+range.
        XCTAssertEqual(cursorStore.cursor(for: "house,senate|90d|all"), 110)
    }

    @MainActor
    func testTimeRangeAllOmitsFromParameter() async throws {
        let capture = RequestCapture()
        installFeedMock(capture: capture, feedJSON: Self.feedJSON(items: [], cursor: 0, count: 0, total: 0, limit: 100))
        let store = CongressTradeStore(
            api: CongressTradeAPIClient(baseURL: Self.baseURL, tokenStore: MemoryTokenStore(token: nil), session: makeSession()),
            cursorStore: InMemorySyncCursorStore(),
            sleeper: { _ in }
        )
        await store.setTimeRange(.all)

        let components = try XCTUnwrap(URLComponents(url: XCTUnwrap(capture.last(pathContains: "/feed")), resolvingAgainstBaseURL: false))
        XCTAssertNil(components.queryItems?.first(where: { $0.name == "from" }))
    }

    // MARK: - Trades sort + pagination (owner punch list #2, items 7-8)

    @MainActor
    func testGoToNextPageSendsOffsetAndTotalPagesReflectsAPITotal() async throws {
        let capture = RequestCapture()
        installFeedMock(
            capture: capture,
            feedJSON: Self.feedJSON(
                items: (1...10).map { Self.tradeJSON(id: "a\($0)", cursor: 100 + $0) },
                cursor: 110, count: 10, total: 250, limit: 50
            )
        )

        let store = CongressTradeStore(
            api: CongressTradeAPIClient(baseURL: Self.baseURL, tokenStore: MemoryTokenStore(token: nil), session: makeSession()),
            cursorStore: InMemorySyncCursorStore(),
            sleeper: { _ in }
        )
        await store.refresh()

        XCTAssertEqual(store.totalPages, 5, "250 rows at the default 50/page rounds up to 5 pages")
        XCTAssertTrue(store.canGoToNextPage)
        XCTAssertFalse(store.canGoToPreviousPage)
        // The first page must not send offset= at all (page 1, not offset=0).
        let firstComponents = try XCTUnwrap(URLComponents(url: XCTUnwrap(capture.last(pathContains: "/feed")), resolvingAgainstBaseURL: false))
        XCTAssertNil(firstComponents.queryItems?.first(where: { $0.name == "offset" }))

        await store.goToNextPage()
        XCTAssertEqual(store.currentPage, 1)
        XCTAssertTrue(store.canGoToPreviousPage)

        let secondComponents = try XCTUnwrap(URLComponents(url: XCTUnwrap(capture.last(pathContains: "/feed")), resolvingAgainstBaseURL: false))
        XCTAssertEqual(secondComponents.queryItems?.first(where: { $0.name == "offset" })?.value, "50")

        await store.goToPreviousPage()
        XCTAssertEqual(store.currentPage, 0)
        XCTAssertFalse(store.canGoToPreviousPage)
    }

    @MainActor
    func testSwitchingToAmountSortDoesNotRefetchButSwitchingBackToDateDoes() async throws {
        let capture = RequestCapture()
        installFeedMock(capture: capture, feedJSON: Self.feedJSON(items: [], cursor: 0, count: 0, total: 0, limit: 100))
        let store = CongressTradeStore(
            api: CongressTradeAPIClient(baseURL: Self.baseURL, tokenStore: MemoryTokenStore(token: nil), session: makeSession()),
            cursorStore: InMemorySyncCursorStore(),
            sleeper: { _ in }
        )
        await store.refresh()
        XCTAssertEqual(capture.all(pathContains: "/feed").count, 1)

        // Amount has no backend sort key — selecting it must NOT refetch.
        await store.setFeedSortKey(.amount)
        XCTAssertEqual(store.feedSortKey, .amount)
        XCTAssertEqual(capture.all(pathContains: "/feed").count, 1, "Amount sort is a local re-sort of the already-loaded page only")

        // Flipping direction while on Amount is also local-only.
        await store.toggleFeedSortDirection()
        XCTAssertEqual(store.feedSortDirection, .ascending)
        XCTAssertEqual(capture.all(pathContains: "/feed").count, 1)

        // Switching back to Date DOES refetch (it's a real backend sort key)
        // and carries over the direction set while on Amount.
        await store.setFeedSortKey(.date)
        XCTAssertEqual(capture.all(pathContains: "/feed").count, 2)

        let components = try XCTUnwrap(URLComponents(url: XCTUnwrap(capture.last(pathContains: "/feed")), resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.queryItems?.first(where: { $0.name == "sort" })?.value, "tx_date")
        XCTAssertEqual(components.queryItems?.first(where: { $0.name == "order" })?.value, "asc")
    }

    @MainActor
    func testChangingATimeRangeResetsCurrentPageToZero() async throws {
        let capture = RequestCapture()
        installFeedMock(capture: capture, feedJSON: Self.feedJSON(items: [], cursor: 0, count: 0, total: 300, limit: 100))
        let store = CongressTradeStore(
            api: CongressTradeAPIClient(baseURL: Self.baseURL, tokenStore: MemoryTokenStore(token: nil), session: makeSession()),
            cursorStore: InMemorySyncCursorStore(),
            sleeper: { _ in }
        )
        await store.refresh()
        await store.goToNextPage()
        XCTAssertEqual(store.currentPage, 1)

        await store.setTimeRange(.thirtyDays)
        XCTAssertEqual(store.currentPage, 0, "A filter change must not strand the user on a now-out-of-range page")

        let components = try XCTUnwrap(URLComponents(url: XCTUnwrap(capture.last(pathContains: "/feed")), resolvingAgainstBaseURL: false))
        XCTAssertNil(components.queryItems?.first(where: { $0.name == "offset" }), "Page reset must omit offset (page 1)")
    }

    // MARK: - Client member profile decode

    /// Owner report (2026-08-09): opening Max Miller failed with
    /// "The data couldn't be read because it isn't in the correct format"
    /// because some private-fund rows ship fractional `amountMin`/`amountMax`
    /// (e.g. 982.18) while `Transaction` required strict Int.
    func testClientMemberResponseAcceptsFractionalAmountBrackets() throws {
        let json = """
        {
          "member": {
            "id": "house-oh07-max-miller",
            "name": "Max Miller",
            "chamber": "house",
            "party": "Republican",
            "state": "OH",
            "district": "7",
            "committees": [],
            "photoUrl": null
          },
          "summary": {
            "totalTrades": 2,
            "buyCount": 2,
            "sellCount": 0,
            "exchangeCount": 0,
            "estimatedVolumeUsd": 33300.5,
            "estimatedNetFlowUsd": 1000,
            "firstTrade": "2023-01-01",
            "lastTrade": "2023-06-29",
            "uniqueTickers": 1,
            "uniqueAssets": 2,
            "performance": {
              "tradeCount": 2,
              "scoredCount": 1,
              "winRate": 0.5,
              "medianReturn": 0.1,
              "medianExcess": -0.1,
              "avgReturn": 0.1,
              "avgExcess": -0.1,
              "avgAnnualizedExcess": null,
              "side": "buys",
              "buyCount": 2,
              "tradeDate": {
                "tradeCount": 2, "scoredCount": 1, "winRate": 0.5,
                "medianReturn": 0.1, "medianExcess": -0.1,
                "avgReturn": 0.1, "avgExcess": -0.1, "avgAnnualizedExcess": null
              },
              "filingDate": {
                "tradeCount": 2, "scoredCount": 1, "winRate": 0.5,
                "medianReturn": 0.1, "medianExcess": -0.1,
                "avgReturn": 0.1, "avgExcess": -0.1, "avgAnnualizedExcess": -0.05
              }
            }
          },
          "items": [
            {
              "id": "tx-int-bracket",
              "cursor": 1,
              "docId": "H-1",
              "member": {"id": "house-oh07-max-miller", "name": "Max Miller", "chamber": "house", "party": "Republican", "state": "OH"},
              "asset": {"name": "Elliot Associates, LP", "ticker": null, "type": null, "sector": null, "marketCapBucket": null},
              "transaction": {"date": "2023-06-29", "type": "B", "owner": "self", "amountMin": 15001, "amountMax": 50000, "estValue": 32500.5, "isOption": false},
              "filing": {"filedDate": "2023-07-12", "firstSeenAt": "2026-07-24T04:59:14.522Z", "sourceUrl": "https://example.test/doc.pdf"},
              "confidence": 0.85,
              "source": "primary"
            },
            {
              "id": "tx-float-bracket",
              "cursor": 2,
              "docId": "H-2",
              "member": {"id": "house-oh07-max-miller", "name": "Max Miller", "chamber": "house", "party": "Republican", "state": "OH"},
              "asset": {"name": "New Water Capital Partners Ii, LP", "ticker": null, "type": null},
              "transaction": {"date": "2023-01-15", "type": "B", "owner": "self", "amountMin": 982.18, "amountMax": 982.18, "estValue": 982.18, "isOption": false},
              "filing": {"filedDate": "2023-02-01", "firstSeenAt": null, "sourceUrl": null},
              "confidence": 1,
              "source": "primary"
            }
          ],
          "cursor": 2,
          "count": 2,
          "total": 2,
          "limit": 25
        }
        """
        let decoded = try JSONDecoder().decode(ClientMemberResponse.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.member.name, "Max Miller")
        XCTAssertEqual(decoded.member.committees, [])
        XCTAssertEqual(decoded.items.count, 2)
        XCTAssertEqual(decoded.items[0].transaction.amountMin, 15001)
        XCTAssertEqual(decoded.items[0].transaction.amountMax, 50000)
        // Fractional USD brackets round to nearest whole dollar.
        XCTAssertEqual(decoded.items[1].transaction.amountMin, 982)
        XCTAssertEqual(decoded.items[1].transaction.amountMax, 982)
        XCTAssertEqual(decoded.summary.performance?.tradeDate?.scoredCount, 1)
        XCTAssertEqual(decoded.summary.performance?.filingDate?.avgAnnualizedExcess, -0.05)
    }

    // MARK: - People directory (owner punch list #2, item 9)

    func testMembersDirectoryHitsOriginLevelMembersEndpointNotClientV1() async throws {
        let session = makeSession()
        let client = CongressTradeAPIClient(
            baseURL: Self.baseURL,
            tokenStore: MemoryTokenStore(token: nil),
            session: session
        )
        var requestedURL: URL?
        MockURLProtocol.handler = { request in
            requestedURL = request.url
            return Self.response(
                for: request,
                json: """
                {"members":[{"filerId":"P000197","fullName":"Jane Smith","chamber":"house",
                 "party":"Republican","state":"TX","district":"10","txCount":42,
                 "photoUrl":"https://example.test/photo.jpg"}],"count":1}
                """
            )
        }

        let response = try await client.membersDirectory()
        XCTAssertEqual(requestedURL?.path, "/api/members", "Roster is origin-level, not under /api/client/v1")
        XCTAssertEqual(response.members.first?.filerId, "P000197")
        XCTAssertEqual(response.members.first?.photoUrl, "https://example.test/photo.jpg")
    }

    @MainActor
    func testLoadMembersDirectoryPopulatesAndMemoizesUntilForced() async throws {
        var hitCount = 0
        MockURLProtocol.handler = { request in
            hitCount += 1
            return Self.response(
                for: request,
                json: #"{"members":[{"filerId":"P000197","fullName":"Jane Smith","chamber":"house","party":"Republican","state":"TX","district":null,"txCount":42,"photoUrl":null}],"count":1}"#
            )
        }

        let store = CongressTradeStore(
            api: CongressTradeAPIClient(baseURL: Self.baseURL, tokenStore: MemoryTokenStore(token: nil), session: makeSession()),
            cursorStore: InMemorySyncCursorStore(),
            sleeper: { _ in }
        )

        await store.loadMembersDirectory()
        XCTAssertEqual(hitCount, 1)
        XCTAssertEqual(store.members.count, 1)
        XCTAssertEqual(store.members.first?.filerId, "P000197")

        // Repeated calls within the TTL window reuse the cached roster.
        await store.loadMembersDirectory()
        XCTAssertEqual(hitCount, 1, "Roster should be memoized, not re-fetched on every tab visit")

        // force: true (pull-to-refresh) bypasses the cache.
        await store.loadMembersDirectory(force: true)
        XCTAssertEqual(hitCount, 2)
    }

    @MainActor
    func testTransientServerErrorIsRetriedWithBackoffThenSucceeds() async throws {
        var feedAttempts = 0
        var recordedDelays: [Double] = []
        MockURLProtocol.handler = { request in
            if request.url?.path.hasSuffix("/bootstrap") == true {
                return Self.response(for: request, json: Self.bootstrapJSON)
            }
            if request.url?.path.contains("/feed") != true {
                return Self.response(for: request, json: "{}")
            }
            feedAttempts += 1
            if feedAttempts == 1 {
                let response = HTTPURLResponse(url: request.url!, statusCode: 503, httpVersion: nil, headerFields: [:])!
                return (response, Data("{\"error\":\"try again\"}".utf8))
            }
            return Self.response(for: request, json: Self.feedJSON(items: [], cursor: 0, count: 0, total: 0, limit: 50))
        }

        let store = CongressTradeStore(
            api: CongressTradeAPIClient(baseURL: Self.baseURL, tokenStore: MemoryTokenStore(token: nil), session: makeSession()),
            cursorStore: InMemorySyncCursorStore(),
            sleeper: { seconds in recordedDelays.append(seconds) }
        )
        await store.refresh()

        XCTAssertEqual(feedAttempts, 2, "A transient 503 should be retried once before succeeding")
        XCTAssertEqual(recordedDelays.count, 1)
        XCTAssertNil(store.feedNotice)
    }

    @MainActor
    func testTrendsTransient502IsRetriedThenSucceeds() async throws {
        var summaryAttempts = 0
        var recordedDelays: [Double] = []
        MockURLProtocol.handler = { request in
            if request.url?.path.contains("/api/analytics/summary") == true {
                summaryAttempts += 1
                if summaryAttempts == 1 {
                    let response = HTTPURLResponse(
                        url: request.url!,
                        statusCode: 502,
                        httpVersion: nil,
                        headerFields: [:]
                    )!
                    return (response, Data("{\"error\":\"Request failed\"}".utf8))
                }
                return Self.response(for: request, json: #"{"totalTrades":4}"#)
            }
            return Self.trendsEndpointResponse(for: request)
        }

        let store = CongressTradeStore(
            api: CongressTradeAPIClient(baseURL: Self.baseURL, tokenStore: MemoryTokenStore(token: nil), session: makeSession()),
            cursorStore: InMemorySyncCursorStore(),
            sleeper: { seconds in recordedDelays.append(seconds) }
        )
        await store.refreshTrends()

        XCTAssertEqual(summaryAttempts, 2, "A transient Trends 502 should be retried once before succeeding")
        XCTAssertEqual(recordedDelays.count, 1)
        XCTAssertNil(store.trendsNotice)
        XCTAssertEqual(store.analyticsSummary?.totalTrades, 4)
    }

    @MainActor
    func testTrendsExhausted502UsesHumanCopyNotRequestFailed() async throws {
        var summaryAttempts = 0
        MockURLProtocol.handler = { request in
            if request.url?.path.contains("/api/analytics/summary") == true {
                summaryAttempts += 1
                let response = HTTPURLResponse(
                    url: request.url!,
                    statusCode: 502,
                    httpVersion: nil,
                    headerFields: [:]
                )!
                return (response, Data("{\"error\":\"Request failed\"}".utf8))
            }
            return Self.trendsEndpointResponse(for: request)
        }

        let store = CongressTradeStore(
            api: CongressTradeAPIClient(baseURL: Self.baseURL, tokenStore: MemoryTokenStore(token: nil), session: makeSession()),
            cursorStore: InMemorySyncCursorStore(),
            sleeper: { _ in }
        )
        await store.refreshTrends()

        XCTAssertEqual(summaryAttempts, 3)
        XCTAssertEqual(store.trendsNotice, "The site is updating (502).  Pull to refresh.")
        XCTAssertFalse((store.trendsNotice ?? "").contains("Request failed"))
    }

    @MainActor
    func testInboundTrade404UsesHonestNotFoundCopy() async throws {
        MockURLProtocol.handler = { request in
            XCTAssertTrue(request.url?.path.hasSuffix("/trade/missing") == true)
            let response = HTTPURLResponse(url: request.url!, statusCode: 404, httpVersion: nil, headerFields: [:])!
            return (response, Data("{\"error\":\"trade not found\"}".utf8))
        }

        let store = CongressTradeStore(
            api: CongressTradeAPIClient(baseURL: Self.baseURL, tokenStore: MemoryTokenStore(token: nil), session: makeSession()),
            cursorStore: InMemorySyncCursorStore(),
            sleeper: { _ in }
        )
        let trade = await store.fetchInboundTrade(id: "missing")

        XCTAssertNil(trade)
        XCTAssertEqual(
            store.feedNotice,
            "That trade was not found.  It may have been retracted or the share link is outdated."
        )
    }

    @MainActor
    func testMemberRequestPutsSortOnTheQueryNotThePath() async throws {
        // Regression: get("member/id?sort=tx_date") encoded `?` into the path
        // and the server 404'd "member not found" on the first politician tap.
        let seen = expectation(description: "member request")
        MockURLProtocol.handler = { request in
            let url = request.url!
            XCTAssertTrue(url.path.hasSuffix("/member/C001047"), url.path)
            XCTAssertFalse(url.path.contains("sort"), url.path)
            XCTAssertFalse(url.absoluteString.contains("%3F"), url.absoluteString)
            let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            XCTAssertEqual(items.first(where: { $0.name == "sort" })?.value, "tx_date")
            XCTAssertEqual(items.first(where: { $0.name == "order" })?.value, "desc")
            seen.fulfill()
            return Self.response(
                for: request,
                json: """
                {"member":{"id":"C001047","name":"Shelley Moore Capito"},"summary":{},"items":[]}
                """
            )
        }
        let api = CongressTradeAPIClient(
            baseURL: Self.baseURL,
            tokenStore: MemoryTokenStore(token: nil),
            session: makeSession()
        )
        _ = try await api.member(id: "C001047")
        await fulfillment(of: [seen], timeout: 1)
    }

    @MainActor
    func testPermanentClientErrorIsNotRetried() async throws {
        var feedAttempts = 0
        MockURLProtocol.handler = { request in
            if request.url?.path.hasSuffix("/bootstrap") == true {
                return Self.response(for: request, json: Self.bootstrapJSON)
            }
            if request.url?.path.contains("/feed") != true {
                return Self.response(for: request, json: "{}")
            }
            feedAttempts += 1
            let response = HTTPURLResponse(url: request.url!, statusCode: 400, httpVersion: nil, headerFields: [:])!
            return (response, Data("{\"error\":\"bad request\"}".utf8))
        }

        let store = CongressTradeStore(
            api: CongressTradeAPIClient(baseURL: Self.baseURL, tokenStore: MemoryTokenStore(token: nil), session: makeSession()),
            cursorStore: InMemorySyncCursorStore(),
            sleeper: { _ in XCTFail("A permanent 4xx must not trigger a backoff sleep") }
        )
        await store.refresh()

        XCTAssertEqual(feedAttempts, 1)
        XCTAssertEqual(store.feedNotice, "bad request")
    }

    // MARK: - Deprecated-row reconciliation (CT-AUD-009)

    @MainActor
    func testReconcileIfDeprecatedRemovesA404TradeFromTheLocalCache() async throws {
        MockURLProtocol.handler = { request in
            XCTAssertTrue(request.url?.path.hasSuffix("/trade/tx_1") == true)
            let response = HTTPURLResponse(url: request.url!, statusCode: 404, httpVersion: nil, headerFields: [:])!
            return (response, Data("{\"error\":\"trade not found\"}".utf8))
        }

        let store = CongressTradeStore(
            api: CongressTradeAPIClient(baseURL: Self.baseURL, tokenStore: MemoryTokenStore(token: nil), session: makeSession()),
            cursorStore: InMemorySyncCursorStore(),
            sleeper: { _ in }
        )
        let context = try Self.makeInMemoryModelContext()
        store.modelContext = context
        let trade = Self.makeTrade(id: "tx_1", cursor: 1)
        context.insert(trade)
        try context.save()

        let removed = await store.reconcileIfDeprecated(trade)

        XCTAssertTrue(removed)
        XCTAssertNotNil(store.feedNotice)
        XCTAssertTrue(try context.fetch(FetchDescriptor<ClientTrade>()).isEmpty)
    }

    @MainActor
    func testReconcileIfDeprecatedLeavesAStillLiveTradeCached() async throws {
        MockURLProtocol.handler = { request in
            Self.response(for: request, json: "{}")
        }

        let store = CongressTradeStore(
            api: CongressTradeAPIClient(baseURL: Self.baseURL, tokenStore: MemoryTokenStore(token: nil), session: makeSession()),
            cursorStore: InMemorySyncCursorStore(),
            sleeper: { _ in }
        )
        let context = try Self.makeInMemoryModelContext()
        store.modelContext = context
        let trade = Self.makeTrade(id: "tx_1", cursor: 1)
        context.insert(trade)
        try context.save()

        let removed = await store.reconcileIfDeprecated(trade)

        XCTAssertFalse(removed)
        XCTAssertEqual(try context.fetch(FetchDescriptor<ClientTrade>()).count, 1)
    }

    // MARK: - Sign in with Apple + StoreKit 2 redeem command

    func testAppleSignInNoticeMapsUnavailableAndSilentDeviceCancel() {
        let unavailable = NSError(domain: "AKAuthenticationError", code: -7003)
        XCTAssertEqual(
            AppleSignInNotice.message(for: unavailable),
            AppleSignInNotice.unavailableMessage
        )

        let canceled = ASAuthorizationError(.canceled)
        #if targetEnvironment(simulator)
        XCTAssertEqual(
            AppleSignInNotice.message(for: canceled),
            AppleSignInNotice.simulatorCanceledMessage
        )
        #else
        XCTAssertNil(AppleSignInNotice.message(for: canceled))
        #endif

        let wrapped = NSError(
            domain: ASAuthorizationError.errorDomain,
            code: ASAuthorizationError.Code.canceled.rawValue,
            userInfo: [NSUnderlyingErrorKey: unavailable]
        )
        XCTAssertEqual(
            AppleSignInNotice.message(for: wrapped),
            AppleSignInNotice.unavailableMessage
        )
    }

    func testSignInWithAppleSendsIdentityTokenAndFullNameToAuthOrigin() async throws {
        let session = makeSession()
        let client = CongressTradeAPIClient(
            baseURL: Self.baseURL,
            tokenStore: MemoryTokenStore(token: nil),
            session: session
        )
        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.absoluteString, "https://example.test/auth/apple")
            XCTAssertEqual(request.httpMethod, "POST")
            let body = try XCTUnwrap(Self.requestBody(request))
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
            XCTAssertEqual(json["identityToken"] as? String, "identity-jwt")
            XCTAssertEqual(json["fullName"] as? String, "Ada Lovelace")
            XCTAssertNil(json["nonce"], "nonce must be omitted when the caller didn't set one")
            return Self.response(
                for: request,
                json: """
                {
                  "ok": true, "token": "native-session-token",
                  "user": { "id": "user_1", "email": "ada@example.com", "name": "Ada Lovelace", "picture": null },
                  "entitlement": { "premium": false, "status": null, "plan": null }
                }
                """
            )
        }

        let response = try await client.signInWithApple(identityToken: "identity-jwt", fullName: "Ada Lovelace")
        XCTAssertEqual(response.token, "native-session-token")
        XCTAssertEqual(response.user.email, "ada@example.com")
        XCTAssertEqual(response.entitlement?.premium, false)
    }

    func testRedeemApplePurchaseSendsTheSignedTransactionCommand() async throws {
        let session = makeSession()
        let client = CongressTradeAPIClient(
            baseURL: Self.baseURL,
            tokenStore: MemoryTokenStore(token: "native-session"),
            session: session
        )
        MockURLProtocol.handler = { request in
            let body = try XCTUnwrap(Self.requestBody(request))
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
            XCTAssertEqual(json["type"] as? String, "redeem_apple_purchase")
            let payload = try XCTUnwrap(json["payload"] as? [String: Any])
            XCTAssertEqual(payload["signedTransaction"] as? String, "jws-blob")
            return Self.response(
                for: request,
                json: """
                {
                  "command": {
                    "id": "cmd_2", "userId": "user_1", "type": "redeem_apple_purchase",
                    "status": "succeeded", "idempotencyKey": "redeem-1", "error": null,
                    "createdAt": "2026-08-09T00:00:00Z", "updatedAt": "2026-08-09T00:00:00Z",
                    "startedAt": "2026-08-09T00:00:00Z", "finishedAt": "2026-08-09T00:00:01Z"
                  },
                  "result": {
                    "entitlement": { "premium": true, "status": "active", "plan": "monthly", "source": "apple" },
                    "plan": "monthly", "expiresAt": "2026-09-09T00:00:00Z",
                    "originalTransactionId": "txn_original_1"
                  }
                }
                """
            )
        }

        let response = try await client.redeemApplePurchase(signedTransaction: "jws-blob", idempotencyKey: "redeem-1")
        XCTAssertEqual(response.result?.originalTransactionId, "txn_original_1")
        XCTAssertEqual(response.result?.entitlement?.premium, true)
        XCTAssertEqual(response.result?.entitlement?.source, "apple")
    }

    func testRedeemApplePurchaseSurfacesAFailedCommandAsAnError() async throws {
        let session = makeSession()
        let client = CongressTradeAPIClient(
            baseURL: Self.baseURL,
            tokenStore: MemoryTokenStore(token: "native-session"),
            session: session
        )
        MockURLProtocol.handler = { request in
            Self.response(
                for: request,
                json: """
                {
                  "command": {
                    "id": "cmd_3", "userId": "user_1", "type": "redeem_apple_purchase",
                    "status": "failed", "idempotencyKey": "redeem-2",
                    "error": "this Apple subscription is already linked to a different account",
                    "createdAt": "2026-08-09T00:00:00Z", "updatedAt": "2026-08-09T00:00:00Z",
                    "startedAt": "2026-08-09T00:00:00Z", "finishedAt": "2026-08-09T00:00:01Z"
                  },
                  "result": null
                }
                """
            )
        }

        do {
            _ = try await client.redeemApplePurchase(signedTransaction: "jws-blob", idempotencyKey: "redeem-2")
            XCTFail("Expected a failed-command error")
        } catch let error as APIError {
            XCTAssertEqual(
                error.errorDescription,
                "this Apple subscription is already linked to a different account"
            )
        }
    }

    /// `POST /entitlements/apple/redeem` (the anonymous route
    /// `refreshAppleEntitlementOwnership` reuses as a READ-ONLY row-3/row-4
    /// probe while signed in — `Store/AppleIAP.swift`) reports a `409` for a
    /// transaction some other account already owns. Locks that the API
    /// client surfaces it as a normal thrown error the caller can inspect,
    /// not a decoded "success" body — the thing `PremiumAccessGate.ownership
    /// (afterProbe:)` depends on to tell rows 3 and 4 apart.
    func testRedeemAppleEntitlementAnonymouslyThrowsOn409OwnerMismatch() async throws {
        let session = makeSession()
        let client = CongressTradeAPIClient(
            baseURL: Self.baseURL,
            tokenStore: MemoryTokenStore(token: nil),
            session: session
        )
        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/client/v1/entitlements/apple/redeem")
            return Self.response(
                for: request,
                status: 409,
                json: """
                {"error":"this Apple subscription is already linked to a different account","upgradeRequired":false}
                """
            )
        }

        do {
            _ = try await client.redeemAppleEntitlementAnonymously(signedTransaction: "jws-blob")
            XCTFail("Expected the 409 to throw")
        } catch let error as APIError {
            guard case .server(let status, let message, _) = error else {
                return XCTFail("Expected .server, got \(error)")
            }
            XCTAssertEqual(status, 409)
            XCTAssertEqual(message, "this Apple subscription is already linked to a different account")
        }
    }

    // MARK: - Account-linked Apple entitlement (owner directive 2026-08-21)
    //
    // "It should be linked to an account which can be used via website or
    // iOS app both." Premium belongs to the ACCOUNT; a device's Apple
    // purchase must never make every signed-in account look Premium.
    // `PremiumAccessGate` (`Store/AppleIAP.swift`) is the pure truth table
    // gate — tested directly here without StoreKit or the Store's async
    // orchestration.

    /// Row 1: signed OUT + a verified, unclaimed device purchase must still
    /// resolve as Premium (Guideline 5.1.1(v)) — must not regress.
    func testPremiumAccessGateGrantsSignedOutDeviceEntitlement() {
        XCTAssertTrue(PremiumAccessGate.granted(
            isPremium: false,
            signedIn: false,
            hasLocalAppleEntitlement: true,
            ownership: .unknown
        ))
    }

    /// Row 2: signed in + server Premium is always granted, regardless of
    /// the device's own entitlement state.
    func testPremiumAccessGateGrantsSignedInServerPremium() {
        XCTAssertTrue(PremiumAccessGate.granted(
            isPremium: true,
            signedIn: true,
            hasLocalAppleEntitlement: false,
            ownership: .linkedToOtherAccount
        ))
    }

    /// Row 3 — the regression this change exists to fix: a signed-in FREE
    /// account must not get Premium access just because this device's Apple
    /// purchase happens to be owned by a DIFFERENT account. This is the case
    /// that used to leak through the old `isPremium || hasLocalAppleEntitlement`
    /// OR-gate at `FeedDashboardView.swift:1241`, `TradeDetailView.swift:325`,
    /// and `CongressTradeStore.exportCSV`.
    func testPremiumAccessGateRefusesForeignDeviceEntitlementWhileSignedIn() {
        XCTAssertFalse(PremiumAccessGate.granted(
            isPremium: false,
            signedIn: true,
            hasLocalAppleEntitlement: true,
            ownership: .linkedToOtherAccount
        ))
    }

    /// Row 4: signed in, server free, device purchase unclaimed (or the
    /// ownership probe has not resolved yet) — grant access so a payer is
    /// never stranded while they decide whether to link it.
    func testPremiumAccessGateGrantsUnclaimedDeviceEntitlementWhileSignedIn() {
        XCTAssertTrue(PremiumAccessGate.granted(
            isPremium: false,
            signedIn: true,
            hasLocalAppleEntitlement: true,
            ownership: .unclaimed
        ))
        XCTAssertTrue(PremiumAccessGate.granted(
            isPremium: false,
            signedIn: true,
            hasLocalAppleEntitlement: true,
            ownership: .unknown
        ))
    }

    /// Baseline: no device entitlement at all, free — never granted, signed
    /// in or out.
    func testPremiumAccessGateRefusesPlainFreeAccount() {
        XCTAssertFalse(PremiumAccessGate.granted(
            isPremium: false,
            signedIn: true,
            hasLocalAppleEntitlement: false,
            ownership: .unknown
        ))
        XCTAssertFalse(PremiumAccessGate.granted(
            isPremium: false,
            signedIn: false,
            hasLocalAppleEntitlement: false,
            ownership: .unknown
        ))
    }

    /// Row 4's "Link this subscription?" ask shows only once the probe
    /// resolves unclaimed and only until "Not now" is remembered for this
    /// account; row 3's plain conflict message shows only once resolved
    /// linked-elsewhere. Neither shows while still unresolved or once the
    /// account is already Premium.
    func testPremiumAccessGateLinkOfferAndConflictVisibility() {
        XCTAssertTrue(PremiumAccessGate.showsLinkOffer(
            isPremium: false, signedIn: true, hasLocalAppleEntitlement: true,
            ownership: .unclaimed, dismissedForAccount: false
        ))
        XCTAssertFalse(PremiumAccessGate.showsLinkOffer(
            isPremium: false, signedIn: true, hasLocalAppleEntitlement: true,
            ownership: .unclaimed, dismissedForAccount: true
        ), "a remembered 'Not now' must not nag again")
        XCTAssertFalse(PremiumAccessGate.showsLinkOffer(
            isPremium: false, signedIn: true, hasLocalAppleEntitlement: true,
            ownership: .unknown, dismissedForAccount: false
        ), "never asks before the read-only ownership probe has resolved")
        XCTAssertFalse(PremiumAccessGate.showsLinkOffer(
            isPremium: true, signedIn: true, hasLocalAppleEntitlement: true,
            ownership: .unclaimed, dismissedForAccount: false
        ), "already Premium — nothing left to link")

        XCTAssertTrue(PremiumAccessGate.showsConflict(
            isPremium: false, signedIn: true, hasLocalAppleEntitlement: true,
            ownership: .linkedToOtherAccount
        ))
        XCTAssertFalse(PremiumAccessGate.showsConflict(
            isPremium: false, signedIn: false, hasLocalAppleEntitlement: true,
            ownership: .linkedToOtherAccount
        ), "signed out never shows an account conflict — there is no account yet")
    }

    /// The core regression this change exists to fix, expressed at the
    /// boundary: `linkAppleEntitlementIfNeeded` used to `try?` away a `409`
    /// from `link_apple_entitlement` ("already linked to a different
    /// account"). `PremiumAccessGate.ownership(afterProbe:)` is what
    /// replaced that swallow — a `409` must surface as
    /// `.linkedToOtherAccount`, never silently vanish, and a transient
    /// failure (offline, 5xx) must never be misreported as a conflict (that
    /// would wrongly gate out a legitimate unclaimed payer).
    func testOwnershipProbeSurfacesThe409ConflictInsteadOfSwallowingIt() {
        XCTAssertEqual(PremiumAccessGate.ownership(afterProbe: .success(())), .unclaimed)
        XCTAssertEqual(
            PremiumAccessGate.ownership(afterProbe: .failure(
                APIError.server(
                    status: 409,
                    message: "this Apple subscription is already linked to a different account",
                    retryAfterSeconds: nil
                )
            )),
            .linkedToOtherAccount
        )
        XCTAssertEqual(
            PremiumAccessGate.ownership(afterProbe: .failure(
                APIError.server(status: 500, message: "boom", retryAfterSeconds: nil)
            )),
            .unknown
        )
        XCTAssertEqual(
            PremiumAccessGate.ownership(afterProbe: .failure(APIError.transport(URLError(.notConnectedToInternet)))),
            .unknown
        )
    }

    /// #2120 leftover: `observeAppleTransactions` used `isPremium` alone to
    /// decide an authenticated redeem.  Stripe Premium is `isPremium` with
    /// `source: "stripe"` and never consults the Apple ledger, so a Stripe
    /// account on a device with an unfinished signed-out Apple purchase
    /// would silent-link that row.  Auto-redeem is only a renewal of an
    /// already-Apple-backed grant.
    func testTransactionUpdateDoesNotAutoRedeemStripePremiumOntoDeviceApplePurchase() {
        XCTAssertFalse(PremiumAccessGate.shouldAutoRedeemOnTransactionUpdate(
            isPremium: true,
            entitlementSource: "stripe"
        ), "Stripe Premium must not claim a leftover unfinished Apple purchase")
        XCTAssertFalse(PremiumAccessGate.shouldAutoRedeemOnTransactionUpdate(
            isPremium: true,
            entitlementSource: nil
        ), "unknown source is treated as not-Apple — probe only")
        XCTAssertFalse(PremiumAccessGate.shouldAutoRedeemOnTransactionUpdate(
            isPremium: false,
            entitlementSource: "apple"
        ), "free account never auto-claims; Link / Restore only")
        XCTAssertTrue(PremiumAccessGate.shouldAutoRedeemOnTransactionUpdate(
            isPremium: true,
            entitlementSource: "apple"
        ), "already-Apple-backed Premium may refresh the same grant")
    }

    // MARK: - UX P0: memberName search + async command result claim

    func testFeedQueryEmitsMemberNameNotMemberForFreeText() {
        let query = FeedQuery(limit: 50, memberName: "Pelosi", sort: "tx_date", order: "desc")
        let items = query.queryItems
        XCTAssertEqual(items.first(where: { $0.name == "memberName" })?.value, "Pelosi")
        XCTAssertNil(items.first(where: { $0.name == "member" }))
    }

    // MARK: - UX wave2: type filter + trade performance

    func testFeedQueryEmitsTypeForBuySellFilter() {
        // Storage/API canonical buy is B (legacy P still accepted by matchers).
        // `TradeTypeFilter` no longer exposes `queryValue` — the single-vs-
        // multi decision now lives in `CongressTradeStore.tradeTypeQueryValue`
        // (owner directive 2026-08-09: multi-select filter pills); a lone
        // case's `rawValue` is still the exact server `type=` token.
        let buy = FeedQuery(limit: 50, type: TradeTypeFilter.buy.rawValue)
        XCTAssertEqual(buy.queryItems.first(where: { $0.name == "type" })?.value, "B")
        let sell = FeedQuery(limit: 50, type: TradeTypeFilter.sell.rawValue)
        XCTAssertEqual(sell.queryItems.first(where: { $0.name == "type" })?.value, "S")
        let exchange = FeedQuery(limit: 50, type: TradeTypeFilter.exchange.rawValue)
        XCTAssertEqual(exchange.queryItems.first(where: { $0.name == "type" })?.value, "E")
        let all = FeedQuery(limit: 50, type: nil)
        XCTAssertNil(all.queryItems.first(where: { $0.name == "type" }))
    }

    func testTradeTypeFilterMatchesLocalCacheSides() {
        XCTAssertTrue(TradeTypeFilter.buy.matches(txType: "P"))
        XCTAssertTrue(TradeTypeFilter.buy.matches(txType: "B"))
        XCTAssertFalse(TradeTypeFilter.buy.matches(txType: "S"))
        XCTAssertTrue(TradeTypeFilter.sell.matches(txType: "S"))
        XCTAssertFalse(TradeTypeFilter.sell.matches(txType: "E"))
        XCTAssertTrue(TradeTypeFilter.exchange.matches(txType: "E"))
        XCTAssertFalse(TradeTypeFilter.exchange.matches(txType: "B"))
    }

    func testPartyFilterBucketsMirrorServerPartyBucketSQL() {
        // Mirrors `PARTY_BUCKET_SQL` in `app/src/analytics/sql.ts`: first
        // letter D/R, EVERYTHING else (incl. empty/nil = no party on file) is
        // Other, so D + R + O partitions the feed (board efd94c45).
        XCTAssertEqual(PartyFilter.bucket(for: "Democratic"), .democrat)
        XCTAssertEqual(PartyFilter.bucket(for: "d"), .democrat)
        XCTAssertEqual(PartyFilter.bucket(for: "Republican"), .republican)
        XCTAssertEqual(PartyFilter.bucket(for: "Independent"), .other)
        XCTAssertEqual(PartyFilter.bucket(for: "Libertarian"), .other)
        XCTAssertEqual(PartyFilter.bucket(for: ""), .other)
        XCTAssertEqual(PartyFilter.bucket(for: "   "), .other)
        XCTAssertEqual(PartyFilter.bucket(for: nil), .other)
        XCTAssertEqual(PartyFilter.other.label, "Other / No party")
    }

    func testTimeRangeCalendarYearBounds() {
        let thisYear = TimeRange.thisCalendarYear
        let lastYear = TimeRange.lastCalendarYear
        let fromThis = thisYear.fromDateISO
        let fromLast = lastYear.fromDateISO
        let toLast = lastYear.toDateISO
        XCTAssertNotNil(fromThis)
        XCTAssertNotNil(fromLast)
        XCTAssertNotNil(toLast)
        XCTAssertTrue(fromThis!.hasSuffix("-01-01"))
        XCTAssertTrue(fromLast!.hasSuffix("-01-01"))
        XCTAssertTrue(toLast!.hasSuffix("-12-31"))
        XCTAssertNil(thisYear.toDateISO)
        XCTAssertEqual(TimeRange.all.fromDateISO, nil)
        XCTAssertEqual(thisYear.label, "This Year")
        XCTAssertEqual(lastYear.label, "Last Year")
    }

    func testAPIErrorCancellationIsNotRetryable() {
        let cancelled = APIError.transport(URLError(.cancelled))
        XCTAssertTrue(cancelled.isCancellation)
        XCTAssertFalse(cancelled.isRetryable)
        let offline = APIError.transport(URLError(.notConnectedToInternet))
        XCTAssertFalse(offline.isCancellation)
        XCTAssertTrue(offline.isOffline)
    }

    func testAPIErrorUserFacingMessageHidesRawTransportPhrase() {
        let updating = APIError.server(status: 502, message: "Request failed", retryAfterSeconds: nil)
        XCTAssertEqual(updating.userFacingMessage, "The site is updating (502).  Pull to refresh.")
        XCTAssertEqual(
            APIError.server(status: 503, message: "try again", retryAfterSeconds: nil).userFacingMessage,
            "The site is updating (503).  Pull to refresh."
        )
        XCTAssertEqual(
            APIError.server(status: 429, message: "Request failed", retryAfterSeconds: 2).userFacingMessage,
            "Too many requests.  Pull to refresh."
        )
        XCTAssertEqual(
            APIError.server(status: 400, message: "bad request", retryAfterSeconds: nil).userFacingMessage,
            "bad request"
        )
        XCTAssertEqual(
            APIError.server(status: 400, message: "Request failed", retryAfterSeconds: nil).userFacingMessage,
            "Could not load this page (400).  Pull to refresh."
        )
        XCTAssertEqual(
            APIError.transport(URLError(.notConnectedToInternet)).userFacingMessage,
            "You are offline."
        )
        XCTAssertEqual(
            APIError.transport(URLError(.timedOut)).userFacingMessage,
            "Could not reach the server.  Pull to refresh."
        )
        XCTAssertNotEqual(
            APIError.transport(URLError(.timedOut)).userFacingMessage,
            URLError(.timedOut).localizedDescription
        )
    }

    func testAppDeepLinkParsesWebsiteQueryAndCustomSchemeEquivalents() {
        XCTAssertEqual(
            AppDeepLink.parse(URL(string: "https://congress.trade/?trade=tx_1")!),
            .trade(id: "tx_1")
        )
        XCTAssertEqual(
            AppDeepLink.parse(URL(string: "https://congress.trade/?member=P000197")!),
            .member(id: "P000197")
        )
        XCTAssertEqual(
            AppDeepLink.parse(URL(string: "https://www.congress.trade/?ticker=nvda")!),
            .ticker(symbol: "NVDA")
        )
        XCTAssertEqual(
            AppDeepLink.parse(URL(string: "congresstrade://?trade=tx_1")!),
            .trade(id: "tx_1")
        )
        XCTAssertEqual(
            AppDeepLink.parse(URL(string: "congresstrade://member/P000197")!),
            .member(id: "P000197")
        )
        XCTAssertEqual(
            AppDeepLink.parse(URL(string: "congresstrade://ticker/msft")!),
            .ticker(symbol: "MSFT")
        )
        XCTAssertEqual(
            AppDeepLink.parse(URL(string: "congresstrade://auth?token=abc")!),
            .auth(token: "abc")
        )
        XCTAssertEqual(
            AppDeepLink.parse(URL(string: "https://congress.trade/?view=directory")!),
            .tab(.people)
        )
        XCTAssertEqual(
            AppDeepLink.parse(URL(string: "https://congress.trade/?ticker=NVDA&trade=tx_1")!),
            .ticker(symbol: "NVDA")
        )
    }

    func testPushNotificationOpenReadsShippedFanoutCamelCaseAndSnakeCase() {
        XCTAssertEqual(
            PushNotificationOpen.parse(["docId": "H-1", "txIds": ["tx_1", "tx_2"]]),
            .trade(id: "tx_1")
        )
        XCTAssertEqual(
            PushNotificationOpen.parse(["trade_id": "tx_9", "doc_id": "H-2"]),
            .trade(id: "tx_9")
        )
        XCTAssertEqual(
            PushNotificationOpen.parse(["docId": "H-3"]),
            .filing(docId: "H-3")
        )
        XCTAssertNil(PushNotificationOpen.parse(["kind": "official_filing"]))
        XCTAssertNil(PushNotificationOpen.parse(["docId": "  "]))
    }

    func testAppDeepLinkStaysHonestOnMissingOrUnknownQueries() {
        XCTAssertNil(AppDeepLink.parse(URL(string: "https://congress.trade/")!))
        XCTAssertNil(AppDeepLink.parse(URL(string: "https://congress.trade/?trade=")!))
        XCTAssertNil(AppDeepLink.parse(URL(string: "https://congress.trade/?member=%20")!))
        XCTAssertNil(AppDeepLink.parse(URL(string: "https://congress.trade/?foo=bar")!))
        XCTAssertNil(AppDeepLink.parse(URL(string: "https://congress.trade/?view=review")!))
        XCTAssertNil(AppDeepLink.parse(URL(string: "congresstrade://auth")!))
        XCTAssertNil(AppDeepLink.parse(URL(string: "congresstrade://unknown/xyz")!))
        XCTAssertNil(AppDeepLink.parse(URL(string: "mailto:support@congress.trade")!))
    }

    func testTradePerformanceResponseDecodesAvailableAndEmpty() throws {
        let availableJSON = """
        {
          "available": true,
          "txType": "P",
          "ticker": "AAPL",
          "txDate": "2025-01-02",
          "filedDate": "2025-01-15",
          "priceAtTrade": 100,
          "currentPrice": 110,
          "currentPriceDate": "2025-06-01",
          "assetReturn": 0.1,
          "spxReturn": 0.05,
          "excessReturn": 0.05,
          "tradeDatePerformance": {
            "priceAt": 100, "spxAt": 4000,
            "assetReturn": 0.1, "spxReturn": 0.05, "excessReturn": 0.05
          },
          "filingDatePerformance": {
            "priceAt": 102, "spxAt": 4010,
            "assetReturn": 0.078, "spxReturn": 0.04, "excessReturn": 0.038
          }
        }
        """
        let available = try JSONDecoder().decode(TradePerformanceResponse.self, from: Data(availableJSON.utf8))
        XCTAssertTrue(available.available)
        XCTAssertEqual(try XCTUnwrap(available.excessReturn), 0.05, accuracy: 0.0001)
        XCTAssertEqual(try XCTUnwrap(available.tradeLeg?.assetReturn), 0.1, accuracy: 0.0001)
        XCTAssertNotNil(available.filingDatePerformance)

        let empty = try JSONDecoder().decode(
            TradePerformanceResponse.self,
            from: Data(#"{"available":false,"isOption":true}"#.utf8)
        )
        XCTAssertFalse(empty.available)
        XCTAssertEqual(empty.isOption, true)
        XCTAssertNil(empty.tradeLeg)
    }

    func testShareURLBuildsTickerDeepLink() {
        let client = CongressTradeAPIClient(
            baseURL: URL(string: "https://example.test/api/client/v1")!,
            tokenStore: MemoryTokenStore(token: nil)
        )
        let url = client.shareURL(queryItem: URLQueryItem(name: "ticker", value: "NVDA"))
        XCTAssertEqual(url?.absoluteString, "https://example.test/?ticker=NVDA")
    }

    @MainActor
    func testSetTradeTypeSendsTypeQueryParam() async throws {
        let store = CongressTradeStore(
            api: CongressTradeAPIClient(baseURL: Self.baseURL, tokenStore: MemoryTokenStore(token: nil), session: makeSession()),
            cursorStore: InMemorySyncCursorStore(),
            sleeper: { _ in }
        )
        let capture = RequestCapture()
        installFeedMock(capture: capture)

        await store.setTradeTypeSelection([.buy])

        let components = try XCTUnwrap(URLComponents(url: XCTUnwrap(capture.last(pathContains: "/feed")), resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.queryItems?.first(where: { $0.name == "type" })?.value, "B")
        // Free-text search still uses memberName when set later; type alone must not emit member=.
        XCTAssertNil(components.queryItems?.first(where: { $0.name == "member" }))
    }

    /// Trends analytics used to ignore the Buys/Sells chip (only the Trades
    /// feed sent `type=`). Selecting Buys must reach `/api/analytics/summary`.
    @MainActor
    func testSetTradeTypeSelectionSendsTypeToTrendsAnalytics() async throws {
        let store = CongressTradeStore(
            api: CongressTradeAPIClient(baseURL: Self.baseURL, tokenStore: MemoryTokenStore(token: nil), session: makeSession()),
            cursorStore: InMemorySyncCursorStore(),
            sleeper: { _ in }
        )
        var summaryURL: URL?
        MockURLProtocol.handler = { request in
            if request.url?.path.hasSuffix("/bootstrap") == true {
                return Self.response(for: request, json: Self.bootstrapJSON)
            }
            if request.url?.path.contains("/api/analytics/summary") == true {
                summaryURL = request.url
            }
            if request.url?.path.contains("/feed") == true {
                return Self.response(for: request, json: Self.feedJSON(items: [], cursor: 0, count: 0, total: 0, limit: 50))
            }
            return Self.response(for: request, json: "{}")
        }

        await store.setTradeTypeSelection([.buy])

        let components = try XCTUnwrap(URLComponents(url: XCTUnwrap(summaryURL), resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.queryItems?.first(where: { $0.name == "type" })?.value, "B")
    }

    @MainActor
    func testSetPartySelectionSendsPartyToPartySplit() async throws {
        let store = CongressTradeStore(
            api: CongressTradeAPIClient(baseURL: Self.baseURL, tokenStore: MemoryTokenStore(token: nil), session: makeSession()),
            cursorStore: InMemorySyncCursorStore(),
            sleeper: { _ in }
        )
        var splitURL: URL?
        var leaderboardURL: URL?
        MockURLProtocol.handler = { request in
            if request.url?.path.hasSuffix("/bootstrap") == true {
                return Self.response(for: request, json: Self.bootstrapJSON)
            }
            if request.url?.path.contains("/api/analytics/party-split") == true {
                splitURL = request.url
            }
            if request.url?.path.contains("/api/analytics/ticker-leaderboard") == true {
                leaderboardURL = request.url
            }
            if request.url?.path.contains("/feed") == true {
                return Self.response(for: request, json: Self.feedJSON(items: [], cursor: 0, count: 0, total: 0, limit: 50))
            }
            return Self.response(for: request, json: "{}")
        }

        await store.setPartySelection([.democrat])

        let split = try XCTUnwrap(URLComponents(url: XCTUnwrap(splitURL), resolvingAgainstBaseURL: false))
        XCTAssertEqual(split.queryItems?.first(where: { $0.name == "party" })?.value, "D")
        let board = try XCTUnwrap(URLComponents(url: XCTUnwrap(leaderboardURL), resolvingAgainstBaseURL: false))
        XCTAssertEqual(board.queryItems?.first(where: { $0.name == "sort" })?.value, "volume")
        XCTAssertNil(board.queryItems?.first(where: { $0.name == "rankBy" }))
    }

    @MainActor
    func testFetchTickerForwardsSharedFilters() async throws {
        let store = CongressTradeStore(
            api: CongressTradeAPIClient(baseURL: Self.baseURL, tokenStore: MemoryTokenStore(token: nil), session: makeSession()),
            cursorStore: InMemorySyncCursorStore(),
            sleeper: { _ in }
        )
        var tickerURL: URL?
        MockURLProtocol.handler = { request in
            if request.url?.path.hasSuffix("/bootstrap") == true {
                return Self.response(for: request, json: Self.bootstrapJSON)
            }
            if request.url?.path.contains("/ticker/") == true {
                tickerURL = request.url
                return Self.response(for: request, json: #"{"ticker":"AAPL","asset":{},"summary":{},"items":[],"count":0,"total":0}"#)
            }
            if request.url?.path.contains("/feed") == true {
                return Self.response(for: request, json: Self.feedJSON(items: [], cursor: 0, count: 0, total: 0, limit: 50))
            }
            return Self.response(for: request, json: "{}")
        }

        await store.setTradeTypeSelection([.buy])
        _ = try? await store.fetchTicker("AAPL")

        let components = try XCTUnwrap(URLComponents(url: XCTUnwrap(tickerURL), resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.queryItems?.first(where: { $0.name == "type" })?.value, "B")
        XCTAssertEqual(components.queryItems?.first(where: { $0.name == "window" })?.value, "90d")
    }

    /// Multi-select Trade Type pill: `type=` is CSV-capable (`asTxTypes`).
    @MainActor
    func testSetTradeTypeSelectionSendsTypeCSVWhenMultipleSidesSelected() async throws {
        let store = CongressTradeStore(
            api: CongressTradeAPIClient(baseURL: Self.baseURL, tokenStore: MemoryTokenStore(token: nil), session: makeSession()),
            cursorStore: InMemorySyncCursorStore(),
            sleeper: { _ in }
        )
        let capture = RequestCapture()
        installFeedMock(capture: capture)

        await store.setTradeTypeSelection([.buy, .sell])

        let components = try XCTUnwrap(URLComponents(url: XCTUnwrap(capture.last(pathContains: "/feed")), resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.queryItems?.first(where: { $0.name == "type" })?.value, "B,S")
    }

    /// Chamber's `chamber=` param is genuinely CSV-capable server-side
    /// (`asChambers` in `app/src/client/utils.ts`), so a multi-selection
    /// forwards the full CSV, unlike Trade Type above.
    @MainActor
    func testSetChamberSelectionSendsChamberCSVForMultipleBranches() async throws {
        let store = CongressTradeStore(
            api: CongressTradeAPIClient(baseURL: Self.baseURL, tokenStore: MemoryTokenStore(token: nil), session: makeSession()),
            cursorStore: InMemorySyncCursorStore(),
            sleeper: { _ in }
        )
        let capture = RequestCapture()
        installFeedMock(capture: capture)
        await store.setChamberSelection([.house, .executive])

        let components = try XCTUnwrap(URLComponents(url: XCTUnwrap(capture.last(pathContains: "/feed")), resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.queryItems?.first(where: { $0.name == "chamber" })?.value, "executive,house")
    }

    @MainActor
    func testSetPartySelectionSendsPartyCSV() async throws {
        let store = CongressTradeStore(
            api: CongressTradeAPIClient(baseURL: Self.baseURL, tokenStore: MemoryTokenStore(token: nil), session: makeSession()),
            cursorStore: InMemorySyncCursorStore(),
            sleeper: { _ in }
        )
        let capture = RequestCapture()
        installFeedMock(capture: capture)

        await store.setPartySelection([.democrat, .republican])

        let components = try XCTUnwrap(URLComponents(url: XCTUnwrap(capture.last(pathContains: "/feed")), resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.queryItems?.first(where: { $0.name == "party" })?.value, "D,R")
    }

    @MainActor
    func testSetAssetClassSendsAssetClassQueryParam() async throws {
        let store = CongressTradeStore(
            api: CongressTradeAPIClient(baseURL: Self.baseURL, tokenStore: MemoryTokenStore(token: nil), session: makeSession()),
            cursorStore: InMemorySyncCursorStore(),
            sleeper: { _ in }
        )
        let capture = RequestCapture()
        installFeedMock(capture: capture)

        await store.setAssetClass(.equitiesFunds)

        let components = try XCTUnwrap(URLComponents(url: XCTUnwrap(capture.last(pathContains: "/feed")), resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.queryItems?.first(where: { $0.name == "assetClass" })?.value, "equities_funds")
    }

    @MainActor
    func testCancelledFeedRefreshDoesNotSetFeedNotice() async throws {
        let store = CongressTradeStore(
            api: CongressTradeAPIClient(baseURL: Self.baseURL, tokenStore: MemoryTokenStore(token: nil), session: makeSession()),
            cursorStore: InMemorySyncCursorStore(),
            sleeper: { _ in }
        )
        MockURLProtocol.handler = { request in
            throw URLError(.cancelled)
        }
        await store.refresh()
        XCTAssertNil(store.feedNotice)
        XCTAssertFalse(store.isOffline)
    }

    @MainActor
    func testDeleteSubscriptionCommandPayload() async throws {
        let session = makeSession()
        let client = CongressTradeAPIClient(
            baseURL: URL(string: "https://example.test/api/client/v1")!,
            tokenStore: MemoryTokenStore(token: "native-session"),
            session: session
        )
        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Idempotency-Key"), "del-1")
            let body = try XCTUnwrap(Self.requestBody(request))
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
            XCTAssertEqual(json["type"] as? String, "delete_subscription")
            let payload = try XCTUnwrap(json["payload"] as? [String: Any])
            XCTAssertEqual(payload["id"] as? String, "sub_gone")
            return Self.response(
                for: request,
                json: """
                {
                  "command": {
                    "id": "cmd_del", "userId": "user_1", "type": "delete_subscription",
                    "status": "succeeded", "idempotencyKey": "del-1", "error": null,
                    "createdAt": "2026-07-11T00:00:00Z", "updatedAt": "2026-07-11T00:00:00Z",
                    "startedAt": "2026-07-11T00:00:00Z", "finishedAt": "2026-07-11T00:00:01Z"
                  },
                  "result": { "deleted": true, "id": "sub_gone" }
                }
                """
            )
        }
        let result = try await client.deleteSubscription(id: "sub_gone", idempotencyKey: "del-1")
        XCTAssertEqual(result.result?.deleted, true)
        XCTAssertEqual(result.result?.id, "sub_gone")
    }

    @MainActor
    func testDeleteAccountCommandPayload() async throws {
        let session = makeSession()
        let client = CongressTradeAPIClient(
            baseURL: URL(string: "https://example.test/api/client/v1")!,
            tokenStore: MemoryTokenStore(token: "native-session"),
            session: session
        )
        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Idempotency-Key"), "del-acct-1")
            let body = try XCTUnwrap(Self.requestBody(request))
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
            XCTAssertEqual(json["type"] as? String, "delete_account")
            return Self.response(
                for: request,
                json: """
                {
                  "command": {
                    "id": "cmd_del_acct", "userId": "user_1", "type": "delete_account",
                    "status": "succeeded", "idempotencyKey": "del-acct-1", "error": null,
                    "createdAt": "2026-08-20T00:00:00Z", "updatedAt": "2026-08-20T00:00:00Z",
                    "startedAt": "2026-08-20T00:00:00Z", "finishedAt": "2026-08-20T00:00:01Z"
                  },
                  "result": { "deleted": true, "userId": "user_1" }
                }
                """
            )
        }
        let result = try await client.deleteAccount(idempotencyKey: "del-acct-1")
        XCTAssertEqual(result.result?.deleted, true)
        XCTAssertEqual(result.result?.userId, "user_1")
    }

    @MainActor
    func testSetSearchUsesMemberNameNotMember() async throws {
        let store = CongressTradeStore(
            api: CongressTradeAPIClient(baseURL: Self.baseURL, tokenStore: MemoryTokenStore(token: nil), session: makeSession()),
            cursorStore: InMemorySyncCursorStore(),
            sleeper: { _ in }
        )
        let capture = RequestCapture()
        installFeedMock(capture: capture)
        await store.setSearch("Nancy Pelosi")

        let components = try XCTUnwrap(URLComponents(url: XCTUnwrap(capture.last(pathContains: "/feed")), resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.queryItems?.first(where: { $0.name == "memberName" })?.value, "Nancy Pelosi")
        XCTAssertNil(components.queryItems?.first(where: { $0.name == "member" }))
    }

    func testCommandResponseDecodesResultNestedOnCommand() throws {
        // GET /commands/:id claims secret onto command.result, not top-level result.
        let json = """
        {
          "command": {
            "id": "cmd_1", "userId": "user_1", "type": "create_subscription",
            "status": "succeeded", "idempotencyKey": "k1", "error": null,
            "createdAt": "2026-07-11T00:00:00Z", "updatedAt": "2026-07-11T00:00:01Z",
            "startedAt": "2026-07-11T00:00:00Z", "finishedAt": "2026-07-11T00:00:01Z",
            "result": {
              "subscription": {
                "id": "sub_1", "delivery": "sse", "targetUrl": null,
                "filters": {}, "cursor": 0, "active": true,
                "createdAt": "2026-07-11T00:00:00Z", "hasSecret": true,
                "secret": "once-only-secret", "streamUrl": "/api/stream?subscription=sub_1&token=once-only-secret"
              }
            }
          }
        }
        """
        let decoded = try JSONDecoder().decode(
            ClientCommandResponse<SubscriptionCommandResult>.self,
            from: Data(json.utf8)
        )
        XCTAssertEqual(decoded.command.status, .succeeded)
        XCTAssertEqual(decoded.result?.subscription.secret, "once-only-secret")
        XCTAssertEqual(decoded.result?.subscription.id, "sub_1")
    }

    func testPostCommandPollsUntilSucceededAndClaimsSecret() async throws {
        let session = makeSession()
        let client = CongressTradeAPIClient(
            baseURL: URL(string: "https://example.test/api/client/v1")!,
            tokenStore: MemoryTokenStore(token: "native-session"),
            session: session
        )
        var postHits = 0
        var getHits = 0
        MockURLProtocol.handler = { request in
            let path = request.url?.path ?? ""
            if request.httpMethod == "POST", path.hasSuffix("/commands") {
                postHits += 1
                return Self.response(
                    for: request,
                    status: 202,
                    json: """
                    {
                      "command": {
                        "id": "cmd_poll", "userId": "user_1", "type": "create_subscription",
                        "status": "queued", "idempotencyKey": "poll-1", "error": null,
                        "createdAt": "2026-07-11T00:00:00Z", "updatedAt": "2026-07-11T00:00:00Z",
                        "startedAt": null, "finishedAt": null
                      }
                    }
                    """
                )
            }
            if request.httpMethod == "GET", path.hasSuffix("/commands/cmd_poll") {
                getHits += 1
                if getHits < 2 {
                    return Self.response(
                        for: request,
                        json: """
                        {
                          "command": {
                            "id": "cmd_poll", "userId": "user_1", "type": "create_subscription",
                            "status": "running", "idempotencyKey": "poll-1", "error": null,
                            "createdAt": "2026-07-11T00:00:00Z", "updatedAt": "2026-07-11T00:00:01Z",
                            "startedAt": "2026-07-11T00:00:00Z", "finishedAt": null
                          }
                        }
                        """
                    )
                }
                return Self.response(
                    for: request,
                    json: """
                    {
                      "command": {
                        "id": "cmd_poll", "userId": "user_1", "type": "create_subscription",
                        "status": "succeeded", "idempotencyKey": "poll-1", "error": null,
                        "createdAt": "2026-07-11T00:00:00Z", "updatedAt": "2026-07-11T00:00:02Z",
                        "startedAt": "2026-07-11T00:00:00Z", "finishedAt": "2026-07-11T00:00:02Z",
                        "result": {
                          "subscription": {
                            "id": "sub_poll", "delivery": "sse", "targetUrl": null,
                            "filters": {}, "cursor": 0, "active": true,
                            "createdAt": "2026-07-11T00:00:00Z", "hasSecret": true,
                            "secret": "claimed-secret", "streamUrl": "/api/stream?x=1"
                          }
                        }
                      }
                    }
                    """
                )
            }
            return Self.response(for: request, status: 404, json: #"{"error":"unexpected"}"#)
        }

        let result = try await client.createSSESubscription(
            filters: SubscriptionFilters(),
            idempotencyKey: "poll-1"
        )
        XCTAssertEqual(postHits, 1)
        XCTAssertGreaterThanOrEqual(getHits, 2)
        XCTAssertEqual(result.command.status, .succeeded)
        XCTAssertEqual(result.result?.subscription.secret, "claimed-secret")
    }

    func testAppLegalFooterMailsSupportAtCongressTradeAndParsesMarkdown() {
        XCTAssertEqual(AppLegal.supportEmail, "support@congress.trade")
        XCTAssertEqual(AppLegal.destinations.map(\.title), ["Privacy", "Terms", "Pricing", "Support"])
        XCTAssertEqual(AppLegal.destinations.last?.url.absoluteString, "mailto:support@congress.trade")
        XCTAssertFalse(
            AppLegal.destinations.contains { $0.url.absoluteString.contains("jays.services") }
        )
        // Tabs and Account render `SiteFooterStack` (disclaimer, then
        // `LegalFooterLinks` buttons).  Keep the attributed fallback honest
        // so a future Markdown caller cannot revive the raw
        // `[Support](mailto:…)` row.
        XCTAssertTrue(AppLegal.markdown.contains("mailto:support@congress.trade"))
        XCTAssertFalse(AppLegal.markdown.contains("congress.trade@jays.services"))
        let links = AppLegal.attributed.runs.compactMap(\.link)
        XCTAssertEqual(links.count, 4)
        XCTAssertEqual(links.last?.absoluteString, "mailto:support@congress.trade")
    }

    @MainActor
    func testDisclaimerColdStartPlaysOnceThenHides() async {
        DisclaimerColdStart.resetForTests()
        var expanded = false
        let binding = Binding(
            get: { expanded },
            set: { expanded = $0 }
        )
        await DisclaimerColdStart.playIfNeeded(binding, hold: .milliseconds(20))
        XCTAssertFalse(expanded, "cold-start intro should auto-hide after the hold")

        expanded = false
        await DisclaimerColdStart.playIfNeeded(binding, hold: .milliseconds(20))
        XCTAssertFalse(expanded, "a second play in the same process must no-op")
        DisclaimerColdStart.resetForTests()
    }

    @MainActor
    func testDisclaimerColdStartCancelKeepsUserToggle() async {
        DisclaimerColdStart.resetForTests()
        var expanded = false
        let binding = Binding(
            get: { expanded },
            set: { expanded = $0 }
        )
        let play = Task {
            await DisclaimerColdStart.playIfNeeded(binding, hold: .seconds(2))
        }
        try? await Task.sleep(for: .milliseconds(30))
        XCTAssertTrue(expanded)
        DisclaimerColdStart.cancelAutoHide()
        expanded = true
        try? await Task.sleep(for: .milliseconds(80))
        XCTAssertTrue(expanded, "ⓘ tap during intro must cancel the auto-hide")
        play.cancel()
        DisclaimerColdStart.resetForTests()
    }

    func testLatencyScorecardHeadlinesMedianAndColorsBySign() {
        // Live 2026-08-16 FMP: 16-12 "win" but avg 4.6d later from outliers; median 13.0h earlier.
        let fmp = Self.latencyProvider(
            label: "FMP",
            matched: 28,
            usFirst: 16,
            providerFirst: 12,
            median: 46_971,
            avg: -397_649,
            status: "preliminary"
        )
        let snap = LatencyScorecardCopy.snapshot(for: fmp)
        XCTAssertEqual(snap.headlineText, "13.0h earlier")
        XCTAssertEqual(snap.direction, .ahead)
        XCTAssertEqual(snap.verdict, .mixed)
        XCTAssertEqual(snap.badgeText, "Mixed")
        XCTAssertEqual(snap.basisLabel, "typical earlier (coverage still building)")
        XCTAssertTrue(snap.averageDisagrees)
        XCTAssertEqual(snap.averageCaption?.contains("4.6d later"), true)
        XCTAssertFalse(snap.headlineText.contains("+"))
        XCTAssertFalse(snap.headlineText.contains("−"))
        XCTAssertFalse(snap.headlineText.contains("-"))
    }

    func testLatencyScorecardNegativeMedianIsRedLaterNotGreenEarlier() {
        let behind = Self.latencyProvider(
            label: "Slow Feed",
            matched: 9,
            usFirst: 2,
            providerFirst: 7,
            median: -20_356,
            avg: -20_356,
            status: "preliminary"
        )
        let snap = LatencyScorecardCopy.snapshot(for: behind)
        XCTAssertEqual(snap.headlineText, "5.7h later")
        XCTAssertEqual(snap.direction, .behind)
        XCTAssertEqual(snap.verdict, .lag)
        XCTAssertEqual(snap.badgeText, "Lag")
        XCTAssertEqual(snap.basisLabel, "typical later")
        XCTAssertFalse(snap.averageDisagrees)
        XCTAssertFalse(snap.headlineText.contains("+"))
        XCTAssertFalse(snap.headlineText.contains("−"))
    }

    func testLatencyScorecardUsableEarlierHasNoPlusSign() {
        let quiver = Self.latencyProvider(
            label: "Quiver Quantitative",
            matched: 13,
            usFirst: 13,
            providerFirst: 0,
            median: 750,
            avg: 6_932,
            status: "usable"
        )
        let snap = LatencyScorecardCopy.snapshot(for: quiver)
        XCTAssertEqual(snap.headlineText, "13m earlier")
        XCTAssertEqual(snap.headlineSec, 750)
        XCTAssertEqual(snap.direction, .ahead)
        XCTAssertEqual(snap.verdict, .lead)
        XCTAssertEqual(snap.badgeText, "Lead")
        XCTAssertEqual(snap.basisLabel, "typical earlier")
        XCTAssertEqual(snap.winPct, 100)
        XCTAssertEqual(snap.averageCaption, "Average 1.9h earlier")
        XCTAssertEqual(snap.averageSec, 6_932)
        XCTAssertEqual(LatencyScorecardCopy.formatLead(snap.averageSec), "1.9h earlier")
    }

    func testLatencyPublicGateHidesWhenMostProvidersLag() {
        let ahead = Self.latencyProvider(
            label: "A", matched: 10, usFirst: 8, providerFirst: 2,
            median: 120, avg: 100, status: "usable"
        )
        let lag1 = Self.latencyProvider(
            label: "B", matched: 10, usFirst: 1, providerFirst: 9,
            median: -3600, avg: -1800, status: "usable"
        )
        let lag2 = Self.latencyProvider(
            label: "C", matched: 10, usFirst: 2, providerFirst: 8,
            median: -7200, avg: -5400, status: "usable"
        )
        let split = LatencySummary(
            generatedAt: "2026-08-17T00:00:00Z",
            windowHours: 48,
            windowDays: 2,
            maxConcurrentDeltaHours: 48,
            totals: LatencySummary.LatencyTotals(
                racedDisclosures: 10, matched: 10, pending: 0,
                comparableProviders: 2, providerObserved: 10,
                unmatchedProvider: 0, scopeMatched: 10, scopeTotal: 10
            ),
            scope: nil,
            providers: [ahead, lag1]
        )
        let majorityBehind = LatencySummary(
            generatedAt: "2026-08-17T00:00:00Z",
            windowHours: 48,
            windowDays: 2,
            maxConcurrentDeltaHours: 48,
            totals: LatencySummary.LatencyTotals(
                racedDisclosures: 10, matched: 10, pending: 0,
                comparableProviders: 3, providerObserved: 10,
                unmatchedProvider: 0, scopeMatched: 10, scopeTotal: 10
            ),
            scope: nil,
            providers: [ahead, lag1, lag2]
        )
        XCTAssertTrue(LatencyScorecardCopy.isPubliclyVisible(split))
        XCTAssertFalse(LatencyScorecardCopy.isPubliclyVisible(majorityBehind))
    }

    func testIOSNeverOffersWebCheckoutForDigitalGoods() {
        XCTAssertFalse(DigitalGoodsCheckout.allowsWebCheckout)
        XCTAssertNil(
            DigitalGoodsCheckout.webCheckoutURL(relativeTo: URL(string: "https://congress.trade")!)
        )

        XCTAssertFalse(PremiumPricing.emptyCatalogMessage.localizedCaseInsensitiveContains("website"))
        XCTAssertFalse(PremiumPricing.emptyCatalogMessage.localizedCaseInsensitiveContains("congress.trade"))
        XCTAssertFalse(PremiumPricing.emptyCatalogMessage.localizedCaseInsensitiveContains("pricing"))
        XCTAssertTrue(PremiumPricing.emptyCatalogMessage.localizedCaseInsensitiveContains("try again later"))

        XCTAssertFalse(PremiumPricing.deliveryUpgradeMessage.localizedCaseInsensitiveContains("website"))
        XCTAssertFalse(PremiumPricing.deliveryUpgradeMessage.localizedCaseInsensitiveContains("congress.trade"))
        XCTAssertTrue(PremiumPricing.deliveryUpgradeMessage.localizedCaseInsensitiveContains("in-app purchase"))

        let purchaseMsg = PremiumPricing.purchaseFailureMessage(
            APIError.transport(URLError(.notConnectedToInternet))
        )
        XCTAssertTrue(purchaseMsg.localizedCaseInsensitiveContains("offline"))
        XCTAssertFalse(purchaseMsg.localizedCaseInsensitiveContains("Apple took the purchase"))

        let redeemMsg = PremiumPricing.redeemFailureMessage(
            APIError.server(status: 400, message: "Command failed", retryAfterSeconds: nil)
        )
        XCTAssertTrue(redeemMsg.localizedCaseInsensitiveContains("Apple took the purchase"))
        XCTAssertTrue(redeemMsg.localizedCaseInsensitiveContains("Restore Purchases"))

        XCTAssertTrue(PremiumPricing.isQuietPurchaseCancellation(
            NSError(domain: SKErrorDomain, code: SKError.paymentCancelled.rawValue)
        ))
        XCTAssertFalse(PremiumPricing.isQuietPurchaseCancellation(
            APIError.server(status: 400, message: "nope", retryAfterSeconds: nil)
        ))

        let pricing = AppLegal.destinations.first { $0.id == "pricing" }
        XCTAssertEqual(pricing?.id, "pricing")
        XCTAssertFalse(AppLegal.opensSafari(pricing!))
        XCTAssertTrue(AppLegal.opensSafari(AppLegal.destinations.first { $0.id == "privacy" }!))
        XCTAssertTrue(
            AppLegal.footerDestinations(includePricing: true, canOpenInAppPurchase: false)
                .allSatisfy { $0.id != "pricing" }
        )
        XCTAssertTrue(
            AppLegal.footerDestinations(includePricing: true, canOpenInAppPurchase: true)
                .contains { $0.id == "pricing" }
        )
    }

    // MARK: - StoreKit-driven Premium copy (no hardcoded prices/trial lengths)

    /// Reference numbers kept here as XCTest fixtures only — never used as
    /// UI copy.  US storefront (2026-08-14): $8.99/mo, $79.99/yr, 1-week
    /// free-trial intro offer.  Other storefronts localize differently.
    private static let referenceUSDMonthly = "$8.99"
    private static let referenceUSDAnnual = "$79.99"

    func testPremiumCopyHasNoHardcodedPrices() {
        let noDollar = { (s: String) in !s.contains("$") }
        let noDecimalAmount = { (s: String) in
            // Any "\d+[.,]\d{2}" — matches "$8.99", "8,99 €", "79.99".
            s.range(of: #"\d+[.,]\d{2}"#, options: .regularExpression) == nil
        }
        let noTrialLength = { (s: String) in
            let needles = ["-week free trial", "-day free trial", "-month free trial", "-year free trial"]
            return needles.allSatisfy { !s.localizedCaseInsensitiveContains($0) }
        }

        let headline = PremiumPricing.fallbackHeadline
        let delivery = PremiumPricing.deliveryUpgradeMessage
        for (label, str) in [("fallbackHeadline", headline), ("deliveryUpgradeMessage", delivery)] {
            XCTAssertTrue(noDollar(str), "\(label) unexpectedly contains a $: \(str)")
            XCTAssertTrue(noDecimalAmount(str), "\(label) unexpectedly contains a decimal amount: \(str)")
            XCTAssertTrue(noTrialLength(str), "\(label) unexpectedly contains a trial-length phrase: \(str)")
        }

        XCTAssertEqual(
            PremiumPricing.headline(for: []),
            PremiumPricing.fallbackHeadline,
            "headline(for: []) must fall back to the price-free fallback"
        )
    }

    func testPremiumHeadlineUsesStoreKitDisplayPrice() {
        // US storefront reference numbers — these are fixtures, not UI strings.
        let usdMonthly = PremiumPlanQuote(
            displayPrice: Self.referenceUSDMonthly,
            price: Decimal(string: "8.99")!,
            periodUnit: .month,
            periodValue: 1,
            freeTrial: .init(unit: .week, value: 1)
        )
        let usdAnnual = PremiumPlanQuote(
            displayPrice: Self.referenceUSDAnnual,
            price: Decimal(string: "79.99")!,
            periodUnit: .year,
            periodValue: 1,
            freeTrial: nil
        )
        let usHeadline = PremiumPricing.headline(for: [usdMonthly, usdAnnual])
        XCTAssertTrue(usHeadline.contains(Self.referenceUSDMonthly))
        XCTAssertTrue(usHeadline.contains(Self.referenceUSDAnnual))
        XCTAssertTrue(usHeadline.localizedCaseInsensitiveContains("1-week free trial"))

        // Localized (non-USD) storefront with no intro offer — must show the
        // localized prices verbatim and must not invent a trial.
        let eurMonthly = PremiumPlanQuote(
            displayPrice: "8,99 €",
            price: Decimal(string: "8.99")!,
            periodUnit: .month,
            periodValue: 1,
            freeTrial: nil
        )
        let eurAnnual = PremiumPlanQuote(
            displayPrice: "79,99 €",
            price: Decimal(string: "79.99")!,
            periodUnit: .year,
            periodValue: 1,
            freeTrial: nil
        )
        let eurHeadline = PremiumPricing.headline(for: [eurMonthly, eurAnnual])
        XCTAssertTrue(eurHeadline.contains("8,99 €"))
        XCTAssertTrue(eurHeadline.contains("79,99 €"))
        XCTAssertFalse(eurHeadline.contains("$"))
        XCTAssertFalse(eurHeadline.localizedCaseInsensitiveContains("free trial"))
    }

    func testAnnualSavingsIsComputedFromQuotes() {
        // 12 * $8.99 = $107.88/mo if you paid monthly.  $79.99/yr saves
        // ($107.88 - $79.99) / $107.88 ≈ 0.2586 → 25% rounded down.  This
        // formula lives in PremiumPricing and is the only place the % claim
        // appears, so the test pins both the formula and the rounding.
        let monthly = PremiumPlanQuote(
            displayPrice: "$8.99",
            price: Decimal(string: "8.99")!,
            periodUnit: .month,
            periodValue: 1,
            freeTrial: nil
        )
        let annual = PremiumPlanQuote(
            displayPrice: "$79.99",
            price: Decimal(string: "79.99")!,
            periodUnit: .year,
            periodValue: 1,
            freeTrial: nil
        )
        let pct = PremiumPricing.savingsPercent(monthly: monthly, annual: annual)
        XCTAssertEqual(pct, 25, "expected 25% savings (rounded down from 25.86%)")
    }

    // MARK: - Manage Subscription (Apple vs website/Stripe)

    func testWebManageSubscriptionURLIsBillingManageOnOrigin() {
        let client = CongressTradeAPIClient(
            baseURL: URL(string: "https://example.test/api/client/v1")!,
            tokenStore: MemoryTokenStore(token: nil)
        )
        XCTAssertEqual(client.webManageSubscriptionURL.absoluteString, "https://example.test/?billing=manage")
        XCTAssertFalse(client.webManageSubscriptionURL.absoluteString.contains("checkout"))
        XCTAssertFalse(client.webManageSubscriptionURL.absoluteString.contains("pricing"))
    }

    @MainActor
    func testManageSubscriptionAppleStaysOnAppStoreEvenIfPortalWould401() {
        let web = URL(string: "https://example.test/?billing=manage")!
        let outcome = CongressTradeStore.outcome(
            entitlementSource: "apple",
            webFallbackURL: web,
            portalResult: .failure(
                APIError.server(status: 401, message: "sign in first", retryAfterSeconds: nil)
            )
        )
        XCTAssertEqual(outcome, .url(CongressTradeAPIClient.appStoreManageSubscriptionsURL))
    }

    @MainActor
    func testManageSubscriptionStripeOpensMintedPortalURL() {
        let portal = URL(string: "https://billing.stripe.com/p/session/live")!
        let web = URL(string: "https://example.test/?billing=manage")!
        let outcome = CongressTradeStore.outcome(
            entitlementSource: "stripe",
            webFallbackURL: web,
            portalResult: .success(portal)
        )
        XCTAssertEqual(outcome, .url(portal))
    }

    @MainActor
    func testManageSubscriptionStripe401OpensWebsiteNotSignOutCopy() {
        let web = URL(string: "https://example.test/?billing=manage")!
        let error = APIError.server(status: 401, message: "sign in first", retryAfterSeconds: nil)
        let outcome = CongressTradeStore.outcome(
            entitlementSource: "stripe",
            webFallbackURL: web,
            portalResult: .failure(error)
        )
        XCTAssertEqual(outcome, .url(web))
        XCTAssertTrue(CongressTradeStore.shouldOpenWebManageFallback(for: error))

        let message = CongressTradeStore.portalFailureMessage(for: error)
        XCTAssertFalse(message.localizedCaseInsensitiveContains("sign out"))
        XCTAssertTrue(message.contains(".  "))
        XCTAssertTrue(message.localizedCaseInsensitiveContains("congress.trade"))
    }

    @MainActor
    func testManageSubscriptionNilSource401OpensWebsite() {
        let web = URL(string: "https://example.test/?billing=manage")!
        let outcome = CongressTradeStore.outcome(
            entitlementSource: nil,
            webFallbackURL: web,
            portalResult: .failure(
                APIError.server(status: 401, message: "sign in first", retryAfterSeconds: nil)
            )
        )
        XCTAssertEqual(outcome, .url(web))
    }

    @MainActor
    func testManageSubscriptionStripeOfflineStaysInApp() {
        let web = URL(string: "https://example.test/?billing=manage")!
        let error = APIError.transport(URLError(.notConnectedToInternet))
        XCTAssertFalse(CongressTradeStore.shouldOpenWebManageFallback(for: error))
        let outcome = CongressTradeStore.outcome(
            entitlementSource: "stripe",
            webFallbackURL: web,
            portalResult: .failure(error)
        )
        guard case .failed(let message) = outcome else {
            return XCTFail("offline Stripe manage should stay in-app, not open Safari")
        }
        XCTAssertTrue(message.localizedCaseInsensitiveContains("offline"))
        XCTAssertTrue(message.contains(".  "))
        XCTAssertFalse(message.localizedCaseInsensitiveContains("sign out"))
    }

    func testBillingPortalURLPostsBearerToOriginPortal() async throws {
        let session = makeSession()
        let client = CongressTradeAPIClient(
            baseURL: Self.baseURL,
            tokenStore: MemoryTokenStore(token: "native-session"),
            session: session
        )
        let sawExpected = XCTestExpectation(description: "portal POST carried the session Bearer")
        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/billing/portal")
            XCTAssertEqual(request.value(forHTTPHeaderField: "authorization"), "Bearer native-session")
            XCTAssertEqual(request.value(forHTTPHeaderField: "idempotency-key"), "portal-key-1")
            sawExpected.fulfill()
            return Self.response(for: request, json: #"{"url":"https://billing.stripe.com/p/session/test"}"#)
        }
        let url = try await client.billingPortalURL(idempotencyKey: "portal-key-1")
        XCTAssertEqual(url.absoluteString, "https://billing.stripe.com/p/session/test")
        await fulfillment(of: [sawExpected], timeout: 1)
    }

    func testFilingPDFNeverOpensSafariCheckout() throws {
        XCTAssertEqual(FilingPDFAccess.action(isPremium: false), .showPremiumSheet)
        XCTAssertEqual(FilingPDFAccess.action(isPremium: true), .fetchInApp)

        let client = CongressTradeAPIClient(
            baseURL: URL(string: "https://example.test/api/client/v1")!,
            tokenStore: MemoryTokenStore(token: "sess-token")
        )
        let url = client.documentPDFURL(docId: "H-2026-1")
        XCTAssertEqual(url?.path, "/api/documents/H-2026-1/pdf")
        XCTAssertFalse(url?.absoluteString.contains("pricing") == true)
        XCTAssertFalse(url?.absoluteString.contains("billing") == true)
        XCTAssertFalse(url?.absoluteString.contains("checkout") == true)
        XCTAssertFalse(url?.absoluteString.contains("stripe") == true)

        let request = try client.documentPDFRequest(docId: "H-2026-1")
        XCTAssertEqual(request.value(forHTTPHeaderField: "accept"), "application/pdf")
        XCTAssertEqual(request.value(forHTTPHeaderField: "authorization"), "Bearer sess-token")

        XCTAssertNil(DigitalGoodsCheckout.webCheckoutURL(relativeTo: URL(string: "https://congress.trade")!))
    }

    // MARK: - Guideline 5.1.1(v): no account required to buy Premium

    /// `FilingPDFAccess.action` itself only ever sees one `isPremium` bool —
    /// the call site (`TradeDetailView.openArchivedFilingPDF`) passes
    /// `store.premiumFeatureAccess` (`PremiumAccessGate.granted`, see the
    /// "Account-linked Apple entitlement" tests above). This locks the
    /// boolean logic callers depend on for the SIGNED-OUT case (row 1): a
    /// signed-out device with its own unclaimed Apple purchase must resolve
    /// exactly like a signed-in Premium session. (Signed IN, the gate is no
    /// longer a plain OR — see `testPremiumAccessGateRefusesForeignDeviceEntitlementWhileSignedIn`.)
    func testFilingPDFAccessTreatsLocalAppleEntitlementAsPremium() {
        let isPremiumSession = true
        let hasLocalAppleEntitlementSignedOut = true
        XCTAssertEqual(
            FilingPDFAccess.action(isPremium: isPremiumSession || hasLocalAppleEntitlementSignedOut),
            .fetchInApp
        )
        XCTAssertEqual(
            FilingPDFAccess.action(isPremium: PremiumAccessGate.granted(
                isPremium: false, signedIn: false, hasLocalAppleEntitlement: true, ownership: .unknown
            )),
            .fetchInApp
        )
        XCTAssertEqual(FilingPDFAccess.action(isPremium: false || false), .showPremiumSheet)
    }

    /// `documentPDFRequest` (used by the in-app filing PDF fetch, never a
    /// plain `openURL` deep link) attaches the cached device entitlement
    /// token so a signed-out device's anonymous purchase (Guideline
    /// 5.1.1(v)) can reach the PDF route without a session.
    func testFilingPDFRequestAttachesCachedDeviceEntitlementTokenWhenSignedOut() throws {
        let client = CongressTradeAPIClient(
            baseURL: URL(string: "https://example.test/api/client/v1")!,
            tokenStore: MemoryTokenStore(token: nil),
            deviceEntitlementStore: MemoryTokenStore(token: "device-entitlement-abc")
        )
        let request = try client.documentPDFRequest(docId: "H-2026-1")
        XCTAssertNil(request.value(forHTTPHeaderField: "authorization"))
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Apple-Device-Entitlement"), "device-entitlement-abc")
    }

    /// No cached device token, no session: neither header is sent — the
    /// server correctly falls through to its 402 upgrade payload.
    func testFilingPDFRequestOmitsDeviceEntitlementHeaderWhenNoneCached() throws {
        let client = CongressTradeAPIClient(
            baseURL: URL(string: "https://example.test/api/client/v1")!,
            tokenStore: MemoryTokenStore(token: nil),
            deviceEntitlementStore: MemoryTokenStore(token: nil)
        )
        let request = try client.documentPDFRequest(docId: "H-2026-1")
        XCTAssertNil(request.value(forHTTPHeaderField: "authorization"))
        XCTAssertNil(request.value(forHTTPHeaderField: "X-Apple-Device-Entitlement"))
    }

    /// A signed-in session's Bearer is sent alongside whatever device token
    /// happens to be cached — the SERVER decides priority (session wins);
    /// the client's only job is to send what it has.
    func testFilingPDFRequestSendsBothHeadersWhenBothPresent() throws {
        let client = CongressTradeAPIClient(
            baseURL: URL(string: "https://example.test/api/client/v1")!,
            tokenStore: MemoryTokenStore(token: "sess-token"),
            deviceEntitlementStore: MemoryTokenStore(token: "device-entitlement-abc")
        )
        let request = try client.documentPDFRequest(docId: "H-2026-1")
        XCTAssertEqual(request.value(forHTTPHeaderField: "authorization"), "Bearer sess-token")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Apple-Device-Entitlement"), "device-entitlement-abc")
    }

    /// CSV export (`GET /api/export/transactions.csv`) is the other route
    /// that accepts the device entitlement token (Guideline 5.1.1(v)) — this
    /// exercises the actual network request, not just request construction.
    func testCSVExportAttachesCachedDeviceEntitlementTokenWhenSignedOut() async throws {
        let session = makeSession()
        let client = CongressTradeAPIClient(
            baseURL: Self.baseURL,
            tokenStore: MemoryTokenStore(token: nil),
            deviceEntitlementStore: MemoryTokenStore(token: "device-entitlement-abc"),
            session: session
        )
        let sawExpectedHeader = XCTestExpectation(description: "CSV request carried the device entitlement header")
        MockURLProtocol.handler = { request in
            XCTAssertNil(request.value(forHTTPHeaderField: "authorization"))
            if request.value(forHTTPHeaderField: "X-Apple-Device-Entitlement") == "device-entitlement-abc" {
                sawExpectedHeader.fulfill()
            }
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["content-type": "text/csv"]
            )!
            return (response, Data("filed_at,tx_date\n".utf8))
        }
        _ = try await client.exportTransactionsCSV()
        await fulfillment(of: [sawExpectedHeader], timeout: 1)
    }

    /// `CongressTradeStore.exportCSV` must not demand sign-in — only Premium
    /// (session OR this device's own anonymous Apple purchase). A signed-out,
    /// non-premium, non-locally-entitled attempt still fails, but with 402
    /// ("subscribe"), never 401 ("sign in").
    @MainActor
    func testExportCSVRefusesWithPremiumRequiredNeverSignInRequired() async {
        let store = CongressTradeStore(
            api: CongressTradeAPIClient(baseURL: Self.baseURL, tokenStore: MemoryTokenStore(token: nil), session: makeSession())
        )
        do {
            _ = try await store.exportCSV(from: nil, to: nil)
            XCTFail("expected exportCSV to throw when neither Premium nor a local entitlement is present")
        } catch let error as APIError {
            guard case .server(let status, let message, _) = error else {
                XCTFail("expected .server, got \(error)")
                return
            }
            XCTAssertEqual(status, 402)
            XCTAssertTrue(message.contains("Premium"))
        } catch {
            XCTFail("unexpected error type: \(error)")
        }
    }

    func testShareURLIsNotADigitalGoodsCheckoutPath() {
        let client = CongressTradeAPIClient(
            baseURL: URL(string: "https://example.test/api/client/v1")!,
            tokenStore: MemoryTokenStore(token: nil)
        )
        let url = client.shareURL(queryItem: URLQueryItem(name: "ticker", value: "NVDA"))
        XCTAssertEqual(url?.absoluteString, "https://example.test/?ticker=NVDA")
        XCTAssertFalse(url?.path.contains("pricing") == true)
        XCTAssertFalse(url?.path.contains("billing") == true)
        XCTAssertFalse(url?.path.contains("checkout") == true)
    }

    // MARK: - Test helpers

    private static func latencyProvider(
        label: String,
        matched: Int,
        usFirst: Int,
        providerFirst: Int,
        median: Int?,
        avg: Int?,
        status: String
    ) -> LatencyProvider {
        LatencyProvider(
            id: label.lowercased(),
            label: label,
            candidates: matched,
            matched: matched,
            strongMatched: matched,
            coveragePct: nil,
            ctCoveragePct: nil,
            providerCoveragePct: nil,
            comparisonStatus: status,
            usFirstCount: usFirst,
            providerFirstCount: providerFirst,
            tieCount: 0,
            medianLeadSec: median,
            avgLeadSec: avg,
            p90LeadSec: median,
            unmatchedProvider: 0,
            providerObserved: matched
        )
    }

    func testReviewModelDisplayNameNeverLabelsOpenRouterAsTheModel() {
        XCTAssertEqual(ReviewModelSummary.displayName(model: "openrouter"), "unknown model")
        XCTAssertEqual(ReviewModelSummary.displayName(model: "OpenRouter"), "unknown model")
        XCTAssertEqual(ReviewModelSummary.displayName(model: "  "), "unknown model")
        XCTAssertEqual(ReviewModelSummary.displayName(model: "google/gemini-2.5-flash"), "google/gemini-2.5-flash")
    }

    func testReviewQueueDecodingIsFailSoftAndKeepsModelId() throws {
        let json = """
        {
          "items": [{
            "docId": "H-2026-2003695",
            "reason": "low_confidence,unresolved_ticker",
            "payload": {"minConfidence": 0.4, "extractor": "vision", "transactions": [
              {"ticker": "AAPL", "assetName": "Apple", "txType": "P", "txDate": "2026-07-01", "amountMin": 1001, "amountMax": 15000, "owner": "self"}
            ]},
            "createdAt": "2026-06-24T02:53:00.000Z",
            "resolved": false,
            "status": "pending",
            "reviewRevision": 7,
            "chamber": "house",
            "docKind": "scanned_pdf",
            "agreementSuppressedAt": "",
            "models": [{
              "provider": "openrouter",
              "model": "google/gemini-2.5-flash",
              "ok": true,
              "rowCount": 1,
              "avgConfidence": 0.42
            }]
          }],
          "count": 1,
          "resolved": false,
          "nextCursor": "abc",
          "totals": {"unresolved": 12, "matching": 1}
        }
        """
        let decoded = try JSONDecoder().decode(ReviewQueueResponse.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.items.count, 1)
        XCTAssertEqual(decoded.totals?.unresolved, 12)
        let item = decoded.items[0]
        XCTAssertEqual(item.docId, "H-2026-2003695")
        XCTAssertEqual(item.reviewRevision, 7)
        XCTAssertFalse(item.isHeldFromAutomation)
        XCTAssertEqual(item.primaryModelLabel, "google/gemini-2.5-flash")
        XCTAssertEqual(item.reasonLabel, "Automated read below publish threshold; Asset symbol could not be matched to a known company")
        XCTAssertEqual(item.queuedRows.count, 1)
        XCTAssertEqual(item.queuedRows[0].confirmEditBody?["txType"] as? String, "B")
        XCTAssertEqual(item.queuedRows[0].confirmEditBody?["ticker"] as? String, "AAPL")
    }

    func testReviewQueueDecodingSurvivesNullFields() throws {
        let json = #"{"items":[{"docId":"X-1","models":null,"payload":null}],"totals":null}"#
        let decoded = try JSONDecoder().decode(ReviewQueueResponse.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.items.count, 1)
        XCTAssertEqual(decoded.items[0].docId, "X-1")
        XCTAssertEqual(decoded.items[0].reviewRevision, 1)
        XCTAssertTrue(decoded.items[0].models.isEmpty)
        XCTAssertEqual(decoded.items[0].reasonLabel, "Needs a human check")
    }

    func testPublicHealthAndAutopilotDecodingAreFailSoft() throws {
        let healthJSON = """
        {
          "ok": true,
          "status": "stalled",
          "pipeline": {
            "status": "stalled",
            "checks": [
              {"id": "extraction_provider", "status": "ok", "detail": "ok", "value": 3},
              {"id": "extraction_backlog", "status": "stalled", "detail": "9 unresolved", "value": 9},
              {"id": "autopilot_halt", "status": "stalled", "detail": "Autopilot runs halted: billing"},
              {"id": "data_freshness", "status": "degraded", "detail": "Latest transaction is 149h old", "value": 149},
              {"id": "ingestion_dead_letter", "status": "degraded", "detail": "320 failed", "value": 320},
              {"id": "latency_probes", "status": "stalled", "detail": "silent", "value": null},
              {"id": "polling_house", "status": "ok", "detail": "house polling live: last success 12m ago", "value": 0.2}
            ],
            "reviewQueue": {"unresolved": 9, "eligible": 4, "suppressed": 2, "terminal": 3}
          }
        }
        """
        let health = try JSONDecoder().decode(PublicHealthResponse.self, from: Data(healthJSON.utf8))
        XCTAssertEqual(health.status, "stalled")
        XCTAssertEqual(health.pipeline?.reviewQueue?.eligible, 4)
        XCTAssertEqual(health.pipeline?.reviewQueue?.terminal, 3)
        XCTAssertEqual(health.pipeline?.check(id: "latency_probes")?.status, "stalled")
        XCTAssertNil(health.pipeline?.check(id: "latency_probes")?.value)

        let autopilotJSON = """
        {
          "enabled": true,
          "backlog": 4,
          "reviewQueue": {"unresolved": 9, "eligible": 4, "suppressed": 2, "terminal": 3},
          "today": {"day": "2026-08-18", "spendUsd": 0.12, "budgetUsd": 2},
          "unacknowledgedHalt": {"id": "run-1", "status": "halted", "haltReason": "error_class:billing"},
          "runs": []
        }
        """
        let autopilot = try JSONDecoder().decode(AutopilotStatusResponse.self, from: Data(autopilotJSON.utf8))
        XCTAssertEqual(autopilot.unacknowledgedHalt?.haltReason, "error_class:billing")
        XCTAssertEqual(autopilot.today?.spendUsd, 0.12)
    }

    @MainActor
    func testNonAdminSeesNoAdminRow() async {
        let store = CongressTradeStore(
            api: CongressTradeAPIClient(
                baseURL: Self.baseURL,
                tokenStore: MemoryTokenStore(token: nil),
                session: makeSession()
            )
        )
        XCTAssertFalse(store.adminAccessGranted)
        XCTAssertFalse(store.showsAdminRow)
    }

    @MainActor
    func testSignedInNonAdminSeesNoAdminRow() async throws {
        let session = makeSession()
        let store = CongressTradeStore(
            api: CongressTradeAPIClient(
                baseURL: Self.baseURL,
                tokenStore: MemoryTokenStore(token: "native-session"),
                session: session
            )
        )
        MockURLProtocol.handler = { request in
            let path = request.url?.path ?? ""
            if path.hasSuffix("/auth/me") {
                XCTAssertEqual(request.value(forHTTPHeaderField: "authorization"), "Bearer native-session")
                XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
                return Self.response(for: request, json: """
                {"user":{"id":"u1","email":"user@example.com","name":"User","picture":null},"admin":{"allowed":false}}
                """)
            }
            if path.hasSuffix("/bootstrap") {
                return Self.response(for: request, json: """
                {"serverTime":"2026-08-18T00:00:00Z","auth":{"user":{"id":"u1","email":"user@example.com","name":"User","picture":null},"entitlement":{"premium":false,"status":null,"plan":null}},"capabilities":{},"endpoints":{}}
                """)
            }
            if path.contains("/feed") {
                return Self.response(for: request, json: Self.feedJSON(items: [], cursor: 0, count: 0, total: 0, limit: 50))
            }
            return Self.response(for: request, json: "{}")
        }
        await store.refresh()
        XCTAssertTrue(store.signedIn)
        XCTAssertFalse(store.showsAdminRow)
    }

    @MainActor
    func testAuthMeAdminAllowedShowsAdminRow() async throws {
        let session = makeSession()
        let tokens = MemoryTokenStore(token: "native-session")
        let client = CongressTradeAPIClient(
            baseURL: Self.baseURL,
            tokenStore: tokens,
            session: session
        )
        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/auth/me")
            XCTAssertEqual(request.value(forHTTPHeaderField: "authorization"), "Bearer native-session")
            XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
            return Self.response(for: request, json: """
            {"user":{"id":"u-admin","email":"admin@example.com","name":"Admin","picture":null},"admin":{"allowed":true}}
            """)
        }
        let store = CongressTradeStore(api: client)
        await store.probeAdminAccess()
        XCTAssertTrue(store.adminAccessGranted)
        XCTAssertTrue(store.showsAdminRow)
    }

    func testAuthMeDecodingIsFailSoft() throws {
        let decoded = try JSONDecoder().decode(AuthMeResponse.self, from: Data(#"{"user":null}"#.utf8))
        XCTAssertFalse(decoded.adminAllowed)
        XCTAssertNil(decoded.user)
    }

    func testAdminRequestReusesSessionBearerAndOmitsAdminToken() async throws {
        let session = makeSession()
        let tokens = MemoryTokenStore(token: "native-session")
        let client = CongressTradeAPIClient(
            baseURL: Self.baseURL,
            tokenStore: tokens,
            session: session
        )
        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/admin/review-queue")
            XCTAssertEqual(request.value(forHTTPHeaderField: "authorization"), "Bearer native-session")
            XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
            return Self.response(for: request, json: #"{"items":[],"count":0,"resolved":false}"#)
        }
        let response = try await client.reviewQueue()
        XCTAssertTrue(response.items.isEmpty)
    }

    func testReviewExtractionsDecodingMapsConfirmEdits() throws {
        let json = """
        {
          "docId": "H-1",
          "count": 1,
          "runs": [{
            "id": "run-1",
            "provider": "openrouter",
            "model": "google/gemini-2.5-flash",
            "ok": true,
            "rowCount": 1,
            "rows": [
              {"ticker": "MSFT", "assetName": "Microsoft", "txType": "S", "txDate": "2026-01-02", "amountMin": 15001, "owner": "spouse"}
            ]
          }]
        }
        """
        let decoded = try JSONDecoder().decode(ReviewExtractionsResponse.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.runs[0].displayName, "google/gemini-2.5-flash")
        XCTAssertTrue(decoded.runs[0].canConfirmFrom)
        XCTAssertEqual(decoded.runs[0].confirmEdits.first?["txType"] as? String, "S")
        XCTAssertEqual(decoded.runs[0].confirmEdits.first?["ticker"] as? String, "MSFT")
    }

    // MARK: - MockURLProtocol isolation (handler races)

    /// Leftover `refreshTrends()` / URLSession callbacks used to hit
    /// `XCTUnwrap(Self.handler)` after tearDown niled it, and XCTest blamed
    /// whichever case was running — including ones that never install a
    /// handler (`testFeedQueryEmitsTypeForBuySellFilter`).
    func testMockURLProtocolNilHandlerDoesNotRecordAnXCTUnwrapFailure() async {
        MockURLProtocol.handler = nil
        let session = makeSession()
        let url = URL(string: "https://example.test/api/analytics/latency-summary")!
        do {
            _ = try await session.data(from: url)
            XCTFail("a request with no handler must not succeed")
        } catch {
            let nsError = error as NSError
            XCTAssertEqual(nsError.domain, NSURLErrorDomain)
            XCTAssertEqual(nsError.code, URLError.cancelled.rawValue)
        }
    }

    /// `setTimeRange` fans out feed + trends.  Capturing only `/feed` must
    /// keep a latency-summary URL from winning `feedURL`.
    @MainActor
    func testFeedURLCaptureIgnoresConcurrentNonFeedRequests() async throws {
        var feedURL: URL?
        var nonFeedHits = 0
        MockURLProtocol.handler = { request in
            if request.url?.path.hasSuffix("/bootstrap") == true {
                return Self.response(for: request, json: Self.bootstrapJSON)
            }
            if request.url?.path.contains("/feed") == true {
                feedURL = request.url
                return Self.response(for: request, json: Self.feedJSON(items: [], cursor: 0, count: 0, total: 0, limit: 50))
            }
            nonFeedHits += 1
            return Self.response(for: request, json: "{}")
        }
        let store = CongressTradeStore(
            api: CongressTradeAPIClient(baseURL: Self.baseURL, tokenStore: MemoryTokenStore(token: nil), session: makeSession()),
            cursorStore: InMemorySyncCursorStore(),
            sleeper: { _ in }
        )
        await store.setTimeRange(.all)
        let captured = try XCTUnwrap(feedURL)
        XCTAssertTrue(captured.path.contains("/feed"), captured.path)
        XCTAssertFalse(captured.path.contains("latency"), captured.absoluteString)
        XCTAssertGreaterThan(nonFeedHits, 0, "setTimeRange must also fire the trends fan-out")
        let components = try XCTUnwrap(URLComponents(url: captured, resolvingAgainstBaseURL: false))
        XCTAssertNil(components.queryItems?.first(where: { $0.name == "from" }))
        store.cancelOutstandingWork()
    }

    func testTickerAnalyticsDecoding() throws {
        let json = """
        {
          "ticker": "AAPL",
          "asset": {
            "ticker": "AAPL",
            "companyName": "Apple Inc.",
            "logoUrl": "https://example.test/aapl.png",
            "sector": "Technology",
            "industry": "Consumer Electronics",
            "assetClass": "stock",
            "exchangeShort": "NASDAQ",
            "currency": "USD",
            "marketCap": 3450000000000.0,
            "marketCapBucket": "mega",
            "currentPrice": 224.5
          },
          "summary": {
            "totalTrades": 42,
            "buyCount": 28,
            "sellCount": 14,
            "exchangeCount": 0,
            "estimatedVolumeUsd": 5200000.0,
            "estimatedNetFlowUsd": 1800000.0,
            "firstTrade": "2023-01-15",
            "lastTrade": "2026-08-10",
            "memberCount": 18
          },
          "items": [],
          "cursor": 0,
          "count": 0,
          "total": 0,
          "analytics": {
            "window": "3m",
            "granularity": "week",
            "asOf": "2026-08-20T00:00:00Z",
            "estimatedAmounts": true,
            "summary": {
              "totalTrades": 10,
              "buyCount": 7,
              "sellCount": 3,
              "memberCount": 6,
              "estVolumeUsd": 1200000.0,
              "estNetFlowUsd": 400000.0,
              "netSentiment": 0.7,
              "firstTrade": "2026-05-20",
              "lastTrade": "2026-08-10"
            },
            "series": [
              {
                "period": "2026-W30",
                "buys": 3,
                "sells": 1,
                "estBuyVolUsd": 450000.0,
                "estSellVolUsd": 100000.0
              }
            ],
            "topBuyers": [
              {
                "filerId": "P000197",
                "fullName": "Nancy Pelosi",
                "partyBucket": "D",
                "photoUrl": "https://example.test/pelosi.jpg",
                "tradeCount": 4,
                "estVolumeUsd": 650000.0
              }
            ],
            "topSellers": [
              {
                "filerId": "M001157",
                "fullName": "Michael T. McCaul",
                "partyBucket": "R",
                "photoUrl": null,
                "tradeCount": 2,
                "estVolumeUsd": 200000.0
              }
            ],
            "backtest": {
              "totalBuyEvents": 24,
              "pricedDays": 500,
              "minN": 5,
              "horizons": [
                {
                  "days": 21,
                  "tradeCount": 24,
                  "n": 22,
                  "medianReturn": 0.045,
                  "avgReturn": 0.052,
                  "winRate": 0.68,
                  "medianExcess": 0.021,
                  "avgExcess": 0.025
                }
              ]
            }
          }
        }
        """
        let decoded = try JSONDecoder().decode(ClientTickerResponse.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.ticker, "AAPL")
        XCTAssertEqual(decoded.asset.companyName, "Apple Inc.")
        XCTAssertEqual(decoded.summary.totalTrades, 42)
        let analytics = try XCTUnwrap(decoded.analytics)
        XCTAssertEqual(analytics.window, "3m")
        XCTAssertEqual(analytics.granularity, "week")
        XCTAssertEqual(analytics.summary?.buyCount, 7)
        XCTAssertEqual(analytics.summary?.netSentiment, 0.7)
        XCTAssertEqual(analytics.series?.first?.period, "2026-W30")
        XCTAssertEqual(analytics.topBuyers?.first?.fullName, "Nancy Pelosi")
        XCTAssertEqual(analytics.topSellers?.first?.filerId, "M001157")
        XCTAssertEqual(analytics.backtest?.horizons?.first?.days, 21)
        XCTAssertEqual(analytics.backtest?.horizons?.first?.winRate, 0.68)
    }

    func testAmountRangeFilterMatching() throws {
        let rangeFilter = SubscriptionFilters(minAmount: 1001, maxAmount: 50000)
        let rangePayload = rangeFilter.commandPayload
        XCTAssertEqual(rangePayload["minAmount"] as? Int, 1001)
        XCTAssertEqual(rangePayload["maxAmount"] as? Int, 50000)

        let minOnlyFilter = SubscriptionFilters(minAmount: 50001, maxAmount: nil)
        let minPayload = minOnlyFilter.commandPayload
        XCTAssertEqual(minPayload["minAmount"] as? Int, 50001)
        XCTAssertNil(minPayload["maxAmount"])

        let maxOnlyFilter = SubscriptionFilters(minAmount: nil, maxAmount: 100000)
        let maxPayload = maxOnlyFilter.commandPayload
        XCTAssertNil(maxPayload["minAmount"])
        XCTAssertEqual(maxPayload["maxAmount"] as? Int, 100000)

        let emptyFilter = SubscriptionFilters(minAmount: nil, maxAmount: nil)
        let emptyPayload = emptyFilter.commandPayload
        XCTAssertNil(emptyPayload["minAmount"])
        XCTAssertNil(emptyPayload["maxAmount"])
    }

    func testTickerIncludeAnalyticsQueryParam() async throws {
        let session = makeSession()
        let client = CongressTradeAPIClient(
            baseURL: Self.baseURL,
            tokenStore: MemoryTokenStore(token: nil),
            session: session
        )
        let capture = RequestCapture()
        MockURLProtocol.handler = { request in
            capture.record(request.url)
            return Self.response(
                for: request,
                json: """
                {
                  "ticker": "NVDA",
                  "asset": { "ticker": "NVDA" },
                  "summary": {},
                  "items": [],
                  "cursor": 0,
                  "count": 0,
                  "total": 0,
                  "analytics": {
                    "window": "1y",
                    "granularity": "month",
                    "estimatedAmounts": true
                  }
                }
                """
            )
        }

        let result = try await client.ticker(
            "NVDA",
            window: "1y",
            include: "analytics"
        )

        let recordedURL = try XCTUnwrap(capture.last(pathContains: "/ticker/NVDA"))
        let components = URLComponents(url: recordedURL, resolvingAgainstBaseURL: false)
        let includeParam = components?.queryItems?.first(where: { $0.name == "include" })?.value
        let windowParam = components?.queryItems?.first(where: { $0.name == "window" })?.value

        XCTAssertEqual(includeParam, "analytics")
        XCTAssertEqual(windowParam, "1y")
        XCTAssertEqual(result.ticker, "NVDA")
        XCTAssertEqual(result.analytics?.window, "1y")
    }

    private func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    private static let baseURL = URL(string: "https://example.test/api/client/v1")!

    private static let bootstrapJSON = """
    {"serverTime":"2026-07-18T00:00:00Z","auth":{"user":null,"entitlement":{"premium":false,"status":null,"plan":null}},
     "capabilities":{},"endpoints":{}}
    """

    private static func feedJSON(items: [String], cursor: Int, count: Int, total: Int, limit: Int) -> String {
        "{\"items\":[\(items.joined(separator: ","))],\"cursor\":\(cursor),\"count\":\(count),\"total\":\(total),\"limit\":\(limit),\"nextPollAfterSec\":30}"
    }

    /// Enough empty analytics envelopes for the Trends fan-out `try await`s.
    private static func trendsEndpointResponse(for request: URLRequest) -> (HTTPURLResponse, Data) {
        let path = request.url?.path ?? ""
        if path.hasSuffix("/bootstrap") {
            return response(for: request, json: bootstrapJSON)
        }
        if path.contains("/feed") {
            return response(for: request, json: feedJSON(items: [], cursor: 0, count: 0, total: 0, limit: 50))
        }
        if path.contains("/api/analytics/ticker-leaderboard") {
            return response(for: request, json: #"{"tickers":[]}"#)
        }
        if path.contains("/api/analytics/volume-over-time") {
            return response(for: request, json: #"{"series":[]}"#)
        }
        if path.contains("/api/analytics/sector-flow") {
            return response(for: request, json: #"{"sectors":[]}"#)
        }
        if path.contains("/api/analytics/member-leaderboard") {
            return response(for: request, json: #"{"members":[]}"#)
        }
        if path.contains("/api/analytics/cluster-buys") {
            return response(for: request, json: #"{"clusters":[]}"#)
        }
        return response(for: request, json: "{}")
    }

    private static func tradeJSON(id: String, cursor: Int) -> String {
        """
        {"id":"\(id)","cursor":\(cursor),"docId":"doc_\(id)","member":{},
         "asset":{"name":"Acme Corp"},"transaction":{"type":"P","isOption":false},
         "filing":{},"confidence":0.9,"source":"primary"}
        """
    }

    @MainActor
    private static func makeInMemoryModelContext() throws -> ModelContext {
        let configuration = ModelConfiguration(isStoredInMemoryOnly: true)
        let container = try ModelContainer(for: ClientTrade.self, configurations: configuration)
        return ModelContext(container)
    }

    private static func makeTrade(id: String, cursor: Int) -> ClientTrade {
        ClientTrade(
            id: id,
            cursor: cursor,
            docId: "doc_\(id)",
            member: .init(id: nil, name: nil, chamber: nil, party: nil, state: nil, photoUrl: nil),
            asset: .init(name: "Acme Corp", ticker: nil, type: nil, sector: nil, marketCapBucket: nil),
            transaction: .init(date: nil, type: "P", owner: nil, amountMin: nil, amountMax: nil, isOption: false),
            filing: .init(filedDate: nil, firstSeenAt: nil, sourceUrl: nil),
            confidence: 0.9,
            source: .primary
        )
    }

    /// The URL loading system is free to hand a POST body to `URLProtocol`
    /// subclasses as either `httpBody` (in-memory) or `httpBodyStream`
    /// (streamed) — which one it picks is an internal, OS-version-dependent
    /// implementation detail, not something callers control. Read both so
    /// `MockURLProtocol` handlers stay correct regardless of which path the
    /// current OS took for a given request.
    private static func requestBody(_ request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        let bufferSize = 4096
        var buffer = [UInt8](repeating: 0, count: bufferSize)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: bufferSize)
            guard read > 0 else { break }
            data.append(buffer, count: read)
        }
        return data.isEmpty ? nil : data
    }

    private static func response(
        for request: URLRequest,
        status: Int = 200,
        json: String
    ) -> (HTTPURLResponse, Data) {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: nil,
            headerFields: ["content-type": "application/json"]
        )!
        return (response, Data(json.utf8))
    }

    // MARK: - Trades search slot (board 341d17d2)

    /// The bug: one keystroke set `isApplyingFilters`, which flipped the slot to
    /// `.updating`, which swapped the `TextField` out of the hierarchy and
    /// cleared focus — so Trades search was one character per tap.
    func testSearchSlotDoesNotShowUpdatingWhileFocused() {
        XCTAssertNil(
            FeedDashboardView.searchSlotStatus(
                notice: nil,
                isOffline: false,
                isTradesUpdating: true,
                isSearchFocused: true
            ),
            "A refresh in flight must not replace the field while the user is typing in it."
        )
    }

    func testSearchSlotShowsUpdatingWhenNotFocused() {
        XCTAssertEqual(
            FeedDashboardView.searchSlotStatus(
                notice: nil,
                isOffline: false,
                isTradesUpdating: true,
                isSearchFocused: false
            ),
            .updating
        )
    }

    /// `.reload` must still win over focus: it is the only recovery control on
    /// the tab, so swallowing it to save a keystroke would strand a failed load.
    func testSearchSlotReloadStillWinsWhileFocused() {
        XCTAssertEqual(
            FeedDashboardView.searchSlotStatus(
                notice: "Request failed",
                isOffline: false,
                isTradesUpdating: true,
                isSearchFocused: true
            ),
            .reload(message: "Request failed")
        )
    }

    func testSearchSlotOfflineReportsOfflineNotTheRawNotice() {
        XCTAssertEqual(
            FeedDashboardView.searchSlotStatus(
                notice: "",
                isOffline: true,
                isTradesUpdating: false,
                isSearchFocused: true
            ),
            .reload(message: "You are offline.")
        )
    }

    // MARK: - Conflicts decode (board bf27125a)

    /// Captured verbatim from `GET /api/analytics/conflicts?window=365d&limit=2`
    /// — the shape `app/src/analytics/routes.ts` actually emits.  The previous
    /// model required `bioguideId`, `committeeCode` and `date`, none of which
    /// appear here, so every decode threw and the whole section stayed hidden.
    private static let conflictsJSON = """
    {
      "count": 2,
      "conflicts": [
        {
          "id": "abc123",
          "ticker": "NVDA",
          "sector": "Information Technology",
          "txType": "B",
          "txDate": "2026-05-04",
          "filerId": "P000197",
          "memberName": "Nancy Pelosi",
          "chamber": "house",
          "partyBucket": "D",
          "viaCommittees": ["Committee on Science, Space, and Technology"],
          "estAmountUsd": 500000
        },
        {
          "id": "def456",
          "ticker": "XOM",
          "sector": null,
          "txType": "S",
          "txDate": null,
          "filerId": "S000033",
          "memberName": null,
          "chamber": null,
          "partyBucket": null,
          "viaCommittees": [],
          "estAmountUsd": null
        }
      ]
    }
    """

    func testConflictsDecodeAgainstLiveResponseShape() throws {
        let decoded = try JSONDecoder().decode(
            ConflictCandidateResponse.self,
            from: Data(Self.conflictsJSON.utf8)
        )
        let items = try XCTUnwrap(decoded.conflicts)
        XCTAssertEqual(items.count, 2)

        let first = items[0]
        XCTAssertEqual(first.id, "abc123")
        XCTAssertEqual(first.memberTargetId, "P000197")
        XCTAssertEqual(first.displayName, "Nancy Pelosi")
        XCTAssertEqual(first.contextLine, "Committee on Science, Space, and Technology · Information Technology")

        // Every nullable field null at once must still decode — one null used to
        // be enough to blank the entire section.
        let second = items[1]
        XCTAssertEqual(second.memberTargetId, "S000033")
        XCTAssertEqual(second.displayName, "S000033")
        XCTAssertEqual(second.contextLine, "")
        XCTAssertTrue(second.committees.isEmpty)
    }

    // MARK: - Calendar-year analytics window (board d2c4a15e)

    /// Both calendar-year chips used to send `365d`, so "Last Calendar Year"
    /// showed trailing-365-day analytics — and disagreed with the Trades list
    /// underneath it, which filters on the exact `from`/`to` bounds.
    /// `app/src/analytics/sql.ts:43` accepts these two as first-class windows.
    func testCalendarYearRangesSendCalendarWindows() {
        XCTAssertEqual(TimeRange.thisCalendarYear.analyticsWindow, "this_cy")
        XCTAssertEqual(TimeRange.lastCalendarYear.analyticsWindow, "last_cy")
    }

    func testNonCalendarRangesStillSendDayCounts() {
        XCTAssertEqual(TimeRange.all.analyticsWindow, "all")
        XCTAssertNotEqual(TimeRange.thisCalendarYear.analyticsWindow, TimeRange.lastCalendarYear.analyticsWindow)
    }

    // MARK: - Error copy (board 5c1c9706)

    /// A support report has to be able to say which failure it was.
    func testServerErrorMessageCarriesStatusCode() {
        XCTAssertTrue(
            APIError.server(status: 502, message: "", retryAfterSeconds: nil).userFacingMessage.contains("502"),
            "5xx copy must name the status code."
        )
        XCTAssertTrue(
            APIError.server(status: 418, message: "Request failed", retryAfterSeconds: nil).userFacingMessage.contains("418"),
            "The generic fallback must name the status code."
        )
    }
}

private final class InMemorySyncCursorStore: SyncCursorStore {
    private var values: [String: Int] = [:]

    func cursor(for key: String) -> Int? { values[key] }
    func setCursor(_ cursor: Int, for key: String) { values[key] = cursor }
}

private final class MemoryTokenStore: SessionTokenStore {
    private var token: String?

    init(token: String?) {
        self.token = token
    }

    func load() throws -> String? { token }
    func save(_ token: String) throws { self.token = token }
    func clear() throws { token = nil }
}

private final class MockURLProtocol: URLProtocol {
    typealias Handler = (URLRequest) throws -> (HTTPURLResponse, Data)

    /// Stamped onto each request in `canonicalRequest` so a leftover
    /// URLSession callback from an earlier test cannot run a later test's
    /// handler, and so `startLoading` never `XCTUnwrap`s a niled handler
    /// onto whichever case happens to be running.
    private static let generationPropertyKey = "CongressTrade.MockURLProtocol.generation"
    private static let lock = NSLock()
    private static var currentGeneration: UInt64 = 0
    private static var boxedHandler: Handler?

    static var handler: Handler? {
        get {
            lock.lock()
            defer { lock.unlock() }
            return boxedHandler
        }
        set {
            lock.lock()
            defer { lock.unlock() }
            currentGeneration &+= 1
            boxedHandler = newValue
        }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        if URLProtocol.property(forKey: generationPropertyKey, in: request) != nil {
            return request
        }
        guard let copy = (request as NSURLRequest).mutableCopy() as? NSMutableURLRequest else {
            return request
        }
        lock.lock()
        let generation = currentGeneration
        lock.unlock()
        URLProtocol.setProperty(NSNumber(value: generation), forKey: generationPropertyKey, in: copy)
        return copy as URLRequest
    }

    override func startLoading() {
        let capturedHandler: Handler?
        let activeGeneration: UInt64
        Self.lock.lock()
        capturedHandler = Self.boxedHandler
        activeGeneration = Self.currentGeneration
        Self.lock.unlock()

        let requestGeneration = (URLProtocol.property(forKey: Self.generationPropertyKey, in: request) as? NSNumber)?.uint64Value
        if let requestGeneration, requestGeneration != activeGeneration {
            client?.urlProtocol(self, didFailWithError: URLError(.cancelled))
            return
        }
        guard let handler = capturedHandler else {
            // Leftover after tearDown, or a unit test that never installed a
            // handler.  Do not XCTUnwrap — that records a failure on the
            // currently running test.
            client?.urlProtocol(self, didFailWithError: URLError(.cancelled))
            return
        }

        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}
