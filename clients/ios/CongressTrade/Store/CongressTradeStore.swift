import Foundation
import SwiftData

@MainActor
final class CongressTradeStore: ObservableObject {
    @Published private(set) var bootstrap: BootstrapResponse?
    @Published private(set) var feed: ClientFeedResponse?
    /// Authoritative trade count for the active filters (from the feed API's COUNT(*)).
    /// Never use cursor_seq as a "trades" KPI — sequences can exceed live rows.
    ///
    /// It counts the filters the SERVER saw, which is not always the same set
    /// the user is looking at — never render it raw. `honestTradeTotal(...)`
    /// is the accessor that knows when it is and isn't an answer, and
    /// `hasClientOnlyFiltering` is the published half of that test.
    @Published private(set) var tradeTotal: Int = 0
    /// True when the visible list is narrowed by something the server's
    /// `COUNT(*)` never saw, which makes `tradeTotal` an OVER-count of what is
    /// actually showing. Today that is: any party selection (no `party` field
    /// on `FeedQuery` — see `selectedParties`), a 2+ side selection (`type=`
    /// omitted — see `selectedTradeTypes`), or an all-three-chambers selection
    /// (`chamberQueryValue` omits `chamber=` so the server counts rows whose
    /// chamber is unresolved, while `FeedDashboardView.filteredTrades` drops
    /// exactly those rows once any chamber filter is active).
    ///
    /// Deliberately NOT a "would the count be wrong" catch-all: local search
    /// text is the fourth narrowing and it lives in the view (see
    /// `honestTradeTotal(localSearchText:)` for why it stays there).
    @Published private(set) var hasClientOnlyFiltering = false
    @Published private(set) var latencySummary: LatencySummary?
    @Published private(set) var analyticsSummary: AnalyticsSummary?
    @Published private(set) var tickerLeaderboard: [TickerLeaderboardItem] = []
    @Published private(set) var volumeSeries: [VolumeOverTimePoint] = []
    @Published private(set) var sectorFlow: [SectorFlowItem] = []
    @Published private(set) var memberLeaderboard: [MemberLeaderboardItem] = []
    @Published private(set) var clusterBuys: [ClusterBuyItem] = []
    @Published private(set) var trendingAssets: [TrendingItem] = []
    @Published private(set) var topPerformers: [TopPerformerItem] = []
    @Published private(set) var marketCapBuckets: [MarketCapItem] = []
    @Published private(set) var partySplit: PartySplitResponse?
    @Published private(set) var filingLag: FilingLagResponse?
    /// Multi-select party filter (owner directive 2026-08-09: Chamber/Party/
    /// Trade Type pills must support one-or-many, matching the web's CSV
    /// multi-select semantics). Empty = all parties (default), matching the
    /// Chamber convention. Wired two different ways because the two server
    /// endpoints differ:
    ///  - Trades feed (`/api/client/v1/feed`): the list is filtered by party
    ///    entirely client-side (`FeedDashboardView.filteredTrades`), for any
    ///    number selected. NOTE — the old comment here claimed
    ///    `filtersFromQuery` has "no `party` param at all"; that is STALE as
    ///    of commit d5d85f0c (2026-08-09): the server does accept `party=D,R`
    ///    (`asPartyBuckets`, `app/src/client/utils.ts:182` →
    ///    `PARTY_BUCKET_SQL_LOCAL`, `app/src/delivery/rows.ts:579`). We still
    ///    filter locally only because `FeedQuery` (`APIClient.swift`) has no
    ///    `party` field to put it in. That matters for more than tidiness: a
    ///    party selection is therefore a narrowing the server's `COUNT(*)`
    ///    never saw, which is exactly what makes `tradeTotal` an over-count —
    ///    see `hasClientOnlyFiltering`. Adding `party` to `FeedQuery` is the
    ///    change that retires that caveat.
    ///  - Trends analytics (`/api/analytics/*`): `asPartyBucket` in
    ///    `app/src/analytics/sql.ts` accepts one bucket. `refreshTrends()`
    ///    below sends `party=` only when exactly one party is selected,
    ///    mirroring the same single-value fallback the web itself uses for
    ///    its `qSideGroup`/`selectedSideParam` side chips — selecting 2+
    ///    parties shows unfiltered (all-party) analytics, honestly, rather
    ///    than silently picking one.
    @Published private(set) var selectedParties: Set<PartyFilter> = []
    @Published private(set) var isLoadingTrends = false
    @Published private(set) var trendsNotice: String?
    @Published private(set) var subscriptions: [Subscription] = []
    @Published private(set) var commands: [ClientCommand] = []
    @Published private(set) var watchlist: [String] = []
    /// A feed fetch chain is running. Stays true continuously across coalesced
    /// re-runs (see `runRefreshChain`), so it never flickers false in the
    /// middle of a burst of filter taps.
    @Published private(set) var isRefreshing = false
    /// True from the instant the user asks for a filter change until the data
    /// for that change is on screen — the whole 3-5s window the owner reported
    /// as "nothing happens". Deliberately NOT an alias for `isRefreshing`:
    ///  - it starts during the VIEW's debounce window, before any request
    ///    exists at all (the view says so with `noteFilterIntent()`), and
    ///  - it spans a coalesced re-run, where the old code let a caller's
    ///    `await refresh()` return while the work it asked for was still queued.
    /// Bind a "Updating…" strip to this; bind the cold-start overlay to
    /// `isRefreshing && cache.isEmpty` as before.
    @Published private(set) var isFilterPending = false
    /// Per-surface split of `isFilterPending`. The two tabs need their own
    /// indicator because the two requests finish at very different times: the
    /// feed is 1-2 requests, `refreshTrends()` is 12, and only the analytics
    /// ones are KV-cached server-side — a single shared flag would either
    /// blink off early on Trends or linger on Trades.
    @Published private(set) var isFeedFilterPending = false
    @Published private(set) var isTrendsFilterPending = false
    @Published private(set) var isSavingWatchlist = false
    @Published private(set) var isCreatingDelivery = false
    @Published private(set) var subscriptionIDsInFlight: Set<String> = []
    @Published private(set) var isLoggingOut = false
    @Published private(set) var feedNotice: String?
    @Published private(set) var watchlistNotice: String?
    @Published private(set) var deliveryNotice: String?
    @Published private(set) var commandNotice: String?
    @Published private(set) var lastCommand: ClientCommand?
    @Published var pendingDeliveryCredential: DeliveryCredential?
    @Published private(set) var lastSuccessfulRefresh: Date?
    @Published private(set) var isOffline = false
    @Published private(set) var hasStoredSessionToken = false
    /// Page size for the visible feed snapshot (newest first). Not a multi-page crawl.
    @Published var viewLimit: Int = 100 {
        didSet {
            if oldValue != viewLimit {
                // A different page size shifts every page boundary — stay on
                // a page that's guaranteed to exist under the new size.
                currentPage = 0
                Task { await refreshFeedTrackingFilter() }
            }
        }
    }
    /// 0-indexed page of the current filtered/sorted snapshot (owner punch
    /// list #2, item 8). `refresh()` sends it as `offset = currentPage *
    /// pageLimit`; every filter/sort/page-size change below resets it to 0
    /// so the user is never stranded on a now-out-of-range page.
    @Published private(set) var currentPage: Int = 0
    /// Trades sort control (owner punch list #2, item 7).
    @Published private(set) var feedSortKey: FeedSortKey = .date
    @Published private(set) var feedSortDirection: SortDirection = .descending
    /// People directory roster (owner punch list #2, item 9).
    @Published private(set) var members: [MemberDirectoryEntry] = []
    @Published private(set) var isLoadingMembers = false
    @Published private(set) var membersNotice: String?
    /// Canonical chamber chip selection. Drives both the visible chips and
    /// the `chamber=` feed request — see `chamberQueryValue`. CT-AUD-010.
    /// Empty set = no chamber filter (all branches). Mirrors the website HSP chips
    /// where nothing selected means all. Non-empty = filter to that subset.
    /// Empty = all branches (website HSP: no chips selected). Non-empty filters to that subset.
    @Published private(set) var selectedChambers: Set<ChamberFilter> = []
    /// Time window for the feed + trends (website default = Past 3 Months).
    @Published private(set) var selectedTimeRange: TimeRange = .ninetyDays
    /// Multi-select Buy/Sell/Exchange side filter. Empty = all sides.
    /// `tradeTypeQueryValue` only forwards `type=` when exactly one side is
    /// selected; any selection count is still filtered correctly client-side
    /// in `FeedDashboardView.filteredTrades`.
    ///
    /// STALE-COMMENT CORRECTION (2026-08-10): the reason recorded here used to
    /// be "server `type=` is single-valued". That stopped being true in commit
    /// d5d85f0c — `asTxTypes` (`app/src/client/utils.ts:81`) parses a CSV
    /// `type=B,S` and `buildTxFilters` expands it into `tx_type IN (...)`
    /// (`app/src/delivery/rows.ts:542`). Forwarding the full selection is a
    /// one-line change in `tradeTypeQueryValue` below and would make
    /// `tradeTotal` truthful for 2+ sides — but
    /// `CongressTradeTests.testSetTradeTypeSelectionOmitsTypeParamWhenMultipleSidesSelected`
    /// asserts today's omission, so the store change and that test have to
    /// land together (that test file is owned by another lane this pass).
    /// Until they do, a 2+ side selection is a client-only narrowing and is
    /// reported as such by `hasClientOnlyFiltering`.
    @Published private(set) var selectedTradeTypes: Set<TradeTypeFilter> = []
    /// Trades-only free-text politician filter (`memberName=`).
    @Published private(set) var politicianFilter: String = ""
    /// Trades-only asset/ticker filter (`ticker=`).
    @Published private(set) var assetFilter: String = ""

