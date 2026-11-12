import Foundation

protocol SessionTokenStore {
    func load() throws -> String?
    func save(_ token: String) throws
    func clear() throws
}

/// Persists the feed sync watermark (`ClientFeedResponse.cursor`) per request
/// shape. A single global cursor is only valid for resuming the exact same
/// filter that produced it — rows excluded by a narrower filter (e.g. an
/// unselected chamber) were never fetched, so widening the filter later must
/// resume from that filter's own watermark, not whatever the last-used
/// filter happened to reach. CT-AUD-009.
protocol SyncCursorStore {
    func cursor(for key: String) -> Int?
    func setCursor(_ cursor: Int, for key: String)
}

final class UserDefaultsSyncCursorStore: SyncCursorStore {
    private let defaults: UserDefaults
    private let keyPrefix = "trade.congress.sync.cursor."

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func cursor(for key: String) -> Int? {
        let storageKey = keyPrefix + key
        guard defaults.object(forKey: storageKey) != nil else { return nil }
        return defaults.integer(forKey: storageKey)
    }

    func setCursor(_ cursor: Int, for key: String) {
        defaults.set(cursor, forKey: keyPrefix + key)
    }
}

struct FeedQuery: Equatable {
    var limit: Int = 30
    var since: Int?
    var ticker: String?
    /// Exact bioguide / filer id (`member=`). Prefer `memberName` for free-text search.
    var member: String?
    /// Free-text politician name (`memberName=` LIKE path). Used for typed search.
    var memberName: String?
    var chamber: String?
    var type: String?
    var party: String?
    var assetClass: String?
    var from: String?
    var to: String?
    /// Backend sort key: `tx_date` | `published` | cursor (default). Prefer
    /// `tx_date` for the consumer feed so seed imports of old filings don't
    /// float to the top just because they got a high cursor_seq.
    var sort: String?
    var order: String?
    /// Offset-paged snapshot navigation (owner punch list #2, item 8) —
    /// `nil`/`0` omits the param (page 1). Server-guarded at
    /// `MAX_PUBLIC_TX_OFFSET` (2000); see `app/docs/client-mobile-api.md`.
    var offset: Int?

    var queryItems: [URLQueryItem] {
        var items = [URLQueryItem(name: "limit", value: String(limit))]
        if let since { items.append(URLQueryItem(name: "since", value: String(since))) }
        if let ticker, !ticker.isEmpty { items.append(URLQueryItem(name: "ticker", value: ticker)) }
        if let member, !member.isEmpty { items.append(URLQueryItem(name: "member", value: member)) }
        if let memberName, !memberName.isEmpty { items.append(URLQueryItem(name: "memberName", value: memberName)) }
        if let chamber, !chamber.isEmpty { items.append(URLQueryItem(name: "chamber", value: chamber)) }
        if let type, !type.isEmpty { items.append(URLQueryItem(name: "type", value: type)) }
        if let party, !party.isEmpty { items.append(URLQueryItem(name: "party", value: party)) }
        if let assetClass, !assetClass.isEmpty { items.append(URLQueryItem(name: "assetClass", value: assetClass)) }
        if let from, !from.isEmpty { items.append(URLQueryItem(name: "from", value: from)) }
        if let to, !to.isEmpty { items.append(URLQueryItem(name: "to", value: to)) }
        if let sort, !sort.isEmpty { items.append(URLQueryItem(name: "sort", value: sort)) }
        if let order, !order.isEmpty { items.append(URLQueryItem(name: "order", value: order)) }
        if let offset, offset > 0 { items.append(URLQueryItem(name: "offset", value: String(offset))) }
        return items
    }
}

protocol RequestInterceptor {
    func intercept(_ request: inout URLRequest) throws
}

final class AuthHeaderInterceptor: RequestInterceptor {
    private let tokenStore: SessionTokenStore

    init(tokenStore: SessionTokenStore) {
        self.tokenStore = tokenStore
    }

    func intercept(_ request: inout URLRequest) throws {
        if let token = try tokenStore.load() {
            let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                request.setValue("Bearer \(trimmed)", forHTTPHeaderField: "authorization")
            }
        }
    }
}

/// Native iOS never starts web Stripe Checkout for Congress.Trade Premium
/// (App Store Guideline 3.1.1).  Website checkout stays on congress.trade.
/// Existing Stripe subscribers still manage via `billingPortalURL()`.
enum DigitalGoodsCheckout {
    static let allowsWebCheckout = false

    static func webCheckoutURL(relativeTo _: URL) -> URL? {
        nil
    }
}

/// Archived Filing PDF is a Premium digital good (APPSTORECOMPLIANCE-01/02).
/// Free and anonymous users open StoreKit.  Premium fetches with the Bearer
/// session.  Never Safari to congress.trade/pricing or Stripe.
enum FilingPDFAccess {
    enum Action: Equatable {
        case showPremiumSheet
        case fetchInApp
    }

    static func action(isPremium: Bool) -> Action {
        isPremium ? .fetchInApp : .showPremiumSheet
    }
}

final class CongressTradeAPIClient {
    private let baseURL: URL
    let tokenStore: SessionTokenStore
    /// Device-scoped (not account-scoped) proof of an anonymous Apple
    /// purchase (Guideline 5.1.1(v)) — a separate Keychain item from
    /// `tokenStore`. Attached as `X-Apple-Device-Entitlement` on the two
    /// requests that accept it (archived filing PDF, CSV export) whenever
    /// present; the server only consults it when there is no session.
    let deviceEntitlementStore: SessionTokenStore
    private let session: URLSession
    private let interceptor: RequestInterceptor
    private let decoder: JSONDecoder
    /// Backoff sleep behind the GET retry loop. Production suspends with
    /// `Task.sleep` (throws on cancel); tests inject a recorder/no-op.
    private let retrySleeper: (TimeInterval) async throws -> Void

    /// Dedicated production session with a sized URLCache so idempotent GETs
    /// can honor server `Cache-Control`/`ETag` (Batch 4 lands those headers
    /// server-side; without them responses simply are not stored and every
    /// request still goes to the network — no behavior change today).
    /// Tests keep injecting their own MockURLProtocol session.
    static func makeDefaultSession() -> URLSession {
        let configuration = URLSessionConfiguration.default
        configuration.requestCachePolicy = .useProtocolCachePolicy
        configuration.urlCache = URLCache(
            memoryCapacity: 10 * 1024 * 1024,
            diskCapacity: 50 * 1024 * 1024,
            diskPath: "trade.congress.api-cache"
        )
        return URLSession(configuration: configuration)
    }

