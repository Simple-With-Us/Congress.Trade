import SwiftUI
import SwiftData
import UIKit

struct FeedDashboardView: View {
    @EnvironmentObject private var store: CongressTradeStore
    @Query private var cachedTrades: [ClientTrade]
    @State private var searchText = ""
    @State private var filterTask: Task<Void, Never>?
    @State private var selectedTrade: ClientTrade?
    @State private var selectedPoliticianId: String?
    @State private var selectedPoliticianName: String?
    @State private var selectedTicker: String?
    /// Shared with Trends via the same `@AppStorage` keys so the disclaimer's
    /// dismissed/expanded state is one truth across both tabs (owner punch
    /// list item 2b) — never a per-view `@State` that resets on tab switch.
    @AppStorage("ct_disclaimer_expanded") private var disclaimerExpanded = true
    @AppStorage("ct_disclaimer_intro_done") private var disclaimerIntroDone = false
    @FocusState private var searchFocused: Bool

    /// `cachedTrades` minus any row whose SwiftData backing is already gone.
    ///
    /// Every refresh ends in `replaceCache`, which DELETES every cached
    /// `ClientTrade` missing from the new response. `@Query` republishes on its
    /// own schedule, so between the delete and that republish `cachedTrades`
    /// still hands out dead objects — and reading ANY persisted property on one
    /// traps (`EXC_BREAKPOINT` inside `ClientTrade.storedAsset.getter`,
    /// reproduced repeatedly by tapping the sort-direction control). Both the
    /// sort/filter closures below and `TradeCard` read persisted properties, so
    /// the window is closed here, once, rather than at each reader.
    private var liveCachedTrades: [ClientTrade] {
        cachedTrades.filter { !$0.isDeleted && $0.modelContext != nil }
    }

    /// Orders the loaded page per the active Trades sort control (owner
    /// punch list #2, item 7). Date is a real backend sort key — the server
    /// already returned rows in this order — but re-sorting here keeps the
    /// list stable/consistent even if a poll races the display. Amount has
    /// no backend sort key, so this IS the sort: a local re-sort of the
    /// already-loaded page only, never a fetch beyond it.
    private var sortedCached: [ClientTrade] {
        let ascending = store.feedSortDirection == .ascending
        switch store.feedSortKey {
        case .date:
            return liveCachedTrades.sorted { lhs, rhs in
                let ld = lhs.transaction.date ?? ""
                let rd = rhs.transaction.date ?? ""
                if ld != rd { return ascending ? ld < rd : ld > rd }
                let lf = lhs.filing.filedDate ?? ""
                let rf = rhs.filing.filedDate ?? ""
                if lf != rf { return ascending ? lf < rf : lf > rf }
                let lc = lhs.cursor ?? 0
                let rc = rhs.cursor ?? 0
                return ascending ? lc < rc : lc > rc
            }
        case .amount:
            return liveCachedTrades.sorted { lhs, rhs in
                let la = lhs.transaction.amountMin ?? 0
                let ra = rhs.transaction.amountMin ?? 0
                if la != ra { return ascending ? la < ra : la > ra }
                // Stable tie-break: newest trade date first, regardless of direction.
                return (lhs.transaction.date ?? "") > (rhs.transaction.date ?? "")
            }
        }
    }

    var filteredTrades: [ClientTrade] {
        let searchNeedle = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        let chambers = store.selectedChambers
        let filteringChambers = !chambers.isEmpty
        let fromISO = store.selectedTimeRange.fromDateISO
        let toISO = store.selectedTimeRange.toDateISO
        let types = store.selectedTradeTypes
        let parties = store.selectedParties

        return sortedCached.filter { trade in
            if let fromISO {
                let tx = trade.transaction.date ?? ""
                if !tx.isEmpty, tx < fromISO { return false }
            }
            if let toISO {
                let tx = trade.transaction.date ?? ""
                if !tx.isEmpty, tx > toISO { return false }
            }

            if filteringChambers {
                if let raw = trade.member.chamber?.lowercased(), let chamber = ChamberFilter(rawValue: raw) {
                    if !chambers.contains(chamber) { return false }
                } else {
                    // Unresolved chamber drops out only when a filter is active.
                    return false
                }
            }

            // Multi-select side filter. Server `type=` is single-valued (only
            // forwarded when exactly one side is selected — see
            // `CongressTradeStore.tradeTypeQueryValue`), so this local check
            // is what actually narrows the result for a 2+ selection.
            if !types.isEmpty, !types.contains(where: { $0.matches(txType: trade.transaction.type) }) {
                return false
            }

            // Party filter is entirely client-side: `/api/client/v1/feed`
            // does not accept a `party=` param at all (see
            // `CongressTradeStore.selectedParties` doc comment).
            if !parties.isEmpty {
                guard let bucket = PartyFilter.bucket(for: trade.member.party), parties.contains(bucket) else {
                    return false
                }
            }

            // Unified multi-token search (any order): each token may match
            // politician name, ticker, asset name, state, or party.
            if !searchNeedle.isEmpty {
                if !TradeSearch.matches(trade, query: searchNeedle) {
                    return false
                }
            }
            return true
        }
    }