    /// DEAD STATE — nothing reads or writes this (verified repo-wide,
    /// 2026-08-10). Left in place only because deleting a `@Published` while
    /// three other lanes are editing views against this store is a needless
    /// merge hazard; do NOT bind a new indicator to it. Use `isFilterPending`
    /// / `isFeedFilterPending` / `isTrendsFilterPending` instead.
    @Published var isLoadingMore = false

    var modelContext: ModelContext?

    internal let api: CongressTradeAPIClient
    private let tokenStore = KeychainTokenStore()
    private let cursorStore: SyncCursorStore
    private let sleeper: (Double) async -> Void
    private var pendingWatchlistMutation: PendingWatchlistMutation?
    private var pendingDeliveryMutation: PendingDeliveryMutation?
    private var pendingSubscriptionMutations: [String: PendingSubscriptionMutation] = [:]
    /// Set when a `refresh()` is requested while one is already running (e.g. the
    /// user toggles chambers mid catch-up). The in-flight chain re-runs once
    /// against the latest selection when it finishes. One Bool, not a queue:
    /// N changes that arrive during one fetch collapse into ONE re-run, and
    /// that re-run reads the live selection, so nothing is dropped and nothing
    /// is repeated.
    private var refreshQueued = false
    /// The running feed-refresh chain. Every `refresh()` caller awaits THIS,
    /// so `await store.refresh()` always means "the data for my change is on
    /// screen". The previous shape — `guard !isRefreshing else { refreshQueued
    /// = true; return }` — returned instantly to the second caller, so a
    /// filter change made during an in-flight fetch reported itself as applied
    /// seconds before it was: the caller's spinner cleared, and any code that
    /// awaited the setter (pending flags, tests, pull-to-refresh) saw a lie.
    private var refreshChain: Task<Void, Never>?
    /// Monotonic token for `refreshTrends()`. It has no in-flight guard by
    /// design (12 independent GETs, all idempotent), so two runs CAN overlap;
    /// without this the slower OLD run wins the write race and Trends shows
    /// charts for a filter the user already moved off. Worse than rare:
    /// analytics are KV-cached per filter combo, so the newer request is
    /// frequently the fast one and the stale overwrite is the common case.
    private var trendsGeneration = 0
    /// "The user has asked for a filter change that hasn't been sent yet."
    /// Owned by the view's debounce timer via `noteFilterIntent()`.
    private var hasFilterIntent = false
    /// Watchdog that clears a stranded intent. The view owns the debounce, so
    /// a cancelled debounce Task (tab switch, view teardown, a menu dismissed
    /// without applying) could otherwise pin the indicator on forever. Nothing
    /// is worse for trust than a spinner that never stops.
    private var filterIntentWatchdog: Task<Void, Never>?
    /// Depth counters, not Bools: two filter surfaces can be mid-apply at once
    /// (chamber change fans out to feed AND trends, and a second tap can land
    /// while the first is running).
    private var feedApplyDepth = 0
    private var trendsApplyDepth = 0
    /// The filter signature `tradeTotal` was measured against. `tradeTotal` is
    /// only written when a response carries `total`, and is never reset on
    /// failure — so after an error, or immediately after a filter change, the
    /// number on screen describes the PREVIOUS filter set. Comparing this to
    /// `countFilterKey` is what stops us rendering that stale number.
    private var tradeTotalFilterKey: String?
    /// Foreground poll timer driven by the feed's `nextPollAfterSec`
    /// (`ClientFeedResponse`). Cancelled while the app is backgrounded.
    private var autoRefreshTask: Task<Void, Never>?
    private var autoRefreshPaused = false
    /// Server-side search term applied on submit (`ticker=` when it looks like
    /// a symbol, otherwise `member=`). Local debounced filtering of the loaded
    /// cache is unchanged and happens in the view layer.
    private var searchTerm: String?

    /// Soft cap on local cache rows (newest by trade date). Avoids multi-thousand
    /// seed crawls while still supporting offline read-back of the last window.
    private var cacheLimit: Int { max(400, viewLimit * 3) }
    private var pageLimit: Int { min(max(viewLimit, 50), 200) }
    /// Attempts (including the first) for a single page fetch before giving up.
    private static let maxAttemptsPerPage = 3
    /// Mirrors the server's `MAX_PUBLIC_TX_OFFSET` (app/src/security/botDefense.ts)
    /// so the pager disables "Next" before ever sending a request the public
    /// feed would 400 — deep paging past this depth is Premium CSV export's job.
    private static let maxPublicOffset = 2000
    private var membersLastLoadedAt: Date?
    private static let membersCacheTTL: TimeInterval = 5 * 60
    /// STALE-COMMENT CORRECTION (2026-08-10): this used to be documented as
    /// "the backend's true default view when `chamber` is omitted — excluding
    /// Executive". Omitting `chamber=` now means ALL chambers, Executive
    /// included (`app/src/delivery/rows.ts:577`, "Executive rows are no longer
    /// excluded by default"). The constants are kept because they are the
    /// seed/reset selections the UI offers, not a claim about the server.
    static let defaultChambers: Set<ChamberFilter> = [.house, .senate]
    static let initialChambers: Set<ChamberFilter> = [.house, .senate, .executive]
    /// Ceiling on how long an un-applied filter intent may hold the indicator
    /// on. Comfortably longer than the view's debounce (~320-450ms) so it
    /// never truncates a real gesture, short enough that a stranded intent is
    /// a blink rather than a stuck spinner.
    private static let filterIntentTimeout: TimeInterval = 2.0