    /// Cache policy per request. Only allowlisted idempotent public GETs may
    /// use the protocol cache; everything account-scoped (`/me` via
    /// bootstrap, preferences, subscriptions, commands), premium-gated
    /// (documents), admin, auth, and every mutation bypasses the cache.
    /// Fail-closed: an unrecognized path is never cached.
    static func cachePolicy(for url: URL, method: String = "GET") -> URLRequest.CachePolicy {
        guard method.uppercased() == "GET" else { return .reloadIgnoringLocalCacheData }
        let path = url.path
        let cacheable = path.hasSuffix("/feed")
            || path.contains("/member/")
            || path.contains("/ticker/")
            || path.contains("/trade/")
            || path == "/api/members"
            || path == "/api/assets"
            || path.hasPrefix("/api/analytics/")
            || path.hasPrefix("/api/logos/")
        return cacheable ? .useProtocolCachePolicy : .reloadIgnoringLocalCacheData
    }

    init(
        baseURL: URL = CongressTradeAPIClient.defaultBaseURL,
        tokenStore: SessionTokenStore = KeychainTokenStore(),
        deviceEntitlementStore: SessionTokenStore = KeychainTokenStore(service: "trade.congress.appleDeviceEntitlement"),
        session: URLSession = CongressTradeAPIClient.makeDefaultSession(),
        interceptor: RequestInterceptor? = nil,
        retrySleeper: @escaping (TimeInterval) async throws -> Void = { delay in
            try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
        }
    ) {
        self.baseURL = baseURL
        self.tokenStore = tokenStore
        self.deviceEntitlementStore = deviceEntitlementStore
        self.session = session
        self.interceptor = interceptor ?? AuthHeaderInterceptor(tokenStore: tokenStore)
        self.decoder = JSONDecoder()
        self.retrySleeper = retrySleeper
    }

    deinit {
        // Dedicated sessions (XCTest MockURLProtocol, never URLSession.shared)
        // must not keep protocol callbacks alive after this client is released.
        // Otherwise a previous test's in-flight trends/feed request can land
        // after that test's tearDown niled MockURLProtocol.handler and
        // XCTUnwrap-crash whichever case is running next.
        if session !== URLSession.shared {
            session.invalidateAndCancel()
        }
    }

    static var defaultBaseURL: URL {
        if let raw = ProcessInfo.processInfo.environment["CONGRESS_TRADE_API_BASE_URL"],
           let url = URL(string: raw) {
            return url
        }
        // Compile-time constant; a malformed override above falls through here.
        return URL(string: "https://congress.trade/api/client/v1")!
    }

    /// The App Store subscriptions page — the sole manage-subscription
    /// surface for Apple IAP subscribers (`entitlement.source == "apple"`).
    /// Stripe subscribers (and `nil`, the safe default for every payer that
    /// predates Apple IAP support — it was disabled until 2026-08-09) use
    /// `billingPortalURL()` instead; this page would show them nothing to
    /// manage.
    static let appStoreManageSubscriptionsURL = URL(string: "https://apps.apple.com/account/subscriptions")!

    /// Website path that can reach Stripe Customer Portal for an existing
    /// web/Stripe subscriber.  Guideline 3.1.1: manage existing web billing,
    /// never start web checkout.  The site honors `?billing=manage` after
    /// `/auth/me` and runs `manageBilling()`.
    var webManageSubscriptionURL: URL {
        var components = URLComponents(url: originURL, resolvingAgainstBaseURL: false) ?? URLComponents()
        components.path = "/"
        components.queryItems = [URLQueryItem(name: "billing", value: "manage")]
        return components.url ?? originURL
    }

    /// Site origin (scheme + host) with the `/api/client/v1` path stripped.
    /// Auth (`/auth/*`), document (`/api/documents/*`), and logo endpoints live
    /// at the origin, not under the client API prefix.
    var origin: URL {
        originURL
    }

    /// URL for the archived filing PDF served from R2.
    /// Mirrors `GET /api/documents/:docId/pdf` in `app/src/delivery/rest.ts`.
    /// Do not open this in Safari — fetch with `fetchDocumentPDF` and the
    /// Bearer session.  Government source URLs stay ungated on the trade row.
    func documentPDFURL(docId: String) -> URL? {
        guard !docId.isEmpty else { return nil }
        let encoded = docId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? docId
        return URL(string: "/api/documents/\(encoded)/pdf", relativeTo: originURL)?.absoluteURL
    }

    /// Bearer + `Accept: application/pdf`.  The server returns 402 JSON for
    /// free/anonymous clients instead of a 302 to `/pricing`.
    func documentPDFRequest(docId: String) throws -> URLRequest {
        guard let url = documentPDFURL(docId: docId) else { throw APIError.invalidResponse }
        var request = try makeRequest(url)
        request.setValue("application/pdf", forHTTPHeaderField: "accept")
        attachDeviceEntitlementHeaderIfNeeded(to: &request)
        return request
    }

    /// Attaches the cached device entitlement token (Guideline 5.1.1(v)), if
    /// any, so a signed-out device can reach the two routes that accept it.
    /// Harmless to attach even when a session Bearer is also present — the
    /// server always prefers the session and only falls back to this header
    /// when there is no signed-in user at all.
    private func attachDeviceEntitlementHeaderIfNeeded(to request: inout URLRequest) {
        guard let token = try? deviceEntitlementStore.load() else { return }
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        request.setValue(trimmed, forHTTPHeaderField: "X-Apple-Device-Entitlement")
    }

    func fetchDocumentPDF(docId: String) async throws -> (data: Data, contentType: String) {
        let request = try documentPDFRequest(docId: docId)
        let (data, response) = try await perform(request)
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        if let finalURL = http.url,
           finalURL.path.contains("pricing") || finalURL.path.contains("billing") {
            throw APIError.server(
                status: 402,
                message: "Archived filing PDF requires a Premium account",
                retryAfterSeconds: nil
            )
        }
        guard (200..<300).contains(http.statusCode) else {
            let error = try? decoder.decode(APIErrorResponse.self, from: data)
            throw APIError.server(
                status: http.statusCode,
                message: error?.error ?? "Request failed",
                retryAfterSeconds: http.value(forHTTPHeaderField: "Retry-After").flatMap { Int($0) }
            )
        }
        let contentType = http.value(forHTTPHeaderField: "Content-Type") ?? "application/pdf"
        return (data, contentType)
    }