    private var hasActiveTextFilter: Bool {
        !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The count line above the list — the owner's "the # of trades says 100 on
    /// top of that tab still".
    ///
    /// It said 100 because 100 is the PAGE SIZE, not a total: `replaceCache`
    /// deletes every cached row that is not in the latest response, so the
    /// local cache is exactly one page and `filteredTrades.count` saturates at
    /// `store.pageSize` whenever the page is full. No filter could ever move
    /// that number, which is precisely why it looked broken.
    ///
    /// `store.honestTradeTotal(localSearchText:)` returns the server's
    /// `COUNT(*)` only while it genuinely describes what is on screen (right
    /// filters, request landed, no client-only narrowing, no local search) and
    /// `nil` otherwise. In the `nil` case we never back-fill with a page count
    /// dressed up as a total: we either say nothing (the owner explicitly
    /// accepted "no number there") or say, in words, that the number is scoped
    /// to this page.
    private func tradeCountLabel(rows: [ClientTrade]) -> String? {
        if let total = store.honestTradeTotal(localSearchText: searchText) {
            return "\(total.formatted(.number.grouping(.automatic))) trades"
        }
        // Mid-apply the rows on screen still belong to the filter set the user
        // just changed away from, so any number would be describing the past.
        guard !store.isFeedFilterPending, !rows.isEmpty else { return nil }
        return "\(rows.count.formatted(.number.grouping(.automatic))) on this page"
    }

    var body: some View {
        let rows = filteredTrades

        return NavigationStack {
            ScrollView {
                VStack(spacing: 12) {
                    DisclaimerBanner(isExpanded: $disclaimerExpanded)

                    // Shared filters (also on Trends) — chamber / party / sides / timeframe.
                    FeedControlBar()

                    // Single unified search (name / ticker / state / party, any order).
                    TradesUnifiedSearchField(
                        text: $searchText,
                        focused: $searchFocused,
                        onSubmit: { applyUnifiedSearch() },
                        onClear: {
                            searchText = ""
                            Task {
                                await store.setSearch(nil)
                                await store.setPoliticianFilter("")
                                await store.setAssetFilter("")
                            }
                        }
                    )
                    .onChange(of: searchText) { _, _ in
                        scheduleSearchDebounce()
                    }

                    // Owner: "when you update filter options it takes 3-5
                    // seconds … there should be some indicator so you don't
                    // think that it just isn't working."
                    //
                    // It shares the count's slot rather than taking a row of
                    // its own because the two are mutually exclusive by
                    // construction — `tradeCountLabel` returns nil for exactly
                    // the window in which the indicator is up — so one slot
                    // costs no extra vertical space and can never jump: this
                    // row's height is set by `FeedSortControl` either way.
                    //
                    // Bound to the FEED half of the pending state, not the
                    // combined flag: a shared filter also kicks off Trends' 12
                    // analytics requests, which routinely outlive the feed
                    // fetch by seconds, and "Updating…" must come down when
                    // THESE rows are final. Trends renders its own indicator
                    // against `isTrendsFilterPending`.
                    HStack(spacing: 8) {
                        FeedSortControl()
                        Spacer(minLength: 0)
                        if store.isFeedFilterPending {
                            // `fixedSize` because the shared indicator is built
                            // to span a full row elsewhere; here it must claim
                            // only its own width.
                            FilterActivityIndicator(isActive: true)
                                .fixedSize()
                        } else if let countLabel = tradeCountLabel(rows: rows) {
                            Text(countLabel)
                                .font(.caption.weight(.medium))
                                .foregroundStyle(Color.secondary)
                        }
                    }

                    // Only real offline/error notices — never cancellation noise.
                    if let notice = store.feedNotice,
                       store.isOffline || (!notice.isEmpty && !Self.isBenignCancellationNotice(notice)) {
                        FeedFreshnessView(
                            isOffline: store.isOffline,
                            lastRefresh: store.lastSuccessfulRefresh,
                            notice: store.feedNotice,
                            onRetry: { Task { await store.refresh() } }
                        )
                    }

                    // Gated on the pending flag as well as `isRefreshing`: a
                    // filter change with a non-empty cache used to fall between
                    // the two — the cold-start overlay was suppressed (cache not
                    // empty) and this branch was suppressed (`isRefreshing` was
                    // only true once the request had actually started), leaving
                    // a blank page mid-apply.
                    if rows.isEmpty && !store.isRefreshing && !store.isFeedFilterPending {
                        ContentUnavailableView {
                            Label(
                                hasActiveTextFilter ? "No Matching Trades" : "No Trades in Range",
                                systemImage: "tray"
                            )
                        } description: {
                            Text(
                                hasActiveTextFilter
                                    ? "Try another ticker, politician, or state."
                                    : "Try a wider time range, or pull to refresh."
                            )
                        } actions: {
                            Button("Retry") { Task { await store.refresh() } }
                                .buttonStyle(.bordered)
                                .clipShape(Capsule())
                        }
                        .padding(.top, 40)
                    }

                    // Owner: pagination was "way at bottom and missing from top
                    // of the list of trades". Same component top and bottom —
                    // `FeedPaginationBar` holds no state of its own (page,
                    // page size and bounds all live on the store), so the two
                    // instances cannot drift.
                    if !rows.isEmpty {
                        FeedPaginationBar()
                    }

                    LazyVStack(spacing: 8) {
                        ForEach(rows) { trade in
                            Button {
                                selectedTrade = trade
                            } label: {
                                TradeCard(trade: trade, onPoliticianTap: {
                                    if let memberId = trade.member.id {
                                        selectedPoliticianName = trade.member.name
                                        selectedPoliticianId = memberId
                                    }
                                }, onTickerTap: trade.asset.ticker.map { ticker in
                                    { selectedTicker = ticker }
                                })
                            }
                            .buttonStyle(.plain)
                            .accessibilityHint("Opens trade details")
                        }
                    }
                    // NO "dim the stale rows while applying" TREATMENT HERE,
                    // deliberately — it looked good and it crashed the app.
                    //
                    // Any modifier that composites this subtree (`.opacity`,
                    // and worse `.animation(_:value:)` keyed on the pending
                    // flag) makes SwiftUI realize and re-render rows that the
                    // `LazyVStack` would otherwise never touch — and it does so
                    // at exactly the wrong instant, because the flag clears in
                    // the same turn `replaceCache` deletes every cached
                    // `ClientTrade` missing from the new response. Reading
                    // `trade.asset` on a deleted SwiftData model traps:
                    // EXC_BREAKPOINT in `ClientTrade.storedAsset.getter`,
                    // reproduced three times on iPhone 17 Pro / iOS 26.5 by
                    // tapping the sort-direction control repeatedly, and zero
                    // times in a control build with only this file reverted.
                    // The "Updating…" strip beside the count is the whole
                    // signal; it costs nothing to render and cannot touch a
                    // model object.

                    if !rows.isEmpty {
                        FeedPaginationBar()
                    }

                    LegalFooterLinks()
                        .padding(.top, 8)
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 24)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(AppTheme.background)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                // EXACT toolbar parity with Trends: ⓘ leading, brand
                // principal, hamburger trailing — one item on each side.
                //
                // The export-CSV arrow that used to sit next to the hamburger
                // is gone: CSV export now lives inside `AccountQuickMenu` (and
                // on the Delivery tab), which is what the owner asked for
                // ("the export CSV button needs to be in settings"). Removing
                // it also fixes "the Trades tab shouldn't have a smaller logo"
                // — a `.principal` item is squeezed by whatever its leading and
                // trailing siblings need, so Trades' two trailing items were
                // shrinking the lockup that Trends rendered at full size.
                ToolbarItem(placement: .topBarLeading) {
                    HeaderIconButton(
                        systemImage: "info.circle",
                        accessibilityLabel: "About Congress.Trade"
                    ) {
                        withAnimation { disclaimerExpanded.toggle() }
                    }
                }
                ToolbarItem(placement: .principal) {
                    BrandTitle()
                }
                ToolbarItem(placement: .topBarTrailing) {
                    HamburgerMenuButton()
                }
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") { searchFocused = false }
                }
            }
            .refreshable { await store.refresh() }
            .task {
                // One-time app-lifetime intro reveal, shared with Trends via
                // the same AppStorage keys — never re-plays on tab switch.
                if !disclaimerIntroDone {
                    disclaimerIntroDone = true
                    withAnimation { disclaimerExpanded = true }
                    try? await Task.sleep(for: .seconds(4))
                    if !Task.isCancelled {
                        withAnimation { disclaimerExpanded = false }
                    }
                }
            }
            .overlay {
                if store.isRefreshing && cachedTrades.isEmpty {
                    ProgressView()
                        .controlSize(.large)
                        .padding(24)
                        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
                }
            }
            .sheet(item: $selectedTrade) { trade in
                TradeDetailView(trade: trade)
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
                    .presentationCornerRadius(18)
            }
            .sheet(isPresented: Binding<Bool>(
                get: { selectedPoliticianId != nil },
                set: { if !$0 { selectedPoliticianId = nil } }
            )) {
                if let memberId = selectedPoliticianId {
                    PoliticianDetailView(memberId: memberId, memberName: selectedPoliticianName ?? "Politician")
                        .presentationDetents([.medium, .large])
                        .presentationDragIndicator(.visible)
                        .presentationCornerRadius(18)
                }
            }
            .sheet(isPresented: Binding<Bool>(
                get: { selectedTicker != nil },
                set: { if !$0 { selectedTicker = nil } }
            )) {
                if let ticker = selectedTicker {
                    TickerDetailView(ticker: ticker)
                        .presentationDetents([.medium, .large])
                        .presentationDragIndicator(.visible)
                        .presentationCornerRadius(18)
                }
            }
            .onDisappear { filterTask?.cancel() }
            .simultaneousGesture(
                TapGesture().onEnded { searchFocused = false }
            )
        }
    }

