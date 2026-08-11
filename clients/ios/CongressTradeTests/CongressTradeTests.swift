import Foundation
import SwiftData
import XCTest
@testable import CongressTrade

final class CongressTradeTests: XCTestCase {
    /// A store does not necessarily go quiet the moment its test method
    /// returns. `refreshTrends()` fans out to 12 concurrent `/api/analytics/*`
    /// requests behind `async let`, and when one of them throws, the siblings
    /// are cancelled at scope exit — but URLSession cancellation is
    /// asynchronous, so an already-started request can still reach
    /// `MockURLProtocol` a moment later, by which time the NEXT test owns the
    /// global handler. That straggler then failed the innocent test, because
    /// handlers assert on the request they expect ("Idempotency-Key == del-1").
    ///
    /// Stamping every session with the epoch of the test that built it, and
    /// dropping requests whose epoch is stale, makes each test see only its
    /// own traffic.
    override func setUp() {
        super.setUp()
        MockURLProtocol.epoch = UUID().uuidString
    }

    override func tearDown() {
        MockURLProtocol.handler = nil
        MockURLProtocol.epoch = UUID().uuidString
        super.tearDown()
    }

    func testParseTickersNormalizesAndDropsEmptyValues() async {
        let tickers = await CongressTradeStore.parseTickers(" aapl, MSFT, , nvda \n")
        XCTAssertEqual(tickers, ["AAPL", "MSFT", "NVDA"])
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

        var feedURL: URL?
        MockURLProtocol.handler = { request in
            if request.url?.path.hasSuffix("/bootstrap") == true {
                return Self.response(for: request, json: Self.bootstrapJSON)
            }
            if Self.isFeedRequest(request) { feedURL = request.url }
            return Self.response(for: request, json: Self.feedJSON(items: [], cursor: 0, count: 0, total: 0, limit: 50))
        }

        // Empty selection omits chamber= so unresolved-chamber rows stay in view.
        await store.setChamberSelection([])

        let components = try XCTUnwrap(URLComponents(url: XCTUnwrap(feedURL), resolvingAgainstBaseURL: false))
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
        var feedURL: URL?
        MockURLProtocol.handler = { request in
            if request.url?.path.hasSuffix("/bootstrap") == true {
                return Self.response(for: request, json: Self.bootstrapJSON)
            }
            if Self.isFeedRequest(request) { feedURL = request.url }
            return Self.response(for: request, json: Self.feedJSON(items: [], cursor: 0, count: 0, total: 0, limit: 50))
        }

        // Selecting a proper subset (not all three) must send a sorted CSV.
        await store.setChamberSelection([.executive, .house])

        let components = try XCTUnwrap(URLComponents(url: XCTUnwrap(feedURL), resolvingAgainstBaseURL: false))
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
        var feedCallCount = 0
        var feedURL: URL?
        MockURLProtocol.handler = { request in
            if request.url?.path.hasSuffix("/bootstrap") == true {
                return Self.response(for: request, json: Self.bootstrapJSON)
            }
            if Self.isFeedRequest(request) {
                feedCallCount += 1
                feedURL = request.url
            }
            return Self.response(for: request, json: Self.feedJSON(
                items: (1...10).map { Self.tradeJSON(id: "a\($0)", cursor: 100 + $0) },
                cursor: 110, count: 10, total: 718, limit: 100
            ))
        }

        let store = CongressTradeStore(
            api: CongressTradeAPIClient(baseURL: Self.baseURL, tokenStore: MemoryTokenStore(token: nil), session: makeSession()),
            cursorStore: cursorStore,
            sleeper: { _ in }
        )
        XCTAssertEqual(store.selectedTimeRange, .ninetyDays)
        await store.setChamberSelection([.house, .senate])

        XCTAssertEqual(feedCallCount, 1, "Visible feed is one newest-first snapshot, not a multi-page historical crawl")
        XCTAssertEqual(store.tradeTotal, 718, "Trades KPI must use API total, never max cursor_seq")
        XCTAssertEqual(store.feed?.cursor, 110)
        XCTAssertNil(store.feedNotice)

        let components = try XCTUnwrap(URLComponents(url: XCTUnwrap(feedURL), resolvingAgainstBaseURL: false))
        let items = components.queryItems ?? []
        XCTAssertEqual(items.first(where: { $0.name == "order" })?.value, "desc")
        XCTAssertEqual(items.first(where: { $0.name == "sort" })?.value, "tx_date")
        XCTAssertNotNil(items.first(where: { $0.name == "from" })?.value, "Default 90d window must send from=")
        // Cursor watermark is keyed by chamber+range+sides — the literal key
        // matters, not just the value: a watermark written under a key nobody
        // reads back silently disables background catch-up instead of failing
        // loudly. `Set<TradeTypeFilter>()` (no side chips) serializes as "all".
        XCTAssertEqual(cursorStore.cursor(for: "house,senate|90d|all"), 110)
    }