    func writeDocumentPDFPreviewFile(docId: String, data: Data, contentType: String) throws -> URL {
        let ext = contentType.lowercased().contains("html") ? "html" : "pdf"
        let safe = docId
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "..", with: "_")
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("ct-filing-\(safe).\(ext)")
        try data.write(to: url, options: .atomic)
        return url
    }

    /// Web dashboard URL for sharing/deep-link parity (`?trade=` / `?member=`).
    /// Not a purchase path — do not point this at pricing or hosted checkout.
    func shareURL(queryItem: URLQueryItem) -> URL? {
        var components = URLComponents(url: originURL, resolvingAgainstBaseURL: false)
        components?.path = "/"
        components?.queryItems = [queryItem]
        return components?.url
    }

    func bootstrap() async throws -> BootstrapResponse {
        try await get("bootstrap")
    }

    func feed(query: FeedQuery = .init()) async throws -> ClientFeedResponse {
        guard var components = URLComponents(url: endpointURL("feed"), resolvingAgainstBaseURL: false) else {
            throw APIError.invalidResponse
        }
        components.queryItems = query.queryItems
        guard let url = components.url else { throw APIError.invalidResponse }
        return try await request(url)
    }

    func member(
        id: String,
        window: String? = nil,
        from: String? = nil,
        to: String? = nil,
        chamber: String? = nil,
        party: String? = nil,
        type: String? = nil
    ) async throws -> ClientMemberResponse {
        // Query items must stay on the URL, not in the path.  `get("member/x?sort=")`
        // went through `appendingPathComponent`, which encoded `?` and made the
        // server look up `C001047?sort=tx_date` → 404 "member not found".
        var components = URLComponents(
            url: endpointURL("member").appendingPathComponent(id),
            resolvingAgainstBaseURL: false
        )
        var items = [
            URLQueryItem(name: "sort", value: "tx_date"),
            URLQueryItem(name: "order", value: "desc"),
        ]
        if let window, !window.isEmpty { items.append(URLQueryItem(name: "window", value: window)) }
        if let from, !from.isEmpty { items.append(URLQueryItem(name: "from", value: from)) }
        if let to, !to.isEmpty { items.append(URLQueryItem(name: "to", value: to)) }
        if let chamber, !chamber.isEmpty { items.append(URLQueryItem(name: "chamber", value: chamber)) }
        if let party, !party.isEmpty { items.append(URLQueryItem(name: "party", value: party)) }
        if let type, !type.isEmpty { items.append(URLQueryItem(name: "type", value: type)) }
        components?.queryItems = items
        guard let url = components?.url else { throw APIError.invalidResponse }
        return try await request(url)
    }

    /// `GET /api/members` — the People directory roster. Origin-level, not
    /// under `/api/client/v1/*` (same pattern as `absoluteClientURL`'s other
    /// origin calls: `auth/*`, `documentPDFURL`, `logout`).
    func membersDirectory() async throws -> MemberDirectoryResponse {
        try await request(originURL.appendingPathComponent("api/members"))
    }

    /// `GET /api/assets` — the Assets directory roster (web parity: Directory
    /// tab's People|Assets segmented toggle, `app/src/ui/dashboardHtml.ts`
    /// `setDirectoryMode`/`loadAssetsDirectory`). Public, unauthenticated,
    /// no query params — the whole roster (every ticker that has ever
    /// appeared in a disclosed transaction), server-side 30-minute KV cache
    /// (`app/src/delivery/rest.ts` `queryAssetsRoster` / `r.get('/assets')`).
    /// Origin-level like `membersDirectory()`, not under `/api/client/v1/*`.
    func assetsDirectory() async throws -> AssetDirectoryResponse {
        try await request(originURL.appendingPathComponent("api/assets"))
    }

    func ticker(
        _ ticker: String,
        window: String? = nil,
        from: String? = nil,
        to: String? = nil,
        chamber: String? = nil,
        party: String? = nil,
        type: String? = nil,
        include: String? = nil
    ) async throws -> ClientTickerResponse {
        let encoded = ticker.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? ticker
        guard var components = URLComponents(
            url: endpointURL("ticker").appendingPathComponent(encoded),
            resolvingAgainstBaseURL: false
        ) else { throw APIError.invalidResponse }
        var items: [URLQueryItem] = []
        if let window, !window.isEmpty { items.append(URLQueryItem(name: "window", value: window)) }
        if let from, !from.isEmpty { items.append(URLQueryItem(name: "from", value: from)) }
        if let to, !to.isEmpty { items.append(URLQueryItem(name: "to", value: to)) }
        if let chamber, !chamber.isEmpty { items.append(URLQueryItem(name: "chamber", value: chamber)) }
        if let party, !party.isEmpty { items.append(URLQueryItem(name: "party", value: party)) }
        if let type, !type.isEmpty { items.append(URLQueryItem(name: "type", value: type)) }
        if let include, !include.isEmpty { items.append(URLQueryItem(name: "include", value: include)) }
        if !items.isEmpty { components.queryItems = items }
        guard let url = components.url else { throw APIError.invalidResponse }
        return try await request(url)
    }

    func subscriptions() async throws -> SubscriptionListResponse {
        try await get("subscriptions")
    }

    func preferences() async throws -> PreferencesResponse {
        try await get("preferences")
    }

    func latencySummary() async throws -> LatencySummary {
        try await analyticsGet("latency-summary")
    }

    private func makeQueryItems(
        window: String,
        party: String? = nil,
        chamber: String? = nil,
        type: String? = nil,
        extra: [URLQueryItem] = []
    ) -> [URLQueryItem] {
        var items = [URLQueryItem(name: "window", value: window)]
        if let party = party, !party.isEmpty { items.append(URLQueryItem(name: "party", value: party)) }
        if let chamber = chamber, !chamber.isEmpty { items.append(URLQueryItem(name: "chamber", value: chamber)) }
        if let type = type, !type.isEmpty { items.append(URLQueryItem(name: "type", value: type)) }
        items.append(contentsOf: extra)
        return items
    }

    func analyticsSummary(window: String, party: String? = nil, chamber: String? = nil, type: String? = nil) async throws -> AnalyticsSummary {
        try await analyticsGet("summary", query: makeQueryItems(window: window, party: party, chamber: chamber, type: type))
    }

    func tickerLeaderboard(window: String, party: String? = nil, chamber: String? = nil, type: String? = nil, sort: String = "volume") async throws -> TickerLeaderboardResponse {
        try await analyticsGet(
            "ticker-leaderboard",
            query: makeQueryItems(window: window, party: party, chamber: chamber, type: type, extra: [URLQueryItem(name: "sort", value: sort)])
        )
    }

    func volumeOverTime(window: String, party: String? = nil, chamber: String? = nil, type: String? = nil) async throws -> VolumeOverTimeResponse {
        try await analyticsGet("volume-over-time", query: makeQueryItems(window: window, party: party, chamber: chamber, type: type))
    }

    func sectorFlow(window: String, party: String? = nil, chamber: String? = nil, type: String? = nil) async throws -> SectorFlowResponse {
        try await analyticsGet("sector-flow", query: makeQueryItems(window: window, party: party, chamber: chamber, type: type))
    }

    func memberLeaderboard(window: String, party: String? = nil, chamber: String? = nil, type: String? = nil) async throws -> MemberLeaderboardResponse {
        try await analyticsGet("member-leaderboard", query: makeQueryItems(window: window, party: party, chamber: chamber, type: type))
    }

    func clusterBuys(window: String, party: String? = nil, chamber: String? = nil, type: String? = nil) async throws -> ClusterBuysResponse {
        try await analyticsGet("cluster-buys", query: makeQueryItems(window: window, party: party, chamber: chamber, type: type))
    }

    func trending(window: String, party: String? = nil, chamber: String? = nil, type: String? = nil) async throws -> TrendingResponse {
        try await analyticsGet("trending", query: makeQueryItems(window: window, party: party, chamber: chamber, type: type))
    }

    func topPerformers(window: String, party: String? = nil, chamber: String? = nil, type: String? = nil) async throws -> TopPerformersResponse {
        try await analyticsGet("member-performance", query: makeQueryItems(window: window, party: party, chamber: chamber, type: type))
    }

    func marketCapBreakdown(window: String, party: String? = nil, chamber: String? = nil, type: String? = nil) async throws -> MarketCapResponse {
        try await analyticsGet("market-cap-breakdown", query: makeQueryItems(window: window, party: party, chamber: chamber, type: type))
    }

    func partySplit(window: String, party: String? = nil, chamber: String? = nil, type: String? = nil) async throws -> PartySplitResponse {
        try await analyticsGet("party-split", query: makeQueryItems(window: window, party: party, chamber: chamber, type: type))
    }

    func filingLag(window: String, party: String? = nil, chamber: String? = nil, type: String? = nil) async throws -> FilingLagResponse {
        try await analyticsGet("filing-lag", query: makeQueryItems(window: window, party: party, chamber: chamber, type: type))
    }

    func conflicts(window: String, party: String? = nil, chamber: String? = nil, type: String? = nil) async throws -> ConflictCandidateResponse {
        try await analyticsGet("conflicts", query: makeQueryItems(window: window, party: party, chamber: chamber, type: type))
    }

    private func analyticsGet<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> T {
        guard var components = URLComponents(
            url: originURL.appendingPathComponent("api/analytics/\(path)"),
            resolvingAgainstBaseURL: false
        ) else { throw APIError.invalidResponse }
        if !query.isEmpty { components.queryItems = query }
        guard let url = components.url else { throw APIError.invalidResponse }
        return try await request(url)
    }

    func commands(limit: Int = 20) async throws -> CommandListResponse {
        guard var components = URLComponents(url: endpointURL("commands"), resolvingAgainstBaseURL: false) else {
            throw APIError.invalidResponse
        }
        components.queryItems = [URLQueryItem(name: "limit", value: String(limit))]
        guard let url = components.url else { throw APIError.invalidResponse }
        return try await request(url)
    }

    func command(id: String) async throws -> ClientCommandResponse<JSONValue> {
        try await get("commands/\(id)")
    }

    /// Confirms a previously cached trade is still live on the server.
    ///
    /// The feed and count queries silently exclude retracted ("deprecated")
    /// rows going forward — there is no tombstone/push signal for a row that
    /// was already synced to a device before an admin later un-published it
    /// (see `app/docs/client-mobile-api.md` "Chamber filter" section and
    /// `app/src/delivery/rows.ts`'s `t.deprecated_at IS NULL` filter). The one
    /// place the backend *does* signal this directly is `GET /trade/:id`,
    /// which 404s once a row is deprecated. Callers use that to reconcile an
    /// already-cached item on demand (e.g. when its detail view is opened).
    func tradeStillExists(id: String) async throws -> Bool {
        do {
            let _: Ack = try await get("trade/\(id)")
            return true
        } catch let error as APIError {
            if case .server(let status, _, _) = error, status == 404 {
                return false
            }
            throw error
        }
    }

    /// Fetches a single trade by ID (`GET /api/client/v1/trade/:id`).
    func trade(id: String) async throws -> ClientTrade {
        let envelope: SingleTradeEnvelope = try await get("trade/\(id)")
        if let item = envelope.item {
            return item
        }
        if let first = envelope.items?.first {
            return first
        }
        throw APIError.invalidResponse
    }

    private struct SingleTradeEnvelope: Decodable {
        let item: ClientTrade?
        let items: [ClientTrade]?
    }

    private struct Ack: Decodable {}

    func createSSESubscription(
        filters: SubscriptionFilters,
        idempotencyKey: String
    ) async throws -> ClientCommandResponse<SubscriptionCommandResult> {
        try await postCommand(
            idempotencyKey: idempotencyKey,
            body: [
                "type": "create_subscription",
                "payload": [
                    "delivery": "sse",
                    "filters": filters.commandPayload
                ]
            ]
        )
    }

    func createWebhookSubscription(
        targetURL: String,
        filters: SubscriptionFilters,
        idempotencyKey: String
    ) async throws -> ClientCommandResponse<SubscriptionCommandResult> {
        try await postCommand(
            idempotencyKey: idempotencyKey,
            body: [
                "type": "create_subscription",
                "payload": [
                    "delivery": "webhook",
                    "targetUrl": targetURL,
                    "filters": filters.commandPayload
                ]
            ]
        )
    }

    /// Register this device for backend-owned push alerts (`register_device`).
    /// Tokens are stored on the account; they do not consume SSE/webhook quota.
    /// Use a stable `idempotencyKey` (e.g. derived from the token) so refresh
    /// loops do not flood the async command queue.
    func registerDevice(
        apnsToken: String,
        appBundle: String = Bundle.main.bundleIdentifier ?? "trade.congress.ios",
        env: String = "production",
        idempotencyKey: String
    ) async throws -> ClientCommandResponse<DeviceRegistrationResult> {
        try await postCommand(
            idempotencyKey: idempotencyKey,
            body: [
                "type": "register_device",
                "payload": [
                    "platform": "apns",
                    "token": apnsToken,
                    "appBundle": appBundle,
                    "env": env
                ]
            ]
        )
    }

    /// Legacy name kept for call sites; prefers `register_device`.
    func createAPNsSubscription(
        apnsToken: String,
        filters: SubscriptionFilters = SubscriptionFilters(),
        idempotencyKey: String = UUID().uuidString
    ) async throws -> ClientCommandResponse<DeviceRegistrationResult> {
        try await registerDevice(apnsToken: apnsToken, idempotencyKey: idempotencyKey)
    }

    func updatePreferences(
        tickers: [String]? = nil,
        notificationSettings: [String: Any]? = nil,
        idempotencyKey: String
    ) async throws -> ClientCommandResponse<PreferencesCommandResult> {
        var payload: [String: Any] = [:]
        if let tickers {
            payload["watchlist"] = tickers
        }
        if let notificationSettings {
            payload["notificationSettings"] = notificationSettings
        }
        return try await postCommand(
            idempotencyKey: idempotencyKey,
            body: [
                "type": "update_preferences",
                "payload": payload
            ]
        )
    }

    func setSubscriptionActive(
        id: String,
        active: Bool,
        idempotencyKey: String
    ) async throws -> ClientCommandResponse<SubscriptionCommandResult> {
        return try await postCommand(
            idempotencyKey: idempotencyKey,
            body: [
                "type": "update_subscription",
                "payload": ["id": id, "active": active]
            ]
        )
    }

    /// Hard-delete a delivery subscription (`delete_subscription` command).
    func deleteSubscription(
        id: String,
        idempotencyKey: String
    ) async throws -> ClientCommandResponse<DeleteSubscriptionResult> {
        try await postCommand(
            idempotencyKey: idempotencyKey,
            body: [
                "type": "delete_subscription",
                "payload": ["id": id]
            ]
        )
    }

    /// Premium CSV export (`GET /api/export/transactions.csv`). Accepts the
    /// same filters as the live feed; requires a Premium bearer session.
    func exportTransactionsCSV(
        from: String? = nil,
        to: String? = nil,
        ticker: String? = nil,
        memberName: String? = nil,
        chamber: String? = nil,
        type: String? = nil,
        party: String? = nil,
        assetClass: String? = nil
    ) async throws -> Data {
        guard var components = URLComponents(
            url: originURL.appendingPathComponent("api/export/transactions.csv"),
            resolvingAgainstBaseURL: false
        ) else { throw APIError.invalidResponse }
        var items: [URLQueryItem] = []
        if let from, !from.isEmpty { items.append(URLQueryItem(name: "from", value: from)) }
        if let to, !to.isEmpty { items.append(URLQueryItem(name: "to", value: to)) }
        if let ticker, !ticker.isEmpty { items.append(URLQueryItem(name: "ticker", value: ticker)) }
        if let memberName, !memberName.isEmpty { items.append(URLQueryItem(name: "memberName", value: memberName)) }
        if let chamber, !chamber.isEmpty { items.append(URLQueryItem(name: "chamber", value: chamber)) }
        if let type, !type.isEmpty { items.append(URLQueryItem(name: "type", value: type)) }
        if let party, !party.isEmpty { items.append(URLQueryItem(name: "party", value: party)) }
        if let assetClass, !assetClass.isEmpty { items.append(URLQueryItem(name: "assetClass", value: assetClass)) }
        if !items.isEmpty { components.queryItems = items }
        guard let url = components.url else { throw APIError.invalidResponse }
        var request = try makeRequest(url)
        attachDeviceEntitlementHeaderIfNeeded(to: &request)
        // Export can be large; give it a longer budget than interactive GETs.
        request.timeoutInterval = 60
        let (data, response) = try await perform(request)
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let error = try? decoder.decode(APIErrorResponse.self, from: data)
            let retryAfter = (http.value(forHTTPHeaderField: "Retry-After")).flatMap { Int($0) }
            throw APIError.server(
                status: http.statusCode,
                message: error?.error ?? "Export failed",
                retryAfterSeconds: retryAfter
            )
        }
        return data
    }

    /// Per-trade performance with an explicit timeout so slow tickers (e.g.
    /// thin history) cannot hang the detail sheet indefinitely.
    func tradePerformance(txId: String, timeout: TimeInterval = 12) async throws -> TradePerformanceResponse {
        let encoded = txId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? txId
        guard let components = URLComponents(
            url: originURL.appendingPathComponent("api/analytics/performance/\(encoded)"),
            resolvingAgainstBaseURL: false
        ), let url = components.url else {
            throw APIError.invalidResponse
        }
        var request = try makeRequest(url)
        request.timeoutInterval = timeout
        return try await send(request)
    }

    // MARK: - Admin (origin-level `/api/admin/*`, `/api/health*`)

    /// `GET /auth/me` — native admin gate is `admin.allowed`, not a pasted token.
    func authMe() async throws -> AuthMeResponse {
        try await request(originURL.appendingPathComponent("auth/me"))
    }

    /// `true` when the current session Bearer is on `ADMIN_EMAILS`.
    func probeAdminAccess() async throws -> Bool {
        try await authMe().adminAllowed
    }

    func publicHealth() async throws -> PublicHealthResponse {
        try await request(originURL.appendingPathComponent("api/health"))
    }

    func pollingHealth() async throws -> PollingHealthResponse {
        try await request(originURL.appendingPathComponent("api/health/polling"))
    }

    func autopilotStatus() async throws -> AutopilotStatusResponse {
        try await sendAdmin(makeAdminRequest(adminURL(["autopilot", "status"])))
    }

    func acknowledgeAutopilotHalt(runId: String? = nil) async throws -> AutopilotAcknowledgeResponse {
        var body: [String: Any] = [:]
        if let runId, !runId.isEmpty { body["runId"] = runId }
        return try await sendAdmin(makeAdminRequest(adminURL(["autopilot", "acknowledge"]), method: "POST", body: body))
    }

    func reviewQueue(resolved: Bool = false, limit: Int = 50, cursor: String? = nil) async throws -> ReviewQueueResponse {
        guard var components = URLComponents(url: adminURL(["review-queue"]), resolvingAgainstBaseURL: false) else {
            throw APIError.invalidResponse
        }
        var items = [
            URLQueryItem(name: "resolved", value: resolved ? "1" : "0"),
            URLQueryItem(name: "limit", value: String(min(max(limit, 1), 200))),
        ]
        if let cursor, !cursor.isEmpty {
            items.append(URLQueryItem(name: "cursor", value: cursor))
        }
        components.queryItems = items
        guard let url = components.url else { throw APIError.invalidResponse }
        return try await sendAdmin(makeAdminRequest(url))
    }

    func reviewExtractions(docId: String) async throws -> ReviewExtractionsResponse {
        try await sendAdmin(makeAdminRequest(adminURL(["review", docId, "extractions"])))
    }

    func reviewDecision(docId: String, decision: String, reviewRevision: Int, edits: [[String: Any]]? = nil) async throws -> ReviewMutationResponse {
        var body: [String: Any] = [
            "decision": decision,
            "reviewRevision": reviewRevision,
        ]
        if let edits { body["edits"] = edits }
        return try await sendAdmin(makeAdminRequest(adminURL(["review", docId]), method: "POST", body: body))
    }

    func unpublishReview(docId: String, reviewRevision: Int, reason: String) async throws -> ReviewUnpublishResponse {
        try await sendAdmin(
            makeAdminRequest(
                adminURL(["review", docId, "unpublish"]),
                method: "POST",
                body: ["reviewRevision": reviewRevision, "reason": reason]
            )
        )
    }

    func retryReviewAuto(docId: String, reviewRevision: Int) async throws -> ReviewRetryAutoResponse {
        try await sendAdmin(
            makeAdminRequest(
                adminURL(["review", docId, "retry-auto"]),
                method: "POST",
                body: ["reviewRevision": reviewRevision]
            )
        )
    }

    /// Permanently delete the signed-in account (`delete_account` command).
    /// The backend revokes sessions, push devices, delivery subscriptions, and
    /// PII.  Callers must clear the local token after success — a follow-up
    /// logout is unnecessary because the session is already dead.
    func deleteAccount(
        idempotencyKey: String = UUID().uuidString
    ) async throws -> ClientCommandResponse<DeleteAccountResult> {
        try await postCommand(
            idempotencyKey: idempotencyKey,
            body: [
                "type": "delete_account",
                "payload": [:] as [String: Any]
            ]
        )
    }

    func logout() async throws {
        var request = try makeRequest(originURL.appendingPathComponent("auth/logout"))
        request.httpMethod = "POST"
        let (_, response) = try await perform(request)
        guard let http = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            throw APIError.server(status: http.statusCode, message: "Could not revoke this session", retryAfterSeconds: nil)
        }
    }

    /// Native Sign in with Apple (`POST /auth/apple`). The client verifies
    /// nothing itself — it forwards `ASAuthorizationAppleIDCredential
    /// .identityToken` (UTF-8 decoded) as-is; the backend does full
    /// RS256-against-Apple's-JWKS verification before trusting any claim.
    /// `fullName` is only ever non-nil on the device's very first
    /// authorization for this app (Apple never encodes it in the token
    /// itself on later sign-ins). See `app/docs/client-mobile-api.md`.
    func signInWithApple(
        identityToken: String,
        nonce: String? = nil,
        fullName: String? = nil
    ) async throws -> AppleSignInResponse {
        var request = try makeRequest(originURL.appendingPathComponent("auth/apple"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        var body: [String: Any] = ["identityToken": identityToken]
        if let nonce, !nonce.isEmpty { body["nonce"] = nonce }
        if let fullName, !fullName.isEmpty { body["fullName"] = fullName }
        request.httpBody = try JSONSerialization.data(withJSONObject: body, options: [])
        return try await send(request)
    }

    /// Redeem a StoreKit 2 purchase (`redeem_apple_purchase` client command —
    /// `app/docs/client-mobile-api.md` "Apple In-App Purchase (StoreKit 2)").
    /// Not Premium-gated (this is how a signed-in user becomes Premium).
    /// Idempotent server-side on Apple's `originalTransactionId`, so both a
    /// fresh purchase and Restore Purchases call this the same way — pass a
    /// fresh `idempotencyKey` per call (command-layer idempotency is keyed on
    /// `userId + idempotencyKey`, distinct from the server's own
    /// transaction-id idempotency).
    func redeemApplePurchase(
        signedTransaction: String,
        idempotencyKey: String = UUID().uuidString
    ) async throws -> ClientCommandResponse<RedeemAppleResult> {
        try await postCommand(
            idempotencyKey: idempotencyKey,
            body: [
                "type": "redeem_apple_purchase",
                "payload": ["signedTransaction": signedTransaction]
            ]
        )
    }

    /// Claims this device's own Apple subscription (`user_id: NULL` ledger
    /// row) for the signed-in account, from an EXPLICIT Link tap
    /// (`link_apple_entitlement` command —
    /// `app/docs/client-mobile-api.md` "Anonymous Apple purchase"). Never
    /// called automatically — see `Store/AppleIAP.swift`
    /// `linkAppleEntitlementToCurrentAccount`. Server-identical to
    /// `redeemApplePurchase`; the distinct command name only lets the caller
    /// know which UI copy to use. A 409 means "already linked to a
    /// different account" and is surfaced to the person, never swallowed.
    func linkAppleEntitlement(
        signedTransaction: String,
        idempotencyKey: String = UUID().uuidString
    ) async throws -> ClientCommandResponse<RedeemAppleResult> {
        try await postCommand(
            idempotencyKey: idempotencyKey,
            body: [
                "type": "link_apple_entitlement",
                "payload": ["signedTransaction": signedTransaction]
            ]
        )
    }

    /// Anonymous counterpart of `redeemApplePurchase` (Guideline 5.1.1(v)) —
    /// `POST /api/client/v1/entitlements/apple/redeem`, no session sent or
    /// required. Records the purchase against a device, not an account, and
    /// returns a short-lived device entitlement token the caller is
    /// responsible for caching (`api.deviceEntitlementStore`) — this method
    /// has no side effects of its own beyond the network call.
    func redeemAppleEntitlementAnonymously(signedTransaction: String) async throws -> AnonymousAppleRedeemResult {
        var request = try makeRequest(endpointURL("entitlements/apple/redeem"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(
            withJSONObject: ["signedTransaction": signedTransaction],
            options: []
        )
        return try await send(request)
    }

    /// Mints a short-lived Stripe-hosted Billing Portal URL for the
    /// signed-in user's Stripe customer (`POST /billing/portal`,
    /// `app/src/billing/routes.ts` — web parity; origin-level, not under
    /// `/api/client/v1/*`). Sends the same session Bearer as `/api/client/v1`
    /// (`makeRequest` → `AuthHeaderInterceptor`). The server must accept
    /// Bearer here (`getCurrentUserFromRequest`); cookie-only auth 401s a
    /// signed-in iOS user. Callers must not fall back to the App Store URL
    /// on failure — a Stripe subscriber has nothing to manage there.
    func billingPortalURL(idempotencyKey: String = UUID().uuidString) async throws -> URL {
        var request = try makeRequest(originURL.appendingPathComponent("billing/portal"))
        request.httpMethod = "POST"
        request.setValue(idempotencyKey, forHTTPHeaderField: "idempotency-key")
        let response: BillingPortalResponse = try await send(request)
        guard let url = URL(string: response.url) else {
            throw APIError.invalidResponse
        }
        return url
    }

    func absoluteClientURL(_ value: String?) -> String? {
        guard let value, !value.isEmpty else { return nil }
        if let url = URL(string: value), url.scheme != nil {
            return url.absoluteString
        }
        return URL(string: value, relativeTo: originURL)?.absoluteURL.absoluteString
    }

    private var originURL: URL {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        components?.path = ""
        components?.query = nil
        components?.fragment = nil
        // baseURL is validated at init (default or env-provided absolute URL),
        // so stripping the path always yields a valid origin; fall back to the
        // base itself rather than trapping if a future caller violates that.
        return components?.url ?? baseURL
    }

    private func endpointURL(_ path: String) -> URL {
        baseURL.appendingPathComponent(path)
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        try await request(endpointURL(path))
    }

    private func postCommand<T: Decodable>(idempotencyKey: String, body: [String: Any]) async throws -> ClientCommandResponse<T> {
        var request = try makeRequest(endpointURL("commands"))
        request.httpMethod = "POST"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue(idempotencyKey, forHTTPHeaderField: "idempotency-key")
        request.httpBody = try JSONSerialization.data(withJSONObject: body, options: [])
        var response: ClientCommandResponse<T> = try await send(request)
        if response.command.status == .failed {
            throw APIError.server(status: 400, message: response.command.error ?? "Command failed", retryAfterSeconds: nil)
        }
        // POST /commands is async (202 + queued). Poll GET /commands/:id until
        // terminal — that first succeeded read also claims one-time secrets.
        if response.command.status == .queued || response.command.status == .running {
            response = try await awaitCommandResult(id: response.command.id)
        }
        if response.command.status == .failed {
            throw APIError.server(status: 400, message: response.command.error ?? "Command failed", retryAfterSeconds: nil)
        }
        if response.command.status == .canceled {
            throw APIError.server(status: 400, message: "Command was canceled", retryAfterSeconds: nil)
        }
        return response
    }

    /// Poll `GET /commands/:id` until the command leaves queued/running.
    /// The first authenticated succeeded read claims and returns `result_secret`.
    ///
    /// The server finishes most commands inline and answers POST /commands with
    /// a terminal status, so this loop is the fallback for the ones it hands
    /// back to the durable queue. That queue is drained by the background tick
    /// — a minute apart at best — so the budget here is ~77s, not the old ~18s.
    /// The old budget expired while a redeemed App Store purchase was still
    /// queued and reported it as an error to someone Apple had already charged.
    private func awaitCommandResult<T: Decodable>(id: String) async throws -> ClientCommandResponse<T> {
        let maxAttempts = 60
        for attempt in 0..<maxAttempts {
            if attempt > 0 {
                let delayNs: UInt64
                switch attempt {
                case ..<5: delayNs = 250_000_000
                case ..<13: delayNs = 500_000_000
                default: delayNs = 1_500_000_000
                }
                try await Task.sleep(nanoseconds: delayNs)
            }
            let polled: ClientCommandResponse<T> = try await get(
                "commands/\(id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id)"
            )
            switch polled.command.status {
            case .succeeded, .failed, .canceled:
                return polled
            case .queued, .running:
                continue
            }
        }
        throw APIError.server(
            status: 504,
            message: "Command is still running. Wait a moment, then retry if needed.",
            retryAfterSeconds: 2
        )
    }

    private func request<T: Decodable>(_ url: URL) async throws -> T {
        try await send(try makeRequest(url))
    }

    private func makeRequest(_ url: URL) throws -> URLRequest {
        var request = URLRequest(url: url)
        request.cachePolicy = Self.cachePolicy(for: url)
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "accept")
        // congress.trade sits behind a Cloudflare managed challenge that 502s
        // some non-browser UAs.  A Safari iOS UA reaches the app.
        request.setValue(
            "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
            forHTTPHeaderField: "User-Agent"
        )
        try interceptor.intercept(&request)
        return request
    }

    /// Same session Bearer as `/api/client/v1`.  Native iOS does not store or
    /// send `ADMIN_TOKEN`.
    private func makeAdminRequest(_ url: URL, method: String = "GET", body: [String: Any]? = nil) throws -> URLRequest {
        var request = try makeRequest(url)
        request.httpMethod = method
        request.cachePolicy = .reloadIgnoringLocalCacheData
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body, options: [])
        }
        return request
    }

    private func adminURL(_ parts: [String]) -> URL {
        parts.reduce(originURL.appendingPathComponent("api/admin")) { url, part in
            url.appendingPathComponent(part)
        }
    }

    private func sendAdmin<T: Decodable>(_ request: URLRequest) async throws -> T {
        let (data, http) = try await performAdmin(request)
        guard (200..<300).contains(http.statusCode) else {
            let error = try? decoder.decode(APIErrorResponse.self, from: data)
            let retryAfter = http.value(forHTTPHeaderField: "Retry-After").flatMap { Int($0) }
            throw APIError.server(
                status: http.statusCode,
                message: error?.error ?? "Request failed",
                retryAfterSeconds: retryAfter
            )
        }
        return try decoder.decode(T.self, from: data)
    }

    private func performAdmin(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await perform(request)
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        return (data, http)
    }

    private func send<T: Decodable>(_ request: URLRequest) async throws -> T {
        // Deploy-window retry (CONGRESS-TRADE-25): idempotent GETs ride
        // through a short origin swap instead of surfacing an error the
        // user must pull-to-refresh away. Mutations never retry here, and
        // admin calls use sendAdmin, which has no loop at all.
        var request = request
        // Marks GETs that this loop will retry, so Sentry beforeSend can drop
        // the per-attempt HTTPClientError without silencing widget or image
        // loads that use a different session and do not retry.
        if (request.httpMethod ?? "GET").uppercased() == "GET" {
            request.setValue(
                TransientRetryPolicy.retryHeaderValue,
                forHTTPHeaderField: TransientRetryPolicy.retryHeaderName
            )
        }
        var retries = 0
        while true {
            do {
                return try await sendOnce(request)
            } catch let error as APIError {
                let retryable = TransientRetryPolicy.shouldRetry(error: error, method: request.httpMethod)
                guard retryable, retries < TransientRetryPolicy.maxRetries else {
                    if retries > 0, retryable, case .server(let status, _, _) = error,
                        TransientRetryPolicy.retryableStatuses.contains(status) {
                        SentryTelemetry.captureExhaustedRetry(
                            method: request.httpMethod ?? "GET",
                            path: request.url?.path,
                            status: status,
                            attempts: retries + 1
                        )
                    }
                    throw error
                }
                retries += 1
                // CancellationError becomes APIError so callers that only
                // check isCancellation do not paint a banner for a dismissed
                // view. Task.sleep throws that error when the task is cancelled.
                do {
                    try Task.checkCancellation()
                    try await retrySleeper(TransientRetryPolicy.delay(for: error, retryIndex: retries - 1))
                } catch is CancellationError {
                    throw APIError.transport(URLError(.cancelled))
                }
            }
        }
    }

    /// Single attempt behind `send`'s retry loop.
    private func sendOnce<T: Decodable>(_ request: URLRequest) async throws -> T {
        let (data, response) = try await perform(request)
        guard let http = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            let error = try? decoder.decode(APIErrorResponse.self, from: data)
            let retryAfter = (http.value(forHTTPHeaderField: "Retry-After")).flatMap { Int($0) }
            throw APIError.server(status: http.statusCode, message: error?.error ?? "Request failed", retryAfterSeconds: retryAfter)
        }
        return try decoder.decode(T.self, from: data)
    }

    private func perform(_ request: URLRequest) async throws -> (Data, URLResponse) {
        // Belt-and-braces: a mutation must never be served from (or stored
        // in) the URL cache, whatever policy makeRequest picked while the
        // request still looked like a GET.
        var request = request
        if (request.httpMethod ?? "GET").uppercased() != "GET" {
            request.cachePolicy = .reloadIgnoringLocalCacheData
        }
        do {
            return try await session.data(for: request)
        } catch let error as URLError {
            throw APIError.transport(error)
        }
    }
}