    private func scheduleFilterApply(_ work: @escaping @MainActor () async -> Void) {
        filterTask?.cancel()
        filterTask = Task {
            try? await Task.sleep(for: .milliseconds(320))
            guard !Task.isCancelled else { return }
            await work()
        }
    }

    /// Submit path for the unified search field: reaches the server via
    /// `CongressTradeStore.setSearch` (ticker-vs-politician-name heuristic
    /// lives in `CongressTradeStore.looksLikeTicker`) immediately, rather
    /// than waiting for the typing debounce below.
    private func applyUnifiedSearch() {
        filterTask?.cancel()
        // Submitting is an explicit "go", so the indicator must light on the
        // tap rather than when the request happens to start. (Typing does NOT
        // do this: the local re-filter is instantaneous, so a spinner on every
        // keystroke would be noise — the debounced server call still raises
        // the flag itself once it fires.)
        store.noteFilterIntent()
        Task { await store.setSearch(searchText) }
    }

    /// Typing itself only needs the already-loaded page's local re-filter
    /// (`filteredTrades`, via `TradeSearch.matches`, recomputes automatically
    /// off `searchText` — no explicit trigger needed); this debounce is
    /// purely so a pause in typing also reaches the server, same 320ms
    /// pattern `scheduleFilterApply` used for the old per-field search.
    private func scheduleSearchDebounce() {
        scheduleFilterApply { [searchText] in
            await store.setSearch(searchText)
        }
    }

    /// Grey full-width "cancelled" cards under the filter bar came from
    /// URLError.cancelled / Task cancel being painted as feedNotice.
    private static func isBenignCancellationNotice(_ message: String) -> Bool {
        let lower = message.lowercased()
        return lower == "cancelled" || lower == "canceled" || lower.contains("cancelled") || lower.contains("canceled")
    }
}

// MARK: - Header / controls

/// Website-parity brand lockup: eagle+bag with CONGRESS / TRADE baked into the
/// light/dark lockup assets. No trailing "Congress.Trade" text after the mark.
/// Sized ~50% larger than the old 28pt bar, then +10% (42→46 / 300→330) and
/// lockup art has ~½ capital-width extra gap between CONGRESS|eagle|TRADE.
struct BrandTitle: View {
    var body: some View {
        Image("BrandLockup")
            .resizable()
            .scaledToFit()
            .frame(height: 46)
            .frame(maxWidth: 330)
            // A `.principal` toolbar item is laid out in whatever width its
            // leading/trailing siblings leave behind, which is how Trades (two
            // trailing items) ended up rendering a visibly smaller lockup than
            // Trends (one). The item counts now match, and these two modifiers
            // stop the bar from compressing the image even if that ever
            // changes again.
            .fixedSize(horizontal: false, vertical: true)
            .layoutPriority(1)
            // Owner: "the heading/logo can be moved upward like 2 millimeters
            // to have tiny white space between dynamic island and eagle still."
            // ~6pt ≈ 2mm on a 460ppi iPhone. `.offset` rather than negative
            // padding so nothing else in the bar reflows around it.
            .offset(y: -6)
            .accessibilityLabel("Congress.Trade")
    }
}

/// Shared under-header filter strip used on both Trades and Trends.
struct FeedControlBar: View {
    @EnvironmentObject private var store: CongressTradeStore
    var showMetrics: Bool = true

    /// Which control a debounce slot belongs to. One slot PER dimension rather
    /// than one shared timer: a shared timer would let a party tap cancel a
    /// still-pending chamber tap and silently drop it.
    private enum FilterDimension: Hashable {
        case timeframe
        case chamber
        case party
        case side
    }