    @MainActor
    func testTimeRangeAllOmitsFromParameter() async throws {
        var feedURL: URL?
        MockURLProtocol.handler = { request in
            if request.url?.path.hasSuffix("/bootstrap") == true {
                return Self.response(for: request, json: Self.bootstrapJSON)
            }
            if Self.isFeedRequest(request) { feedURL = request.url }
            return Self.response(for: request, json: Self.feedJSON(items: [], cursor: 0, count: 0, total: 0, limit: 100))
        }

        let store = CongressTradeStore(
            api: CongressTradeAPIClient(baseURL: Self.baseURL, tokenStore: MemoryTokenStore(token: nil), session: makeSession()),
            cursorStore: InMemorySyncCursorStore(),
            sleeper: { _ in }
        )
        await store.setTimeRange(.all)

        let components = try XCTUnwrap(URLComponents(url: XCTUnwrap(feedURL), resolvingAgainstBaseURL: false))
        XCTAssertNil(components.queryItems?.first(where: { $0.name == "from" }))
    }

    // MARK: - Trades sort + pagination (owner punch list #2, items 7-8)

    @MainActor
    func testGoToNextPageSendsOffsetAndTotalPagesReflectsAPITotal() async throws {
        var feedURLs: [URL] = []
        MockURLProtocol.handler = { request in
            if request.url?.path.hasSuffix("/bootstrap") == true {
                return Self.response(for: request, json: Self.bootstrapJSON)
            }
            if Self.isFeedRequest(request), let url = request.url { feedURLs.append(url) }
            return Self.response(for: request, json: Self.feedJSON(
                items: (1...10).map { Self.tradeJSON(id: "a\($0)", cursor: 100 + $0) },
                cursor: 110, count: 10, total: 250, limit: 100
            ))
        }

        let store = CongressTradeStore(
            api: CongressTradeAPIClient(baseURL: Self.baseURL, tokenStore: MemoryTokenStore(token: nil), session: makeSession()),
            cursorStore: InMemorySyncCursorStore(),
            sleeper: { _ in }
        )
        await store.refresh()

        XCTAssertEqual(store.totalPages, 3, "250 rows at 100/page rounds up to 3 pages")
        XCTAssertTrue(store.canGoToNextPage)
        XCTAssertFalse(store.canGoToPreviousPage)
        // The first page must not send offset= at all (page 1, not offset=0).
        let firstComponents = try XCTUnwrap(URLComponents(url: XCTUnwrap(feedURLs.last), resolvingAgainstBaseURL: false))
        XCTAssertNil(firstComponents.queryItems?.first(where: { $0.name == "offset" }))

        await store.goToNextPage()
        XCTAssertEqual(store.currentPage, 1)
        XCTAssertTrue(store.canGoToPreviousPage)

        let secondComponents = try XCTUnwrap(URLComponents(url: XCTUnwrap(feedURLs.last), resolvingAgainstBaseURL: false))
        XCTAssertEqual(secondComponents.queryItems?.first(where: { $0.name == "offset" })?.value, "100")

        await store.goToPreviousPage()
        XCTAssertEqual(store.currentPage, 0)
        XCTAssertFalse(store.canGoToPreviousPage)
    }