/// `GET /api/assets` response shape (`app/src/delivery/rest.ts`
/// `queryAssetsRoster`). No existing iOS Decodable matches this — asset rows
/// here are ticker-keyed roster entries, not `ClientTrade.asset`'s per-trade
/// snapshot in `Models.swift`.
struct AssetDirectoryResponse: Decodable {
    let assets: [AssetDirectoryEntry]
    let count: Int
}

struct AssetDirectoryEntry: Decodable, Identifiable, Hashable {
    let ticker: String
    /// LEFT-joined enrichment (`securities_ref`); `nil` for un-enriched tickers.
    let name: String?
    let assetClass: String?
    let txCount: Int?
    let memberCount: Int?

    var id: String { ticker }
}

struct APIErrorResponse: Decodable {
    let error: String
}

/// Retry policy for idempotent GETs through short deploy-window
/// outages (CONGRESS-TRADE-25): while the origin swap has no server, edge
/// and LB failures surface as 502/503/504 — Cloudflare's own page carries
/// `Retry-After: 60`, far too long for an interactive app. Pure (no
/// networking, no sleeping) so tests pin the decisions directly.
struct TransientRetryPolicy: Sendable {
    /// Extra attempts after the first try: 3 requests worst case.
    static let maxRetries = 2
    /// Server `Retry-After` is honored only up to this.
    static let maxRetryAfterDelay: TimeInterval = 5
    /// Deploy-window statuses worth another GET. Other failures fail fast
    /// at this layer. Callers must not run a second loop over errors
    /// `shouldRetry` still accepts: this policy already exhausted them.
    static let retryableStatuses: Set<Int> = [502, 503, 504]
    /// Request header set on GETs that pass through `send`'s retry loop.
    /// Sentry's automatic failed-request event keeps the header (it is not
    /// in the SDK's security-header denylist), so beforeSend can tell a
    /// retried API GET from a widget or image GET.
    static let retryHeaderName = "X-Congress-Retry"
    static let retryHeaderValue = "deploy-window"