    /// The multi-select menus are built from `Toggle` rows precisely so the
    /// menu stays OPEN across taps, which makes 2-3 taps per gesture the normal
    /// case. Each of those taps used to fire its own full feed refresh plus a
    /// 12-request analytics refresh, serialized behind one another — most of
    /// the "3-5 seconds" the owner measured was simply the same work done
    /// three times. This window coalesces the burst into a single apply.
    private static let multiSelectDebounce: Duration = .milliseconds(400)

    /// Rows that dismiss the menu on tap (a timeframe pick, the "All X" resets)
    /// cannot burst, so they apply immediately — but they still go through the
    /// same slot, so a Toggle tapped moments earlier in the same menu can never
    /// land AFTER the reset and resurrect the selection it just cleared.
    private static let immediateApply: Duration = .zero

    @State private var filterTasks: [FilterDimension: Task<Void, Never>] = [:]

    /// Optimistic mirrors of the store's selections, alive only for the
    /// debounce window (`nil` = read the store). Without them the checkmark
    /// inside an open menu would not move until the request was already in
    /// flight, which reads as a dead control — the exact impression the
    /// debounce exists to remove.
    @State private var pendingTimeRange: TimeRange?
    @State private var pendingChambers: Set<ChamberFilter>?
    @State private var pendingParties: Set<PartyFilter>?
    @State private var pendingTradeTypes: Set<TradeTypeFilter>?

    private var timeRange: TimeRange { pendingTimeRange ?? store.selectedTimeRange }
    private var chambers: Set<ChamberFilter> { pendingChambers ?? store.selectedChambers }
    private var parties: Set<PartyFilter> { pendingParties ?? store.selectedParties }
    private var tradeTypes: Set<TradeTypeFilter> { pendingTradeTypes ?? store.selectedTradeTypes }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                // Timeframe Filter — stays fully visible (icon+value) at all
                // times and sits first/top-left (owner punch list item 5).
                Menu {
                    ForEach(TimeRange.allCases) { range in
                        Button {
                            applyTimeRange(range)
                        } label: {
                            HStack {
                                Text(range.label)
                                if timeRange == range {
                                    Image(systemName: "checkmark")
                                }
                            }
                        }
                    }
                } label: {
                    FilterMenuLabel(
                        title: timeRange.label,
                        icon: "calendar",
                        isActive: timeRange != .ninetyDays,
                        alwaysShowLabel: true,
                        accessibilityLabel: "Time range, \(timeRange.label)"
                    )
                }

                // Branch/Chamber Filter — multi-select: each row is a Toggle
                // (not a Button) so tapping it flips membership without
                // dismissing the menu, matching native multi-select menu
                // idiom (Button-only menu items always dismiss on tap;
                // Toggle/Picker items don't). Wired into the `chamber=` CSV
                // param exactly as the web sends it (`app/docs/
                // client-mobile-api.md`).
                Menu {
                    Button {
                        applyChambers([], after: Self.immediateApply)
                    } label: {
                        Label("All Branches", systemImage: "xmark.circle")
                    }
                    Divider()
                    ForEach(ChamberFilter.allCases) { chamber in
                        Toggle(isOn: chamberBinding(for: chamber)) {
                            Text(chamber.label)
                        }
                        .accessibilityLabel(chamber.label)
                        .accessibilityValue(chambers.contains(chamber) ? "Selected" : "Not selected")
                    }
                } label: {
                    FilterMenuLabel(
                        // Full labels joined "+" once modified (owner spec:
                        // "House+Senate"); icon-only "All" at default.
                        title: chambers.isEmpty
                            ? "All"
                            : ChamberFilter.allCases
                                .filter { chambers.contains($0) }
                                .map(\.label)
                                .joined(separator: "+"),
                        icon: "building.columns",
                        isActive: !chambers.isEmpty,
                        accessibilityLabel: "Branch filter, \(chambers.isEmpty ? "all" : ChamberFilter.allCases.filter { chambers.contains($0) }.map(\.label).joined(separator: ", "))"
                    )
                }

                // Party Filter — multi-select, entirely client-side on the
                // Trades feed (`FeedQuery` carries no `party` field); see
                // `CongressTradeStore.selectedParties`. That is also why a
                // party selection suppresses the trade count: the server's
                // COUNT(*) never saw this narrowing.
                Menu {
                    Button {
                        applyParties([], after: Self.immediateApply)
                    } label: {
                        Label("All Parties", systemImage: "xmark.circle")
                    }
                    Divider()
                    ForEach(PartyFilter.allCases) { party in
                        Toggle(isOn: partyBinding(for: party)) {
                            Text("\(party.emoji) \(party.label)")
                        }
                        .accessibilityLabel(party.label)
                        .accessibilityValue(parties.contains(party) ? "Selected" : "Not selected")
                    }
                } label: {
                    FilterMenuLabel(
                        title: parties.isEmpty
                            ? "All"
                            : PartyFilter.allCases
                                .filter { parties.contains($0) }
                                .map(\.summaryLabel)
                                .joined(separator: "+"),
                        icon: "person.2.fill",
                        isActive: !parties.isEmpty,
                        accessibilityLabel: "Party filter, \(parties.isEmpty ? "all" : PartyFilter.allCases.filter { parties.contains($0) }.map(\.label).joined(separator: ", "))"
                    )
                }