    @MainActor
    func testSwitchingToAmountSortDoesNotRefetchButSwitchingBackToDateDoes() async throws {
        var feedCallCount = 0
        var lastURL: URL?
        MockURLProtocol.handler = { request in
            if request.url?.path.hasSuffix("/bootstrap") == true {
                return Self.response(for: request, json: Self.bootstrapJSON)
            }
            if Self.isFeedRequest(request) { feedCallCount += 1 }
            lastURL = request.url
            return Self.response(for: request, json: Self.feedJSON(items: [], cursor: 0, count: 0, total: 0, limit: 100))
        }

        let store = CongressTradeStore(
            api: CongressTradeAPIClient(baseURL: Self.baseURL, tokenStore: MemoryTokenStore(token: nil), session: makeSession()),
            cursorStore: InMemorySyncCursorStore(),
            sleeper: { _ in }
        )
        await store.refresh()
        XCTAssertEqual(feedCallCount, 1)

        // Amount has no backend sort key — selecting it must NOT refetch.
        await store.setFeedSortKey(.amount)
        XCTAssertEqual(store.feedSortKey, .amount)
        XCTAssertEqual(feedCallCount, 1, "Amount sort is a local re-sort of the already-loaded page only")

        // Flipping direction while on Amount is also local-only.
        await store.toggleFeedSortDirection()
        XCTAssertEqual(store.feedSortDirection, .ascending)
        XCTAssertEqual(feedCallCount, 1)

        // Switching back to Date DOES refetch (it's a real backend sort key)
        // and carries over the direction set while on Amount.
        await store.setFeedSortKey(.date)
        XCTAssertEqual(feedCallCount, 2)

        let components = try XCTUnwrap(URLComponents(url: XCTUnwrap(lastURL), resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.queryItems?.first(where: { $0.name == "sort" })?.value, "tx_date")
        XCTAssertEqual(components.queryItems?.first(where: { $0.name == "order" })?.value, "asc")
    }

    @MainActor
    func testChangingATimeRangeResetsCurrentPageToZero() async throws {
        var feedURLs: [URL] = []
        MockURLProtocol.handler = { request in
            if request.url?.path.hasSuffix("/bootstrap") == true {
                return Self.response(for: request, json: Self.bootstrapJSON)
            }
            if Self.isFeedRequest(request), let url = request.url { feedURLs.append(url) }
            return Self.response(for: request, json: Self.feedJSON(items: [], cursor: 0, count: 0, total: 300, limit: 100))
        }

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

        let components = try XCTUnwrap(URLComponents(url: XCTUnwrap(feedURLs.last), resolvingAgainstBaseURL: false))
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
    func testPermanentClientErrorIsNotRetried() async throws {
        var feedAttempts = 0
        MockURLProtocol.handler = { request in
            if request.url?.path.hasSuffix("/bootstrap") == true {
                return Self.response(for: request, json: Self.bootstrapJSON)
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

    func testPartyFilterBucketsMirrorServerAsPartyBucket() {
        // Mirrors `asPartyBucket` in `app/src/analytics/sql.ts`: first
        // letter D/R, anything else non-empty is Other, empty/nil unresolved.
        XCTAssertEqual(PartyFilter.bucket(for: "Democratic"), .democrat)
        XCTAssertEqual(PartyFilter.bucket(for: "d"), .democrat)
        XCTAssertEqual(PartyFilter.bucket(for: "Republican"), .republican)
        XCTAssertEqual(PartyFilter.bucket(for: "Independent"), .other)
        XCTAssertNil(PartyFilter.bucket(for: ""))
        XCTAssertNil(PartyFilter.bucket(for: nil))
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
        XCTAssertEqual(thisYear.label, "This Calendar Year")
        XCTAssertEqual(lastYear.label, "Last Calendar Year")
    }

    func testAPIErrorCancellationIsNotRetryable() {
        let cancelled = APIError.transport(URLError(.cancelled))
        XCTAssertTrue(cancelled.isCancellation)
        XCTAssertFalse(cancelled.isRetryable)
        let offline = APIError.transport(URLError(.notConnectedToInternet))
        XCTAssertFalse(offline.isCancellation)
        XCTAssertTrue(offline.isOffline)
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
        var feedURL: URL?
        MockURLProtocol.handler = { request in
            if request.url?.path.hasSuffix("/bootstrap") == true {
                return Self.response(for: request, json: Self.bootstrapJSON)
            }
            if Self.isFeedRequest(request) { feedURL = request.url }
            return Self.response(for: request, json: Self.feedJSON(items: [], cursor: 0, count: 0, total: 0, limit: 50))
        }

        await store.setTradeTypeSelection([.buy])

        let components = try XCTUnwrap(URLComponents(url: XCTUnwrap(feedURL), resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.queryItems?.first(where: { $0.name == "type" })?.value, "B")
        // Free-text search still uses memberName when set later; type alone must not emit member=.
        XCTAssertNil(components.queryItems?.first(where: { $0.name == "member" }))
    }

    /// Multi-select Trade Type pill (owner directive 2026-08-09): the
    /// server's `type=` (`asTxType`) accepts exactly one value, so selecting
    /// 2+ sides must omit the param (an unfiltered fetch, narrowed correctly
    /// client-side by `FeedDashboardView.filteredTrades`) rather than send a
    /// CSV the server can't parse — mirroring the web's own
    /// `selectedSideParam` fallback for its `qSideGroup` chips.
    @MainActor
    func testSetTradeTypeSelectionOmitsTypeParamWhenMultipleSidesSelected() async throws {
        let store = CongressTradeStore(
            api: CongressTradeAPIClient(baseURL: Self.baseURL, tokenStore: MemoryTokenStore(token: nil), session: makeSession()),
            cursorStore: InMemorySyncCursorStore(),
            sleeper: { _ in }
        )
        var feedURL: URL?
        MockURLProtocol.handler = { request in
            if request.url?.path.hasSuffix("/bootstrap") == true {
                return Self.response(for: request, json: Self.bootstrapJSON)
            }
            if Self.isFeedRequest(request) { feedURL = request.url }
            return Self.response(for: request, json: Self.feedJSON(items: [], cursor: 0, count: 0, total: 0, limit: 50))
        }

        await store.setTradeTypeSelection([.buy, .sell])

        let components = try XCTUnwrap(URLComponents(url: XCTUnwrap(feedURL), resolvingAgainstBaseURL: false))
        XCTAssertNil(components.queryItems?.first(where: { $0.name == "type" }))
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
        var feedURL: URL?
        MockURLProtocol.handler = { request in
            if request.url?.path.hasSuffix("/bootstrap") == true {
                return Self.response(for: request, json: Self.bootstrapJSON)
            }
            if Self.isFeedRequest(request) { feedURL = request.url }
            return Self.response(for: request, json: Self.feedJSON(items: [], cursor: 0, count: 0, total: 0, limit: 50))
        }

        await store.setChamberSelection([.house, .executive])

        let components = try XCTUnwrap(URLComponents(url: XCTUnwrap(feedURL), resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.queryItems?.first(where: { $0.name == "chamber" })?.value, "executive,house")
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
    func testSetSearchUsesMemberNameNotMember() async throws {
        let store = CongressTradeStore(
            api: CongressTradeAPIClient(baseURL: Self.baseURL, tokenStore: MemoryTokenStore(token: nil), session: makeSession()),
            cursorStore: InMemorySyncCursorStore(),
            sleeper: { _ in }
        )
        var feedURL: URL?
        MockURLProtocol.handler = { request in
            if request.url?.path.hasSuffix("/bootstrap") == true {
                return Self.response(for: request, json: Self.bootstrapJSON)
            }
            if Self.isFeedRequest(request) { feedURL = request.url }
            return Self.response(for: request, json: Self.feedJSON(items: [], cursor: 0, count: 0, total: 0, limit: 50))
        }

        await store.setSearch("Nancy Pelosi")

        let components = try XCTUnwrap(URLComponents(url: XCTUnwrap(feedURL), resolvingAgainstBaseURL: false))
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

    // MARK: - Test helpers

    private func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        // See `setUp()` — this is what keeps one test's late requests from
        // landing on the next test's handler.
        configuration.httpAdditionalHeaders = [MockURLProtocol.epochHeader: MockURLProtocol.epoch]
        return URLSession(configuration: configuration)
    }

    private static let baseURL = URL(string: "https://example.test/api/client/v1")!

    /// Identifies the `GET /api/client/v1/feed` request specifically.
    ///
    /// The filters both tabs share (chamber, party, timeframe, sides) fan out
    /// to `refreshTrends()` as well as the feed, and `refreshTrends()` is
    /// TWELVE concurrent `/api/analytics/*` requests. Handlers that recorded
    /// "anything whose path is not /bootstrap" as the feed were therefore
    /// recording 13 requests and keeping whichever one happened to finish
    /// last — so `feedURL` usually ended up being an analytics URL with no
    /// `sort`/`order`/`from`/`chamber`/`type` on it, and `feedCallCount` read
    /// 13. Matching the feed endpoint POSITIVELY is what makes these
    /// assertions deterministic; it does not relax any of them.
    private static func isFeedRequest(_ request: URLRequest) -> Bool {
        request.url?.path.hasSuffix("/feed") == true
    }

    private static let bootstrapJSON = """
    {"serverTime":"2026-07-18T00:00:00Z","auth":{"user":null,"entitlement":{"premium":false,"status":null,"plan":null}},
     "capabilities":{},"endpoints":{}}
    """

    private static func feedJSON(items: [String], cursor: Int, count: Int, total: Int, limit: Int) -> String {
        "{\"items\":[\(items.joined(separator: ","))],\"cursor\":\(cursor),\"count\":\(count),\"total\":\(total),\"limit\":\(limit),\"nextPollAfterSec\":30}"
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
    static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    /// Identifies which test built the session a request came from. Rotated in
    /// `setUp`/`tearDown`; see the comment there for what it prevents.
    static let epochHeader = "X-CT-Test-Epoch"
    static var epoch = UUID().uuidString

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        // Answer only requests belonging to the test that is running right
        // now (see `CongressTradeTests.setUp`). A straggler from a finished
        // test gets the same cancellation the store already treats as benign
        // (`APIError.isCancellation`) instead of being unwrapped into a
        // failure charged to an innocent test.
        guard let handler = Self.handler,
              request.value(forHTTPHeaderField: Self.epochHeader) == Self.epoch else {
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