    /// GET-only gate. POST/PUT/DELETE must never implicitly repeat —
    /// callers own their idempotency keys.
    static func shouldRetry(error: APIError, method: String?) -> Bool {
        guard (method ?? "GET").uppercased() == "GET" else { return false }
        guard error.isRetryable else { return false }
        switch error {
        case .server(let status, _, _):
            return retryableStatuses.contains(status)
        case .transport(let urlError):
            return [.timedOut, .networkConnectionLost, .cannotConnectToHost].contains(urlError.code)
        case .invalidResponse:
            return false
        }
    }

    /// Backoff before retry number `retryIndex` (0-based): the server's
    /// `Retry-After` capped at 5s when present, else 1s then 2s.
    static func delay(for error: APIError, retryIndex: Int) -> TimeInterval {
        if let retryAfter = error.retryAfterSeconds, retryAfter >= 0 {
            return min(TimeInterval(retryAfter), maxRetryAfterDelay)
        }
        return retryIndex <= 0 ? 1 : 2
    }
}

enum APIError: LocalizedError {
    case invalidResponse
    case server(status: Int, message: String, retryAfterSeconds: Int?)
    case transport(URLError)

    var isOffline: Bool {
        guard case .transport(let error) = self else { return false }
        return [
            .notConnectedToInternet,
            .networkConnectionLost,
            .cannotFindHost,
            .cannotConnectToHost,
            .dnsLookupFailed
        ].contains(error.code)
    }