                // Side/Trade Type Filter (Buy/Sell/Exchange) — multi-select.
                // `type=` is only forwarded when exactly one side is chosen
                // (`CongressTradeStore.tradeTypeQueryValue`); any selection
                // count is still filtered correctly client-side
                // (`FeedDashboardView.filteredTrades`).
                Menu {
                    Button {
                        applyTradeTypes([], after: Self.immediateApply)
                    } label: {
                        Label("All Sides", systemImage: "xmark.circle")
                    }
                    Divider()
                    ForEach(TradeTypeFilter.allCases) { type in
                        Toggle(isOn: tradeTypeBinding(for: type)) {
                            Text(type.label)
                        }
                        .accessibilityLabel(type.label)
                        .accessibilityValue(tradeTypes.contains(type) ? "Selected" : "Not selected")
                    }
                } label: {
                    SidesFilterMenuLabel(
                        title: tradeTypes.isEmpty
                            ? "All"
                            : TradeTypeFilter.allCases
                                .filter { tradeTypes.contains($0) }
                                .map(\.summaryLabel)
                                .joined(separator: "+"),
                        isActive: !tradeTypes.isEmpty,
                        selected: tradeTypes
                    )
                }
            }
            .padding(.horizontal, 2)
            .padding(.vertical, 4)
        }
    }

    private func chamberBinding(for chamber: ChamberFilter) -> Binding<Bool> {
        Binding(
            get: { chambers.contains(chamber) },
            set: { _ in toggleChamber(chamber) }
        )
    }

    private func partyBinding(for party: PartyFilter) -> Binding<Bool> {
        Binding(
            get: { parties.contains(party) },
            set: { _ in toggleParty(party) }
        )
    }

    private func tradeTypeBinding(for type: TradeTypeFilter) -> Binding<Bool> {
        Binding(
            get: { tradeTypes.contains(type) },
            set: { _ in toggleTradeType(type) }
        )
    }

    private func toggleParty(_ party: PartyFilter) {
        var next = parties
        if next.contains(party) {
            next.remove(party)
        } else {
            next.insert(party)
        }
        applyParties(next, after: Self.multiSelectDebounce)
    }

    private func toggleTradeType(_ type: TradeTypeFilter) {
        var next = tradeTypes
        if next.contains(type) {
            next.remove(type)
        } else {
            next.insert(type)
        }
        applyTradeTypes(next, after: Self.multiSelectDebounce)
    }

    private func toggleChamber(_ chamber: ChamberFilter) {
        var next = chambers
        if next.contains(chamber) {
            next.remove(chamber)
        } else {
            next.insert(chamber)
        }
        applyChambers(next, after: Self.multiSelectDebounce)
    }

    // MARK: - Debounced apply

    private func applyTimeRange(_ next: TimeRange) {
        guard next != timeRange else { return }
        pendingTimeRange = next
        scheduleApply(.timeframe, after: Self.immediateApply) {
            await store.setTimeRange(next)
            // Only retire the mirror if it is still OURS. A tap during the
            // (multi-second) apply installs a newer mirror, and clearing it
            // here would snap the pill back to the value that just landed.
            if pendingTimeRange == next { pendingTimeRange = nil }
        }
    }

    private func applyChambers(_ next: Set<ChamberFilter>, after delay: Duration) {
        guard next != chambers else { return }
        pendingChambers = next
        scheduleApply(.chamber, after: delay) {
            await store.setChamberSelection(next)
            if pendingChambers == next { pendingChambers = nil }
        }
    }

    private func applyParties(_ next: Set<PartyFilter>, after delay: Duration) {
        guard next != parties else { return }
        pendingParties = next
        scheduleApply(.party, after: delay) {
            await store.setPartySelection(next)
            if pendingParties == next { pendingParties = nil }
        }
    }

    private func applyTradeTypes(_ next: Set<TradeTypeFilter>, after delay: Duration) {
        guard next != tradeTypes else { return }
        pendingTradeTypes = next
        scheduleApply(.side, after: delay) {
            await store.setTradeTypeSelection(next)
            if pendingTradeTypes == next { pendingTradeTypes = nil }
        }
    }

    /// Lights the indicator on the TAP — `noteFilterIntent()`'s own
    /// documentation is explicit that the view owns this moment, because the
    /// store cannot see a gesture that has not reached it yet. Without it the
    /// "Updating…" strip would appear only once the debounce fired, i.e. after
    /// the exact window in which the control feels dead.
    ///
    /// The debounce Task only ever SLEEPS; the apply runs in a separate
    /// unstructured Task so a later tap's `cancel()` kills a pending timer and
    /// never an apply that is already talking to the server (which would
    /// surface as a spurious cancelled-request notice). Overlapping applies are
    /// safe — the store coalesces the feed refresh chain and version-stamps the
    /// trends fan-out.
    private func scheduleApply(
        _ dimension: FilterDimension,
        after delay: Duration,
        _ work: @escaping @MainActor () async -> Void
    ) {
        store.noteFilterIntent()
        filterTasks[dimension]?.cancel()
        filterTasks[dimension] = Task { @MainActor in
            if delay > .zero {
                try? await Task.sleep(for: delay)
                guard !Task.isCancelled else { return }
            }
            Task { @MainActor in await work() }
        }
    }
}

// MARK: - One control language for the whole tab

/// Shared metrics for every pill-shaped control on Trades.
///
/// The owner's complaint was that the tab looked like three different apps:
/// the sort key used the filter capsule, the sort direction was a 30pt circle
/// with its own fill and stroke, and the pager was a row of unstyled chevrons
/// inside an `ultraThinMaterial` card. Sort key, sort direction, prev/next and
/// rows-per-page are now literally the same capsule — same height, same corner
/// family, same border, same type — so the strip above the list and the strip
/// below it read as one system.
private enum FeedControlMetrics {
    static let verticalPadding: CGFloat = 8
    static let horizontalPadding: CGFloat = 12
    /// Icon-only controls get tighter sides so a lone glyph does not float in
    /// the middle of an over-wide capsule.
    static let compactHorizontalPadding: CGFloat = 10
    /// Pinned so a text capsule and a glyph-only capsule come out the same
    /// height despite different intrinsic content heights.
    static let minHeight: CGFloat = 32
    static let labelFont: Font = .caption.weight(.semibold)
    static let glyphFont: Font = .caption.weight(.bold)
    static let chevronFont: Font = .system(size: 9, weight: .bold)
}

/// The capsule itself. Colors are CONCRETE `Color` values, never the
/// hierarchical `.primary`/`.secondary` shape styles: these capsules sit inside
/// `Button` and `Menu` labels, where a hierarchical style resolves against the
/// current foreground style — which is the app tint — and comes out blue. That
/// is the same trap that kept the toolbar icons blue through an earlier "make
/// them grey" pass.
private struct FeedControlSurface: ViewModifier {
    var isActive: Bool
    var isEnabled: Bool
    var horizontalPadding: CGFloat