    init(
        api: CongressTradeAPIClient,
        cursorStore: SyncCursorStore = UserDefaultsSyncCursorStore(),
        sleeper: @escaping (Double) async -> Void = { seconds in
            try? await Task.sleep(nanoseconds: UInt64((seconds * 1_000_000_000).rounded()))
        }
    ) {
        self.api = api
        self.cursorStore = cursorStore
        self.sleeper = sleeper
        let storedToken = try? api.tokenStore.load()
        self.hasStoredSessionToken = storedToken?.isEmpty == false
    }

    var signedIn: Bool {
        bootstrap?.auth.user != nil
    }

    var signedInUser: User? {
        bootstrap?.auth.user
    }

    var isPremium: Bool {
        bootstrap?.auth.entitlement.premium == true
    }

    var entitlementLabel: String {
        isPremium ? "Premium" : "Free"
    }

    /// `"stripe" | "apple" | nil` — which billing surface currently backs
    /// Premium, for choosing between the App Store subscriptions page and the
    /// Stripe billing portal link. Additive/optional on the server
    /// (`app/docs/client-mobile-api.md` "Entitlement semantics"); `nil` means
    /// "unknown," not "not premium" — always gate visibility on `isPremium`.
    var entitlementSource: String? {
        bootstrap?.auth.entitlement.source
    }