    /// True when the underlying URLSession task was cancelled (view dismiss,
    /// Task cancel, or refresh superseded). Callers must not surface these as
    /// feed/trends error banners.
    var isCancellation: Bool {
        if case .transport(let error) = self {
            return error.code == .cancelled
        }
        return false
    }

    /// Whether a retry is worth attempting: rate limiting (429), transient
    /// server failure (5xx), or a transport-level hiccup. Anything else
    /// (400/401/404/etc.) is a permanent rejection that retrying cannot fix.
    /// Cancellation is never retryable.
    var isRetryable: Bool {
        if isCancellation { return false }
        switch self {
        case .server(let status, _, _):
            return status == 429 || (500...599).contains(status)
        case .transport:
            return true
        case .invalidResponse:
            return false
        }
    }

    /// Server-provided `Retry-After` (seconds), when present on a 429/5xx.
    var retryAfterSeconds: Int? {
        guard case .server(_, _, let retryAfterSeconds) = self else { return nil }
        return retryAfterSeconds
    }

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "Invalid server response."
        case .server(_, let message, _):
            return message
        case .transport(let error):
            return error.localizedDescription
        }
    }

    /// Human Trends / inbound-link copy.  Never the raw transport phrase
    /// (`Request failed`, `The Internet connection appears to be offline.`).
    var userFacingMessage: String {
        switch self {
        case .server(let status, let message, _):
            if status == 429 {
                return "Too many requests.  Pull to refresh."
            }
            // The status code is carried in the copy so a support report says
            // which failure it was.  Without it every backend fault reads the
            // same and "it says the site is updating" is unactionable.
            if (500...599).contains(status) {
                return "The site is updating (\(status)).  Pull to refresh."
            }
            if message.isEmpty || message == "Request failed" {
                return "Could not load this page (\(status)).  Pull to refresh."
            }
            return message
        case .transport:
            if isOffline {
                return "You are offline."
            }
            return "Could not reach the server.  Pull to refresh."
        case .invalidResponse:
            return "Invalid server response."
        }
    }
}