    func body(content: Content) -> some View {
        content
            .padding(.horizontal, horizontalPadding)
            .padding(.vertical, FeedControlMetrics.verticalPadding)
            .frame(minHeight: FeedControlMetrics.minHeight)
            .foregroundStyle(isActive ? Color.white : (isEnabled ? Color.primary : Color.secondary))
            .background(
                isActive ? Color.blue : Color(uiColor: .secondarySystemBackground),
                in: Capsule()
            )
            .overlay(Capsule().stroke(AppTheme.borderColor, lineWidth: 1))
            // Explicit rather than relying on the button style to dim a
            // disabled control: `.buttonStyle(.plain)` does not.
            .opacity(isEnabled ? 1 : 0.4)
    }
}

private extension View {
    func feedControlSurface(
        isActive: Bool = false,
        isEnabled: Bool = true,
        horizontalPadding: CGFloat = FeedControlMetrics.horizontalPadding
    ) -> some View {
        modifier(
            FeedControlSurface(
                isActive: isActive,
                isEnabled: isEnabled,
                horizontalPadding: horizontalPadding
            )
        )
    }
}

/// Trades-only sort control (owner punch list #2, item 7) — mirrors the
/// web's mobile sort dropdown + direction toggle (`app/src/ui/dashboardHtml.ts`
/// `syncMobileSortControl()`/`toggleMobileSortDir()`): a key menu (Date /
/// Amount) plus a separate direction button that flips asc/desc for
/// whichever key is active.
struct FeedSortControl: View {
    @EnvironmentObject private var store: CongressTradeStore

    var body: some View {
        HStack(spacing: 6) {
            Menu {
                ForEach(FeedSortKey.allCases) { key in
                    Button {
                        guard key != store.feedSortKey else { return }
                        store.noteFilterIntent()
                        Task { await store.setFeedSortKey(key) }
                    } label: {
                        HStack {
                            Text(key.label)
                            if store.feedSortKey == key {
                                Image(systemName: "checkmark")
                            }
                        }
                    }
                }
            } label: {
                FilterMenuLabel(
                    title: store.feedSortKey.label,
                    icon: "arrow.up.arrow.down",
                    isActive: false,
                    alwaysShowLabel: true,
                    accessibilityLabel: "Sort by \(store.feedSortKey.label)"
                )
            }

            Button {
                store.noteFilterIntent()
                Task { await store.toggleFeedSortDirection() }
            } label: {
                Image(systemName: store.feedSortDirection.systemImage)
                    .font(FeedControlMetrics.glyphFont)
                    .feedControlSurface(horizontalPadding: FeedControlMetrics.compactHorizontalPadding)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(store.feedSortDirection.accessibilityLabel), tap to flip")
        }
    }
}

/// "Page X of Y" + prev/next + rows-per-page (owner punch list #2, item 8) —
/// mirrors the web's `#prevPageBtn`/`#nextPageBtn`/`#pageSize`
/// (`app/src/ui/dashboardHtml.ts`). Reads `total`/`limit` from the feed's own
/// response metadata via the store's `totalPages`/`pageSize`; never a
/// client-side estimate.
///
/// Rendered ABOVE and BELOW the list (owner: it was "way at bottom and missing
/// from top"). Both instances are the same struct holding no state of its own —
/// page index, page size and bounds all live on the store — so they cannot
/// drift out of sync.
struct FeedPaginationBar: View {
    @EnvironmentObject private var store: CongressTradeStore

    private static let pageSizeOptions = [50, 100, 200]

    var body: some View {
        HStack(spacing: 6) {
            Button {
                store.noteFilterIntent()
                Task { await store.goToPreviousPage() }
            } label: {
                Image(systemName: "chevron.left")
                    .font(FeedControlMetrics.glyphFont)
                    .feedControlSurface(
                        isEnabled: store.canGoToPreviousPage,
                        horizontalPadding: FeedControlMetrics.compactHorizontalPadding
                    )
            }
            .buttonStyle(.plain)
            .disabled(!store.canGoToPreviousPage)
            .accessibilityLabel("Previous page")

            Text("Page \(store.currentPage + 1) of \(store.totalPages)")
                .font(FeedControlMetrics.labelFont)
                .foregroundStyle(Color.secondary)
                .frame(minWidth: 92)
                .accessibilityLabel("Page \(store.currentPage + 1) of \(store.totalPages)")

            Button {
                store.noteFilterIntent()
                Task { await store.goToNextPage() }
            } label: {
                Image(systemName: "chevron.right")
                    .font(FeedControlMetrics.glyphFont)
                    .feedControlSurface(
                        isEnabled: store.canGoToNextPage,
                        horizontalPadding: FeedControlMetrics.compactHorizontalPadding
                    )
            }
            .buttonStyle(.plain)
            .disabled(!store.canGoToNextPage)
            .accessibilityLabel("Next page")

            Spacer(minLength: 8)

            Menu {
                ForEach(Self.pageSizeOptions, id: \.self) { size in
                    Button {
                        // Guarded so a no-op pick does not strand the pending
                        // indicator on for the store's watchdog timeout:
                        // `setPageSize` short-circuits inside `viewLimit`'s
                        // `didSet` and never reaches an apply.
                        guard store.pageSize != size else { return }
                        store.noteFilterIntent()
                        store.setPageSize(size)
                    } label: {
                        HStack {
                            Text("\(size) / page")
                            if store.pageSize == size {
                                Image(systemName: "checkmark")
                            }
                        }
                    }
                }
            } label: {
                HStack(spacing: 4) {
                    Text("\(store.pageSize)/page")
                        .font(FeedControlMetrics.labelFont)
                    Image(systemName: "chevron.down")
                        .font(FeedControlMetrics.chevronFont)
                        .opacity(0.5)
                        .padding(.leading, 2)
                }
                .feedControlSurface()
            }
            .accessibilityLabel("Rows per page, \(store.pageSize)")
        }
    }
}

/// Tiny green up / red down / grey left-right arrows for the shared
/// multi-select Sides control (Buy/Sell/Exchange). Icon-only (compact) at
/// the default "All" state — every arrow shows its normal color, since
/// nothing selected means every side is shown. Once a subset is selected,
/// the unselected sides' arrows dim and the compact summary label (e.g.
/// "Buys+Sells") appears (owner punch list item 5 pattern, extended to
/// multi-select 2026-08-09).
struct SidesFilterMenuLabel: View {
    let title: String
    let isActive: Bool
    let selected: Set<TradeTypeFilter>

