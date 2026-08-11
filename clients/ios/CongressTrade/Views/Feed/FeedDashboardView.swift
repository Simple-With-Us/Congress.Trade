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
    @State private var showExportSheet = false
    @FocusState private var searchFocused: Bool

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
            return cachedTrades.sorted { lhs, rhs in
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
            return cachedTrades.sorted { lhs, rhs in
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

    var body: some View {
        NavigationStack {
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

                    HStack(spacing: 8) {
                        FeedSortControl()
                        Spacer(minLength: 0)
                        Text("\(filteredTrades.count) trades")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.secondary)
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

                    if filteredTrades.isEmpty && !store.isRefreshing {
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

                    LazyVStack(spacing: 8) {
                        ForEach(filteredTrades) { trade in
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

                    if !filteredTrades.isEmpty {
                        FeedPaginationBar()
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 24)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(AppTheme.background)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                // Swapped vs the old layout (owner punch list item 3): ⓘ now
                // leads (where the export arrow used to be), arrow trails —
                // matching Trends' ⓘ side after its own swap below.
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
                ToolbarItemGroup(placement: .topBarTrailing) {
                    HeaderIconButton(
                        systemImage: "arrow.down.circle",
                        accessibilityLabel: "Export CSV"
                    ) {
                        showExportSheet = true
                    }
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
            .sheet(isPresented: $showExportSheet) {
                ExportCSVSheet()
                    .environmentObject(store)
                    .presentationDetents([.medium])
                    .presentationDragIndicator(.visible)
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

// `BrandTitle` now lives in Views/Components/Components.swift — it has to be
// one fixed rendered size for every tab, which is a shared-primitive concern,
// not a Trades one.

/// Shared under-header filter strip used on both Trades and Trends.
struct FeedControlBar: View {
    @EnvironmentObject private var store: CongressTradeStore
    var showMetrics: Bool = true

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                // Timeframe Filter — stays fully visible (icon+value) at all
                // times and sits first/top-left (owner punch list item 5).
                Menu {
                    ForEach(TimeRange.allCases) { range in
                        Button {
                            Task { await store.setTimeRange(range) }
                        } label: {
                            HStack {
                                Text(range.label)
                                if store.selectedTimeRange == range {
                                    Image(systemName: "checkmark")
                                }
                            }
                        }
                    }
                } label: {
                    FilterMenuLabel(
                        title: store.selectedTimeRange.label,
                        icon: "calendar",
                        isActive: store.selectedTimeRange != .ninetyDays,
                        alwaysShowLabel: true,
                        accessibilityLabel: "Time range, \(store.selectedTimeRange.label)"
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
                        Task { await store.setChamberSelection([]) }
                    } label: {
                        Label("All Branches", systemImage: "xmark.circle")
                    }
                    Divider()
                    ForEach(ChamberFilter.allCases) { chamber in
                        Toggle(isOn: chamberBinding(for: chamber)) {
                            Text(chamber.label)
                        }
                        .accessibilityLabel(chamber.label)
                        .accessibilityValue(store.selectedChambers.contains(chamber) ? "Selected" : "Not selected")
                    }
                } label: {
                    FilterMenuLabel(
                        // Full labels joined "+" once modified (owner spec:
                        // "House+Senate"); icon-only "All" at default.
                        title: store.selectedChambers.isEmpty
                            ? "All"
                            : ChamberFilter.allCases
                                .filter { store.selectedChambers.contains($0) }
                                .map(\.label)
                                .joined(separator: "+"),
                        icon: "building.columns",
                        isActive: !store.selectedChambers.isEmpty,
                        accessibilityLabel: "Branch filter, \(store.selectedChambers.isEmpty ? "all" : ChamberFilter.allCases.filter { store.selectedChambers.contains($0) }.map(\.label).joined(separator: ", "))"
                    )
                }

                // Party Filter — multi-select, entirely client-side on the
                // Trades feed (server has no `party=` feed param at all); see
                // `CongressTradeStore.selectedParties`.
                Menu {
                    Button {
                        Task { await store.setPartySelection([]) }
                    } label: {
                        Label("All Parties", systemImage: "xmark.circle")
                    }
                    Divider()
                    ForEach(PartyFilter.allCases) { party in
                        Toggle(isOn: partyBinding(for: party)) {
                            Text("\(party.emoji) \(party.label)")
                        }
                        .accessibilityLabel(party.label)
                        .accessibilityValue(store.selectedParties.contains(party) ? "Selected" : "Not selected")
                    }
                } label: {
                    FilterMenuLabel(
                        title: store.selectedParties.isEmpty
                            ? "All"
                            : PartyFilter.allCases
                                .filter { store.selectedParties.contains($0) }
                                .map(\.summaryLabel)
                                .joined(separator: "+"),
                        icon: "person.2.fill",
                        isActive: !store.selectedParties.isEmpty,
                        accessibilityLabel: "Party filter, \(store.selectedParties.isEmpty ? "all" : PartyFilter.allCases.filter { store.selectedParties.contains($0) }.map(\.label).joined(separator: ", "))"
                    )
                }

                // Side/Trade Type Filter (Buy/Sell/Exchange) — multi-select.
                // Server `type=` is single-valued, so it's only forwarded
                // when exactly one side is chosen; any selection count is
                // still filtered correctly client-side
                // (`FeedDashboardView.filteredTrades`).
                Menu {
                    Button {
                        Task { await store.setTradeTypeSelection([]) }
                    } label: {
                        Label("All Sides", systemImage: "xmark.circle")
                    }
                    Divider()
                    ForEach(TradeTypeFilter.allCases) { type in
                        Toggle(isOn: tradeTypeBinding(for: type)) {
                            Text(type.label)
                        }
                        .accessibilityLabel(type.label)
                        .accessibilityValue(store.selectedTradeTypes.contains(type) ? "Selected" : "Not selected")
                    }
                } label: {
                    SidesFilterMenuLabel(
                        title: store.selectedTradeTypes.isEmpty
                            ? "All"
                            : TradeTypeFilter.allCases
                                .filter { store.selectedTradeTypes.contains($0) }
                                .map(\.summaryLabel)
                                .joined(separator: "+"),
                        isActive: !store.selectedTradeTypes.isEmpty,
                        selected: store.selectedTradeTypes
                    )
                }
            }
            .padding(.horizontal, 2)
            .padding(.vertical, 4)
        }
    }

    private func chamberBinding(for chamber: ChamberFilter) -> Binding<Bool> {
        Binding(
            get: { store.selectedChambers.contains(chamber) },
            set: { _ in toggleChamber(chamber) }
        )
    }

    private func partyBinding(for party: PartyFilter) -> Binding<Bool> {
        Binding(
            get: { store.selectedParties.contains(party) },
            set: { _ in toggleParty(party) }
        )
    }

    private func tradeTypeBinding(for type: TradeTypeFilter) -> Binding<Bool> {
        Binding(
            get: { store.selectedTradeTypes.contains(type) },
            set: { _ in toggleTradeType(type) }
        )
    }

    private func toggleParty(_ party: PartyFilter) {
        var next = store.selectedParties
        if next.contains(party) {
            next.remove(party)
        } else {
            next.insert(party)
        }
        Task { await store.setPartySelection(next) }
    }

    private func toggleTradeType(_ type: TradeTypeFilter) {
        var next = store.selectedTradeTypes
        if next.contains(type) {
            next.remove(type)
        } else {
            next.insert(type)
        }
        Task { await store.setTradeTypeSelection(next) }
    }

    private func toggleChamber(_ chamber: ChamberFilter) {
        var next = store.selectedChambers
        if next.contains(chamber) {
            next.remove(chamber)
        } else {
            next.insert(chamber)
        }
        Task { await store.setChamberSelection(next) }
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
                Task { await store.toggleFeedSortDirection() }
            } label: {
                Image(systemName: store.feedSortDirection.systemImage)
                    .font(.caption.weight(.bold))
                    .frame(width: 30, height: 30)
                    .foregroundStyle(.secondary)
                    .background(Color(uiColor: .secondarySystemBackground), in: Circle())
                    .overlay(Circle().stroke(AppTheme.borderColor, lineWidth: 1))
            }
            .accessibilityLabel("\(store.feedSortDirection.accessibilityLabel), tap to flip")
        }
    }
}

/// "Page X of Y" + prev/next + rows-per-page (owner punch list #2, item 8) —
/// mirrors the web's `#prevPageBtn`/`#nextPageBtn`/`#pageSize`
/// (`app/src/ui/dashboardHtml.ts`). Reads `total`/`limit` from the feed's own
/// response metadata via the store's `totalPages`/`pageSize`; never a
/// client-side estimate.
struct FeedPaginationBar: View {
    @EnvironmentObject private var store: CongressTradeStore

    private static let pageSizeOptions = [50, 100, 200]

    var body: some View {
        HStack(spacing: 10) {
            Button {
                Task { await store.goToPreviousPage() }
            } label: {
                Image(systemName: "chevron.left")
                    .font(.caption.weight(.bold))
                    .frame(width: 30, height: 30)
            }
            .disabled(!store.canGoToPreviousPage)
            .accessibilityLabel("Previous page")

            Text("Page \(store.currentPage + 1) of \(store.totalPages)")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(minWidth: 84)
                .accessibilityLabel("Page \(store.currentPage + 1) of \(store.totalPages)")

            Button {
                Task { await store.goToNextPage() }
            } label: {
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.bold))
                    .frame(width: 30, height: 30)
            }
            .disabled(!store.canGoToNextPage)
            .accessibilityLabel("Next page")

            Spacer(minLength: 8)

            Menu {
                ForEach(Self.pageSizeOptions, id: \.self) { size in
                    Button {
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
                HStack(spacing: 3) {
                    Text("\(store.pageSize)/page")
                        .font(.caption.weight(.semibold))
                    Image(systemName: "chevron.down")
                        .font(.system(size: 9, weight: .bold))
                        .opacity(0.5)
                }
                .foregroundStyle(.secondary)
            }
            .accessibilityLabel("Rows per page, \(store.pageSize)")
        }
        .buttonStyle(.plain)
        .foregroundStyle(.primary)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
        .background(AppTheme.panel, in: RoundedRectangle(cornerRadius: 12))
        .overlay(AppTheme.border(cornerRadius: 12))
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

    private var dimColor: Color { isActive ? .white.opacity(0.45) : .secondary }

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
                    .font(.system(size: 8, weight: .heavy))
                    .foregroundStyle(isOn(.exchange) ? Color.orange : dimColor)
            }
            if isActive {
                Text(title)
                    .font(.caption.weight(.semibold))
            }
            Image(systemName: "chevron.down")
                .font(.system(size: 9, weight: .bold))
                .opacity(0.5)
                .padding(.leading, 2)
        }
        .padding(.horizontal, isActive ? 12 : 10)
        .padding(.vertical, 8)
        .foregroundStyle(isActive ? .white : .primary)
        .background(
            isActive ? Color.blue : Color(uiColor: .secondarySystemBackground),
            in: Capsule()
        )
        .overlay(Capsule().stroke(AppTheme.borderColor, lineWidth: 1))
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
                .font(.caption.weight(.bold))
            if showsLabel {
                Text(title)
                    .font(.caption.weight(.semibold))
            }
            Image(systemName: "chevron.down")
                .font(.system(size: 9, weight: .bold))
                .opacity(0.5)
                .padding(.leading, 2)
        }
        .padding(.horizontal, showsLabel ? 12 : 10)
        .padding(.vertical, 8)
        .foregroundStyle(isActive ? .white : .primary)
        .background(
            isActive ? Color.blue : Color(uiColor: .secondarySystemBackground),
            in: Capsule()
        )
        .overlay(Capsule().stroke(AppTheme.borderColor, lineWidth: 1))
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

    var body: some View {
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