    static func parseTickers(_ text: String) -> [String] {
        text
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() }
            .filter { !$0.isEmpty }
    }

    // MARK: - Filter-apply progress (owner: "3-5 seconds with no indicator")

    /// Alias for `isFilterPending`. The Phase-1 diagnosis handed the view lane
    /// this name, and both tabs' indicators were speced against it; keeping it
    /// costs one line and removes a whole class of "which flag was it?" churn
    /// while three files are being edited concurrently.
    var isApplyingFilters: Bool { isFilterPending }

    /// Call the INSTANT the user taps a filter control — before the view's
    /// debounce timer starts, not after it fires.
    ///
    /// The debounce lives in the view (`FeedDashboardView.scheduleFilterApply`)
    /// because that is where the coalescing has to happen: the multi-select
    /// menus stay open across taps by design, so a normal gesture is 2-3 taps
    /// that must collapse into one request. The store therefore cannot see the
    /// gesture begin. Without this call the indicator would appear ~450ms
    /// after the tap and the control would read as dead for exactly the window
    /// the owner complained about.
    ///
    /// Idempotent — call it on every tap of a burst; each call re-arms the
    /// watchdog. Safe to call from a view that then cancels its debounce.
    func noteFilterIntent() {
        hasFilterIntent = true
        syncFilterPendingFlags()
        filterIntentWatchdog?.cancel()
        filterIntentWatchdog = Task { @MainActor [weak self] in
            let timeout = Self.filterIntentTimeout
            try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
            guard !Task.isCancelled, let self else { return }
            self.clearFilterIntent()
        }
    }

    /// Drops an intent that will never be applied (the user reverted the pill,
    /// the sheet was dismissed). The watchdog would get there on its own; this
    /// just makes the indicator honest immediately.
    func clearFilterIntent() {
        filterIntentWatchdog?.cancel()
        filterIntentWatchdog = nil
        guard hasFilterIntent else { return }
        hasFilterIntent = false
        syncFilterPendingFlags()
    }

    /// An apply has started, so the intent it represented is now covered by a
    /// real in-flight request; hand the indicator over without letting it
    /// blink off in between (clear intent and raise depth in one turn).
    private func beginFilterApply(feed: Bool, trends: Bool) {
        if feed { feedApplyDepth += 1 }
        if trends { trendsApplyDepth += 1 }
        filterIntentWatchdog?.cancel()
        filterIntentWatchdog = nil
        hasFilterIntent = false
        syncFilterPendingFlags()
    }

    private func endFilterApply(feed: Bool, trends: Bool) {
        if feed { feedApplyDepth = max(0, feedApplyDepth - 1) }
        if trends { trendsApplyDepth = max(0, trendsApplyDepth - 1) }
        syncFilterPendingFlags()
    }

    private func syncFilterPendingFlags() {
        let feedPending = hasFilterIntent || feedApplyDepth > 0
        let trendsPending = hasFilterIntent || trendsApplyDepth > 0
        // Assign only on change: these are read by every row of both tabs, and
        // `@Published` republishes on every set, change or not.
        if isFeedFilterPending != feedPending { isFeedFilterPending = feedPending }
        if isTrendsFilterPending != trendsPending { isTrendsFilterPending = trendsPending }
        let anyPending = feedPending || trendsPending
        if isFilterPending != anyPending { isFilterPending = anyPending }
    }

    /// Fan-out used by every filter that both tabs share (chamber, party,
    /// timeframe, sides). Both flags are raised SYNCHRONOUSLY here — before
    /// the first `await` — so a control that skipped `noteFilterIntent()`
    /// still lights the indicator in the same runloop turn as the tap, and
    /// each surface releases its own flag the moment ITS request lands.
    private func refreshFeedAndTrends() async {
        beginFilterApply(feed: true, trends: true)
        async let feedDone: Void = runFeedRefreshThenEndApply()
        async let trendsDone: Void = runTrendsRefreshThenEndApply()
        _ = await (feedDone, trendsDone)
    }

    /// Paired with the `beginFilterApply(feed: true, ...)` in
    /// `refreshFeedAndTrends()` — do not call it standalone; use
    /// `refreshFeedTrackingFilter()` for a feed-only change.
    private func runFeedRefreshThenEndApply() async {
        defer { endFilterApply(feed: true, trends: false) }
        await refresh()
    }

    /// Paired with the `beginFilterApply(..., trends: true)` in
    /// `refreshFeedAndTrends()`.
    private func runTrendsRefreshThenEndApply() async {
        defer { endFilterApply(feed: false, trends: true) }
        await refreshTrends()
    }

    /// Feed-only change (search, dedicated filters, sort, paging). Trends is
    /// intentionally untouched: search is Trades-local on both the client and
    /// the server, and `refreshTrends()` reads none of the search fields.
    private func refreshFeedTrackingFilter() async {
        beginFilterApply(feed: true, trends: false)
        defer { endFilterApply(feed: true, trends: false) }
        await refresh()
    }

    /// Selects the chamber chips and immediately resyncs against that
    /// selection's own request. Empty = all branches.
    func setChamberSelection(_ chambers: Set<ChamberFilter>) async {
        // Allow empty = all branches (website parity with unselected H/S/P).
        selectedChambers = chambers
        currentPage = 0
        syncClientOnlyFilteringFlag()
        await refreshFeedAndTrends()
    }

    func setTimeRange(_ range: TimeRange) async {
        guard range != selectedTimeRange else {
            // The tap still opened an intent in the view; nothing will apply
            // it, so retire it here rather than let the watchdog do it.
            clearFilterIntent()
            return
        }
        selectedTimeRange = range
        currentPage = 0
        await refreshFeedAndTrends()
    }

    /// Sets the full Buy/Sell/Exchange multi-selection and immediately
    /// resyncs. Empty = all sides.
    func setTradeTypeSelection(_ types: Set<TradeTypeFilter>) async {
        guard types != selectedTradeTypes else {
            clearFilterIntent()
            return
        }
        selectedTradeTypes = types
        currentPage = 0
        syncClientOnlyFilteringFlag()
        await refreshFeedAndTrends()
    }

    /// Trades-only politician name filter (server `memberName=`).
    func setPoliticianFilter(_ text: String) async {
        let next = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard next != politicianFilter else {
            clearFilterIntent()
            return
        }
        politicianFilter = next
        currentPage = 0
        await refreshFeedTrackingFilter()
    }

    /// Trades-only asset/ticker filter (server `ticker=`).
    func setAssetFilter(_ text: String) async {
        let next = text.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard next != assetFilter else {
            clearFilterIntent()
            return
        }
        assetFilter = next
        currentPage = 0
        await refreshFeedTrackingFilter()
    }

    // MARK: - Trades sort control (owner punch list #2, item 7)

    /// Selecting Date refetches the current page with `sort=tx_date` in the
    /// existing direction; selecting Amount is a local re-sort only (no
    /// backend `amount` sort key — see `FeedSortKey.isServerSort`).
    func setFeedSortKey(_ key: FeedSortKey) async {
        guard key != feedSortKey else {
            clearFilterIntent()
            return
        }
        feedSortKey = key
        guard key.isServerSort else {
            // Amount is a local re-sort — nothing is in flight to wait on.
            clearFilterIntent()
            return
        }
        currentPage = 0
        await refreshFeedTrackingFilter()
    }

    /// Flips asc/desc for whichever sort key is active. Only a server-sort
    /// key (currently Date) needs a refetch; Amount just re-renders the
    /// already-loaded page in the new direction.
    func toggleFeedSortDirection() async {
        feedSortDirection = feedSortDirection.toggled
        guard feedSortKey.isServerSort else {
            clearFilterIntent()
            return
        }
        currentPage = 0
        await refreshFeedTrackingFilter()
    }

    // MARK: - Pagination (owner punch list #2, item 8)

    /// Rows actually requested per page — already existed internally as
    /// `pageLimit`; exposed read-only for the "N / page" pager control.
    var pageSize: Int { pageLimit }

    /// `tradeTotal` is the API's `COUNT(*)` for the active filters (never
    /// cursor_seq — see the `tradeTotal` doc comment above), so this is
    /// stable across pages of the same filter set.
    var totalPages: Int {
        guard tradeTotal > 0 else { return 1 }
        return max(1, Int((Double(tradeTotal) / Double(pageLimit)).rounded(.up)))
    }

    var canGoToPreviousPage: Bool { currentPage > 0 }

    /// Also false once the *next* page's offset would exceed the server's
    /// public depth cap, so "Next" never dead-ends on a 400.
    var canGoToNextPage: Bool {
        currentPage + 1 < totalPages && (currentPage + 1) * pageLimit <= Self.maxPublicOffset
    }

    /// Paging reports through the same pending flag as a filter change: from
    /// the user's side it is the same "I asked for different rows, when do
    /// they arrive" wait, and the count must be suppressed for the same reason
    /// (the rows on screen are the old page's until it lands).
    func goToNextPage() async {
        guard canGoToNextPage else { return }
        currentPage += 1
        await refreshFeedTrackingFilter()
    }

    func goToPreviousPage() async {
        guard canGoToPreviousPage else { return }
        currentPage -= 1
        await refreshFeedTrackingFilter()
    }

    /// Rows-per-page control. Routes through `viewLimit`'s existing `didSet`
    /// (which already resets `currentPage` and refetches) so there is one
    /// path for "page size changed," not two.
    func setPageSize(_ size: Int) {
        viewLimit = size
    }

    /// Applies a server-side search filter (submit path; typing alone keeps
    /// using the local debounced cache filter). `nil`/empty clears it.
    /// Prefer `setPoliticianFilter` / `setAssetFilter` for dedicated fields.
    func setSearch(_ term: String?) async {
        let trimmed = (term ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let next = trimmed.isEmpty ? nil : trimmed
        guard next != searchTerm else {
            clearFilterIntent()
            return
        }
        searchTerm = next
        currentPage = 0
        await refreshFeedTrackingFilter()
    }

    /// Short all-caps tokens are treated as ticker symbols (`ticker=`);
    /// anything longer or with spaces goes to free-text politician search
    /// (`memberName=`).
    private static func looksLikeTicker(_ term: String) -> Bool {
        term.range(of: #"^[A-Za-z]{1,5}(\.[A-Za-z]{1,2})?$"#, options: .regularExpression) != nil
    }

    /// Pauses/resumes the foreground poll timer (backgrounded scenes must not
    /// keep polling). Resuming schedules from the last feed's
    /// `nextPollAfterSec`; the next successful refresh re-arms it anyway.
    func setAutoRefreshPaused(_ paused: Bool) {
        autoRefreshPaused = paused
        if paused {
            autoRefreshTask?.cancel()
            autoRefreshTask = nil
        } else {
            scheduleAutoRefresh()
        }
    }

    private func scheduleAutoRefresh() {
        autoRefreshTask?.cancel()
        autoRefreshTask = nil
        guard !autoRefreshPaused, let delay = feed?.nextPollAfterSec else { return }
        // Clamp so a bad server value can neither spin nor stall the loop.
        let seconds = min(max(delay, 15), 300)
        autoRefreshTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(seconds) * 1_000_000_000)
            guard !Task.isCancelled, let self else { return }
            await self.refresh()
        }
    }

    /// Refreshes the feed and does not return until the caller's request is
    /// actually reflected on screen — including the case where it had to be
    /// coalesced behind an in-flight fetch.
    ///
    /// THE BUG THIS REPLACES: `guard !isRefreshing else { refreshQueued = true;
    /// return }` returned instantly to the second caller. The work was not
    /// dropped (the in-flight run re-ran against the live selection), but the
    /// caller was told it was done seconds early — so a filter change made
    /// during a fetch looked like "it just isn't working": the pending flag
    /// cleared, the spinner cleared, and the rows changed later, apparently at
    /// random. Joining the chain instead of returning makes `await refresh()`
    /// mean what every caller already assumed it meant.
    func refresh() async {
        if let chain = refreshChain {
            // Ask the running chain for one more pass with the latest
            // selection, then wait for the whole chain — ours included.
            refreshQueued = true
            await chain.value
            return
        }
        // Unstructured on purpose: the chain must outlive the individual
        // caller that started it, or a view teardown mid-fetch would cancel a
        // refresh that three other callers are waiting on.
        let chain = Task { @MainActor [weak self] in
            guard let self else { return }
            await self.runRefreshChain()
        }
        refreshChain = chain
        await chain.value
    }

    /// Runs feed refreshes until nothing more is queued.
    ///
    /// Not recursion and not a poll loop: each extra iteration requires an
    /// EXTERNAL caller to have set `refreshQueued` during the previous pass,
    /// and nothing inside `performRefresh()` sets it. The flag is cleared
    /// before each pass so a change arriving mid-pass earns its own pass.
    private func runRefreshChain() async {
        // Held true across the whole chain. It used to flicker false between
        // coalesced runs, which is why any indicator bound to it blinked in
        // the middle of a burst of filter taps.
        isRefreshing = true
        repeat {
            refreshQueued = false
            await performRefresh()
        } while refreshQueued
        // Everything from the final `refreshQueued` read to dropping the
        // handle is straight-line synchronous — no `await` — so no other
        // MainActor work can interleave. That is what makes the invariant
        // "a non-nil handle will see my flag" true, and therefore what makes
        // the join in `refresh()` above safe rather than racy.
        isRefreshing = false
        refreshChain = nil
        // Arm the next foreground poll from the final feed's cadence hint.
        scheduleAutoRefresh()
    }

    private func performRefresh() async {
        feedNotice = nil
        let chambers = selectedChambers
        let chamberParam = Self.chamberQueryValue(for: chambers)
        let from = selectedTimeRange.fromDateISO
        let to = selectedTimeRange.toDateISO
        let search = searchTerm
        let typeParam = Self.tradeTypeQueryValue(for: selectedTradeTypes)
        // Snapshot of "which filters this request is for", taken before the
        // first await so a selection change mid-flight cannot make the
        // returned count look current for filters it never saw.
        let requestCountKey = countFilterKey
        // Dedicated fields win; legacy combined search still fills the other slot.
        let tickerParam: String? = {
            if !assetFilter.isEmpty { return assetFilter }
            return search.flatMap { Self.looksLikeTicker($0) ? $0.uppercased() : nil }
        }()
        let memberNameParam: String? = {
            if !politicianFilter.isEmpty { return politicianFilter }
            return search.flatMap { Self.looksLikeTicker($0) ? nil : $0 }
        }()
        // Date is a real backend sort key (`sort=tx_date`); its direction
        // drives `order=`. Amount has no backend sort key, so the fetched
        // page always stays in the stable newest-first server order and the
        // view re-sorts what's already loaded (FeedDashboardView.sortedCached).
        let orderParam = feedSortKey.isServerSort ? feedSortDirection.rawValue : SortDirection.descending.rawValue
        let page = currentPage
        let offsetParam = page > 0 ? page * pageLimit : nil
        do {
            async let bootstrapTask = api.bootstrap()
            // One page of the current window/sort — not a multi-page
            // historical crawl. Users change the window/page-size/page
            // controls if they want a different slice; the list they see is
            // the list we load.
            let response = try await fetchPageWithRetry(
                FeedQuery(
                    limit: pageLimit,
                    since: nil,
                    ticker: tickerParam,
                    // Free-text politician search must use memberName= (LIKE),
                    // not member= (exact filer/bioguide id). CT UX P0.
                    member: nil,
                    memberName: memberNameParam,
                    chamber: chamberParam,
                    type: typeParam,
                    from: from,
                    to: to,
                    sort: "tx_date",
                    order: orderParam,
                    offset: offsetParam
                )
            )
            try replaceCache(with: response)
            feed = response
            if let total = response.total {
                tradeTotal = total
                // Stamp WHICH filters this count describes. Without it the
                // number outlives its filter set: `tradeTotal` is never reset
                // on failure, so after an error (or before the next response
                // lands) it silently describes the previous selection.
                tradeTotalFilterKey = requestCountKey
            }
            bootstrap = try await bootstrapTask
            lastSuccessfulRefresh = Date()
            isOffline = false
            // Forward watermark only (for optional background catch-up of brand-new rows).
            let filterKey = Self.syncFilterKey(
                chambers: chambers,
                range: selectedTimeRange,
                tradeTypes: selectedTradeTypes
            )
            if let cursor = response.cursor { cursorStore.setCursor(cursor, for: filterKey) }
            if signedIn {
                await refreshSignedInState()
                await PushNotificationManager.shared.syncTokenWithBackend(api: api)
            } else {
                subscriptions = []
                commands = []
                watchlist = []
            }
        } catch {
            if Task.isCancelled { /* superseding refresh / view teardown */ }
            else if let apiError = error as? APIError, apiError.isCancellation {
                // Normal Task cancel — do not paint a grey "cancelled" banner.
            } else {
                isOffline = (error as? APIError)?.isOffline == true
                feedNotice = isOffline
                    ? "Offline. Showing saved trades from this device."
                    : error.localizedDescription
            }
        }
        // No `isRefreshing`/queue/timer bookkeeping here on purpose — the
        // chain owns all three (`runRefreshChain`), so one pass of this
        // function is exactly one fetch and nothing else.
    }

    /// Sets the full party multi-selection and immediately resyncs both the
    /// (client-side-filtered) Trades feed and Trends analytics. Empty = all
    /// parties.
    func setPartySelection(_ parties: Set<PartyFilter>) async {
        guard parties != selectedParties else {
            clearFilterIntent()
            return
        }
        selectedParties = parties
        currentPage = 0
        syncClientOnlyFilteringFlag()
        await refreshFeedAndTrends()
    }

    /// Refreshes every Trends chart for the current shared filters.
    ///
    /// Has no in-flight guard by design — 12 idempotent GETs, and blocking
    /// would make the tab feel stuck — so two runs can overlap. The generation
    /// token is what keeps that safe: a run that has been superseded publishes
    /// NOTHING and does not touch `isLoadingTrends`. Without it the slower OLD
    /// run wins (and it usually is the older one that is slower, because the
    /// newer filter combo is more likely to be a KV cache hit), leaving Trends
    /// showing charts for a filter the user already moved off, with the
    /// spinner already cleared.
    func refreshTrends() async {
        trendsGeneration &+= 1
        let generation = trendsGeneration
        isLoadingTrends = true
        trendsNotice = nil
        // All-time + calendar-year analytics map through analyticsWindow.
        let analyticsWindow = selectedTimeRange.analyticsWindow
        // Server `party=` (`asPartyBucket`) is single-valued — see the
        // `selectedParties` doc comment above. Forward it only when exactly
        // one party is selected; 0 or 2+ selected shows unfiltered analytics.
        let partyParam = selectedParties.count == 1 ? selectedParties.first?.rawValue : nil
        let chamberParam = selectedChambers.isEmpty || selectedChambers.count == ChamberFilter.allCases.count
            ? nil
            : selectedChambers.map { $0.rawValue }.sorted().joined(separator: ",")

        do {
            async let summaryTask = api.analyticsSummary(window: analyticsWindow, party: partyParam, chamber: chamberParam)
            async let tickersTask = api.tickerLeaderboard(window: analyticsWindow, party: partyParam, chamber: chamberParam, rankBy: "volume")
            async let volumeTask = api.volumeOverTime(window: analyticsWindow, party: partyParam, chamber: chamberParam)
            async let sectorsTask = api.sectorFlow(window: analyticsWindow, party: partyParam, chamber: chamberParam)
            async let membersTask = api.memberLeaderboard(window: analyticsWindow, party: partyParam, chamber: chamberParam)
            async let clustersTask = api.clusterBuys(window: analyticsWindow, party: partyParam, chamber: chamberParam)
            async let trendingTask = api.trending(window: analyticsWindow, party: partyParam, chamber: chamberParam)
            async let topPerformersTask = api.topPerformers(window: analyticsWindow, party: partyParam, chamber: chamberParam)
            async let marketCapTask = api.marketCapBreakdown(window: analyticsWindow, party: partyParam, chamber: chamberParam)
            async let partySplitTask = api.partySplit(window: analyticsWindow, chamber: chamberParam)
            async let filingLagTask = api.filingLag(window: analyticsWindow, party: partyParam, chamber: chamberParam)
            // Latency is independent of trends filters; load it fail-soft so a
            // slow/failed scoreboard never blanks the rest of Trends.
            async let latencyTask = api.latencySummary()

            // Collect first, publish second. The old code assigned each chart
            // as its request resolved, which meant a superseded run could
            // interleave its charts with the current run's — and that a
            // mid-list failure left the tab showing half one filter's data and
            // half another's. One atomic block behind one generation check is
            // the only shape where every chart on screen is guaranteed to
            // describe the SAME filter set.
            let summary = try await summaryTask
            let tickers = try await tickersTask.tickers
            let volume = try await volumeTask.series
            let sectors = try await sectorsTask.sectors
            // `memberLeaders`, not `members`: the store already has a
            // `members` property (the People directory roster) and shadowing
            // it here would be a trap for the next reader.
            let memberLeaders = try await membersTask.members
            let clusters = try await clustersTask.clusters
            let trending = (try? await trendingTask)?.trending ?? []
            let performers = (try? await topPerformersTask)?.members ?? []
            let marketCaps = (try? await marketCapTask)?.buckets ?? []
            let split = try? await partySplitTask
            let lag = try? await filingLagTask
            // Latency is independent of the trends filters, so a failure here
            // must not blank the rest of the tab — and a cancel is not a
            // result, so it keeps whatever is already on screen.
            var latency: LatencySummary?
            do {
                latency = try await latencyTask
            } catch {
                let cancelled = (error as? APIError)?.isCancellation == true
                latency = cancelled ? latencySummary : nil
            }

            // Superseded by a newer filter selection — drop this whole run on
            // the floor, including `isLoadingTrends`, which now belongs to the
            // newer run.
            guard generation == trendsGeneration else { return }

            analyticsSummary = summary
            tickerLeaderboard = tickers
            volumeSeries = volume
            sectorFlow = sectors
            memberLeaderboard = memberLeaders
            clusterBuys = clusters
            trendingAssets = trending
            topPerformers = performers
            marketCapBuckets = marketCaps
            partySplit = split
            filingLag = lag
            latencySummary = latency
        } catch {
            guard generation == trendsGeneration else { return }
            if Task.isCancelled { /* ignore */ }
            else if let apiError = error as? APIError, apiError.isCancellation {
                // Normal Task cancel — do not paint a grey "cancelled" banner.
            } else {
                trendsNotice = error.localizedDescription
            }
        }
        guard generation == trendsGeneration else { return }
        isLoadingTrends = false
    }

    private func fetchPageWithRetry(_ query: FeedQuery) async throws -> ClientFeedResponse {
        var attempt = 0
        while true {
            do {
                return try await api.feed(query: query)
            } catch let error as APIError {
                attempt += 1
                guard error.isRetryable, attempt < Self.maxAttemptsPerPage else { throw error }
                let backoffSeconds = error.retryAfterSeconds.map(Double.init) ?? pow(2.0, Double(attempt))
                guard backoffSeconds <= 15.0 else { throw error }
                await sleeper(backoffSeconds)
            }
        }
    }

    /// Replace the local cache with the snapshot we just fetched so the list
    /// matches the active window/sort instead of mixing in stale all-time rows.
    /// Upserts by `id` inside a single `save()` instead of the old
    /// delete-everything/re-insert churn (which rewrote every row on every
    /// poll and left the store empty between the delete and the insert).
    private func replaceCache(with response: ClientFeedResponse) throws {
        guard let context = modelContext else { return }
        let existing = try context.fetch(FetchDescriptor<ClientTrade>())
        let byID = Dictionary(existing.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var seen = Set<String>()
        for item in response.items {
            seen.insert(item.id)
            if let cached = byID[item.id] {
                cached.apply(item)
            } else {
                context.insert(item)
            }
        }
        for trade in existing where !seen.contains(trade.id) {
            context.delete(trade)
        }
        if context.hasChanges {
            try context.save()
        }
        try trimCache(in: context)
    }

    /// Confirms a cached trade is still live; removes it locally and returns
    /// `true` if the server reports it retracted (404 on `GET /trade/:id`).
    @discardableResult
    func reconcileIfDeprecated(_ trade: ClientTrade) async -> Bool {
        do {
            let stillExists = try await api.tradeStillExists(id: trade.id)
            guard !stillExists else { return false }
            if let context = modelContext {
                context.delete(trade)
                try? context.save()
            }
            feedNotice = "A disclosure you had open was retracted by its source and removed from your feed."
            return true
        } catch {
            return false
        }
    }

    private static func syncFilterKey(
        chambers: Set<ChamberFilter>,
        range: TimeRange,
        tradeTypes: Set<TradeTypeFilter> = []
    ) -> String {
        let chamberKey = (chambers.isEmpty ? initialChambers : chambers)
            .map(\.rawValue)
            .sorted()
            .joined(separator: ",")
        let typeKey = tradeTypes.isEmpty ? "all" : tradeTypes.map(\.rawValue).sorted().joined(separator: ",")
        return "\(chamberKey)|\(range.rawValue)|\(typeKey)"
    }

    // MARK: - Truthful trade count (owner: it always said "100 trades")

    /// Signature of the filters a `total` was measured against. Only the
    /// server-visible params matter here — a client-only narrowing changes
    /// nothing about which COUNT(*) the server ran, and is reported separately
    /// by `hasClientOnlyFiltering`.
    private var countFilterKey: String {
        [
            Self.chamberQueryValue(for: selectedChambers) ?? "-",
            selectedTimeRange.rawValue,
            Self.tradeTypeQueryValue(for: selectedTradeTypes) ?? "-",
            assetFilter.isEmpty ? "-" : assetFilter,
            politicianFilter.isEmpty ? "-" : politicianFilter,
            searchTerm ?? "-"
        ].joined(separator: "|")
    }

    /// True only while `tradeTotal` was measured against the filters that are
    /// selected right now. False after a filter change until the response
    /// lands, and false after a failed refresh — `tradeTotal` is never reset
    /// on error, so without this the last successful filter set's number would
    /// sit above a different set's rows indefinitely.
    var tradeTotalMatchesCurrentFilters: Bool {
        tradeTotalFilterKey == countFilterKey
    }

    private func syncClientOnlyFilteringFlag() {
        // Party: no `party` field on `FeedQuery`, so the server counted every
        // party. Sides: `type=` omitted for a 2+ selection. Chambers: an
        // all-three selection omits `chamber=` (server counts unresolved-
        // chamber rows) while the view drops them.
        let next = !selectedParties.isEmpty
            || selectedTradeTypes.count > 1
            || selectedChambers.count == ChamberFilter.allCases.count
        if hasClientOnlyFiltering != next { hasClientOnlyFiltering = next }
    }

    /// The only honest way to render a trade count.
    ///
    /// Returns the server's total when it genuinely answers "how many trades
    /// match what I'm looking at", and `nil` when no such number is knowable
    /// client-side. `nil` means SHOW NO NUMBER (or a phrasing that says it is
    /// page-scoped, e.g. "N on this page") — it must never be back-filled with
    /// `filteredTrades.count`, which is the loaded page and is capped at
    /// `pageSize`; that is the whole reason the owner kept seeing "100 trades".
    ///
    /// `localSearchText` is a PARAMETER rather than store state on purpose.
    /// The Trades search box is `@State` in `FeedDashboardView` and is a local
    /// re-filter of the loaded page; mirroring it into the store would create
    /// a second source of truth for a value the store has no other use for,
    /// and would tempt a future caller into "filtering" by it server-side —
    /// which is not equivalent (`TradeSearch.matches` is a multi-token AND
    /// across name / ticker / asset / state / party, while the server sees at
    /// most one of `ticker=` or `memberName=`).
    func honestTradeTotal(localSearchText: String = "") -> Int? {
        // Mid-apply the rows on screen belong to the previous filter set, and
        // so does the number.
        guard !isFeedFilterPending else { return nil }
        guard tradeTotalMatchesCurrentFilters else { return nil }
        guard !hasClientOnlyFiltering else { return nil }
        guard localSearchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return tradeTotal
    }

    /// Same test as `honestTradeTotal` without the value, for a view that
    /// wants to pick copy before it has a number to format.
    func isTradeTotalTruthful(localSearchText: String = "") -> Bool {
        honestTradeTotal(localSearchText: localSearchText) != nil
    }

    /// The `chamber=` query value for a selection, or `nil` to omit the
    /// parameter entirely when the selection cannot narrow anything (empty, or
    /// all three). Note the asymmetry that `hasClientOnlyFiltering` exists to
    /// report: omitting the param makes the SERVER count rows whose chamber is
    /// unresolved, while an active client-side selection drops exactly those
    /// rows (`FeedDashboardView.filteredTrades`).
    private static func chamberQueryValue(for chambers: Set<ChamberFilter>) -> String? {
        // Empty (or all three) = omit chamber= so unresolved-chamber rows stay in view.
        let all = Set(ChamberFilter.allCases)
        if chambers.isEmpty || chambers == all { return nil }
        return chambers.map(\.rawValue).sorted().joined(separator: ",")
    }

    /// The `type=` query value for a multi-selection, or `nil` to omit the
    /// parameter — sent only when exactly one side is selected. Any selection
    /// count is still filtered correctly client-side afterward (see
    /// `FeedDashboardView.filteredTrades`); only the server-side COUNT(*) is
    /// affected, which is why a 2+ selection sets `hasClientOnlyFiltering`.
    ///
    /// The historical reason for the omission ("the server's `type=` is
    /// single-valued") no longer holds — `asTxTypes` parses `type=B,S` as of
    /// d5d85f0c. Making this `guard !types.isEmpty` + sorted CSV is the whole
    /// fix and would retire one of the three client-only narrowings, but
    /// `CongressTradeTests.testSetTradeTypeSelectionOmitsTypeParamWhenMultipleSidesSelected`
    /// pins the current behavior, so the change belongs in the same commit as
    /// that test rather than silently breaking it from this lane.
    private static func tradeTypeQueryValue(for types: Set<TradeTypeFilter>) -> String? {
        guard types.count == 1 else { return nil }
        return types.first?.rawValue
    }

    private func trimCache(in context: ModelContext) throws {
        // After replaceCache the store holds one windowed snapshot; cursor-desc
        // is a fine eviction order (newest inserts keep). Display sort is by
        // trade date in the view layer.
        var descriptor = FetchDescriptor<ClientTrade>(
            sortBy: [SortDescriptor(\.cursor, order: .reverse)]
        )
        descriptor.fetchOffset = cacheLimit
        for trade in try context.fetch(descriptor) {
            context.delete(trade)
        }
        if context.hasChanges {
            try context.save()
        }
    }

    // MARK: - People directory (owner punch list #2, item 9)

    /// Loads the `GET /api/members` roster. Memoized for `membersCacheTTL`
    /// (mirrors the web's `PEOPLE_CACHE`/`PEOPLE_TTL_MS`, `dashboardHtml.ts`)
    /// so switching to the People tab repeatedly doesn't re-fetch the whole
    /// roster every time; pass `force: true` for pull-to-refresh.
    func loadMembersDirectory(force: Bool = false) async {
        if !force, let lastLoadedAt = membersLastLoadedAt,
           Date().timeIntervalSince(lastLoadedAt) < Self.membersCacheTTL, !members.isEmpty {
            return
        }
        isLoadingMembers = true
        membersNotice = nil
        do {
            let response = try await api.membersDirectory()
            members = response.members
            membersLastLoadedAt = Date()
        } catch {
            if let apiError = error as? APIError, apiError.isCancellation {
                // ignore
            } else {
                membersNotice = error.localizedDescription
            }
        }
        isLoadingMembers = false
    }

    func refreshSignedInState() async {
        do {
            async let subscriptionsTask = api.subscriptions()
            async let commandsTask = api.commands(limit: 12)
            async let preferencesTask = api.preferences()
            subscriptions = try await subscriptionsTask.subscriptions
            commands = try await commandsTask.commands
            watchlist = try await preferencesTask.preferences.watchlist
        } catch {
            if signedIn {
                commandNotice = error.localizedDescription
            }
        }
    }

    func saveWatchlist(_ text: String) async {
        let tickers = Self.parseTickers(text)

        let mutation = pendingWatchlistMutation?.tickers == tickers
            ? pendingWatchlistMutation!
            : PendingWatchlistMutation(tickers: tickers, idempotencyKey: UUID().uuidString)
        pendingWatchlistMutation = mutation
        isSavingWatchlist = true
        watchlistNotice = nil
        do {
            let response = try await api.updatePreferences(
                tickers: tickers,
                idempotencyKey: mutation.idempotencyKey
            )
            pendingWatchlistMutation = nil
            lastCommand = response.command
            watchlist = response.result?.preferences.watchlist ?? tickers
            watchlistNotice = response.replayed == true ? "Preferences already saved." : "Watchlist saved."
            await refreshCommandHistory()
        } catch {
            watchlistNotice = "Could not save. Retry will safely reuse this request: \(error.localizedDescription)"
        }
        isSavingWatchlist = false
    }

    func createDelivery(mode: DeliveryMode, webhookURL: String, chambers: Set<ChamberFilter> = [], members: [String] = []) async {
        let normalizedURL = webhookURL.trimmingCharacters(in: .whitespacesAndNewlines)
        let filters = SubscriptionFilters(
            members: members.isEmpty ? nil : members,
            tickers: watchlist.isEmpty ? nil : watchlist,
            chambers: chambers.isEmpty ? nil : chambers.map(\.rawValue).sorted()
        )
        let mutation = PendingDeliveryMutation(
            mode: mode,
            webhookURL: normalizedURL,
            filters: filters,
            idempotencyKey: UUID().uuidString
        )
        let request = pendingDeliveryMutation?.matches(mutation) == true ? pendingDeliveryMutation! : mutation
        pendingDeliveryMutation = request
        isCreatingDelivery = true
        deliveryNotice = nil
        do {
            let response: ClientCommandResponse<SubscriptionCommandResult>
            switch mode {
            case .sse:
                response = try await api.createSSESubscription(
                    filters: filters,
                    idempotencyKey: request.idempotencyKey
                )
            case .webhook:
                guard URL(string: normalizedURL)?.scheme?.lowercased() == "https" else {
                    deliveryNotice = "Webhook URLs must use HTTPS."
                    isCreatingDelivery = false
                    return
                }
                response = try await api.createWebhookSubscription(
                    targetURL: normalizedURL,
                    filters: filters,
                    idempotencyKey: request.idempotencyKey
                )
            }
            pendingDeliveryMutation = nil
            lastCommand = response.command
            if let subscription = response.result?.subscription {
                pendingDeliveryCredential = DeliveryCredential(
                    id: subscription.id,
                    delivery: subscription.delivery,
                    streamURL: api.absoluteClientURL(subscription.streamUrl),
                    secret: subscription.secret
                )
            }
            deliveryNotice = response.replayed == true
                ? "Delivery already created. A replay cannot reveal its one-time secret."
                : "Delivery created. Save the credential shown now."
            await refreshSignedInState()
        } catch {
            deliveryNotice = "Could not create delivery. Retry will safely reuse this request: \(error.localizedDescription)"
        }
        isCreatingDelivery = false
    }

    func clearPendingDeliveryCredential() {
        pendingDeliveryCredential = nil
    }

    func toggleSubscription(_ subscription: Subscription) async {
        let desiredActive = !subscription.active
        let previous = pendingSubscriptionMutations[subscription.id]
        let mutation = previous?.active == desiredActive
            ? previous!
            : PendingSubscriptionMutation(active: desiredActive, idempotencyKey: UUID().uuidString)
        pendingSubscriptionMutations[subscription.id] = mutation
        subscriptionIDsInFlight.insert(subscription.id)
        deliveryNotice = nil
        do {
            let response = try await api.setSubscriptionActive(
                id: subscription.id,
                active: desiredActive,
                idempotencyKey: mutation.idempotencyKey
            )
            pendingSubscriptionMutations[subscription.id] = nil
            lastCommand = response.command
            if let updated = response.result?.subscription,
               let index = subscriptions.firstIndex(where: { $0.id == updated.id }) {
                subscriptions[index] = updated
            } else {
                await refreshSignedInState()
            }
            deliveryNotice = desiredActive ? "Delivery resumed." : "Delivery paused."
        } catch {
            deliveryNotice = "Could not update delivery. Retry will safely reuse this request: \(error.localizedDescription)"
        }
        subscriptionIDsInFlight.remove(subscription.id)
    }

    /// Permanently removes a delivery subscription after the UI double-confirm.
    func deleteSubscription(_ subscription: Subscription) async {
        subscriptionIDsInFlight.insert(subscription.id)
        deliveryNotice = nil
        let key = UUID().uuidString
        do {
            let response = try await api.deleteSubscription(id: subscription.id, idempotencyKey: key)
            lastCommand = response.command
            subscriptions.removeAll { $0.id == subscription.id }
            deliveryNotice = "Delivery deleted."
        } catch {
            deliveryNotice = "Could not delete delivery: \(error.localizedDescription)"
            await refreshSignedInState()
        }
        subscriptionIDsInFlight.remove(subscription.id)
    }

    /// Premium CSV export using explicit From/To (export popup) plus active
    /// feed filters. Returns raw CSV bytes for share-sheet handoff.
    func exportCSV(from: String?, to: String?) async throws -> Data {
        guard signedIn else {
            throw APIError.server(status: 401, message: "Sign in required for CSV export", retryAfterSeconds: nil)
        }
        guard isPremium else {
            throw APIError.server(status: 402, message: "CSV export requires Premium", retryAfterSeconds: nil)
        }
        let chamberParam = Self.chamberQueryValue(for: selectedChambers)
        return try await api.exportTransactionsCSV(
            from: from,
            to: to,
            ticker: assetFilter.isEmpty ? nil : assetFilter,
            memberName: politicianFilter.isEmpty ? nil : politicianFilter,
            chamber: chamberParam,
            type: Self.tradeTypeQueryValue(for: selectedTradeTypes)
        )
    }

    /// Shared account-status notice setter for sign-in flows implemented
    /// outside this file (`Store/AppleSignIn.swift`) — `watchlistNotice`
    /// itself stays `private(set)` so every write funnels through this file.
    func setAccountNotice(_ text: String) {
        watchlistNotice = text
    }

    @discardableResult
    func saveSessionToken(_ token: String) -> Bool {
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            watchlistNotice = "Enter a session token."
            return false
        }
        do {
            try api.tokenStore.save(trimmed)
            hasStoredSessionToken = true
            watchlistNotice = "Signed in."
            Task {
                await refresh()
            }
            return true
        } catch {
            watchlistNotice = "Failed to save session: \(error.localizedDescription)"
            return false
        }
    }

    /// Sends a magic-link sign-in email (`POST /auth/magic/request?client=ios`).
    /// The emailed link deep-links back into the app as
    /// `congresstrade://auth?token=…` (handled by `onOpenURL` in the app root).
    func requestMagicLink(email: String) async {
        let trimmed = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !trimmed.isEmpty else {
            watchlistNotice = "Enter your email address."
            return
        }
        do {
            try await api.requestMagicLink(email: trimmed)
            watchlistNotice = "If that email is registered, a sign-in link is on its way."
        } catch {
            watchlistNotice = error.localizedDescription
        }
    }

    func signOut() async {
        guard hasStoredSessionToken, !isLoggingOut else { return }
        isLoggingOut = true
        watchlistNotice = nil
        do {
            try await api.logout()
            try api.tokenStore.clear()
            hasStoredSessionToken = false
            bootstrap = nil
            subscriptions = []
            commands = []
            watchlist = []
            watchlistNotice = "Signed out."
            await refresh()
        } catch {
            // Still clear local token so the UI doesn't stay half-signed-in.
            try? api.tokenStore.clear()
            hasStoredSessionToken = false
            bootstrap = nil
            subscriptions = []
            commands = []
            watchlist = []
            watchlistNotice = "Signed out locally. Server revoke may have failed: \(error.localizedDescription)"
        }
        isLoggingOut = false
    }

    private func refreshCommandHistory() async {
        do {
            commands = try await api.commands(limit: 12).commands
        } catch {
            commandNotice = error.localizedDescription
        }
    }
}

private struct PendingWatchlistMutation {
    let tickers: [String]
    let idempotencyKey: String
}

private struct PendingDeliveryMutation {
    let mode: DeliveryMode
    let webhookURL: String
    let filters: SubscriptionFilters
    let idempotencyKey: String

    func matches(_ other: PendingDeliveryMutation) -> Bool {
        mode == other.mode && webhookURL == other.webhookURL && filters == other.filters
    }
}

private struct PendingSubscriptionMutation {
    let active: Bool
    let idempotencyKey: String
}

enum DeliveryMode: String, CaseIterable, Identifiable {
    case sse = "SSE"
    case webhook = "Webhook"

    var id: String { rawValue }
}