    /// A side reads as "on" when nothing is selected (default = show all) or
    /// when it's explicitly in the selection.
    private func isOn(_ type: TradeTypeFilter) -> Bool {
        selected.isEmpty || selected.contains(type)
    }

    private var dimColor: Color { isActive ? .white.opacity(0.45) : Color.secondary }

    /// The exchange glyph.
    ///
    /// Owner: "make the double arrow symbol for exchanges be black instead of
    /// red and could be '↔' that sort of symbol if the arrows were in same
    /// style as the up and down buy and sell arrows." `arrow.left.arrow.right`
    /// already IS that shape, so only its treatment changes: same 9pt heavy
    /// weight as its siblings (it was 8pt, which is why it read as a different
    /// set), and `Color.primary` rather than `Color.orange`.
    ///
    /// `Color.primary`, not a literal `.black`: primary resolves to black in
    /// light mode and white in dark, and a literal black would be invisible
    /// against the dark-mode capsule. On an active (blue) pill it is the white
    /// the other two glyphs also take, which is the correct high-contrast
    /// answer there.
    private var exchangeColor: Color {
        guard isOn(.exchange) else { return dimColor }
        return isActive ? .white : Color.primary
    }

    var body: some View {
        HStack(spacing: 4) {
            HStack(spacing: 1) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 9, weight: .heavy))
                    .foregroundStyle(isOn(.buy) ? Color.green : dimColor)
                Image(systemName: "arrow.down")
                    .font(.system(size: 9, weight: .heavy))
                    .foregroundStyle(isOn(.sell) ? Color.red : dimColor)
                Image(systemName: "arrow.left.arrow.right")
                    .font(.system(size: 9, weight: .heavy))
                    .foregroundStyle(exchangeColor)
            }
            if isActive {
                Text(title)
                    .font(FeedControlMetrics.labelFont)
            }
            Image(systemName: "chevron.down")
                .font(FeedControlMetrics.chevronFont)
                .opacity(0.5)
                .padding(.leading, 2)
        }
        .feedControlSurface(
            isActive: isActive,
            horizontalPadding: isActive
                ? FeedControlMetrics.horizontalPadding
                : FeedControlMetrics.compactHorizontalPadding
        )
        .accessibilityLabel("Trade side filter, \(title)")
    }
}

/// Filter pill shared by Branch/Party/$/Timeframe. Icon-only (compact) when
/// at the default/unmodified state; expands to icon+value once active —
/// except `alwaysShowLabel` (Timeframe), which stays icon+value always
/// (owner punch list item 5).
struct FilterMenuLabel: View {
    let title: String
    let icon: String
    let isActive: Bool
    var alwaysShowLabel: Bool = false
    var accessibilityLabel: String? = nil

    private var showsLabel: Bool { alwaysShowLabel || isActive }

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: icon)
                .font(FeedControlMetrics.glyphFont)
            if showsLabel {
                Text(title)
                    .font(FeedControlMetrics.labelFont)
            }
            Image(systemName: "chevron.down")
                .font(FeedControlMetrics.chevronFont)
                .opacity(0.5)
                .padding(.leading, 2)
        }
        .feedControlSurface(
            isActive: isActive,
            horizontalPadding: showsLabel
                ? FeedControlMetrics.horizontalPadding
                : FeedControlMetrics.compactHorizontalPadding
        )
        .accessibilityLabel(accessibilityLabel ?? title)
    }
}

/// Trades-only unified search field (name / ticker / state / party, any
/// order) — replaces the old side-by-side Name + Asset/Ticker fields.
/// `TradeSearch.matches` (`MemberDirectorySearch.swift`) does the actual
/// any-order token matching against the already-loaded page; submitting or
/// pausing while typing (`FeedDashboardView.scheduleSearchDebounce`) also
/// reaches the server via `CongressTradeStore.setSearch`.
struct TradesUnifiedSearchField: View {
    @Binding var text: String
    var focused: FocusState<Bool>.Binding
    var onSubmit: () -> Void = {}
    var onClear: () -> Void = {}

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)
            TextField("Name, ticker, state, or party", text: $text)
                .neverAutocapitalized()
                .autocorrectionDisabled()
                .font(.subheadline)
                .focused(focused)
                .submitLabel(.search)
                .onSubmit {
                    onSubmit()
                    focused.wrappedValue = false
                }
            if !text.isEmpty {
                Button {
                    withAnimation { text = "" }
                    onClear()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear Search")
            }
        }
        .padding(12)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
        .background(AppTheme.panel, in: RoundedRectangle(cornerRadius: 12))
        .overlay(AppTheme.border(cornerRadius: 12))
        .accessibilityLabel("Search trades by politician name, ticker, state, or party")
    }
}

struct SearchField: View {
    @Binding var text: String
    var onSubmit: () -> Void = {}
    var onClear: () -> Void = {}
    @FocusState private var isFocused: Bool

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)
            TextField("Search ticker, politician, or state", text: $text)
                .neverAutocapitalized()
                .autocorrectionDisabled()
                .focused($isFocused)
                .submitLabel(.search)
                .onSubmit {
                    onSubmit()
                    isFocused = false
                }
            if !text.isEmpty {
                Button {
                    withAnimation { text = "" }
                    onClear()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                }
                .accessibilityLabel("Clear Search")
            }
        }
        .padding(12)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
        .background(AppTheme.panel, in: RoundedRectangle(cornerRadius: 12))
        .overlay(AppTheme.border(cornerRadius: 12))
    }
}

/// Shared educational disclaimer used on Trades and Trends.
struct DisclaimerBanner: View {
    @Binding var isExpanded: Bool

    var body: some View {
        if isExpanded {
            Text("Congress.Trade is an informational tool for exploring public STOCK Act disclosures. Summaries are historical observational views — not trading signals or investment advice. Dollar figures are estimates from disclosed amount brackets.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 8))
        }
    }
}

/// Trades-only export popup: From / To dates + small ↓ CSV (Premium-gated).
struct ExportCSVSheet: View {
    @EnvironmentObject private var store: CongressTradeStore
    @Environment(\.dismiss) private var dismiss
    @State private var fromDate = Calendar.current.date(byAdding: .month, value: -3, to: Date()) ?? Date()
    @State private var toDate = Date()
    @State private var isExporting = false
    @State private var notice: String?
    @State private var shareURL: URL?
    @State private var showSubscribe = false

    private static let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(secondsFromGMT: 0)
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    DatePicker("From", selection: $fromDate, displayedComponents: .date)
                    DatePicker("To", selection: $toDate, displayedComponents: .date)
                } header: {
                    Text("Date range")
                } footer: {
                    Text("Exports the filtered feed for this range. Premium required.")
                }

                if let notice {
                    Section {
                        Text(notice)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }

                Section {
                    if !store.signedIn {
                        Text("Sign in with a Premium account to export CSV.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    } else if !store.isPremium {
                        Text("CSV export is a Premium feature ($5/mo or $50/yr, 1-month free trial).")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        Button {
                            showSubscribe = true
                        } label: {
                            Label("Subscribe with Apple", systemImage: "apple.logo")
                        }
                    } else {
                        Button {
                            Task { await runExport() }
                        } label: {
                            if isExporting {
                                ProgressView()
                                    .frame(maxWidth: .infinity)
                            } else {
                                Text("↓ CSV")
                                    .font(.caption.weight(.bold))
                                    .frame(maxWidth: .infinity)
                            }
                        }
                        .disabled(isExporting)
                    }
                }
            }
            .navigationTitle("Export")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
            .sheet(isPresented: $showSubscribe) {
                SubscribeView()
                    .environmentObject(store)
            }
            .sheet(isPresented: Binding(
                get: { shareURL != nil },
                set: { if !$0 { shareURL = nil } }
            )) {
                if let shareURL {
                    ShareSheet(items: [shareURL])
                }
            }
        }
    }

    private func runExport() async {
        isExporting = true
        notice = nil
        defer { isExporting = false }
        let from = Self.dayFormatter.string(from: min(fromDate, toDate))
        let to = Self.dayFormatter.string(from: max(fromDate, toDate))
        do {
            let data = try await store.exportCSV(from: from, to: to)
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent("congress-trades-\(from)-\(to).csv")
            try data.write(to: url, options: .atomic)
            shareURL = url
            notice = "Ready to share."
        } catch {
            notice = error.localizedDescription
        }
    }
}

/// UIKit share sheet bridge for the exported CSV file URL.
struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}

// MARK: - Compact trade row

struct TradeCard: View {
    let trade: ClientTrade
    var onPoliticianTap: (() -> Void)? = nil
    var onTickerTap: (() -> Void)? = nil

    /// SwiftData models are observable, and a DELETE is an observed change — so
    /// when `replaceCache` drops the rows that are not in a new response,
    /// SwiftUI re-runs this body for a row whose backing data is already gone,
    /// before the parent's `@Query` array has caught up and dropped it. Reading
    /// any persisted property at that moment traps. The parent filters dead
    /// models out of its array (`liveCachedTrades`), but that only covers rows
    /// built from a fresh body pass; this covers a row SwiftUI refreshes in
    /// place because the model itself notified. Bailing to an empty row is
    /// invisible in practice — the parent re-renders without it a frame later.
    private var isLive: Bool {
        !trade.isDeleted && trade.modelContext != nil
    }

    var body: some View {
        if isLive {
            card
        }
    }

    private var card: some View {
        HStack(alignment: .center, spacing: 12) {
            // Only reserve logo column when a ticker exists; AssetMark is EmptyView
            // until a real logo loads (no blue monogram tiles that steal width).
            if trade.asset.ticker != nil {
                Button {
                    onTickerTap?()
                } label: {
                    AssetMark(symbol: assetTitle, isTicker: true, size: 40)
                }
                .buttonStyle(.plain)
                .disabled(onTickerTap == nil)
                .accessibilityLabel(onTickerTap == nil ? assetTitle : "View \(assetTitle) Trades")
            }

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(assetTitle)
                        .font(.subheadline.weight(.bold))
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    StatusPill(
                        text: shortTypeLabel,
                        color: trade.transaction.type.tint,
                        compact: true
                    )
                }

                Button {
                    onPoliticianTap?()
                } label: {
                    Text(politicianLine)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                }
                .buttonStyle(.plain)
                .disabled(onPoliticianTap == nil)
            }

            Spacer(minLength: 4)

            VStack(alignment: .trailing, spacing: 2) {
                Text(trade.amountLabel)
                    .font(.subheadline.weight(.bold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                Text(trade.transaction.date.shortDate)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(AppTheme.borderColor.opacity(0.55), lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.12), radius: 10, y: 4)
    }

    private var assetTitle: String {
        trade.asset.displayName
    }

    private var shortTypeLabel: String {
        switch trade.transaction.type {
        case "B", "P": return "Buy"
        case "S": return "Sell"
        case "E": return "Exch"
        default: return trade.transaction.type
        }
    }

    /// Single meta line: "Sen. Name · D-CA" — chamber once, never duplicated.
    private var politicianLine: String {
        let name = trade.member.name ?? "Unknown"
        let chamber = trade.member.chamber?.chamberLabel
        let party = partyLetter(trade.member.party)
        let state = trade.member.state?.uppercased()
        let partyState: String? = {
            switch (party, state) {
            case let (p?, s?): return "\(p)-\(s)"
            case let (p?, nil): return p
            case let (nil, s?): return s
            default: return nil
            }
        }()

        var parts: [String] = []
        if let chamber {
            parts.append("\(chamber) · \(name)")
        } else {
            parts.append(name)
        }
        if let partyState {
            parts.append(partyState)
        }
        return parts.joined(separator: " · ")
    }

    private func partyLetter(_ raw: String?) -> String? {
        guard let raw, !raw.isEmpty else { return nil }
        switch raw.lowercased() {
        case "democrat", "dem", "d": return "D"
        case "republican", "rep", "r": return "R"
        case "independent", "ind", "i": return "I"
        default: return String(raw.prefix(1)).uppercased()
        }
    }
}
